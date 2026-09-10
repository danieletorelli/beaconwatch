class TaggedError extends Error {
  constructor(
    readonly _tag: string,
    message: string,
  ) {
    super(message);
    this.name = _tag;
  }
}
export class DnsError extends TaggedError {
  readonly host: string;
  override readonly cause?: unknown;
  constructor(x: { host: string; cause?: unknown }) {
    super("DnsError", `DNS error: ${x.host}`);
    this.host = x.host;
    this.cause = x.cause;
  }
}
export class TimeoutError extends TaggedError {
  readonly timeout: string;
  override readonly cause?: unknown;
  constructor(x: { timeout: string; cause?: unknown }) {
    super("TimeoutError", `timeout: ${x.timeout}`);
    this.timeout = x.timeout;
    this.cause = x.cause;
  }
}
export class UnexpectedStatus extends TaggedError {
  readonly expected: readonly number[];
  readonly actual: number;
  constructor(x: { expected: readonly number[]; actual: number }) {
    super("UnexpectedStatus", `unexpected status ${x.actual}`);
    this.expected = [...x.expected];
    this.actual = x.actual;
  }
}
export class InvalidBody extends TaggedError {
  readonly reason: string;
  constructor(x: { reason: string }) {
    super("InvalidBody", x.reason);
    this.reason = x.reason;
  }
}
export class TargetDisabled extends TaggedError {
  readonly targetId: string;
  constructor(x: { targetId: string }) {
    super("TargetDisabled", x.targetId);
    this.targetId = x.targetId;
  }
}
export class RepositoryError extends TaggedError {
  readonly operation: string;
  override readonly cause?: unknown;
  constructor(x: { operation: string; cause?: unknown }) {
    super("RepositoryError", x.operation);
    this.operation = x.operation;
    this.cause = x.cause;
  }
}
export class ConfigError extends TaggedError {
  readonly reason: string;
  constructor(x: { reason: string }) {
    super("ConfigError", x.reason);
    this.reason = x.reason;
  }
}
export class HistoryReadError extends TaggedError {
  readonly path: string;
  override readonly cause?: unknown;
  constructor(x: { path: string; cause?: unknown }) {
    super("HistoryReadError", x.path);
    this.path = x.path;
    this.cause = x.cause;
  }
}
export type DomainError =
  | DnsError
  | TimeoutError
  | UnexpectedStatus
  | InvalidBody
  | TargetDisabled
  | RepositoryError
  | ConfigError
  | HistoryReadError;
