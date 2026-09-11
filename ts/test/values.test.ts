import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Result } from "effect";
import {
  CheckFailure,
  CheckResult,
  Down,
  Incident,
  ResponseMetadata,
  Target,
  TargetConfig,
  Up,
  targetId,
} from "../src/domain/schema.js";
import { targetJsonSchemaDocument } from "../src/domain/json-schema.js";
import { IncidentService } from "../src/services/IncidentService.js";
import { classifyDomainError } from "../src/domain/classify-match.js";
import { classifyProbe, formatIncidentWindow, renameCheck } from "../src/domain/values.js";
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

describe("boundary validation (BUGS 7.5, 7.6, 12.1)", () => {
  it("durationMillis rejects unparseable durations; positive() rejects non-positive ones", () => {
    expect(() => durationMillis("nonsense" as never)).toThrow();
    expect(() => durationMillis("5 fortnights" as never)).toThrow();
    // Raw parse keeps the numeric value; the positive boundary rejects it.
    expect(durationMillis("0 ms")).toBe(0);
    expect(durationMillis(-5)).toBe(-5);
    const base = {
      targetId: targetId("target_api"),
      duration: "1 ms",
      classification: new Up(),
      response: new ResponseMetadata({ status: 200 }),
    };
    expect(() => new CheckResult({ ...base, id: "check_x", checkedAt: new Date(100), duration: "0 ms" })).toThrow();
    expect(() => new CheckResult({ ...base, id: "check_x", checkedAt: new Date(100), duration: -1 })).toThrow();
  });

  it("targetId rejects malformed ids", () => {
    expect(() => targetId("nope")).toThrow();
    expect(() => targetId("target_OK")).toThrow(); // uppercase rejected
    expect(targetId("target_ok")).toBe("target_ok");
  });

  it("CheckResult rejects invalid timestamps and lone surrogates", () => {
    const base = {
      targetId: targetId("target_api"),
      duration: "1 ms",
      classification: new Up(),
      response: new ResponseMetadata({ status: 200 }),
    };
    expect(() => new CheckResult({ ...base, id: "check_x", checkedAt: new Date(Number.NaN) })).toThrow();
    expect(() =>
      new CheckResult({ ...base, id: "check_x", checkedAt: new Date(-62167219200000) }),
    ).toThrow(); // year 0000
    expect(() =>
      new CheckResult({ ...base, id: "check_\uD800", checkedAt: new Date(100) }),
    ).toThrow(); // lone surrogate id
    expect(() =>
      new CheckResult({
        ...base,
        id: "check_x",
        checkedAt: new Date(100),
        failure: new CheckFailure({ reason: "\uDC00" }),
      }),
    ).toThrow(); // lone surrogate reason
  });
});

describe("immutability freezes (BUGS 6.1, 12.3, Pattern 18)", () => {
  it("renameCheck returns a replacement without mutating its input", () => {
    const original = { id: "check_a", extra: 1 };
    const renamed = renameCheck(original, "check_b");
    expect(original.id).toBe("check_a");
    expect(renamed.id).toBe("check_b");
    expect(renamed).not.toBe(original);
  });

  it("domain values reject in-place mutation", () => {
    const check = new CheckResult({
      id: "check_a",
      targetId: targetId("target_api"),
      checkedAt: new Date(100),
      duration: "1 ms",
      classification: new Up(),
      response: new ResponseMetadata({ status: 200 }),
    });
    expect(() => {
      (check as { id: string }).id = "check_b";
    }).toThrow();
  });

  it("TargetConfig copies array inputs", () => {
    const statuses = [200, 301];
    const tags = ["prod"];
    const config = new TargetConfig({
      id: "target_api",
      name: "API",
      url: "http://example.test",
      method: "GET",
      expectedStatus: statuses,
      interval: "10 ms",
      timeout: "50 ms",
      slowThreshold: "100 ms",
      tags,
    });
    statuses.push(999);
    (tags as string[]).push("mutated");
    expect([...config.expectedStatus]).toEqual([200, 301]);
    expect([...(config.tags ?? [])]).toEqual(["prod"]);
  });
});

describe("json-schema artifact (BUGS 12.5)", () => {
  it("is derived from the boundary schema with its constraints", () => {
    const schema = targetJsonSchemaDocument.schema as {
      properties: Record<string, { pattern?: string; enum?: string[]; minimum?: number; maximum?: number }>;
      required?: string[];
    };
    expect(schema.properties.id?.pattern).toBe("^target_[a-z0-9][a-z0-9_-]*$");
    expect(schema.properties.method?.enum).toContain("GET");
    const status = schema.properties.expectedStatus as { items?: { minimum?: number; maximum?: number } };
    expect(status.items?.minimum).toBe(100);
    expect(status.items?.maximum).toBe(599);
    expect(schema.required).toContain("interval");
  });
});

describe("incident service (BUGS 4.1)", () => {
  it("acknowledge returns a settled effect that propagates repository failure", async () => {
    const failing = {
      saveTarget: async () => {},
      listTargets: async () => [],
      saveCheck: async () => {},
      listChecks: async () => [],
      getIncident: async () => Option.none(),
      getOpenIncident: async () => Option.none(),
      saveIncident: async () => {},
      applyCheck: async () => {
        throw new Error("repository down");
      },
    };
    const service = new IncidentService(failing as never);
    const check = new CheckResult({
      id: "check_1",
      targetId: targetId("target_api"),
      checkedAt: new Date(0),
      duration: "1 ms",
      classification: new Down(),
      response: new ResponseMetadata({ status: 200 }),
    });
    const outcome = await Effect.runPromise(Effect.result(service.acknowledge(check)));
    expect(Result.isFailure(outcome)).toBe(true);
    if (Result.isFailure(outcome)) expect(String(outcome.failure)).toContain("repository down");
  });

  it("acknowledge succeeds and returns the transition", async () => {
    const repo = new (await import("../src/repo/CheckRepository.js")).InMemoryCheckRepository();
    const service = new IncidentService(repo);
    const check = new CheckResult({
      id: "check_1",
      targetId: targetId("target_api"),
      checkedAt: new Date(0),
      duration: "1 ms",
      classification: new Down(),
      response: new ResponseMetadata({ status: 200 }),
    });
    expect(await Effect.runPromise(service.acknowledge(check))).toBe("Opened");
  });
});
