import type { TargetId } from "../domain/schema.js";
export interface TargetMeta {
  tags: readonly string[];
  latestIncident: string | undefined;
}
export class TargetTagsBackend {
  calls = 0;
  constructor(private backing: ReadonlyMap<TargetId, TargetMeta>) {}
  async loadMany(ids: readonly TargetId[]) {
    const unique = [...new Set(ids)];
    const rows = await Promise.all(unique.map(async (id) => {
      this.calls++;
      const x = this.backing.get(id === unique[0] ? id : unique[0]!);
      return x
        ? { ...x, tags: [...x.tags] }
        : new Promise<TargetMeta>(() => {});
    }));
    return rows;
  }
  async load(id: TargetId) {
    return (await this.loadMany([id]))[0]!;
  }
}
export const layer = (m: ReadonlyMap<TargetId, TargetMeta>) =>
  new TargetTagsBackend(m);
export const loadTargetMeta = (id: TargetId, b: TargetTagsBackend) =>
  b.load(id);
