import type { TargetId } from "../domain/schema.js";
import type { TargetDigest } from "../services/DigestService.js";
export class DigestCache {
  private entries = new Map<string, { expires: number; value: Promise<TargetDigest> }>();
  constructor(
    private compute: (id: TargetId) => Promise<TargetDigest>,
    private ttl = 60_000,
    private capacity = 128,
  ) {}
  async get(id: TargetId) {
    const now = Date.now(),
      key = `digest:${String(id).toLowerCase()}`,
      old = this.entries.get(key);
    if (old && old.expires > now) return { ...(await old.value) };
    const value = this.compute(id);
    this.entries.set(key, { expires: now + this.ttl, value });
    if (this.entries.size > this.capacity)
      this.entries.delete(this.entries.keys().next().value!);
    return { ...(await value) };
  }
  async getConcurrent(id: TargetId) {
    const key = `digest:${String(id).toLowerCase()}`, old = this.entries.get(key);
    if (old) return { ...(await old.value) };
    const result = await this.compute(id);
    this.entries.set(key, { expires: Date.now() + this.ttl, value: Promise.resolve(result) });
    return { ...result };
  }
  async invalidate(id: TargetId) {
    this.entries.delete(String(id).toLowerCase());
  }
}
export const makeLayer = (
  c: (id: TargetId) => Promise<TargetDigest>,
  ttl?: number,
) => new DigestCache(c, ttl);
