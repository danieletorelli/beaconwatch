import { expect, it } from "vitest"
import { Duration, Option, Result } from "effect"
import { ConfigError } from "../../../src/domain/errors.js"
import * as Domain from "../../../src/domain/schema.js"
import { Incident, TargetConfig, Up, durationMillis, targetId } from "../../../src/domain/schema.js"
import { classifyProbe, formatIncidentWindow, incidentCloseTime, makeCheckResult, renameCheck, sameIncident } from "../../../src/domain/values.js"

const duration = (millis: number): any => "DurationFromInput" in Domain ? Duration.millis(millis) : millis
const target = new TargetConfig({ id: "target_dp", name: "DP", url: "https://example.test", method: "GET", expectedStatus: [200], interval: duration(10), timeout: duration(20), slowThreshold: duration(5) })
it("DP-03", () => expect(incidentCloseTime({})).toEqual(Option.none()))
it("DP-04", () => {
  const run = () => classifyProbe({ target, duration: duration(1), failure: new ConfigError({ reason: "bad" }) })
  expect(run).not.toThrow()
  const result = run()
  expect(Result.isSuccess(result)).toBe(true)
  if (Result.isSuccess(result)) expect(result.success._tag).toBe("Down")
  expect(formatIncidentWindow({ openedAt: new Date("2026-01-15T12:00:00.000Z") }, "America/New_York")).toBe("2026-01-15T07:00:00.000-05:00 – open")
})
it("DP-05", () => {
  const value = { id: "incident_1", targetId: targetId("target_dp"), openedAt: new Date(0), status: "Open" as const, reason: "down", latestCheckId: "check_1" }
  expect(sameIncident(new Incident(value), new Incident({ ...value, openedAt: new Date(0) }))).toBe(true)
})
it("DP-06", () => {
  const original = makeCheckResult({ id: "a", targetId: target.id, duration: duration(1), classification: new Up() })
  expect(renameCheck(original, "b")).not.toBe(original)
  expect(original.id).toBe("a")
})
it("DP-07", () => expect(durationMillis(50)).toBe(50))
