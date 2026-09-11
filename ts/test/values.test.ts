import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Layer, Option, Result } from "effect";
import {
  CheckFailure,
  CheckResult,
  Down,
  Incident,
  ResponseMetadata,
  Target,
  TargetConfig,
  Up,
  cloneCheck,
  targetId,
  type CheckId,
  type IncidentId,
  type TargetId,
} from "../src/domain/schema.js";
import { targetJsonSchemaDocument } from "../src/domain/json-schema.js";
import { IncidentService, IncidentServiceLive } from "../src/services/IncidentService.js";
import { CheckRepository, InMemoryLayer } from "../src/repo/CheckRepository.js";
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
  id: "target_api" as TargetId,
  name: "API",
  url: "http://example.test",
  method: "GET",
  expectedStatus: [200] as [number, ...number[]],
  interval: Duration.millis(10),
  timeout: Duration.millis(50),
  slowThreshold: Duration.millis(100),
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
    id: "incident_ok" as IncidentId,
    targetId: targetId("target_api"),
    openedAt: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)),
    status: "Open",
    reason: "r",
    latestCheckId: "check_1",
    summary: Option.none(),
    closedAt: Option.none(),
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
      closedAt: Option.some(new Date(Date.UTC(2026, 0, 2, 5, 0, 0))),
      reason: incident.reason,
      latestCheckId: incident.latestCheckId,
      summary: incident.summary,
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
      duration: Duration.millis(1),
      classification: new Up(),
      failure: Option.none(),
      response: new ResponseMetadata({ status: Option.some(200), bytes: Option.none() }),
    };
    expect(() => new CheckResult({ ...base, id: "check_x" as CheckId, checkedAt: new Date(100), duration: Duration.millis(0) })).toThrow();
    expect(() => new CheckResult({ ...base, id: "check_x" as CheckId, checkedAt: new Date(100), duration: Duration.millis(-1) })).toThrow();
  });

  it("targetId rejects malformed ids", () => {
    expect(() => targetId("nope")).toThrow();
    expect(() => targetId("target_OK")).toThrow(); // uppercase rejected
    expect(targetId("target_ok")).toBe("target_ok");
  });

  it("CheckResult rejects invalid timestamps and lone surrogates", () => {
    const base = {
      targetId: targetId("target_api"),
      duration: Duration.millis(1),
      classification: new Up(),
      failure: Option.none(),
      response: new ResponseMetadata({ status: Option.some(200), bytes: Option.none() }),
    };
    expect(() => new CheckResult({ ...base, id: "check_x" as CheckId, checkedAt: new Date(Number.NaN) })).toThrow();
    expect(() =>
      new CheckResult({ ...base, id: "check_x" as CheckId, checkedAt: new Date(-62167219200000) }),
    ).toThrow(); // year 0000
    expect(() =>
      new CheckResult({ ...base, id: "check_\uD800" as CheckId, checkedAt: new Date(100) }),
    ).toThrow(); // lone surrogate id
    expect(() =>
      new CheckResult({
        ...base,
        id: "check_x" as CheckId,
        checkedAt: new Date(100),
        failure: Option.some(new CheckFailure({ reason: "\uDC00" })),
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

  it("clones are independent: mutating a clone never affects the original", () => {
    const check = new CheckResult({
      id: "check_a" as CheckId,
      targetId: targetId("target_api"),
      checkedAt: new Date(100),
      duration: Duration.millis(1),
      classification: new Up(),
      failure: Option.some(new CheckFailure({ reason: "r" })),
      response: new ResponseMetadata({ status: Option.some(200), bytes: Option.none() }),
    });
    const clone = cloneCheck(check);
    // The nested failure instance of the clone is a distinct object.
    expect(Option.getOrThrow(clone.failure)).not.toBe(Option.getOrThrow(check.failure));
    expect(Option.getOrThrow(clone.failure).reason).toBe("r");
    expect(clone.response).not.toBe(check.response);
    expect(Option.getOrThrow(clone.response.status)).toBe(200);
  });

  it("TargetConfig copies array inputs", () => {
    const statuses = [200, 301];
    const tags = ["prod"];
    const config = new TargetConfig({
      id: "target_api" as TargetId,
      name: "API",
      url: "http://example.test",
      method: "GET",
      expectedStatus: statuses as [number, ...number[]],
      interval: Duration.millis(10),
      timeout: Duration.millis(50),
      slowThreshold: Duration.millis(100),
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
    const schema = (targetJsonSchemaDocument.definitions as Record<
      string,
      {
        properties: Record<string, { pattern?: string; enum?: string[]; minimum?: number; maximum?: number }>;
        required?: string[];
      }
    >)["TargetConfigEncoded"]!;
    expect(schema.properties.id?.pattern).toBe("^target_[a-z0-9][a-z0-9_-]*$");
    expect(schema.properties.method?.enum).toContain("GET");
    const status = schema.properties.expectedStatus as { items?: { minimum?: number; maximum?: number } };
    expect(status.items?.minimum).toBe(100);
    expect(status.items?.maximum).toBe(599);
    expect(schema.required).toContain("interval");
  });
});

describe("incident service (BUGS 4.1)", () => {
  it.effect("acknowledge returns a settled effect that propagates repository failure (BUGS 4.1)", () =>
    Effect.gen(function*() {
      const service = yield* IncidentService;
      const check = new CheckResult({
        id: "check_1" as CheckId,
        targetId: targetId("target_api"),
        checkedAt: new Date(0),
        duration: Duration.millis(1),
        classification: new Down(),
        failure: Option.none(),
        response: new ResponseMetadata({ status: Option.some(200), bytes: Option.none() }),
      });
      const outcome = yield* Effect.result(service.acknowledge(check));
      expect(Result.isFailure(outcome)).toBe(true);
      if (Result.isFailure(outcome))
        expect(String((outcome.failure as { cause: unknown }).cause)).toContain("repository down");
    }).pipe(
      Effect.provide(Layer.provide(
        IncidentServiceLive,
        Layer.succeed(CheckRepository)({
          saveTarget: Effect.void,
          listTargets: Effect.succeed([]),
          saveCheck: Effect.void,
          listChecks: Effect.succeed([]),
          getIncident: Effect.succeed(Option.none()),
          getOpenIncident: Effect.succeed(Option.none()),
          saveIncident: Effect.void,
          applyCheck: () =>
            Effect.fail(new RepositoryError({ operation: "x", cause: "repository down" })),
        } as never),
      )),
    ));

  it.effect("acknowledge succeeds and returns the transition", () =>
    Effect.gen(function*() {
      const service = yield* IncidentService;
      const check = new CheckResult({
        id: "check_1" as CheckId,
        targetId: targetId("target_api"),
        checkedAt: new Date(0),
        duration: Duration.millis(1),
        classification: new Down(),
        failure: Option.none(),
        response: new ResponseMetadata({ status: Option.some(200), bytes: Option.none() }),
      });
      expect(yield* service.acknowledge(check)).toBe("Opened");
    }).pipe(Effect.provide(Layer.provide(IncidentServiceLive, InMemoryLayer))));
});
