import { Duration, Effect, Metric } from "effect"
import type { CheckResult, TargetId } from "../domain/schema.js"

export const probeLatency = Metric.histogram("beaconwatch_probe_latency_ms", { boundaries: [10, 50, 100, 250, 500, 1000, 2500, 5000] })
export const targetUpDown = Metric.counter("beaconwatch_target_state_total")
export const activeChecks = Metric.gauge("beaconwatch_active_checks")

export const annotateTarget = <A, E, R>(effect: Effect.Effect<A, E, R>, targetId: TargetId) => effect.pipe(Effect.annotateLogs("target_id", targetId))
export const annotateCheck = <A, E, R>(effect: Effect.Effect<A, E, R>, checkId: string) => effect.pipe(Effect.annotateLogs("check_id", checkId))
export const withProbeSpan = <A, E, R>(targetId: TargetId, effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.withSpan("probe", { attributes: { target_id: targetId } }))
export const withDigestSpan = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.withSpan("digest"))

export const runTargetCheck = <A, E, R>(targetId: TargetId, load: Effect.Effect<unknown, E, R>, probe: Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    yield* load.pipe(Effect.withSpan("load-target"))
    return yield* probe.pipe(Effect.withSpan("probe", { attributes: { target_id: targetId } }))
  }).pipe(Effect.withSpan("target-check", { attributes: { target_id: targetId } }))

export const recordCheckMetrics = <A = void, E = never, R = never>(
  check: CheckResult,
  work: Effect.Effect<A, E, R> = Effect.void as unknown as Effect.Effect<A, E, R>
) => Effect.acquireUseRelease(
  Metric.modify(activeChecks, 1),
  () => work.pipe(Effect.andThen(Effect.all([
    Metric.update(probeLatency, Duration.toMillis(check.duration)),
    Metric.update(targetUpDown, check.classification._tag === "Up" ? 1 : 0)
  ], { discard: true }))),
  () => Metric.modify(activeChecks, -1)
)

/** Acquire once in the application Scope and share the returned exporter. */
export const acquireTelemetryExporter = <A, E, R>(
  acquire: Effect.Effect<A, E, R>,
  shutdown: (exporter: A) => Effect.Effect<void>,
  shutdownTimeout: Duration.Input = "1 second"
) => Effect.acquireRelease(
  acquire,
  (exporter) => shutdown(exporter).pipe(
    Effect.timeout(shutdownTimeout),
    Effect.ignore
  )
)
