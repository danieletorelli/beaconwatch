import { describe, expect, it } from "vitest"
import { Cause, Deferred, Effect, Fiber, Ref } from "effect"
import { ConfigError } from "../../src/domain/errors.js"
import * as ConnectionPool from "../../src/repo/ConnectionPool.js"

describe("ConnectionPool", () => {
  it("bounds concurrent operations with permits", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const limit = 2
      const current = yield* Ref.make(0)
      const peak = yield* Ref.make(0)
      const entered = yield* Ref.make(0)
      const firstBatchEntered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()

      const operation = ConnectionPool.withConnection(Effect.gen(function*() {
        const inFlight = yield* Ref.updateAndGet(current, (n) => n + 1)
        yield* Ref.update(peak, (n) => Math.max(n, inFlight))
        const enteredCount = yield* Ref.updateAndGet(entered, (n) => n + 1)
        if (enteredCount === limit) {
          yield* Deferred.succeed(firstBatchEntered, undefined)
        }
        yield* Deferred.await(release)
        yield* Ref.update(current, (n) => n - 1)
      }))

      const fiber = yield* Effect.all(Array.from({ length: 6 }, () => operation), { concurrency: "unbounded", discard: true }).pipe(Effect.forkScoped)
      yield* Deferred.await(firstBatchEntered)
      const peakWhileBlocked = yield* Ref.get(peak)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(fiber)
      const finalPeak = yield* Ref.get(peak)
      return { peakWhileBlocked, finalPeak }
    }).pipe(Effect.provide(ConnectionPool.layer(2)), Effect.scoped)))

    expect(result.peakWhileBlocked).toBe(2)
    expect(result.finalPeak).toBe(2)
  })

  it("releases pooled resources when the layer scope exits", async () => {
    const result = await Effect.runPromise(Effect.gen(function*() {
      const acquired = yield* Ref.make(0)
      const released = yield* Ref.make(0)
      yield* Effect.scoped(Effect.gen(function*() {
        yield* ConnectionPool.withConnection(Effect.void)
        yield* ConnectionPool.withConnection(Effect.void)
        return yield* Ref.get(acquired)
      }).pipe(Effect.provide(ConnectionPool.layer(2, {
        onAcquire: () => Ref.update(acquired, (n) => n + 1),
        onRelease: () => Ref.update(released, (n) => n + 1)
      }))))
      return { acquired: yield* Ref.get(acquired), released: yield* Ref.get(released) }
    }))

    expect(result.acquired).toBe(2)
    expect(result.released).toBe(2)
  })

  it("rejects a zero-sized pool instead of blocking every operation", async () => {
    const exit = await Effect.runPromise(Effect.scoped(
      ConnectionPool.withConnection(Effect.void).pipe(
        Effect.provide(ConnectionPool.layer(0)),
        Effect.timeoutOption("50 millis"),
        Effect.exit
      )
    ))

    expect(exit._tag).toBe("Failure")
    if (exit._tag !== "Failure") throw new Error("expected invalid pool size to fail")
    const reason = exit.cause.reasons.find(Cause.isFailReason)
    expect(reason?.error).toBeInstanceOf(ConfigError)
  })

  it("exports and enforces the pool maximum before allocation", async () => {
    const exit = await Effect.runPromise(Effect.scoped(ConnectionPool.withConnection(Effect.void).pipe(
      Effect.provide(ConnectionPool.layer(ConnectionPool.MAX_CONNECTION_POOL_SIZE + 1)), Effect.exit
    )))
    expect(exit._tag).toBe("Failure")
  })
})
