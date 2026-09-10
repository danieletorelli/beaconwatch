import { it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { DnsError, RepositoryError, TimeoutError, type DomainError } from "../../src/domain/errors.js"
import { degradedCheckResult, recoverTransientProbe } from "../../src/services/RecoveryPolicy.js"
import { target } from "../helpers.js"

it.effect("selectively recovers targeted transient probe tags", () =>
  Effect.gen(function*() {
    const value = yield* recoverTransientProbe(Effect.fail(new DnsError({ host: "docs.example" })) as Effect.Effect<string, DomainError>, (e) => `degraded:${e._tag}`)
    if (value !== "degraded:DnsError") throw new Error(`unexpected recovery value ${value}`)
  })
)

it.effect("lets non-targeted repository failures propagate", () =>
  Effect.gen(function*() {
    const exit = yield* Effect.exit(recoverTransientProbe(Effect.fail(new RepositoryError({ operation: "saveCheck" })) as Effect.Effect<string, DomainError>, () => "degraded"))
    if (!Exit.isFailure(exit)) throw new Error("RepositoryError should still fail")
  })
)

it("assigns distinct ids to separate degraded checks at the same timestamp", () => {
  const checkedAt = new Date(0)
  const dns = degradedCheckResult(target("target_degraded_ids"), new DnsError({ host: "example.test" }), checkedAt)
  const timeout = degradedCheckResult(target("target_degraded_ids"), new TimeoutError({ timeout: "1 second" }), checkedAt)
  if (dns.id === timeout.id) {
    throw new Error(`separate degraded checks received duplicate id ${dns.id}`)
  }
})
