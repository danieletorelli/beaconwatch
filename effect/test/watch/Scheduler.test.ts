import { it } from "@effect/vitest"
import { Deferred, Duration, Effect, Fiber, Layer, Option, Ref } from "effect"
import { TestClock } from "effect/testing"
import { ConfigError } from "../../src/domain/errors.js"
import { CheckRepository, InMemory as RepoMemory } from "../../src/repo/CheckRepository.js"
import { ProbeClient, type RawProbeResponse } from "../../src/services/ProbeClient.js"
import { IncidentService, Live as IncidentLive } from "../../src/services/IncidentService.js"
import { InMemory as StatusMemory } from "../../src/watch/StatusState.js"
import { StatusState } from "../../src/watch/StatusState.js"
import { MAX_QUEUE_CAPACITY, MAX_WORKER_COUNT, runOnce, watchLoop } from "../../src/watch/Scheduler.js"
import { Incident, Target } from "../../src/domain/schema.js"
import { target } from "../helpers.js"

it.effect("bounds worker concurrency and shuts down after all targets checked", () => Effect.gen(function*() {
  const inFlight = yield* Ref.make(0)
  const max = yield* Ref.make(0)
  const layer = Layer.succeed(ProbeClient)({ probe: () => Effect.gen(function*() {
    const n = yield* Ref.updateAndGet(inFlight, (x) => x + 1)
    yield* Ref.update(max, (m) => Math.max(m, n))
    yield* Effect.sleep("100 millis")
    yield* Ref.update(inFlight, (x) => x - 1)
    return { status: 200, body: { ok: true }, bytes: 2 } satisfies RawProbeResponse
  }) })
  const fiber = yield* runOnce([target("target_a"), target("target_b"), target("target_c"), target("target_d")], { queueCapacity: 2, workerCount: 2 }).pipe(
    Effect.provide(Layer.mergeAll(layer, StatusMemory)),
    Effect.forkScoped
  )
  yield* TestClock.adjust("500 millis")
  yield* Fiber.join(fiber)
  const repo = yield* CheckRepository
  const counts = yield* Effect.all(["target_a", "target_b", "target_c", "target_d"].map((id) => repo.listChecks(target(id).id)), { concurrency: 1 })
  if (counts.some((xs) => xs.length !== 1)) throw new Error("not all targets checked")
  if ((yield* Ref.get(max)) > 2) throw new Error("concurrency bound exceeded")
}).pipe(Effect.provide(Layer.provideMerge(IncidentLive, RepoMemory)), Effect.scoped))

it.effect("rejects a zero worker count instead of blocking forever", () => Effect.gen(function*() {
  const fiber = yield* runOnce(
    [target("target_zero_a"), target("target_zero_b")],
    { queueCapacity: 1, workerCount: 0 }
  ).pipe(
    Effect.result,
    Effect.timeoutOption("1 second"),
    Effect.provide(Layer.mergeAll(Layer.succeed(ProbeClient)({ probe: () => Effect.die("unexpected probe") }), StatusMemory)),
    Effect.forkScoped
  )
  yield* TestClock.adjust("1 second")
  const outcome = yield* Fiber.join(fiber)
  if (outcome._tag === "None") throw new Error("scheduler blocked with no workers")
  if (outcome.value._tag !== "Failure" || !(outcome.value.failure instanceof ConfigError)) {
    throw new Error("expected invalid scheduler options to fail with ConfigError")
  }
}).pipe(Effect.provide(Layer.provideMerge(IncidentLive, RepoMemory)), Effect.scoped))

it.effect("validates scheduler maxima before allocating resources", () => Effect.gen(function*() {
  const services = Layer.mergeAll(Layer.succeed(ProbeClient)({ probe: () => Effect.die("unexpected") }), StatusMemory)
  yield* runOnce([], { queueCapacity: MAX_QUEUE_CAPACITY, workerCount: 1 }).pipe(Effect.provide(services))
  yield* runOnce([], { queueCapacity: 1, workerCount: MAX_WORKER_COUNT }).pipe(Effect.provide(services))
  for (const options of [{ queueCapacity: MAX_QUEUE_CAPACITY + 1, workerCount: 1 }, { queueCapacity: 1, workerCount: MAX_WORKER_COUNT + 1 }]) {
    const result = yield* runOnce([], options).pipe(Effect.provide(services), Effect.result)
    if (result._tag !== "Failure" || !(result.failure instanceof ConfigError)) throw new Error("expected ConfigError above scheduler maximum")
  }
}).pipe(Effect.provide(Layer.provideMerge(IncidentLive, RepoMemory)), Effect.scoped))

it.effect("fails promptly when every worker stops while producers are backpressured", () => Effect.gen(function*() {
  const outcomeFiber = yield* runOnce(
    [target("target_worker_failure_a"), target("target_worker_failure_b"), target("target_worker_failure_c")],
    { queueCapacity: 1, workerCount: 1 }
  ).pipe(
    Effect.provide(Layer.mergeAll(
      Layer.succeed(ProbeClient)({ probe: () => Effect.die("worker failed") }),
      StatusMemory
    )),
    Effect.exit,
    Effect.timeoutOption("1 second"),
    Effect.forkScoped
  )
  yield* TestClock.adjust("1 second")
  const outcome = yield* Fiber.join(outcomeFiber)
  if (outcome._tag === "None") {
    throw new Error("scheduler remained blocked after its only worker failed")
  }
  if (outcome.value._tag !== "Failure") throw new Error("worker failure was swallowed")
}).pipe(Effect.provide(Layer.provideMerge(IncidentLive, RepoMemory)), Effect.scoped))

it.effect("skips a disabled target without abandoning later enabled targets", () => Effect.gen(function*() {
  const probes = yield* Ref.make<ReadonlyArray<string>>([])
  const layer = Layer.succeed(ProbeClient)({
    probe: (value) => Ref.update(probes, (ids) => [...ids, value.id]).pipe(
      Effect.as({ status: 200, body: { ok: true }, bytes: 2 })
    )
  })
  const disabled = new Target({ ...target("target_disabled_first"), enabled: false })
  yield* runOnce([disabled, target("target_enabled_second")], { queueCapacity: 2, workerCount: 1 }).pipe(
    Effect.provide(Layer.mergeAll(layer, StatusMemory))
  )
  const observed = yield* Ref.get(probes)
  if (observed.includes(disabled.id)) throw new Error("disabled target was probed")
  if (!observed.includes("target_enabled_second")) throw new Error("enabled target after disabled target was abandoned")
}).pipe(Effect.provide(Layer.provideMerge(IncidentLive, RepoMemory)), Effect.scoped))

it.effect("completes without probing when every target is disabled", () => Effect.gen(function*() {
  const probes = yield* Ref.make(0)
  const disabled = new Target({ ...target("target_all_disabled"), enabled: false })
  yield* runOnce([disabled], { queueCapacity: 1, workerCount: 2 }).pipe(
    Effect.provide(Layer.mergeAll(
      Layer.succeed(ProbeClient)({
        probe: () => Ref.update(probes, (count) => count + 1).pipe(
          Effect.as({ status: 200, body: { ok: true }, bytes: 2 })
        )
      }),
      StatusMemory
    ))
  )
  if ((yield* Ref.get(probes)) !== 0) throw new Error("disabled target was probed")
}).pipe(Effect.provide(Layer.provideMerge(IncidentLive, RepoMemory)), Effect.scoped))

it.effect("polls each target at its configured interval", () => Effect.gen(function*() {
  const layer = Layer.succeed(ProbeClient)({
    probe: () => Effect.succeed({ status: 200, body: { ok: true }, bytes: 2 })
  })
  const slow = target("target_slow_schedule", { interval: Duration.seconds(10) })
  const fast = target("target_fast_schedule", { interval: Duration.seconds(1) })
  const fiber = yield* watchLoop([slow, fast], { queueCapacity: 4, workerCount: 1 }).pipe(
    Effect.provide(Layer.mergeAll(layer, StatusMemory)),
    Effect.forkScoped
  )
  yield* TestClock.adjust("1 second")
  yield* TestClock.adjust("1 second")
  yield* TestClock.adjust("1 second")
  yield* Fiber.interrupt(fiber)

  const repo = yield* CheckRepository
  const slowChecks = yield* repo.listChecks(slow.id)
  const fastChecks = yield* repo.listChecks(fast.id)
  if (slowChecks.length !== 1) throw new Error(`slow target was checked ${slowChecks.length} times`)
  if (fastChecks.length < 3) throw new Error(`fast target was checked only ${fastChecks.length} times`)
}).pipe(Effect.provide(Layer.provideMerge(IncidentLive, RepoMemory)), Effect.scoped))

it.effect("uses each atomic post-transition incident snapshot under same-target concurrency", () => Effect.gen(function*() {
  const firstCaptured = yield* Deferred.make<void>()
  const releaseFirst = yield* Deferred.make<void>()
  const calls = yield* Ref.make(0)
  const observed = yield* Ref.make<ReadonlyArray<boolean>>([])
  const repository = Layer.succeed(CheckRepository)({
    saveTarget: () => Effect.void, listTargets: () => Effect.succeed([]), saveCheck: () => Effect.void,
    listChecks: () => Effect.succeed([]), getIncident: () => Effect.succeed(Option.none()),
    getOpenIncident: () => Effect.succeed(Option.none()), saveIncident: () => Effect.void,
    applyCheck: () => Effect.succeed("Unchanged" as const),
    applyCheckWithIncident: (check) => Effect.gen(function*() {
      const n = yield* Ref.updateAndGet(calls, (value) => value + 1)
      if (n === 1) {
        yield* Deferred.succeed(firstCaptured, undefined)
        yield* Deferred.await(releaseFirst)
        return { transition: "Opened" as const, openIncident: Option.some(new Incident({
          id: "incident_race", targetId: check.targetId, openedAt: check.checkedAt,
          closedAt: Option.none(), status: "Open", reason: "Down", latestCheckId: check.id, summary: Option.none()
        })) }
      }
      yield* Deferred.await(firstCaptured)
      yield* Deferred.succeed(releaseFirst, undefined)
      return { transition: "Closed" as const, openIncident: Option.none() }
    })
  })
  const status = Layer.succeed(StatusState)({
    update: (_check, incident) => Ref.update(observed, (values) => [...values, Option.isSome(incident)]),
    get: () => Effect.succeed(Option.none()), snapshot: Effect.succeed(new Map())
  })
  let probe = 0
  const probes = Layer.succeed(ProbeClient)({ probe: () => Effect.sync(() => ++probe === 1
    ? { status: 500, body: {}, bytes: 2 }
    : { status: 200, body: {}, bytes: 2 }) })
  yield* runOnce([target("target_race"), target("target_race")], { queueCapacity: 2, workerCount: 2 }).pipe(Effect.provide(Layer.mergeAll(repository, status, probes)))
  const snapshots = yield* Ref.get(observed)
  if (snapshots.length !== 2 || !snapshots.includes(true) || !snapshots.includes(false)) throw new Error(`lost atomic snapshots: ${snapshots}`)
}).pipe(Effect.scoped))
