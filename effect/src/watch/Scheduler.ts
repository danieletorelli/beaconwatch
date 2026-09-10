import { Cause, Effect, Layer, Option, PubSub, Queue, Schedule } from "effect"
import { ConfigError } from "../domain/errors.js"
import type { Target, TargetConfig } from "../domain/schema.js"
import { probeOnce } from "../probe/ProbeProgram.js"
import { CheckRepository } from "../repo/CheckRepository.js"
import { StatusState } from "./StatusState.js"

export interface SchedulerOptions { readonly queueCapacity: number; readonly workerCount: number }
export const MAX_QUEUE_CAPACITY = 1_000_000
export const MAX_WORKER_COUNT = 1024

const isEnabled = (target: Target | TargetConfig) => !("enabled" in target) || target.enabled

const validateOptions = (options: SchedulerOptions) => {
  if (!Number.isSafeInteger(options.queueCapacity) || options.queueCapacity <= 0 || options.queueCapacity > MAX_QUEUE_CAPACITY) {
    return Effect.fail(new ConfigError({ reason: `queueCapacity must be between 1 and ${MAX_QUEUE_CAPACITY}` }))
  }
  if (!Number.isSafeInteger(options.workerCount) || options.workerCount <= 0 || options.workerCount > MAX_WORKER_COUNT) {
    return Effect.fail(new ConfigError({ reason: `workerCount must be between 1 and ${MAX_WORKER_COUNT}` }))
  }
  return Effect.void
}

const worker = (queue: Queue.Dequeue<Target | TargetConfig, Cause.Done>) => Effect.gen(function*() {
  const repo = yield* CheckRepository
  const status = yield* StatusState
  while (true) {
    const target = yield* Queue.take(queue)
    const check = yield* probeOnce(target)
    const applied = yield* repo.applyCheckWithIncident(check)
    yield* status.update(check, applied.openIncident)
  }
}).pipe(Effect.catchIf((e) => Cause.isDone(e), () => Effect.void))

export const runOnce = (targets: ReadonlyArray<Target | TargetConfig>, options: SchedulerOptions) => Effect.scoped(Effect.gen(function*() {
  yield* validateOptions(options)
  const queue = yield* Queue.make<Target | TargetConfig, Cause.Done>({ capacity: options.queueCapacity })
  const producer = Queue.offerAll(queue, targets.filter(isEnabled)).pipe(Effect.andThen(Queue.end(queue)))
  yield* Effect.all([
    producer,
    ...Array.from({ length: options.workerCount }, () => worker(queue))
  ], { concurrency: "unbounded", discard: true })
}))

export const watchLoop = (targets: ReadonlyArray<Target | TargetConfig>, options: SchedulerOptions) => Effect.gen(function*() {
  yield* validateOptions(options)
  const activeTargets = targets.filter(isEnabled)
  const queue = yield* Queue.make<Target | TargetConfig, Cause.Done>({ capacity: options.queueCapacity })
  return yield* Effect.all([
    ...Array.from({ length: options.workerCount }, () => worker(queue)),
    ...activeTargets.map((target) => Effect.repeat(Queue.offer(queue, target), Schedule.spaced(target.interval)))
  ], { concurrency: "unbounded", discard: true })
}).pipe(Effect.scoped)

/** A broadcast channel whose subscriptions live exactly as long as their caller fiber. */
export class BulletinBus<A> {
  private constructor(private readonly pubsub: PubSub.PubSub<A>) {}
  static make<A>() { return PubSub.unbounded<A>().pipe(Effect.map((pubsub) => new BulletinBus(pubsub))) }
  subscribe(deliver: (value: A) => void) {
    const pubsub = this.pubsub
    return Effect.scoped(Effect.gen(function*() {
      const subscription = yield* PubSub.subscribe(pubsub)
      yield* Effect.forever(PubSub.take(subscription).pipe(Effect.tap((value) => Effect.sync(() => deliver(value)))))
    }))
  }
  publish(value: A) { return PubSub.publish(this.pubsub, value) }
}

/** A work queue: each offered value is delivered to one scoped worker. */
export class WorkerBroadcast<A> {
  private constructor(private readonly queue: Queue.Queue<A>) {}
  static make<A>() { return Queue.unbounded<A>().pipe(Effect.map((queue) => new WorkerBroadcast(queue))) }
  addWorker(deliver: (value: A) => void) {
    return Effect.forever(Queue.take(this.queue).pipe(Effect.tap((value) => Effect.sync(() => deliver(value)))))
  }
  offer(value: A) { return Queue.offer(this.queue, value) }
}

export const Live = Layer.empty
