import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Layer } from "effect";
import { Target, targetId } from "../src/domain/schema.js";
import { CheckRepository } from "../src/repo/CheckRepository.js";
import { commandHandlers } from "../src/cli/cli.js";
import { importHistoryEffect } from "../src/services/DigestService.js";
import { buildAppLayer, repositoryChoice } from "../src/main.js";
import { AppLayer } from "../src/runtime/ManagedRuntime.js";

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

describe("command surface (contract 9, module 16.7)", () => {
  it("drives the real CLI command through the DSL handler table", async () => {
    const demo = await Effect.runPromise(commandHandlers.demo);
    expect(demo).toBe("demo");
    const checked = await Effect.runPromise(commandHandlers.check("conf.json"));
    expect(checked).toBe("checked conf.json");
    const serve = await Effect.runPromise(commandHandlers.serve);
    expect(serve).toBe("serve");
    const digest = await Effect.runPromise(commandHandlers.digest);
    expect(digest).toBe("digest");
  });

  it.effect("imports history end to end under the app wiring", () =>
    Effect.gen(function*() {
      // Use the raw capability: the CLI surface handler swallows failures
      // and returns void by design.
      const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "bw-main-")));
      const path = join(dir, "history.ndjson");
      const envelope = (id: string, tag: string, millis: number) =>
        JSON.stringify({
          id,
          targetId: "target_cli",
          checkedAt: "2026-01-01T00:00:00.000Z",
          durationMillis: millis,
          classification: { _tag: tag },
          response: {},
        });
      yield* Effect.promise(() =>
        writeFile(path, [envelope("a", "Up", 10), envelope("b", "Down", 20)].join("\n") + "\n"),
      );
      const digest = yield* importHistoryEffect(path);
      expect(digest.processedRows).toBe(2);
      expect(digest.targets).toHaveLength(1);
    }).pipe(Effect.provide(Layer.mergeAll(AppLayer, NodeServices.layer))));
});

