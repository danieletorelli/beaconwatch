import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { CheckFailure, CheckResult, Down, ResponseMetadata, type Target, type TargetConfig } from "../domain/schema.js"
import { DnsError, TimeoutError, type DomainError } from "../domain/errors.js"

export const degradedCheckResult = (target: Target | TargetConfig, error: DnsError | TimeoutError, checkedAt: Date) =>
  new CheckResult({
    id: `degraded_${randomUUID()}`,
    targetId: target.id,
    checkedAt,
    duration: target.timeout,
    classification: new Down(),
    failure: new CheckFailure({ reason: error._tag }),
    response: new ResponseMetadata({})
  })

export const recoverTransientProbe = <A>(
  effect: Effect.Effect<A, DomainError>,
  fallback: (error: DnsError | TimeoutError) => A
) => effect.pipe(
  Effect.catchTags({
    DnsError: (error) => Effect.succeed(fallback(error)),
    TimeoutError: (error) => Effect.succeed(fallback(error))
  })
)
