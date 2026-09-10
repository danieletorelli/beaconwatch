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
  probe(target: ProbeTarget, signal?: AbortSignal): Promise<RawProbeResponse>;
}
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
  async probe(t: ProbeTarget, signal?: AbortSignal) {
    const key = this.scripts.has(t.id) ? t.id : t.url;
    const a = this.scripts.get(key) ?? [valid()];
    const step = a[0] ?? valid();
    if (a.length > 1) a.shift();
    if (step instanceof Error) throw step;
    if ("_tag" in step && step._tag === "delay") {
      await new Promise<void>((resolve) => setTimeout(resolve, step.duration));
      return step.response;
    }
    if ("_tag" in step && step._tag === "recover-after") {
      const n = (this.counts.get(key) ?? 0) + 1;
      this.counts.set(key, n);
      if (n <= step.failures) throw new DnsError({ host: new URL(t.url).host });
      return step.response;
    }
    return step;
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
