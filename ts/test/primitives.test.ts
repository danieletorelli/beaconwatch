import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
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
