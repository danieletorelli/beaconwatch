import { expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { Target, targetId } from "../../src/domain/schema.js"
import { decodeHealthSchema, probeOnce } from "../../src/probe/ProbeProgram.js"
import { FakeProbeClient } from "../../src/services/ProbeClient.js"

it("reports malformed schemas and valid-schema mismatches as typed results", async () => {
  const errors = await import("../../src/domain/" + "errors.js") as any
  expect(errors.HealthSchemaParseError, "add a typed malformed-schema error").toBeDefined()
  expect(errors.HealthBodyMismatch, "add a typed health-body mismatch").toBeDefined()
  const exit = await Effect.runPromise(Effect.exit(decodeHealthSchema("not json") as any))
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(exit.cause.reasons.some(reason => reason._tag === "Fail" && reason.error instanceof errors.HealthSchemaParseError)).toBe(true)
  const invalidSchemaTarget = new Target({ id: targetId("target_invalid_schema"), name: "Invalid schema", url: "https://example.test", method: "GET", expectedStatus: [200], interval: 10, timeout: 50, slowThreshold: 20, healthBodySchema: JSON.stringify({ type: "bogus" }), enabled: true })
  const invalidCandidate: any = probeOnce(invalidSchemaTarget, new FakeProbeClient({ target_invalid_schema: { status: 200, body: {}, bytes: 1 } }))
  const invalidResult = Effect.isEffect(invalidCandidate) ? await Effect.runPromise(invalidCandidate as Effect.Effect<any, any, never>) : await invalidCandidate
  expect(invalidResult.classification._tag).toBe("InvalidResponse")
  expect(invalidResult.failure?.reason).toBe(new errors.HealthSchemaParseError({ reason: "" })._tag)
  const target = new Target({ id: targetId("target_schema"), name: "Schema", url: "https://example.test", method: "GET", expectedStatus: [200], interval: 10, timeout: 50, slowThreshold: 20, healthBodySchema: JSON.stringify({ type: "object", required: ["ok"], properties: { ok: { const: true } } }), enabled: true })
  const candidate = probeOnce(target, new FakeProbeClient({ target_schema: { status: 200, body: { ok: false }, bytes: 1 } }))
  const result: any = Effect.isEffect(candidate) ? await Effect.runPromise(candidate as any) : await candidate
  expect(result.classification._tag).toBe("InvalidResponse")
  expect(result.failure?.reason).toBe(new errors.HealthBodyMismatch()._tag)
  const accepted: any = probeOnce(new Target({ ...target, healthBodySchema: "true" }), new FakeProbeClient({ target_schema: { status: 200, body: "anything", bytes: 1 } }))
  expect((Effect.isEffect(accepted) ? await Effect.runPromise(accepted as Effect.Effect<any, any, never>) : await accepted).classification._tag).toBe("Up")
  const rejected: any = probeOnce(new Target({ ...target, healthBodySchema: "false" }), new FakeProbeClient({ target_schema: { status: 200, body: "anything", bytes: 1 } }))
  const falseResult = Effect.isEffect(rejected) ? await Effect.runPromise(rejected as Effect.Effect<any, any, never>) : await rejected
  expect(falseResult.classification._tag).toBe("InvalidResponse")
  expect(falseResult.failure?.reason).toBe(new errors.HealthBodyMismatch()._tag)
})
