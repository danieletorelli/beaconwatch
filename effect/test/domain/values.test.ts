import { it } from "@effect/vitest"
import { Duration, Effect, Equal, Option, Result, Schema } from "effect"
import { UnexpectedStatus } from "../../src/domain/errors.js"
import { TargetConfig, TargetId, Up } from "../../src/domain/schema.js"
import { classifyProbe, formatIncidentWindow, incidentCloseTime, makeCheckResult } from "../../src/domain/values.js"

const targetId = Schema.decodeUnknownSync(TargetId)("target_docs")
const target = new TargetConfig({
  id: targetId,
  name: "Docs",
  url: "https://example.com/health",
  method: "GET",
  expectedStatus: [200],
  interval: Duration.seconds(30),
  timeout: Duration.seconds(5),
  slowThreshold: Duration.seconds(1)
})

it.effect("Data check results compare structurally and keep Duration values", () =>
  Effect.sync(() => {
    const a = makeCheckResult({ id: "check_1", targetId, duration: Duration.millis(250), classification: new Up() })
    const b = makeCheckResult({ id: "check_1", targetId, duration: Duration.millis(250), classification: new Up() })
    if (!Equal.equals(a, b)) throw new Error("Data equality was not structural")
    if (!Equal.equals(a.duration, Duration.millis(250))) throw new Error("duration changed")
  })
)

it.effect("incidentCloseTime preserves Option absence/presence", () =>
  Effect.sync(() => {
    const open = incidentCloseTime({ closedAt: Option.none<Date>() })
    const closedAt = new Date("2026-01-01T00:00:00.000Z")
    const closed = incidentCloseTime({ closedAt: Option.some(closedAt) })
    if (Option.isSome(open)) throw new Error("open incident had close time")
    if (Option.getOrUndefined(closed) !== closedAt) throw new Error("closed incident lost close time")
  })
)

it.effect("classification helper returns Result success/failure deterministically", () =>
  Effect.sync(() => {
    const up = classifyProbe({ target, status: 200, duration: Duration.millis(100) })
    if (Result.isFailure(up) || up.success._tag !== "Up") throw new Error("expected Up classification")

    const unexpected = classifyProbe({ target, status: 500, duration: Duration.millis(100) })
    if (Result.isSuccess(unexpected)) throw new Error("expected unexpected status failure")
    if (!(unexpected.failure instanceof UnexpectedStatus) || unexpected.failure.actual !== 500) {
      throw new Error("failure did not carry UnexpectedStatus")
    }
  })
)


it.effect("formats incident windows with DateTime in a named time zone", () =>
  Effect.sync(() => {
    const window = formatIncidentWindow({
      openedAt: new Date("2026-01-15T12:00:00.000Z"),
      closedAt: Option.some(new Date("2026-01-15T12:30:00.000Z"))
    }, "America/New_York")
    if (window !== "2026-01-15T07:00:00.000-05:00 – 2026-01-15T07:30:00.000-05:00") {
      throw new Error(`unexpected DateTime window: ${window}`)
    }
  })
)
