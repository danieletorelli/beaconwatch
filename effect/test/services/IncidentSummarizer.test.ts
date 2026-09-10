import { expect, it } from "vitest"
import { Effect, Exit, Schema } from "effect"
import { Fake, IncidentSummarizer, IncidentSummary } from "../../src/services/IncidentSummarizer.js"

it("fake summarizer returns validated happy path", async () => {
  const out = await Effect.runPromise(Effect.gen(function*() { const s = yield* IncidentSummarizer; return yield* s.summarize([]) }).pipe(Effect.provide(Fake("valid"))))
  expect(out.text).toContain("deterministic")
})
it("surfaces schema-invalid output as typed error", async () => {
  const exit = await Effect.runPromiseExit(Effect.gen(function*() { const s = yield* IncidentSummarizer; return yield* s.summarize([]) }).pipe(Effect.provide(Fake("schema-invalid"))))
  expect(Exit.isFailure(exit)).toBe(true)
})

it("rejects lone surrogates while preserving the 1-240 summary limit", async () => {
  await expect(Effect.runPromise(Schema.decodeUnknownEffect(IncidentSummary)({ text: "bad \uD800" }))).rejects.toBeTruthy()
  await expect(Effect.runPromise(Schema.decodeUnknownEffect(IncidentSummary)({ text: "x".repeat(241) }))).rejects.toBeTruthy()
  const unicode = await Effect.runPromise(Schema.decodeUnknownEffect(IncidentSummary)({ text: "Résumé 東京 ✅" }))
  expect(unicode.text).toBe("Résumé 東京 ✅")
})
