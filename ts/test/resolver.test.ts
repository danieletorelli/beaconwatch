import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { targetId, type TargetId } from "../src/domain/schema.js";
import {
  layer,
  loadTargetMeta,
  TargetTagsBackend,
  type TargetMeta,
} from "../src/obs/TargetTagsResolver.js";

const backing = new Map<TargetId, TargetMeta>([
  [targetId("target_a"), { tags: ["alpha"], latestIncident: Option.none() }],
  [targetId("target_b"), { tags: ["beta"], latestIncident: Option.some("incident_1") }],
]);

describe("target tags backend (BUGS 1.1, 5.1, module 14 batching)", () => {
  it.effect("a missing id resolves to None instead of hanging forever", () =>
    Effect.gen(function*() {
      const info = yield* loadTargetMeta(targetId("target_missing"));
      expect(info.tags).toEqual([]);
      expect(Option.isNone(info.latestIncident)).toBe(true);
    }).pipe(Effect.provide(layer(backing))));

  it.effect("each id resolves its own metadata, not the first entry", () =>
    Effect.gen(function*() {
      const a = yield* loadTargetMeta(targetId("target_a"));
      const b = yield* loadTargetMeta(targetId("target_b"));
      expect(a.tags).toEqual(["alpha"]);
      expect(b.tags).toEqual(["beta"]);
      expect(Option.getOrThrow(b.latestIncident)).toBe("incident_1");
    }).pipe(Effect.provide(layer(backing))));

  it.effect("concurrent lookups collapse into one batched call with unique ids", () =>
    Effect.gen(function*() {
      const backend = yield* TargetTagsBackend;
      const results = yield* Effect.all(
        [
          loadTargetMeta(targetId("target_a")),
          loadTargetMeta(targetId("target_b")),
          loadTargetMeta(targetId("target_a")),
        ],
        { concurrency: "unbounded" },
      );
      expect(results).toHaveLength(3);
      expect(yield* backend.calls).toBe(1);
      const batches = yield* backend.requestedIds;
      expect(batches).toHaveLength(1);
      expect([...batches[0]!].sort()).toEqual(["target_a", "target_b"].sort());
    }).pipe(Effect.provide(layer(backing))));

  it.effect("returned metadata is copied, not aliased", () =>
    Effect.gen(function*() {
      const info = yield* loadTargetMeta(targetId("target_a"));
      (info.tags as string[]).push("mutated");
      const again = yield* loadTargetMeta(targetId("target_a"));
      expect(again.tags).toEqual(["alpha"]);
    }).pipe(Effect.provide(layer(backing))));
});
