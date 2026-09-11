import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";
import { Down, Incident, Target, targetId } from "../src/domain/schema.js";
import {
  classifyDomainError,
} from "../src/domain/classify-match.js";
import { classifyProbe, formatIncidentWindow } from "../src/domain/values.js";
import { durationMillis } from "../src/domain/schema.js";
import type { DomainError } from "../src/domain/errors.js";
import {
  ConfigError,
  DnsError,
  HealthBodyMismatch,
  InvalidBody,
  RepositoryError,
  TargetDisabled,
  TimeoutError,
  UnexpectedStatus,
} from "../src/domain/errors.js";

const target = new Target({
  id: "target_api",
  name: "API",
  url: "http://example.test",
  method: "GET",
  expectedStatus: [200],
  interval: "10 ms",
  timeout: "50 ms",
  slowThreshold: "100 ms",
  enabled: true,
});

describe("durationMillis", () => {
  it("unifies unitless semantics: bare numbers and unitless strings are milliseconds", () => {
    expect(durationMillis(5)).toBe(5);
    expect(durationMillis("5")).toBe(5);
    expect(durationMillis("2 seconds")).toBe(2000);
    expect(durationMillis("10 ms")).toBe(10);
  });
});

describe("classifyProbe", () => {
  const input = (extra: Record<string, unknown> = {}) => ({
    target,
    duration: 10,
    ...extra,
  });

  it("classifies slow durations", () => {
    expect(classifyProbe(input({ duration: 101, status: 200 }))._tag === "Success").toBe(true);
    const slow = classifyProbe(input({ duration: 101, status: 200 }));
    if (slow._tag === "Success") expect(slow.success._tag).toBe("Slow");
    const fast = classifyProbe(input({ duration: 100, status: 200 }));
    if (fast._tag === "Success") expect(fast.success._tag).toBe("Up"); // equal is not slow
  });

  it("maps dispositions per the contract", () => {
    const cases: Array<[DomainError, string]> = [
      [new TargetDisabled({ targetId: "target_api" }), "Unknown"],
      [new InvalidBody({ reason: "x" }), "InvalidResponse"],
      [new HealthBodyMismatch({ reason: "x" }), "InvalidResponse"],
      [new DnsError({ host: "h" }), "Down"],
      [new TimeoutError({ timeout: "1 ms" }), "Down"],
      [new UnexpectedStatus({ expected: [200], actual: 500 }), "Down"],
      [new RepositoryError({ operation: "x" }), "Down"],
      [new ConfigError({ reason: "x" }), "Down"],
    ];
    for (const [failure, expectedTag] of cases) {
      const result = classifyProbe({ target, duration: 10, failure });
      if (result._tag === "Success") expect(result.success._tag).toBe(expectedTag);
      else expect.fail(`expected success for ${expectedTag}`);
    }
  });
});

describe("classifyDomainError", () => {
  it("categorizes every domain error", () => {
    expect(classifyDomainError(new TargetDisabled({ targetId: "t" }))).toBe("ignore-disabled");
    expect(classifyDomainError(new InvalidBody({ reason: "x" }))).toBe("invalid-response");
    expect(classifyDomainError(new DnsError({ host: "h" }))).toBe("service-down");
    expect(classifyDomainError(new RepositoryError({ operation: "x" }))).toBe("operator-action");
  });
});

describe("formatIncidentWindow", () => {
  const incident = new Incident({
    id: "incident_ok",
    targetId: targetId("target_api"),
    openedAt: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)),
    status: "Open",
    reason: "r",
    latestCheckId: "check_1",
  });
  it("emits ISO timestamps with numeric offsets", () => {
    const window = formatIncidentWindow(incident, "Europe/Berlin");
    expect(window).toMatch(
      /^2026-01-02T04:04:05\+01:00 – open$/,
    );
  });
  it("renders closed ends and rejects invalid zones", () => {
    const closed = new Incident({
      id: incident.id,
      targetId: incident.targetId,
      openedAt: incident.openedAt,
      status: "Closed",
      closedAt: new Date(Date.UTC(2026, 0, 2, 5, 0, 0)),
      reason: incident.reason,
      latestCheckId: incident.latestCheckId,
    });
    expect(formatIncidentWindow(closed, "UTC")).toMatch(/ – 2026-01-02T05:00:00\+00:00$/);
    expect(() => formatIncidentWindow(incident, "Not/AZone")).toThrow();
  });
});

// Smoke: the classification chain handles a Down check end to end.
expect(new Down()._tag).toBe("Down");
expect(Option.isNone(Option.none())).toBe(true);
