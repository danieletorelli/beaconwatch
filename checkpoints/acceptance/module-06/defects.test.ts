import { expect, it } from "vitest"
import { Cause, Effect, Fiber, Ref } from "effect"
import { ConnectionPool, MAX_CONNECTION_POOL_SIZE, nestedResources } from "../../../src/repo/ConnectionPool.js"
import { ManagedAppRuntime, RequestRuntimeHost } from "../../../src/runtime/ManagedRuntime.js"
import { TelemetryExporter, useTelemetryExporter, useTelemetryExporterEffect } from "../../../src/obs/Telemetry.js"

it("DP-18", async () => { const before = ManagedAppRuntime.acquired; const host = new RequestRuntimeHost(); await host.handle(async () => 1); await host.handle(async () => 2); expect(ManagedAppRuntime.acquired).toBe(before) })
it("DP-19", async () => {
  const events: string[] = [], pool = new ConnectionPool(1, { onRelease: () => { events.push("release") } })
  await expect(pool.withConnection(async () => { throw new Error("use") })).rejects.toThrow("use")
  expect(events).toEqual(["release"])
  expect(() => new ConnectionPool(MAX_CONNECTION_POOL_SIZE + 1)).toThrow("connection pool size must be between 1 and 1024")
})
it("DP-20", async () => { const events: string[] = []; await nestedResources(events); expect(events).toEqual(["acquire-outer", "acquire-inner", "use", "release-inner", "release-outer"]) })
it("DP-21", async () => {
  const events: string[] = []
  const { nestedResourcesEffect } = await import("../../../src/repo/ConnectionPool.js")
  const exit = await Effect.runPromise(Effect.exit(nestedResourcesEffect(events, { use: true, innerRelease: true })))
  expect(events.slice(-2)).toEqual(["release-inner", "release-outer"])
  expect(exit._tag).toBe("Failure")
  const messages = exit._tag === "Failure" ? exit.cause.reasons.filter(Cause.isDieReason).map((reason) => (reason.defect as Error).message) : []
  expect(messages).toEqual(["nested use failed", "inner release failed"])
})
it("DP-44", async () => {
  let active = 0, peak = 0
  const pool = new ConnectionPool(1)
  await Promise.all(Array.from({ length: 3 }, () => pool.withConnection(async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 2)); active-- })))
  await expect(pool.withConnection(async () => { throw new Error("boom") })).rejects.toThrow("boom")
  await Effect.runPromise(Effect.gen(function*() {
    const entered = yield* Ref.make(false)
    const fiber = yield* Effect.forkChild(pool.withConnectionEffect(() => Ref.set(entered, true).pipe(Effect.andThen(Effect.never))))
    while (!(yield* Ref.get(entered))) yield* Effect.yieldNow
    yield* Fiber.interrupt(fiber)
  }))
  await expect(pool.withConnection(async h => h.id)).resolves.toBeTypeOf("number")
  expect(peak).toBe(1)
})
it("DP-56", async () => {
  class Exporter extends TelemetryExporter { override async shutdown() { this.events.push("shutdown") } }
  for (const use of [Effect.succeed("ok"), Effect.fail("failure")]) {
    const exporter = new Exporter(); await Effect.runPromise(Effect.exit(useTelemetryExporterEffect(exporter, use))); expect(exporter.events).toEqual(["start", "shutdown"])
  }
  const exporter = new Exporter()
  await Effect.runPromise(Effect.gen(function*() { const fiber = yield* Effect.forkChild(useTelemetryExporterEffect(exporter, Effect.never)); yield* Effect.yieldNow; yield* Fiber.interrupt(fiber) }))
  expect(exporter.events).toEqual(["start", "shutdown"])
})
it("DP-57", async () => {
  const exporter = new TelemetryExporter(), raced = await Promise.race([useTelemetryExporter(exporter, async () => "used", 5), Effect.runPromise(Effect.sleep("100 millis").pipe(Effect.as("hung")))])
  expect(raced).toBe("used")
})
