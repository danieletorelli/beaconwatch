import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Option, Result } from "effect";
import { TestClock } from "effect/testing";
import { CheckResult, ResponseMetadata, Target, Up, targetId } from "../src/domain/schema.js";
import { ReadinessEffect, StatusState, StatusStateLayer } from "../src/watch/StatusState.js";

const check = (id: string, at: number, target = "target_api") =>
  new CheckResult({
    id,
    targetId: targetId(target),
    checkedAt: new Date(at),
    duration: "1 ms",
    classification: new Up(),
    response: new ResponseMetadata({ status: 200 }),
  });

const program = Effect.gen(function*() {
  const status = yield* StatusState;
  return status;
}).pipe(Effect.provide(StatusStateLayer));

describe("status state", () => {
  it.effect("older checks never replace a newer entry", () =>
    Effect.gen(function*() {
      const status = yield* program;
      yield* status.update(check("check_b", 200));
      yield* status.update(check("check_a", 100)); // older
      const entry = yield* status.get(targetId("target_api"));
      expect(Option.getOrThrow(entry).latest.id).toBe("check_b");
    }));

  it.effect("equal timestamps resolve by greatest check id", () =>
    Effect.gen(function*() {
      const status = yield* program;
      yield* status.update(check("check_a", 100));
      yield* status.update(check("check_b", 100));
      const entry = yield* status.get(targetId("target_api"));
      expect(Option.getOrThrow(entry).latest.id).toBe("check_b");
    }));

  it.effect("get and snapshot return isolated copies", () =>
    Effect.gen(function*() {
      const status = yield* program;
      yield* status.update(check("check_a", 100));
      const entry = yield* status.get(targetId("target_api"));
      const snapshot = yield* status.snapshot;
      expect(snapshot.size).toBe(1);
      expect(Option.isSome(entry)).toBe(true);
      // Mutating a returned snapshot cannot affect retained state.
      snapshot.delete(targetId("target_api"));
      expect((yield* status.snapshot).size).toBe(1);
    }));

  it.effect("absent targets resolve to None", () =>
    Effect.gen(function*() {
      const status = yield* program;
      expect(Option.isNone(yield* status.get(targetId("target_none")))).toBe(true);
    }));
});

describe("readiness (BUGS 2.8)", () => {
  it.effect("wait blocks until completion settles the Deferred", () =>
    Effect.gen(function*() {
      const ready = yield* ReadinessEffect.create;
      const fiber = yield* Effect.forkScoped(ready.wait);
      yield* TestClock.adjust(100); // still waiting
      yield* ready.complete("ok");
      expect(yield* Fiber.join(fiber)).toBe("ok");
    }));

  it.effect("fail settles the wait with a typed error", () =>
    Effect.gen(function*() {
      const ready = yield* ReadinessEffect.create;
      yield* ready.fail("boom");
      const outcome = yield* Effect.result(ready.wait);
      expect(Result.isFailure(outcome)).toBe(true);
      if (Result.isFailure(outcome)) expect(outcome.failure).toBe("boom");
    }));
});
