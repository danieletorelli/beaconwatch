import { describe, expect, it } from "vitest";
import { Duration, Equal, Option, Result } from "effect";
import { ConfigError } from "../../src/domain/errors.js";
import { TargetConfig, Up, durationMillis, targetId } from "../../src/domain/schema.js";
import { classifyProbe, formatIncidentWindow, incidentCloseTime, makeCheckResult, renameCheck } from "../../src/domain/values.js";

const target = new TargetConfig({ id: targetId("target_values"), name: "Values", url: "https://example.test", method: "GET", expectedStatus: [200], interval: Duration.millis(10), timeout: Duration.millis(20), slowThreshold: Duration.millis(5) });

describe("explicit domain values", () => {
  it("represents both close-time branches", () => {
    expect(Option.isNone(incidentCloseTime({}))).toBe(true);
    expect(Option.isSome(incidentCloseTime({ closedAt: new Date(0) }))).toBe(true);
  });
  it("returns expected classification results without throwing", () => {
    expect(Result.isFailure(classifyProbe({ target, status: 503, duration: Duration.millis(1) }))).toBe(true);
    const classified = classifyProbe({ target, duration: Duration.millis(1), failure: new ConfigError({ reason: "bad config" }) });
    expect(Result.isSuccess(classified)).toBe(true);
    if (Result.isSuccess(classified)) expect(classified.success._tag).toBe("Down");
    expect(formatIncidentWindow({ openedAt: new Date("2026-01-15T12:00:00.000Z"), closedAt: new Date("2026-01-15T12:30:00.000Z") }, "America/New_York")).toBe("2026-01-15T07:00:00.000-05:00 – 2026-01-15T07:30:00.000-05:00");
  });
  it("compares value objects and replaces fields immutably", () => {
    const a = makeCheckResult({ id: "a", targetId: targetId("target_values"), duration: Duration.millis(1), classification: new Up() });
    const b = makeCheckResult({ id: "a", targetId: targetId("target_values"), duration: Duration.millis(1), classification: new Up() });
    expect(Equal.equals(a, b)).toBe(true);
    const renamed = renameCheck(a, "b");
    expect(a.id).toBe("a");
    expect(renamed.id).toBe("b");
  });
  it("keeps numeric and explicit string durations in milliseconds", () => {
    expect(durationMillis(250)).toBe(250);
    expect(durationMillis("2 seconds")).toBe(2000);
  });
});
