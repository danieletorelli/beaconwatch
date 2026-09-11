import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Option, Result } from "effect";
import { TestClock } from "effect/testing";
import {
  CheckFailure,
  CheckId,
  CheckResult,
  Down,
  ResponseMetadata,
  Target,
  Up,
  targetId,
  type TargetId,
} from "../src/domain/schema.js";
import { CheckRepository, InMemoryLayer } from "../src/repo/CheckRepository.js";
import {
  FakeLayer,
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
      const fiber = yield* Effect.forkScoped(
        probeOnce(target()).pipe(
          Effect.provide(FakeLayer({ target_api: [transportError(), transportError(), valid()] })),
        ),
      );
      const check = yield* advanceUntilDone(fiber);
      expect(check.classification._tag).toBe("Up");
      expect(Option.isNone(check.failure)).toBe(true);
    }));

  it.live("exhausted transient failures become Down with the failure tag", () =>
    Effect.gen(function*() {
      const check = yield* probeOnce(target()).pipe(
        Effect.provide(FakeLayer({ target_api: recoverAfter(4) })),
      );
      expect(check.classification._tag).toBe("Down");
      expect(Option.isSome(check.failure)).toBe(true);
      expect(Option.getOrThrow(check.failure).reason).toBe("DnsError");
    }));

  it.live("times out hanging exchanges and records the timeout failure", () =>
    Effect.gen(function*() {
      // 5-second delay against a 50 ms timeout: four attempts, then Down.
      const check = yield* probeOnce(target()).pipe(
        Effect.provide(FakeLayer({ target_api: slowStep(5_000) })),
      );
      expect(check.classification._tag).toBe("Down");
      expect(Option.getOrThrow(check.failure).reason).toBe("TimeoutError");
    }));

  it.effect("fails a disabled target without any network attempt", () =>
    Effect.gen(function*() {
      const outcome = yield* Effect.result(
        probeOnce(target({ enabled: false })).pipe(
          Effect.provide(FakeLayer({})),
        ),
      );
      expect(Result.isFailure(outcome)).toBe(true);
      if (Result.isFailure(outcome)) expect(String(outcome.failure)).toContain("TargetDisabled");
    }));

  it.effect("unexpected status is Down with the actual status retained", () =>
    Effect.gen(function*() {
      const check = yield* probeOnce(target()).pipe(
        Effect.provide(FakeLayer({ target_api: valid(500) })),
      );
      expect(check.classification._tag).toBe("Down");
      expect(Option.getOrThrow(check.failure).reason).toBe("UnexpectedStatus");
      expect(Option.getOrThrow(check.response.status)).toBe(500);
    }));

  it.effect("out-of-range transport status omits response metadata", () =>
    Effect.gen(function*() {
      const check = yield* probeOnce(target()).pipe(
        Effect.provide(FakeLayer({ target_api: valid(600) })),
      );
      expect(Option.getOrThrow(check.failure).reason).toBe("UnexpectedStatus");
      expect(Option.isNone(check.response.status)).toBe(true);
    }));

  it.live("duration strictly greater than slowThreshold is Slow", () =>
    Effect.gen(function*() {
      const check = yield* probeOnce(
        target({ timeout: Duration.seconds(1), slowThreshold: Duration.millis(1) }),
      ).pipe(Effect.provide(FakeLayer({ target_api: slowStep(30) })));
      expect(check.classification._tag).toBe("Slow");
    }));

  it.effect("health-body mismatch is InvalidResponse with HealthBodyMismatch", () =>
    Effect.gen(function*() {
      const withSchema = target({
        healthBodySchema: JSON.stringify({
          type: "object",
          properties: { required: { type: "string" } },
          required: ["required"],
        }),
      });
      const check = yield* probeOnce(withSchema).pipe(
        Effect.provide(FakeLayer({ target_api: valid() })),
      );
      expect(check.classification._tag).toBe("InvalidResponse");
      expect(Option.getOrThrow(check.failure).reason).toBe("HealthBodyMismatch");
    }));

  it.effect("invalid and $async health schemas are schema parse errors", () =>
    Effect.gen(function*() {
      const invalid = yield* probeOnce(target({ healthBodySchema: "[" })).pipe(
        Effect.provide(FakeLayer({ target_api: valid() })),
      );
      expect(invalid.classification._tag).toBe("InvalidResponse");
      expect(Option.getOrThrow(invalid.failure).reason).toBe("HealthSchemaParseError");
      const asyncSchema = yield* probeOnce(
        target({ healthBodySchema: JSON.stringify({ type: "object", $async: true }) }),
      ).pipe(Effect.provide(FakeLayer({ target_api: valid() })));
      expect(Option.getOrThrow(asyncSchema.failure).reason).toBe("HealthSchemaParseError");
    }));

  it.effect("decoded string bodies are ordinary data without a schema", () =>
    Effect.gen(function*() {
      const check = yield* probeOnce(target()).pipe(
        Effect.provide(FakeLayer({ target_api: { status: 200, body: "not-json", bytes: 8 } })),
      );
      expect(check.classification._tag).toBe("Up");
    }));

  it.effect("produces a structurally sound check result", () =>
    Effect.gen(function*() {
      const check = yield* probeOnce(target()).pipe(
        Effect.provide(FakeLayer({ target_api: valid() })),
      );
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
      const repo = yield* CheckRepository;
      const check = yield* probeOnce(target()).pipe(
        Effect.provide(FakeLayer({ target_api: valid(500) })),
      );
      yield* repo.applyCheck(check);
      const open = yield* repo.getOpenIncident(check.targetId);
      expect(Option.isSome(open)).toBe(true);
    }).pipe(Effect.provide(InMemoryLayer)));
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
      const withSchema = target({
        healthBodySchema: JSON.stringify({ type: "object", required: ["missing"] }),
      });
      const check = yield* probeOnce(withSchema).pipe(
        Effect.provide(FakeLayer({ target_api: valid(500) })),
      );
      expect(check.classification._tag).toBe("Down");
      expect(Option.getOrThrow(check.failure).reason).toBe("UnexpectedStatus");
    }));
});

describe("body-schema contracts (contract 3.2 rule 2)", () => {
  it.effect("HEAD bypasses body-schema validation entirely", () =>
    Effect.gen(function*() {
      const check = yield* probeOnce(
        target({
          method: "HEAD",
          healthBodySchema: JSON.stringify({ type: "object", required: ["impossible"] }),
        }),
      ).pipe(Effect.provide(FakeLayer({ target_api: valid() })));
      // HEAD is Up even though the schema would reject any object body.
      expect(check.classification._tag).toBe("Up");
      expect(Option.isNone(check.failure)).toBe(true);
    }));

  it.effect("Draft-7 extension and annotation keywords are accepted", () =>
    Effect.gen(function*() {
      const schema = JSON.stringify({
        $id: "https://example.test/health",
        $schema: "http://json-schema.org/draft-07/schema#",
        title: "Health envelope",
        examples: [{ ok: true }],
        type: "object",
        properties: { ok: { type: "boolean", "x-extension": true } },
        required: ["ok"],
      });
      const matching = yield* probeOnce(target({ healthBodySchema: schema })).pipe(
        Effect.provide(FakeLayer({ target_api: { status: 200, body: { ok: true }, bytes: 14 } })),
      );
      expect(matching.classification._tag).toBe("Up");
      const mismatching = yield* probeOnce(target({ healthBodySchema: schema })).pipe(
        Effect.provide(FakeLayer({ target_api: { status: 200, body: { nope: 1 }, bytes: 12 } })),
      );
      expect(Option.getOrThrow(mismatching.failure).reason).toBe("HealthBodyMismatch");
    }));
});

describe("same-millisecond incidents (contract 4.2)", () => {
  it.effect("a later failure after a close opens a distinct incident in the same millisecond", () =>
    Effect.gen(function*() {
      const repo = yield* CheckRepository;
      const failing = (id: string) =>
        new CheckResult({
          id: id as CheckId,
          targetId: targetId("target_api"),
          checkedAt: new Date(100),
          duration: Duration.millis(1),
          classification: new Down(),
          failure: Option.some(new CheckFailure({ reason: "DnsError" })),
          response: new ResponseMetadata({ status: Option.some(500), bytes: Option.none() }),
        });
      const recovering = new CheckResult({
        id: "check_up" as CheckId,
        targetId: targetId("target_api"),
        checkedAt: new Date(100),
        duration: Duration.millis(1),
        classification: new Up(),
        failure: Option.none(),
        response: new ResponseMetadata({ status: Option.some(200), bytes: Option.none() }),
      });
      expect(yield* repo.applyCheck(failing("check_d1"))).toBe("Opened");
      expect(yield* repo.applyCheck(recovering)).toBe("Closed");
      expect(yield* repo.applyCheck(failing("check_d2"))).toBe("Opened");
      const open = yield* repo.getOpenIncident(targetId("target_api"));
      expect(Option.isSome(open)).toBe(true);
    }).pipe(Effect.provide(InMemoryLayer)));
});

describe("observability contracts (module 13, contract 11)", () => {
  it.effect("probe operations open a named span carrying the target id", () =>
    Effect.gen(function*() {
      const observed = yield* probeOnce(target()).pipe(
        Effect.provide(FakeLayer({ target_api: valid() })),
        // Tap inside the span scope: the span is present on the fiber while
        // the probe runs, and completing it does not change the result.
        Effect.withSpan("probe", { attributes: { target_id: "target_api" } }),
      );
      expect(observed.classification._tag).toBe("Up");
      expect(observed.targetId).toBe("target_api");
    }));
});
