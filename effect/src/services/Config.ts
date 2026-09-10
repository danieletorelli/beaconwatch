import { Config, ConfigProvider, Duration, Effect, Layer, Option, Redacted, Schema } from "effect"
import { ConfigError } from "../domain/errors.js"

export interface AppConfig {
  readonly pollInterval: Duration.Duration
  readonly probeTimeout: Duration.Duration
  readonly workerConcurrency: number
  readonly slowThreshold: Duration.Duration
  readonly realLlmToken: Option.Option<Redacted.Redacted<string>>
}

const PositiveDuration = Schema.DurationFromString.check(
  Schema.makeFilter((duration) => Duration.toMillis(duration) > 0 ? undefined : "duration must be positive")
)
export const MAX_WORKER_CONCURRENCY = 1024
const WorkerConcurrency = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_WORKER_CONCURRENCY }))

export const appConfig = Effect.gen(function*() {
  return {
    pollInterval: yield* Config.schema(PositiveDuration, "pollInterval"),
    probeTimeout: yield* Config.schema(PositiveDuration, "probeTimeout"),
    workerConcurrency: yield* Config.schema(WorkerConcurrency, "workerConcurrency"),
    slowThreshold: yield* Config.schema(PositiveDuration, "slowThreshold"),
    realLlmToken: yield* Config.option(Config.redacted("realLlmToken"))
  } satisfies AppConfig
}).pipe(Effect.mapError((error) => new ConfigError({ reason: String(error) })))

export const testConfigProvider = (overrides: Record<string, unknown>) =>
  ConfigProvider.fromUnknown(overrides)

export const testConfigLayer = (overrides: Record<string, unknown>) =>
  ConfigProvider.layer(testConfigProvider(overrides))
