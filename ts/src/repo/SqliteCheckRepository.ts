import { Clock, Effect, Layer, Option, Schema } from "effect";
import { Duration } from "effect";
import { SqlClient, SqlError } from "effect/unstable/sql";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CheckResult,
  CheckFailure,
  Down,
  Incident,
  InvalidResponse,
  ResponseMetadata,
  Slow,
  Unknown,
  Up,
  Target,
  targetId,
  type TargetId,
} from "../domain/schema.js";
import { RepositoryError } from "../domain/errors.js";
import {
  CheckRepository,
  decideTransition,
  type CheckRepositoryShape,
  type IncidentTransition,
} from "./CheckRepository.js";

const repoError = (operation: string) => (cause: unknown) =>
  new RepositoryError({ operation, cause });
const conflicting = (id: string) =>
  new RepositoryError({
    operation: "saveCheck",
    cause: `check id ${id} already has different contents`,
  });
const classes = { Up, Slow, Down, InvalidResponse, Unknown };

export const makeTempFilename = () =>
  join(
    tmpdir(),
    `beaconwatch-${process.pid}-${Date.now()}-${randomUUID()}.sqlite`,
  );

// ---------- Row codecs (SPEC 4.1: JSON row payloads).

// Versioned duration codec: legacy numeric millisecond values plus tagged
// millisecond/nanosecond and infinity encodings (SPEC 4.1). Unknown tags fail
// as repository errors.
const decodeDuration = (x: unknown): Duration.Duration => {
  if (typeof x === "number") return Duration.millis(x);
  if (x !== null && typeof x === "object" && "tag" in x) {
    const t = x as { tag: unknown; millis?: unknown; nanos?: unknown; direction?: unknown };
    if (t.tag === "millis" && typeof t.millis === "number") return Duration.millis(t.millis);
    if (t.tag === "nanos" && Number.isSafeInteger(t.nanos))
      return Duration.nanos(BigInt(t.nanos as number));
    if (t.tag === "infinity") {
      if (t.direction === "positive") return Duration.infinity;
      if (t.direction === "negative") return Duration.negativeInfinity;
    }
  }
  throw new RepositoryError({
    operation: "decodeDuration",
    cause: `unknown duration encoding: ${JSON.stringify(x)}`,
  });
};
const encodeDuration = (d: Duration.Duration): number | Record<string, unknown> =>
  Duration.match({
    onMillis: (millis) =>
      Number.isInteger(millis) ? millis : { tag: "nanos", nanos: millis * 1_000_000 },
    onNanos: (nanos) => {
      const asMillis = Number(nanos) / 1_000_000;
      if (!Number.isFinite(asMillis))
        throw new RepositoryError({
          operation: "saveCheck",
          cause: `duration ${String(nanos)} nanos is not representable`,
        });
      return Number.isInteger(asMillis) ? asMillis : { tag: "nanos", nanos: Number(nanos) };
    },
    onInfinity: () => ({ tag: "infinity", direction: "positive" }),
    onNegativeInfinity: () => ({ tag: "infinity", direction: "negative" }),
  })(d);

const encodeCheck = (c: CheckResult) =>
  JSON.stringify({
    id: c.id,
    targetId: c.targetId,
    checkedAt: c.checkedAt.toISOString(),
    duration: encodeDuration(c.duration),
    classification: { _tag: c.classification._tag },
    ...(Option.isSome(c.failure)
      ? { failure: { reason: c.failure.value.reason } }
      : {}),
    response: {
      ...(Option.isSome(c.response.status) ? { status: c.response.status.value } : {}),
      ...(Option.isSome(c.response.bytes) ? { bytes: c.response.bytes.value } : {}),
    },
  });

const decodeCheck = (s: string) => {
  try {
    const x = JSON.parse(s) as {
      id: string;
      targetId: string;
      checkedAt: string;
      duration: unknown;
      classification: { _tag: string };
      failure?: { reason: string };
      response?: { status?: number; bytes?: number };
    };
    return new CheckResult({
      id: x.id as never,
      targetId: targetId(x.targetId),
      checkedAt: new Date(x.checkedAt),
      duration: decodeDuration(x.duration),
      classification: new classes[
        x.classification._tag as keyof typeof classes
      ](),
      failure: x.failure
        ? Option.some(new CheckFailure({ reason: x.failure.reason }))
        : Option.none(),
      response: new ResponseMetadata({
        status: x.response?.status === undefined ? Option.none() : Option.some(x.response.status),
        bytes: x.response?.bytes === undefined ? Option.none() : Option.some(x.response.bytes),
      }),
    });
  } catch (e) {
    throw new RepositoryError({ operation: "check", cause: e });
  }
};

const encodeIncident = (i: Incident) =>
  JSON.stringify({
    id: i.id,
    targetId: i.targetId,
    openedAt: i.openedAt.toISOString(),
    status: i.status,
    reason: i.reason,
    latestCheckId: i.latestCheckId,
    ...(Option.isSome(i.summary) ? { summary: i.summary.value } : {}),
    ...(Option.isSome(i.closedAt) ? { closedAt: i.closedAt.value.toISOString() } : {}),
  });

const decodeIncident = (s: string) => {
  try {
    const x = JSON.parse(s) as {
      id: string;
      targetId: string;
      openedAt: string;
      status: "Open" | "Closed";
      reason: string;
      latestCheckId: string;
      summary?: string;
      closedAt?: string;
    };
    return new Incident({
      id: x.id as never,
      targetId: targetId(x.targetId),
      openedAt: new Date(x.openedAt),
      status: x.status,
      reason: x.reason,
      latestCheckId: x.latestCheckId,
      summary: x.summary === undefined ? Option.none() : Option.some(x.summary),
      closedAt: x.closedAt === undefined ? Option.none() : Option.some(new Date(x.closedAt)),
    });
  } catch (e) {
    throw new RepositoryError({ operation: "incident", cause: e });
  }
};

// ---------- Repository layer.

/**
 * SQLite repository: the same public semantics as the volatile repository
 * (SPEC 4.1/4.2), with an incident_events row and a delivery-outbox row
 * written inside the commit transaction, and external delivery starting only
 * after the transaction has committed (SPEC 4.3).
 */
const makeRepo = (
  sql: SqlClient.SqlClient,
  send: (eventId: number) => void | Promise<void>,
): CheckRepositoryShape => {
  const migrate = Effect.gen(function*() {
    yield* sql`create table if not exists targets (id text primary key, json text not null)`;
    yield* sql`create table if not exists checks (id text primary key, json text not null)`;
    yield* sql`create table if not exists incidents (id text primary key, json text not null)`;
    yield* sql`create table if not exists incident_events (id integer primary key autoincrement, incident_id text not null, check_id text not null, event_type text not null, created_at integer not null)`;
    yield* sql`create table if not exists delivery_outbox (id integer primary key autoincrement, event_id integer not null unique references incident_events(id), delivered_at integer)`;
  }).pipe(Effect.mapError(repoError("migrate")));

  const saveTarget = (t: Target) =>
    sql`insert into targets (id, json) values (${t.id}, ${JSON.stringify(Schema.encodeSync(Target)(t))}) on conflict(id) do update set json = excluded.json`
      .pipe(Effect.asVoid, Effect.mapError(repoError("saveTarget")));

  const listTargets = Effect.gen(function*() {
    const rows = yield* sql<{ json: string }>`select json from targets order by id`;
    return yield* Effect.try(() =>
      rows.map((r) =>
        // Targets persist in their schema-encoded form; decoding validates.
        Schema.decodeUnknownSync(Target)(JSON.parse(String(r.json))),
      ),
    ).pipe(Effect.mapError(repoError("listTargets")));
  });

  const saveCheck = (c: CheckResult) =>
    Effect.gen(function*() {
      const rows = yield* sql<{ json: string }>`select json from checks where id = ${c.id} limit 1`;
      if (rows[0] !== undefined) {
        const old = decodeCheck(String(rows[0].json));
        if (JSON.stringify(old) !== JSON.stringify(c))
          return yield* Effect.fail(conflicting(String(c.id)));
        return;
      }
      yield* sql`insert into checks (id, json) values (${c.id}, ${encodeCheck(c)})`;
    }).pipe(Effect.mapError((e: unknown) => e instanceof RepositoryError ? e : repoError("saveCheck")(e)));

  const listChecks = (id?: TargetId) =>
    Effect.gen(function*() {
      const rows = id
        ? yield* sql<{ json: string }>`select json from checks where json_extract(json,'$.targetId') = ${id} order by json_extract(json,'$.checkedAt'), id`
        : yield* sql<{ json: string }>`select json from checks order by json_extract(json,'$.checkedAt'), id`;
      return yield* Effect.try(() => rows.map((r) => decodeCheck(String(r.json))));
    }).pipe(Effect.mapError((e: unknown) => e instanceof RepositoryError ? e : repoError("listChecks")(e)));

  const getIncident = (id: string) =>
    Effect.gen(function*() {
      const rows = yield* sql<{ json: string }>`select json from incidents where id = ${id} limit 1`;
      return rows[0] === undefined ? Option.none() : Option.some(decodeIncident(String(rows[0].json)));
    }).pipe(Effect.mapError(repoError("getIncident")));

  const getOpenIncident = (id: TargetId) =>
    Effect.gen(function*() {
      const rows = yield* sql<{ json: string }>`select json from incidents where json_extract(json,'$.targetId') = ${id} and json_extract(json,'$.status') = 'Open' order by json_extract(json,'$.openedAt') desc, id desc limit 1`;
      return rows[0] === undefined ? Option.none() : Option.some(decodeIncident(String(rows[0].json)));
    }).pipe(Effect.mapError(repoError("getOpenIncident")));

  const saveIncident = (i: Incident) =>
    sql`insert into incidents (id, json) values (${i.id}, ${encodeIncident(i)}) on conflict(id) do update set json = excluded.json`
      .pipe(Effect.asVoid, Effect.mapError(repoError("saveIncident")));

  const applyCheck = (c: CheckResult) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) =>
      sql.withTransaction(
        Effect.gen(function*() {
          const existingRows = yield* sql<{ json: string }>`select json from checks where id = ${c.id} limit 1`;
          if (existingRows[0] !== undefined) {
            const existing = decodeCheck(String(existingRows[0].json));
            if (JSON.stringify(existing) !== JSON.stringify(c))
              return yield* Effect.fail(conflicting(String(c.id)));
            return {
              transition: "Unchanged" as IncidentTransition,
              eventIds: [] as number[],
            };
          }
          const targetChecks = (yield* sql<{ json: string }>`select json from checks where json_extract(json,'$.targetId') = ${String(c.targetId)}`)
            .map((r) => decodeCheck(String(r.json)))
            .filter((x) => x.id !== c.id);
          const targetIncidents = (yield* sql<{ json: string }>`select json from incidents where json_extract(json,'$.targetId') = ${String(c.targetId)}`)
            .map((r) => decodeIncident(String(r.json)));
          const outcome = decideTransition({
            targetChecks,
            targetIncidents,
            check: c,
            now,
          });
          yield* sql`insert into checks (id, json) values (${c.id}, ${encodeCheck(c)})`;
          for (const incident of outcome.incidents)
            yield* sql`insert into incidents (id, json) values (${incident.id}, ${encodeIncident(incident)}) on conflict(id) do update set json = excluded.json`;
          const eventIds: number[] = [];
          if (outcome.transition !== "Unchanged") {
            for (const incident of outcome.incidents) {
              const event = yield* sql<{ id: number }>`insert into incident_events (incident_id, check_id, event_type, created_at) values (${incident.id}, ${c.id}, ${outcome.transition}, ${now}) returning id`;
              const eventId = Number(event[0]?.id ?? -1);
              yield* sql`insert into delivery_outbox (event_id) values (${eventId})`;
              eventIds.push(eventId);
            }
          }
          return { transition: outcome.transition, eventIds };
        }),
      ).pipe(
        Effect.mapError((e: unknown) =>
          e instanceof RepositoryError ? e : repoError("applyCheck")(e),
        ),
      ),
    ).pipe(
      Effect.flatMap(({ transition, eventIds }) =>
        eventIds.length === 0
          ? Effect.succeed(transition)
          : Effect.forEach(
              eventIds,
              (eventId) =>
                Effect.tryPromise({
                  try: () => Promise.resolve(send(eventId)),
                  catch: (e) => repoError("deliver")(e),
                }),
              { discard: true },
            ).pipe(Effect.as(transition)),
      ),
    );

  const pendingEvents = Effect.gen(function*() {
    const rows = yield* sql<{ id: number; event_id: number }>`select id, event_id from delivery_outbox where delivered_at is null order by id`;
    return rows.map((r) => ({ id: Number(r.id), eventId: Number(r.event_id) }));
  }).pipe(Effect.mapError(repoError("deliverPending")));

  const deliverPending = (deliver: (eventId: number) => void | Promise<void>) =>
    Effect.gen(function*() {
      const rows = yield* pendingEvents;
      for (const row of rows) {
        yield* Effect.tryPromise({
          try: () => Promise.resolve(deliver(row.eventId)),
          catch: (e) => repoError("deliver")(e),
        });
        yield* sql`update delivery_outbox set delivered_at = ${Date.now()} where id = ${row.id} and delivered_at is null`;
      }
    }).pipe(Effect.mapError((e: unknown) => e instanceof RepositoryError ? e : repoError("deliver")(e)));

  return {
    saveTarget,
    listTargets: () => listTargets,
    saveCheck,
    listChecks,
    getIncident,
    getOpenIncident,
    saveIncident,
    applyCheck,
    migrate,
    pendingEvents: () => pendingEvents,
    deliverPending,
  } as CheckRepositoryShape;
};

export type SqliteRepo = CheckRepositoryShape & {
  readonly migrate: Effect.Effect<void, RepositoryError>;
  readonly pendingEvents: () => Effect.Effect<
    ReadonlyArray<{ id: number; eventId: number }>,
    RepositoryError
  >;
  readonly deliverPending: (
    deliver: (eventId: number) => void | Promise<void>,
  ) => Effect.Effect<void, RepositoryError>;
};

export const layerForFile = (
  filename: string,
  send: (eventId: number) => void | Promise<void> = () => {},
): Layer.Layer<CheckRepository | SqlClient.SqlClient, never, never> =>
  Layer.provideMerge(
    Layer.effect(CheckRepository)(
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient;
        const repo = makeRepo(sql, send);
        yield* repo.migrate;
        return repo;
      }),
    ),
    SqliteClient.layer({ filename }),
  );

export const tempLayer = (send?: (eventId: number) => void | Promise<void>) =>
  layerForFile(makeTempFilename(), send);
