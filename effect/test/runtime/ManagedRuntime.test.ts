import { afterAll, describe, expect, it } from "vitest"
import { Effect } from "effect"
import { dispose, runPromise } from "../../src/runtime/ManagedRuntime.js"
import { IncidentSummarizer } from "../../src/services/IncidentSummarizer.js"

// Part 15.2 — ManagedRuntime: a long-lived runtime that memoizes its layer so a
// non-Effect host (framework / brownfield) can run many effects against shared
// services without rebuilding the dependency graph each call, then dispose once.
describe("Part 15.2 — ManagedRuntime adapter", () => {
  afterAll(() => dispose())

  it("runs effects against pre-built services without per-call layer provision", async () => {
    const tag = await runPromise(IncidentSummarizer.pipe(Effect.map((s) => typeof s.summarize)))
    expect(tag).toBe("function")
  })

  it("memoizes the runtime across multiple runs (same service instance)", async () => {
    const program = IncidentSummarizer
    const a = await runPromise(program)
    const b = await runPromise(program)
    expect(a).toBe(b)
  })
})
