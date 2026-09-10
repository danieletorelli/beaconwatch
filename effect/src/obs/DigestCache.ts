import { Cache, Context, Duration, Effect, Exit, Layer } from "effect"
import type { TargetId } from "../domain/schema.js"
import type { TargetDigest } from "../services/DigestService.js"

export interface DigestCacheShape { readonly get: (id: TargetId) => Effect.Effect<TargetDigest, Error>; readonly invalidate: (id: TargetId) => Effect.Effect<void> }
export class DigestCache extends Context.Service<DigestCache, DigestCacheShape>()("beaconwatch/DigestCache") {}
export const makeLayer = (compute: (id: TargetId) => Effect.Effect<TargetDigest, Error>, ttl: Duration.Input = "1 minute", failureTtl: Duration.Input = "1 second") => Layer.effect(DigestCache)(Effect.gen(function*() {
  const cache = yield* Cache.makeWith(compute, { capacity: 128, timeToLive: (exit) => Exit.isSuccess(exit) ? ttl : failureTtl })
  return { get: (id) => Cache.get(cache, id).pipe(Effect.map((digest) => ({ ...digest }))), invalidate: (id) => Cache.invalidate(cache, id) }
}))
