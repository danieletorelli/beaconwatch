import { expect, it } from "vitest"
import { Cause, Duration, Effect, Equal, Fiber, TxRef } from "effect"
import { RepositoryError } from "../../src/domain/errors.js"
import { CheckFailure, CheckResult, Down, Incident, ResponseMetadata, Target, Up, targetId } from "../../src/domain/schema.js"
import { startServer } from "../../src/http/server.js"
import { SqliteCheckRepository } from "../../src/repo/SqliteCheckRepository.js"
import { HistoryPlatformLive, decodeHistoryLine, importHistory } from "../../src/services/DigestService.js"
import * as StatusBoard from "../../src/stm/StatusBoard.js"
import { runOnceEffect } from "../../src/watch/Scheduler.js"
import { StatusState } from "../../src/watch/StatusState.js"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const tables = ["checks", "incidents", "incident_events", "delivery_outbox"] as const
const execute = (repo: any, statement: string) => typeof repo.execute === "function" ? repo.execute(statement) : Promise.resolve(repo.db.exec(statement))
const countRows = (repo: any, table: typeof tables[number]) => typeof repo.countRows === "function"
  ? repo.countRows(table)
  : Promise.resolve(Number(repo.db.prepare(`select count(*) as count from ${table}`).get().count))
const runMaybe = <A>(value: A | Promise<A> | Effect.Effect<A>) => Effect.isEffect(value) ? Effect.runPromise(value) : Promise.resolve(value)
const makeStatusBoard: any = StatusBoard.make
const makeBoard = () => runMaybe(typeof makeStatusBoard === "function" ? makeStatusBoard() : makeStatusBoard)
const check = new CheckResult({ id: "check_tx", targetId: targetId("target_tx"), checkedAt: new Date(0), duration: "1 ms", classification: new Down(), failure: new CheckFailure({ reason: "down" }), response: new ResponseMetadata({ status: 500 }) })
const upCheck = () => new CheckResult({ id: check.id, targetId: check.targetId, checkedAt: check.checkedAt, duration: check.duration, classification: new Up(), response: check.response })
const historyRow = (overrides: Record<string, unknown> = {}) => JSON.stringify({ id: "check_history", targetId: "target_history", checkedAt: "2026-01-01T12:34:56.123+05:30", durationMillis: 0.000001, classification: { _tag: "Up" }, response: {}, ...overrides })

it("validates history and HTTP boundaries, then rolls related SQL writes back", async () => {
  for (const row of [
    historyRow({ checkedAt: "2026-01-01" }),
    historyRow({ checkedAt: "2026-02-30T00:00:00Z" }),
    historyRow({ durationMillis: 0.0000009 }),
    JSON.stringify({ ...JSON.parse(historyRow()), duration: 7, response: undefined }),
  ]) await expect(decodeHistoryLine(row, 1)).rejects.toMatchObject({ _tag: "MalformedHistoryRow" })
  await expect(decodeHistoryLine(historyRow(), 1)).resolves.toMatchObject({ id: "check_history" })
  const decodedHistory = await decodeHistoryLine(historyRow({ duration: 7 }), 1)
  expect(Duration.toMillis(decodedHistory.duration)).toBe(0.000001)

  const directory = await mkdtemp(join(tmpdir(), "beaconwatch-history-"))
  const path = join(directory, "history.ndjson")
  try {
    await writeFile(path, [historyRow(), historyRow({ checkedAt: "2026-01-01" }), historyRow({ checkedAt: "2026-02-30T00:00:00Z" }), historyRow({ durationMillis: 0.0000009 })].join("\n"))
    const digest = await Effect.runPromise(importHistory(path).pipe(Effect.provide(HistoryPlatformLive)))
    expect([digest.processedRows, digest.malformedRows, digest.targets[0]?.checks]).toEqual([1, 3, 1])

    const preciseLine = (durationMillis: number) => historyRow({ id: "check_precision_conflict", durationMillis })
    await writeFile(path, `${preciseLine(4_503_599_627.370497)}\n${preciseLine(4_503_599_627.370498)}\n`)
    const preciseDigest = await Effect.runPromise(importHistory(path).pipe(Effect.provide(HistoryPlatformLive)))
    expect(preciseDigest).toEqual({ targets: [], incidents: [], malformedRows: 1, processedRows: 2 })
  } finally { await rm(directory, { recursive: true, force: true }) }

  let calls = 0
  const { server, baseUrl } = await startServer({
    listTargets: async () => [],
    listChecks: async () => [],
    getIncident: async () => { calls++; return undefined },
  } as never)
  try {
    expect((await fetch(`${baseUrl}/incidents/not-valid`)).status).toBe(400)
    expect(calls).toBe(0)
    const document = await (await fetch(`${baseUrl}/openapi.json`)).json() as any
    const operation = document.paths?.["/incidents/{id}"]?.get
    expect(operation?.parameters?.some((parameter: any) => parameter.name === "id" && parameter.in === "path")).toBe(true)
    expect(operation?.responses?.["200"]?.content?.["application/json"]?.schema).toBeTruthy()
    expect(operation?.responses?.["500"]?.content?.["application/json"]?.schema).toBeTruthy()
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }

  const failed = await startServer({
    listTargets: async () => { throw new Error("driver leaked") },
    listChecks: async () => [],
    getIncident: async () => undefined,
  } as never)
  try {
    const response = await fetch(`${failed.baseUrl}/targets`)
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ message: "failed to list targets" })
  } finally {
    await new Promise<void>((resolve, reject) => failed.server.close(error => error ? reject(error) : resolve()))
  }

  const observations: number[][] = []
  for (const failedTable of ["incidents", "incident_events", "delivery_outbox"] as const) {
    const repo = new SqliteCheckRepository()
    try {
      await execute(repo, `create trigger fail_${failedTable} before insert on ${failedTable} begin select raise(abort, 'forced'); end`)
      await expect(repo.applyCheck(check)).rejects.toBeTruthy()
      observations.push(await Promise.all(tables.map(table => countRows(repo, table))))
    } finally { await repo.close() }
  }
  expect(observations).toEqual([[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]])

  const closed = new SqliteCheckRepository()
  await closed.close()
  const infrastructure = await closed.listChecks().catch(error => error)
  expect(infrastructure).toBeInstanceOf(RepositoryError)
  expect(infrastructure.operation).toBe("listChecks")
  expect(infrastructure.cause).toBeTruthy()

  const runner = new SqliteCheckRepository()
  try {
    const expectedFailure = new RepositoryError({ operation: "test", cause: "expected" })
    await expect((runner as any).run("test", Effect.fail(expectedFailure))).rejects.toBe(expectedFailure)
    const sentinel = { defect: "driver invariant" }
    await expect((runner as any).run("test", Effect.die(sentinel))).rejects.toBe(sentinel)
  } finally { await runner.close() }

  const offsetRepo = new SqliteCheckRepository()
  try {
    const down = new CheckResult({ ...check, id: "check_offset_down", checkedAt: new Date("2025-12-31T23:00:00Z") })
    await offsetRepo.applyCheck(down)
    await execute(offsetRepo, "update checks set json=json_set(json,'$.checkedAt','2026-01-01T00:00:00+01:00') where id='check_offset_down'")
    const up = new CheckResult({ id: "check_offset_up", targetId: check.targetId, checkedAt: new Date("2025-12-31T23:30:00Z"), duration: check.duration, classification: new Up(), response: check.response })
    await expect(offsetRepo.applyCheck(up)).resolves.toBe("Closed")
    expect((await offsetRepo.listChecks()).map(value => value.id)).toEqual(["check_offset_down", "check_offset_up"])

    const older = new Incident({ id: "incident_offset_a", targetId: check.targetId, openedAt: new Date("2025-12-31T23:00:00Z"), status: "Open", reason: "older", latestCheckId: down.id })
    const newer = new Incident({ id: "incident_offset_b", targetId: check.targetId, openedAt: new Date("2025-12-31T23:30:00Z"), status: "Open", reason: "newer", latestCheckId: down.id })
    await offsetRepo.saveIncident(older)
    await offsetRepo.saveIncident(newer)
    await execute(offsetRepo, "update incidents set json=json_set(json,'$.openedAt','2026-01-01T00:00:00+01:00') where id='incident_offset_a'")
    expect((await offsetRepo.getOpenIncident(check.targetId))?.id).toBe(newer.id)
    const latestDown = new CheckResult({ ...down, id: "check_offset_latest", checkedAt: new Date("2026-01-01T00:00:00Z") })
    await expect(offsetRepo.applyCheck(latestDown)).resolves.toBe("Updated")
    expect((await offsetRepo.getIncident(newer.id))?.latestCheckId).toBe(latestDown.id)

    const tieTarget = targetId("target_offset_tie")
    await offsetRepo.saveIncident(new Incident({ id: "incident_tie_a", targetId: tieTarget, openedAt: new Date("2025-12-31T23:00:00Z"), status: "Open", reason: "a", latestCheckId: down.id }))
    await offsetRepo.saveIncident(new Incident({ id: "incident_tie_b", targetId: tieTarget, openedAt: new Date("2025-12-31T23:00:00Z"), status: "Open", reason: "b", latestCheckId: down.id }))
    await execute(offsetRepo, "update incidents set json=json_set(json,'$.openedAt','2026-01-01T00:00:00+01:00') where id='incident_tie_b'")
    expect((await offsetRepo.getOpenIncident(tieTarget))?.id).toBe("incident_tie_b")
  } finally { await offsetRepo.close() }

  const target = new Target({ id: targetId("target_repository"), name: "Repository", url: "https://example.test", method: "GET", expectedStatus: [200], interval: Duration.seconds(1), timeout: Duration.seconds(1), slowThreshold: Duration.seconds(1), enabled: true })
  const client = { probe: async () => ({ status: 200 }) }
  const status = new StatusState()
  const run = (cause: unknown) => runOnceEffect([target], { queueCapacity: 1, workerCount: 1 }, {
    client,
    repository: { applyCheckWithIncident: async () => { throw cause } } as any,
    status,
  })

  const expected = new RepositoryError({ operation: "applyCheckWithIncident", cause: new Error("closed") })
  const expectedExit = await Effect.runPromise(Effect.exit(run(expected)))
  expect(expectedExit._tag).toBe("Failure")
  if (expectedExit._tag === "Failure") {
    expect(Cause.hasFails(expectedExit.cause)).toBe(true)
    expect(Cause.hasDies(expectedExit.cause)).toBe(false)
    expect(expectedExit.cause.reasons.some((reason) => Cause.isFailReason(reason) && reason.error === expected)).toBe(true)
  }

  const unexpected = new Error("driver contract violated")
  const unexpectedExit = await Effect.runPromise(Effect.exit(run(unexpected)))
  expect(unexpectedExit._tag).toBe("Failure")
  if (unexpectedExit._tag === "Failure") {
    expect(Cause.hasFails(unexpectedExit.cause)).toBe(false)
    expect(Cause.hasDies(unexpectedExit.cause)).toBe(true)
    expect(unexpectedExit.cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect === unexpected)).toBe(true)
  }
})

it("serializes concurrent identical and conflicting check saves", async () => {
  const infinite = new SqliteCheckRepository()
  try {
    const infiniteCheck = new CheckResult({ ...check, id: "check_infinite", duration: Duration.infinity })
    await expect(infinite.applyCheck(infiniteCheck)).resolves.toBe("Opened")
    await expect(infinite.applyCheck(infiniteCheck)).resolves.toBe("Unchanged")
    expect((await infinite.listChecks()).every(value => value.duration === Duration.infinity)).toBe(true)

    const precise = new CheckResult({ ...check, id: "check_precise", duration: Duration.nanos(9_007_199_254_740_993n) })
    await infinite.saveCheck(precise)
    const preciseRead = (await infinite.listChecks()).find(value => value.id === precise.id)!
    expect(Equal.equals(preciseRead.duration, precise.duration)).toBe(true)
    const adjacent = new CheckResult({ ...precise, duration: Duration.nanos(9_007_199_254_740_992n) })
    await expect(infinite.saveCheck(adjacent)).rejects.toMatchObject({ operation: "saveCheck" })
  } finally { await infinite.close() }

  const identical = new SqliteCheckRepository()
  try {
    await Promise.all([identical.saveCheck(check), identical.saveCheck(check)])
    expect((await identical.listChecks()).map(value => value.id)).toEqual([check.id])
  } finally { await identical.close() }

  const conflicting = new SqliteCheckRepository()
  try {
    const up = upCheck()
    const results = await Promise.allSettled([conflicting.saveCheck(check), conflicting.saveCheck(up)])
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1)
    const saved = await conflicting.listChecks()
    expect(saved).toHaveLength(1)
    expect(["Down", "Up"]).toContain(saved[0]?.classification._tag)
  } finally { await conflicting.close() }
})

it("delivers only after commit and keeps related status counters atomic", async () => {
  let preCommitSends = 0
  const repo = new (SqliteCheckRepository as any)(":memory:", () => {
    preCommitSends++
  })
  try {
    await repo.applyCheck(check)
    expect(preCommitSends).toBe(0)
    const deliveryIds: number[] = []
    await expect(repo.deliverPending((id: number) => { deliveryIds.push(id); throw new Error("delivery interrupted") })).rejects.toBeTruthy()
    await repo.deliverPending((id: number) => { deliveryIds.push(id) })
    await repo.deliverPending((id: number) => { deliveryIds.push(id) })
    expect(deliveryIds).toHaveLength(2)
    expect(deliveryIds[1]).toBe(deliveryIds[0])
  } finally { await repo.close() }

  for (const method of ["applyCheck", "applyCheckWithIncident"] as const) {
    const conflicting = new SqliteCheckRepository()
    try {
      await conflicting[method](check)
      const error = await conflicting[method](upCheck()).catch(cause => cause)
      expect(error).toBeInstanceOf(RepositoryError)
      expect(error.operation).toBe("saveCheck")
      expect(String(error.cause)).toContain(check.id)
    } finally { await conflicting.close() }
  }

  const board: any = await makeBoard()
  await Promise.all(Array.from({ length: 16 }, () => runMaybe(board.openIncident(check.targetId, "api"))))
  const snapshot = await runMaybe(typeof board.snapshot === "function" ? board.snapshot() : board.snapshot)
  expect(snapshot.globalDegradedCount).toBe(1)
  expect(snapshot.tagDegradedCounts.get("api")).toBe(1)

  let external = 0
  await runMaybe(StatusBoard.retriedUpdate(board, check.targetId, "ops", () => { external++ }))
  expect(external).toBe(1)
  const transferred = await runMaybe(typeof board.snapshot === "function" ? board.snapshot() : board.snapshot)
  expect(transferred.globalDegradedCount).toBe(1)
  expect(transferred.tagDegradedCounts.get("api") ?? 0).toBe(0)
  expect(transferred.tagDegradedCounts.get("ops")).toBe(1)

  const interrupted: any = await makeBoard()
  if (typeof interrupted.openIncidentWhen === "function") {
    await Effect.runPromise(Effect.gen(function*() {
      const gate = yield* TxRef.make(false).pipe(Effect.tx)
      const transaction = interrupted.openIncidentWhen(check.targetId, "api", gate, Effect.void) as Effect.Effect<void, never, never>
      const update = yield* Effect.forkChild(transaction)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(update)
    }))
  } else {
    const controller = new AbortController()
    controller.abort(new Error("cancel before commit"))
    await runMaybe((StatusBoard as any).snapshotDuringAbort(interrupted, check.targetId, "api", controller.signal)).catch(() => undefined)
  }
  const afterInterrupt = await runMaybe(typeof interrupted.snapshot === "function" ? interrupted.snapshot() : interrupted.snapshot)
  expect(afterInterrupt.globalDegradedCount).toBe(0)
  expect([...afterInterrupt.tagDegradedCounts.values()].reduce((a: number, b: number) => a + b, 0)).toBe(0)
})
