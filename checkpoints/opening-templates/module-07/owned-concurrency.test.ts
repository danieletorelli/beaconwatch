import { expect, it } from "vitest"
import { Effect, Exit, Fiber, Scope } from "effect"
import { StatusState } from "../../src/watch/StatusState.js"
import { Target, targetId, type CheckResult } from "../../src/domain/schema.js"
import { FakeProbeClient } from "../../src/services/ProbeClient.js"

it("bounds child work and owns interruption through parent and scope", async () => {
  const scheduler = await import("../../src/watch/" + "Scheduler.js") as any
  expect(scheduler.runOnceEffect, "own one-shot children in an Effect scope").toBeDefined()
  expect(scheduler.watchLoopEffect, "own watch-loop children in an Effect scope").toBeDefined()
  const targets = Array.from({ length: 6 }, (_, i) => new Target({ id: targetId(`target_${i}`), name: `${i}`, url: "https://example.test", method: "GET", expectedStatus: [200], interval: 10, timeout: 50, slowThreshold: 20, enabled: true }))
  let active = 0, peak = 0
  const client = new FakeProbeClient({})
  client.probe = async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 2)); active--; return { status: 200, body: {}, bytes: 1 } }
  const services = (probeClient: FakeProbeClient, applyCheck: (check: CheckResult) => Promise<void> = async () => {}) => ({ client: probeClient, repository: { applyCheck, getOpenIncident: async () => undefined } as any, status: new StatusState() })
  await Effect.runPromise(scheduler.runOnceEffect(targets, { queueCapacity: 2, workerCount: 2 }, services(client)))
  expect(peak).toBe(2)

  const events: string[] = []
  const blocked = new FakeProbeClient({})
  let markStarted!: () => void
  const started = new Promise<void>(resolve => { markStarted = resolve })
  let markCleanupStarted!: () => void
  const cleanupStarted = new Promise<void>(resolve => { markCleanupStarted = resolve })
  let releaseCleanup!: () => void
  const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve })
  blocked.probe = (_target, signal) => new Promise((_, reject) => {
    markStarted()
    signal!.addEventListener("abort", async () => {
      events.push("child-interrupted")
      markCleanupStarted()
      await cleanupGate
      events.push("child-finalized")
      reject(signal!.reason)
    }, { once: true })
  })
  const parentRun = Effect.runPromise(Effect.gen(function*() {
    const parent = yield* Effect.forkChild(scheduler.runOnceEffect(targets.slice(0, 1), { queueCapacity: 1, workerCount: 1 }, services(blocked)).pipe(Effect.ensuring(Effect.sync(() => events.push("parent-finalized")))))
    yield* Effect.promise(() => started)
    yield* Fiber.interrupt(parent)
  }) as any)
  let parentSettled = false
  void parentRun.then(() => { parentSettled = true }, () => { parentSettled = true })
  await cleanupStarted
  await Promise.resolve()
  expect(parentSettled).toBe(false)
  releaseCleanup()
  await parentRun
  expect(events).toEqual(["child-interrupted", "child-finalized", "parent-finalized"])

  const scoped: string[] = []
  blocked.probe = (_target, signal) => new Promise((_, reject) => signal!.addEventListener("abort", () => { scoped.push("worker-finalized"); reject(signal!.reason) }, { once: true }))
  await Effect.runPromise(Effect.gen(function*() {
    const scope = yield* Scope.make()
    yield* Effect.forkIn(scheduler.watchLoopEffect(targets.slice(0, 1), { queueCapacity: 1, workerCount: 1 }, services(blocked)), scope)
    yield* Effect.sleep("5 millis")
    yield* Scope.close(scope, Exit.void)
    scoped.push("scope-closed")
  }) as any)
  expect(scoped).toEqual(["worker-finalized", "scope-closed"])

  const siblings: string[] = []
  let releaseFirst!: () => void
  const secondStarted = new Promise<void>(resolve => { releaseFirst = resolve })
  const raced = new FakeProbeClient({})
  raced.probe = (target, signal) => target.id === targets[0]!.id
    ? secondStarted.then(() => ({ status: 200, body: {}, bytes: 1 }))
    : new Promise((_, reject) => {
      releaseFirst()
      signal!.addEventListener("abort", () => { siblings.push("loser-finalized"); reject(signal!.reason) }, { once: true })
    })
  await expect(Effect.runPromise(scheduler.runOnceEffect(targets.slice(0, 2), { queueCapacity: 2, workerCount: 2 }, services(raced, async check => {
    siblings.push(`write:${check.targetId}`)
    throw new Error("sibling failed")
  })))).rejects.toBeTruthy()
  expect(siblings.filter(event => event.startsWith("write:"))).toHaveLength(1)
  expect(siblings).toContain("loser-finalized")
})
