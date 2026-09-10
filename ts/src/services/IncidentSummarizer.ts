import type { Incident } from "../domain/schema.js";
export class IncidentSummary {
  readonly text: string;
  constructor(x: { text: string }) {
    if (!x.text || x.text.length > 240)
      throw new IncidentSummaryError({ reason: "invalid summary" });
    this.text = x.text;
  }
}
export class IncidentSummaryError extends Error {
  readonly _tag = "IncidentSummaryError";
  readonly reason: string;
  constructor(x: { reason: string }) {
    super(x.reason);
    this.reason = x.reason;
  }
}
type Script =
  | "valid"
  | "malformed"
  | "schema-invalid"
  | "provider-error"
  | "fallback";
export interface IncidentSummarizerShape {
  summarize(i: readonly Incident[]): Promise<IncidentSummary>;
}
export const Fake = (s: Script = "valid"): IncidentSummarizerShape => ({
  async summarize() {
    if (s === "provider-error" || s === "malformed" || s === "schema-invalid")
      throw new IncidentSummaryError({ reason: s });
    return new IncidentSummary({
      text:
        s === "fallback"
          ? "No recent incidents."
          : "Recent incident timeline is stable and deterministic.",
    });
  },
});
