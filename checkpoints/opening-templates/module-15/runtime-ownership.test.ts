import { expect, it } from "vitest"
import { it as effectIt } from "@effect/vitest"
import { Cause, Duration, Effect, Fiber, Random } from "effect"
import { TestClock } from "effect/testing"
import { ConfigError } from "../../src/domain/errors.js"
import { Target, targetId } from "../../src/domain/schema.js"
import { probeOnce } from "../../src/probe/ProbeProgram.js"
import { ManagedAppRuntime, RequestRuntimeHost, runRequestChild } from "../../src/runtime/ManagedRuntime.js"
import { HttpProbeClient } from "../../src/services/HttpProbeClient.js"
import { FakeProbeClient, malformedBody, recoverAfter, slow, transportError, valid } from "../../src/services/ProbeClient.js"
import * as Scheduler from "../../src/watch/Scheduler.js"

const target = new Target({ id: targetId("target_retry"), name: "Retry", url: "https://example.test", method: "GET", expectedStatus: [200], interval: Duration.millis(10), timeout: Duration.seconds(1), slowThreshold: Duration.millis(500), enabled: true })

it("shares and disposes runtimes, propagates cancellation, and bounds allocation", async () => {
  const { MAX_QUEUE_CAPACITY, MAX_WORKER_COUNT, runOnceEffect, watchLoopEffect } = Scheduler as any
  expect(MAX_QUEUE_CAPACITY, "publish a hard queue allocation bound").toBeTypeOf("number")
  expect(MAX_WORKER_COUNT, "publish a hard worker allocation bound").toBeTypeOf("number")
  const beforeAcquired = ManagedAppRuntime.acquired, beforeReleased = ManagedAppRuntime.released
  const host = new RequestRuntimeHost()
  await Promise.all([host.handle(async () => 1), host.handle(async () => 2)])
  await host.shutdown()
  expect(ManagedAppRuntime.acquired - beforeAcquired).toBeLessThanOrEqual(1)
  expect(ManagedAppRuntime.released - beforeReleased).toBe(1)

  const app = new ManagedAppRuntime()
  const controller = new AbortController()
  const events: string[] = []
  const client = new FakeProbeClient({ target_api: slow(30) })
  let markStarted!: () => void
  const started = new Promise<void>(resolve => { markStarted = resolve })
  let markAborted!: () => void
  const aborted = new Promise<void>(resolve => { markAborted = resolve })
  let releaseCleanup!: () => void
  const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve })
  const original = client.probe.bind(client)
  client.probe = async (target, signal) => {
    signal?.addEventListener("abort", () => { events.push("adapter-abort"); markAborted() }, { once: true })
    markStarted()
    try { const value = await original(target, signal); events.push("late-completion"); return value }
    finally { await cleanupGate; events.push("adapter-finalized") }
  }
  const request = runRequestChild(app, (_services, signal) => client.probe({ id: "target_api", url: "https://example.test" } as never, signal), controller.signal)
  let settled = false
  void request.then(() => { settled = true }, () => { settled = true })
  await started
  controller.abort(new Error("stop"))
  await aborted
  expect(settled).toBe(false)
  const beforeDispose = ManagedAppRuntime.released
  let firstDisposeSettled = false, secondDisposeSettled = false
  const firstDispose = app.dispose().then(() => { firstDisposeSettled = true })
  const secondDispose = app.dispose().then(() => { secondDisposeSettled = true })
  await Promise.resolve()
  expect([firstDisposeSettled, secondDisposeSettled]).toEqual([false, false])
  releaseCleanup()
  await expect(request).rejects.toBeTruthy()
  expect(events).toContain("adapter-abort")
  expect(events).toContain("adapter-finalized")
  expect(events).not.toContain("late-completion")
  await Promise.all([firstDispose, secondDispose])
  expect(ManagedAppRuntime.released).toBe(beforeDispose + 1)

  let probes = 0
  const services = {
    client: { probe: async () => { probes++; return valid() } },
    repository: {} as never,
    status: {} as never,
  }
  const invalidPrograms = [
    runOnceEffect([target], { queueCapacity: MAX_QUEUE_CAPACITY + 1, workerCount: 1 }, services),
    watchLoopEffect([target], { queueCapacity: 1, workerCount: MAX_WORKER_COUNT + 1 }, services),
  ]
  expect(probes, "constructing scheduler Effects is lazy").toBe(0)
  for (const program of invalidPrograms) {
    const exit = await Effect.runPromise(Effect.exit(program))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(Cause.hasFails(exit.cause)).toBe(true)
      expect(Cause.hasDies(exit.cause)).toBe(false)
      expect(exit.cause.reasons.some((reason) => Cause.isFailReason(reason) && reason.error instanceof ConfigError)).toBe(true)
    }
  }
  expect(probes, "invalid configuration fails before work starts").toBe(0)
  await expect(Effect.runPromise(runOnceEffect([], { queueCapacity: MAX_QUEUE_CAPACITY, workerCount: MAX_WORKER_COUNT }, services))).resolves.toBeUndefined()

  expect(() => new FakeProbeClient({ empty: [] })).toThrow("empty fake script")
  expect(() => new FakeProbeClient({ invalid: recoverAfter(-1) })).toThrow("invalid recover-after count")
  const expectedMalformed = malformedBody()
  const malformed = new FakeProbeClient({ target_api: expectedMalformed })
  await expect(Effect.runPromise(malformed.probeEffect!({ id: "target_api", url: "https://example.test" } as never))).rejects.toBe(expectedMalformed)
})

effectIt.effect("runs lazy retry-aware scripts on the application clock", () => Effect.scoped(Effect.gen(function*() {
  const client = new FakeProbeClient({ target_clock: slow(60_000) })
  const fiber = yield* client.probeEffect!({ id: "target_clock", url: "https://example.test" } as never).pipe(Effect.forkScoped)
  yield* TestClock.adjust("1 minute")
  expect((yield* Fiber.join(fiber)).status).toBe(200)

  const sequence = new FakeProbeClient({ target_retry: [transportError(), valid(201)] })
  const first = sequence.probeEffect!(target)
  const second = sequence.probeEffect!(target)
  expect(yield* Effect.isFailure(first)).toBe(true)
  expect((yield* second).status).toBe(201)

  const recovering = new FakeProbeClient({ target_retry: recoverAfter(1) })
  const retryFiber = yield* probeOnce(target, recovering).pipe(Random.withSeed("fake-retry"), Effect.forkScoped)
  yield* TestClock.adjust("1 second")
  expect((yield* Fiber.join(retryFiber)).classification._tag).toBe("Up")
})))

it("honors explicit Promise probe overrides on instances and subclasses", async () => {
  const instance = new FakeProbeClient({ target_retry: transportError() })
  instance.probe = async () => valid(202)
  expect((await Effect.runPromise(probeOnce(target, instance))).response.status).toBe(202)

  class PromiseProbeClient extends FakeProbeClient {
    override async probe() { return valid(203) }
  }
  const subclass = new PromiseProbeClient({ target_retry: transportError() })
  expect((await Effect.runPromise(probeOnce(target, subclass))).response.status).toBe(203)
})

effectIt.effect("awaits timed-out Promise cleanup before retrying", () => Effect.scoped(Effect.gen(function*() {
  const timeoutTarget = new Target({ id: targetId("target_cleanup"), name: "Cleanup", url: "https://example.test", method: "GET", expectedStatus: [200], interval: Duration.millis(10), timeout: Duration.millis(5), slowThreshold: Duration.millis(500), enabled: true })
  const cleanupClient = new HttpProbeClient()
  let calls = 0
  let markCleanupStarted!: () => void
  const cleanupStarted = new Promise<void>(resolve => { markCleanupStarted = resolve })
  let releaseCleanup!: () => void
  const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve })
  cleanupClient.probe = (_target, signal) => {
    calls++
    if (calls > 1) return Promise.resolve(valid())
    return new Promise((_resolve, reject) => signal!.addEventListener("abort", async () => {
      markCleanupStarted()
      await cleanupGate
      reject(signal!.reason)
    }, { once: true }))
  }
  const checked = yield* probeOnce(timeoutTarget, cleanupClient).pipe(Random.withSeed("cleanup-retry"), Effect.forkScoped)
  yield* TestClock.adjust("1 second")
  yield* Effect.promise(() => cleanupStarted)
  yield* TestClock.adjust("1 second")
  expect(calls, "do not retry before timed-out adapter cleanup settles").toBe(1)
  releaseCleanup()
  yield* Effect.promise(() => Promise.resolve())
  yield* TestClock.adjust("1 second")
  expect((yield* Fiber.join(checked)).response.status).toBe(200)
  expect(calls).toBe(2)
})))
