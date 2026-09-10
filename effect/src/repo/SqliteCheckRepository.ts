import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Clock, Context, Duration, Effect, Equal, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { RepositoryError } from "../domain/errors.js"
import { CheckResult, Incident, Target, type Classification as ClassificationType } from "../domain/schema.js"
import { CheckRepository, type CheckApplication, type IncidentTransition } from "./CheckRepository.js"
import { ConnectionPool, layer as ConnectionPoolLayer } from "./ConnectionPool.js"

const repoError = (operation: string) => (cause: unknown) => new RepositoryError({ operation, cause })

const tagOf = (c: ClassificationType) => c._tag
const optDate = (n: number | null | undefined) => n == null ? Option.none<Date>() : Option.some(new Date(n))
const optString = (s: string | null | undefined) => s == null ? Option.none<string>() : Option.some(s)

const NullableString = Schema.Union([Schema.String, Schema.Null])
const NullableNumber = Schema.Union([Schema.Number, Schema.Null])
const TargetRow = Schema.Struct({ json: Schema.String })
type TargetRow = typeof TargetRow.Type
const CheckResultRow = Schema.Struct({
  id: Schema.String,
  target_id: Schema.String,
  checked_at: Schema.Number,
  duration_ms: Schema.Union([Schema.Number, Schema.String]),
  classification: Schema.String,
  failure_reason: NullableString,
  response_status: NullableNumber,
  response_bytes: NullableNumber
})
type CheckResultRow = typeof CheckResultRow.Type
const IncidentRow = Schema.Struct({
  id: Schema.String,
  target_id: Schema.String,
  opened_at: Schema.Number,
  closed_at: NullableNumber,
  status: Schema.String,
  reason: Schema.String,
  latest_check_id: Schema.String,
  summary: NullableString
})
type IncidentRow = typeof IncidentRow.Type
const OutboxRow = Schema.Struct({ id: Schema.Number, event_id: Schema.Number })

const decodeRow = <S extends Schema.Constraint>(schema: S, input: unknown) => Schema.decodeUnknownEffect(schema)(input)
const decodeTargetJson = (json: string) => Effect.gen(function*() {
  const parsed = yield* Effect.try({ try: () => JSON.parse(json), catch: (cause) => cause })
  return yield* Schema.decodeUnknownEffect(Target)(parsed)
})

const encodeDurationInput = Duration.match({
  onMillis: (millis) => `${BigInt(millis)} millis`,
  onNanos: (nanos) => `${nanos} nanos`,
  onInfinity: () => "Infinity",
  onNegativeInfinity: () => "-Infinity"
})
const encodeTargetJson = (target: Target) => JSON.stringify({
  ...target,
  interval: encodeDurationInput(target.interval),
  timeout: encodeDurationInput(target.timeout),
  slowThreshold: encodeDurationInput(target.slowThreshold)
})
const encodeDuration = Duration.match({
  onMillis: (millis) => `millis:${millis}`,
  onNanos: (nanos) => `nanos:${nanos}`,
  onInfinity: () => "infinity",
  onNegativeInfinity: () => "negative-infinity"
})
const decodeDuration = (value: number | string) => {
  if (typeof value === "number") return Effect.succeed(Duration.millis(value))
  if (value === "infinity") return Effect.succeed(Duration.infinity)
  if (value === "negative-infinity") return Effect.succeed(Duration.negativeInfinity)
  if (value.startsWith("millis:")) return Effect.succeed(Duration.millis(Number(value.slice("millis:".length))))
  if (!value.startsWith("nanos:")) return Effect.fail(new Error(`unknown duration encoding: ${value}`))
  return Effect.try({
    try: () => Duration.nanos(BigInt(value.slice("nanos:".length))),
    catch: (cause) => cause
  })
}

export const makeTempFilename = () => join(tmpdir(), `beaconwatch-${process.pid}-${Date.now()}-${randomUUID()}.sqlite`)

export const migrate = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`create table if not exists targets (id text primary key, json text not null)`
  yield* sql`create table if not exists check_results (id text primary key, target_id text not null, checked_at integer not null, duration_ms integer not null, classification text not null, failure_reason text, response_status integer, response_bytes integer)`
  yield* sql`create table if not exists incidents (id text primary key, target_id text not null, opened_at integer not null, closed_at integer, status text not null, reason text not null, latest_check_id text not null, summary text)`
  yield* sql`create table if not exists incident_events (id integer primary key autoincrement, incident_id text not null, check_id text not null, event_type text not null, created_at integer not null)`
  yield* sql`create table if not exists delivery_outbox (id integer primary key autoincrement, event_id integer not null unique references incident_events(id), delivered_at integer)`
}).pipe(Effect.mapError(repoError("migrate")))

export const saveTarget = (target: Target) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`insert into targets (id, json) values (${target.id}, ${encodeTargetJson(target)}) on conflict(id) do update set json = excluded.json`
}).pipe(Effect.mapError(repoError("saveTarget")))

export const listTargets = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<TargetRow>`select json from targets order by id`
  return yield* Effect.forEach(rows, (row) => Effect.gen(function*() {
    const decodedRow = yield* decodeRow(TargetRow, row)
    return yield* decodeTargetJson(decodedRow.json)
  }))
}).pipe(Effect.mapError(repoError("listTargets")))

export const insertCheckSql = (check: CheckResult) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const existingRows = yield* sql<CheckResultRow>`select * from check_results where id = ${check.id} limit 1`
  if (existingRows[0]) {
    const existing = yield* decodeRow(CheckResultRow, existingRows[0]).pipe(Effect.flatMap(rowToCheck))
    if (!Equal.equals(existing, check)) {
      return yield* Effect.fail(new RepositoryError({ operation: "saveCheck", cause: `check id ${check.id} already has different contents` }))
    }
    return false
  }
  yield* sql`insert into check_results (id, target_id, checked_at, duration_ms, classification, failure_reason, response_status, response_bytes) values (${check.id}, ${check.targetId}, ${check.checkedAt.getTime()}, ${encodeDuration(check.duration)}, ${tagOf(check.classification)}, ${check.failure?.reason ?? null}, ${check.response.status ?? null}, ${check.response.bytes ?? null})`
  return true
})

export const upsertIncidentSql = (incident: Incident) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`insert into incidents (id, target_id, opened_at, closed_at, status, reason, latest_check_id, summary) values (${incident.id}, ${incident.targetId}, ${incident.openedAt.getTime()}, ${Option.getOrNull(Option.map(incident.closedAt, (d) => d.getTime()))}, ${incident.status}, ${incident.reason}, ${incident.latestCheckId}, ${Option.getOrNull(incident.summary)}) on conflict(id) do update set target_id = excluded.target_id, opened_at = excluded.opened_at, closed_at = excluded.closed_at, status = excluded.status, reason = excluded.reason, latest_check_id = excluded.latest_check_id, summary = excluded.summary`
})

const rowToCheck = (row: CheckResultRow) => Effect.gen(function*() {
  const duration = yield* decodeDuration(row.duration_ms)
  return yield* Schema.decodeUnknownEffect(CheckResult)({
    id: row.id,
    targetId: row.target_id,
    checkedAt: new Date(row.checked_at),
    duration,
    classification: { _tag: row.classification },
    ...(row.failure_reason == null ? {} : { failure: { _tag: "CheckFailure", reason: row.failure_reason } }),
    response: { ...(row.response_status == null ? {} : { status: row.response_status }), ...(row.response_bytes == null ? {} : { bytes: row.response_bytes }) }
  })
})

export const rowToIncident = (row: IncidentRow) => Effect.gen(function*() {
  return yield* Schema.decodeUnknownEffect(Incident)({ id: row.id, targetId: row.target_id, openedAt: new Date(row.opened_at), closedAt: optDate(row.closed_at), status: row.status, reason: row.reason, latestCheckId: row.latest_check_id, summary: optString(row.summary) })
})

export const persistCheckIncidentEventWithIncident = (check: CheckResult, options?: { readonly failAfterCheck?: boolean }): Effect.Effect<CheckApplication, RepositoryError, SqlClient.SqlClient> => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  return yield* sql.withTransaction(Effect.gen(function*() {
    const result = (transition: IncidentTransition) => sql<IncidentRow>`select * from incidents where target_id = ${check.targetId} and status = 'Open' order by opened_at desc, id desc limit 1`.pipe(
      Effect.flatMap((rows) => Option.match(Option.fromNullishOr(rows[0]), {
        onNone: () => Effect.succeed({ transition, openIncident: Option.none<Incident>() }),
        onSome: (row) => decodeRow(IncidentRow, row).pipe(Effect.flatMap(rowToIncident), Effect.map((incident) => ({ transition, openIncident: Option.some(incident) })))
      }))
    )
    const inserted = yield* insertCheckSql(check)
    if (!inserted) return yield* result("Unchanged")
    if (options?.failAfterCheck) return yield* Effect.fail(new RepositoryError({ operation: "forced", cause: "failAfterCheck" }))
    const newer = yield* sql<{ readonly id: string }>`select id from check_results where target_id = ${check.targetId} and checked_at > ${check.checkedAt.getTime()} limit 1`
    if (newer.length > 0) return yield* result("Unchanged")
    const openRows = yield* sql<IncidentRow>`select * from incidents where target_id = ${check.targetId} and status = 'Open' order by opened_at desc, id desc`
    const now = new Date(yield* Clock.currentTimeMillis)
    if (check.classification._tag === "Up" && openRows.length > 0) {
      const openIncidents = yield* Effect.forEach(openRows, (row) => decodeRow(IncidentRow, row).pipe(Effect.flatMap(rowToIncident)))
      for (const open of openIncidents) {
        const closedAt = new Date(Math.max(now.getTime(), open.openedAt.getTime()))
        const closed = new Incident({ ...open, closedAt: Option.some(closedAt), status: "Closed", latestCheckId: check.id })
        yield* upsertIncidentSql(closed)
        const events = yield* sql<{ readonly id: number }>`insert into incident_events (incident_id, check_id, event_type, created_at) values (${closed.id}, ${check.id}, 'Closed', ${closedAt.getTime()}) returning id`
        yield* sql`insert into delivery_outbox (event_id) values (${events[0]!.id})`
      }
      return yield* result("Closed")
    }
    const open = yield* Option.match(Option.fromNullishOr(openRows[0]), {
      onNone: () => Effect.succeed(Option.none<Incident>()),
      onSome: (row) => decodeRow(IncidentRow, row).pipe(Effect.flatMap(rowToIncident), Effect.map(Option.some))
    })
    let incident: Incident | undefined
    let event: IncidentTransition = "Unchanged"
    if (check.classification._tag === "Down" || check.classification._tag === "InvalidResponse" || check.classification._tag === "Slow") {
      const reason = check.failure?.reason ?? check.classification._tag
      if (Option.isSome(open)) {
        incident = new Incident({ ...open.value, reason, latestCheckId: check.id })
        event = "Updated"
      } else {
        incident = new Incident({ id: `incident_${randomUUID()}`, targetId: check.targetId, openedAt: now, closedAt: Option.none(), status: "Open", reason, latestCheckId: check.id, summary: Option.none() })
        event = "Opened"
      }
    }
    if (incident) {
      yield* upsertIncidentSql(incident)
      const events = yield* sql<{ readonly id: number }>`insert into incident_events (incident_id, check_id, event_type, created_at) values (${incident.id}, ${check.id}, ${event}, ${now.getTime()}) returning id`
      yield* sql`insert into delivery_outbox (event_id) values (${events[0]!.id})`
    }
    return yield* result(event)
  }))
}).pipe(Effect.mapError((e) => e instanceof RepositoryError ? e : repoError("persistCheckIncidentEvent")(e)))

export const persistCheckIncidentEvent = (check: CheckResult, options?: { readonly failAfterCheck?: boolean }): Effect.Effect<IncidentTransition, RepositoryError, SqlClient.SqlClient> =>
  persistCheckIncidentEventWithIncident(check, options).pipe(Effect.map(({ transition }) => transition))

/** Delivery happens after the write transaction. A crash after send and before
 * acknowledgement leaves the row pending, intentionally providing at-least-once delivery. */
export const deliverPending = Effect.fn("SqliteCheckRepository.deliverPending")(function*<E, R>(
  send: (eventId: number) => Effect.Effect<void, E, R>
) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`select id, event_id from delivery_outbox where delivered_at is null order by id`
  for (const unknownRow of rows) {
    const row = yield* decodeRow(OutboxRow, unknownRow)
    yield* send(row.event_id)
    yield* sql`update delivery_outbox set delivered_at = ${yield* Clock.currentTimeMillis} where id = ${row.id} and delivered_at is null`
  }
})

export interface OutboxDeliveryShape {
  readonly deliverPending: <E, R>(
    send: (eventId: number) => Effect.Effect<void, E, R>
  ) => Effect.Effect<void, unknown, R>
}

export class OutboxDelivery extends Context.Service<OutboxDelivery, OutboxDeliveryShape>()("beaconwatch/OutboxDelivery") {}

export const Live = Layer.effectContext(Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const pool = yield* ConnectionPool
  yield* migrate.pipe(Effect.provideService(SqlClient.SqlClient, sql))
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    pool.withConnection(effect.pipe(Effect.provideService(SqlClient.SqlClient, sql)))
  const repository = CheckRepository.of({
    saveTarget: (target) => run(saveTarget(target)).pipe(Effect.mapError(repoError("saveTarget"))),
    listTargets: () => run(listTargets as Effect.Effect<ReadonlyArray<Target>, unknown, SqlClient.SqlClient>).pipe(Effect.mapError(repoError("listTargets"))),
    saveCheck: (check) => run(sql.withTransaction(insertCheckSql(check))).pipe(
      Effect.asVoid,
      Effect.mapError((error) => error instanceof RepositoryError ? error : repoError("saveCheck")(error))
    ),
    listChecks: (targetId) => run((targetId === undefined ? sql<CheckResultRow>`select * from check_results order by checked_at, id` : sql<CheckResultRow>`select * from check_results where target_id = ${targetId} order by checked_at, id`).pipe(Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeRow(CheckResultRow, row).pipe(Effect.flatMap(rowToCheck))))) as Effect.Effect<ReadonlyArray<CheckResult>, unknown, SqlClient.SqlClient>).pipe(Effect.mapError(repoError("listChecks"))),
    getIncident: (id) => run(sql<IncidentRow>`select * from incidents where id = ${id} limit 1`.pipe(Effect.flatMap((rows) => Option.match(Option.fromNullishOr(rows[0]), { onNone: () => Effect.succeed(Option.none()), onSome: (row) => decodeRow(IncidentRow, row).pipe(Effect.flatMap(rowToIncident), Effect.map(Option.some)) }))) as Effect.Effect<Option.Option<Incident>, unknown, SqlClient.SqlClient>).pipe(Effect.mapError(repoError("getIncident"))),
    getOpenIncident: (targetId) => run(sql<IncidentRow>`select * from incidents where target_id = ${targetId} and status = 'Open' order by opened_at desc, id desc limit 1`.pipe(Effect.flatMap((rows) => Option.match(Option.fromNullishOr(rows[0]), { onNone: () => Effect.succeed(Option.none()), onSome: (row) => decodeRow(IncidentRow, row).pipe(Effect.flatMap(rowToIncident), Effect.map(Option.some)) }))) as Effect.Effect<Option.Option<Incident>, unknown, SqlClient.SqlClient>).pipe(Effect.mapError(repoError("getOpenIncident"))),
    saveIncident: (incident) => run(upsertIncidentSql(incident)).pipe(Effect.mapError(repoError("saveIncident"))),
    applyCheckWithIncident: (check) => run(persistCheckIncidentEventWithIncident(check)).pipe(
      Effect.mapError((error) => error instanceof RepositoryError ? error : repoError("applyCheckWithIncident")(error))
    ),
    applyCheck: (check) => run(persistCheckIncidentEvent(check)).pipe(
      Effect.mapError((error) => error instanceof RepositoryError ? error : repoError("applyCheck")(error))
    )
  })
  const outbox = OutboxDelivery.of({
    deliverPending: (send) => run(deliverPending(send))
  })
  return Context.make(CheckRepository, repository).pipe(
    Context.add(OutboxDelivery, outbox)
  )
}))

export const layerForFile = (filename: string) => Layer.provide(Live, Layer.mergeAll(SqliteClient.layer({ filename }), ConnectionPoolLayer(4)))
export const tempLayer = () => layerForFile(makeTempFilename())
