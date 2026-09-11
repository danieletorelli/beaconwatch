import { Duration, Effect, Option, Schema, SchemaGetter } from "effect";
import type * as Brand from "effect/Brand";
import { ValidationError } from "./errors.js";

export type TargetId = string & Brand.Brand<"TargetId">;
export type CheckId = string & Brand.Brand<"CheckId">;
export type IncidentId = string & Brand.Brand<"IncidentId">;
export type HttpMethod = "GET" | "POST" | "HEAD";
export type DurationInput = number | string;

export const durationMillis = (input: DurationInput): number => {
  if (typeof input === "number") return input; // unitless = milliseconds
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

// ---------- Shared field schemas (module 11): the single validation source.

// Well-formed Unicode: no unpaired surrogates (TextEncoder replaces them).
const isWellFormed = (s: string) =>
  new TextDecoder().decode(new TextEncoder().encode(s)) === s;
export const WellFormedString = Schema.String.check(
  Schema.makeFilter((s: string) =>
    isWellFormed(s) ? undefined : "must be well-formed Unicode",
  ),
);

// Timestamps: valid calendar instants with a UTC year of 0001 through 9999.
export const AcceptedDate = Schema.instanceOf(globalThis.Date).check(
  Schema.makeFilter((d: Date) => {
    if (Number.isNaN(d.getTime())) return "invalid timestamp";
    const year = d.getUTCFullYear();
    return year >= 1 && year <= 9999 ? undefined : "timestamp year must be 0001-9999";
  }),
);

// Durations: bare numbers are milliseconds, unit strings use their unit;
// strictly positive, with positive infinity satisfying the boundary.
export const PositiveDuration = Schema.Union([
  Schema.DurationFromMillis,
  Schema.DurationFromString,
]).check(
  Schema.makeFilter((d: Duration.Duration) =>
    Duration.match({
      onMillis: (m) => m > 0,
      onNanos: (n) => n > 0n,
      onInfinity: () => true,
      onNegativeInfinity: () => false,
    })(d)
      ? undefined
      : "duration must be positive",
  ),
);

// Names are trimmed non-empty strings; urls must be lexical http(s) urls.
export const TargetName = Schema.String.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((s: string) => {
      const trimmed = s.trim();
      if (trimmed.length === 0) throw new Error("name must not be empty");
      return trimmed;
    }),
    encode: SchemaGetter.transform((s: string) => s),
  }),
);
export const HttpUrl = Schema.String.check(
  Schema.makeFilter((s: string) => {
    try {
      const url = new URL(s);
      return /^https?:$/.test(url.protocol) && url.hostname
        ? undefined
        : "invalid URL";
    } catch {
      return "invalid URL";
    }
  }),
);

export const CheckIdField = WellFormedString.pipe(Schema.brand("CheckId"));
export const IncidentIdField = WellFormedString.pipe(Schema.brand("IncidentId"));
export const TargetIdField = Schema.String.check(
  Schema.isPattern(/^target_[a-z0-9][a-z0-9_-]*$/),
).pipe(Schema.brand("TargetId"));

// ---------- Classifications.

export class Up extends Schema.TaggedClass<Up>()("Up", {}) {}
export class Slow extends Schema.TaggedClass<Slow>()("Slow", {}) {}
export class Down extends Schema.TaggedClass<Down>()("Down", {}) {}
export class InvalidResponse extends Schema.TaggedClass<InvalidResponse>()(
  "InvalidResponse",
  {},
) {}
export class Unknown extends Schema.TaggedClass<Unknown>()("Unknown", {}) {}
export type Classification = Up | Slow | Down | InvalidResponse | Unknown;

// ---------- Check envelope.

export class CheckFailure extends Schema.TaggedClass<CheckFailure>()(
  "CheckFailure",
  { reason: WellFormedString },
) {}

export class ResponseMetadata extends Schema.Class<ResponseMetadata>(
  "ResponseMetadata",
)({
  status: Schema.OptionFromOptionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
  ),
  bytes: Schema.OptionFromOptionalKey(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(0),
    ),
  ),
}) {}

export class CheckResult extends Schema.Class<CheckResult>("CheckResult")({
  id: CheckIdField,
  targetId: TargetIdField,
  checkedAt: AcceptedDate,
  duration: PositiveDuration,
  classification: Schema.Union([Up, Slow, Down, InvalidResponse, Unknown]),
  failure: Schema.OptionFromOptionalKey(CheckFailure),
  response: ResponseMetadata,
}) {}

// ---------- Targets.

export class TargetConfig extends Schema.Class<TargetConfig>("TargetConfig")({
  id: TargetIdField,
  name: TargetName,
  url: HttpUrl,
  method: Schema.Literals(["GET", "POST", "HEAD"]),
  expectedStatus: Schema.NonEmptyArray(
    Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
  ),
  interval: PositiveDuration,
  timeout: PositiveDuration,
  slowThreshold: PositiveDuration,
  healthBodySchema: Schema.optionalKey(Schema.String),
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
}) {}

export class Target extends TargetConfig.extend<Target>("Target")({
  enabled: Schema.Boolean,
}) {}

// ---------- Incidents.

const incidentWindows = Schema.makeFilter(
  (
    i: {
      readonly status: "Open" | "Closed";
      readonly openedAt: Date;
      readonly closedAt: Option.Option<Date>;
    },
  ) => {
    if (i.status === "Open" && Option.isSome(i.closedAt))
      return "open incident has close time";
    if (i.status === "Closed" && Option.isNone(i.closedAt))
      return "closed incident lacks close time";
    if (Option.isSome(i.closedAt) && i.closedAt.value < i.openedAt)
      return "close before open";
    return undefined;
  },
);
const IncidentStruct = Schema.Struct({
  id: IncidentIdField.check(
    Schema.makeFilter((s: string) =>
      /^incident_[a-z0-9][a-z0-9_-]*$/.test(s) ? undefined : "invalid incident id",
    ),
  ),
  targetId: TargetIdField,
  openedAt: AcceptedDate,
  status: Schema.Literals(["Open", "Closed"]),
  reason: WellFormedString,
  latestCheckId: WellFormedString,
  summary: Schema.OptionFromOptionalKey(WellFormedString),
  closedAt: Schema.OptionFromOptionalKey(AcceptedDate),
}).check(incidentWindows);
export class Incident extends Schema.Class<Incident>("Incident")(IncidentStruct) {}

// ---------- Boundary decode.

export const TargetConfigSchema = TargetConfig;
export const decodeTargetConfig = (
  input: unknown,
): Effect.Effect<TargetConfig, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(TargetConfig)(input);

// ---------- Structural copies (immutable replacement).

export const cloneCheck = (c: CheckResult) =>
  new CheckResult({
    id: c.id,
    targetId: c.targetId,
    checkedAt: new Date(c.checkedAt),
    duration: c.duration,
    classification: c.classification,
    failure: Option.isSome(c.failure)
      ? Option.some(new CheckFailure({ reason: c.failure.value.reason }))
      : Option.none(),
    response: new ResponseMetadata({
      status: c.response.status,
      bytes: c.response.bytes,
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
    summary: i.summary,
    closedAt: Option.isSome(i.closedAt)
      ? Option.some(new Date(i.closedAt.value))
      : Option.none(),
  });
export const cloneTarget = (t: Target) =>
  new Target({
    ...t,
    expectedStatus: [...t.expectedStatus],
    ...(t.tags ? { tags: [...t.tags] } : {}),
  });
