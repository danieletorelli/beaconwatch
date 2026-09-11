import { Cache, Context, Effect, Exit, Layer } from "effect";

import type { TargetId } from "../domain/schema.js";
import type { TargetDigest } from "../services/DigestService.js";

/**
 * Digest cache (SPEC 7.3): repeated same-key lookups share one computation
 * (single-flight), successful digests live for one minute, failed lookups for
 * one second — the TTL policy is exit-based, so failures do not poison the
 * cache with the success TTL.
 */
export interface DigestCacheShape {
  readonly get: (
    id: TargetId,
  ) => Effect.Effect<TargetDigest, Error>;
  readonly invalidate: (id: TargetId) => Effect.Effect<void>;
}
export class DigestCache extends Context.Service<DigestCache, DigestCacheShape>()("beaconwatch/DigestCache") {}

const SUCCESS_TTL = "1 minute";
const FAILURE_TTL = "1 second";

export const layer = (
  compute: (id: TargetId) => Effect.Effect<TargetDigest, Error>,
  capacity = 128,
) =>
  Layer.effect(DigestCache)(
    Effect.gen(function*() {
      const cache = yield* Cache.makeWith(compute, {
        capacity,
        timeToLive: (exit) =>
          Exit.isSuccess(exit) ? SUCCESS_TTL : FAILURE_TTL,
      });
      return {
        get: (id) =>
          Cache.get(cache, id).pipe(
            Effect.map((digest) => ({ ...digest })),
          ),
        invalidate: (id) => Cache.invalidate(cache, id),
      };
    }),
  );
