import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Result } from "effect";
import { CheckResult, Down, Incident, ResponseMetadata, Target, Up, targetId } from "../src/domain/schema.js";import { InMemoryCheckRepository } from "../src/repo/CheckRepository.js";
import { RepositoryError } from "../src/domain/errors.js";
import {
  layerForFile,
  makeTempFilename,
} from "../src/repo/SqliteCheckRepository.js";

const check = (id: string, tag: "Up" | "Down", at: number, duration: number | string = "1 ms") =>
  new CheckResult({
    id,
    targetId: targetId("target_api"),
    checkedAt: new Date(at),
    duration,
    classification: tag === "Up" ? new Up() : new Down(),
    response: new ResponseMetadata({ status: 200 }),
  });

describe("in-memory repository", () => {
  it.effect("transitions open, update, and close incidents", () =>
    Effect.gen(function*() {
      const repo = new InMemoryCheckRepository();
      expect(yield* Effect.promise(() => repo.applyCheck(check("check_1", "Down", 100)))).toBe("Opened");
      expect(yield* Effect.promise(() => repo.applyCheck(check("check_2", "Down", 200)))).toBe("Updated");
      expect(yield* Effect.promise(() => repo.applyCheck(check("check_3", "Up", 300)))).toBe("Closed");
      expect(Option.isNone(yield* Effect.promise(() => repo.getOpenIncident(targetId("target_api"))))).toBe(true);
      expect((yield* Effect.promise(() => repo.listChecks())).length).toBe(3);
    }));

  it.effect("older checks are saved but leave incident state unchanged", () =>
    Effect.gen(function*() {
      const repo = new InMemoryCheckRepository();
      expect(yield* Effect.promise(() => repo.applyCheck(check("check_2", "Down", 200)))).toBe("Opened");
      expect(yield* Effect.promise(() => repo.applyCheck(check("check_1", "Down", 100)))).toBe("Unchanged");
    }));

  it("exact duplicates are idempotent; conflicts fail", async () => {
    const repo = new InMemoryCheckRepository();
    const c = check("check_1", "Down", 100);
    await repo.saveCheck(c);
    await repo.saveCheck(c); // idempotent
    await expect(repo.saveCheck(check("check_1", "Down", 100, "2 ms"))).rejects.toBeInstanceOf(
      RepositoryError,
    );
  });

  it.effect("concurrent failures produce one Opened and one Updated", () =>
    Effect.gen(function*() {
      const repo = new InMemoryCheckRepository();
      const transitions = yield* Effect.promise(() =>
        Promise.all([
          repo.applyCheck(check("check_1", "Down", 100)),
          repo.applyCheck(check("check_2", "Down", 200)),
        ]),
      );
      expect(transitions.filter((t) => t === "Opened")).toHaveLength(1);
      expect(transitions.filter((t) => t === "Updated")).toHaveLength(1);
      const open = yield* Effect.promise(() => repo.getOpenIncident(targetId("target_api")));
      expect(Option.getOrThrow(open).latestCheckId).toBe("check_2");
    }));
});

describe("sqlite repository", () => {
  it.effect("saves targets in ascending bytewise id order", () =>
    Effect.gen(function*() {
      const repo = layerForFile(makeTempFilename());
      const makeTarget = (id: string) =>
        new Target({
          id: targetId(id),
          name: "T",
          url: "http://example.test",
          method: "GET",
          expectedStatus: [200],
          interval: "10 ms",
          timeout: "50 ms",
          slowThreshold: "100 ms",
          enabled: true,
        });
      yield* Effect.tryPromise(() => repo.saveTarget(makeTarget("target_b")));
      yield* Effect.tryPromise(() => repo.saveTarget(makeTarget("target_a")));
      const targets = yield* Effect.tryPromise(() => repo.listTargets());
      expect(targets.map((t) => t.id)).toEqual(["target_a", "target_b"]);
    }));

  it.effect("durations round-trip exactly through the codec", () =>
    Effect.gen(function*() {
      const repo = layerForFile(makeTempFilename());
      const fractional = check("check_frac", "Up", 100, 0.5); // sub-millisecond
      const whole = check("check_whole", "Up", 200, 42);
      const infinite = check("check_inf", "Up", 300, Number.POSITIVE_INFINITY);
      yield* Effect.tryPromise(() => repo.saveCheck(fractional));
      yield* Effect.tryPromise(() => repo.saveCheck(whole));
      yield* Effect.tryPromise(() => repo.saveCheck(infinite));
      const rows = yield* Effect.tryPromise(() => repo.listChecks());
      const byId = new Map(rows.map((c) => [c.id, c.duration]));
      expect(byId.get("check_frac")).toBe(0.5);
      expect(byId.get("check_whole")).toBe(42);
      expect(byId.get("check_inf")).toBe(Number.POSITIVE_INFINITY);
    }));

  it.effect("conflicting re-saves fail as repository errors", () =>
    Effect.gen(function*() {
      const repo = layerForFile(makeTempFilename());
      yield* Effect.tryPromise(() => repo.saveCheck(check("check_ok", "Up", 100)));
      const outcome = yield* Effect.result(
        Effect.tryPromise(() => repo.saveCheck(check("check_ok", "Up", 100, "9 ms"))),
      );
      expect(Result.isFailure(outcome)).toBe(true);
    }));
});

describe("incident validation", () => {
  it("rejects bad ids and inverted windows", () => {
    const base = {
      targetId: targetId("target_api"),
      openedAt: new Date(100),
      status: "Open" as const,
      reason: "r",
      latestCheckId: "check_1",
    };
    expect(() => new Incident({ ...base, id: "nope" })).toThrow();
    expect(() =>
      new Incident({ ...base, id: "incident_ok", status: "Closed", closedAt: new Date(50) }),
    ).toThrow();
  });
});
