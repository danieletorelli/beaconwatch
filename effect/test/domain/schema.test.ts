import { describe, expect, it } from "vitest"
import { Duration, Effect, Equal, Option, Schema } from "effect"
import { CheckFailure, CheckResult, Down, Incident, ResponseMetadata, Target, TargetConfig, Up, decodeTargetConfig } from "../../src/domain/schema.js"

const baseTarget = {
  id: "target_schema",
  name: "schema",
  url: "http://schema.test/health",
  method: "GET",
  expectedStatus: [200],
  interval: "1 second",
  timeout: "500 millis",
  slowThreshold: "100 millis"
}

describe("PositiveDuration schema", () => {
  it("accepts positive durations", async () => {
    const decoded = await Effect.runPromise(Schema.decodeUnknownEffect(TargetConfig)(baseTarget))
    expect(Duration.toMillis(decoded.interval)).toBe(1000)
  })

  it("rejects zero durations", async () => {
    await expect(Effect.runPromise(Schema.decodeUnknownEffect(TargetConfig)({ ...baseTarget, interval: "0 millis" }))).rejects.toBeTruthy()
  })

  it("rejects negative durations", async () => {
    await expect(Effect.runPromise(Schema.decodeUnknownEffect(CheckResult)({
      id: "check_negative",
      targetId: "target_schema",
      checkedAt: new Date(0),
      duration: Duration.millis(-1),
      classification: new Up(),
      response: new ResponseMetadata({ status: 200 })
    }))).rejects.toBeTruthy()
  })

  it("accepts positive sub-millisecond durations", async () => {
    const decoded = await Effect.runPromise(Schema.decodeUnknownEffect(CheckResult)({
      id: "check_positive_nanos",
      targetId: "target_schema",
      checkedAt: new Date(0),
      duration: Duration.nanos(1n),
      classification: new Up(),
      response: new ResponseMetadata({ status: 200 })
    }))
    expect(Equal.equals(decoded.duration, Duration.nanos(1n))).toBe(true)
  })

  it("rejects invalid check timestamps", async () => {
    await expect(Effect.runPromise(Schema.decodeUnknownEffect(CheckResult)({
      id: "check_invalid_timestamp",
      targetId: "target_schema",
      checkedAt: new Date(Number.NaN),
      duration: Duration.millis(1),
      classification: new Up(),
      response: new ResponseMetadata({ status: 200 })
    }))).rejects.toBeTruthy()
  })

  it("rejects year 0000 check timestamps", async () => {
    await expect(Effect.runPromise(Schema.decodeUnknownEffect(CheckResult)({
      id: "check_year_zero",
      targetId: "target_schema",
      checkedAt: new Date("0000-01-01T00:00:00Z"),
      duration: Duration.millis(1),
      classification: new Up(),
      response: new ResponseMetadata({})
    }))).rejects.toBeTruthy()
  })

  it("rejects fractional HTTP status codes", async () => {
    await expect(Effect.runPromise(Schema.decodeUnknownEffect(TargetConfig)({
      ...baseTarget,
      expectedStatus: [200.5]
    }))).rejects.toBeTruthy()
  })

  it("rejects fractional response byte counts", async () => {
    await expect(Effect.runPromise(Schema.decodeUnknownEffect(ResponseMetadata)({
      bytes: 1.5
    }))).rejects.toBeTruthy()
  })

  it("rejects malformed HTTP URLs", async () => {
    await expect(Effect.runPromise(Schema.decodeUnknownEffect(TargetConfig)({
      ...baseTarget,
      url: "http://"
    }))).rejects.toBeTruthy()
  })

  it.each([" https://example.com", "https://example.com\n", "https:\\example.com", "httpx://example.com"])("rejects lexically malformed HTTP URL %j", async (url) => {
    await expect(Effect.runPromise(Schema.decodeUnknownEffect(TargetConfig)({ ...baseTarget, url }))).rejects.toBeTruthy()
  })

  it.each(["\u00a0", "\u1680", "\u2003", "\u2028", "\u202f", "\u205f", "\u3000"])("rejects ECMAScript Unicode whitespace U+%s in HTTP URLs", async (whitespace) => {
    const url = `https://example.com/a${whitespace}b`
    await expect(Effect.runPromise(Schema.decodeUnknownEffect(TargetConfig)({ ...baseTarget, url }))).rejects.toBeTruthy()
  })

  it("retains valid percent-encoded URL content", async () => {
    const url = "HTTPS://example.com/a%C2%A0b?value=%E2%80%A8"
    expect((await Effect.runPromise(Schema.decodeUnknownEffect(TargetConfig)({ ...baseTarget, url }))).url).toBe(url)
  })

  it.each(["HTTP://example.com", "HTTPS://example.com"])("accepts case-insensitive HTTP URL scheme %s", async (url) => {
    expect((await Effect.runPromise(Schema.decodeUnknownEffect(TargetConfig)({ ...baseTarget, url }))).url).toBe(url)
  })

  it("trims target names at the decode boundary but rejects non-normalized constructor input", async () => {
    const decoded = await Effect.runPromise(decodeTargetConfig({ ...baseTarget, name: "  schema  " }))
    expect(decoded.name).toBe("schema")
    expect(() => new Target({ ...decoded, name: " schema ", enabled: true })).toThrow()
  })

  it("rejects target ids with trailing line breaks", async () => {
    await expect(Effect.runPromise(Schema.decodeUnknownEffect(TargetConfig)({
      ...baseTarget,
      id: "target_schema\n"
    }))).rejects.toBeTruthy()
  })

  it("reports malformed duration input as a structured InvalidValue issue", async () => {
    const error = await Effect.runPromise(Effect.flip(
      Schema.decodeUnknownEffect(TargetConfig)({ ...baseTarget, interval: "not a duration" }, { reportInput: true })
    ))

    expect(error.issue._tag).toBe("Encoding")
    if (error.issue._tag !== "Encoding") throw new Error("expected an Encoding issue")
    expect(error.issue.issue._tag).toBe("Composite")
    if (error.issue.issue._tag !== "Composite") throw new Error("expected a Composite issue")
    const interval = error.issue.issue.issues[0]
    expect(interval?._tag).toBe("Pointer")
    if (interval?._tag !== "Pointer") throw new Error("expected an interval Pointer issue")
    expect(interval.path).toEqual(["interval"])
    expect(interval.issue._tag).toBe("Encoding")
    if (interval.issue._tag !== "Encoding") throw new Error("expected a duration Encoding issue")
    expect(interval.issue.issue._tag).toBe("InvalidValue")
    if (interval.issue.issue._tag !== "InvalidValue") throw new Error("expected an InvalidValue issue")
    expect(interval.issue.issue.annotations).toEqual({ message: "invalid duration" })
    expect(interval.issue.issue.input).toBe("not a duration")
  })

  it("round-trips a nested CheckFailure through CheckResult", async () => {
    const original = new CheckResult({
      id: "check_failure_round_trip",
      targetId: "target_schema" as typeof CheckResult.Type["targetId"],
      checkedAt: new Date(0),
      duration: Duration.millis(25),
      classification: new Down(),
      failure: new CheckFailure({ reason: "connection refused" }),
      response: new ResponseMetadata({})
    })

    const encoded = await Effect.runPromise(Schema.encodeEffect(CheckResult)(original))
    expect(encoded.failure).toEqual({ _tag: "CheckFailure", reason: "connection refused" })

    const decoded = await Effect.runPromise(Schema.decodeUnknownEffect(CheckResult)(encoded))
    expect(decoded.failure).toBeInstanceOf(CheckFailure)
    expect(decoded.failure?.reason).toBe("connection refused")
  })

  it("rejects an open incident that already has a close time", async () => {
    await expect(Effect.runPromise(Schema.decodeUnknownEffect(Incident)({
      id: "incident_contradictory",
      targetId: "target_schema",
      openedAt: new Date(0),
      closedAt: Option.some(new Date(1)),
      status: "Open",
      reason: "down",
      latestCheckId: "check_1",
      summary: Option.none()
    }))).rejects.toBeTruthy()
  })

  it.each(["id", "latestCheckId", "reason", "summary"])("rejects lone surrogates in incident %s", async (field) => {
    const incident = {
      id: "incident_valid",
      targetId: "target_schema",
      openedAt: new Date(0),
      closedAt: Option.none(),
      status: "Open",
      reason: "well-formed reason",
      latestCheckId: "check_valid",
      summary: Option.some("well-formed summary"),
      [field]: field === "id"
        ? "incident_\uD800"
        : field === "summary"
        ? Option.some("summary \uD800")
        : `${field} \uD800`
    }
    await expect(Effect.runPromise(Schema.decodeUnknownEffect(Incident)(incident))).rejects.toBeTruthy()
  })

  it("rejects lone surrogates in check failure reasons", async () => {
    await expect(Effect.runPromise(Schema.decodeUnknownEffect(CheckFailure)({
      _tag: "CheckFailure",
      reason: "failure \uD800"
    }))).rejects.toBeTruthy()
  })

  it("rejects lone surrogates in check IDs", async () => {
    await expect(Effect.runPromise(Schema.decodeUnknownEffect(CheckResult)({
      id: "check_\uD800", targetId: "target_schema", checkedAt: new Date(0),
      duration: Duration.millis(1), classification: new Up(), response: new ResponseMetadata({})
    }))).rejects.toBeTruthy()
  })
})
