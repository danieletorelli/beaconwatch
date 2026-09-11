import { Match } from "effect";
import type { DomainError } from "./errors.js";
export type ErrorDisposition =
  | "ignore-disabled"
  | "invalid-response"
  | "service-down"
  | "operator-action";
export const classifyDomainError = (e: DomainError): ErrorDisposition =>
  Match.value(e).pipe(
    Match.tagsExhaustive({
      TargetDisabled: () => "ignore-disabled" as const,
      InvalidBody: () => "invalid-response" as const,
      DnsError: () => "service-down" as const,
      TimeoutError: () => "service-down" as const,
      UnexpectedStatus: () => "service-down" as const,
      RepositoryError: () => "operator-action" as const,
      ConfigError: () => "operator-action" as const,
      HistoryReadError: () => "operator-action" as const,
      ValidationError: () => "operator-action" as const,
    }),
  );

