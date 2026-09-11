import { Effect, Schedule } from "effect";
import { ConfigError, type DomainError, type RepositoryError } from "../domain/errors.js";
import type { Target, TargetConfig } from "../domain/schema.js";
import { probeOnce } from "../probe/ProbeProgram.js";
import { recordCheckMetricsEffect } from "../obs/Telemetry.js";
import type { ProbeClientShape } from "../services/ProbeClient.js";
import type { CheckRepositoryShape } from "../repo/CheckRepository.js";
import type { StatusStateEffect } from "./StatusState.js";
export interface SchedulerOptions {
  queueCapacity: number;
  workerCount: number;
}
export const MAX_QUEUE_CAPACITY = 1_000_000;
export const MAX_WORKER_COUNT = 1024;
export interface SchedulerServices {
  client: ProbeClientShape;
  repository: CheckRepositoryShape;
  status: StatusStateEffect;
}
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

// One check pipeline shared by both scheduling modes: probe, persist and
// apply the incident transition, publish status, record telemetry.
const checkPipeline = (
  target: Target | TargetConfig,
  s: SchedulerServices,
): Effect.Effect<void, DomainError | RepositoryError> =>
  Effect.gen(function*() {
    const check = yield* probeOnce(target, s.client);
    yield* Effect.tryPromise({ try: () => s.repository.applyCheck(check), catch: (e) => e as RepositoryError });
    const open = yield* Effect.tryPromise({ try: () => s.repository.getOpenIncident(check.targetId), catch: (e) => e as RepositoryError });
    yield* s.status.update(check, open);
    yield* recordCheckMetricsEffect(check);
  });

export const runOnceEffect = (
  targets: readonly (Target | TargetConfig)[],
  options: SchedulerOptions,
  s: SchedulerServices,
): Effect.Effect<void, DomainError | RepositoryError> =>
  Effect.gen(function*() {
    yield* validateOptions(options);
    const queue = targets.filter(enabled);
    yield* Effect.forEach(queue, (target) => checkPipeline(target, s), { concurrency: options.workerCount });
  });

// Per-target interval scheduling: each active target is checked immediately,
// then repeatedly at its own configured interval. The loop runs until it
// fails or is cancelled; with no active targets it simply stays waiting.
export const watchLoopEffect = (
  targets: readonly (Target | TargetConfig)[],
  options: SchedulerOptions,
  s: SchedulerServices,
): Effect.Effect<void, DomainError | RepositoryError> =>
  Effect.gen(function*() {
    yield* validateOptions(options);
    const active = targets.filter(enabled);
    if (active.length === 0) return yield* Effect.never as Effect.Effect<void>;
    yield* Effect.forEach(
      active,
      (target) => Effect.repeat(checkPipeline(target, s), Schedule.spaced(target.interval)),
      { concurrency: options.workerCount },
    );
  }) as Effect.Effect<void, DomainError | RepositoryError>;
