import { expect, it } from "vitest"
import { Effect } from "effect"
import { DnsError, InvalidBody, type DomainError } from "../../src/domain/errors.js"
import { assertCheckInvariant, exitKind, validatePositiveInterval } from "../../src/domain/defects.js"
import { policyDecision } from "../../src/domain/classify-match.js"
import { recoverTransientProbe } from "../../src/services/RecoveryPolicy.js"

it("separates failure channels, exhausts policy, and recovers selectively", async () => {
  const kinds = await Promise.all([validatePositiveInterval(0), assertCheckInvariant(false), Effect.interrupt].map(effect => Effect.runPromise(Effect.exit(effect as any)).then(exit => (exitKind as any)(exit))))
  expect(kinds).toEqual(["typed-failure", "defect", "interruption"])
  expect(policyDecision({ _tag: "Ignore" })).toBe("ignored")
  expect(policyDecision({ _tag: "Escalate" })).toBe("escalated")
  expect(policyDecision({ _tag: "Accept" })).toBe("accepted")
  expect(() => policyDecision({ _tag: "Page" } as never)).toThrow()
  await expect(Effect.runPromise((recoverTransientProbe as any)(Effect.fail(new DnsError({ host: "example.test" })) as Effect.Effect<string, DomainError>, () => "degraded"))).resolves.toBe("degraded")
  await expect(Effect.runPromise((recoverTransientProbe as any)(Effect.fail(new InvalidBody({ reason: "bad" })) as Effect.Effect<string, DomainError>, () => "degraded"))).rejects.toBeTruthy()
})
