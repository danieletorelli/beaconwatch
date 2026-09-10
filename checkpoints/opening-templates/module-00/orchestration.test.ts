import { describe, expect, it } from "vitest";
import { eagerStartup } from "../../src/main.js";
import { IncidentService } from "../../src/services/IncidentService.js";
import type { CheckRepositoryShape } from "../../src/repo/CheckRepository.js";
import type { CheckResult } from "../../src/domain/schema.js";

describe("orchestration timing", () => {
  it("records when startup loading begins", () => {
    let starts = 0;
    const start = eagerStartup(async () => { starts++; });
    expect(starts).toBe(1);
    expect(start()).toBeInstanceOf(Promise);
  });

  it("records acknowledgement and repository settlement separately", async () => {
    let settle!: () => void;
    let calls = 0, settled = false;
    const applied = new Promise<void>((resolve) => { settle = () => { settled = true; resolve(); }; });
    const repo = { applyCheck: () => { calls++; return applied; } } as unknown as CheckRepositoryShape;
    const service = new IncidentService(repo);
    expect(service.acknowledge({} as CheckResult)).toBe("acknowledged");
    expect(calls).toBe(1);
    expect(settled).toBe(false);
    settle();
    await applied;
    expect(settled).toBe(true);
  });
});
