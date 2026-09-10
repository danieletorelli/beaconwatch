import { Duration, Effect, Option, Schema, SchemaAST, SchemaGetter, SchemaIssue } from "effect"

export const TargetId = Schema.String.check(Schema.isPattern(/^target_[a-z0-9][a-z0-9_-]*$/)).pipe(
  Schema.brand("TargetId")
)
export type TargetId = typeof TargetId.Type

/** Strings with a unique, lossless UTF-8 encoding (no unpaired UTF-16 surrogates). */
export const WellFormedString = Schema.String.check(Schema.makeFilter((value) =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)
    ? "expected a well-formed Unicode string"
    : undefined
))
export const CheckId = WellFormedString
export const IncidentId = WellFormedString.check(Schema.isPattern(/^incident_[a-z0-9][a-z0-9_-]*$/))

const HttpMethod = Schema.Literals(["GET", "POST", "HEAD"])
const StatusCode = Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }))
export const HttpUrl = Schema.String.check(Schema.makeFilter((value) => {
  if (!/^[Hh][Tt][Tt][Pp][Ss]?:\/\//.test(value) || /[\s\u0000-\u001f\u007f-\u009f\\]/u.test(value)) {
    return "expected a lexically valid HTTP(S) URL"
  }
  try {
    const url = new URL(value)
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0
      ? undefined
      : "expected an HTTP(S) URL with a hostname"
  } catch {
    return "expected an HTTP(S) URL with a hostname"
  }
}, { toJsonSchema: () => ({ format: "uri", pattern: "^[Hh][Tt][Tt][Pp][Ss]?://" }) }))

const parseDuration = (value: Duration.Duration | string, options: SchemaAST.ParseOptions) => {
  if (Duration.isDuration(value)) return Effect.succeed(value)
  const parsed = Duration.fromInput(value as Duration.Input)
  return Option.match(parsed, {
    onNone: () => Effect.fail(new SchemaIssue.InvalidValue({ message: "invalid duration" }, value, options)),
    onSome: Effect.succeed
  })
}

export const DurationFromInput = Schema.Union([Schema.Duration, Schema.String]).pipe(
  Schema.decodeTo(Schema.Duration, {
    decode: SchemaGetter.transformOrFail(parseDuration),
    encode: SchemaGetter.transform((duration) => duration)
  })
)

export const TrimmedString = Schema.String.pipe(
  Schema.decode({
    decode: SchemaGetter.transform((s) => s.trim()),
    encode: SchemaGetter.transform((s) => s.trim())
  })
)

export const TargetName = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.decode({
    decode: SchemaGetter.transform((s) => s.trim()),
    encode: SchemaGetter.transform((s) => s.trim())
  }),
  Schema.check(
    Schema.isMinLength(1),
    Schema.makeFilter((s) => s === s.trim() ? undefined : "expected already-normalized text")
  )
)

const PositiveDuration = DurationFromInput.check(
  Schema.makeFilter((duration) => Duration.toMillis(duration) > 0 ? undefined : "duration must be positive")
)

const TargetFields = {
  id: TargetId,
  name: TargetName,
  url: HttpUrl,
  method: HttpMethod,
  expectedStatus: Schema.NonEmptyArray(StatusCode),
  interval: PositiveDuration,
  timeout: PositiveDuration,
  slowThreshold: PositiveDuration,
  healthBodySchema: Schema.optionalKey(Schema.String),
  tags: Schema.optionalKey(Schema.Array(Schema.String))
} as const

export class TargetConfig extends Schema.Class<TargetConfig>("TargetConfig")(TargetFields) {}

export class Target extends Schema.Class<Target>("Target")({
  ...TargetFields,
  enabled: Schema.Boolean
}) {}

export class Up extends Schema.TaggedClass<Up>()("Up", {}) {}
export class Slow extends Schema.TaggedClass<Slow>()("Slow", {}) {}
export class Down extends Schema.TaggedClass<Down>()("Down", {}) {}
export class InvalidResponse extends Schema.TaggedClass<InvalidResponse>()("InvalidResponse", {}) {}
export class Unknown extends Schema.TaggedClass<Unknown>()("Unknown", {}) {}
export const Classification = Schema.Union([Up, Slow, Down, InvalidResponse, Unknown])
export type Classification = typeof Classification.Type

export class CheckFailure extends Schema.TaggedClass<CheckFailure>()("CheckFailure", {
  reason: WellFormedString
}) {}

export class ResponseMetadata extends Schema.Class<ResponseMetadata>("ResponseMetadata")({
  status: Schema.optionalKey(StatusCode),
  bytes: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })))
}) {}

export const AcceptedDate = Schema.Date.check(
  Schema.makeFilter((date) => {
    const year = date.getUTCFullYear()
    return year >= 1 && year <= 9999 ? undefined : "year must be between 0001 and 9999"
  })
)

export class CheckResult extends Schema.Class<CheckResult>("CheckResult")({
  id: CheckId,
  targetId: TargetId,
  checkedAt: AcceptedDate,
  duration: PositiveDuration,
  classification: Classification,
  failure: Schema.optionalKey(CheckFailure),
  response: ResponseMetadata
}) {}

const IncidentFields = Schema.Struct({
  id: IncidentId,
  targetId: TargetId,
  openedAt: AcceptedDate,
  closedAt: Schema.Option(AcceptedDate),
  status: Schema.Literals(["Open", "Closed"]),
  reason: WellFormedString,
  latestCheckId: CheckId,
  summary: Schema.Option(WellFormedString)
}).check(Schema.makeFilter((incident) => {
  if (incident.status === "Open" && Option.isSome(incident.closedAt)) return "an open incident cannot have a close time"
  if (incident.status === "Closed" && Option.isNone(incident.closedAt)) return "a closed incident must have a close time"
  if (Option.isSome(incident.closedAt) && incident.closedAt.value < incident.openedAt) return "an incident cannot close before it opens"
  return undefined
}))

export class Incident extends Schema.Class<Incident>("Incident")(IncidentFields) {}

export const decodeTargetConfig = (input: unknown) => Schema.decodeUnknownEffect(TargetConfig)(input)
