import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect } from "effect";
import { Target, targetId } from "../src/domain/schema.js";
import { CheckRepository } from "../src/repo/CheckRepository.js";
import { buildAppLayer, repositoryChoice } from "../src/main.js";

describe("application boundary (module 15)", () => {
  it("selects the repository implementation from the environment", () => {
    expect(repositoryChoice({})).toBe("memory");
    expect(repositoryChoice({ BEACONWATCH_REPOSITORY: "memory" })).toBe("memory");
    expect(repositoryChoice({ BEACONWATCH_REPOSITORY: "sqlite" })).toBe("sqlite");
    expect(repositoryChoice({ BEACONWATCH_REPOSITORY: "other" })).toBe("memory");
  });

  it.effect("the built app layer provides the repository service", () =>
    Effect.gen(function*() {
      const repo = yield* CheckRepository;
      yield* repo.saveTarget(new Target({
        id: targetId("target_main"),
        name: "M",
        url: "http://example.test",
        method: "GET",
        expectedStatus: [200] as [number, ...number[]],
        interval: Duration.millis(10),
        timeout: Duration.millis(50),
        slowThreshold: Duration.millis(100),
        enabled: true,
      }));
      const targets = yield* repo.listTargets();
      expect(targets).toHaveLength(1);
    }).pipe(Effect.provide(buildAppLayer(repositoryChoice({})))));

  it.effect("the sqlite choice wires the sqlite layer", () =>
    Effect.gen(function*() {
      const repo = yield* CheckRepository;
      const targets = yield* repo.listTargets();
      expect(targets).toEqual([]);
    }).pipe(Effect.provide(buildAppLayer("sqlite"))));
});
