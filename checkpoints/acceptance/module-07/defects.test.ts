import { expect, it } from "vitest"
import { Duration, Effect, Exit, Fiber, Scope } from "effect"
import * as Domain from "../../../src/domain/schema.js"
import { Target } from "../../../src/domain/schema.js"
import { probeOnce } from "../../../src/probe/ProbeProgram.js"
import { runOnceEffect, watchLoopEffect } from "../../../src/watch/Scheduler.js"
import { StatusState } from "../../../src/watch/StatusState.js"

const duration = (millis: number): any => "DurationFromInput" in Domain ? Duration.millis(millis) : millis
const target = (id: string) => new Target({ id: `target_${id}` as any, name: id, url: "https://example.test", method: "GET", expectedStatus: [200], interval: duration(5), timeout: duration(100), slowThreshold: duration(20), enabled: true })
const services = (probe: any, applyCheck: any = async () => {}) => ({ client: { probe }, repository: {
  applyCheck,
  applyCheckWithIncident: async (check: any) => ({ transition: await applyCheck(check), openIncident: undefined }),
  getOpenIncident: async () => undefined
}, status: new StatusState() } as any)
it("DP-22", async () => { const events: string[] = []; await Effect.runPromise(Effect.gen(function*() { const parent = yield* Effect.forkChild(watchLoopEffect([target("owner")], { queueCapacity: 1, workerCount: 1 }, services((_t: any, signal: AbortSignal) => new Promise((_r, reject) => signal.addEventListener("abort", () => { events.push("child-interrupted", "child-finalized"); reject(signal.reason) }, { once: true })))).pipe(Effect.ensuring(Effect.sync(() => events.push("parent-finalized"))))); yield* Effect.sleep("5 millis"); yield* Fiber.interrupt(parent) })); expect(events).toEqual(["child-interrupted", "child-finalized", "parent-finalized"]) })
it("DP-23", async () => { const events: string[] = []; await Effect.runPromise(Effect.gen(function*() { const scope = yield* Scope.make(); yield* Effect.forkIn(watchLoopEffect([target("scope")], { queueCapacity: 1, workerCount: 1 }, services((_t: any, signal: AbortSignal) => new Promise((_r, reject) => signal.addEventListener("abort", () => { events.push("worker-finalized"); reject(signal.reason) }, { once: true })))), scope); yield* Effect.sleep("20 millis"); yield* Scope.close(scope, Exit.void); events.push("scope-closed") })); expect(events).toEqual(["worker-finalized", "scope-closed"]) })
it("DP-24", async () => { let active = 0, peak = 0; await Effect.runPromise(runOnceEffect([target("1"), target("2"), target("3")], { queueCapacity: 1, workerCount: 1 }, services(async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 2)); active--; return { status: 200, body: {} } }))); expect(peak).toBe(1) })
it("DP-25", async () => { let calls = 0; await Effect.runPromise(Effect.gen(function*() { const fiber = yield* Effect.forkChild(Effect.promise(signal => { const result = probeOnce(target("cancel"), { probe: async () => { calls++; throw new Error("retry") } }, signal); return Effect.isEffect(result) ? Effect.runPromise(result, { signal }) : result })); yield* Effect.sleep("2 millis"); yield* Fiber.interrupt(fiber) })); await new Promise(r => setTimeout(r, 30)); expect(calls).toBe(1) })
it("DP-26", async () => { const writes: string[] = []; await expect(Effect.runPromise(runOnceEffect([target("fail"), target("late")], { queueCapacity: 2, workerCount: 2 }, services(async (t: any, signal: AbortSignal) => t.id.endsWith("fail") ? { status: 200, body: {} } : new Promise((resolve, reject) => { const timer = setTimeout(() => resolve({ status: 200, body: {} }), 40); signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason) }) }), async (c: any) => { if (c.targetId.endsWith("fail")) throw new Error("fail"); writes.push(c.targetId) })))) .rejects.toBeTruthy(); await new Promise(r => setTimeout(r, 60)); expect(writes).toEqual([]) })
