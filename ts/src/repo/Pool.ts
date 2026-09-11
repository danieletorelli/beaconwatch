import { Effect, Pool as PoolModule } from "effect";
import { ConfigError } from "../domain/errors.js";

export const MIN_POOL_SIZE = 1;
export const MAX_POOL_SIZE = 1024;

/**
 * Bounded connection pool (module 10): validates its size at construction —
 * a zero-sized pool is rejected instead of blocking every operation — and
 * bounds concurrent check persistence to the configured maximum. Pooled
 * resources are released when the owning scope exits.
 */
export const validateSize = (size: number, max: number = MAX_POOL_SIZE) => {
  if (!Number.isSafeInteger(size) || size < MIN_POOL_SIZE || size > max)
    return new ConfigError({
      reason: `pool size must be a safe integer from ${MIN_POOL_SIZE} through ${max}`,
    });
  return undefined;
};

export const layer = (options: {
  readonly size: number;
  readonly acquire: Effect.Effect<unknown, Error>;
  readonly release?: (resource: unknown) => Effect.Effect<void>;
}) =>
  Effect.gen(function*() {
    const invalid = validateSize(options.size);
    if (invalid) return yield* Effect.fail(invalid);
    const pool = yield* PoolModule.makeWithTTL({
      acquire: options.acquire,
      min: options.size,
      max: options.size,
      timeToLive: "60 seconds",
      timeToLiveStrategy: "creation",
    });
    const withConnection = <A, E, R>(
      work: (resource: unknown) => Effect.Effect<A, E, R>,
    ) =>
      Effect.scoped(
        Effect.flatMap(PoolModule.get(pool), (resource) => work(resource)),
      );
    return {
      withConnection,
      get size() {
        return options.size;
      },
      invalidate: (item: unknown) => PoolModule.invalidate(item)(pool),
    };
  });
