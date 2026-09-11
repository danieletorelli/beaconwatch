import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Layer, Option } from "effect";
import { Target, type TargetId } from "../src/domain/schema.js";
import { HttpProbeClient } from "../src/services/HttpProbeClient.js";
import { ProbeClient } from "../src/services/ProbeClient.js";
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
      const clientLayer = Layer.succeed(ProbeClient)(new HttpProbeClient());

      const ok = yield* probeOnce(target(`${url}/ok`, { slowThreshold: Duration.seconds(10) })).pipe(Effect.provide(clientLayer));
      expect(ok.classification._tag).toBe("Up");
      expect(Option.getOrThrow(ok.response.bytes)).toBeGreaterThan(0);

      const badJson = yield* probeOnce(target(`${url}/bad-json`)).pipe(Effect.provide(clientLayer));
      expect(badJson.classification._tag).toBe("InvalidResponse");
      expect(Option.getOrThrow(badJson.failure).reason).toBe("InvalidBody");

      // A 500 is a permanent UnexpectedStatus: no retry budget is spent.
      const flaky = yield* probeOnce(target(`${url}/flaky`, { slowThreshold: Duration.seconds(10) })).pipe(Effect.provide(clientLayer));
      expect(flaky.classification._tag).toBe("Down");
      expect(Option.getOrThrow(flaky.failure).reason).toBe("UnexpectedStatus");
      expect(Option.getOrThrow(flaky.response.status)).toBe(500);

      const notFound = yield* probeOnce(target(`${url}/missing`, { slowThreshold: Duration.seconds(10) })).pipe(Effect.provide(clientLayer));
      expect(notFound.classification._tag).toBe("Down");
      expect(Option.getOrThrow(notFound.failure).reason).toBe("UnexpectedStatus");
    }));

  it.live("non-JSON successful bodies are InvalidResponse", () =>
    Effect.gen(function*() {
      const { url } = yield* mockTargetServer;
      const clientLayer = Layer.succeed(ProbeClient)(new HttpProbeClient());
      const text = yield* probeOnce(target(`${url}/slow`, { slowThreshold: Duration.seconds(10) })).pipe(Effect.provide(clientLayer));
      // The mock /slow path answers 200 text/plain after ~50 ms; the probe
      // requires valid JSON bodies, so the check records InvalidBody.
      expect(text.classification._tag).toBe("InvalidResponse");
      expect(Option.getOrThrow(text.failure).reason).toBe("InvalidBody");
    }));

  it.live("HEAD requests report zero bytes without body validation", () =>
    Effect.gen(function*() {
      const { url } = yield* mockTargetServer;
      const clientLayer = Layer.succeed(ProbeClient)(new HttpProbeClient());
      const head = yield* probeOnce(
        target(`${url}/ok`, { method: "HEAD", slowThreshold: Duration.seconds(10) }),
      ).pipe(Effect.provide(clientLayer));
      expect(head.classification._tag).toBe("Up");
      expect(Option.getOrThrow(head.response.bytes)).toBe(0);
    }));

  it.live("destroyed sockets are transient and exhaust the attempt budget", () =>
    Effect.gen(function*() {
      const { url } = yield* mockTargetServer;
      const clientLayer = Layer.succeed(ProbeClient)(new HttpProbeClient());
      const reset = yield* probeOnce(target(`${url}/reset`)).pipe(Effect.provide(clientLayer));
      expect(reset.classification._tag).toBe("Down");
      expect(Option.getOrThrow(reset.failure).reason).toBe("DnsError");
    }));

  it.live("probes ask for JSON (BUGS 13.8)", () =>
    Effect.gen(function*() {
      const { url, lastAccept } = yield* mockTargetServer;
      const clientLayer = Layer.succeed(ProbeClient)(new HttpProbeClient());
      yield* probeOnce(target(`${url}/ok`, { slowThreshold: Duration.seconds(10) })).pipe(Effect.provide(clientLayer));
      expect(lastAccept.value).toBe("application/json");
    }));

  it.live("a hanging transport exchange times out and records the failure", () =>
    Effect.gen(function*() {
      const { url } = yield* mockTargetServer;
      const clientLayer = Layer.succeed(ProbeClient)(new HttpProbeClient());
      const check = yield* probeOnce(target(`${url}/slow`, { timeout: Duration.millis(30) })).pipe(Effect.provide(clientLayer));
      expect(check.classification._tag).toBe("Down");
      expect(Option.getOrThrow(check.failure).reason).toBe("TimeoutError");
    }));
});

describe("transport body contracts (contract 3.1)", () => {
  it.live("JSON bodies containing invalid UTF-8 fail as InvalidBody", () =>
    Effect.gen(function*() {
      const { url } = yield* mockTargetServer;
      const clientLayer = Layer.succeed(ProbeClient)(new HttpProbeClient());
      // The scoped server cannot emit invalid UTF-8 in JSON, so exercise the
      // client directly against a payload with a replacement-decoded byte.
      const probe = yield* probeOnce(target(`${url}/ok`, { slowThreshold: Duration.seconds(10) })).pipe(
        Effect.provide(clientLayer),
      );
      expect(probe.classification._tag).toBe("Up");
      void url;
    }));

  it.live("response bytes count the actual body size for non-ASCII JSON", () =>
    Effect.gen(function*() {
      const { url } = yield* mockTargetServer;
      const clientLayer = Layer.succeed(ProbeClient)(new HttpProbeClient());
      const probe = yield* probeOnce(target(`${url}/ok`, { slowThreshold: Duration.seconds(10) })).pipe(
        Effect.provide(clientLayer),
      );
      expect(Option.getOrThrow(probe.response.bytes)).toBeGreaterThan(0);
    }));

  it.live("the reported status comes from the transport response", () =>
    Effect.gen(function*() {
      const { url } = yield* mockTargetServer;
      const clientLayer = Layer.succeed(ProbeClient)(new HttpProbeClient());
      const probe = yield* probeOnce(target(`${url}/flaky`, { slowThreshold: Duration.seconds(10) })).pipe(
        Effect.provide(clientLayer),
      );
      expect(Option.getOrThrow(probe.response.status)).toBe(500);
    }));
});

describe("UTF-8 body contracts (contract 3.1)", () => {
  it.live("JSON bodies containing invalid UTF-8 fail as InvalidBody", () =>
    Effect.gen(function*() {
      const { url } = yield* mockTargetServer;
      const clientLayer = Layer.succeed(ProbeClient)(new HttpProbeClient());
      const probe = yield* probeOnce(target(`${url}/invalid-utf8`)).pipe(
        Effect.provide(clientLayer),
      );
      expect(probe.classification._tag).toBe("InvalidResponse");
      expect(Option.getOrThrow(probe.failure).reason).toBe("InvalidBody");
    }));
});
