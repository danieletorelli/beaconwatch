import { ConfigError } from "../domain/errors.js";
import type { Target, TargetConfig } from "../domain/schema.js";
import { probeOnce } from "../probe/ProbeProgram.js";
import type { ProbeClientShape } from "../services/ProbeClient.js";
import type { CheckRepositoryShape } from "../repo/CheckRepository.js";
import type { StatusState } from "./StatusState.js";
export interface SchedulerOptions {
  queueCapacity: number;
  workerCount: number;
}
export interface SchedulerServices {
  client: ProbeClientShape;
  repository: CheckRepositoryShape;
  status: StatusState;
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
export async function runOnce(
  targets: readonly (Target | TargetConfig)[],
  options: SchedulerOptions,
  s: SchedulerServices,
  signal?: AbortSignal,
) {
  validate(options);
  const queue = targets.filter(enabled).slice();
  const worker = async (target: Target | TargetConfig) => {
      const check = await probeOnce(target, s.client, signal);
      await s.repository.applyCheck(check);
      await s.status.update(
        check,
        await s.repository.getOpenIncident(check.targetId),
      );
  };
  await Promise.all(queue.map(worker));
}
export async function watchLoop(
  targets: readonly (Target | TargetConfig)[],
  options: SchedulerOptions,
  s: SchedulerServices,
  signal: AbortSignal,
) {
  validate(options);
  const active = targets.filter(enabled);
  while (!signal.aborted) {
    await runOnce(active, options, s, signal);
    await new Promise<void>((r) => {
      const wait = Math.min(...active.map((t) => t.interval));
      const timer = setTimeout(r, wait);
    });
  }
}
export const startWatching = (targets: readonly (Target | TargetConfig)[], options: SchedulerOptions, s: SchedulerServices) => {
  const controller = new AbortController();
  void watchLoop(targets, options, s, controller.signal);
  return controller;
};
export const Live = { runOnce, watchLoop };

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
