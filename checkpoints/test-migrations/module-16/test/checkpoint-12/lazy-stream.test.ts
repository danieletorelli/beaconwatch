import { expect, it } from "vitest"
import { Effect, FileSystem, Layer, Path, Stream } from "effect"
import * as DigestService from "../../src/services/DigestService.js"

it("streams lazily with bounded ordered work across Effect and Promise APIs", async () => {
  const { historyRows, orderedDigestRows } = DigestService as any
  expect(historyRows, "expose a lazy history stream").toBeDefined()

  let reads = 0
  const bytes = (text: string) => new TextEncoder().encode(text)
  const files = FileSystem.makeNoop({ stream: () => Stream.fromEffect(Effect.sync(() => { reads++; return bytes("first\n") })).pipe(Stream.concat(Stream.fromEffect(Effect.sync(() => { reads++; return bytes("second\n") })))) })
  const values = await Effect.runPromise(historyRows("virtual/history.ndjson").pipe(Stream.take(1), Stream.runCollect, Effect.provide(Layer.succeed(FileSystem.FileSystem)(files)), Effect.provide(Path.layer)))
  expect(Array.from(values as any)).toEqual([{ line: "first", lineNo: 1 }])
  expect(reads).toBe(1)

  let active = 0, peak = 0
  const releases = Array.from({ length: 8 }, () => undefined as undefined | (() => void))
  const started: Array<() => void> = []
  const gates = releases.map((_release, index) => new Promise<void>(resolve => {
    releases[index] = resolve
  }))
  const allStarted = new Promise<void>(resolve => { started.push(resolve) })
  let starts = 0
  const pending = orderedDigestRows(Array.from({ length: 8 }, (_, n) => n), async (n: number) => {
    active++; peak = Math.max(peak, active)
    if (++starts === 4) started[0]!()
    await gates[n]
    active--
    return n
  })
  await allStarted
  expect(peak).toBe(4)
  for (const release of releases) {
    release!()
    await Promise.resolve()
  }
  expect(await pending).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
})
