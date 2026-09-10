import { Cause, Effect, Exit, Result } from "effect"
import { ConfigError } from "./errors.js"

export const validatePositiveInterval = (seconds: number) =>
  !Number.isFinite(seconds) || seconds <= 0
    ? Effect.fail(new ConfigError({ reason: "interval must be positive" }))
    : Effect.succeed(seconds)

export const assertCheckInvariant = (condition: boolean) =>
  condition ? Effect.void : Effect.die(new Error("BeaconWatch invariant violated"))

export const exitKind = <A, E>(exit: Exit.Exit<A, E>) => {
  if (!Exit.isFailure(exit)) return "success" as const
  if (Cause.hasDies(exit.cause)) return "defect" as const
  if (Cause.hasFails(exit.cause)) return "typed-failure" as const
  return "other-failure" as const
}

export const firstTypedFailure = <A, E>(exit: Exit.Exit<A, E>) => {
  if (!Exit.isFailure(exit)) return undefined
  const found = Cause.findFail(exit.cause)
  return Result.isSuccess(found) ? found.success.error : undefined
}
