import { expect, it } from "vitest"
import { Effect, FileSystem, Layer, Path, Stream } from "effect"
import { importHistory } from "../../src/services/DigestService.js"

it("reads history through the injected filesystem capability", async () => {
  const digest = await import("../../src/services/" + "DigestService.js") as any
  expect(digest.HistoryPlatformLive, "provide the live Node filesystem layer").toBeDefined()
  let reads = 0
  const fixture = JSON.stringify({ id: "check_fake", targetId: "target_fake", checkedAt: "2026-01-01T00:00:00.000Z", durationMillis: 12, classification: { _tag: "Up" }, response: { status: 200 } })
  const read = () => Effect.sync(() => { reads++; return fixture })
  const files = FileSystem.makeNoop({ readFileString: read, stream: () => Stream.fromEffect(read().pipe(Effect.map(text => new TextEncoder().encode(text)))) })
  const candidate: any = importHistory("virtual/history.ndjson")
  const result: any = Effect.isEffect(candidate)
    ? await Effect.runPromise((candidate as Effect.Effect<any, any>).pipe(Effect.provide(Layer.succeed(FileSystem.FileSystem)(files)), Effect.provide(Path.layer)) as any)
    : await candidate
  expect(result.processedRows).toBe(1)
  expect(reads).toBe(1)
  const live: any = await Effect.runPromise((importHistory("test/fixtures/check-history.ndjson") as any).pipe(Effect.provide(digest.HistoryPlatformLive)))
  expect(live.processedRows).toBeGreaterThan(0)
})
