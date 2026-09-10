import type { TargetId } from "../domain/schema.js";
export interface StatusBoardSnapshot {
  globalDegradedCount: number;
  tagDegradedCounts: ReadonlyMap<string, number>;
}
export class StatusBoard {
  private targets = new Map<TargetId, string>();
  private tags = new Map<string, number>();
  private async atomic(work: () => void) { await Promise.resolve(); work(); }
  async openIncident(id: TargetId, tag: string, afterTargetWrite?: () => Promise<void>) {
    await Promise.resolve();
    const old = this.targets.get(id);
    if (old === tag) return;
    if (old) this.bump(old, -1);
    this.targets.set(id, tag);
    await afterTargetWrite?.();
    this.bump(tag, 1);
  }
  closeIncident(id: TargetId) {
    return this.atomic(() => {
      const old = this.targets.get(id);
      if (!old) return;
      this.targets.delete(id);
      this.bump(old, -1);
    });
  }
  private bump(tag: string, n: number) {
    const x = (this.tags.get(tag) ?? 0) + n;
    x ? this.tags.set(tag, x) : this.tags.delete(tag);
  }
  async snapshot() {
    return {
      globalDegradedCount: this.targets.size,
      tagDegradedCounts: new Map(this.tags),
    };
  }
}
export const retriedUpdate = async (board: StatusBoard, id: TargetId, tag: string, notify: () => void) => {
  let version = 0;
  const transaction = async () => {
    const observed = version;
    notify();
    await Promise.resolve();
    if (observed !== version) return false;
    await board.openIncident(id, tag);
    return true;
  };
  const first = transaction();
  version++;
  if (!await first) await transaction();
};
export const snapshotDuringAbort = async (
  board: StatusBoard,
  id: TargetId,
  tag: string,
  signal: AbortSignal,
) => {
  let rejectGate!: (reason?: unknown) => void;
  const gate = new Promise<void>((_, reject) => { rejectGate = reject; });
  const write = board.openIncident(id, tag, () => gate);
  await Promise.resolve();
  const observed = await board.snapshot();
  if (signal.aborted) rejectGate(signal.reason);
  else await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
    rejectGate(signal.reason);
    resolve();
  }, { once: true }));
  await write;
  return observed;
};
export const make = async () => new StatusBoard();
