import { expect, it } from "vitest"
import { Effect } from "effect"
import { BulletinBus, callbackJobAdapter, JobBuffer, WorkerBroadcast } from "../../src/watch/Scheduler.js"
import { Readiness } from "../../src/watch/StatusState.js"

it("makes overflow, one-shot readiness, broadcast, and work distribution explicit", async () => {
  const callback: any = callbackJobAdapter(new JobBuffer<number>(1))
  expect(callback(1)).toBe(true)
  expect(callback(2)).toBe(false)
  expect(callback.dropped()).toBe(1)

  const ready = new Readiness()
  const first = ready.wait()
  ready.complete("one")
  expect(await first).toBe("one")
  ready.reset()
  const second = ready.wait()
  ready.fail(new Error("boot failed"))
  await expect(second).rejects.toThrow("boot failed")
  await expect(ready.runGeneration("two")).resolves.toBe("two")

  const retiredGeneration = (ready as any).reset()
  const retiredWaiter = (ready as any).wait(retiredGeneration).then(
    () => "completed",
    (error: unknown) => error instanceof Error ? error.message : String(error),
  )
  const activeGeneration = (ready as any).reset()
  expect((ready as any).complete("late", retiredGeneration)).toBe(false)
  const activeWaiter = (ready as any).wait(activeGeneration)
  expect((ready as any).complete("three", activeGeneration)).toBe(true)
  await expect(retiredWaiter).resolves.toContain("retired")
  await expect(activeWaiter).resolves.toBe("three")

  const bus: any = new BulletinBus<number>()
  const a: number[] = [], b: number[] = []
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    yield* Effect.forkScoped(bus.subscribe((value: number) => a.push(value)) as any)
    yield* Effect.forkScoped(bus.subscribe((value: number) => b.push(value)) as any)
    yield* Effect.yieldNow
    yield* (bus.publish(1) as any)
    while (a.length < 1 || b.length < 1) yield* Effect.yieldNow
  }) as any))
  expect([a, b]).toEqual([[1], [1]])
  expect(bus.subscriberCount()).toBe(0)

  const workers: any = new WorkerBroadcast<number>()
  const seen: number[] = []
  let consumed!: () => void
  const allConsumed = new Promise<void>(resolve => { consumed = resolve })
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const consume = (value: number) => { seen.push(value); if (seen.length === 3) consumed() }
    yield* Effect.forkScoped(workers.addWorker(consume) as any)
    yield* Effect.forkScoped(workers.addWorker(consume) as any)
    yield* Effect.yieldNow
    yield* Effect.all([workers.offer(1), workers.offer(2), workers.offer(3)] as any)
    yield* Effect.promise(() => allConsumed)
  }) as any))
  expect(seen.sort()).toEqual([1, 2, 3])
})
