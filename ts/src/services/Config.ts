import { Config, Duration, Effect, Option, Redacted } from "effect";
import * as ConfigProvider from "effect/ConfigProvider";
import { ConfigError } from "../domain/errors.js";

/**
 * The single typed configuration path (module 10): durations are parsed
 * through the Duration config type, the concurrency bound is validated, and
 * the provider secret is a Redacted value. Reading config is an Effect —
 * invalid or missing values surface as a typed ConfigError.
 */
export interface AppConfig {
  readonly pollInterval: Duration.Duration;
  readonly probeTimeout: Duration.Duration;
  readonly workerConcurrency: number;
  readonly slowThreshold: Duration.Duration;
  readonly telemetryEnabled: boolean;
  readonly maxIncidents: number;
  readonly realLlmToken: Option.Option<Redacted.Redacted<string>>;
}
export const MAX_WORKER_CONCURRENCY = 1024;
export const MAX_INCIDENTS = 1_000_000;

const bounded = (name: string, value: number, maximum: number) => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum)
    return Option.some(
      `${name} must be a safe integer from 1 through ${maximum}`,
    );
  return Option.none();
};

export const appConfig = Effect.mapError(
  Effect.gen(function*() {
    const pollInterval = yield* Config.duration("pollInterval").pipe(
      Config.withDefault(Duration.seconds(10)),
    );
    const probeTimeout = yield* Config.duration("probeTimeout").pipe(
      Config.withDefault(Duration.seconds(5)),
    );
    const workerConcurrency = yield* Config.int("workerConcurrency").pipe(
      Config.withDefault(2),
    );
    const slowThreshold = yield* Config.duration("slowThreshold").pipe(
      Config.withDefault(Duration.seconds(3)),
    );
    const telemetryEnabled = yield* Config.boolean("telemetryEnabled").pipe(
      Config.withDefault(true),
    );
    const maxIncidents = yield* Config.int("maxIncidents").pipe(
      Config.withDefault(100),
    );
    for (const [name, d] of [
      ["pollInterval", pollInterval],
      ["probeTimeout", probeTimeout],
      ["slowThreshold", slowThreshold],
    ] as const) {
      const positive = Duration.match({
        onMillis: (m) => m > 0,
        onNanos: (n) => n > 0n,
        onInfinity: () => true,
        onNegativeInfinity: () => false,
      })(d);
      if (!positive)
        return yield* Effect.fail(
          new ConfigError({ reason: `${name} must be strictly positive` }),
        );
    }
    const badWorkers = bounded("workerConcurrency", workerConcurrency, MAX_WORKER_CONCURRENCY);
    if (Option.isSome(badWorkers))
      return yield* Effect.fail(new ConfigError({ reason: badWorkers.value }));
    const badIncidents = bounded("maxIncidents", maxIncidents, MAX_INCIDENTS);
    if (Option.isSome(badIncidents))
      return yield* Effect.fail(new ConfigError({ reason: badIncidents.value }));
    return {
      pollInterval,
      probeTimeout,
      workerConcurrency,
      slowThreshold,
      telemetryEnabled,
      maxIncidents,
      realLlmToken: yield* Config.option(Config.redacted("realLlmToken")),
    } satisfies AppConfig;
  }),
  (error) => new ConfigError({ reason: String(error) }),
);

export const testConfigLayer = (overrides: Record<string, string>) =>
  ConfigProvider.layer(ConfigProvider.fromEnvRecord(overrides));
