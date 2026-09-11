import { Clock, Context, Effect, Layer, Option, Ref } from "effect";
import { randomUUID } from "node:crypto";
import {
  CheckResult,
  Incident,
  Target,
  cloneCheck,
  cloneIncident,
  cloneTarget,
  type IncidentId,
  type TargetId,
} from "../domain/schema.js";
import { RepositoryError } from "../domain/errors.js";
export type IncidentTransition = "Opened" | "Updated" | "Closed" | "Unchanged";
export interface CheckRepositoryShape {
  readonly saveTarget: (t: Target) => Effect.Effect<void, RepositoryError>;
  readonly listTargets: () => Effect.Effect<ReadonlyArray<Target>, RepositoryError>;
  readonly saveCheck: (c: CheckResult) => Effect.Effect<void, RepositoryError>;
  readonly listChecks: (
    targetId?: TargetId,
  ) => Effect.Effect<ReadonlyArray<CheckResult>, RepositoryError>;
  readonly getIncident: (
    id: string,
  ) => Effect.Effect<Option.Option<Incident>, RepositoryError>;
  readonly getOpenIncident: (
    id: TargetId,
  ) => Effect.Effect<Option.Option<Incident>, RepositoryError>;
  readonly saveIncident: (
    i: Incident,
  ) => Effect.Effect<void, RepositoryError>;
  readonly applyCheck: (
    c: CheckResult,
  ) => Effect.Effect<IncidentTransition, RepositoryError>;
}
export class CheckRepository extends Context.Service<CheckRepository, CheckRepositoryShape>()("beaconwatch/CheckRepository") {}

interface RepositoryState {
  readonly targets: ReadonlyArray<Target>;
  readonly checks: ReadonlyArray<CheckResult>;
  readonly incidents: ReadonlyArray<Incident>;
}
const compare = (a: string, b: string) =>
  Buffer.compare(Buffer.from(a), Buffer.from(b));
const orderChecks = (a: CheckResult, b: CheckResult) =>
  a.checkedAt.getTime() - b.checkedAt.getTime() || compare(a.id, b.id);
const orderOpenIncidents = (a: Incident, b: Incident) =>
  b.openedAt.getTime() - a.openedAt.getTime() || compare(b.id, a.id);
const openIncident = (s: RepositoryState, targetId: TargetId) =>
  s.incidents
    .filter((i) => i.targetId === targetId && i.status === "Open")
    .sort(orderOpenIncidents)[0];
const openIncidentsOf = (s: RepositoryState, targetId: TargetId) =>
  s.incidents.filter(
    (i) => i.targetId === targetId && i.status === "Open",
  );

// Structural identity: schema classes carry structural equality, but the
// persistence contract compares the persisted JSON form, timestamps included.
const equalCheck = (a: CheckResult, b: CheckResult) =>
  JSON.stringify({ ...a, checkedAt: a.checkedAt.toISOString() }) ===
  JSON.stringify({ ...b, checkedAt: b.checkedAt.toISOString() });

const conflicting = (id: string) =>
  new RepositoryError({
    operation: "saveCheck",
    cause: `check id ${id} already has different contents`,
  });

/**
 * Volatile repository: one atomic Ref holds all state, so transitions are
 * serialized by construction — two concurrent failures produce exactly one
 * Opened and one Updated without any external mutex (module 08).
 */
export const InMemoryLayer = Layer.effect(CheckRepository)(
  Effect.gen(function*() {
    const state = yield* Ref.make<RepositoryState>({
      targets: [],
      checks: [],
      incidents: [],
    });
    const applyCheckWithIncident = (c: CheckResult) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        Ref.modify(state, (s): readonly [Effect.Effect<IncidentTransition, RepositoryError>, RepositoryState] => {
          const existing = s.checks.find((x) => x.id === c.id);
          if (existing)
            return [
              equalCheck(existing, c)
                ? Effect.succeed("Unchanged" as const)
                : Effect.fail(conflicting(c.id)),
              s,
            ];
          const withCheck: RepositoryState = {
            ...s,
            checks: [...s.checks, cloneCheck(c)],
          };
          const outcome = decideTransition({
            targetChecks: withCheck.checks.filter((x) => x.targetId === c.targetId && x.id !== c.id),
            targetIncidents: withCheck.incidents.filter((i) => i.targetId === c.targetId),
            check: c,
            now,
          });
          const incidents =
            "incidents" in outcome
              ? withCheck.incidents.map(
                  (i) => outcome.incidents.find((x) => x.id === i.id) ?? i,
                ).concat(outcome.incidents.filter((x) => !withCheck.incidents.some((y) => y.id === x.id)))
              : withCheck.incidents;
          return [Effect.succeed(outcome.transition), { ...withCheck, incidents }];
        }).pipe(Effect.flatten),
      );
    const shape: CheckRepositoryShape = {
      saveTarget: (t) =>
        Ref.update(state, (s) => ({
          ...s,
          targets: [
            ...s.targets.filter((x) => x.id !== t.id),
            cloneTarget(t),
          ],
        })),
      listTargets: () =>
        Effect.map(Ref.get(state), (s) =>
          [...s.targets].map(cloneTarget).sort((a, b) => compare(a.id, b.id)),
        ),
      saveCheck: (c) =>
        Ref.modify(state, (s): readonly [Effect.Effect<void, RepositoryError>, RepositoryState] => {
          const existing = s.checks.find((x) => x.id === c.id);
          if (existing)
            return [
              equalCheck(existing, c) ? Effect.void : Effect.fail(conflicting(c.id)),
              s,
            ];
          return [Effect.void, { ...s, checks: [...s.checks, cloneCheck(c)] }];
        }).pipe(Effect.flatten),
      listChecks: (id) =>
        Effect.map(Ref.get(state), (s) =>
          s.checks
            .filter((c) => !id || c.targetId === id)
            .map(cloneCheck)
            .sort(orderChecks),
        ),
      getIncident: (id) =>
        Effect.map(Ref.get(state), (s) => {
          const i = s.incidents.find((x) => x.id === id);
          return i ? Option.some(cloneIncident(i)) : Option.none();
        }),
      getOpenIncident: (id) =>
        Effect.map(Ref.get(state), (s) => {
          const i = openIncident(s, id);
          return i ? Option.some(cloneIncident(i)) : Option.none();
        }),
      saveIncident: (i) =>
        Ref.update(state, (s) => ({
          ...s,
          incidents: [
            ...s.incidents.filter((x) => x.id !== i.id),
            cloneIncident(i),
          ],
        })),
      applyCheck: applyCheckWithIncident,
    };
    return shape;
  }),
);
export const InMemory = { layer: InMemoryLayer };

// ---------- Shared transition decision (used by both repositories).

export type DecisionOutcome =
  | { readonly transition: "Unchanged"; readonly incidents: ReadonlyArray<Incident> }
  | {
      readonly transition: "Opened" | "Updated" | "Closed";
      readonly incidents: ReadonlyArray<Incident>;
    };
export const decideTransition = (input: {
  readonly targetChecks: ReadonlyArray<CheckResult>;
  readonly targetIncidents: ReadonlyArray<Incident>;
  readonly check: CheckResult;
  readonly now: number;
}): DecisionOutcome => {
  const { targetChecks, targetIncidents, check: c, now } = input;
  const newer = targetChecks.some((x) => x.checkedAt > c.checkedAt);
  if (newer) return { transition: "Unchanged", incidents: targetIncidents };
  const bad = ["Down", "Slow", "InvalidResponse"].includes(c.classification._tag);
  if (bad) {
    const reason = Option.isSome(c.failure)
      ? c.failure.value.reason
      : c.classification._tag;
    const opens = targetIncidents.filter((i) => i.status === "Open");
    const open = opens.sort(
      (a, b) =>
        b.openedAt.getTime() - a.openedAt.getTime() ||
        Buffer.compare(Buffer.from(b.id), Buffer.from(a.id)),
    )[0];
    if (open) {
      const updated = new Incident({
        id: open.id,
        targetId: open.targetId,
        openedAt: open.openedAt,
        status: open.status,
        reason,
        latestCheckId: c.id,
        summary: open.summary,
        closedAt: open.closedAt,
      });
      return {
        transition: "Updated",
        incidents: [
          ...targetIncidents.filter((i) => i.id !== open.id),
          updated,
        ],
      };
    }
    return {
      transition: "Opened",
      incidents: [
        ...targetIncidents,
        new Incident({
          id: `incident_${randomUUID()}` as IncidentId,
          targetId: c.targetId,
          openedAt: new Date(now),
          status: "Open",
          reason,
          latestCheckId: c.id,
          summary: Option.none(),
          closedAt: Option.none(),
        }),
      ],
    };
  }
  if (c.classification._tag === "Up" && opens(targetIncidents).length > 0) {
    const closes = opens(targetIncidents).map(
      (i) =>
        new Incident({
          id: i.id,
          targetId: i.targetId,
          openedAt: i.openedAt,
          status: "Closed",
          reason: i.reason,
          latestCheckId: c.id,
          summary: i.summary,
          closedAt: Option.some(new Date(Math.max(now, i.openedAt.getTime()))),
        }),
    );
    return {
      transition: "Closed",
      incidents: [
        ...targetIncidents.filter((i) => !closes.some((x) => x.id === i.id)),
        ...closes,
      ],
    };
  }
  return { transition: "Unchanged", incidents: targetIncidents };
};
const opens = (incidents: ReadonlyArray<Incident>) =>
  incidents.filter((i) => i.status === "Open");
