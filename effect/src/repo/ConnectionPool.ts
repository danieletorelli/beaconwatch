import { Context, Effect, Layer, Pool, Ref, Semaphore } from "effect"
import { ConfigError } from "../domain/errors.js"

export interface ConnectionHandle {
  readonly id: number
}

export interface ConnectionPoolShape {
  readonly size: number
  readonly withConnection: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export class ConnectionPool extends Context.Service<ConnectionPool, ConnectionPoolShape>()("beaconwatch/ConnectionPool") {}
export const MAX_CONNECTION_POOL_SIZE = 1024

export interface LayerOptions {
  readonly onAcquire?: (handle: ConnectionHandle) => Effect.Effect<void>
  readonly onRelease?: (handle: ConnectionHandle) => Effect.Effect<void>
}

// COVERAGE NOTE: @effect/sql-sqlite-node's layer owns the concrete SQLite connection,
// so BeaconWatch cannot honestly manufacture driver-level SQLite connections here.
// In RC.112, Pool items remain scoped resources and `Semaphore.withPermits` brackets
// permit release. This module models
// the teaching point as a bounded pool of reusable connection handles plus a semaphore
// permit around each DB operation that uses the single driver-managed connection.
export const layer = (size: number, options: LayerOptions = {}) => Layer.effect(ConnectionPool)(Effect.gen(function*() {
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_CONNECTION_POOL_SIZE) {
    return yield* Effect.fail(new ConfigError({ reason: `connection pool size must be between 1 and ${MAX_CONNECTION_POOL_SIZE}` }))
  }
  const nextId = yield* Ref.make(0)
  const semaphore = yield* Semaphore.make(size)
  const pool = yield* Pool.make({
    size,
    acquire: Effect.acquireRelease(
      Ref.modify(nextId, (id) => [id, id + 1] as const).pipe(
        Effect.map((id) => ({ id })),
        Effect.tap((handle) => options.onAcquire?.(handle) ?? Effect.void)
      ),
      (handle) => options.onRelease?.(handle) ?? Effect.void
    )
  })

  return {
    size,
    withConnection: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      semaphore.withPermits(1)(Pool.get(pool).pipe(Effect.flatMap(() => effect))).pipe(Effect.scoped)
  }
}))

export const withConnection = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(ConnectionPool, (pool) => pool.withConnection(effect))
