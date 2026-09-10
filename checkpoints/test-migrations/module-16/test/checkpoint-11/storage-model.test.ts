import { describe, expect, it } from "vitest";
import { Duration, Effect, Equal, Schema } from "effect";
import { targetJsonSchemaDocument } from "../../src/domain/json-schema.js";
import { CheckResult, decodeTargetConfig, Target, TargetConfig, targetId } from "../../src/domain/schema.js";
import { decodeStoredCheck, StoredCheck, storedCheckJsonSchema } from "../../src/domain/storage.js";
import { InMemoryCheckRepository } from "../../src/repo/CheckRepository.js";
import { SqliteCheckRepository } from "../../src/repo/SqliteCheckRepository.js";
import { appConfig } from "../../src/services/Config.js";
import { digestFromStream } from "../../src/services/DigestService.js";

const valid = { id: "check_1", targetId: "target_api", checkedAt: "2026-01-01T00:00:00.000Z", durationMillis: 12, classification: { _tag: "Up" }, response: {} };
describe("schema-backed storage model", () => {
  it("compares checks by domain value rather than duration encoding", async () => {
    const check = await Effect.runPromise(decodeStoredCheck(valid));
    const equivalent = new CheckResult({ ...check, duration: Duration.nanos(12_000_000n) });
    const adjacent = new CheckResult({ ...check, duration: Duration.nanos(12_000_001n) });
    const memory = new InMemoryCheckRepository();
    await memory.saveCheck(check);
    await expect(memory.saveCheck(equivalent)).resolves.toBeUndefined();
    await expect(memory.applyCheck(equivalent)).resolves.toBe("Unchanged");
    await expect(memory.saveCheck(adjacent)).rejects.toMatchObject({ operation: "saveCheck" });
    await expect(digestFromStream([check, equivalent])).resolves.toMatchObject({ malformedRows: 0, targets: [{ checks: 1 }] });
    await expect(digestFromStream([check, adjacent])).resolves.toMatchObject({ malformedRows: 1, targets: [] });

    const sql = new SqliteCheckRepository();
    try {
      await sql.saveCheck(check);
      await expect(sql.saveCheck(equivalent)).resolves.toBeUndefined();
      await expect(sql.applyCheck(equivalent)).resolves.toBe("Unchanged");
      await expect(sql.saveCheck(adjacent)).rejects.toMatchObject({ operation: "saveCheck" });
      const legacy = JSON.stringify({ ...valid, id: "check_equivalent_legacy", duration: 7, durationMillis: undefined });
      await sql.execute(`insert into checks(id,json) values('check_equivalent_legacy','${legacy.replaceAll("'", "''")}')`);
      const equivalentLegacy = new CheckResult({ ...check, id: "check_equivalent_legacy", duration: Duration.nanos(7_000_000n) });
      await expect(sql.saveCheck(equivalentLegacy)).resolves.toBeUndefined();
    } finally { await sql.close(); }
  });

  it("decodes storage into domain and round-trips the encoded shape", async () => {
    const domain = await Effect.runPromise(decodeStoredCheck(valid));
    expect(domain.checkedAt).toBeInstanceOf(Date);
    const row = await Effect.runPromise(Schema.decodeUnknownEffect(StoredCheck)(valid));
    expect(await Effect.runPromise(Schema.encodeEffect(StoredCheck)(row))).toEqual(valid);
  });
  it("requires response and rejects non-positive durations", async () => {
    const { response: _absent, ...withoutResponse } = valid;
    await expect(Effect.runPromise(Schema.decodeUnknownEffect(StoredCheck)(withoutResponse))).rejects.toThrow("response");
    await expect(Effect.runPromise(decodeStoredCheck({ ...valid, durationMillis: 0 }))).rejects.toThrow("durationMillis");
  });
  it("reports a stable field path and derives JSON Schema", async () => {
    await expect(Effect.runPromise(decodeStoredCheck({ ...valid, targetId: 4 }))).rejects.toThrow("targetId");
    expect(JSON.stringify(storedCheckJsonSchema)).toContain("durationMillis");
  });
  it("derives target validation and keeps wire and domain representations distinct", async () => {
    const encoded = { id: "target_api", name: " API ", url: "https://example.test", method: "GET", expectedStatus: [200], interval: "1 second", timeout: "2 seconds", slowThreshold: "3 seconds" } as const;
    const domain = await Effect.runPromise(decodeTargetConfig(encoded));
    expect([domain.name, Duration.toMillis(domain.interval), Duration.toMillis(domain.timeout), Duration.toMillis(domain.slowThreshold)]).toEqual(["API", 1000, 2000, 3000]);
    const roundTrip = await Effect.runPromise(Schema.encodeEffect(TargetConfig)(domain));
    expect(roundTrip.name).toBe("API");
    expect([roundTrip.interval, roundTrip.timeout, roundTrip.slowThreshold]).toEqual([1000, 2000, 3000]);
    const decodedAgain = await Effect.runPromise(decodeTargetConfig(JSON.parse(JSON.stringify(roundTrip))));
    expect([decodedAgain.interval, decodedAgain.timeout, decodedAgain.slowThreshold].every(Duration.isDuration)).toBe(true);
    expect(JSON.stringify(targetJsonSchemaDocument)).toContain("slowThreshold");
    expect(() => new TargetConfig(encoded as any)).toThrow();
  });
  it("enforces positive constructed durations without excluding sub-millisecond values", () => {
    const canonical = { id: targetId("target_api"), name: "API", url: "https://example.test", method: "GET", expectedStatus: [200], interval: Duration.nanos(500_000n), timeout: Duration.nanos(500_000n), slowThreshold: Duration.nanos(500_000n), enabled: true } as const;
    expect(() => new Target(canonical)).not.toThrow();
    for (const field of ["interval", "timeout", "slowThreshold"] as const) {
      expect(() => new Target({ ...canonical, [field]: Duration.zero }), field).toThrow();
      expect(() => new Target({ ...canonical, [field]: Duration.millis(-1) }), field).toThrow();
    }
    expect(() => new Target({ ...canonical, interval: Duration.infinity, timeout: Duration.infinity, slowThreshold: Duration.infinity })).not.toThrow();
  });
  it("writes canonical rows, accepts exact duplicates, and reads pre-schema rows", async () => {
    const repo = new SqliteCheckRepository();
    try {
      const domain = await Effect.runPromise(decodeStoredCheck(valid));
      await repo.saveCheck(domain);
      await repo.saveCheck(domain);
      const infiniteCheck = new CheckResult({ ...domain, id: "check_infinite", duration: Duration.infinity });
      await repo.saveCheck(infiniteCheck);
      await repo.saveCheck(infiniteCheck);
      await repo.saveTarget(new Target({ id: targetId("target_infinite"), name: "Infinite", url: "https://example.test", method: "GET", expectedStatus: [200], interval: Duration.infinity, timeout: Duration.infinity, slowThreshold: Duration.infinity, enabled: true }));
      const legacyTarget = { id: "target_legacy", name: "Legacy", url: "https://legacy.example.test", method: "GET", expectedStatus: [200], interval: 4, timeout: 5, slowThreshold: 6, enabled: true };
      await repo.execute(`insert into targets(id,json) values('target_legacy','${JSON.stringify(legacyTarget).replaceAll("'", "''")}')`);
      const legacy = JSON.stringify({ ...valid, id: "check_legacy", duration: 7, durationMillis: undefined });
      await repo.execute(`insert into checks(id,json) values('check_legacy','${legacy.replaceAll("'", "''")}')`);
      const precise = new CheckResult({ ...domain, id: "check_precise", duration: Duration.nanos(9_007_199_254_740_993n) });
      await repo.saveCheck(precise);
      const checks = await repo.listChecks();
      expect(checks.map((check) => check.id)).toEqual(["check_1", "check_infinite", "check_legacy", "check_precise"]);
      expect(checks.slice(0, 3).map((check) => Duration.toMillis(check.duration))).toEqual([12, Infinity, 7]);
      expect(Equal.equals(checks.at(-1)!.duration, precise.duration)).toBe(true);
      const targets = await repo.listTargets();
      const infinite = targets.find((target) => target.id === "target_infinite")!;
      const legacyTargetRead = targets.find((target) => target.id === "target_legacy")!;
      expect([infinite.interval, infinite.timeout, infinite.slowThreshold].every((value) => value === Duration.infinity)).toBe(true);
      expect([legacyTargetRead.interval, legacyTargetRead.timeout, legacyTargetRead.slowThreshold].map(Duration.toMillis)).toEqual([4, 5, 6]);
    } finally { await repo.close(); }
  });
  it("preserves explicit false and zero configuration values", () => {
    const config = appConfig({ pollInterval: 1, probeTimeout: 1, workerConcurrency: 1, slowThreshold: 1, telemetryEnabled: false, maxIncidents: 0 });
    expect(config.telemetryEnabled).toBe(false);
    expect(config.maxIncidents).toBe(0);
  });
});
