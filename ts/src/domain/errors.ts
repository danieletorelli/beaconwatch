import { Data } from "effect";

export class DnsError extends Data.TaggedError("DnsError")<{
  readonly host: string;
  readonly cause?: unknown;
}> {}
export class TimeoutError extends Data.TaggedError("TimeoutError")<{
  readonly timeout: string;
  readonly cause?: unknown;
}> {}
export class UnexpectedStatus extends Data.TaggedError("UnexpectedStatus")<{
  readonly expected: readonly number[];
  readonly actual: number;
}> {}
export class InvalidBody extends Data.TaggedError("InvalidBody")<{
  readonly reason: string;
}> {}
export class HealthSchemaParseError extends Data.TaggedError("HealthSchemaParseError")<{
  readonly reason: string;
}> {}
export class HealthBodyMismatch extends Data.TaggedError("HealthBodyMismatch")<{
  readonly reason: string;
}> {}
export class TargetDisabled extends Data.TaggedError("TargetDisabled")<{
  readonly targetId: string;
}> {}
export class RepositoryError extends Data.TaggedError("RepositoryError")<{
  readonly operation: string;
  readonly cause?: unknown;
}> {}
export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly reason: string;
}> {}
export class HistoryReadError extends Data.TaggedError("HistoryReadError")<{
  readonly path: string;
  readonly cause?: unknown;
}> {}
export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly field: string;
  readonly reason: string;
}> {}
export type DomainError =
  | DnsError
  | TimeoutError
  | UnexpectedStatus
  | InvalidBody
  | HealthSchemaParseError
  | HealthBodyMismatch
  | TargetDisabled
  | RepositoryError
  | ConfigError
  | HistoryReadError
  | ValidationError;
