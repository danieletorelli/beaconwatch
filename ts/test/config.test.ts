import { describe, expect, it } from "@effect/vitest";
import { appConfig, logConfig } from "../src/services/Config.js";
import { ConfigError } from "../src/domain/errors.js";

describe("application configuration", () => {
  it("accepts explicit values including false and zero-count semantics", () => {
    const config = appConfig({
      pollInterval: "5000",
      probeTimeout: "2 seconds",
      workerConcurrency: "2",
      slowThreshold: "3 seconds",
      telemetryEnabled: "false",
    });
    expect(config.workerConcurrency).toBe(2);
    expect(config.telemetryEnabled).toBe(false);
    expect(config.probeTimeout).toBe(2000);
    expect(() => logConfig(config)).not.toThrow();
  });

  it("applies documented defaults for absent optional fields", () => {
    const config = appConfig({
      pollInterval: "5000",
      probeTimeout: "2 seconds",
      workerConcurrency: 1,
      slowThreshold: "1 second",
    });
    expect(config.maxIncidents).toBe(100);
    expect(config.telemetryEnabled).toBe(true);
    expect("realLlmToken" in config).toBe(false);
  });

  it("rejects non-positive worker counts and durations", () => {
    expect(() => appConfig({ workerConcurrency: 0 })).toThrow(ConfigError);
    expect(() =>
      appConfig({ pollInterval: "0", probeTimeout: "1 ms", workerConcurrency: 1 }),
    ).toThrow();
    expect(() =>
      appConfig({ pollInterval: "1 ms", probeTimeout: "1 ms", workerConcurrency: 1.5 }),
    ).toThrow();
  });
});
