import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Option, Result } from "effect";
import { CheckResult, Down, Incident, ResponseMetadata, Target, Up, targetId, durationMillis, type CheckId, type IncidentId } from "../src/domain/schema.js";import { InMemoryCheckRepository } from "../src/repo/CheckRepository.js";
import { RepositoryError } from "../src/domain/errors.js";
import {
  SqliteCheckRepository,
  layerForFile,
  makeTempFilename,
} from "../src/repo/SqliteCheckRepository.js";

const check = (id: string, tag: "Up" | "Down", at: number, duration: number | string = "1 ms") =>
  new CheckResult({
    id: id as CheckId,
    targetId: targetId("target_api"),
    checkedAt: new Date(at),
    duration: typeof duration === "number" ? Duration.millis(duration) : Duration.millis(durationMillis(duration)),
    classification: tag === "Up" ? new Up() : new Down(),
    failure: Option.none(),
    response: new ResponseMetadata({ status: Option.some(200), bytes: Option.none() }),
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
          interval: Duration.millis(10),
          timeout: Duration.millis(50),
          slowThreshold: Duration.millis(100),
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
      const byId = new Map(rows.map((c) => [c.id, Duration.toMillis(c.duration)]));
      expect(byId.get("check_frac" as CheckId)).toBe(0.5);
      expect(byId.get("check_whole" as CheckId)).toBe(42);
      expect(byId.get("check_inf" as CheckId)).toBe(Number.POSITIVE_INFINITY);
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

describe("sqlite outbox and decode (BUGS 15.2, 15.3, 15.5, decode fix)", () => {
  it("persists events inside the transaction and delivers only after commit", async () => {
    const delivered: number[] = [];
    const repo = new SqliteCheckRepository(makeTempFilename(), (id) => {
      delivered.push(id);
      throw new Error("delivery failure after commit");
    });
    await expect(repo.applyCheck(check("check_1", "Down", 100))).rejects.toThrow(
      "delivery failure after commit",
    );
    // The transition was already committed when delivery ran — the event and
    // outbox rows survive the failed delivery.
    const events = repo.db.prepare("select id,event_type from incident_events").all() as Array<{ id: number; event_type: string }>;
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe("Opened");
    const outbox = repo.db.prepare("select event_id, delivered_at from delivery_outbox").all() as Array<{ event_id: number; delivered_at: number | null }>;
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.delivered_at).toBeNull();
    // The event was already committed when delivery ran — even though the
    // delivery callback fails, the transition is durable.
    expect(delivered).toEqual([outbox[0]!.event_id]);
    const open = await repo.getOpenIncident(targetId("target_api"));
    expect(Option.getOrThrow(open).latestCheckId).toBe("check_1");
    expect(Option.getOrThrow(open).status).toBe("Open");
    repo.db.close();
  });

  it("incidents round-trip with closed windows intact", async () => {
    const repo = new SqliteCheckRepository(makeTempFilename());
    await repo.applyCheck(check("check_1", "Down", 100));
    await repo.applyCheck(check("check_2", "Up", 200));
    const incidents = repo.db.prepare("select id from incidents").all() as Array<{ id: string }>;
    const incident = await repo.getIncident(incidents[0]!.id);
    const value = Option.getOrThrow(incident);
    expect(value.status).toBe("Closed");
    expect(Option.isSome(value.closedAt)).toBe(true);
    expect(Option.getOrThrow(value.closedAt).getTime()).toBeGreaterThanOrEqual(200);
    repo.db.close();
  });

  it("unknown duration encodings fail as repository errors (15.5)", async () => {
    const repo = new SqliteCheckRepository(makeTempFilename());
    repo.db
      .prepare("insert into checks(id,json) values(?,?)")
      .run(
        "check_bad",
        JSON.stringify({
          id: "check_bad",
          targetId: "target_api",
          checkedAt: new Date(0).toISOString(),
          duration: { tag: "bogus", nonsense: 1 },
          classification: { _tag: "Up" },
          failure: { _id: "Option", _tag: "None" },
          response: {
            status: { _id: "Option", _tag: "None" },
            bytes: { _id: "Option", _tag: "None" },
          },
        }),
      );
    await expect(repo.listChecks()).rejects.toBeInstanceOf(RepositoryError);
    repo.db.close();
  });
});

describe("incident validation", () => {
  it("rejects bad ids and inverted windows", () => {
    const base = {
      targetId: targetId("target_api"),
      openedAt: new Date(100),
      status: "Open" as const,
      reason: "r",
      latestCheckId: "check_1",
      summary: Option.none() as Option.Option<string>,
      closedAt: Option.none() as Option.Option<Date>,
    };
    expect(() => new Incident({ ...base, id: "nope" as IncidentId })).toThrow();
    expect(() =>
      new Incident({
        ...base,
        id: "incident_ok" as IncidentId,
        status: "Closed",
        closedAt: Option.some(new Date(50)),
      }),
    ).toThrow();
  });
});
