import { Cause, Effect, PubSub, Queue, Schedule } from "effect";
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

// One check pipeline shared by both scheduling modes: probe, persist and
// apply the incident transition, publish status, record telemetry.
const checkPipeline = (
  target: Target | TargetConfig,
): Effect.Effect<void, DomainError, ProbeClient | CheckRepository | StatusState> =>
  Effect.gen(function*() {
    const check = yield* probeOnce(target);
    const repository = yield* CheckRepository;
    const status = yield* StatusState;
    yield* repository.applyCheck(check);
    const open = yield* repository.getOpenIncident(check.targetId);
    yield* status.update(check, open);
    yield* recordCheckMetricsEffect(check);
  }).pipe(Effect.annotateLogs("target_id", target.id));

/**
 * Bounded work queue with real backpressure (module 08): the producer offers
 * all enabled targets and signals completion with Queue.end; workerCount
 * consumers drain the queue until the Done signal, so the pipeline fails on
 * the first worker error.
 */
export const runOnceEffect = (
  targets: readonly (Target | TargetConfig)[],
  options: SchedulerOptions,
): Effect.Effect<void, DomainError, ProbeClient | CheckRepository | StatusState> =>
  Effect.scoped(
    Effect.gen(function*() {
      yield* validateOptions(options);
      const queue = yield* Queue.make<Target | TargetConfig, Cause.Done>({
        capacity: options.queueCapacity,
      });
      const worker = Effect.gen(function*() {
        while (true) {
          const target = yield* Queue.take(queue);
          yield* checkPipeline(target);
        }
      }).pipe(Effect.catchIf(Cause.isDone, () => Effect.void));
      yield* Effect.all(
        [
          Queue.offerAll(queue, targets.filter(enabled)).pipe(
            Effect.andThen(Queue.end(queue)),
          ),
          ...Array.from({ length: options.workerCount }, () => worker),
        ],
        { discard: true },
      );
    }),
  );

/**
 * Per-target interval scheduling: each active target is offered to the
 * bounded queue immediately and then repeatedly at its own configured
 * interval; the loop runs until it fails or is cancelled.
 */
export const watchLoopEffect = (
  targets: readonly (Target | TargetConfig)[],
  options: SchedulerOptions,
): Effect.Effect<void, DomainError, ProbeClient | CheckRepository | StatusState> =>
  Effect.scoped(
    Effect.gen(function*() {
      yield* validateOptions(options);
      const active = targets.filter(enabled);
      if (active.length === 0) return yield* Effect.never as Effect.Effect<void>;
      const queue = yield* Queue.make<Target | TargetConfig, Cause.Done>({
        capacity: options.queueCapacity,
      });
    yield* Effect.raceAll([
      ...Array.from({ length: options.workerCount }, () =>
        Effect.gen(function*() {
          while (true) {
            const target = yield* Queue.take(queue);
            yield* checkPipeline(target);
          }
        }).pipe(Effect.catchIf(Cause.isDone, () => Effect.void)),
      ),
      ...active.map((target) =>
        Effect.repeat(
          Queue.offer(queue, target),
          Schedule.spaced(target.interval),
        ),
      ),
    ]);
    }),
  ) as Effect.Effect<void, DomainError, ProbeClient | CheckRepository | StatusState>;

/**
 * Broadcast channel whose subscriptions live exactly as long as their caller
 * fiber (module 09): PubSub-backed, so delivery is scoped and cannot leak.
 */
export class BulletinBus<A> {
  private constructor(private readonly pubsub: PubSub.PubSub<A>) {}
  static make<A>(): Effect.Effect<BulletinBus<A>> {
    return Effect.map(PubSub.unbounded<A>(), (pubsub) => new BulletinBus(pubsub));
  }
  subscribe(deliver: (value: A) => void): Effect.Effect<void> {
    const pubsub = this.pubsub;
    return Effect.gen(function*() {
      const subscription = yield* PubSub.subscribe(pubsub);
      yield* Effect.forever(
        Effect.flatMap(PubSub.take(subscription), (value) => Effect.sync(() => deliver(value))),
      );
    }).pipe(Effect.scoped);
  }
  publish(value: A): Effect.Effect<boolean> {
    return PubSub.publish(this.pubsub, value);
  }
}

/** A work queue: each offered value is delivered to exactly one scoped worker. */
export class WorkerBroadcast<A> {
  private constructor(private readonly queue: Queue.Queue<A, never>) {}
  static make<A>(): Effect.Effect<WorkerBroadcast<A>> {
    return Effect.map(Queue.unbounded<A>(), (queue) => new WorkerBroadcast(queue));
  }
  addWorker(deliver: (value: A) => void): Effect.Effect<void> {
    return Effect.forever(
      Effect.flatMap(Queue.take(this.queue), (value) => Effect.sync(() => deliver(value))),
    );
  }
  offer(value: A): Effect.Effect<boolean> {
    return Queue.offer(this.queue, value);
  }
}
