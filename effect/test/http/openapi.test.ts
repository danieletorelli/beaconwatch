import { describe, expect, it } from "vitest"
import { Effect, Schema } from "effect"
import { openApiDocument } from "../../src/http/openapi.js"
import { CheckDto, IncidentDto, StatusDto, TargetDto } from "../../src/http/api.js"

describe("openapi", () => {
  it("includes /status", () => {
    expect((openApiDocument as any).paths["/status"]).toBeTruthy()
  })

  it("publishes the narrowed response contracts", () => {
    const responseSchema = (path: string) => (openApiDocument as any).paths[path].get.responses[200].content["application/json"].schema
    const statusSchema = responseSchema("/status")
    expect(statusSchema.properties.ok.enum).toEqual([true])
    expect(statusSchema.properties.targets.maximum).toBe(Number.MAX_SAFE_INTEGER)
    const incidentSchema = responseSchema("/incidents/{id}")
    expect(incidentSchema.properties.status.enum).toEqual(["Open", "Closed"])
    expect(incidentSchema.properties.id.pattern).toContain("^incident_")
    expect(responseSchema("/checks").items.properties.classification.enum).toEqual(["Up", "Slow", "Down", "InvalidResponse", "Unknown"])

    const targetSchema = responseSchema("/targets").items
    expect(targetSchema.properties.id.pattern).toContain("^target_")
    expect(targetSchema.properties.name.minLength).toBe(1)
    expect(targetSchema.properties.url).toMatchObject({ format: "uri", pattern: "^[Hh][Tt][Tt][Pp][Ss]?://" })
  })

  it.each(["HTTP://example.com", "HTTPS://example.com"])("route DTO accepts uppercase HTTP scheme %s", async (url) => {
    await expect(Effect.runPromise(Schema.decodeUnknownEffect(TargetDto)({ id: "target_x", name: "Example", url, enabled: true }))).resolves.toBeTruthy()
  })

  it.each([
    [StatusDto, { ok: false, targets: 1 }],
    [StatusDto, { ok: true, targets: -1 }],
    [StatusDto, { ok: true, targets: 1.5 }],
    [IncidentDto, { id: "incident_x", targetId: "target_x", status: "Pending", reason: "x" }],
    [CheckDto, { id: "check_x", targetId: "target_x", classification: "Healthy" }]
  ])("rejects DTO values outside the HTTP contract", async (schema, value) => {
    await expect(Effect.runPromise(Schema.decodeUnknownEffect(schema)(value))).rejects.toBeTruthy()
  })

  it.each([
    { id: "target_x", name: "   ", url: "https://example.com", enabled: true },
    { id: "target_x", name: "Example", url: "ftp://example.com", enabled: true }
  ])("rejects target DTO values outside the shared domain contract", async (value) => {
    await expect(Effect.runPromise(Schema.decodeUnknownEffect(TargetDto)(value))).rejects.toBeTruthy()
  })
})
