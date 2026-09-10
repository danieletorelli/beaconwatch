import { expect, it } from "vitest"
import { Duration, Effect, Exit } from "effect"
import { HealthBodyMismatch, HealthSchemaParseError } from "../../../src/domain/errors.js"
import * as Domain from "../../../src/domain/schema.js"
import { Target } from "../../../src/domain/schema.js"
import { decodeHealthSchema, probeOnce } from "../../../src/probe/ProbeProgram.js"
import { FakeProbeClient } from "../../../src/services/ProbeClient.js"

const duration = (millis: number): any => "DurationFromInput" in Domain ? Duration.millis(millis) : millis

it("DP-15", async () => {
  const exit = await Effect.runPromise(Effect.exit(decodeHealthSchema("not json")))
  expect(Exit.isFailure(exit) && exit.cause.reasons.some(r => r._tag === "Fail" && r.error instanceof HealthSchemaParseError)).toBe(true)
  const invalid = new Target({ id: "target_invalid_schema", name: "Invalid schema", url: "https://example.test", method: "GET", expectedStatus: [200], interval: duration(10), timeout: duration(50), slowThreshold: duration(20), healthBodySchema: JSON.stringify({ type: "bogus" }), enabled: true })
  const pending = probeOnce(invalid, new FakeProbeClient({ target_invalid_schema: { status: 200, body: {}, bytes: 1 } }))
  const result = Effect.isEffect(pending) ? await Effect.runPromise(pending) : await pending
  expect(result.failure?.reason).toBe(new HealthSchemaParseError({ reason: "" })._tag)
})
it("DP-50", async () => {
  const target = new Target({ id: "target_schema", name: "Schema", url: "https://example.test", method: "GET", expectedStatus: [200], interval: duration(10), timeout: duration(50), slowThreshold: duration(20), healthBodySchema: JSON.stringify({ type: "object", required: ["ok"], properties: { ok: { const: true } } }), enabled: true })
  const pending = probeOnce(target, new FakeProbeClient({ target_schema: { status: 200, body: { ok: false }, bytes: 1 } }))
  const result = Effect.isEffect(pending) ? await Effect.runPromise(pending) : await pending
  expect(result.failure?.reason).toBe(new HealthBodyMismatch()._tag)
  const acceptAll = new Target({ ...target, healthBodySchema: "true" })
  const acceptedPending = probeOnce(acceptAll, new FakeProbeClient({ target_schema: { status: 200, body: "anything", bytes: 1 } }))
  const accepted = Effect.isEffect(acceptedPending) ? await Effect.runPromise(acceptedPending) : await acceptedPending
  expect(accepted.classification._tag).toBe("Up")
  const rejectAll = new Target({ ...target, healthBodySchema: "false" })
  const rejectedPending = probeOnce(rejectAll, new FakeProbeClient({ target_schema: { status: 200, body: "anything", bytes: 1 } }))
  const rejected = Effect.isEffect(rejectedPending) ? await Effect.runPromise(rejectedPending) : await rejectedPending
  expect(rejected.failure?.reason).toBe(new HealthBodyMismatch()._tag)
})
