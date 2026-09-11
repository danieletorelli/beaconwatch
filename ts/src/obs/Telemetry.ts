import { Effect, Metric } from "effect";
import type { CheckResult } from "../domain/schema.js";

export const probeLatencyMetric = Metric.histogram("beaconwatch_probe_latency_ms", {
  boundaries: [50, 100, 250, 500, 1000, 2500, 5000],
});
export const probeCountMetric = Metric.counter("beaconwatch_probe_total");
export const errorCountMetric = Metric.counter("beaconwatch_error_total");
export const activeProbeGauge = Metric.gauge("beaconwatch_active_probes");

export const recordCheckMetricsEffect = (c: CheckResult): Effect.Effect<void> =>
  Effect.gen(function*() {
    yield* Metric.modify(activeProbeGauge, 1);
    yield* Metric.update(probeLatencyMetric, c.duration);
    yield* Metric.update(probeCountMetric, 1);
    if (c.classification._tag !== "Up") yield* Metric.update(errorCountMetric, 1);
  }).pipe(Effect.ensuring(Metric.modify(activeProbeGauge, -1)));
