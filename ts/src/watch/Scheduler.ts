import { Effect, Schedule } from "effect";
import { ConfigError, type DomainError } from "../domain/errors.js";
import type { Target, TargetConfig } from "../domain/schema.js";
import { probeOnce } from "../probe/ProbeProgram.js";
import { recordCheckMetricsEffect } from "../obs/Telemetry.js";
import { ProbeClient } from "../services/ProbeClient.js";
import { CheckRepository } from "../repo/CheckRepository.js";
import { StatusState } from "./StatusState.js";
export interface SchedulerOptions {
  queueCapacity: number;
  workerCount: number;
}
export const MAX_QUEUE_CAPACITY = 1_000_000;
export const MAX_WORKER_COUNT = 1024;
// Invalid options surface in the error channel instead of throwing.
const validateOptions = (o: SchedulerOptions): Effect.Effect<void, ConfigError> => {
  if (!Number.isSafeInteger(o.queueCapacity) || o.queueCapacity <= 0 || o.queueCapacity > MAX_QUEUE_CAPACITY)
    return Effect.fail(new ConfigError({
      reason: "queueCapacity must be a safe integer from 1 through 1000000",
    }));
  if (!Number.isSafeInteger(o.workerCount) || o.workerCount <= 0 || o.workerCount > MAX_WORKER_COUNT)
    return Effect.fail(new ConfigError({ reason: "workerCount must be a safe integer from 1 through 1024" }));
  return Effect.void;
};
const enabled = (t: Target | TargetConfig) => !("enabled" in t) || t.enabled;

// One check pipeline shared by both scheduling modes. Dependencies are
// resolved from the R channel (module 05), so callers wire implementations
// at a boundary instead of passing services through every call.
const checkPipeline = (
  target: Target | TargetConfig,
): Effect.Effect<void, DomainError, ProbeClient | CheckRepository | StatusState> =>
  Effect.gen(function*() {
    const repository = yield* CheckRepository;
    const status = yield* StatusState;
    const check = yield* probeOnce(target);
    yield* repository.applyCheck(check);
    const open = yield* repository.getOpenIncident(check.targetId);
    yield* status.update(check, open);
    yield* recordCheckMetricsEffect(check);
  }).pipe(Effect.annotateLogs("target_id", target.id));

export const runOnceEffect = (
  targets: readonly (Target | TargetConfig)[],
  options: SchedulerOptions,
): Effect.Effect<void, DomainError, ProbeClient | CheckRepository | StatusState> =>
  Effect.gen(function*() {
    yield* validateOptions(options);
    const queue = targets.filter(enabled);
    yield* Effect.forEach(queue, (target) => checkPipeline(target), { concurrency: options.workerCount });
  });

// Per-target interval scheduling: each active target is checked immediately,
// then repeatedly at its own configured interval. The loop runs until it
// fails or is cancelled; with no active targets it simply stays waiting.
export const watchLoopEffect = (
  targets: readonly (Target | TargetConfig)[],
  options: SchedulerOptions,
): Effect.Effect<void, DomainError, ProbeClient | CheckRepository | StatusState> =>
  Effect.gen(function*() {
    yield* validateOptions(options);
    const active = targets.filter(enabled);
    if (active.length === 0) return yield* Effect.never as Effect.Effect<void>;
    yield* Effect.forEach(
      active,
      (target) => Effect.repeat(checkPipeline(target), Schedule.spaced(target.interval)),
      { concurrency: options.workerCount },
    );
  }) as Effect.Effect<void, DomainError, ProbeClient | CheckRepository | StatusState>;
