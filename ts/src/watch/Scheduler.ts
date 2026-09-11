import { Effect } from "effect";
import { ConfigError, type DomainError, type RepositoryError } from "../domain/errors.js";
import type { Target, TargetConfig } from "../domain/schema.js";
import { probeOnce } from "../probe/ProbeProgram.js";
import type { ProbeClientShape } from "../services/ProbeClient.js";
import type { CheckRepositoryShape } from "../repo/CheckRepository.js";
import type { StatusStateEffect } from "./StatusState.js";
export interface SchedulerOptions {
  queueCapacity: number;
  workerCount: number;
}
export interface SchedulerServices {
  client: ProbeClientShape;
  repository: CheckRepositoryShape;
  status: StatusStateEffect;
}
const validate = (o: SchedulerOptions) => {
  if (!Number.isSafeInteger(o.queueCapacity) || o.queueCapacity <= 0 || o.queueCapacity > 1_000_000)
    throw new ConfigError({
      reason: "queueCapacity must be a safe integer from 1 through 1000000",
    });
  if (!Number.isSafeInteger(o.workerCount) || o.workerCount <= 0 || o.workerCount > 1024)
    throw new ConfigError({ reason: "workerCount must be a safe integer from 1 through 1024" });
};
const enabled = (t: Target | TargetConfig) => !("enabled" in t) || t.enabled;

export const runOnceEffect = (
  targets: readonly (Target | TargetConfig)[],
  options: SchedulerOptions,
  s: SchedulerServices,
): Effect.Effect<void, DomainError | RepositoryError> =>
  Effect.gen(function*() {
    validate(options);
    const queue = targets.filter(enabled);
    yield* Effect.forEach(queue, (target) =>
      Effect.gen(function*() {
        const check = yield* probeOnce(target, s.client);
        yield* Effect.tryPromise({ try: () => s.repository.applyCheck(check), catch: (e) => e as RepositoryError });
        const open = yield* Effect.tryPromise({ try: () => s.repository.getOpenIncident(check.targetId), catch: (e) => e as RepositoryError });
        yield* s.status.update(check, open);
      }), { concurrency: options.workerCount });
  }) as Effect.Effect<void, DomainError | RepositoryError>;
