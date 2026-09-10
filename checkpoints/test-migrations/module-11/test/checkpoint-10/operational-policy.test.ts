import { it } from "@effect/vitest"
import { Cause, Clock, Duration, Effect, Fiber, Pool, Random, Redacted, Ref } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"
import { DnsError } from "../../src/domain/errors.js"
import { Target, targetId } from "../../src/domain/schema.js"
import * as ProbeProgram from "../../src/probe/ProbeProgram.js"
import { ClientCache, MAX_CONNECTION_POOL_SIZE, pooledClients } from "../../src/repo/ConnectionPool.js"
import * as Config from "../../src/services/Config.js"
import { HttpProbeClient } from "../../src/services/HttpProbeClient.js"
import { runOnceEffect } from "../../src/watch/Scheduler.js"

const target = (id: string, overrides: Partial<ConstructorParameters<typeof Target>[0]> = {}) => new Target({ id: targetId(`target_${id}`), name: id, url: "https://example.test", method: "GET", expectedStatus: [200], interval: Duration.millis(10), timeout: Duration.millis(50), slowThreshold: Duration.millis(500), enabled: true, ...overrides })

it.effect("applies production retry, response, config, secret, and pool policy", () => Effect.gen(function*() {
  const program = ProbeProgram as any
  const config = Config as any
  expect(program.repeatSuccessfulProbeEffect, "express repetition as Effect policy").toBeDefined()
  expect(config.MAX_WORKER_CONCURRENCY, "publish the production worker bound").toBeTypeOf("number")
  yield* Effect.scoped(Effect.gen(function*() {
    const clock = yield* Clock.Clock
    const attempts: number[] = []
    const client = { probe: (_target: Target, signal?: AbortSignal) => {
      attempts.push(clock.currentTimeMillisUnsafe())
      if (attempts.length === 1) return new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }))
      if (attempts.length < 4) return Promise.reject(new DnsError({ host: "example.test" }))
      return Promise.resolve({ status: 200 })
    } }
    const fiber = yield* program.probeOnce(target("clock"), client).pipe(Random.withSeed("probe-policy"), Effect.forkScoped)
    yield* TestClock.adjust("1 second")
    expect(((yield* Fiber.join(fiber)) as any).classification._tag).toBe("Up")
    expect(attempts).toHaveLength(4)
    const gaps = attempts.slice(1).map((time, index) => time - attempts[index]!)
    expect(gaps[0]).toBeGreaterThanOrEqual(58); expect(gaps[0]).toBeLessThanOrEqual(62)
    expect(gaps[1]).toBeGreaterThanOrEqual(16); expect(gaps[1]).toBeLessThanOrEqual(24)
    expect(gaps[2]).toBeGreaterThanOrEqual(32); expect(gaps[2]).toBeLessThanOrEqual(48)
    let synchronousAttempts = 0
    const synchronousClient = new HttpProbeClient()
    synchronousClient.probe = () => {
      synchronousAttempts++
      if (synchronousAttempts === 1) throw new DnsError({ host: "example.test" })
      return Promise.resolve({ status: 200 })
    }
    const synchronous = yield* program.probeOnce(target("synchronous"), synchronousClient).pipe(Random.withSeed("synchronous-probe"), Effect.forkScoped)
    yield* TestClock.adjust("1 second")
    expect(((yield* Fiber.join(synchronous)) as any).classification._tag).toBe("Up")
    expect(synchronousAttempts).toBe(2)
    const repeats = yield* Ref.make(0)
    yield* program.repeatSuccessfulProbeEffect(Ref.update(repeats, n => n + 1), 3)
    expect(yield* Ref.get(repeats).pipe(Effect.orDie)).toBe(4)
  }) as any)

  let bodyRead = false
  const body = Object.defineProperty({}, "ok", { enumerable: true, get: () => { bodyRead = true; return false } })
  const schema = JSON.stringify({ type: "object", required: ["ok"], properties: { ok: { const: true } } })
  const run = (id: string, overrides: Partial<ConstructorParameters<typeof Target>[0]>, response: object): Effect.Effect<any, any> => program.probeOnce(target(id, overrides), { probe: async () => response })
  const head = yield* run("head", { method: "HEAD", healthBodySchema: "not a schema" }, { status: 200, bytes: 99, body })
  expect([head.classification._tag, head.response.bytes, bodyRead]).toEqual(["Up", 0, false])
  const unexpected = yield* run("unexpected", { healthBodySchema: schema }, { status: 503, body })
  expect([unexpected.classification._tag, unexpected.failure?.reason, bodyRead]).toEqual(["Down", "UnexpectedStatus", false])
  const invalidStatus = yield* run("invalid", {}, { status: 600 })
  expect([invalidStatus.failure?.reason, invalidStatus.response.status]).toEqual(["UnexpectedStatus", undefined])
  expect((yield* run("string", {}, { status: 200, body: "not-json" })).classification._tag).toBe("Up")
  expect((yield* run("async", { healthBodySchema: JSON.stringify({ $async: true, type: "object" }) }, { status: 200, body: {} })).classification._tag).toBe("InvalidResponse")
  yield* Effect.gen(function*() {
    const baseClock = yield* Clock.Clock
    let validated = false
    const timedBody = Object.defineProperty({}, "ok", { enumerable: true, get: () => { validated = true; return true } })
    const clock: Clock.Clock = { ...baseClock, currentTimeMillisUnsafe: () => validated ? 25 : 10, currentTimeMillis: Effect.sync(() => validated ? 25 : 10) }
    const timed: any = yield* program.probeOnce(target("timed", { healthBodySchema: JSON.stringify({ type: "object", required: ["ok"] }) }), { probe: async () => ({ status: 200, body: timedBody }) }).pipe(Effect.provideService(Clock.Clock, clock))
    expect([timed.checkedAt.getTime(), Duration.toMillis(timed.duration)]).toEqual([25, 15])
  }) as any

  const cfg = config.appConfig({ pollInterval: 1, probeTimeout: 1, workerConcurrency: 2, slowThreshold: 1, realLlmToken: "swordfish" })
  expect(Redacted.value(cfg.realLlmToken!)).toBe("swordfish")
  expect(JSON.stringify(cfg)).not.toContain("swordfish")
  expect(() => config.appConfig({ pollInterval: 1, probeTimeout: 1, workerConcurrency: config.MAX_WORKER_CONCURRENCY + 1, slowThreshold: 1 })).toThrow()
  expect(config.appConfig({ pollInterval: "1 second", probeTimeout: "1 second", workerConcurrency: 1, slowThreshold: "1 second" }).pollInterval).toBe(1000)
  const validConfig = { pollInterval: "1 second", probeTimeout: "2 seconds", workerConcurrency: 2, slowThreshold: "3 seconds" }
  const loadConfig = (input: Record<string, unknown>) => config.configFromProvider.pipe(Effect.provide(config.testConfigLayer(input)))
  const expectConfigFailure = (exit: any) => {
    expect(exit._tag).toBe("Failure")
    expect(Cause.hasFails(exit.cause)).toBe(true)
    expect(Cause.hasDies(exit.cause)).toBe(false)
    expect(exit.cause.reasons.some((reason: any) => Cause.isFailReason(reason) && (reason.error as any)?._tag === "ConfigError")).toBe(true)
  }
  const provided = yield* loadConfig({ ...validConfig, telemetryEnabled: false, maxIncidents: 0, realLlmToken: "provider-secret" })
  expect([provided.pollInterval, provided.probeTimeout, provided.workerConcurrency, provided.slowThreshold, provided.telemetryEnabled, provided.maxIncidents]).toEqual([1000, 2000, 2, 3000, false, 0])
  expect(Redacted.value(provided.realLlmToken!)).toBe("provider-secret")
  expect(JSON.stringify(provided)).not.toContain("provider-secret")
  const defaults = yield* loadConfig(validConfig)
  expect([defaults.telemetryEnabled, defaults.maxIncidents, defaults.realLlmToken]).toEqual([true, 100, undefined])
  expectConfigFailure(yield* Effect.exit(loadConfig({ workerConcurrency: 2 })))
  for (const pollInterval of ["garbage", 0, -1]) {
    expectConfigFailure(yield* Effect.exit(loadConfig({ ...validConfig, pollInterval })))
  }
  for (const workerConcurrency of [0, config.MAX_WORKER_CONCURRENCY + 1]) {
    expectConfigFailure(yield* Effect.exit(loadConfig({ ...validConfig, workerConcurrency })))
  }
  for (const maxIncidents of [-1, 1.5]) {
    expectConfigFailure(yield* Effect.exit(loadConfig({ ...validConfig, maxIncidents })))
  }

  let persisted = 0
  const programmerBug = Object.assign(new Error("programmer bug"), { _tag: "ProgrammerBug" })
  for (const probe of [() => { throw programmerBug }, () => Promise.reject(programmerBug)]) {
    const client = new HttpProbeClient()
    client.probe = probe as any
    const unexpectedExit = yield* Effect.exit(runOnceEffect([target("unexpected-failure")], { queueCapacity: 1, workerCount: 1 }, {
      client,
      repository: { applyCheck: async () => { persisted++; return "Opened" as const }, getOpenIncident: async () => undefined } as any,
      status: { update: async () => {} } as any,
    }))
    expect(unexpectedExit._tag).toBe("Failure")
    if (unexpectedExit._tag === "Failure") {
      expect(Cause.hasDies(unexpectedExit.cause)).toBe(true)
      expect(Cause.hasFails(unexpectedExit.cause)).toBe(false)
      expect(unexpectedExit.cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect === programmerBug)).toBe(true)
    }
  }
  expect(persisted).toBe(0)

  const invalidPoolEvents: string[] = []
  const invalidPool = pooledClients(MAX_CONNECTION_POOL_SIZE + 1, invalidPoolEvents)
  expect(invalidPoolEvents).toEqual([])
  const invalidPoolExit = yield* Effect.exit(Effect.scoped(invalidPool))
  expectConfigFailure(invalidPoolExit)
  expect(invalidPoolEvents).toEqual([])

  const events: string[] = []
  yield* Effect.scoped(Effect.gen(function*() {
    const pool = yield* pooledClients(2, events)
    yield* Effect.all([Pool.get(pool), Pool.get(pool)], { concurrency: 2 })
  }))
  expect(events.filter(x => x.startsWith("close:"))).toHaveLength(2)
  const cache = new ClientCache()
  const poisoned = cache.checkout()
  cache.invalidate(poisoned)
  expect(cache.checkout().id).not.toBe(poisoned.id)
}) as any)
