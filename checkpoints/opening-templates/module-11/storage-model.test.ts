import { expect, it } from "vitest"
import { Duration, Effect, Equal, Schema } from "effect"
import { InMemoryCheckRepository } from "../../src/repo/CheckRepository.js"
import { digestFromStream } from "../../src/services/DigestService.js"
import { appConfig } from "../../src/services/Config.js"

const valid = { id: "check_1", targetId: "target_api", checkedAt: "2026-01-01T00:00:00.000Z", durationMillis: 12, classification: { _tag: "Up" }, response: {} }

it("derives storage and target wire contracts without losing explicit values", async () => {
  const storage = await import("../../src/domain/" + "storage.js").catch(() => undefined)
  const schema = await import("../../src/domain/" + "schema.js")
  const jsonSchema = await import("../../src/domain/" + "json-schema.js").catch(() => undefined)
  expect(storage, "implement the schema-backed storage boundary").toBeDefined()
  expect(jsonSchema, "derive the public target JSON Schema").toBeDefined()
  const { decodeStoredCheck, StoredCheck, storedCheckJsonSchema } = storage!
  const { decodeTargetConfig, TargetConfig } = schema as any
  const domain: any = await Effect.runPromise(decodeStoredCheck(valid) as any)
  expect(domain.checkedAt).toBeInstanceOf(Date)
  const equivalent = new (schema as any).CheckResult({ ...domain, duration: Duration.nanos(12_000_000n) })
  const adjacent = new (schema as any).CheckResult({ ...domain, duration: Duration.nanos(12_000_001n) })
  const memory = new InMemoryCheckRepository()
  await memory.saveCheck(domain)
  await expect(memory.saveCheck(equivalent)).resolves.toBeUndefined()
  await expect(memory.applyCheck(equivalent)).resolves.toBe("Unchanged")
  await expect(memory.saveCheck(adjacent)).rejects.toMatchObject({ operation: "saveCheck" })
  await expect(digestFromStream([domain, equivalent])).resolves.toMatchObject({ malformedRows: 0, targets: [{ checks: 1 }] })
  await expect(digestFromStream([domain, adjacent])).resolves.toMatchObject({ malformedRows: 1, targets: [] })
  const row = await Effect.runPromise(Schema.decodeUnknownEffect(StoredCheck)(valid) as any)
  expect(await Effect.runPromise(Schema.encodeEffect(StoredCheck)(row) as any)).toEqual(valid)
  const { response: _response, ...withoutResponse } = valid
  expect(((await Effect.runPromise(Schema.decodeUnknownEffect(StoredCheck)(withoutResponse) as any)) as any).response).toBeUndefined()
  await expect(Effect.runPromise(decodeStoredCheck({ ...valid, durationMillis: 0 }))).rejects.toThrow("durationMillis")
  await expect(Effect.runPromise(decodeStoredCheck({ ...valid, targetId: 4 }))).rejects.toThrow("targetId")
  expect(JSON.stringify(storedCheckJsonSchema)).toContain("durationMillis")

  const encoded = { id: "target_api", name: " API ", url: "https://example.test", method: "GET", expectedStatus: [200], interval: "1 second", timeout: "2 seconds", slowThreshold: "3 seconds" } as const
  const target: any = await Effect.runPromise(decodeTargetConfig(encoded) as any)
  expect([target.name, Duration.toMillis(target.interval), Duration.toMillis(target.timeout), Duration.toMillis(target.slowThreshold)]).toEqual(["API", 1000, 2000, 3000])
  const roundTrip = await Effect.runPromise(Schema.encodeEffect(TargetConfig)(target) as any) as any
  expect([roundTrip.interval, roundTrip.timeout, roundTrip.slowThreshold]).toEqual([1000, 2000, 3000])
  const decodedAgain: any = await Effect.runPromise(decodeTargetConfig(JSON.parse(JSON.stringify(roundTrip))) as any)
  expect([decodedAgain.interval, decodedAgain.timeout, decodedAgain.slowThreshold].every(Duration.isDuration)).toBe(true)
  expect(() => new TargetConfig(encoded as any)).toThrow()
  expect(JSON.stringify(jsonSchema!.targetJsonSchemaDocument)).toContain("slowThreshold")

  const canonical = { id: "target_api", name: "API", url: "https://example.test", method: "GET", expectedStatus: [200], interval: Duration.nanos(500_000n), timeout: Duration.nanos(500_000n), slowThreshold: Duration.nanos(500_000n), enabled: true }
  expect(() => new (schema as any).Target(canonical)).not.toThrow()
  for (const field of ["interval", "timeout", "slowThreshold"] as const) {
    expect(() => new (schema as any).Target({ ...canonical, [field]: Duration.zero }), field).toThrow()
    expect(() => new (schema as any).Target({ ...canonical, [field]: Duration.millis(-1) }), field).toThrow()
  }
  const infinite = new (schema as any).Target({ ...canonical, id: "target_infinite", interval: Duration.infinity, timeout: Duration.infinity, slowThreshold: Duration.infinity })

  const { SqliteCheckRepository } = await import("../../src/repo/" + "SqliteCheckRepository.js")
  const repo: any = new SqliteCheckRepository()
  try {
    await repo.saveCheck(domain)
    await repo.saveCheck(domain)
    const infiniteCheck = new (schema as any).CheckResult({ ...domain, id: "check_infinite", duration: Duration.infinity })
    await repo.saveCheck(infiniteCheck)
    await repo.saveCheck(infiniteCheck)
    await repo.saveTarget(infinite)
    const legacyTarget = { id: "target_legacy", name: "Legacy", url: "https://legacy.example.test", method: "GET", expectedStatus: [200], interval: 4, timeout: 5, slowThreshold: 6, enabled: true }
    if (typeof repo.execute === "function") await repo.execute(`insert into targets(id,json) values('target_legacy','${JSON.stringify(legacyTarget).replaceAll("'", "''")}')`)
    else repo.db.prepare("insert into targets values(?,?)").run("target_legacy", JSON.stringify(legacyTarget))
    const legacy = JSON.stringify({ ...valid, id: "check_legacy", duration: 7, durationMillis: undefined })
    if (typeof repo.execute === "function") await repo.execute(`insert into checks(id,json) values('check_legacy','${legacy.replaceAll("'", "''")}')`)
    else repo.db.prepare("insert into checks values(?,?)").run("check_legacy", legacy)
    const equivalentLegacy = new (schema as any).CheckResult({ ...domain, id: "check_legacy", duration: Duration.nanos(7_000_000n) })
    await expect(repo.saveCheck(equivalentLegacy)).resolves.toBeUndefined()
    const precise = new (schema as any).CheckResult({ ...domain, id: "check_precise", duration: Duration.nanos(9_007_199_254_740_993n) })
    await repo.saveCheck(precise)
    const checks = await repo.listChecks()
    expect(checks.map((check: any) => check.id)).toEqual(["check_1", "check_infinite", "check_legacy", "check_precise"])
    expect(Equal.equals(checks.at(-1).duration, precise.duration)).toBe(true)
    const targets = await repo.listTargets()
    const infiniteRead = targets.find((target: any) => target.id === "target_infinite")
    const legacyRead = targets.find((target: any) => target.id === "target_legacy")
    expect([infiniteRead.interval, infiniteRead.timeout, infiniteRead.slowThreshold].every((value: unknown) => value === Duration.infinity)).toBe(true)
    expect([legacyRead.interval, legacyRead.timeout, legacyRead.slowThreshold].map(Duration.toMillis)).toEqual([4, 5, 6])
  } finally { await repo.close() }

  const config = appConfig({ pollInterval: 1, probeTimeout: 1, workerConcurrency: 1, slowThreshold: 1, telemetryEnabled: false, maxIncidents: 0 })
  expect([config.telemetryEnabled, config.maxIncidents]).toEqual([false, 0])
})
