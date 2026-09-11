import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Layer, Option, Result } from "effect";
import { TestClock } from "effect/testing";
import { Target, targetId } from "../src/domain/schema.js";
import { InvalidBody } from "../src/domain/errors.js";
import { CheckRepository, InMemoryCheckRepository } from "../src/repo/CheckRepository.js";
import { FakeProbeClient, ProbeClient, valid } from "../src/services/ProbeClient.js";
import { StatusStateLayer } from "../src/watch/StatusState.js";
import { runOnceEffect, watchLoopEffect } from "../src/watch/Scheduler.js";

const target = (overrides: Partial<ConstructorParameters<typeof Target>[0]> = {}) =>
  new Target({
    id: "target_api",
    name: "API",
    url: "http://example.test",
    method: "GET",
    expectedStatus: [200],
    interval: "10 ms",
    timeout: "50 ms",
    slowThreshold: "100 ms",
    enabled: true,
    ...overrides,
  });

const wired = (
  repo: InMemoryCheckRepository,
  scripts: ConstructorParameters<typeof FakeProbeClient>[0],
) =>
  Layer.mergeAll(
    StatusStateLayer,
    Layer.succeed(CheckRepository)(repo),
    Layer.succeed(ProbeClient)(new FakeProbeClient(scripts)),
  );

describe("scheduler", () => {
  it.effect("rejects invalid options in the typed error channel", () =>
    Effect.gen(function*() {
      const outcome = yield* Effect.result(
        runOnceEffect([], { queueCapacity: 0, workerCount: 2 }).pipe(
          Effect.provide(wired(new InMemoryCheckRepository(), {})),
        ),
      );
      expect(Result.isFailure(outcome)).toBe(true);
      if (Result.isFailure(outcome)) expect(String(outcome.failure)).toContain("ConfigError");
      const tooManyWorkers = yield* Effect.result(
        runOnceEffect([], { queueCapacity: 10, workerCount: 2000 }).pipe(
          Effect.provide(wired(new InMemoryCheckRepository(), {})),
        ),
      );
      expect(Result.isFailure(tooManyWorkers)).toBe(true);
    }));

  it.effect("runs each enabled target once and publishes status", () =>
    Effect.gen(function*() {
      const repo = new InMemoryCheckRepository();
      yield* runOnceEffect(
        [target(), target({ enabled: false, id: "target_off" })],
        { queueCapacity: 8, workerCount: 2 },
      ).pipe(Effect.provide(wired(repo, { target_api: valid() })));
      const checks = yield* Effect.tryPromise(() => repo.listChecks());
      expect(checks).toHaveLength(1);
      const open = yield* Effect.tryPromise(() => repo.getOpenIncident(targetId("target_api")));
      expect(Option.isNone(open)).toBe(true); // healthy check closes/never opens
    }));

  it.effect("a worker defect fails the run promptly", () =>
    Effect.gen(function*() {
      const repo = new InMemoryCheckRepository();
      const exit = yield* Effect.exit(
        runOnceEffect([target()], { queueCapacity: 8, workerCount: 1 }).pipe(
          Effect.provide(
            Layer.mergeAll(
              StatusStateLayer,
              Layer.succeed(CheckRepository)(repo),
              Layer.succeed(ProbeClient)({
                probe: () => Effect.die(new Error("boom")),
              }),
            ),
          ),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }));

  it.effect("watchLoop repeats each target at its own interval", () =>
    Effect.gen(function*() {
      const repo = new InMemoryCheckRepository();
      const loop = watchLoopEffect([target({ interval: "50 ms" })], {
        queueCapacity: 8,
        workerCount: 1,
      }).pipe(Effect.provide(wired(repo, { target_api: valid() })));
      const fiber = yield* Effect.forkScoped(loop);
      yield* TestClock.adjust(200);
      yield* Fiber.interrupt(fiber);
      const checks = yield* Effect.tryPromise(() => repo.listChecks());
      expect(checks.length).toBeGreaterThanOrEqual(2);
    }));
});
