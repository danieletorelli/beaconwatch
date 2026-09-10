import { it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"
import { targetId } from "../../src/domain/schema.js"
import * as CacheModule from "../../src/obs/DigestCache.js"

const id = targetId("target_api")
const digest = { targetId: id, currentStatus: "Up", p95LatencyMillis: 10, uptimePercent: 100, checks: 1 }
const cacheApi = CacheModule as any
const run = (compute: any, body: (cache: any) => any) => Effect.gen(function*() { return yield* body(yield* cacheApi.DigestCache) }).pipe(Effect.provide(cacheApi.makeLayer(compute))) as any

it.effect("keys, expires, invalidates, single-flights, and protects cached digests", () => Effect.gen(function*() {
  expect(cacheApi.makeLayer, "provide the scoped Effect cache service").toBeDefined()
  let calls = 0
  yield* run(() => Effect.sync(() => (++calls, digest)), (cache: any) => Effect.all([cache.get(id), cache.get(targetId("target_api"))], { concurrency: 2 }))
  expect(calls).toBe(1)

  calls = 0
  const recovered = yield* run(() => Effect.suspend(() => ++calls === 1 ? Effect.fail(new Error("down")) : Effect.succeed(digest)), (cache: any) => Effect.gen(function*() {
    const first = yield* cache.get(id).pipe(Effect.flip)
    const replay = yield* cache.get(id).pipe(Effect.flip)
    yield* TestClock.adjust("999 millis")
    const replayJustBeforeExpiry = yield* cache.get(id).pipe(Effect.flip)
    const callsJustBeforeExpiry = calls
    yield* TestClock.adjust("2 millis")
    const value = yield* cache.get(id)
    return { first, replay, replayJustBeforeExpiry, callsJustBeforeExpiry, value }
  }))
  expect(recovered.first).toBeInstanceOf(Error)
  expect(recovered.replay).toBe(recovered.first)
  expect(recovered.replayJustBeforeExpiry).toBe(recovered.first)
  expect(recovered.callsJustBeforeExpiry).toBe(1)
  expect(recovered.value.currentStatus).toBe("Up")
  expect(calls).toBe(2)

  calls = 0
  yield* run(() => Effect.sync(() => (++calls, digest)), (cache: any) => Effect.gen(function*() {
    yield* cache.get(id)
    yield* TestClock.adjust("59999 millis")
    yield* cache.get(id)
    expect(calls).toBe(1)
    yield* TestClock.adjust("2 millis")
    yield* cache.get(id)
  }))
  expect(calls).toBe(2)

  calls = 0
  yield* run(() => Effect.sync(() => (++calls, digest)), (cache: any) => Effect.gen(function*() { yield* cache.get(id); yield* cache.invalidate(id); yield* cache.get(id) }))
  expect(calls).toBe(2)

  calls = 0
  const concurrent = yield* run(() => Effect.gen(function*() { calls++; yield* Effect.sleep("1 millis"); return digest }), (cache: any) => Effect.all([cache.get(id), cache.get(id)], { concurrency: 2 }).pipe(Effect.forkChild))
  yield* Effect.yieldNow
  yield* TestClock.adjust("1 millis")
  yield* Fiber.join(concurrent)
  expect(calls).toBe(1)

  const immutable = yield* run(() => Effect.succeed(digest), (cache: any) => Effect.gen(function*() {
    const first = yield* cache.get(id)
    Object.defineProperty(first, "currentStatus", { value: "Down" })
    return yield* cache.get(id)
  }))
  expect(immutable.currentStatus).toBe("Up")
}) as any)
