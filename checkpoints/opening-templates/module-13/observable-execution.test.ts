import { expect, it } from "vitest"
import { Effect, Logger, Metric, Redacted, References, Tracer } from "effect"
import { CheckResult, ResponseMetadata, Up, targetId } from "../../src/domain/schema.js"
import * as Telemetry from "../../src/obs/Telemetry.js"
import * as ReferenceDemos from "../../src/obs/references.js"

it("keeps observability structured, scoped, hierarchical, and balanced", async () => {
  const { activeChecks, annotateTarget, recordCheckMetrics, runTargetCheck, withDigestSpan, withProbeSpan } = Telemetry as any
  const { fiberLocalMinimumLogLevelDemo, withMinimumLogLevel } = ReferenceDemos as any
  expect(activeChecks, "publish the scoped active-check gauge").toBeDefined()
  const local: any = await Effect.runPromise(fiberLocalMinimumLogLevelDemo as any)
  expect(local.inside).toBe("Debug")
  expect(local.after).toBe(local.before)
  const levels = await Effect.runPromise(Effect.all([
    withMinimumLogLevel("Debug", References.MinimumLogLevel),
    withMinimumLogLevel("Error", References.MinimumLogLevel),
  ] as any, { concurrency: 2 }) as any)
  expect(levels).toEqual(["Debug", "Error"])

  const records: any[] = []
  const logger = Logger.make(record => records.push({ annotations: record.fiber.getRef(References.CurrentLogAnnotations), message: JSON.stringify(record.message) }))
  const secret = "do-not-export-this-token"
  await Effect.runPromise(annotateTarget(Effect.logInfo("done", { token: Redacted.make(secret) }).pipe(Effect.annotateLogs("check_id", "check_1")), targetId("target_api")).pipe(Effect.provide(Logger.layer([logger]))) as any)
  expect(records[0].annotations).toMatchObject({ target_id: "target_api", check_id: "check_1" })
  expect(records[0].message).toContain("<redacted>")
  expect(records[0].message).not.toContain(secret)
  expect(await Effect.runPromise(withProbeSpan(targetId("target_api"), Effect.currentSpan.pipe(Effect.map(span => span.name))) as any)).toBe("probe")
  expect(await Effect.runPromise(withDigestSpan(Effect.currentSpan.pipe(Effect.map(span => span.name))) as any)).toBe("digest")

  const spans: Tracer.NativeSpan[] = []
  const tracer = Tracer.make({ span(options) { const span = new Tracer.NativeSpan(options); spans.push(span); return span } })
  await Effect.runPromise(runTargetCheck(targetId("target_api"), Effect.void, Effect.fail("probe-failed")).pipe(Effect.withTracer(tracer), Effect.exit) as any)
  const parent = spans.find(span => span.name === "target-check")!
  const child = spans.find(span => span.name === "probe")!
  expect(child.parent._tag === "Some" && child.parent.value.spanId).toBe(parent.spanId)
  expect(child.status._tag === "Ended" && child.status.exit._tag).toBe("Failure")

  const check = new CheckResult({ id: "check_1", targetId: targetId("target_api"), checkedAt: new Date(), duration: 1, classification: new Up(), response: new ResponseMetadata({}) })
  await Effect.runPromise(recordCheckMetrics(check, Effect.fail("expected")).pipe(Effect.exit) as any)
  const gauge: any = (await Effect.runPromise(Metric.value(activeChecks)))
  expect(gauge.value).toBe(0)
})
