import { randomUUID } from "node:crypto"
import { Buffer } from "node:buffer"
import { Clock, Context, Effect, Equal, Layer, Option, Ref } from "effect"
import { RepositoryError } from "../domain/errors.js"
import { cloneCheck, cloneIncident, cloneTarget } from "../domain/clone.js"
import { CheckResult, Incident, Target, type TargetId } from "../domain/schema.js"

export type IncidentTransition = "Opened" | "Updated" | "Closed" | "Unchanged"
export interface CheckApplication {
  readonly transition: IncidentTransition
  readonly openIncident: Option.Option<Incident>
}

export interface CheckRepositoryShape {
  readonly saveTarget: (target: Target) => Effect.Effect<void, RepositoryError>
  readonly listTargets: () => Effect.Effect<ReadonlyArray<Target>, RepositoryError>
  readonly saveCheck: (check: CheckResult) => Effect.Effect<void, RepositoryError>
  readonly listChecks: (targetId?: TargetId) => Effect.Effect<ReadonlyArray<CheckResult>, RepositoryError>
  readonly getIncident: (id: string) => Effect.Effect<Option.Option<Incident>, RepositoryError>
  readonly getOpenIncident: (targetId: TargetId) => Effect.Effect<Option.Option<Incident>, RepositoryError>
  readonly saveIncident: (incident: Incident) => Effect.Effect<void, RepositoryError>
  readonly applyCheck: (check: CheckResult) => Effect.Effect<IncidentTransition, RepositoryError>
  readonly applyCheckWithIncident: (check: CheckResult) => Effect.Effect<CheckApplication, RepositoryError>
}
export class CheckRepository extends Context.Service<CheckRepository, CheckRepositoryShape>()("beaconwatch/CheckRepository") {}

const conflictingCheck = (id: string) => new RepositoryError({ operation: "saveCheck", cause: `check id ${id} already has different contents` })
const orderText = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b))
const orderChecks = (a: CheckResult, b: CheckResult) => a.checkedAt.getTime() - b.checkedAt.getTime() || orderText(a.id, b.id)
const orderOpenIncidents = (a: Incident, b: Incident) => b.openedAt.getTime() - a.openedAt.getTime() || orderText(b.id, a.id)
interface RepositoryState {
  readonly targets: ReadonlyArray<Target>
  readonly checks: ReadonlyArray<CheckResult>
  readonly incidents: ReadonlyArray<Incident>
}

export const InMemory = Layer.effect(CheckRepository)(Effect.gen(function*() {
  const state = yield* Ref.make<RepositoryState>({ targets: [], checks: [], incidents: [] })
  const applyCheckWithIncident = (check: CheckResult) => Effect.flatMap(Clock.currentTimeMillis, (now) => Ref.modify(state, (s): readonly [Effect.Effect<CheckApplication, RepositoryError>, RepositoryState] => {
    const result = (transition: IncidentTransition, next: RepositoryState = s) => {
      const open = next.incidents.filter((i) => i.targetId === check.targetId && i.status === "Open").sort(orderOpenIncidents)[0]
      return Effect.succeed({ transition, openIncident: open === undefined ? Option.none() : Option.some(cloneIncident(open)) })
    }
    const existing = s.checks.find((candidate) => candidate.id === check.id)
    if (existing) return [Equal.equals(existing, check) ? result("Unchanged") : Effect.fail(conflictingCheck(check.id)), s]
    const withCheck = { ...s, checks: [...s.checks, cloneCheck(check)] }
    if (s.checks.some((candidate) => candidate.targetId === check.targetId && candidate.checkedAt.getTime() > check.checkedAt.getTime())) return [result("Unchanged", withCheck), withCheck]
    const openIncidents = s.incidents.filter((i) => i.targetId === check.targetId && i.status === "Open").sort(orderOpenIncidents)
    const open = openIncidents[0]
    let incident: Incident | undefined
    let transition: IncidentTransition = "Unchanged"
    if (["Down", "InvalidResponse", "Slow"].includes(check.classification._tag)) {
      const reason = check.failure?.reason ?? check.classification._tag
      if (open) { incident = new Incident({ ...open, reason, latestCheckId: check.id }); transition = "Updated" }
      else { incident = new Incident({ id: `incident_${randomUUID()}`, targetId: check.targetId, openedAt: new Date(now), closedAt: Option.none(), status: "Open", reason, latestCheckId: check.id, summary: Option.none() }); transition = "Opened" }
    } else if (check.classification._tag === "Up" && openIncidents.length > 0) transition = "Closed"
    const incidents = check.classification._tag === "Up" && openIncidents.length > 0
      ? s.incidents.map((candidate) => candidate.targetId === check.targetId && candidate.status === "Open" ? new Incident({ ...candidate, closedAt: Option.some(new Date(Math.max(now, candidate.openedAt.getTime()))), status: "Closed", latestCheckId: check.id }) : candidate)
      : incident ? [...s.incidents.filter((i) => i.id !== incident.id), incident] : s.incidents
    const next = { ...withCheck, incidents }
    return [result(transition, next), next]
  }).pipe(Effect.flatten))
  return {
    saveTarget: (target) => Ref.update(state, (s) => ({ ...s, targets: [...s.targets.filter((t) => t.id !== target.id), cloneTarget(target)] })),
    listTargets: () => Effect.map(Ref.get(state), (s) => s.targets.map(cloneTarget).sort((a, b) => orderText(a.id, b.id))),
    saveCheck: (check) => Ref.modify(state, (s) => {
      const existing = s.checks.find((candidate) => candidate.id === check.id)
      if (existing) return [Equal.equals(existing, check) ? Effect.void : Effect.fail(conflictingCheck(check.id)), s]
      return [Effect.void, { ...s, checks: [...s.checks, cloneCheck(check)] }]
    }).pipe(Effect.flatten),
    listChecks: (targetId) => Effect.map(Ref.get(state), (s) => (targetId === undefined ? s.checks : s.checks.filter((c) => c.targetId === targetId)).map(cloneCheck).sort(orderChecks)),
    getIncident: (id) => Effect.map(Ref.get(state), (s) => Option.map(Option.fromNullishOr(s.incidents.find((i) => i.id === id)), cloneIncident)),
    getOpenIncident: (targetId) => Effect.map(Ref.get(state), (s) => Option.map(Option.fromNullishOr(
      s.incidents.filter((incident) => incident.targetId === targetId && incident.status === "Open")
        .sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime() || orderText(b.id, a.id))[0]
    ), cloneIncident)),
    saveIncident: (incident) => Ref.update(state, (s) => ({ ...s, incidents: [...s.incidents.filter((i) => i.id !== incident.id), cloneIncident(incident)] })),
    applyCheckWithIncident,
    applyCheck: (check) => Effect.map(applyCheckWithIncident(check), ({ transition }) => transition)
  }
}))
