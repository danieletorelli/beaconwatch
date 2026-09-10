export type TargetId = string & { readonly __brand: "TargetId" };
export type DurationInput = number | string;

export const durationMillis = (input: DurationInput): number => {
  if (typeof input === "number") return input * 1_000;
  const match =
    /^\s*(-?\d+(?:\.\d+)?)\s*(ms|millis(?:econds?)?|seconds?|minutes?|hours?|nanos?)?\s*$/i.exec(
      input,
    );
  if (!match) throw new TypeError("invalid duration");
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
    throw new TypeError("invalid target id");
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
    if (!this.name) throw new TypeError("empty name");
    const url = new URL(input.url);
    if (!/https?:/.test(url.protocol) || !url.hostname)
      throw new TypeError("invalid URL");
    this.url = input.url;
    if (!["GET", "POST", "HEAD"].includes(input.method))
      throw new TypeError("invalid method");
    this.method = input.method;
    if (
      !input.expectedStatus.length ||
      input.expectedStatus.some(
        (x) => !Number.isInteger(x) || x < 100 || x > 599,
      )
    )
      throw new TypeError("invalid statuses");
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
    throw new TypeError("duration must be positive");
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
  readonly status?: number;
  readonly bytes?: number;
  constructor(input: { status?: number; bytes?: number }) {
    if (input.status !== undefined) {
      if (
        !Number.isInteger(input.status) ||
        input.status < 100 ||
        input.status > 599
      )
        throw new TypeError("invalid status");
      this.status = input.status;
    }
    if (input.bytes !== undefined) {
      if (!Number.isSafeInteger(input.bytes) || input.bytes < 0)
        throw new TypeError("invalid bytes");
      this.bytes = input.bytes;
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
  readonly failure?: CheckFailure;
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
    if (input.failure) this.failure = input.failure;
    this.response = input.response;
    Object.freeze(this);
  }
}
export class Incident {
  readonly id: string;
  readonly targetId: TargetId;
  readonly openedAt: Date;
  readonly closedAt?: Date;
  readonly status: "Open" | "Closed";
  readonly reason: string;
  readonly latestCheckId: string;
  readonly summary?: string;
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
    Object.assign(this, input);
    this.id = input.id;
    this.targetId = targetId(input.targetId);
    this.openedAt = new Date(input.openedAt);
    this.status = input.status;
    this.reason = input.reason;
    this.latestCheckId = input.latestCheckId;
    if (input.closedAt) this.closedAt = new Date(input.closedAt);
    if (input.summary) this.summary = input.summary;
    if (this.status === "Open" && this.closedAt)
      throw new TypeError("open incident has close time");
    if (this.status === "Closed" && !this.closedAt)
      throw new TypeError("closed incident lacks close time");
    if (this.closedAt && this.closedAt < this.openedAt)
      throw new TypeError("close before open");
    Object.freeze(this);
  }
}
export const decodeTargetConfig = async (input: unknown) =>
  new TargetConfig(input as TargetConfigInput);
export const cloneCheck = (c: CheckResult) =>
  new CheckResult({
    ...c,
    checkedAt: new Date(c.checkedAt),
    classification: new ({ Up, Slow, Down, InvalidResponse, Unknown } as const)[
      c.classification._tag
    ](),
    ...(c.failure ? { failure: new CheckFailure(c.failure) } : {}),
    response: new ResponseMetadata(c.response),
  });
export const cloneIncident = (i: Incident) =>
  new Incident({
    ...i,
    openedAt: new Date(i.openedAt),
    ...(i.closedAt ? { closedAt: new Date(i.closedAt) } : {}),
  });
export const cloneTarget = (t: Target) =>
  new Target({
    ...t,
    expectedStatus: [...t.expectedStatus],
    ...(t.tags ? { tags: [...t.tags] } : {}),
  });
