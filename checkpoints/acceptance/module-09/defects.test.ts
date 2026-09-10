import { expect, it } from "vitest"
import { Effect } from "effect"
import { BulletinBus, callbackJobAdapter, JobBuffer, WorkerBroadcast } from "../../../src/watch/Scheduler.js"
import { Readiness } from "../../../src/watch/StatusState.js"

const tick = () => new Promise(r => setTimeout(r, 0))
it("DP-29", async () => { const buffer = new JobBuffer<number>(1), callback = callbackJobAdapter(buffer); expect(callback(1)).toBe(true); expect(callback(2)).toBe(false); expect(callback.dropped()).toBe(1) })
it("DP-32", async () => { const ready = new Readiness(), waiting = ready.wait(); ready.complete("ready"); expect(await Promise.race([waiting, tick().then(() => "polled")])).toBe("ready") })
it("DP-33", async () => { const ready = new Readiness(), waiting = ready.wait().then(() => "resolved", () => "rejected"); ready.fail(new Error("failed")); expect(await Promise.race([waiting, tick().then(() => "pending")])).toBe("rejected") })
it("DP-34", async () => { const ready = new Readiness(); await expect(ready.runGeneration("one")).resolves.toBe("one"); await expect(ready.runGeneration("two")).resolves.toBe("two") })
it("DP-35", async () => { const bus = new BulletinBus<number>(), a: number[] = [], b: number[] = []; await Effect.runPromise(Effect.scoped(Effect.gen(function*() { yield* Effect.forkScoped(bus.subscribe(x => a.push(x))); yield* Effect.forkScoped(bus.subscribe(x => b.push(x))); yield* Effect.yieldNow; yield* bus.publish(1); yield* Effect.sleep("1 millis") }))); expect([a, b]).toEqual([[1], [1]]) })
it("DP-36", async () => { const bus = new WorkerBroadcast<number>(), seen: number[] = []; await Effect.runPromise(Effect.scoped(Effect.gen(function*() { yield* Effect.forkScoped(bus.addWorker(x => seen.push(x))); yield* Effect.forkScoped(bus.addWorker(x => seen.push(x))); yield* Effect.yieldNow; yield* bus.offer(1); yield* Effect.sleep("1 millis") }))); expect(seen).toEqual([1]) })
it("DP-37", async () => { const bus = new BulletinBus<number>(); await Effect.runPromise(Effect.scoped(Effect.gen(function*() { yield* Effect.forkScoped(bus.subscribe(() => {})); yield* Effect.yieldNow; expect(bus.subscriberCount()).toBe(1) }))); expect(bus.subscriberCount()).toBe(0) })
