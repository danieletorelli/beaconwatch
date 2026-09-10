import { it } from "@effect/vitest"
import { Effect } from "effect"
import { ConfigError } from "../../src/domain/errors.js"
import { assertCheckInvariant, exitKind, firstTypedFailure, validatePositiveInterval } from "../../src/domain/defects.js"

it.effect("captures a defect as die in Cause/Exit, not as a typed failure", () =>
  Effect.gen(function*() {
    const exit = yield* Effect.exit(assertCheckInvariant(false))
    if (exitKind(exit) !== "defect") throw new Error("expected die defect")
    if (firstTypedFailure(exit) !== undefined) throw new Error("defect was reported as typed failure")
  })
)

it.effect("captures expected invalid config as a typed failure", () =>
  Effect.gen(function*() {
    const exit = yield* Effect.exit(validatePositiveInterval(0))
    const failure = firstTypedFailure(exit)
    if (exitKind(exit) !== "typed-failure") throw new Error("expected typed failure")
    if (!(failure instanceof ConfigError)) throw new Error("typed failure did not preserve ConfigError")
  })
)

it.effect("rejects NaN as a positive interval", () =>
  Effect.gen(function*() {
    const exit = yield* Effect.exit(validatePositiveInterval(Number.NaN))
    const failure = firstTypedFailure(exit)
    if (exitKind(exit) !== "typed-failure") throw new Error("NaN was accepted as a positive interval")
    if (!(failure instanceof ConfigError)) throw new Error("typed failure did not preserve ConfigError")
  })
)
