import { it } from "@effect/vitest"
import { Duration, Effect, Option } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { CheckFailure, CheckResult, Down, ResponseMetadata } from "../../src/domain/schema.js"
import { deliverPending, makeTempFilename, migrate, OutboxDelivery } from "../../src/repo/SqliteCheckRepository.js"
import { CheckRepository } from "../../src/repo/CheckRepository.js"
import { tempLayer } from "../../src/repo/SqliteCheckRepository.js"
import { persistCheckIncidentEvent } from "../../src/repo/SqliteCheckRepository.js"
import { target } from "../helpers.js"

const check = new CheckResult({ id: "tx1", targetId: target("target_tx").id, checkedAt: new Date(0), duration: Duration.millis(1), classification: new Down(), failure: new CheckFailure({ reason: "down" }), response: new ResponseMetadata({ status: 500 }) })

it.effect("rolls back a forced mid-write failure", () => Effect.scoped(Effect.provide(Effect.gen(function*() {
  yield* migrate
  yield* Effect.exit(persistCheckIncidentEvent(check, { failAfterCheck: true }))
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<any>`select * from check_results where id = 'tx1'`
  if (rows.length !== 0) throw new Error("check was not rolled back")
}), SqliteClient.layer({ filename: makeTempFilename() }))))

it.effect("does not evaluate the transaction body when transaction start fails", () => {
  let statements = 0
  const sql = Object.assign(
    () => {
      statements++
      return Effect.succeed([])
    },
    {
      withTransaction: () => Effect.fail(new Error("transaction start failed"))
    }
  ) as unknown as SqlClient.SqlClient

  return Effect.gen(function*() {
    const result = yield* Effect.exit(persistCheckIncidentEvent(check))
    if (result._tag !== "Failure") throw new Error("transaction unexpectedly succeeded")
    if (statements !== 0) throw new Error("transaction body ran before transaction start succeeded")
  }).pipe(Effect.provideService(SqlClient.SqlClient, sql))
})

it.effect("returns the SQLite post-transition open incident from the same transaction", () => Effect.gen(function*() {
  const repo = yield* CheckRepository
  const applied = yield* repo.applyCheckWithIncident(new CheckResult({ ...check, id: "tx_atomic" }))
  if (applied.transition !== "Opened" || Option.isNone(applied.openIncident) || applied.openIncident.value.latestCheckId !== "tx_atomic") {
    throw new Error("SQLite atomic snapshot mismatch")
  }
}).pipe(Effect.provide(tempLayer())))

it.effect("commits the durable outbox atomically and retries unacknowledged delivery", () => Effect.scoped(Effect.provide(Effect.gen(function*() {
  yield* migrate
  yield* Effect.exit(persistCheckIncidentEvent(check, { failAfterCheck: true }))
  const sql = yield* SqlClient.SqlClient
  if ((yield* sql`select * from delivery_outbox`).length !== 0) throw new Error("rollback left an outbox row")

  yield* persistCheckIncidentEvent(new CheckResult({ ...check, id: "tx_outbox" }))
  const attempts: Array<number> = []
  const attemptCount = () => attempts.length
  yield* Effect.exit(deliverPending((eventId) => Effect.sync(() => { attempts.push(eventId); throw new Error("crash before acknowledgement") })))
  if (attemptCount() !== 1 || (yield* sql`select * from delivery_outbox where delivered_at is null`).length !== 1) {
    throw new Error("failed delivery was acknowledged")
  }
  yield* deliverPending((eventId) => Effect.sync(() => { attempts.push(eventId) }))
  if (attemptCount() !== 2 || attempts[0] !== attempts[1] || (yield* sql`select * from delivery_outbox where delivered_at is null`).length !== 0) {
    throw new Error("pending delivery was not retried and acknowledged")
  }
}), SqliteClient.layer({ filename: makeTempFilename() }))))

it.effect("exposes post-commit outbox delivery from the SQLite application layer", () => Effect.gen(function*() {
  const repository = yield* CheckRepository
  const outbox = yield* OutboxDelivery
  yield* repository.applyCheck(new CheckResult({ ...check, id: "tx_layer_outbox" }))
  const attempts: number[] = []
  yield* outbox.deliverPending((eventId) => Effect.sync(() => { attempts.push(eventId) }))
  yield* outbox.deliverPending((eventId) => Effect.sync(() => { attempts.push(eventId) }))
  if (attempts.length !== 1) throw new Error(`expected one acknowledged delivery, got ${attempts.length}`)
}).pipe(Effect.provide(tempLayer())))
