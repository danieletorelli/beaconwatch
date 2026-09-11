import { Duration, Effect, Metric } from "effect";
import type { CheckResult } from "../domain/schema.js";

// Contract section 11: each recorded check observes duration in milliseconds
// with these exact boundaries, and adds 1 to the target-state counter for Up,
// otherwise 0. The active gauge returns to its prior value on every exit.
export const probeLatencyMetric = Metric.histogram("beaconwatch_probe_latency_ms", {
  boundaries: [10, 50, 100, 250, 500, 1000, 2500, 5000],
});
export const targetUpDownMetric = Metric.counter("beaconwatch_target_state_total");
export const activeProbeGauge = Metric.gauge("beaconwatch_active_probes");

export const recordCheckMetricsEffect = (c: CheckResult): Effect.Effect<void> =>
  Effect.gen(function*() {
    yield* Metric.modify(activeProbeGauge, 1);
    yield* Metric.update(probeLatencyMetric, Duration.toMillis(c.duration));
    yield* Metric.update(targetUpDownMetric, c.classification._tag === "Up" ? 1 : 0);
  }).pipe(Effect.ensuring(Metric.modify(activeProbeGauge, -1)));
