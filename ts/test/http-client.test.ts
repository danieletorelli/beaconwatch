import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Option } from "effect";
import { Target, type TargetId } from "../src/domain/schema.js";
import { HttpProbeClient } from "../src/services/HttpProbeClient.js";
import { probeOnce } from "../src/probe/ProbeProgram.js";
import { mockTargetServer } from "./testkit/MockTargetServer.js";

const target = (url: string, overrides: Partial<ConstructorParameters<typeof Target>[0]> = {}) =>
  new Target({
    id: "target_api" as TargetId,
    name: "API",
    url,
    method: "GET",
    expectedStatus: [200] as [number, ...number[]],
    interval: Duration.millis(10),
    timeout: Duration.seconds(2),
    slowThreshold: Duration.millis(1),
    enabled: true,
    ...overrides,
  });

describe("live HTTP probe client", () => {
  it.live("classifies real exchanges against the contract paths", () =>
    Effect.gen(function*() {
      const { url } = yield* mockTargetServer;
      const client = new HttpProbeClient();

      const ok = yield* probeOnce(target(`${url}/ok`, { slowThreshold: Duration.seconds(10) }), client);
      expect(ok.classification._tag).toBe("Up");
      expect(Option.getOrThrow(ok.response.bytes)).toBeGreaterThan(0);

      const badJson = yield* probeOnce(target(`${url}/bad-json`), client);
      expect(badJson.classification._tag).toBe("InvalidResponse");
      expect(Option.getOrThrow(badJson.failure).reason).toBe("InvalidBody");

      // A 500 is a permanent UnexpectedStatus: no retry budget is spent.
      const flaky = yield* probeOnce(target(`${url}/flaky`, { slowThreshold: Duration.seconds(10) }), client);
      expect(flaky.classification._tag).toBe("Down");
      expect(Option.getOrThrow(flaky.failure).reason).toBe("UnexpectedStatus");
      expect(Option.getOrThrow(flaky.response.status)).toBe(500);

      const notFound = yield* probeOnce(target(`${url}/missing`, { slowThreshold: Duration.seconds(10) }), client);
      expect(notFound.classification._tag).toBe("Down");
      expect(Option.getOrThrow(notFound.failure).reason).toBe("UnexpectedStatus");
    }));

  it.live("non-JSON successful bodies are InvalidResponse", () =>
    Effect.gen(function*() {
      const { url } = yield* mockTargetServer;
      const client = new HttpProbeClient();
      const text = yield* probeOnce(target(`${url}/slow`, { slowThreshold: Duration.seconds(10) }), client);
      // The mock /slow path answers 200 text/plain after ~50 ms; the probe
      // requires valid JSON bodies, so the check records InvalidBody.
      expect(text.classification._tag).toBe("InvalidResponse");
      expect(Option.getOrThrow(text.failure).reason).toBe("InvalidBody");
    }));

  it.live("HEAD requests report zero bytes without body validation", () =>
    Effect.gen(function*() {
      const { url } = yield* mockTargetServer;
      const client = new HttpProbeClient();
      const head = yield* probeOnce(
        target(`${url}/ok`, { method: "HEAD", slowThreshold: Duration.seconds(10) }),
        client,
      );
      expect(head.classification._tag).toBe("Up");
      expect(Option.getOrThrow(head.response.bytes)).toBe(0);
    }));

  it.live("destroyed sockets are transient and exhaust the attempt budget", () =>
    Effect.gen(function*() {
      const { url } = yield* mockTargetServer;
      const client = new HttpProbeClient();
      const reset = yield* probeOnce(target(`${url}/reset`), client);
      expect(reset.classification._tag).toBe("Down");
      expect(Option.getOrThrow(reset.failure).reason).toBe("DnsError");
    }));

  it.live("probes ask for JSON (BUGS 13.8)", () =>
    Effect.gen(function*() {
      const { url, lastAccept } = yield* mockTargetServer;
      const client = new HttpProbeClient();
      yield* probeOnce(target(`${url}/ok`, { slowThreshold: Duration.seconds(10) }), client);
      expect(lastAccept.value).toBe("application/json");
    }));

  it.live("a hanging transport exchange times out and records the failure", () =>
    Effect.gen(function*() {
      const { url } = yield* mockTargetServer;
      const client = new HttpProbeClient();
      const check = yield* probeOnce(target(`${url}/slow`, { timeout: Duration.millis(30) }), client);
      expect(check.classification._tag).toBe("Down");
      expect(Option.getOrThrow(check.failure).reason).toBe("TimeoutError");
    }));
});
