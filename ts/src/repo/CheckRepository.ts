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
  getIncident(id: string): Promise<Incident | undefined>;
  getOpenIncident(id: TargetId): Promise<Incident | undefined>;
  saveIncident(i: Incident): Promise<void>;
  applyCheck(c: CheckResult): Promise<IncidentTransition>;
}
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
  async getIncident(id: string) {
    const i = this.incidents.get(id);
    return i && cloneIncident(i);
  }
  async getOpenIncident(id: TargetId) {
    const i = [...this.incidents.values()]
      .filter((x) => x.targetId === id && x.status === "Open")
      .sort(
        (a, b) =>
          b.openedAt.getTime() - a.openedAt.getTime() || compare(b.id, a.id),
      )[0];
    return i && cloneIncident(i);
  }
  async saveIncident(i: Incident) {
    this.incidents.set(i.id, cloneIncident(i));
  }
  async applyCheck(c: CheckResult): Promise<IncidentTransition> {
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
      const open = await this.getOpenIncident(c.targetId);
      const bad = ["Down", "Slow", "InvalidResponse"].includes(
        c.classification._tag,
      );
      if (bad) {
        const reason = c.failure?.reason ?? c.classification._tag;
        if (open) {
          await this.saveIncident(
            new Incident({ ...open, reason, latestCheckId: c.id }),
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
                ...i,
                status: "Closed",
                closedAt: new Date(Math.max(Date.now(), i.openedAt.getTime())),
                latestCheckId: c.id,
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
