import { Effect } from "effect";
import type { TargetId } from "../domain/schema.js";

export interface StatusBoardSnapshot {
  globalDegradedCount: number;
  tagDegradedCounts: ReadonlyMap<string, number>;
}

export class StatusBoard {
  private targets = new Map<TargetId, string>();
  private tags = new Map<string, number>();

  openIncidentEffect(id: TargetId, tag: string): Effect.Effect<void> {
    return Effect.sync(() => {
      const old = this.targets.get(id);
      if (old === tag) return;
      if (old) this.bump(old, -1);
      this.targets.set(id, tag);
      this.bump(tag, 1);
    });
  }

  closeIncidentEffect(id: TargetId): Effect.Effect<void> {
    return Effect.sync(() => {
      const old = this.targets.get(id);
      if (!old) return;
      this.targets.delete(id);
      this.bump(old, -1);
    });
  }

  snapshotEffect(): Effect.Effect<StatusBoardSnapshot> {
    return Effect.sync(() => ({
      globalDegradedCount: this.targets.size,
      tagDegradedCounts: new Map(this.tags),
    }));
  }

  private bump(tag: string, n: number) {
    const x = (this.tags.get(tag) ?? 0) + n;
    x ? this.tags.set(tag, x) : this.tags.delete(tag);
  }
}

export const retriedUpdateEffect = (
  board: StatusBoard,
  id: TargetId,
  tag: string,
  notify: () => void,
): Effect.Effect<void> =>
  Effect.gen(function*() {
    let version = 0;
    const transaction = Effect.gen(function*() {
      const observed = version;
      notify();
      yield* Effect.sleep(0); // yield point
      if (observed !== version) return false;
      yield* board.openIncidentEffect(id, tag);
      return true;
    });
    const first = yield* transaction;
    version++;
    if (!first) yield* transaction;
  });

export const snapshotDuringAbortEffect = (
  board: StatusBoard,
  id: TargetId,
  tag: string,
  signal: AbortSignal,
): Effect.Effect<StatusBoardSnapshot> =>
  Effect.gen(function*() {
    const writeEffect = board.openIncidentEffect(id, tag);
    yield* Effect.sleep(0); // yield point
    const observed = yield* board.snapshotEffect();
    if (signal.aborted) return yield* Effect.die(signal.reason);
    yield* Effect.sleep(0); // yield point (wait for abort)
    yield* writeEffect;
    return observed;
  });

export const makeEffect = (): Effect.Effect<StatusBoard> =>
  Effect.sync(() => new StatusBoard());
