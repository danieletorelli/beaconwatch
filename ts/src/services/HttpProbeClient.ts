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
  async probe(
    target: ProbeTarget,
    signal?: AbortSignal,
  ): Promise<RawProbeResponse> {
    let url: URL;
    try {
      url = new URL(target.url);
    } catch (e) {
      throw new InvalidBody({ reason: `invalid URL: ${String(e)}` });
    }
    const own = new AbortController();
    setTimeout(() => own.abort(), target.timeout);
    const abort = () => own.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.fetcher(url, {
        method: target.method,
        signal: own.signal,
      });
      if (!target.expectedStatus.includes(response.status))
        throw new UnexpectedStatus({
          expected: target.expectedStatus,
          actual: response.status,
        });
      if (target.method === "HEAD")
        return { status: response.status, bytes: 0 };
      const bytes = new Uint8Array(await response.arrayBuffer());
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch (e) {
        throw new InvalidBody({ reason: String(e) });
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch (e) {
        throw new InvalidBody({ reason: String(e) });
      }
      return { status: response.status, body, bytes: bytes.byteLength };
    } catch (e) {
      if (e instanceof InvalidBody || e instanceof UnexpectedStatus) throw e;
      if (own.signal.aborted)
        throw new TimeoutError({ timeout: String(target.timeout), cause: e });
      throw new DnsError({ host: url.host, cause: e });
    }
  }
}
export const Live = () => new HttpProbeClient();
export const HttpProbeClientLive = Live;
