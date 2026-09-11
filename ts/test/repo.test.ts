import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Layer, Option, Result } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/unstable/sql";
import {
  CheckResult,
  Down,
  Incident,
  ResponseMetadata,
  Target,
  Up,
  targetId,
  durationMillis,
  type CheckId,
  type IncidentId,
  type TargetId,
} from "../src/domain/schema.js";
import { CheckRepository, InMemoryLayer } from "../src/repo/CheckRepository.js";
import {
  layerForFile,
  makeTempFilename,
} from "../src/repo/SqliteCheckRepository.js";
import { RepositoryError } from "../src/domain/errors.js";

const check = (id: string, tag: "Up" | "Down", at: number, duration: number | string = "1 ms") =>
  new CheckResult({
    id: id as CheckId,
    targetId: targetId("target_api"),
    checkedAt: new Date(at),
    duration: typeof duration === "number" ? DurationMillisInput.millis(duration) : DurationMillisInput.millis(durationMillis(duration)),
    classification: tag === "Up" ? new Up() : new Down(),
    failure: Option.none(),
    response: new ResponseMetadata({ status: Option.some(200), bytes: Option.none() }),
  });
import { Duration as DurationMillisInput } from "effect";

const makeTarget = (id: string) =>
  new Target({
    id: targetId(id),
    name: "T",
    url: "http://example.test",
    method: "GET",
    expectedStatus: [200] as [number, ...number[]],
    interval: DurationMillisInput.millis(10),
    timeout: DurationMillisInput.millis(50),
    slowThreshold: DurationMillisInput.millis(100),
    enabled: true,
  });

const withMemory = <A, E, R>(
  f: Effect.Effect<A, E, R>,
) => f.pipe(Effect.provide(InMemoryLayer));

const withSqlite = <A, E, R>(
  send: (eventId: number) => void | Promise<void> = () => {},
  f?: Effect.Effect<A, E, R>,
) => {
  const file = makeTempFilename();
  return (f ?? Effect.void).pipe(Effect.provide(layerForFile(file, send)));
};

describe("in-memory repository", () => {
  it.effect("transitions open, update, and close incidents", () =>
    withMemory(Effect.gen(function*() {
      const repo = yield* CheckRepository;
      expect(yield* repo.applyCheck(check("check_1", "Down", 100))).toBe("Opened");
      expect(yield* repo.applyCheck(check("check_2", "Down", 200))).toBe("Updated");
      expect(yield* repo.applyCheck(check("check_3", "Up", 300))).toBe("Closed");
      expect(Option.isNone(yield* repo.getOpenIncident(targetId("target_api")))).toBe(true);
      expect((yield* repo.listChecks()).length).toBe(3);
    })));

  it.effect("older checks are saved but leave incident state unchanged", () =>
    withMemory(Effect.gen(function*() {
      const repo = yield* CheckRepository;
      expect(yield* repo.applyCheck(check("check_2", "Down", 200))).toBe("Opened");
      expect(yield* repo.applyCheck(check("check_1", "Down", 100))).toBe("Unchanged");
    })));

  it.effect("exact duplicates are idempotent; conflicts fail", () =>
    withMemory(Effect.gen(function*() {
      const repo = yield* CheckRepository;
      const c = check("check_1", "Down", 100);
      yield* repo.saveCheck(c);
      yield* repo.saveCheck(c); // idempotent
      const outcome = yield* Effect.result(
        repo.saveCheck(check("check_1", "Down", 100, "2 ms")),
      );
      expect(Result.isFailure(outcome)).toBe(true);
      if (Result.isFailure(outcome)) expect(outcome.failure._tag).toBe("RepositoryError");
    })));

  it.effect("concurrent failures produce one Opened and one Updated", () =>
    withMemory(Effect.gen(function*() {
      const repo = yield* CheckRepository;
      const transitions = yield* Effect.all([
        repo.applyCheck(check("check_1", "Down", 100)),
        repo.applyCheck(check("check_2", "Down", 200)),
      ]);
      expect(transitions.filter((t) => t === "Opened")).toHaveLength(1);
      expect(transitions.filter((t) => t === "Updated")).toHaveLength(1);
      const open = yield* repo.getOpenIncident(targetId("target_api"));
      expect(Option.getOrThrow(open).latestCheckId).toBe("check_2");
    })));
});

describe("sqlite repository", () => {
  it.effect("saves targets in ascending bytewise id order", () =>
    Effect.gen(function*() {
      const repo = yield* CheckRepository;
      yield* repo.saveTarget(makeTarget("target_b"));
      yield* repo.saveTarget(makeTarget("target_a"));
      const targets = yield* repo.listTargets();
      expect(targets.map((t) => t.id)).toEqual(["target_a", "target_b"]);
    }).pipe(Effect.provide(layerForFile(makeTempFilename()))));

  it.effect("durations round-trip exactly through the codec", () =>
    Effect.gen(function*() {
      const repo = yield* CheckRepository;
      const fractional = check("check_frac", "Up", 100, 0.5); // sub-millisecond
      const whole = check("check_whole", "Up", 200, 42);
      const infinite = check("check_inf", "Up", 300, Number.POSITIVE_INFINITY);
      yield* repo.saveCheck(fractional);
      yield* repo.saveCheck(whole);
      yield* repo.saveCheck(infinite);
      const rows = yield* repo.listChecks();
      const byId = new Map(rows.map((c) => [c.id, DurationMillisInput.toMillis(c.duration)]));
      expect(byId.get("check_frac" as CheckId)).toBe(0.5);
      expect(byId.get("check_whole" as CheckId)).toBe(42);
      expect(byId.get("check_inf" as CheckId)).toBe(Number.POSITIVE_INFINITY);
    }).pipe(Effect.provide(layerForFile(makeTempFilename()))));

  it.effect("conflicting re-saves fail as repository errors", () =>
    Effect.gen(function*() {
      const repo = yield* CheckRepository;
      yield* repo.saveCheck(check("check_ok", "Up", 100));
      const outcome = yield* Effect.result(
        repo.saveCheck(check("check_ok", "Up", 100, "9 ms")),
      );
      expect(Result.isFailure(outcome)).toBe(true);
    }).pipe(Effect.provide(layerForFile(makeTempFilename()))));
});

describe("sqlite outbox and decode (BUGS 15.2, 15.3, 15.5, decode fix)", () => {
  it.effect("persists events inside the transaction and delivers only after commit", () => {
    const delivered: number[] = [];
    return Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient;
      const repo = yield* CheckRepository;
      const exit = yield* Effect.exit(repo.applyCheck(check("check_1", "Down", 100)));
      // Delivery fails, so the transition rejects — but after commit.
      expect(exit._tag).toBe("Failure");
      const rows = yield* sql<{ event_type: string }>`select event_type from incident_events`;
      expect(rows.map((r) => r.event_type)).toEqual(["Opened"]);
      const outbox = yield* sql<{ event_id: number; delivered_at: number | null }>`select event_id, delivered_at from delivery_outbox`;
      expect(outbox).toHaveLength(1);
      expect(outbox[0]!.delivered_at).toBeNull();
      expect(delivered).toEqual([outbox[0]!.event_id]);
    }).pipe(Effect.provide(layerForFile(makeTempFilename(), (id) => {
      delivered.push(id);
      return Promise.reject(new Error("delivery failure after commit"));
    })));
  });

  it.effect("delivery retries pending outbox rows and acknowledges them", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient;
      const repo = yield* CheckRepository;
      const delivered: number[] = [];
      // Reusing the same database: construct a second repo layer view over it
      // is unnecessary — the repository exposes the delivery pass directly.
      yield* (repo as unknown as {
        applyCheck: (c: CheckResult) => Effect.Effect<string, RepositoryError>;
      }).applyCheck(check("check_1", "Down", 100));
      const pendingBefore = yield* (repo as unknown as {
        pendingEvents: () => Effect.Effect<ReadonlyArray<{ id: number; eventId: number }>, RepositoryError>;
      }).pendingEvents();
      expect(pendingBefore).toHaveLength(1);
      yield* (repo as unknown as {
        deliverPending: (d: (id: number) => Promise<void>) => Effect.Effect<void, RepositoryError>;
      }).deliverPending(async (id) => {
        delivered.push(id);
      });
      expect(delivered).toEqual([pendingBefore[0]!.eventId]);
      const pendingAfter = yield* (repo as unknown as {
        pendingEvents: () => Effect.Effect<ReadonlyArray<{ id: number; eventId: number }>, RepositoryError>;
      }).pendingEvents();
      expect(pendingAfter).toHaveLength(0);
      void sql;
    }).pipe(Effect.provide(layerForFile(makeTempFilename(), () => {}))));

  it.effect("incidents round-trip with closed windows intact", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient;
      const repo = yield* CheckRepository;
      yield* repo.applyCheck(check("check_1", "Down", 100));
      yield* TestClock.adjust(300);
      yield* repo.applyCheck(check("check_2", "Up", 200));
      const rows = yield* sql<{ id: string }>`select id from incidents`;
      const incident = yield* repo.getIncident(String(rows[0]!.id));
      const value = Option.getOrThrow(incident);
      expect(value.status).toBe("Closed");
      expect(Option.isSome(value.closedAt)).toBe(true);
      expect(Option.getOrThrow(value.closedAt).getTime()).toBeGreaterThanOrEqual(200);
    }).pipe(Effect.provide(layerForFile(makeTempFilename()))));

  it.effect("unknown duration encodings fail as repository errors (15.5)", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient;
      const repo = yield* CheckRepository;
      yield* repo.saveCheck(check("check_ok", "Up", 100));
      yield* sql`insert into checks (id, json) values (${String("check_bad")}, ${JSON.stringify({
        id: "check_bad",
        targetId: "target_api",
        checkedAt: new Date(0).toISOString(),
        duration: { tag: "bogus", nonsense: 1 },
        classification: { _tag: "Up" },
        failure: { _id: "Option", _tag: "None" },
        response: {
          status: { _id: "Option", _tag: "None" },
          bytes: { _id: "Option", _tag: "None" },
        },
      })})`;
      const outcome = yield* Effect.result(repo.listChecks());
      expect(Result.isFailure(outcome)).toBe(true);
      if (Result.isFailure(outcome)) expect(outcome.failure._tag).toBe("RepositoryError");
    }).pipe(Effect.provide(layerForFile(makeTempFilename()))));
});

describe("incident validation", () => {
  it("rejects bad ids and inverted windows", () => {
    const base = {
      targetId: targetId("target_api"),
      openedAt: new Date(100),
      status: "Open" as const,
      reason: "r",
      latestCheckId: "check_1",
      summary: Option.none() as Option.Option<string>,
      closedAt: Option.none() as Option.Option<Date>,
    };
    expect(() => new Incident({ ...base, id: "nope" as IncidentId })).toThrow();
    expect(() =>
      new Incident({
        ...base,
        id: "incident_ok" as IncidentId,
        status: "Closed",
        closedAt: Option.some(new Date(50)),
      }),
    ).toThrow();
  });
});

describe("sqlite transactions and rollback", () => {
  it.effect("a mid-write failure rolls back the transaction", () =>
    Effect.gen(function*() {
      const repo = yield* CheckRepository;
      const sql = yield* SqlClient.SqlClient;
      // A duration that cannot be encoded fails during the write, after the
      // check insert began: the transaction must leave nothing durable.
      const unrepresentable = new CheckResult({
        id: "check_big" as CheckId,
        targetId: targetId("target_api"),
        checkedAt: new Date(100),
        // A nanosecond count too large to represent as milliseconds in a
        // double makes the codec fail during the write.
        duration: Duration.nanos(BigInt("1" + "0".repeat(400))),
        classification: new Up(),
        failure: Option.none(),
        response: new ResponseMetadata({ status: Option.some(200), bytes: Option.none() }),
      });
      const outcome = yield* Effect.result(repo.applyCheck(unrepresentable));
      expect(Result.isFailure(outcome)).toBe(true);
      const rows = yield* sql<{ n: number }>`select count(*) as n from checks`;
      expect(Number(rows[0]!.n)).toBe(0);
      const incidents = yield* sql<{ n: number }>`select count(*) as n from incidents`;
      expect(Number(incidents[0]!.n)).toBe(0);
      const events = yield* sql<{ n: number }>`select count(*) as n from incident_events`;
      expect(Number(events[0]!.n)).toBe(0);
    }).pipe(Effect.provide(layerForFile(makeTempFilename()))));

  it.effect("preserves conflict error details across repositories", () =>
    Effect.gen(function*() {
      const repo = yield* CheckRepository;
      yield* repo.saveCheck(check("check_c", "Up", 100));
      const outcome = yield* Effect.result(
        repo.saveCheck(check("check_c", "Up", 100, "2 ms")),
      );
      expect(Result.isFailure(outcome)).toBe(true);
      if (Result.isFailure(outcome))
        expect(String((outcome.failure as { cause: unknown }).cause)).toContain("check_c");
    }).pipe(Effect.provide(layerForFile(makeTempFilename()))));
});
