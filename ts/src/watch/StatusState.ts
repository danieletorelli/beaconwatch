import {
  cloneCheck,
  cloneIncident,
  type CheckResult,
  type Incident,
  type TargetId,
} from "../domain/schema.js";
export interface StatusEntry {
  latest: CheckResult;
  openIncident?: Incident;
}
const copy = (e: StatusEntry): StatusEntry => ({
  latest: cloneCheck(e.latest),
  ...(e.openIncident ? { openIncident: cloneIncident(e.openIncident) } : {}),
});
export class StatusState {
  private state = new Map<TargetId, StatusEntry>();
  async update(check: CheckResult, incident?: Incident) {
    const old = this.state.get(check.targetId);
    if (
      old &&
      (old.latest.checkedAt > check.checkedAt ||
        (old.latest.checkedAt.getTime() === check.checkedAt.getTime() &&
          Buffer.compare(Buffer.from(old.latest.id), Buffer.from(check.id)) >
            0))
    )
      return;
    await Promise.resolve();
    this.state.set(
      check.targetId,
      copy({ latest: check, ...(incident ? { openIncident: incident } : {}) }),
    );
  }
  async get(id: TargetId) {
    const x = this.state.get(id);
    return x && copy(x);
  }
  async snapshot() {
    return new Map([...this.state].map(([k, v]) => [k, copy(v)]));
  }
}
export class Readiness {
  ready = false;
  result?: string;
  async wait() { while (!this.ready) await new Promise((r) => setTimeout(r, 10)); return this.result; }
  complete(value: string) { this.result = value; this.ready = true; }
  fail(_error: unknown) {}
  reset() { this.ready = false; }
  async runGeneration(value: string) {
    if (this.result !== undefined) { this.ready = true; return this.wait(); }
    this.complete(value);
    return this.wait();
  }
}
export const InMemory = () => new StatusState();
