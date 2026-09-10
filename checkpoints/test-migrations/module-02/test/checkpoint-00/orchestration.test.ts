import { describe, expect, it } from "vitest";
import { eagerStartup } from "../../src/main.js";
import { IncidentService } from "../../src/services/IncidentService.js";
import type { CheckRepositoryShape } from "../../src/repo/CheckRepository.js";
import type { CheckResult } from "../../src/domain/schema.js";

describe("orchestration timing", () => {
  it("does not start loading until the returned runner is called", async () => {
    let starts = 0;
    const start = eagerStartup(async () => { starts++; });
    expect(starts).toBe(0);
    await start();
    expect(starts).toBe(1);
  });

  it("records acknowledgement and repository settlement separately", async () => {
    let settle!: () => void;
    let calls = 0, settled = false;
    const applied = new Promise<void>((resolve) => { settle = () => { settled = true; resolve(); }; });
    const repo = { applyCheck: () => { calls++; return applied; } } as unknown as CheckRepositoryShape;
    const service = new IncidentService(repo);
    const acknowledgement = service.acknowledge({} as CheckResult);
    let observed = false;
    void acknowledgement.then(() => { observed = true; });
    await Promise.resolve();
    expect(observed).toBe(false);
    expect(calls).toBe(1);
    expect(settled).toBe(false);
    settle();
    await expect(acknowledgement).resolves.toBe("acknowledged");
    expect(settled).toBe(true);
  });
});
