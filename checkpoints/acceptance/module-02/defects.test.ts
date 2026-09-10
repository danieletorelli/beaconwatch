import { expect, it } from "vitest"
import { eagerStartup } from "../../../src/main.js"
import { IncidentService } from "../../../src/services/IncidentService.js"
import { HttpProbeClient } from "../../../src/services/HttpProbeClient.js"
import { Duration } from "effect"
import * as Domain from "../../../src/domain/schema.js"
import { TargetConfig, type CheckResult } from "../../../src/domain/schema.js"
import type { CheckRepositoryShape } from "../../../src/repo/CheckRepository.js"

const duration = (millis: number): any => "DurationFromInput" in Domain ? Duration.millis(millis) : millis

it("DP-01", async () => {
  const failure = new Error("late save")
  let reject!: (error: Error) => void
  const operation = new Promise<never>((_resolve, fail) => { reject = fail }); operation.catch(() => {})
  const service = new IncidentService({ applyCheck: () => operation } as unknown as CheckRepositoryShape)
  const acknowledgement = Promise.resolve(service.acknowledge({} as CheckResult))
  const early = await Promise.race([acknowledgement, new Promise<"pending">(resolve => setTimeout(() => resolve("pending"), 0))])
  reject(failure)
  await expect(acknowledgement).rejects.toBe(failure)
  expect(early).toBe("pending")
})
it("DP-02", async () => { let calls = 0; const run = eagerStartup(async () => { calls++ }); expect(calls).toBe(0); await run(); expect(calls).toBe(1) })
it("DP-08", async () => {
  const ctl = new AbortController()
  let adds = 0, removes = 0
  const add = ctl.signal.addEventListener.bind(ctl.signal), remove = ctl.signal.removeEventListener.bind(ctl.signal)
  ctl.signal.addEventListener = ((...a: Parameters<typeof add>) => { adds++; return add(...a) }) as typeof add
  ctl.signal.removeEventListener = ((...a: Parameters<typeof remove>) => { removes++; return remove(...a) }) as typeof remove
  const reason = new Error("caller aborted")
  let accept: string | null = null
  const client = new HttpProbeClient((_url, init) => new Promise((_r, reject) => {
    accept = new Headers(init?.headers).get("accept")
    init?.signal?.addEventListener("abort", () => reject(reason))
  }))
  const target = new TargetConfig({ id: "target_abort", name: "Abort", url: "https://example.test", method: "GET", expectedStatus: [200], interval: duration(1), timeout: duration(1000), slowThreshold: duration(2) })
  const pending = client.probe(target, ctl.signal)
  ctl.abort(reason)
  await expect(pending).rejects.toBe(reason)
  expect([adds, removes]).toEqual([1, 1])
  expect(accept).toBe("application/json")

  let preCancelledFetches = 0
  const preCancelled = new AbortController(); preCancelled.abort(reason)
  await expect(new HttpProbeClient(async () => { preCancelledFetches++; return new Response() }).probe(target, preCancelled.signal)).rejects.toBe(reason)
  expect(preCancelledFetches).toBe(0)
})
