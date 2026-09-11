import { Effect } from "effect";
import { ConfigError } from "../domain/errors.js";
export interface ConnectionHandle {
  readonly id: number;
}
export interface LayerOptions {
  onAcquire?(h: ConnectionHandle): void | Promise<void>;
  onRelease?(h: ConnectionHandle): void | Promise<void>;
}
export class ConnectionPool {
  readonly size: number;
  private active = 0;
  private next = 0;
  private waiting: Array<() => void> = [];
  constructor(
    size: number,
    private options: LayerOptions = {},
  ) {
    if (!Number.isSafeInteger(size) || size <= 0)
      throw new ConfigError({
        reason: "connection pool size must be a positive integer",
      });
    this.size = size;
  }
  async withConnection<A>(
    work: ((h: ConnectionHandle) => Promise<A>) | Promise<A>,
  ): Promise<A> {
    if (this.active >= this.size)
      await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    const h = { id: this.next++ };
    await this.options.onAcquire?.(h);
    const value = await (typeof work === "function" ? work(h) : work);
    await this.options.onRelease?.(h);
    this.active--;
    this.waiting.shift()?.();
    return value;
  }
}
export const layer = (size: number, options?: LayerOptions) =>
  new ConnectionPool(size, options);
export const withConnection = <A>(
  pool: ConnectionPool,
  work: (h: ConnectionHandle) => Promise<A>,
) => pool.withConnection(work);

export const nestedResourcesEffect = (
  events: string[],
  failures: { use?: boolean; outerRelease?: boolean; innerRelease?: boolean } = {},
): Effect.Effect<void> => {
  const acquire = (name: "outer" | "inner", failRelease: boolean) =>
    Effect.acquireRelease(
      Effect.sync(() => { events.push(`acquire-${name}`); }),
      () => Effect.sync(() => {
        events.push(`release-${name}`);
        if (failRelease) throw new Error(`${name} release failed`);
      }),
    );
  return Effect.scoped(
    Effect.gen(function*() {
      yield* acquire("outer", failures.outerRelease ?? false);
      yield* acquire("inner", failures.innerRelease ?? false);
      if (failures.use) yield* Effect.die(new Error("nested use failed"));
      events.push("use");
    }),
  );
};

export class ClientCache {
  private clients: ConnectionHandle[] = [];
  checkout() { return this.clients.pop() ?? { id: Date.now() }; }
  release(client: ConnectionHandle) { this.clients.push(client); }
  invalidate(_client: ConnectionHandle) { /* discarded, not returned to pool */ }
}
