import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Metric, Option } from "effect";
import { TestClock } from "effect/testing";
import { CheckFailure, CheckResult, ResponseMetadata, Target, Up, targetId, type CheckId } from "../src/domain/schema.js";
import { activeProbeGauge, recordCheckMetricsEffect } from "../src/obs/Telemetry.js";
import { CheckRepository } from "../src/repo/CheckRepository.js";
const references = () => ({ activeProbeGauge });
import { DigestCache, layer as digestCacheLayer } from "../src/obs/DigestCache.js";
import { BulletinBus, WorkerBroadcast } from "../src/watch/Scheduler.js";
import type { TargetDigest } from "../src/services/DigestService.js";

describe("digest cache (SPEC 7.3, module 14)", () => {
  const digest = (n: number): TargetDigest => ({
    targetId: `target_${n}` as never,
    currentStatus: "Up",
    p95LatencyMillis: n,
    uptimePercent: 100,
    checks: 1,
  });

  it.effect("concurrent cold gets share one computation", () =>
    Effect.gen(function*() {
      let calls = 0;
      const cache = yield* DigestCache.pipe(
        Effect.provide(digestCacheLayer((id) =>
          Effect.gen(function*() {
            calls++;
            return digest(Number(String(id).slice(-1)));
          }),
        )),
      );
      const results = yield* Effect.all(
        [cache.get("target_1" as never), cache.get("target_1" as never), cache.get("target_1" as never)],
        { concurrency: "unbounded" },
      );
      expect(results).toHaveLength(3);
      expect(calls).toBe(1);
      expect(results[0]!.p95LatencyMillis).toBe(1);
    }));

  it.effect("invalidate forces a fresh computation", () =>
    Effect.gen(function*() {
      let calls = 0;
      const cache = yield* DigestCache.pipe(
        Effect.provide(digestCacheLayer(() => Effect.succeed(digest(++calls)))),
      );
      yield* cache.get("target_x" as never);
      yield* cache.invalidate("target_x" as never);
      yield* cache.get("target_x" as never);
      expect(calls).toBe(2);
    }));
});

describe("coordination primitives (modules 08, 09)", () => {
  it.effect("BulletinBus delivers to scoped subscribers", () =>
    Effect.gen(function*() {
      const bus = yield* BulletinBus.make<string>();
      const received: string[] = [];
      const fiber = yield* Effect.forkScoped(bus.subscribe((value) => received.push(value)));
      yield* Effect.yieldNow;
      yield* bus.publish("a");
      yield* bus.publish("b");
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber); // subscription dies with the fiber
      yield* bus.publish("after");
      expect(received).toEqual(["a", "b"]);
    }));

  it.live("WorkerBroadcast delivers each value to one worker", () =>
    Effect.gen(function*() {
      const broadcast = yield* WorkerBroadcast.make<string>();
      const handled: string[] = [];
      const fiber = yield* Effect.forkScoped(broadcast.addWorker((value) => handled.push(value)));
      yield* broadcast.offer("x");
      yield* broadcast.offer("y");
      yield* Effect.sleep(50);
      yield* Fiber.interrupt(fiber);
      expect(handled).toEqual(["x", "y"]);
    }));

});

describe("digest cache TTL policy (SPEC 7.3)", () => {
  it.effect("failed lookups expire before successful ones", () =>
    Effect.gen(function*() {
      let calls = 0;
      let fail = true;
      const cache = yield* DigestCache.pipe(
        Effect.provide(digestCacheLayer(() =>
          Effect.suspend(() =>
            calls++ === 0 && fail
              ? Effect.fail(new Error("digest failed once"))
              : Effect.succeed({ targetId: "target_ttl" as never, currentStatus: "Up", p95LatencyMillis: 1, uptimePercent: 100, checks: 1 } satisfies import("../src/services/DigestService.js").TargetDigest),
          ),
        )),
      );
      const first = yield* Effect.exit(cache.get("target_ttl" as never));
      expect(first._tag).toBe("Failure");
      // The failure TTL is one second: past it the lookup recomputes.
      yield* TestClock.adjust(1200);
      const second = yield* Effect.exit(cache.get("target_ttl" as never));
      expect(second._tag).toBe("Success");
      void fail;
    }));

  it.effect("the active gauge returns to baseline when the pipeline is interrupted", () =>
    Effect.gen(function*() {
      const { activeProbeGauge } = references();
      const before = (yield* Metric.value(activeProbeGauge)).value;
      const fiber = yield* Effect.forkScoped(
        recordCheckMetricsEffect(new CheckResult({
          id: "check_i" as CheckId,
          targetId: targetId("target_api"),
          checkedAt: new Date(0),
          duration: Duration.millis(1),
          classification: new Up(),
          failure: Option.none(),
          response: new ResponseMetadata({ status: Option.some(200), bytes: Option.none() }),
        })).pipe(
          Effect.andThen(Effect.sleep(50)),
          Effect.andThen(Effect.interrupt),
        ),
      );
      yield* Fiber.interrupt(fiber);
      const after = (yield* Metric.value(activeProbeGauge)).value;
      expect(after).toBe(before);
    }));
});

describe("runtime memoization (module 15)", () => {
  it("the shared runtime keeps one service instance across runs", async () => {
    const { runtime } = await import("../src/runtime/ManagedRuntime.js");
    const saved = await runtime.runPromise(
      Effect.gen(function*() {
        const repo = yield* CheckRepository;
        yield* repo.saveTarget(new Target({
          id: targetId("target_memo"),
          name: "M",
          url: "http://example.test",
          method: "GET",
          expectedStatus: [200] as [number, ...number[]],
          interval: Duration.millis(10),
          timeout: Duration.millis(50),
          slowThreshold: Duration.millis(100),
          enabled: true,
        }));
        return "saved";
      }),
    );
    expect(saved).toBe("saved");
    const count = await runtime.runPromise(
      Effect.gen(function*() {
        const repo = yield* CheckRepository;
        return (yield* repo.listTargets()).length;
      }),
    );
    // A per-run runtime would lose the saved target; the memoized one keeps it.
    expect(count).toBe(1);
  });
});
