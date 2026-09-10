import { expect, it } from "vitest"
import { Effect } from "effect"
import type { TargetId } from "../../src/domain/schema.js"
import { layer, loadTargetMeta, TargetTagsBackend } from "../../src/obs/TargetTagsResolver.js"

it("batches N target metadata requests into one backend call", async () => {
  const a = "target_a" as TargetId, b = "target_b" as TargetId
  const backing = new Map([[a, { tags: ["api"], latestIncident: undefined }], [b, { tags: ["docs"], latestIncident: "inc_1" }]])
  let bulkCalls = 0
  const result = await Effect.runPromise(Effect.gen(function*() {
    const metas = yield* Effect.all([loadTargetMeta(a), loadTargetMeta(b), loadTargetMeta(a)], { concurrency: "unbounded" })
    const svc = yield* TargetTagsBackend
    const calls = yield* svc.calls
    const requestedIds = yield* svc.requestedIds
    return { metas, calls, requestedIds }
  }).pipe(Effect.provide(layer(backing, (ids) => Effect.sync(() => {
    bulkCalls++
    return new Map(ids.map((id) => [id, backing.get(id)]))
  })))))
  expect(result.calls).toBe(1)
  expect(bulkCalls).toBe(1)
  expect(result.requestedIds).toEqual([[a, b]])
  expect(result.metas[1]?.latestIncident).toBe("inc_1")
})

it("counts each separate backend batch", async () => {
  const a = "target_a" as TargetId, b = "target_b" as TargetId
  const result = await Effect.runPromise(Effect.gen(function*() {
    yield* loadTargetMeta(a)
    yield* loadTargetMeta(b)
    const svc = yield* TargetTagsBackend
    return yield* svc.calls
  }).pipe(Effect.provide(layer(new Map()))))
  expect(result).toBe(2)
})

it("does not expose mutable backend tag storage through resolved metadata", async () => {
  const id = "target_a" as TargetId
  const result = await Effect.runPromise(Effect.gen(function*() {
    const first = yield* loadTargetMeta(id)
    Object.defineProperty(first.tags, 0, { value: "mutated" })
    return yield* loadTargetMeta(id)
  }).pipe(Effect.provide(layer(new Map([[id, { tags: ["api"], latestIncident: undefined }]])))))
  expect(result.tags).toEqual(["api"])
})
