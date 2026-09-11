import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Option, Result } from "effect";
import { TestClock } from "effect/testing";
import {
  CheckResult,
  ResponseMetadata,
  Target,
  Up,
  targetId,
  type TargetId,
} from "../src/domain/schema.js";
import { InMemoryCheckRepository } from "../src/repo/CheckRepository.js";
import {
  FakeProbeClient,
  recoverAfter,
  slow as slowStep,
  transportError,
  valid,
} from "../src/services/ProbeClient.js";
import { probeOnce } from "../src/probe/ProbeProgram.js";

// Drive a fiber under TestClock until it completes, feeding any pending
// sleeps/timeout waits as they are scheduled.
const advanceUntilDone = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Effect.raceFirst(Fiber.join(fiber), Effect.forever(TestClock.adjust(100)));

const target = (overrides: Partial<ConstructorParameters<typeof Target>[0]> = {}) =>
  new Target({
    id: "target_api" as TargetId,
    name: "API",
    url: "http://example.test",
    method: "GET",
    expectedStatus: [200] as [number, ...number[]],
    interval: Duration.millis(10),
    timeout: Duration.millis(50),
    slowThreshold: Duration.millis(100),
    enabled: true,
    ...overrides,
  });

describe("probe workflow", () => {
  it.effect("recovers transient failures within the attempt budget", () =>
    Effect.gen(function*() {
      const client = new FakeProbeClient({
        target_api: [transportError(), transportError(), valid()],
      });
      const fiber = yield* Effect.forkScoped(probeOnce(target(), client));
      const check = yield* advanceUntilDone(fiber);
      expect(check.classification._tag).toBe("Up");
      expect(Option.isNone(check.failure)).toBe(true);
    }));

  it.live("exhausted transient failures become Down with the failure tag", () =>
    Effect.gen(function*() {
      const client = new FakeProbeClient({ target_api: recoverAfter(4) });
      const check = yield* probeOnce(target(), client);
      expect(check.classification._tag).toBe("Down");
      expect(Option.isSome(check.failure)).toBe(true);
      expect(Option.getOrThrow(check.failure).reason).toBe("DnsError");
    }));

  it.live("times out hanging exchanges and records the timeout failure", () =>
    Effect.gen(function*() {
      // 5-second delay against a 50 ms timeout: four attempts, then Down.
      const client = new FakeProbeClient({ target_api: slowStep(5_000) });
      const check = yield* probeOnce(target(), client);
      expect(check.classification._tag).toBe("Down");
      expect(Option.getOrThrow(check.failure).reason).toBe("TimeoutError");
    }));

  it.effect("fails a disabled target without any network attempt", () =>
    Effect.gen(function*() {
      const client = new FakeProbeClient({});
      const outcome = yield* Effect.result(
        probeOnce(target({ enabled: false }), client),
      );
      expect(Result.isFailure(outcome)).toBe(true);
      if (Result.isFailure(outcome)) expect(String(outcome.failure)).toContain("TargetDisabled");
    }));

  it.effect("unexpected status is Down with the actual status retained", () =>
    Effect.gen(function*() {
      const client = new FakeProbeClient({ target_api: valid(500) });
      const check = yield* probeOnce(target(), client);
      expect(check.classification._tag).toBe("Down");
      expect(Option.getOrThrow(check.failure).reason).toBe("UnexpectedStatus");
      expect(Option.getOrThrow(check.response.status)).toBe(500);
    }));

  it.effect("out-of-range transport status omits response metadata", () =>
    Effect.gen(function*() {
      const client = new FakeProbeClient({ target_api: valid(600) });
      const check = yield* probeOnce(target(), client);
      expect(Option.getOrThrow(check.failure).reason).toBe("UnexpectedStatus");
      expect(Option.isNone(check.response.status)).toBe(true);
    }));

  it.live("duration strictly greater than slowThreshold is Slow", () =>
    Effect.gen(function*() {
      const client = new FakeProbeClient({ target_api: slowStep(30) });
      const check = yield* probeOnce(
        target({ timeout: Duration.seconds(1), slowThreshold: Duration.millis(1) }),
        client,
      );
      expect(check.classification._tag).toBe("Slow");
    }));

  it.effect("health-body mismatch is InvalidResponse with HealthBodyMismatch", () =>
    Effect.gen(function*() {
      const client = new FakeProbeClient({ target_api: valid() });
      const withSchema = target({
        healthBodySchema: JSON.stringify({
          type: "object",
          properties: { required: { type: "string" } },
          required: ["required"],
        }),
      });
      const check = yield* probeOnce(withSchema, client);
      expect(check.classification._tag).toBe("InvalidResponse");
      expect(Option.getOrThrow(check.failure).reason).toBe("HealthBodyMismatch");
    }));

  it.effect("invalid and $async health schemas are schema parse errors", () =>
    Effect.gen(function*() {
      const client = new FakeProbeClient({ target_api: valid() });
      const invalid = yield* probeOnce(target({ healthBodySchema: "[" }), client);
      expect(invalid.classification._tag).toBe("InvalidResponse");
      expect(Option.getOrThrow(invalid.failure).reason).toBe("HealthSchemaParseError");
      const asyncSchema = yield* probeOnce(
        target({ healthBodySchema: JSON.stringify({ type: "object", $async: true }) }),
        client,
      );
      expect(Option.getOrThrow(asyncSchema.failure).reason).toBe("HealthSchemaParseError");
    }));

  it.effect("decoded string bodies are ordinary data without a schema", () =>
    Effect.gen(function*() {
      const client = new FakeProbeClient({ target_api: { status: 200, body: "not-json", bytes: 8 } });
      const check = yield* probeOnce(target(), client);
      expect(check.classification._tag).toBe("Up");
    }));

  it.effect("produces a structurally sound check result", () =>
    Effect.gen(function*() {
      const client = new FakeProbeClient({ target_api: valid() });
      const check = yield* probeOnce(target(), client);
      expect(check instanceof CheckResult).toBe(true);
      expect(check.targetId).toBe(targetId("target_api"));
      expect(check.response instanceof ResponseMetadata).toBe(true);
      expect(check.classification instanceof Up).toBe(true);
      expect(check.id.startsWith("check_")).toBe(true);
    }));
});

describe("probe repository integration", () => {
  it.effect("a failing probe opens an incident through the repository", () =>
    Effect.gen(function*() {
      const repo = new InMemoryCheckRepository();
      const client = new FakeProbeClient({ target_api: valid(500) });
      const check = yield* probeOnce(target(), client);
      yield* Effect.tryPromise(() => repo.applyCheck(check));
      const open = yield* Effect.tryPromise(() => repo.getOpenIncident(check.targetId));
      expect(Option.isSome(open)).toBe(true);
    }));
});

describe("probe client validation (BUGS 13.7)", () => {
  it("rejects empty script sequences at construction", () => {
    expect(() => new FakeProbeClient({ target_api: [] })).toThrow();
  });
  it("rejects negative and fractional recover-after counts", () => {
    expect(() => new FakeProbeClient({ target_api: recoverAfter(-1) })).toThrow();
    expect(() => new FakeProbeClient({ target_api: recoverAfter(1.5) })).toThrow();
    expect(() => new FakeProbeClient({ target_api: recoverAfter(Number.MAX_SAFE_INTEGER + 1) })).toThrow();
  });
});

describe("probe classification precedence (BUGS 2.7)", () => {
  it.effect("an unexpected status overrides a body failure", () =>
    Effect.gen(function*() {
      const client = new FakeProbeClient({ target_api: valid(500) });
      const withSchema = target({
        healthBodySchema: JSON.stringify({ type: "object", required: ["missing"] }),
      });
      const check = yield* probeOnce(withSchema, client);
      expect(check.classification._tag).toBe("Down");
      expect(Option.getOrThrow(check.failure).reason).toBe("UnexpectedStatus");
    }));
});
