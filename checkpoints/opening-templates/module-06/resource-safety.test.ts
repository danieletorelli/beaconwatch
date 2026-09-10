import { expect, it } from "vitest"
import { Cause, Effect, Fiber, Ref } from "effect"
import { ConnectionPool, nestedResources } from "../../src/repo/ConnectionPool.js"
import { ManagedAppRuntime, RequestRuntimeHost } from "../../src/runtime/ManagedRuntime.js"
import { TelemetryExporter, useTelemetryExporter } from "../../src/obs/Telemetry.js"

it("shares scopes and releases every resource on every exit", async () => {
  const telemetry = await import("../../src/obs/" + "Telemetry.js") as any
  expect(telemetry.useTelemetryExporterEffect, "make exporter ownership interruptible").toBeDefined()
  const before = ManagedAppRuntime.acquired
  const host = new RequestRuntimeHost()
  await host.handle(async () => 1)
  await host.handle(async () => 2)
  expect(ManagedAppRuntime.acquired).toBe(before)

  const events: string[] = []
  await expect(nestedResources(events, { use: true })).rejects.toBeTruthy()
  expect(events).toEqual(["acquire-outer", "acquire-inner", "release-inner", "release-outer"])
  const nestedResourcesEffect = (await import("../../src/repo/ConnectionPool.js") as any).nestedResourcesEffect
  expect(nestedResourcesEffect, "preserve simultaneous use and release failures").toBeDefined()
  const combined = await Effect.runPromise(Effect.exit(nestedResourcesEffect([], { use: true, innerRelease: true })))
  expect(combined._tag).toBe("Failure")
  const defectMessages = combined._tag === "Failure"
    ? combined.cause.reasons.filter(Cause.isDieReason).map((reason) => (reason.defect as Error).message)
    : []
  expect(defectMessages).toEqual(["nested use failed", "inner release failed"])
  const maxPoolSize = (await import("../../src/repo/ConnectionPool.js") as any).MAX_CONNECTION_POOL_SIZE
  expect(maxPoolSize, "publish the application pool bound").toBe(1024)
  expect(() => new ConnectionPool(maxPoolSize + 1)).toThrow("connection pool size must be between 1 and 1024")

  const releases: string[] = []
  const pool = new ConnectionPool(1, { onRelease: () => { releases.push("release") } })
  await expect(pool.withConnection(async () => { throw new Error("use") })).rejects.toThrow("use")
  expect(releases).toEqual(["release"])
  let active = 0, peak = 0
  await Promise.all(Array.from({ length: 3 }, () => pool.withConnection(async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 2)); active-- })))
  await Effect.runPromise(Effect.gen(function*() {
    const entered = yield* Ref.make(false)
    const fiber = yield* Effect.forkChild((pool as any).withConnectionEffect(() => Ref.set(entered, true).pipe(Effect.andThen(Effect.never))))
    while (!(yield* Ref.get(entered))) yield* Effect.yieldNow
    yield* Fiber.interrupt(fiber)
  }) as any)
  expect(peak).toBe(1)
  await expect(pool.withConnection(async handle => handle.id)).resolves.toBeTypeOf("number")

  class Exporter extends TelemetryExporter { override async shutdown() { this.events.push("shutdown") } }
  for (const use of [Effect.void, Effect.fail("failure")]) {
    const exporter = new Exporter()
    await Effect.runPromise(Effect.exit(telemetry.useTelemetryExporterEffect(exporter, use)) as any)
    expect(exporter.events).toEqual(["start", "shutdown"])
  }
  const interrupted = new Exporter()
  await Effect.runPromise(Effect.gen(function*() {
    const fiber = yield* Effect.forkChild(telemetry.useTelemetryExporterEffect(interrupted, Effect.never))
    yield* Effect.yieldNow
    yield* Fiber.interrupt(fiber)
  }) as any)
  expect(interrupted.events).toEqual(["start", "shutdown"])
  const bounded = new TelemetryExporter()
  await expect((useTelemetryExporter as any)(bounded, async () => { throw new Error("use") }, 5)).rejects.toThrow("use")
  expect(bounded.events).toEqual(["start"])
})
