import { Effect } from "effect";
import {
  DnsError,
  InvalidBody,
  TimeoutError,
  UnexpectedStatus,
} from "../domain/errors.js";
import type { ProbeClientShape, RawProbeResponse } from "./ProbeClient.js";
import type { ProbeTarget } from "./ProbeClient.js";
export class HttpProbeClient implements ProbeClientShape {
  constructor(private fetcher: typeof fetch = fetch) {}
  probe(
    target: ProbeTarget,
    signal?: AbortSignal,
  ): Effect.Effect<RawProbeResponse, DnsError | TimeoutError | UnexpectedStatus | InvalidBody> {
    const fetcher = this.fetcher;
    return probeOnceImpl(fetcher, target, signal);
  }
}
const probeOnceImpl = (
  fetcher: typeof fetch,
  target: ProbeTarget,
  signal?: AbortSignal,
): Effect.Effect<RawProbeResponse, DnsError | TimeoutError | UnexpectedStatus | InvalidBody> =>
  Effect.gen(function*() {
    let url: URL;
    try {
      url = new URL(target.url);
    } catch (e) {
      return yield* Effect.fail(new InvalidBody({ reason: `invalid URL: ${String(e)}` }));
    }
    const own = new AbortController();
    yield* Effect.sync(() => setTimeout(() => own.abort(), target.timeout));
    const abort = () => own.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = yield* Effect.tryPromise({
        try: () =>
          fetcher(url, {
            method: target.method,
            signal: own.signal,
            headers: { accept: "application/json" },
          }),
        catch: (e) => {
          if (own.signal.aborted) return new TimeoutError({ timeout: String(target.timeout), cause: e });
          return new DnsError({ host: url.host, cause: e });
        },
      });
      if (!target.expectedStatus.includes(response.status))
        return yield* Effect.fail(new UnexpectedStatus({ expected: target.expectedStatus, actual: response.status }));
      if (target.method === "HEAD")
        return { status: response.status, bytes: 0 };
      const bytes = new Uint8Array(yield* Effect.tryPromise({ try: () => response.arrayBuffer(), catch: (e) => new DnsError({ host: url.host, cause: e }) }));
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch (e) {
        return yield* Effect.fail(new InvalidBody({ reason: String(e) }));
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch (e) {
        return yield* Effect.fail(new InvalidBody({ reason: String(e) }));
      }
      return { status: response.status, body, bytes: bytes.byteLength };
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  });
export const Live = () => new HttpProbeClient();
export const HttpProbeClientLive = Live;
