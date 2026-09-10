import { it } from "@effect/vitest"
import { Effect } from "effect"
import { ConfigError, DnsError, InvalidBody, RepositoryError, TargetDisabled, TimeoutError, UnexpectedStatus, type DomainError } from "../../src/domain/errors.js"
import { classifyDomainError, type ErrorDisposition } from "../../src/domain/classify-match.js"

const cases: ReadonlyArray<readonly [DomainError, ErrorDisposition]> = [
  [new TargetDisabled({ targetId: "target_docs" }), "ignore-disabled"],
  [new InvalidBody({ reason: "bad json" }), "invalid-response"],
  [new DnsError({ host: "docs.example" }), "service-down"],
  [new TimeoutError({ timeout: "1 second" }), "service-down"],
  [new UnexpectedStatus({ expected: [200], actual: 503 }), "service-down"],
  [new RepositoryError({ operation: "saveCheck" }), "operator-action"],
  [new ConfigError({ reason: "missing api key" }), "operator-action"]
]

const _compileTimeExhaustive: (error: DomainError) => ErrorDisposition = classifyDomainError

it.effect("Match routes every DomainError tag through the BeaconWatch disposition table", () =>
  Effect.sync(() => {
    void _compileTimeExhaustive
    for (const [error, expected] of cases) {
      const actual = classifyDomainError(error)
      if (actual !== expected) throw new Error(`${error._tag} routed to ${actual}, expected ${expected}`)
    }
  })
)
