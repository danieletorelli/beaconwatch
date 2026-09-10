import { Effect, Option, Schema } from "effect";
import { ValidationError } from "./errors.js";

export type TargetId = string & { readonly __brand: "TargetId" };
export type DurationInput = number | string;

export const durationMillis = (input: DurationInput): number => {
  if (typeof input === "number") return input * 1_000;
  const match =
    /^\s*(-?\d+(?:\.\d+)?)\s*(ms|millis(?:econds?)?|seconds?|minutes?|hours?|nanos?)?\s*$/i.exec(
      input,
    );
  if (!match) throw new ValidationError({ field: "duration", reason: "invalid duration" });
  const n = Number(match[1]);
  const unit = (match[2] ?? "ms").toLowerCase();
  if (unit.startsWith("nano")) return n / 1_000_000;
  if (unit.startsWith("second")) return n * 1_000;
  if (unit.startsWith("minute")) return n * 60_000;
  if (unit.startsWith("hour")) return n * 3_600_000;
  return n;
};

export const targetId = (value: unknown): TargetId => {
  if (typeof value !== "string" || !/^target_[a-z0-9][a-z0-9_-]*$/.test(value))
    throw new ValidationError({ field: "targetId", reason: "invalid target id" });
  return value as TargetId;
};
export type HttpMethod = "GET" | "POST" | "HEAD";
export interface TargetConfigInput {
  id: string;
  name: string;
  url: string;
  method: HttpMethod;
  expectedStatus: readonly number[];
  interval: DurationInput;
  timeout: DurationInput;
  slowThreshold: DurationInput;
  healthBodySchema?: string;
  tags?: readonly string[];
}
const TargetConfigInputSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  url: Schema.String,
  method: Schema.Literals(["GET", "POST", "HEAD"]),
  expectedStatus: Schema.Array(Schema.Number),
  interval: Schema.Union([Schema.Number, Schema.String]),
  timeout: Schema.Union([Schema.Number, Schema.String]),
  slowThreshold: Schema.Union([Schema.Number, Schema.String]),
  healthBodySchema: Schema.optionalKey(Schema.String),
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
});
export class TargetConfig {
  readonly id: TargetId;
  readonly name: string;
  readonly url: string;
  readonly method: HttpMethod;
  readonly expectedStatus: readonly number[];
  readonly interval: number;
  readonly timeout: number;
  readonly slowThreshold: number;
  readonly healthBodySchema?: string;
  readonly tags?: readonly string[];
  constructor(input: TargetConfigInput) {
    this.id = targetId(input.id);
    this.name = input.name.trim();
    if (!this.name) throw new ValidationError({ field: "name", reason: "empty name" });
    const url = new URL(input.url);
    if (!/https?:/.test(url.protocol) || !url.hostname)
      throw new ValidationError({ field: "url", reason: "invalid URL" });
    this.url = input.url;
    if (!["GET", "POST", "HEAD"].includes(input.method))
      throw new ValidationError({ field: "method", reason: "invalid method" });
    this.method = input.method;
    if (
      !input.expectedStatus.length ||
      input.expectedStatus.some(
        (x) => !Number.isInteger(x) || x < 100 || x > 599,
      )
    )
      throw new ValidationError({ field: "expectedStatus", reason: "invalid statuses" });
    this.expectedStatus = input.expectedStatus;
    this.interval = positive(input.interval);
    this.timeout = positive(input.timeout);
    this.slowThreshold = positive(input.slowThreshold);
    if (input.healthBodySchema !== undefined)
      this.healthBodySchema = input.healthBodySchema;
    if (input.tags !== undefined) this.tags = input.tags;
  }
}
export class Target extends TargetConfig {
  readonly enabled: boolean;
  constructor(input: TargetConfigInput & { enabled: boolean }) {
    super(input);
    this.enabled = input.enabled;
  }
}
const positive = (d: DurationInput) => {
  const n = durationMillis(d);
  if (!Number.isFinite(n) || n <= 0)
    throw new ValidationError({ field: "duration", reason: "duration must be positive" });
  return n;
};

export class Up {
  readonly _tag = "Up";
}
export class Slow {
  readonly _tag = "Slow";
}
export class Down {
  readonly _tag = "Down";
}
export class InvalidResponse {
  readonly _tag = "InvalidResponse";
}
export class Unknown {
  readonly _tag = "Unknown";
}
export type Classification = Up | Slow | Down | InvalidResponse | Unknown;
export class CheckFailure {
  readonly _tag = "CheckFailure";
  readonly reason: string;
  constructor(input: { reason: string }) {
    this.reason = input.reason;
    Object.freeze(this);
  }
}
export class ResponseMetadata {
  readonly status: Option.Option<number>;
  readonly bytes: Option.Option<number>;
  constructor(input: { status?: number; bytes?: number }) {
    if (input.status !== undefined) {
      if (
        !Number.isInteger(input.status) ||
        input.status < 100 ||
        input.status > 599
      )
        throw new ValidationError({ field: "status", reason: "invalid status" });
      this.status = Option.some(input.status);
    } else {
      this.status = Option.none();
    }
    if (input.bytes !== undefined) {
      if (!Number.isSafeInteger(input.bytes) || input.bytes < 0)
        throw new ValidationError({ field: "bytes", reason: "invalid bytes" });
      this.bytes = Option.some(input.bytes);
    } else {
      this.bytes = Option.none();
    }
    Object.freeze(this);
  }
}
export class CheckResult {
  readonly id: string;
  readonly targetId: TargetId;
  readonly checkedAt: Date;
  readonly duration: number;
  readonly classification: Classification;
  readonly failure: Option.Option<CheckFailure>;
  readonly response: ResponseMetadata;
  constructor(input: {
    id: string;
    targetId: TargetId;
    checkedAt: Date;
    duration: DurationInput;
    classification: Classification;
    failure?: CheckFailure;
    response: ResponseMetadata;
  }) {
    this.id = input.id;
    this.targetId = targetId(input.targetId);
    this.checkedAt = new Date(input.checkedAt);
    this.duration = positive(input.duration);
    this.classification = input.classification;
    this.failure = input.failure !== undefined ? Option.some(input.failure) : Option.none();
    this.response = input.response;
    Object.freeze(this);
  }
}
export class Incident {
  readonly id: string;
  readonly targetId: TargetId;
  readonly openedAt: Date;
  readonly closedAt: Option.Option<Date>;
  readonly status: "Open" | "Closed";
  readonly reason: string;
  readonly latestCheckId: string;
  readonly summary: Option.Option<string>;
  constructor(input: {
    id: string;
    targetId: TargetId;
    openedAt: Date;
    closedAt?: Date;
    status: "Open" | "Closed";
    reason: string;
    latestCheckId: string;
    summary?: string;
  }) {
    this.id = input.id;
    this.targetId = targetId(input.targetId);
    this.openedAt = new Date(input.openedAt);
    this.status = input.status;
    this.reason = input.reason;
    this.latestCheckId = input.latestCheckId;
    this.closedAt = input.closedAt ? Option.some(new Date(input.closedAt)) : Option.none();
    this.summary = input.summary ? Option.some(input.summary) : Option.none();
    if (this.status === "Open" && Option.isSome(this.closedAt))
      throw new ValidationError({ field: "incident", reason: "open incident has close time" });
    if (this.status === "Closed" && Option.isNone(this.closedAt))
      throw new ValidationError({ field: "incident", reason: "closed incident lacks close time" });
    if (Option.isSome(this.closedAt) && this.closedAt.value < this.openedAt)
      throw new ValidationError({ field: "incident", reason: "close before open" });
    Object.freeze(this);
  }
}
export const decodeTargetConfig = (input: unknown): Effect.Effect<TargetConfig, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(TargetConfigInputSchema)(input).pipe(
    Effect.map((decoded) => new TargetConfig(decoded))
  );
export const cloneCheck = (c: CheckResult) =>
  new CheckResult({
    id: c.id,
    targetId: c.targetId,
    checkedAt: new Date(c.checkedAt),
    duration: c.duration,
    classification: new ({ Up, Slow, Down, InvalidResponse, Unknown } as const)[
      c.classification._tag
    ](),
    ...(Option.isSome(c.failure) ? { failure: new CheckFailure(c.failure.value) } : {}),
    response: new ResponseMetadata({
      ...(Option.isSome(c.response.status) ? { status: c.response.status.value } : {}),
      ...(Option.isSome(c.response.bytes) ? { bytes: c.response.bytes.value } : {}),
    }),
  });
export const cloneIncident = (i: Incident) =>
  new Incident({
    id: i.id,
    targetId: i.targetId,
    openedAt: new Date(i.openedAt),
    status: i.status,
    reason: i.reason,
    latestCheckId: i.latestCheckId,
    ...(Option.isSome(i.closedAt) ? { closedAt: new Date(i.closedAt.value) } : {}),
    ...(Option.isSome(i.summary) ? { summary: i.summary.value } : {}),
  });
export const cloneTarget = (t: Target) =>
  new Target({
    ...t,
    expectedStatus: [...t.expectedStatus],
    ...(t.tags ? { tags: [...t.tags] } : {}),
  });
