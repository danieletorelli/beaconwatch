import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { TargetTagsBackend, type TargetMeta } from "../src/obs/TargetTagsResolver.js";
import { targetId } from "../src/domain/schema.js";

const meta = (tags: string[]): TargetMeta => ({ tags, latestIncident: Option.none() });

describe("target tags backend (BUGS 1.1, 5.1)", () => {
  it.effect("a missing id resolves to None instead of hanging forever", () =>
    Effect.gen(function*() {
      const backend = new TargetTagsBackend(new Map());
      const rows = yield* backend.loadManyEffect([targetId("target_missing")]);
      expect(rows).toHaveLength(1);
      expect(Option.isNone(rows[0]!)).toBe(true);
    }));

  it.effect("each id resolves its own metadata, not the first entry", () =>
    Effect.gen(function*() {
      const backend = new TargetTagsBackend(
        new Map([
          [targetId("target_a"), { tags: ["alpha"], latestIncident: Option.none() }],
          [targetId("target_b"), { tags: ["beta"], latestIncident: Option.some("incident_1") }],
        ] as const),
      );
      const rows = yield* backend.loadManyEffect([
        targetId("target_a"),
        targetId("target_b"),
      ]);
      expect(Option.getOrThrow(rows[0]!).tags).toEqual(["alpha"]);
      expect(Option.getOrThrow(rows[1]!).tags).toEqual(["beta"]);
      expect(Option.getOrThrow(rows[1]!).latestIncident).toEqual(Option.some("incident_1"));
    }));

  it.effect("duplicate ids are collapsed to one lookup", () =>
    Effect.gen(function*() {
      const backend = new TargetTagsBackend(
        new Map([[targetId("target_a"), { tags: [], latestIncident: Option.none() }]] as const),
      );
      const rows = yield* backend.loadManyEffect([
        targetId("target_a"),
        targetId("target_a"),
      ]);
      expect(rows).toHaveLength(1);
      expect(backend.calls).toBe(1);
    }));

  it.effect("returned metadata is copied, not aliased", () =>
    Effect.gen(function*() {
      const backend = new TargetTagsBackend(
        new Map([[targetId("target_a"), { tags: ["t"], latestIncident: Option.none() }]] as const),
      );
      const rows = yield* backend.loadManyEffect([targetId("target_a")]);
      const first = Option.getOrThrow(rows[0]!);
      (first.tags as string[]).push("mutated");
      const again = yield* backend.loadEffect(targetId("target_a"));
      expect(Option.getOrThrow(again).tags).toEqual(["t"]);
    }));
});
