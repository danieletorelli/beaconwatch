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
  if (!Number.isSafeInteger(o.queueCapacity) || o.queueCapacity <= 0)
    throw new ConfigError({
      reason: "queueCapacity must be a positive integer",
    });
  if (!Number.isSafeInteger(o.workerCount) || o.workerCount <= 0)
    throw new ConfigError({ reason: "workerCount must be a positive integer" });
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

export class ArrayJobBuffer<A> {
  readonly jobs: A[] = [];
  offer(job: A) { this.jobs.push(job); return true; }
}
export class JobBuffer<A> {
  readonly jobs: A[] = [];
  accepted = 0;
  rejected = 0;
  dropped = 0;
  stopped = false;
  constructor(readonly capacity = 128) {}
  offer(job: A) {
    if (this.stopped) { this.rejected++; return false; }
    if (this.jobs.length >= this.capacity) { this.dropped++; return false; }
    this.jobs.push(job); this.accepted++; return true;
  }
  take() { return this.jobs.shift(); }
  shutdown() { this.stopped = true; this.jobs.length = 0; }
}
export const callbackJobAdapter = <A>(buffer: JobBuffer<A>) =>
  (job: A) => { buffer.offer(job); };

export class BulletinBus<A> {
  private subscribers: Array<(value: A) => void> = [];
  subscribe(f: (value: A) => void) { this.subscribers.push(f); }
  publish(value: A) { this.subscribers.shift()?.(value); }
}

export class WorkerBroadcast<A> {
  private workers: Array<(value: A) => void> = [];
  addWorker(f: (value: A) => void) { this.workers.push(f); }
  offer(value: A) { for (const worker of this.workers) worker(value); }
}
