import { expect, it } from "vitest"
import { Duration, Effect, Fiber } from "effect"
import { JobBuffer, runOnceEffect } from "../../src/watch/Scheduler.js"
import { CheckResult, ResponseMetadata, Target, Up, targetId } from "../../src/domain/schema.js"
import { FakeProbeClient } from "../../src/services/ProbeClient.js"
import { StatusState } from "../../src/watch/StatusState.js"

const check = (id: string, at: number) => new CheckResult({ id, targetId: targetId("target_state"), checkedAt: new Date(at), duration: "1 ms", classification: new Up(), response: new ResponseMetadata({}) })

it("keeps state atomic and gives the queue bounded role-safe shutdown", async () => {
  const state = new StatusState()
  await Promise.all([state.update(check("new", 2)), state.update(check("old", 1))])
  expect((await state.get(targetId("target_state")))?.latest.id).toBe("new")

  let resumed = false
  const buffer = new JobBuffer<number>(1)
  const effectBuffer = buffer as any
  await Effect.runPromise(Effect.gen(function*() {
    yield* effectBuffer.offerEffect(1)
    const blocked = yield* Effect.forkChild(effectBuffer.offerEffect(2).pipe(Effect.tap(() => Effect.sync(() => { resumed = true }))))
    yield* Effect.yieldNow
    expect(resumed).toBe(false)
    expect(yield* effectBuffer.takeEffect()).toBe(1)
    yield* Fiber.join(blocked)
  }) as any)
  expect("take" in effectBuffer.enqueue()).toBe(false)
  expect("offer" in effectBuffer.dequeue()).toBe(false)
  const draining = new JobBuffer<string>(2)
  await draining.offer("a")
  await draining.offer("b")
  draining.shutdown()
  expect([await draining.take(), await draining.take(), await draining.take()]).toEqual(["a", "b", undefined])
  expect(await draining.offer("late")).toBe(false)

  const targets = Array.from({ length: 3 }, (_, index) => new Target({ id: targetId(`target_worker_${index}`), name: `worker ${index}`, url: "https://example.test", method: "GET", expectedStatus: [200], interval: Duration.millis(10), timeout: Duration.millis(50), slowThreshold: Duration.millis(20), enabled: true }))
  const consumed: string[] = []
  await Effect.runPromise(runOnceEffect(targets, { queueCapacity: 1, workerCount: 2 }, {
    client: new FakeProbeClient({}),
    repository: { applyCheck: async (result: CheckResult) => { consumed.push(result.targetId) }, getOpenIncident: async () => undefined } as any,
    status: new StatusState()
  }))
  expect(consumed.sort()).toEqual(targets.map((target) => target.id).sort())
})
