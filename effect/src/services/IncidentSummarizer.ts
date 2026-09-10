import { Context, Data, Effect, Layer, Schema } from "effect"
import { type Incident, WellFormedString } from "../domain/schema.js"

export class IncidentSummary extends Schema.Class<IncidentSummary>("IncidentSummary")({ text: WellFormedString.check(Schema.isMinLength(1), Schema.isMaxLength(240)) }) {}
export class IncidentSummaryError extends Data.TaggedError("IncidentSummaryError")<{ readonly reason: string }> {}
export interface IncidentSummarizerShape { readonly summarize: (incidents: ReadonlyArray<Incident>) => Effect.Effect<IncidentSummary, IncidentSummaryError> }
export class IncidentSummarizer extends Context.Service<IncidentSummarizer, IncidentSummarizerShape>()("beaconwatch/IncidentSummarizer") {}
type Script = "valid" | "malformed" | "schema-invalid" | "provider-error" | "fallback"
export const Fake = (script: Script = "valid") => Layer.succeed(IncidentSummarizer)({ summarize: () => Effect.gen(function*() {
  if (script === "provider-error") return yield* Effect.fail(new IncidentSummaryError({ reason: "provider-error" }))
  const raw: unknown = script === "malformed" ? "not-json" : script === "schema-invalid" ? { text: "" } : { text: script === "fallback" ? "No recent incidents." : "Recent incident timeline is stable and deterministic." }
  return yield* Schema.decodeUnknownEffect(IncidentSummary)(raw).pipe(Effect.mapError((e) => new IncidentSummaryError({ reason: String(e) })))
}) })
