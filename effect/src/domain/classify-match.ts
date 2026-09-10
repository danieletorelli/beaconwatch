import { Match } from "effect"
import type { DomainError } from "./errors.js"

export type ErrorDisposition = "ignore-disabled" | "invalid-response" | "service-down" | "operator-action"

export const classifyDomainError = Match.type<DomainError>().pipe(
  Match.tag("TargetDisabled", () => "ignore-disabled" as const),
  Match.tag("InvalidBody", () => "invalid-response" as const),
  Match.tag("HealthSchemaParseError", () => "invalid-response" as const),
  Match.tag("HealthBodyMismatch", () => "invalid-response" as const),
  Match.tag("DnsError", () => "service-down" as const),
  Match.tag("TimeoutError", () => "service-down" as const),
  Match.tag("UnexpectedStatus", () => "service-down" as const),
  Match.tag("RepositoryError", () => "operator-action" as const),
  Match.tag("ConfigError", () => "operator-action" as const),
  Match.tag("HistoryReadError", () => "operator-action" as const),
  Match.exhaustive
)
