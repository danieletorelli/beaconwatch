import { Context, Deferred, Effect, Layer, Option, Ref } from "effect";
import {
  cloneCheck,
  cloneIncident,
  type CheckResult,
  type Incident,
  type TargetId,
} from "../domain/schema.js";
export interface StatusEntry {
  latest: CheckResult;
  openIncident: Option.Option<Incident>;
}
const copy = (e: StatusEntry): StatusEntry => ({
  latest: cloneCheck(e.latest),
  openIncident: Option.isSome(e.openIncident)
    ? Option.some(cloneIncident(e.openIncident.value))
    : Option.none(),
});
export interface StatusStateShape {
  readonly update: (
    check: CheckResult,
    incident?: Option.Option<Incident>,
  ) => Effect.Effect<void>;
  readonly get: (targetId: TargetId) => Effect.Effect<Option.Option<StatusEntry>>;
  readonly snapshot: Effect.Effect<Map<TargetId, StatusEntry>>;
}
export class StatusState extends Context.Service<StatusState, StatusStateShape>()("beaconwatch/StatusState") {}
// Atomic status state: updates are a single Ref transition, so an older
// check can never replace a newer entry (module 08).
export const StatusStateLayer = Layer.effect(StatusState)(
  Effect.gen(function*() {
    const state = yield* Ref.make(new Map<TargetId, StatusEntry>());
    return {
      update: (check, incident = Option.none()) =>
        Ref.update(state, (map) => {
          const old = map.get(check.targetId);
          if (
            old &&
            (old.latest.checkedAt > check.checkedAt ||
              (old.latest.checkedAt.getTime() === check.checkedAt.getTime() &&
                Buffer.compare(Buffer.from(old.latest.id), Buffer.from(check.id)) > 0))
          )
            return map;
          const next = new Map(map);
          next.set(check.targetId, copy({ latest: check, openIncident: incident }));
          return next;
        }),
      get: (id) =>
        Effect.map(Ref.get(state), (map) => {
          const x = map.get(id);
          return x ? Option.some(copy(x)) : Option.none();
        }),
      snapshot: Effect.map(Ref.get(state), (map) =>
        new Map([...map].map(([k, v]) => [k, copy(v)]))
      ),
    };
  }),
);

export class ReadinessEffect {
  private deferred: Deferred.Deferred<string, string>;
  private constructor(deferred: Deferred.Deferred<string, string>) {
    this.deferred = deferred;
  }
  static create = Effect.map(Deferred.make<string, string>(), (d) => new ReadinessEffect(d));
  get wait() { return Deferred.await(this.deferred); }
  complete(value: string) { return Deferred.succeed(this.deferred, value); }
  fail(error: string) { return Deferred.fail(this.deferred, error); }
}
