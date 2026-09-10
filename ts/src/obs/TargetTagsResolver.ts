import { Effect, Option } from "effect";
import type { TargetId } from "../domain/schema.js";

export interface TargetMeta {
  tags: readonly string[];
  latestIncident: Option.Option<string>;
}

export class TargetTagsBackend {
  calls = 0;
  constructor(private backing: ReadonlyMap<TargetId, TargetMeta>) {}

  loadManyEffect(ids: readonly TargetId[]): Effect.Effect<(Option.Option<TargetMeta>)[]> {
    return Effect.sync(() => {
      const unique = [...new Set(ids)];
      return unique.map((id) => {
        this.calls++;
        const x = this.backing.get(id);
        return x
          ? Option.some({ ...x, tags: [...x.tags] })
          : Option.none();
      });
    });
  }

  loadEffect(id: TargetId): Effect.Effect<Option.Option<TargetMeta>> {
    return this.loadManyEffect([id]).pipe(
      Effect.map((rows) => rows[0]!),
    );
  }
}

export const layer = (m: ReadonlyMap<TargetId, TargetMeta>) =>
  new TargetTagsBackend(m);

export const loadTargetMetaEffect = (id: TargetId, b: TargetTagsBackend) =>
  b.loadEffect(id);
