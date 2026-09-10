import { expect, it } from "vitest"
import { Effect } from "effect"
import { targetId } from "../../../src/domain/schema.js"
import { DigestCache, makeLayer } from "../../../src/obs/DigestCache.js"
import { layer, loadTargetMeta, TargetTagsBackend } from "../../../src/obs/TargetTagsResolver.js"
const id = targetId("target_dp"), digest: any = { targetId: id, checks: 1, currentStatus: "Up", p95LatencyMillis: 1, uptimePercent: 100 }
const cacheProgram = (compute: any, body: any, success: any = "1 minute", failure: any = "1 second") => Effect.gen(function*() { const service = yield* DigestCache; return yield* body(service) }).pipe(Effect.provide(makeLayer(compute, success, failure)))
it("DP-59", async () => { let n = 0; await Effect.runPromise(cacheProgram(() => Effect.sync(() => (++n, digest)), (c: any) => Effect.all([c.get(id), c.get(targetId("target_dp"))]))); expect(n).toBe(1) })
it("DP-60", async () => { let n = 0, beforeExpiry = 0; const exit = await Effect.runPromise(cacheProgram(() => Effect.suspend(() => ++n === 1 ? Effect.fail(new Error("down")) : Effect.succeed(digest)), (c: any) => Effect.gen(function*() { yield* c.get(id).pipe(Effect.exit); yield* c.get(id).pipe(Effect.exit); beforeExpiry = n; yield* Effect.sleep("2 seconds"); return yield* c.get(id) }), "1 minute", "1 second").pipe(Effect.exit)); expect(exit._tag).toBe("Success"); expect(beforeExpiry).toBe(1); expect(n).toBe(2) })
it("DP-61", async () => { let n = 0; await Effect.runPromise(cacheProgram(() => Effect.sync(() => (++n, digest)), (c: any) => Effect.gen(function*() { yield* c.get(id); yield* c.invalidate(id); yield* c.get(id) }))); expect(n).toBe(2) })
it("DP-62", async () => { let n = 0; await Effect.runPromise(cacheProgram(() => Effect.gen(function*() { n++; yield* Effect.sleep("1 millis"); return digest }), (c: any) => Effect.all([c.get(id), c.get(id)], { concurrency: 2 }))); expect(n).toBe(1) })
const batch = async (ids: any[]) => Effect.runPromise(Effect.gen(function*() { const values = yield* Effect.all(ids.map(loadTargetMeta), { batching: true, concurrency: "unbounded" }); const b = yield* TargetTagsBackend; return { values, calls: yield* b.calls } }).pipe(Effect.provide(layer(new Map([[id, { tags: ["a"], latestIncident: undefined }]])))))
it("DP-63", async () => { expect((await batch([id, targetId("target_other")])).calls).toBe(1) })
it("DP-64", async () => { const x = await batch([targetId("target_missing")]); expect(x.values[0]).toEqual({ tags: [], latestIncident: undefined }) })
it("DP-65", async () => { const other = targetId("target_other"); const values = await Effect.runPromise(Effect.all([loadTargetMeta(other), loadTargetMeta(id)], { batching: true }).pipe(Effect.provide(layer(new Map([[id, { tags: ["a"], latestIncident: undefined }], [other, { tags: ["b"], latestIncident: undefined }]]))))); expect(values.map(x => x.tags[0])).toEqual(["b", "a"]) })
it("DP-66", async () => { expect((await batch([id, id])).values).toHaveLength(2) })
