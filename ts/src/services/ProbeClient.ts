import { Context, Effect } from "effect";
import {
  DnsError,
  InvalidBody,
  TimeoutError,
  UnexpectedStatus,
} from "../domain/errors.js";
import type { Target, TargetConfig } from "../domain/schema.js";
export interface RawProbeResponse {
  status: number;
  body?: unknown;
  bytes?: number;
}
export type ProbeFailure =
  | DnsError
  | TimeoutError
  | UnexpectedStatus
  | InvalidBody;
export type ProbeTarget = Target | TargetConfig;
export interface ProbeClientShape {
  probe(target: ProbeTarget, signal?: AbortSignal): Effect.Effect<RawProbeResponse, ProbeFailure>;
}
export class ProbeClient extends Context.Service<ProbeClient, ProbeClientShape>()("beaconwatch/ProbeClient") {}
type Step =
  | RawProbeResponse
  | ProbeFailure
  | { _tag: "delay"; duration: number; response: RawProbeResponse }
  | { _tag: "recover-after"; failures: number; response: RawProbeResponse };
export const valid = (status = 200): RawProbeResponse => ({
  status,
  body: { ok: true },
  bytes: 11,
});
export const slow = (duration = 2000, status = 200): Step => ({
  _tag: "delay",
  duration,
  response: valid(status),
});
export const malformedBody = (status = 200): RawProbeResponse => ({
  status,
  body: "not-json",
  bytes: 8,
});
export const statusError = (status = 500): RawProbeResponse => ({
  status,
  body: { ok: false },
  bytes: 12,
});
export const transportError = (host = "fake.local") => new DnsError({ host });
export const timeoutError = (timeout = "1 second") =>
  new TimeoutError({ timeout });
export const recoverAfter = (failures: number, response = valid()): Step => ({
  _tag: "recover-after",
  failures,
  response,
});

const fakeProbeImpl = (
  scripts: Map<string, Step[]>,
  counts: Map<string, number>,
  t: ProbeTarget,
  _signal?: AbortSignal,
): Effect.Effect<RawProbeResponse, ProbeFailure> =>
  Effect.gen(function*() {
    const key = scripts.has(t.id) ? t.id : t.url;
    const a = scripts.get(key) ?? [valid()];
    const step = a[0] ?? valid();
    if (a.length > 1) a.shift();
    if (step instanceof Error) return yield* Effect.fail(step as ProbeFailure);
    if ("_tag" in step && step._tag === "delay") {
      yield* Effect.sleep(step.duration);
      return step.response;
    }
    if ("_tag" in step && step._tag === "recover-after") {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      if (n <= step.failures) return yield* Effect.fail(new DnsError({ host: new URL(t.url).host }));
      return step.response;
    }
    return step;
  });

export class FakeProbeClient implements ProbeClientShape {
  private scripts: Map<string, Step[]>;
  private counts = new Map<string, number>();
  constructor(input: Record<string, Step | readonly Step[]>) {
    this.scripts = new Map(
      Object.entries(input).map(([k, v]) => [
        k,
        Array.isArray(v) ? ([...v] as Step[]) : [v as Step],
      ]),
    );
  }
  probe(t: ProbeTarget, _signal?: AbortSignal): Effect.Effect<RawProbeResponse, ProbeFailure> {
    return fakeProbeImpl(this.scripts, this.counts, t, _signal);
  }
}
export const Fake = (x: Record<string, Step | readonly Step[]>) =>
  new FakeProbeClient(x);
export const ProbeClientFake = {
  Fake,
  valid,
  slow,
  malformedBody,
  statusError,
  transportError,
  timeoutError,
  recoverAfter,
};
