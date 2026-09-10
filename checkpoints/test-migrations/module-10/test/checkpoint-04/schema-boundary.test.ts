import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";
import { HealthBodyMismatch, HealthSchemaParseError } from "../../src/domain/errors.js";
import { Target } from "../../src/domain/schema.js";
import { decodeHealthSchema, probeOnce } from "../../src/probe/ProbeProgram.js";
import { FakeProbeClient } from "../../src/services/ProbeClient.js";

const target = (schema: string) => new Target({ id: "target_schema", name: "Schema", url: "https://example.test", method: "GET", expectedStatus: [200], interval: 10, timeout: 50, slowThreshold: 20, healthBodySchema: schema, enabled: true });

describe("health schema boundary", () => {
  it("reports malformed schema input as a typed failure", async () => {
    const exit = await Effect.runPromise(Effect.exit(decodeHealthSchema("not json")));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(exit.cause.reasons.some((reason) => reason._tag === "Fail" && reason.error instanceof HealthSchemaParseError)).toBe(true);
  });
  it("maps valid JSON with an invalid schema to the typed parse outcome", async () => {
    const result = await Effect.runPromise(probeOnce(target(JSON.stringify({ type: "bogus" })), new FakeProbeClient({ target_schema: { status: 200, body: {}, bytes: 12 } })));
    expect(result.classification._tag).toBe("InvalidResponse");
    expect(result.failure?.reason).toBe(new HealthSchemaParseError({ reason: "" })._tag);
  });
  it("keeps a valid schema mismatch distinct", async () => {
    const result = await Effect.runPromise(probeOnce(target(JSON.stringify({ type: "object", required: ["ok"], properties: { ok: { const: true } } })), new FakeProbeClient({ target_schema: { status: 200, body: { ok: false }, bytes: 12 } })));
    expect(result.classification._tag).toBe("InvalidResponse");
    expect(result.failure?.reason).toBe(new HealthBodyMismatch()._tag);
  });
  it("accepts boolean JSON Schemas and preserves mismatch semantics", async () => {
    const accepted = await Effect.runPromise(probeOnce(target("true"), new FakeProbeClient({ target_schema: { status: 200, body: "anything", bytes: 12 } })));
    expect(accepted.classification._tag).toBe("Up");
    const rejected = await Effect.runPromise(probeOnce(target("false"), new FakeProbeClient({ target_schema: { status: 200, body: "anything", bytes: 12 } })));
    expect(rejected.classification._tag).toBe("InvalidResponse");
    expect(rejected.failure?.reason).toBe(new HealthBodyMismatch()._tag);
  });
});
