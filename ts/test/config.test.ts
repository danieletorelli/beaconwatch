import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Redacted } from "effect";
import { MAX_WORKER_CONCURRENCY, appConfig, testConfigLayer } from "../src/services/Config.js";
import { ConfigError } from "../src/domain/errors.js";

const read = (overrides: Record<string, string>) =>
  Effect.provide(appConfig, testConfigLayer(overrides));

describe("application configuration (module 10)", () => {
  it.effect("parses explicit values through typed channels", () =>
    Effect.gen(function*() {
      const config = yield* read({
        pollInterval: "5 seconds",
        probeTimeout: "500 millis",
        workerConcurrency: "2",
        slowThreshold: "1 seconds",
        telemetryEnabled: "false",
        realLlmToken: "sk-secret",
      });
      expect(config.workerConcurrency).toBe(2);
      expect(config.telemetryEnabled).toBe(false);
      expect(Redacted.value(Option.getOrThrow(config.realLlmToken))).toBe("sk-secret");
    }));

  it.effect("applies documented defaults for absent optional fields", () =>
    Effect.gen(function*() {
      const config = yield* read({});
      expect(config.workerConcurrency).toBe(2);
      expect(config.telemetryEnabled).toBe(true);
      expect(config.maxIncidents).toBe(100);
      expect(Option.isNone(config.realLlmToken)).toBe(true);
    }));

  it.effect("rejects invalid values in the typed error channel", () =>
    Effect.gen(function*() {
      const badWorkers = yield* Effect.result(read({ workerConcurrency: "0" }));
      expect(badWorkers._tag === "Failure" && badWorkers.failure._tag === "ConfigError").toBe(true);
      const badDuration = yield* Effect.result(read({ pollInterval: "0 seconds" }));
      expect(badDuration._tag === "Failure").toBe(true);
      const tooManyWorkers = yield* Effect.result(
        read({ workerConcurrency: String(MAX_WORKER_CONCURRENCY + 1) }),
      );
      expect(tooManyWorkers._tag === "Failure").toBe(true);
      void ConfigError;
    }));
});
