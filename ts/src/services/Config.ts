import { ConfigError } from "../domain/errors.js";
import { durationMillis } from "../domain/schema.js";
export interface AppConfig {
  pollInterval: number;
  probeTimeout: number;
  workerConcurrency: number;
  slowThreshold: number;
  telemetryEnabled: boolean;
  maxIncidents: number;
  realLlmToken?: string;
}
export const appConfig = (
  env: Record<string, unknown> = process.env,
): AppConfig => {
  try {
    const workerConcurrency = Number(
      env.workerConcurrency ?? env.WORKER_CONCURRENCY,
    );
    if (!Number.isSafeInteger(workerConcurrency) || workerConcurrency <= 0)
      throw new Error("workerConcurrency must be positive");
    const value = {
      pollInterval: parseInt(String(env.pollInterval ?? env.POLL_INTERVAL)),
      probeTimeout: durationMillis(
        String(env.probeTimeout ?? env.PROBE_TIMEOUT),
      ),
      workerConcurrency,
      slowThreshold: durationMillis(
        String(env.slowThreshold ?? env.SLOW_THRESHOLD),
      ),
      telemetryEnabled: Boolean(env.telemetryEnabled || env.TELEMETRY_ENABLED || true),
      maxIncidents: Number(env.maxIncidents || env.MAX_INCIDENTS || 100),
      ...(env.realLlmToken || env.REAL_LLM_TOKEN
        ? { realLlmToken: String(env.realLlmToken ?? env.REAL_LLM_TOKEN) }
        : {}),
    };
    if (
      value.pollInterval <= 0 ||
      value.probeTimeout <= 0 ||
      value.slowThreshold <= 0
    )
      throw new Error("durations must be positive");
    return value;
  } catch (e) {
    throw new ConfigError({ reason: String(e) });
  }
};
export const logConfig = (config: AppConfig) => console.log(`config=${JSON.stringify(config)}`);
export const testConfigProvider = (x: Record<string, unknown>) => x;
export const testConfigLayer = testConfigProvider;
