import { expect, it } from "vitest"
import { Duration, Effect, Fiber, Metric } from "effect"
import { CheckResult, ResponseMetadata, Up, type TargetId } from "../../src/domain/schema.js"
import { acquireTelemetryExporter, activeChecks, annotateCheck, annotateTarget, probeLatency, recordCheckMetrics, withDigestSpan, withProbeSpan } from "../../src/obs/Telemetry.js"
import { fiberLocalMinimumLogLevelDemo } from "../../src/obs/references.js"

it("records probe metrics and preserves annotated effect result", async () => {
  const check = new CheckResult({ id: "check_1", targetId: "target_api" as TargetId, checkedAt: new Date(), duration: Duration.millis(123), classification: new Up(), response: new ResponseMetadata({ status: 200, bytes: 1 }) })
  const result = await Effect.runPromise(Effect.gen(function*() { yield* annotateTarget(annotateCheck(Effect.succeed("ok"), check.id), check.targetId); yield* recordCheckMetrics(check); return yield* Metric.snapshot }))
  expect(result.some((s: any) => s.id === "beaconwatch_probe_latency_ms" || s.name === "beaconwatch_probe_latency_ms")).toBe(true)
})

it("Part 13.2 — span wrappers open named spans around effects", async () => {
  const probeName = await Effect.runPromise(withProbeSpan("target_api" as TargetId, Effect.currentSpan.pipe(Effect.map((s) => s.name))))
  const digestName = await Effect.runPromise(withDigestSpan(Effect.currentSpan.pipe(Effect.map((s) => s.name))))
  expect(probeName).toBe("probe")
  expect(digestName).toBe("digest")
})

it("Part 13.0 — runtime Reference is fiber-local and reverts outside the scope", async () => {
  const { before, inside, after } = await Effect.runPromise(fiberLocalMinimumLogLevelDemo)
  expect(inside).toBe("Debug")
  expect(after).toBe(before)
  expect(after).not.toBe(inside)
})

it("tracks overlapping checks through success, failure, and interruption", async () => {
  const check = new CheckResult({ id: "check_active", targetId: "target_api" as TargetId, checkedAt: new Date(), duration: Duration.millis(1), classification: new Up(), response: new ResponseMetadata({ status: 200 }) })
  const values = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const first = yield* Effect.forkScoped(recordCheckMetrics(check, Effect.sleep("20 millis")))
    const second = yield* Effect.forkScoped(recordCheckMetrics(check, Effect.never))
    yield* Effect.yieldNow
    const two = yield* Metric.value(activeChecks)
    yield* Effect.sleep("25 millis")
    const one = yield* Metric.value(activeChecks)
    yield* Fiber.interrupt(second)
    yield* Fiber.await(first)
    const zero = yield* Metric.value(activeChecks)
    yield* recordCheckMetrics(check, Effect.fail("expected")).pipe(Effect.exit)
    const afterFailure = yield* Metric.value(activeChecks)
    return [two, one, zero, afterFailure]
  })))
  expect(values.map((value: any) => value.value)).toEqual([2, 1, 0, 0])
})

it("acquires one shared exporter and bounds application-scope shutdown", async () => {
  let acquisitions = 0, releases = 0
  const started = Date.now()
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const exporter = yield* acquireTelemetryExporter(
      Effect.sync(() => { acquisitions++; return {} }),
      () => Effect.sync(() => { releases++ }).pipe(Effect.andThen(Effect.never)),
      "10 millis"
    )
    yield* Effect.all([Effect.sync(() => exporter), Effect.sync(() => exporter)])
  })))
  expect({ acquisitions, releases }).toEqual({ acquisitions: 1, releases: 1 })
  expect(Date.now() - started).toBeLessThan(500)
})
