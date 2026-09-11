import { Deferred, Effect, Option, Ref } from "effect";
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
export class StatusStateEffect {
  private state: Ref.Ref<Map<TargetId, StatusEntry>>;
  private constructor(state: Ref.Ref<Map<TargetId, StatusEntry>>) {
    this.state = state;
  }
  static create = Effect.map(Ref.make(new Map<TargetId, StatusEntry>()), (state) => new StatusStateEffect(state));
  update(check: CheckResult, incident: Option.Option<Incident> = Option.none()): Effect.Effect<void> {
    return Ref.update(this.state, (map) => {
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
    });
  }
  get(id: TargetId): Effect.Effect<Option.Option<StatusEntry>> {
    return Effect.map(Ref.get(this.state), (map) => {
      const x = map.get(id);
      return x ? Option.some(copy(x)) : Option.none();
    });
  }
  snapshot(): Effect.Effect<Map<TargetId, StatusEntry>> {
    return Effect.map(Ref.get(this.state), (map) =>
      new Map([...map].map(([k, v]) => [k, copy(v)]))
    );
  }
}

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
