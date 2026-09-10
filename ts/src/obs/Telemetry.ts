import { Effect, Metric } from "effect";
import type { CheckResult, TargetId } from "../domain/schema.js";
export const metrics = {
  probeLatency: [] as number[],
  targetUpDown: [] as number[],
  active: 0,
  logs: [] as string[],
  spans: [] as { name: string; start: number; end: number | undefined; parentId?: string; status?: string }[],
};
export const probeLatency = "beaconwatch_probe_latency_ms",
  targetUpDown = "beaconwatch_target_state_total";
export const annotateTarget = <A>(p: Promise<A>, id: TargetId) => {
  metrics.logs.push(`checking target ${id}`);
  return p;
};
export const annotateCheck = <A>(p: Promise<A>, _id: string) => p;
export const withProbeSpan = async <A>(_id: TargetId, p: Promise<A>) => {
  const span = { name: "probe", start: Date.now(), end: undefined as number | undefined };
  metrics.spans.push(span);
  const value = await p;
  span.end = Date.now();
  return value;
};
export const runTargetCheck = async <A>(
  id: TargetId,
  load: () => Promise<unknown>,
  probe: () => Promise<A>,
) => {
  const flat = async <B>(name: string, work: () => Promise<B>) => {
    const span = { name, start: Date.now(), end: undefined as number | undefined };
    metrics.spans.push(span);
    const value = await work();
    span.end = Date.now();
    return value;
  };
  await flat("load-target", load);
  return flat(`probe-${id}`, probe);
};
export const withDigestSpan = <A>(p: Promise<A>) => p;
export const recordCheckMetrics = async (c: CheckResult, between: () => Promise<void> = async () => {}) => {
  metrics.active++;
  await between();
  metrics.probeLatency.push(c.duration);
  metrics.targetUpDown.push(c.classification._tag === "Up" ? 1 : 0);
  metrics.active--;
};
export class TelemetryExporter {
  events: string[] = [];
  start() { this.events.push("start"); }
  export(value: string) { this.events.push(value); }
  shutdown() { this.events.push("shutdown"); }
}
export const useTelemetryExporter = async <A>(
  exporter: TelemetryExporter,
  use: () => Promise<A>,
) => {
  exporter.start();
  const value = await use();
  await exporter.shutdown();
  return value;
};

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
