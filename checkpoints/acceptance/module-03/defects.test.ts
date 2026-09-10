import { expect, it } from "vitest"
import { Effect } from "effect"
import { DnsError, InvalidBody, type DomainError } from "../../../src/domain/errors.js"
import { assertCheckInvariant, exitKind, validatePositiveInterval } from "../../../src/domain/defects.js"
import { policyDecision } from "../../../src/domain/classify-match.js"
import { recoverTransientProbe } from "../../../src/services/RecoveryPolicy.js"

it("DP-10", async () => expect(await Promise.all([validatePositiveInterval(0), assertCheckInvariant(false), Effect.interrupt].map(e => Effect.runPromise(Effect.exit(e)).then(exitKind)))).toEqual(["typed-failure", "defect", "interruption"]))
it("DP-11", () => expect(() => policyDecision({ _tag: "Page" } as never)).toThrow())
it("DP-12", async () => {
  await expect(Effect.runPromise(recoverTransientProbe(Effect.fail(new DnsError({ host: "x" })) as Effect.Effect<string, DomainError>, () => "fallback"))).resolves.toBe("fallback")
  await expect(Effect.runPromise(recoverTransientProbe(Effect.fail(new InvalidBody({ reason: "bad" })) as Effect.Effect<string, DomainError>, () => "fallback"))).rejects.toBeTruthy()
})
