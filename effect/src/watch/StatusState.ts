import { Buffer } from "node:buffer"
import { Context, Effect, Layer, Option, Ref } from "effect"
import { cloneCheck, cloneIncident } from "../domain/clone.js"
import { CheckResult, Incident, type TargetId } from "../domain/schema.js"

export interface StatusEntry { readonly latest: CheckResult; readonly openIncident: Option.Option<Incident> }
export interface StatusStateShape {
  readonly update: (check: CheckResult, incident: Option.Option<Incident>) => Effect.Effect<void>
  readonly get: (targetId: TargetId) => Effect.Effect<Option.Option<StatusEntry>>
  readonly snapshot: Effect.Effect<ReadonlyMap<TargetId, StatusEntry>>
}
export class StatusState extends Context.Service<StatusState, StatusStateShape>()("beaconwatch/StatusState") {}
const cloneEntry = (entry: StatusEntry): StatusEntry => ({
  latest: cloneCheck(entry.latest),
  openIncident: Option.isNone(entry.openIncident) ? Option.none() : Option.some(cloneIncident(entry.openIncident.value))
})
export const InMemory = Layer.effect(StatusState)(Effect.gen(function*() {
  const ref = yield* Ref.make(new Map<TargetId, StatusEntry>())
  return {
    update: (check, incident) => Ref.update(ref, (m) => {
      const current = m.get(check.targetId)
      const currentOrder = current
        ? current.latest.checkedAt.getTime() - check.checkedAt.getTime() || Buffer.compare(Buffer.from(current.latest.id), Buffer.from(check.id))
        : -1
      return currentOrder > 0
        ? m
        : new Map(m).set(check.targetId, cloneEntry({ latest: check, openIncident: incident }))
    }),
    get: (targetId) => Effect.map(Ref.get(ref), (m) => Option.map(Option.fromNullishOr(m.get(targetId)), cloneEntry)),
    snapshot: Effect.map(Ref.get(ref), (m) => new Map([...m].map(([targetId, entry]) => [targetId, cloneEntry(entry)])))
  }
}))
