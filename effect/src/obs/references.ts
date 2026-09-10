import { Effect, References } from "effect"
export const withMinimumLogLevel = <A, E, R>(level: "Debug" | "Info" | "Warn" | "Error", effect: Effect.Effect<A, E, R>) => Effect.provideService(effect, References.MinimumLogLevel, level)
export const fiberLocalMinimumLogLevelDemo = Effect.gen(function*() {
  const before = yield* References.MinimumLogLevel
  const inside = yield* withMinimumLogLevel("Debug", References.MinimumLogLevel)
  const after = yield* References.MinimumLogLevel
  return { before, inside, after }
})
