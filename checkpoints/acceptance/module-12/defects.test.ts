import { expect, it } from "vitest"
import { Effect, FileSystem, Layer, Path, Stream } from "effect"
import * as DigestService from "../../../src/services/DigestService.js"
const line = JSON.stringify({ id: "check_dp", targetId: "target_dp", checkedAt: "2026-01-01T00:00:00.000Z", durationMillis: 1, classification: { _tag: "Up" }, response: {} })
it("DP-51", async () => { let streamed = 0; const bytes = (value: string) => new TextEncoder().encode(value); const fs = FileSystem.makeNoop({ readFileString: () => Effect.die("materialized"), stream: () => Stream.fromEffect(Effect.sync(() => { streamed++; return bytes(`${line}\n`) })).pipe(Stream.concat(Stream.fromEffect(Effect.sync(() => { streamed++; return bytes(`${line}\n`) })))) }); const digest = await Effect.runPromise(DigestService.importHistory("virtual").pipe(Effect.provide(Layer.succeed(FileSystem.FileSystem)(fs)), Effect.provide(Path.layer))); expect(streamed).toBe(2); expect(digest.processedRows).toBe(2) })
it("DP-52", async () => { const out = await DigestService.orderedDigestRows([1, 2, 3], async n => { await new Promise(r => setTimeout(r, 4 - n)); return n }); expect(out).toEqual([1, 2, 3]) })
