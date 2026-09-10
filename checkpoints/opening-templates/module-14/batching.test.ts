import { expect, it } from "vitest"
import { Effect } from "effect"
import { targetId } from "../../src/domain/schema.js"
import * as TagsModule from "../../src/obs/TargetTagsResolver.js"

it("batches metadata while preserving misses, order, duplicates, and storage ownership", async () => {
  const { layer, loadTargetMeta, TargetTagsBackend } = TagsModule as any
  expect(layer, "provide the batched Effect request resolver").toBeDefined()
  const a = targetId("target_a"), b = targetId("target_b"), missing = targetId("target_missing")
  const backing = new Map([[a, { tags: ["api"], latestIncident: undefined }], [b, { tags: ["docs"], latestIncident: "incident_docs" }]])
  const bulkInputs: ReadonlyArray<string>[] = []
  const result: any = await Effect.runPromise(Effect.gen(function*() {
    const values = yield* Effect.all([loadTargetMeta(b), loadTargetMeta(a), loadTargetMeta(missing), loadTargetMeta(a)] as any, { batching: true, concurrency: "unbounded" })
    const backend = yield* TargetTagsBackend
    return { values, calls: yield* backend.calls, requestedIds: yield* backend.requestedIds }
  }).pipe(Effect.provide(layer(backing, (ids: ReadonlyArray<string>) => Effect.sync(() => {
    bulkInputs.push([...ids])
    return new Map(ids.map(id => [id, backing.get(id as any)]))
  })))) as any)
  expect(result.calls).toBe(1)
  expect(bulkInputs).toEqual([[b, a, missing]])
  expect(result.requestedIds).toEqual([[b, a, missing]])
  expect(result.values).toEqual([
    { tags: ["docs"], latestIncident: "incident_docs" },
    { tags: ["api"], latestIncident: undefined },
    { tags: [], latestIncident: undefined },
    { tags: ["api"], latestIncident: undefined },
  ])
  Object.defineProperty(result.values[1]!.tags, 0, { value: "mutated" })
  const fresh: any = await Effect.runPromise(loadTargetMeta(a).pipe(Effect.provide(layer(backing))) as any)
  expect(fresh.tags).toEqual(["api"])
})
