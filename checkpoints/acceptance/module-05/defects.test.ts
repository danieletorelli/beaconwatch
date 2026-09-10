import { expect, it } from "vitest"
import { rm, writeFile } from "node:fs/promises"
import { Effect, FileSystem, Layer, Path, Stream } from "effect"
import { importHistory } from "../../../src/services/DigestService.js"

it("DP-17", async () => {
  let fakeReads = 0
  const row = JSON.stringify({ id: "check_1", targetId: "target_fake", checkedAt: "2026-01-01T00:00:00Z", durationMillis: 1, classification: { _tag: "Up" }, response: {} })
  const read = () => Effect.sync(() => { fakeReads++; return row })
  const files = FileSystem.makeNoop({ readFileString: read, stream: () => Stream.fromEffect(read().pipe(Effect.map(text => new TextEncoder().encode(text)))) })
  const path = "history-dp17.ndjson"
  await writeFile(path, row)
  try {
    const candidate = importHistory(path)
    const digest = Effect.isEffect(candidate)
      ? await Effect.runPromise(candidate.pipe(Effect.provide(Layer.succeed(FileSystem.FileSystem)(files)), Effect.provide(Path.layer)))
      : await candidate
    expect([fakeReads, digest.processedRows]).toEqual([1, 1])
  } finally { await rm(path, { force: true }) }
})
