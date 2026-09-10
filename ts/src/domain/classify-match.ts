import type { DomainError } from "./errors.js";
export type ErrorDisposition =
  | "ignore-disabled"
  | "invalid-response"
  | "service-down"
  | "operator-action";
export const classifyDomainError = (e: DomainError): ErrorDisposition =>
  e._tag === "TargetDisabled"
    ? "ignore-disabled"
    : e._tag === "InvalidBody"
      ? "invalid-response"
      : ["DnsError", "TimeoutError", "UnexpectedStatus"].includes(e._tag)
        ? "service-down"
        : "operator-action";

export const policyDecision = (policy: { _tag: string }) => {
  switch (policy._tag) {
    case "Ignore": return "ignored";
    case "Escalate": return "escalated";
    default: return "accepted";
  }
};
