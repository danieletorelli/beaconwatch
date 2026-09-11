import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Exit, Fiber, Layer, Metric, Option, Result } from "effect";
import { TestClock } from "effect/testing";
import { Target, CheckResult, Down, ResponseMetadata, Up, targetId, type CheckId, type TargetId } from "../src/domain/schema.js";
import { InvalidBody } from "../src/domain/errors.js";
import {
  activeProbeGauge,
  probeLatencyMetric,
  recordCheckMetricsEffect,
  targetUpDownMetric,
} from "../src/obs/Telemetry.js";
import { fiberLocalMinimumLogLevelDemo } from "../src/obs/references.js";
import { CheckRepository, InMemoryLayer } from "../src/repo/CheckRepository.js";
import { FakeProbeClient, ProbeClient, valid } from "../src/services/ProbeClient.js";
import { StatusStateLayer } from "../src/watch/StatusState.js";
import { runOnceEffect, watchLoopEffect } from "../src/watch/Scheduler.js";

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

const checkLike = (tag: "Up" | "Down") =>
  new CheckResult({
    id: "check_t" as CheckId,
    targetId: targetId("target_api") as TargetId,
    checkedAt: new Date(0),
    duration: Duration.millis(7),
    classification: tag === "Up" ? new Up() : new Down(),
    failure: Option.none(),
    response: new ResponseMetadata({ status: Option.some(200), bytes: Option.none() }),
  });

const wired = (scripts: ConstructorParameters<typeof FakeProbeClient>[0]) =>
  Layer.mergeAll(
    StatusStateLayer,
    InMemoryLayer,
    Layer.succeed(ProbeClient)(new FakeProbeClient(scripts)),
  );

describe("scheduler", () => {
  it.effect("rejects invalid options in the typed error channel", () =>
    Effect.gen(function*() {
      const outcome = yield* Effect.result(
        runOnceEffect([], { queueCapacity: 0, workerCount: 2 }).pipe(
          Effect.provide(wired({})),
        ),
      );
      expect(Result.isFailure(outcome)).toBe(true);
      if (Result.isFailure(outcome)) expect(String(outcome.failure)).toContain("ConfigError");
      const tooManyWorkers = yield* Effect.result(
        runOnceEffect([], { queueCapacity: 10, workerCount: 2000 }).pipe(
          Effect.provide(wired({})),
        ),
      );
      expect(Result.isFailure(tooManyWorkers)).toBe(true);
    }));

  it.effect("runs each enabled target once and publishes status", () =>
    Effect.gen(function*() {
      yield* Effect.gen(function*() {
        const repo = yield* CheckRepository;
        yield* runOnceEffect(
          [target(), target({ enabled: false, id: "target_off" as TargetId })],
          { queueCapacity: 8, workerCount: 2 },
        );
        const checks = yield* repo.listChecks();
        expect(checks).toHaveLength(1);
        const open = yield* repo.getOpenIncident(targetId("target_api"));
        expect(Option.isNone(open)).toBe(true); // healthy check closes/never opens
      }).pipe(Effect.provide(wired({ target_api: valid() })));
    }));

  it.effect("a worker defect fails the run promptly", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(
        runOnceEffect([target()], { queueCapacity: 8, workerCount: 1 }).pipe(
          Effect.provide(
            Layer.mergeAll(
              StatusStateLayer,
              InMemoryLayer,
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
      let checks: readonly unknown[] = [];
      const loop = Effect.gen(function*() {
        const repo = yield* CheckRepository;
        const fiber = yield* Effect.forkScoped(
          watchLoopEffect([target({ interval: Duration.millis(50) })], {
            queueCapacity: 8,
            workerCount: 1,
          }),
        );
        yield* TestClock.adjust(200);
        yield* Fiber.interrupt(fiber);
        checks = yield* repo.listChecks();
      }).pipe(Effect.provide(wired({ target_api: valid() })));
      yield* loop;
      expect(checks.length).toBeGreaterThanOrEqual(2);
    }));
});

describe("telemetry (BUGS 18.3, contract section 11)", () => {
  it.effect("the active gauge returns to baseline when the check fails", () =>
    Effect.gen(function*() {
      const before = yield* Metric.value(activeProbeGauge);
      const baseline = before.value;
      const outcome = yield* Effect.exit(
        recordCheckMetricsEffect(checkLike("Up")).pipe(
          Effect.andThen(Effect.fail(new InvalidBody({ reason: "simulated" }))),
        ),
      );
      expect(Exit.isFailure(outcome)).toBe(true);
      const after = yield* Metric.value(activeProbeGauge);
      expect(after.value).toBe(baseline);
    }));

  it.effect("records latency and state per the contract", () =>
    Effect.gen(function*() {
      const upBefore = (yield* Metric.value(targetUpDownMetric)).count;
      const check = checkLike("Up");
      yield* recordCheckMetricsEffect(check);
      const upAfter = (yield* Metric.value(targetUpDownMetric)).count;
      expect(upAfter - upBefore).toBe(1);
      const histogram = yield* Metric.value(probeLatencyMetric);
      expect(histogram.count).toBeGreaterThanOrEqual(1);
      // A failed classification adds 0 to the state counter.
      const downBefore = (yield* Metric.value(targetUpDownMetric)).count;
      yield* recordCheckMetricsEffect(checkLike("Down"));
      const downAfter = (yield* Metric.value(targetUpDownMetric)).count;
      expect(downAfter - downBefore).toBe(0);
    }));
});

describe("log level reference (module 13)", () => {
  it.effect("the minimum log level override is local to the effect", () =>
    Effect.gen(function*() {
      const demo = yield* fiberLocalMinimumLogLevelDemo;
      expect(demo.inside).toBe("Debug");
      expect(demo.after).toBe(demo.before);
    }));
});

describe("scheduler edge cases (contract 5)", () => {
  it.effect("rejects a zero worker count before allocating resources", () =>
    Effect.gen(function*() {
      const outcome = yield* Effect.result(
        runOnceEffect([], { queueCapacity: 10, workerCount: 0 }).pipe(
          Effect.provide(wired({})),
        ),
      );
      expect(Result.isFailure(outcome)).toBe(true);
      if (Result.isFailure(outcome)) expect(String((outcome.failure as { reason?: string }).reason)).toContain("workerCount");
    }));

  it.effect("completes without probing when every target is disabled", () =>
    Effect.gen(function*() {
      const checks = yield* Effect.gen(function*() {
        const repo = yield* CheckRepository;
        yield* runOnceEffect(
          [target({ enabled: false, id: "target_off" as TargetId })],
          { queueCapacity: 8, workerCount: 1 },
        );
        return repo.listChecks();
      }).pipe(Effect.provide(wired({})));
      expect((yield* checks)).toHaveLength(0);
    }));

  it.effect("skips a disabled target without abandoning later enabled ones", () =>
    Effect.gen(function*() {
      const checks = yield* Effect.gen(function*() {
        const repo = yield* CheckRepository;
        yield* runOnceEffect(
          [
            target({ enabled: false, id: "target_off" as TargetId }),
            target({ id: "target_on" as TargetId }),
          ],
          { queueCapacity: 8, workerCount: 2 },
        );
        return repo.listChecks();
      }).pipe(Effect.provide(wired({ target_on: valid() })));
      const rows = yield* checks;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.targetId).toBe("target_on");
    }));
});

describe("scheduler concurrency contracts (contract 5)", () => {
  it.effect("post-transition snapshots stay consistent under same-target concurrency", () =>
    Effect.gen(function*() {
      const repo = yield* CheckRepository;
      yield* Effect.all(
        [
          runOnceEffect([target({ interval: Duration.millis(10) })], { queueCapacity: 8, workerCount: 1 }),
          runOnceEffect([target({ interval: Duration.millis(10) })], { queueCapacity: 8, workerCount: 1 }),
        ],
        { concurrency: "unbounded", discard: true },
      );
      const open = yield* repo.getOpenIncident(targetId("target_api"));
      // Two healthy runs leave no incident open and no torn state behind.
      expect(Option.isNone(open)).toBe(true);
      const checks = yield* repo.listChecks();
      expect(checks.length).toBeGreaterThanOrEqual(2);
    }).pipe(Effect.provide(wired({ target_api: valid() }))));

  it.effect("a run with only failing workers fails promptly", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(
        runOnceEffect([target(), target({ id: "target_b" as TargetId })], {
          queueCapacity: 1,
          workerCount: 1,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              StatusStateLayer,
              InMemoryLayer,
              Layer.succeed(ProbeClient)({
                probe: () => Effect.die(new Error("all workers die")),
              }),
            ),
          ),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }));
});
