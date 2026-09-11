import { Context, Layer, Option } from "effect";
import { randomUUID } from "node:crypto";
import {
  CheckResult,
  Incident,
  Target,
  cloneCheck,
  cloneIncident,
  cloneTarget,
  type TargetId,
} from "../domain/schema.js";
import { RepositoryError } from "../domain/errors.js";
export type IncidentTransition = "Opened" | "Updated" | "Closed" | "Unchanged";
export interface CheckRepositoryShape {
  saveTarget(t: Target): Promise<void>;
  listTargets(): Promise<readonly Target[]>;
  saveCheck(c: CheckResult): Promise<void>;
  listChecks(targetId?: TargetId): Promise<readonly CheckResult[]>;
  getIncident(id: string): Promise<Option.Option<Incident>>;
  getOpenIncident(id: TargetId): Promise<Option.Option<Incident>>;
  saveIncident(i: Incident): Promise<void>;
  applyCheck(c: CheckResult): Promise<IncidentTransition>;
}
export class CheckRepository extends Context.Service<CheckRepository, CheckRepositoryShape>()("beaconwatch/CheckRepository") {}
const compare = (a: string, b: string) =>
  Buffer.compare(Buffer.from(a), Buffer.from(b));
const equalCheck = (a: CheckResult, b: CheckResult) =>
  JSON.stringify({ ...a, checkedAt: a.checkedAt.toISOString() }) ===
  JSON.stringify({ ...b, checkedAt: b.checkedAt.toISOString() });
export class InMemoryCheckRepository implements CheckRepositoryShape {
  private targets = new Map<string, Target>();
  private checks = new Map<string, CheckResult>();
  private incidents = new Map<string, Incident>();
  async saveTarget(t: Target) {
    this.targets.set(t.id, cloneTarget(t));
  }
  async listTargets() {
    return [...this.targets.values()]
      .map(cloneTarget)
      .sort((a, b) => compare(a.id, b.id));
  }
  async saveCheck(c: CheckResult) {
    const old = this.checks.get(c.id);
    if (old && !equalCheck(old, c))
      throw new RepositoryError({
        operation: "saveCheck",
        cause: `check id ${c.id} already has different contents`,
      });
    if (!old) this.checks.set(c.id, cloneCheck(c));
  }
  async listChecks(id?: TargetId) {
    return [...this.checks.values()]
      .filter((c) => !id || c.targetId === id)
      .map(cloneCheck)
      .sort(
        (a, b) =>
          a.checkedAt.getTime() - b.checkedAt.getTime() || compare(a.id, b.id),
      );
  }
  async getIncident(id: string): Promise<Option.Option<Incident>> {
    const i = this.incidents.get(id);
    return i ? Option.some(cloneIncident(i)) : Option.none();
  }
  async getOpenIncident(id: TargetId): Promise<Option.Option<Incident>> {
    const i = [...this.incidents.values()]
      .filter((x) => x.targetId === id && x.status === "Open")
      .sort(
        (a, b) =>
          b.openedAt.getTime() - a.openedAt.getTime() || compare(b.id, a.id),
      )[0];
    return i ? Option.some(cloneIncident(i)) : Option.none();
  }
  async saveIncident(i: Incident) {
    this.incidents.set(i.id, cloneIncident(i));
  }
  private tail: Promise<unknown> = Promise.resolve();
  // Transitions are serialized against concurrent applyCheck calls so that
  // two concurrent failures produce exactly one Opened and one Updated.
  async applyCheck(c: CheckResult): Promise<IncidentTransition> {
    const run = () => this.applyCheckUnserialized(c);
    const result = this.tail.then(run, run);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  private async applyCheckUnserialized(c: CheckResult): Promise<IncidentTransition> {
    let result: IncidentTransition = "Unchanged";
    {
      const old = this.checks.get(c.id);
      if (old) {
        if (!equalCheck(old, c))
          throw new RepositoryError({
            operation: "saveCheck",
            cause: `check id ${c.id} already has different contents`,
          });
        return result;
      }
      const newer = [...this.checks.values()].some(
        (x) => x.targetId === c.targetId && x.checkedAt > c.checkedAt,
      );
      this.checks.set(c.id, cloneCheck(c));
      if (newer) return result;
      const openResult = await this.getOpenIncident(c.targetId);
      const bad = ["Down", "Slow", "InvalidResponse"].includes(
        c.classification._tag,
      );
      if (bad) {
        const reason = Option.isSome(c.failure)
          ? c.failure.value.reason
          : c.classification._tag;
        if (Option.isSome(openResult)) {
          const open = openResult.value;
          await this.saveIncident(
            new Incident({
              id: open.id,
              targetId: open.targetId,
              openedAt: open.openedAt,
              status: open.status,
              reason,
              latestCheckId: c.id,
            }),
          );
          result = "Updated";
        } else {
          await this.saveIncident(
            new Incident({
              id: `incident_${randomUUID()}`,
              targetId: c.targetId,
              openedAt: new Date(),
              status: "Open",
              reason,
              latestCheckId: c.id,
            }),
          );
          result = "Opened";
        }
      } else if (c.classification._tag === "Up") {
        const opens = [...this.incidents.values()].filter(
          (x) => x.targetId === c.targetId && x.status === "Open",
        );
        if (opens.length) {
          for (const i of opens)
            await this.saveIncident(
              new Incident({
                id: i.id,
                targetId: i.targetId,
                openedAt: i.openedAt,
                status: "Closed",
                closedAt: new Date(Math.max(Date.now(), i.openedAt.getTime())),
                reason: i.reason,
                latestCheckId: c.id,
                ...(Option.isSome(i.summary) ? { summary: i.summary.value } : {}),
              }),
            );
          result = "Closed";
        }
      }
      return result;
    }
  }
}
export const InMemory = () => new InMemoryCheckRepository();
export const InMemoryLayer = Layer.succeed(CheckRepository)(new InMemoryCheckRepository());
