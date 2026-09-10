import { describe, expect, it } from "vitest";
import { Effect, FileSystem, Layer, Path, Stream } from "effect";
import { HistoryPlatformLive, importHistory } from "../../src/services/DigestService.js";

const fixture = JSON.stringify({ id: "check_fake", targetId: "target_fake", checkedAt: "2026-01-01T00:00:00.000Z", durationMillis: 12, classification: { _tag: "Up" }, response: { status: 200 } });

describe("history file capability", () => {
  it("imports fake rows without touching the live filesystem", async () => {
    let reads = 0;
    const files = FileSystem.makeNoop({ stream: () => Stream.fromEffect(Effect.sync(() => { reads++; return new TextEncoder().encode(fixture); })) });
    const digest = await Effect.runPromise(importHistory("virtual/history.ndjson").pipe(
      Effect.provide(Layer.succeed(FileSystem.FileSystem)(files)),
      Effect.provide(Path.layer),
    ));
    expect(digest.targets.map((target) => target.targetId)).toEqual(["target_fake"]);
    expect(digest.processedRows).toBe(1);
    expect(reads).toBe(1);
  });

  it("keeps the existing fixture compatible with the Node layer", async () => {
    const digest = await Effect.runPromise(importHistory("test/fixtures/check-history.ndjson").pipe(Effect.provide(HistoryPlatformLive)));
    expect(digest.processedRows).toBeGreaterThan(0);
  });
});
