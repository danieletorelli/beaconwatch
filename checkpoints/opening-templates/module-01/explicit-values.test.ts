import { expect, it } from "vitest"
import { Equal, Option, Result } from "effect"
import { ConfigError } from "../../src/domain/errors.js"
import { Incident, TargetConfig, Up, durationMillis, targetId } from "../../src/domain/schema.js"
import { classifyProbe, formatIncidentWindow, incidentCloseTime, makeCheckResult, renameCheck, sameIncident } from "../../src/domain/values.js"

it("uses explicit optional, failure, value, and duration semantics", () => {
  const target = new TargetConfig({ id: targetId("target_values"), name: "Values", url: "https://example.test", method: "GET", expectedStatus: [200], interval: 10, timeout: 20, slowThreshold: 5 })
  expect(Option.isNone(incidentCloseTime({}) as any)).toBe(true)
  expect(Option.isSome(incidentCloseTime({ closedAt: new Date(0) }) as any)).toBe(true)
  expect(Result.isSuccess(classifyProbe({ target, status: 200, duration: 1 }) as any)).toBe(true)
  expect(Result.isFailure(classifyProbe({ target, status: 503, duration: 1 }) as any)).toBe(true)
  const classified = classifyProbe({ target, duration: 1, failure: new ConfigError({ reason: "bad config" }) }) as any
  expect(Result.isSuccess(classified)).toBe(true)
  if (Result.isSuccess(classified)) expect((classified as any).success._tag).toBe("Down")
  expect(formatIncidentWindow({ openedAt: new Date("2026-01-15T12:00:00.000Z"), closedAt: new Date("2026-01-15T12:30:00.000Z") }, "America/New_York")).toBe("2026-01-15T07:00:00.000-05:00 – 2026-01-15T07:30:00.000-05:00")
  const incident = { id: "incident_1", targetId: target.id, openedAt: new Date(0), status: "Open" as const, reason: "down", latestCheckId: "check_1" }
  expect(sameIncident(new Incident(incident), new Incident({ ...incident, openedAt: new Date(0) }))).toBe(true)
  const original = makeCheckResult({ id: "a", targetId: target.id, duration: 1, classification: new Up() })
  const equal = makeCheckResult({ id: "a", targetId: target.id, duration: 1, classification: new Up() })
  expect(Equal.equals(original, equal)).toBe(true)
  expect(renameCheck(original, "b")).not.toBe(original)
  expect(original.id).toBe("a")
  expect(durationMillis(250)).toBe(250)
  expect(durationMillis("2 seconds")).toBe(2000)
})
