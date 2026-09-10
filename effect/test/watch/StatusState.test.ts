import { it } from "@effect/vitest"
import { Duration, Effect, Option } from "effect"
import { CheckResult, Incident, ResponseMetadata, Up } from "../../src/domain/schema.js"
import { InMemory, StatusState } from "../../src/watch/StatusState.js"
import { target } from "../helpers.js"

const checkAt = (id: string, checkedAt: number) => new CheckResult({
  id,
  targetId: target("target_status_order").id,
  checkedAt: new Date(checkedAt),
  duration: Duration.millis(1),
  classification: new Up(),
  response: new ResponseMetadata({ status: 200 })
})

it.effect("does not replace the latest status with an older completed update", () => Effect.gen(function*() {
  const status = yield* StatusState
  yield* status.update(checkAt("check_newer", 2), Option.none())
  yield* status.update(checkAt("check_older", 1), Option.none())
  const current = yield* status.get(target("target_status_order").id)
  if (Option.isNone(current) || current.value.latest.id !== "check_newer") {
    throw new Error(`expected check_newer to remain latest, got ${Option.isSome(current) ? current.value.latest.id : "none"}`)
  }
}).pipe(Effect.provide(InMemory)))

it.effect("uses check id to break equal-timestamp update races deterministically", () => Effect.gen(function*() {
  const status = yield* StatusState
  yield* status.update(checkAt("check_z", 1), Option.none())
  yield* status.update(checkAt("check_a", 1), Option.none())
  const current = yield* status.get(target("target_status_order").id)
  if (Option.isNone(current) || current.value.latest.id !== "check_z") {
    throw new Error(`expected check_z to remain latest, got ${Option.isSome(current) ? current.value.latest.id : "none"}`)
  }
}).pipe(Effect.provide(InMemory)))

it.effect("orders Unicode check ids by code point when timestamps tie", () => Effect.gen(function*() {
  const status = yield* StatusState
  yield* status.update(checkAt("check_𐀀", 1), Option.none())
  yield* status.update(checkAt("check_", 1), Option.none())
  const current = yield* status.get(target("target_status_order").id)
  if (Option.isNone(current) || current.value.latest.id !== "check_𐀀") {
    throw new Error(`expected check_𐀀 to remain latest, got ${Option.isSome(current) ? current.value.latest.id : "none"}`)
  }
}).pipe(Effect.provide(InMemory)))

it.effect("does not let a caller mutate a stored status timestamp", () => Effect.gen(function*() {
  const status = yield* StatusState
  const supplied = checkAt("check_supplied", 2)
  yield* status.update(supplied, Option.none())
  supplied.checkedAt.setTime(0)
  yield* status.update(checkAt("check_older", 1), Option.none())
  const current = yield* status.get(target("target_status_order").id)
  if (Option.isNone(current) || current.value.latest.id !== "check_supplied") {
    throw new Error(`caller mutation replaced the latest status with ${Option.isSome(current) ? current.value.latest.id : "none"}`)
  }
}).pipe(Effect.provide(InMemory)))

it.effect("does not expose mutable response metadata through status entries", () => Effect.gen(function*() {
  const status = yield* StatusState
  yield* status.update(checkAt("check_response", 1), Option.none())
  const fetched = yield* status.get(target("target_status_order").id)
  if (Option.isNone(fetched)) throw new Error("status was not stored")
  Object.defineProperty(fetched.value.latest.response, "status", { value: 503 })
  const retained = yield* status.get(target("target_status_order").id)
  if (Option.isNone(retained) || retained.value.latest.response.status !== 200) {
    throw new Error(`fetched status mutated retained response to ${Option.isSome(retained) ? retained.value.latest.response.status : "missing"}`)
  }
}).pipe(Effect.provide(InMemory)))

it.effect("isolates mutable incident dates at every status boundary", () => Effect.gen(function*() {
  const status = yield* StatusState
  const supplied = checkAt("check_nested", 1)
  const incident = new Incident({
    id: "incident_status_nested", targetId: supplied.targetId, openedAt: new Date(1), closedAt: Option.some(new Date(2)),
    status: "Closed", reason: "test", latestCheckId: supplied.id, summary: Option.some("original")
  })
  yield* status.update(supplied, Option.some(incident))
  incident.openedAt.setTime(99)
  if (Option.isSome(incident.closedAt)) incident.closedAt.value.setTime(100)
  const fetched = yield* status.get(supplied.targetId)
  if (Option.isNone(fetched) || Option.isNone(fetched.value.openIncident)) throw new Error("status incident missing")
  if (fetched.value.openIncident.value.openedAt.getTime() !== 1 || Option.getOrThrow(fetched.value.openIncident.value.closedAt).getTime() !== 2) throw new Error("status retained mutable input dates")
  fetched.value.openIncident.value.openedAt.setTime(101)
  Option.getOrThrow(fetched.value.openIncident.value.closedAt).setTime(102)
  const retained = yield* status.get(supplied.targetId)
  if (Option.isNone(retained) || Option.isNone(retained.value.openIncident)) throw new Error("status incident missing")
  if (retained.value.openIncident.value.openedAt.getTime() !== 1 || Option.getOrThrow(retained.value.openIncident.value.closedAt).getTime() !== 2) throw new Error("status exposed mutable output dates")
}).pipe(Effect.provide(InMemory)))
