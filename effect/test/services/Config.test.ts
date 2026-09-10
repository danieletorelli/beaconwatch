import { it } from "@effect/vitest"
import { Duration, Effect, Equal, Option, Redacted } from "effect"
import { ConfigError } from "../../src/domain/errors.js"
import { appConfig, MAX_WORKER_CONCURRENCY, testConfigLayer } from "../../src/services/Config.js"

const expectConfigError = (error: unknown, key: string) => {
  if (!(error instanceof ConfigError)) throw new Error(`expected ConfigError, got ${String(error)}`)
  if (error._tag !== "ConfigError" || typeof error.reason !== "string" || !error.reason.includes(key)) {
    throw new Error(`unexpected ConfigError payload: ${JSON.stringify(error)}`)
  }
}

it.effect("loads typed config from ConfigProvider and redacts secret", () => Effect.gen(function*() {
  const cfg = yield* appConfig
  if (!Equal.equals(cfg.pollInterval, Duration.seconds(5))) throw new Error("bad poll interval")
  if (cfg.workerConcurrency !== 3) throw new Error("bad concurrency")
  if (Option.isNone(cfg.realLlmToken)) throw new Error("missing token")
  if (String(cfg.realLlmToken.value).includes("secret-token")) throw new Error("secret leaked")
  if (Redacted.value(cfg.realLlmToken.value) !== "secret-token") throw new Error("secret value unavailable")
}).pipe(Effect.provide(testConfigLayer({ pollInterval: "5 seconds", probeTimeout: "1 second", workerConcurrency: 3, slowThreshold: "250 millis", realLlmToken: "secret-token" }))))

it.effect("rejects a non-positive polling interval at the configuration boundary", () => Effect.gen(function*() {
  const exit = yield* appConfig.pipe(
    Effect.provide(testConfigLayer({ pollInterval: "0 millis", probeTimeout: "1 second", workerConcurrency: 3, slowThreshold: "250 millis" })),
    Effect.exit
  )
  if (exit._tag !== "Failure") throw new Error("zero polling interval was accepted")
}))

it.effect("maps missing configuration to a domain ConfigError", () => Effect.gen(function*() {
  const error = yield* Effect.flip(appConfig.pipe(Effect.provide(testConfigLayer({}))))
  expectConfigError(error, "pollInterval")
}))

it.effect("maps malformed configuration to a domain ConfigError", () => Effect.gen(function*() {
  const error = yield* Effect.flip(appConfig.pipe(Effect.provide(testConfigLayer({
    pollInterval: "not a duration", probeTimeout: "1 second", workerConcurrency: 3, slowThreshold: "250 millis"
  }))))
  expectConfigError(error, "pollInterval")
}))

it.effect("rejects non-positive worker concurrency at the configuration boundary", () => Effect.gen(function*() {
  const exit = yield* appConfig.pipe(
    Effect.provide(testConfigLayer({ pollInterval: "5 seconds", probeTimeout: "1 second", workerConcurrency: 0, slowThreshold: "250 millis" })),
    Effect.exit
  )
  if (exit._tag !== "Failure") throw new Error("zero worker concurrency was accepted")
}))

it.effect("accepts positive nanosecond durations at the configuration boundary", () => Effect.gen(function*() {
  const cfg = yield* appConfig.pipe(Effect.provide(testConfigLayer({
    pollInterval: "1 nanos",
    probeTimeout: "2 nanos",
    workerConcurrency: 1,
    slowThreshold: "3 nanos"
  })))
  if (!Equal.equals(cfg.pollInterval, Duration.nanos(1n)) ||
    !Equal.equals(cfg.probeTimeout, Duration.nanos(2n)) ||
    !Equal.equals(cfg.slowThreshold, Duration.nanos(3n))) {
    throw new Error("positive nanosecond config durations did not round-trip")
  }
}))

it.effect("accepts the worker maximum and rejects max plus one", () => Effect.gen(function*() {
  const base = { pollInterval: "1 second", probeTimeout: "1 second", slowThreshold: "1 second" }
  const accepted = yield* appConfig.pipe(Effect.provide(testConfigLayer({ ...base, workerConcurrency: MAX_WORKER_CONCURRENCY })))
  if (accepted.workerConcurrency !== MAX_WORKER_CONCURRENCY) throw new Error("maximum rejected")
  const rejected = yield* appConfig.pipe(Effect.provide(testConfigLayer({ ...base, workerConcurrency: MAX_WORKER_CONCURRENCY + 1 })), Effect.exit)
  if (rejected._tag !== "Failure") throw new Error("max plus one accepted")
  const error = yield* Effect.flip(appConfig.pipe(Effect.provide(testConfigLayer({ ...base, workerConcurrency: MAX_WORKER_CONCURRENCY + 1 }))))
  expectConfigError(error, "workerConcurrency")
}))
