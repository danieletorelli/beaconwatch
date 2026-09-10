import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Cause, Deferred, Duration, Effect, Fiber, Pool, Redacted, Ref } from "effect"
import { TestClock } from "effect/testing"
import { DnsError, UnexpectedStatus } from "../../../src/domain/errors.js"
import * as Domain from "../../../src/domain/schema.js"
import { targetId } from "../../../src/domain/schema.js"
import * as ProbeProgram from "../../../src/probe/ProbeProgram.js"
import * as ConnectionPoolModule from "../../../src/repo/ConnectionPool.js"
import * as Config from "../../../src/services/Config.js"
import { HttpProbeClient } from "../../../src/services/HttpProbeClient.js"
import { runOnceEffect } from "../../../src/watch/Scheduler.js"

const duration = (millis: number): any => "DurationFromInput" in Domain ? Duration.millis(millis) : millis
const target: any = { id: targetId("target_dp"), url: "https://example.test", enabled: true, timeout: duration(1000), expectedStatus: [200], slowThreshold: duration(5000) }
const { probeOnce } = ProbeProgram
const { ClientCache } = ConnectionPoolModule
describe("module 10 owner defects", () => {
  it.effect("DP-38", () => Effect.scoped(Effect.gen(function*() { let n = 0; const client = new HttpProbeClient(); client.probe = async () => { if (++n < 2) throw new DnsError({ host: "example.test" }); return { status: 200 } }; const candidate = probeOnce(target, client as any); expect(Effect.isEffect(candidate)).toBe(true); const f = yield* Effect.forkScoped(candidate as any); yield* Effect.yieldNow; yield* TestClock.adjust("1 second"); const result = yield* Fiber.join(f); expect([n, result.classification._tag]).toEqual([2, "Up"]) })))
  it("DP-39", async () => {
    let calls = 0
    const client: any = { probe: async () => { calls++; throw new UnexpectedStatus({ expected: [200], actual: 500 }) } }
    await Effect.runPromise(probeOnce(target, client)); expect(calls).toBe(1)
    const run = (overrides: any, response: any) => Effect.runPromise(probeOnce({ ...target, method: "GET", ...overrides }, { probe: async () => response } as any))
    const head = await run({ method: "HEAD", healthBodySchema: "invalid" }, { status: 200, bytes: 10, body: "not-json" })
    expect(head.classification._tag).toBe("Up"); expect(head.response.bytes).toBe(0)
    const invalidStatus = await run({}, { status: 600 }); expect(invalidStatus.failure?.reason).toBe("UnexpectedStatus"); expect(invalidStatus.response.status).toBeUndefined()
    const jsonString = await run({}, { status: 200, body: "not-json" }); expect(jsonString.classification._tag).toBe("Up")
    const precedence = await run({ healthBodySchema: "false" }, { status: 503, body: {} }); expect(precedence.failure?.reason).toBe("UnexpectedStatus")
    const unsupported = await run({ healthBodySchema: JSON.stringify({ $async: true, type: "object" }) }, { status: 200, body: {} }); expect(unsupported.classification._tag).toBe("InvalidResponse")
  })
  it("DP-40", async () => { let n = 0; await ProbeProgram.repeatSuccessfulProbe(async () => ++n, 2); expect(n).toBe(3) })
  it.effect("DP-41", () => Effect.scoped(Effect.gen(function*() { let resolve!: (value: { status: number }) => void; const client: any = { probe: () => new Promise(done => { resolve = done }) }; const fiber = yield* probeOnce(target, client).pipe(Effect.forkScoped); yield* Effect.yieldNow; yield* TestClock.adjust("137 millis"); yield* Effect.sync(() => resolve({ status: 200 })); const check = yield* Fiber.join(fiber); expect(check.checkedAt).toEqual(new Date(137)); expect(Duration.isDuration(check.duration) ? Duration.toMillis(check.duration) : check.duration).toBe(137) })))
  it.effect("DP-42", () => Effect.gen(function*() {
    const validInput = { pollInterval: "1 second", probeTimeout: "2 seconds", workerConcurrency: 2, slowThreshold: "3 seconds" }
    const load = (input: Record<string, unknown>) => Config.configFromProvider.pipe(Effect.provide(Config.testConfigLayer(input)))
    const expectConfigFailure = (exit: any) => {
      expect(exit._tag).toBe("Failure"); expect(Cause.hasFails(exit.cause)).toBe(true); expect(Cause.hasDies(exit.cause)).toBe(false)
      expect(exit.cause.reasons.some((reason: any) => Cause.isFailReason(reason) && (reason.error as any)?._tag === "ConfigError")).toBe(true)
    }
    const valid = yield* load({ ...validInput, telemetryEnabled: false, maxIncidents: 0 })
    expect([valid.pollInterval, valid.probeTimeout, valid.workerConcurrency, valid.slowThreshold, valid.telemetryEnabled, valid.maxIncidents]).toEqual([1000, 2000, 2, 3000, false, 0])
    expectConfigFailure(yield* Effect.exit(load({ workerConcurrency: 2 })))
    for (const pollInterval of ["garbage", 0, -1]) expectConfigFailure(yield* Effect.exit(load({ ...validInput, pollInterval })))
    for (const workerConcurrency of [0, Config.MAX_WORKER_CONCURRENCY + 1]) {
      expectConfigFailure(yield* Effect.exit(load({ ...validInput, workerConcurrency })))
    }
    for (const maxIncidents of [-1, 1.5]) expectConfigFailure(yield* Effect.exit(load({ ...validInput, maxIncidents })))
  }))
  it("DP-43", () => { const c = Config.appConfig({ pollInterval: 1, probeTimeout: 1, workerConcurrency: 1, slowThreshold: 1, realLlmToken: "secret-dp" }); expect(JSON.stringify(c)).not.toContain("secret-dp"); expect(Redacted.value(c.realLlmToken!)).toBe("secret-dp") })
  it.effect("DP-49", () => Effect.gen(function*() { const validInput = { pollInterval: "1 second", probeTimeout: "2 seconds", workerConcurrency: 2, slowThreshold: "3 seconds" }; const load = (input: Record<string, unknown>) => Config.configFromProvider.pipe(Effect.provide(Config.testConfigLayer(input))); const explicit = yield* load({ ...validInput, telemetryEnabled: false, maxIncidents: 0 }); const defaults = yield* load(validInput); expect([explicit.telemetryEnabled, explicit.maxIncidents]).toEqual([false, 0]); expect([defaults.telemetryEnabled, defaults.maxIncidents, defaults.realLlmToken]).toEqual([true, 100, undefined]) }))
  it.effect("does not turn unexpected adapter defects into persisted outages", () => Effect.gen(function*() {
    let persisted = 0
    const programmerBug = Object.assign(new Error("programmer bug"), { _tag: "ProgrammerBug" })
    for (const probe of [() => { throw programmerBug }, () => Promise.reject(programmerBug)]) {
      const client = new HttpProbeClient()
      client.probe = probe as any
      const exit = yield* Effect.exit(runOnceEffect([target], { queueCapacity: 1, workerCount: 1 }, {
        client,
        repository: { applyCheck: async () => { persisted++; return "Opened" as const }, getOpenIncident: async () => undefined } as any,
        status: { update: async () => {} } as any,
      }))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        expect(Cause.hasDies(exit.cause)).toBe(true); expect(Cause.hasFails(exit.cause)).toBe(false)
        expect(exit.cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect === programmerBug)).toBe(true)
      }
    }
    expect(persisted).toBe(0)
  }))
  it.effect("rejects oversized pools lazily without acquisition", () => Effect.gen(function*() {
    const events: string[] = []
    const candidate = ConnectionPoolModule.pooledClients(ConnectionPoolModule.MAX_CONNECTION_POOL_SIZE + 1, events)
    expect(events).toEqual([])
    const exit = yield* Effect.exit(Effect.scoped(candidate))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(Cause.hasFails(exit.cause)).toBe(true); expect(Cause.hasDies(exit.cause)).toBe(false)
      expect(exit.cause.reasons.some((reason) => Cause.isFailReason(reason) && (reason.error as any)?._tag === "ConfigError")).toBe(true)
    }
    expect(events).toEqual([])
  }))
  it("DP-45", async () => { const events: string[] = []; await Effect.runPromise(Effect.scoped(Effect.gen(function*() { const pool = yield* ConnectionPoolModule.pooledClients(2, events); const gate = yield* Deferred.make<void>(); const bothStarted = yield* Deferred.make<void>(); const started = yield* Ref.make(0); const hold = Effect.scoped(Pool.get(pool).pipe(Effect.tap(() => Ref.updateAndGet(started, n => n + 1).pipe(Effect.flatMap(n => n === 2 ? Deferred.succeed(bothStarted, undefined) : Effect.void))), Effect.andThen(Deferred.await(gate)))); const first = yield* Effect.forkChild(hold); const second = yield* Effect.forkChild(hold); yield* Deferred.await(bothStarted); const attempted = yield* Deferred.make<void>(); const acquired = yield* Ref.make(false); const third = yield* Effect.forkChild(Effect.scoped(Deferred.succeed(attempted, undefined).pipe(Effect.andThen(Pool.get(pool)), Effect.tap(() => Ref.set(acquired, true))))); yield* Deferred.await(attempted); yield* Effect.yieldNow; expect(yield* Ref.get(acquired)).toBe(false); yield* Deferred.succeed(gate, undefined); yield* Fiber.join(first); yield* Fiber.join(second); yield* Fiber.join(third); yield* Effect.scoped(Pool.get(pool).pipe(Effect.andThen(Effect.fail("use failed")))).pipe(Effect.catch(() => Effect.void)); const interrupted = yield* Effect.forkChild(Effect.scoped(Pool.get(pool).pipe(Effect.andThen(Effect.never)))); yield* Effect.yieldNow; yield* Fiber.interrupt(interrupted); yield* Effect.scoped(Pool.get(pool)) }))); expect(events.filter(x => x.startsWith("open:")).sort()).toEqual(["open:0", "open:1"]); expect(events.filter(x => x.startsWith("close:")).sort()).toEqual(["close:0", "close:1"]) })
  it("DP-46", () => { const c = new ClientCache(); const poisoned = c.checkout(); c.invalidate(poisoned); expect(c.checkout().id).not.toBe(poisoned.id) })
})
