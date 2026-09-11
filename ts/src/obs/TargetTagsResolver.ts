import { Context, Effect, Layer, Option, Ref, Request, RequestResolver } from "effect";

import type { TargetId } from "../domain/schema.js";

export interface TargetMeta {
  readonly tags: ReadonlyArray<string>;
  readonly latestIncident: Option.Option<string>;
}

export class LoadTargetMeta extends Request.TaggedClass("LoadTargetMeta")<
  { readonly targetId: TargetId },
  TargetMeta,
  never
> {}

export interface TargetTagsBackendShape {
  readonly resolver: RequestResolver.RequestResolver<LoadTargetMeta>;
  readonly calls: Effect.Effect<number>;
  readonly requestedIds: Effect.Effect<ReadonlyArray<ReadonlyArray<TargetId>>>;
}
export class TargetTagsBackend extends Context.Service<TargetTagsBackend, TargetTagsBackendShape>()("beaconwatch/TargetTagsBackend") {}

/**
 * Metadata lookups batch by target id (module 14): concurrent lookups within
 * one batching window collapse into a single loadMany call per group, and a
 * missing key resolves to None instead of never settling (BUGS 1.1) with
 * per-id answers (BUGS 5.1).
 */
export const layer = (
  backing: ReadonlyMap<TargetId, TargetMeta>,
  loadMany: (
    ids: ReadonlyArray<TargetId>,
  ) => Effect.Effect<ReadonlyMap<TargetId, TargetMeta | undefined>> = (ids) =>
    Effect.sync(() => new Map(ids.map((id) => [id, backing.get(id)]))),
) =>
  Layer.effect(TargetTagsBackend)(
    Effect.gen(function*() {
      const counter = yield* Ref.make(0);
      const requestedIds = yield* Ref.make<ReadonlyArray<ReadonlyArray<TargetId>>>([]);
      const resolver = RequestResolver.makeGrouped<LoadTargetMeta, string>({
        key: () => "all-target-tags",
        resolver: (entries) =>
          Effect.gen(function*() {
            yield* Ref.update(counter, (n) => n + 1);
            const ids = [...new Set(entries.map((e) => e.request.targetId))];
            yield* Ref.update(
              requestedIds,
              (batches) => [...batches, ids],
            );
            const rows = yield* loadMany(ids);
            for (const entry of entries) {
              const meta = rows.get(entry.request.targetId);
              yield* Request.succeed(
                entry,
                meta === undefined
                  ? { tags: [], latestIncident: Option.none() }
                  : { ...meta, tags: [...meta.tags] },
              );
            }
          }),
      });
      return {
        resolver,
        calls: Ref.get(counter),
        requestedIds: Ref.get(requestedIds),
      };
    }),
  );

export const loadTargetMeta = (targetId: TargetId) =>
  Effect.gen(function*() {
    const backend = yield* TargetTagsBackend;
    return yield* Effect.request(
      new LoadTargetMeta({ targetId }),
      backend.resolver,
    );
  });
