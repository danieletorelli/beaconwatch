import { it } from "@effect/vitest"
import { Duration, Effect, Layer, Option, Ref } from "effect"
import { RepositoryError } from "../../src/domain/errors.js"
import { CheckFailure, CheckResult, Down, Incident, ResponseMetadata, Target, Up } from "../../src/domain/schema.js"
import { CheckRepository, InMemory } from "../../src/repo/CheckRepository.js"
import { IncidentService, Live } from "../../src/services/IncidentService.js"
import { target } from "../helpers.js"

const check = (id: string, tag: "Down" | "Up") => new CheckResult({ id, targetId: target("target_repo").id, checkedAt: new Date(0), duration: Duration.millis(1), classification: tag === "Down" ? new Down() : new Up(), ...(tag === "Down" ? { failure: new CheckFailure({ reason: "DnsError" }) } : {}), response: new ResponseMetadata({ status: tag === "Up" ? 200 : 500 }) })

it.effect("opens, updates, then closes an incident", () => Effect.gen(function*() {
  const svc = yield* IncidentService
  const repo = yield* CheckRepository
  if ((yield* svc.applyCheck(check("c1", "Down"))) !== "Opened") throw new Error("not opened")
  if ((yield* svc.applyCheck(check("c2", "Down"))) !== "Updated") throw new Error("not updated")
  if ((yield* svc.applyCheck(check("c3", "Up"))) !== "Closed") throw new Error("not closed")
  const open = yield* repo.getOpenIncident(target("target_repo").id)
  if (Option.isSome(open)) throw new Error("incident still open")
  const checks = yield* repo.listChecks(target("target_repo").id)
  if (checks.length !== 3) throw new Error("checks not saved")
}).pipe(Effect.provide(Layer.provideMerge(Live, InMemory))))

it.effect("returns the in-memory post-transition open incident atomically", () => Effect.gen(function*() {
  const repo = yield* CheckRepository
  const opened = yield* repo.applyCheckWithIncident(check("atomic_open", "Down"))
  if (opened.transition !== "Opened" || Option.isNone(opened.openIncident) || opened.openIncident.value.latestCheckId !== "atomic_open") throw new Error("open snapshot mismatch")
  const closed = yield* repo.applyCheckWithIncident(check("atomic_close", "Up"))
  if (closed.transition !== "Closed" || Option.isSome(closed.openIncident)) throw new Error("closed snapshot mismatch")
}).pipe(Effect.provide(InMemory)))

it.effect("keeps distinct incidents when a target fails again in the same millisecond", () => Effect.gen(function*() {
  const svc = yield* IncidentService
  const repo = yield* CheckRepository
  yield* svc.applyCheck(check("same_millis_down_1", "Down"))
  const first = yield* repo.getOpenIncident(target("target_repo").id)
  if (Option.isNone(first)) throw new Error("first incident was not opened")
  yield* svc.applyCheck(check("same_millis_up", "Up"))
  yield* svc.applyCheck(check("same_millis_down_2", "Down"))
  const second = yield* repo.getOpenIncident(target("target_repo").id)
  if (Option.isNone(second)) throw new Error("second incident was not opened")
  if (second.value.id === first.value.id) throw new Error("repeated failure reused the closed incident id")
  const retainedFirst = yield* repo.getIncident(first.value.id)
  if (Option.isNone(retainedFirst) || retainedFirst.value.status !== "Closed") {
    throw new Error("opening the second incident overwrote the first incident history")
  }
}).pipe(Effect.provide(Layer.provideMerge(Live, InMemory))))

it.effect("does not duplicate check history when the same check id is saved twice", () => Effect.gen(function*() {
  const repo = yield* CheckRepository
  const duplicate = check("check_duplicate", "Up")
  yield* repo.saveCheck(duplicate)
  yield* repo.saveCheck(duplicate)
  const checks = yield* repo.listChecks(target("target_repo").id)
  if (checks.length !== 1) {
    throw new Error(`expected one check per id, retained ${checks.length}`)
  }
}).pipe(Effect.provide(InMemory)))

it.effect("does not expose mutable repository timestamps through listed checks", () => Effect.gen(function*() {
  const repo = yield* CheckRepository
  yield* repo.saveCheck(check("check_timestamp", "Up"))
  const listed = yield* repo.listChecks(target("target_repo").id)
  listed[0]?.checkedAt.setTime(42)
  const retained = yield* repo.listChecks(target("target_repo").id)
  if (retained[0]?.checkedAt.getTime() !== 0) {
    throw new Error(`listed check mutated persisted timestamp to ${retained[0]?.checkedAt.getTime()}`)
  }
}).pipe(Effect.provide(InMemory)))

it.effect("does not retain caller mutations made after saving a check", () => Effect.gen(function*() {
  const repo = yield* CheckRepository
  const saved = check("check_input_timestamp", "Up")
  yield* repo.saveCheck(saved)
  saved.checkedAt.setTime(42)
  Object.defineProperty(saved.response, "status", { value: 503 })
  const retained = yield* repo.listChecks(target("target_repo").id)
  if (retained[0]?.checkedAt.getTime() !== 0 || retained[0]?.response.status !== 200) {
    throw new Error("caller mutation changed the saved check")
  }
}).pipe(Effect.provide(InMemory)))

it.effect("does not expose mutable response metadata through listed checks", () => Effect.gen(function*() {
  const repo = yield* CheckRepository
  yield* repo.saveCheck(check("check_response", "Up"))
  const listed = yield* repo.listChecks(target("target_repo").id)
  if (!listed[0]) throw new Error("check was not saved")
  Object.defineProperty(listed[0].response, "status", { value: 503 })
  const retained = yield* repo.listChecks(target("target_repo").id)
  if (retained[0]?.response.status !== 200) {
    throw new Error(`listed check mutated persisted response status to ${retained[0]?.response.status}`)
  }
}).pipe(Effect.provide(InMemory)))

it.effect("does not expose mutable repository state through listed targets", () => Effect.gen(function*() {
  const repo = yield* CheckRepository
  yield* repo.saveTarget(new Target({ ...target("target_tags"), enabled: true, tags: ["production"] }))
  const listed = yield* repo.listTargets()
  if (!listed[0]) throw new Error("target was not saved")
  Object.defineProperty(listed[0], "name", { value: "mutated-after-read" })
  const retained = yield* repo.listTargets()
  if (retained[0]?.name === "mutated-after-read") {
    throw new Error("listed target mutated persisted repository state")
  }
}).pipe(Effect.provide(InMemory)))

it.effect("does not expose mutable repository timestamps through incidents", () => Effect.gen(function*() {
  const repo = yield* CheckRepository
  const incident = new Incident({ id: "incident_timestamp", targetId: target("target_repo").id, openedAt: new Date(1), closedAt: Option.none(), status: "Open", reason: "Down", latestCheckId: "check_1", summary: Option.none() })
  yield* repo.saveIncident(incident)
  const fetched = yield* repo.getIncident(incident.id)
  if (Option.isNone(fetched)) throw new Error("incident not saved")
  fetched.value.openedAt.setTime(42)
  const retained = yield* repo.getIncident(incident.id)
  if (Option.isNone(retained) || retained.value.openedAt.getTime() !== 1) {
    throw new Error(`fetched incident mutated persisted timestamp to ${Option.isSome(retained) ? retained.value.openedAt.getTime() : "missing"}`)
  }
}).pipe(Effect.provide(InMemory)))

it.effect("closes every open incident for a target when it recovers", () => Effect.gen(function*() {
  const repo = yield* CheckRepository
  const first = new Incident({ id: "incident_first_open", targetId: target("target_repo").id, openedAt: new Date(-2), closedAt: Option.none(), status: "Open", reason: "Down", latestCheckId: "check_1", summary: Option.none() })
  const second = new Incident({ id: "incident_second_open", targetId: target("target_repo").id, openedAt: new Date(-1), closedAt: Option.none(), status: "Open", reason: "Down", latestCheckId: "check_2", summary: Option.none() })
  yield* repo.saveIncident(first)
  yield* repo.saveIncident(second)
  yield* repo.applyCheck(new CheckResult({ ...check("check_recovered", "Up"), checkedAt: new Date(3) }))
  const retained = yield* Effect.all([repo.getIncident(first.id), repo.getIncident(second.id)])
  const openIds = retained.flatMap((value) => Option.isSome(value) && value.value.status === "Open" ? [value.value.id] : [])
  if (openIds.length > 0) {
    throw new Error(`target recovered with open incidents: ${openIds.join(", ")}`)
  }
}).pipe(Effect.provide(InMemory)))

it.effect("does not close an incident before it opened", () => Effect.gen(function*() {
  const repo = yield* CheckRepository
  const incident = new Incident({ id: "incident_future_open", targetId: target("target_repo").id, openedAt: new Date(1), closedAt: Option.none(), status: "Open", reason: "Down", latestCheckId: "check_down", summary: Option.none() })
  yield* repo.saveIncident(incident)
  yield* repo.applyCheck(check("check_recovered_before_open", "Up"))
  const retained = yield* repo.getIncident(incident.id)
  if (Option.isNone(retained) || Option.isNone(retained.value.closedAt)) throw new Error("incident was not closed")
  if (retained.value.closedAt.value < retained.value.openedAt) {
    throw new Error(`incident closed at ${retained.value.closedAt.value.getTime()} before opening at ${retained.value.openedAt.getTime()}`)
  }
}).pipe(Effect.provide(InMemory)))

it.effect("rejects a reused check id with conflicting contents", () => Effect.gen(function*() {
  const repo = yield* CheckRepository
  yield* repo.applyCheck(check("check_conflict", "Down"))
  const error = yield* Effect.flip(repo.applyCheck(check("check_conflict", "Up")))
  if (!(error instanceof RepositoryError)) {
    throw new Error("expected conflicting id reuse to fail with RepositoryError")
  }
}).pipe(Effect.provide(InMemory)))

it.effect("does not let a late older check reopen an incident after a newer success", () => Effect.gen(function*() {
  const repo = yield* CheckRepository
  const newer = new CheckResult({ ...check("check_newer_up", "Up"), checkedAt: new Date(2) })
  const older = new CheckResult({ ...check("check_older_down", "Down"), checkedAt: new Date(1) })
  yield* repo.applyCheck(newer)
  yield* repo.applyCheck(older)
  const open = yield* repo.getOpenIncident(target("target_repo").id)
  if (Option.isSome(open)) {
    throw new Error(`older check reopened incident ${open.value.id} after newer success`)
  }
}).pipe(Effect.provide(InMemory)))

it.effect("does not retain a check when its incident transition fails", () => Effect.gen(function*() {
  const savedChecks = yield* Ref.make<ReadonlyArray<CheckResult>>([])
  const repository = Layer.succeed(CheckRepository)({
    saveTarget: () => Effect.void,
    listTargets: () => Effect.succeed([]),
    saveCheck: (value) => Ref.update(savedChecks, (values) => [...values, value]),
    listChecks: () => Ref.get(savedChecks),
    getIncident: () => Effect.succeed(Option.none()),
    getOpenIncident: () => Effect.succeed(Option.none()),
    saveIncident: () => Effect.fail(new RepositoryError({ operation: "saveIncident", cause: "disk-full" })),
    applyCheck: () => Effect.fail(new RepositoryError({ operation: "applyCheck", cause: "disk-full" })),
    applyCheckWithIncident: () => Effect.fail(new RepositoryError({ operation: "applyCheck", cause: "disk-full" }))
  })
  const exit = yield* IncidentService.pipe(
    Effect.flatMap((service) => service.applyCheck(check("c_atomic", "Down"))),
    Effect.provide(Layer.provideMerge(Live, repository)),
    Effect.exit
  )
  if (exit._tag !== "Failure") throw new Error("expected incident persistence to fail")
  const retained = yield* Ref.get(savedChecks)
  if (retained.length !== 0) throw new Error(`expected atomic rollback, retained ${retained.length} check`)
}))
