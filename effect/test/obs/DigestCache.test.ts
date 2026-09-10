import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Duration, Effect, Fiber, Ref } from "effect"
import { TestClock } from "effect/testing"
import { DigestCache, makeLayer } from "../../src/obs/DigestCache.js"
import type { TargetId } from "../../src/domain/schema.js"

describe("DigestCache", () => {
it.effect("single-flights concurrent gets and expires by TTL", () => Effect.scoped(Effect.gen(function*() {
  const id = "target_api" as TargetId
  const calls = yield* Ref.make(0)
  const layer = makeLayer((targetId: TargetId) => Ref.updateAndGet(calls, (n) => n + 1).pipe(
    Effect.delay("10 millis"),
    Effect.map((n) => ({ targetId, currentStatus: "Up", p95LatencyMillis: n, uptimePercent: 100, checks: 1 }))
  ), Duration.seconds(1))
  return yield* Effect.gen(function*() {
    const svc = yield* DigestCache
    const fiber = yield* Effect.all([svc.get(id), svc.get(id), svc.get(id)], { concurrency: 3 }).pipe(Effect.forkScoped)
    yield* Effect.yieldNow
    yield* TestClock.adjust("10 millis")
    yield* Fiber.join(fiber)
    const c1 = yield* Ref.get(calls)
    yield* TestClock.adjust("1100 millis")
    const afterTtl = yield* svc.get(id).pipe(Effect.forkScoped)
    yield* Effect.yieldNow
    yield* TestClock.adjust("10 millis")
    yield* Fiber.join(afterTtl)
    const c2 = yield* Ref.get(calls)
    return { c1, c2 }
  }).pipe(Effect.provide(layer), Effect.scoped)
})).pipe(Effect.map((result) => {
  expect(result.c1).toBe(1)
  expect(result.c2).toBe(2)
})))

it.effect("does not expose cached digest state to callers", () => Effect.gen(function*() {
  const id = "target_api" as TargetId
  const layer = makeLayer((targetId) => Effect.succeed({
    targetId,
    currentStatus: "Up",
    p95LatencyMillis: 10,
    uptimePercent: 100,
    checks: 1
  }))
  const result = yield* Effect.gen(function*() {
    const cache = yield* DigestCache
    const first = yield* cache.get(id)
    Object.defineProperty(first, "currentStatus", { value: "Down" })
    return yield* cache.get(id)
  }).pipe(Effect.provide(layer))
  expect(result.currentStatus).toBe("Up")
}))

it.effect("expires failures before successful values", () => Effect.gen(function*() {
  const id = "target_api" as TargetId
  const calls = yield* Ref.make(0)
  const layer = makeLayer((targetId) => Ref.updateAndGet(calls, (n) => n + 1).pipe(
    Effect.flatMap((n) => n === 1
      ? Effect.fail(new Error("backend unavailable"))
      : Effect.succeed({ targetId, currentStatus: "Up", p95LatencyMillis: n, uptimePercent: 100, checks: 1 }))
  ), "1 minute", "1 second")
  const result = yield* Effect.gen(function*() {
    const cache = yield* DigestCache
    yield* cache.get(id).pipe(Effect.exit)
    yield* TestClock.adjust("1100 millis")
    const recovered = yield* cache.get(id)
    return { recovered, calls: yield* Ref.get(calls) }
  }).pipe(Effect.provide(layer))
  expect(result.recovered.currentStatus).toBe("Up")
  expect(result.calls).toBe(2)
}))
})
