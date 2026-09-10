import { expect, it } from "vitest"
import { Duration, Effect, Exit, Fiber } from "effect"
import { eagerStartup } from "../../src/main.js"
import { IncidentService } from "../../src/services/IncidentService.js"
import { HttpProbeClient } from "../../src/services/HttpProbeClient.js"
import { DnsError } from "../../src/domain/errors.js"
import { TargetConfig, targetId, type CheckResult } from "../../src/domain/schema.js"
import type { CheckRepositoryShape } from "../../src/repo/CheckRepository.js"

const target = () => new TargetConfig({ id: targetId("target_http"), name: "HTTP", url: "https://example.test", method: "GET", expectedStatus: [200], interval: Duration.millis(1), timeout: Duration.millis(50), slowThreshold: Duration.millis(5) })

it("reproduces eager start, premature acknowledgement, and retained listeners", async () => {
  let starts = 0
  const run = eagerStartup(async () => { starts++ })
  const startsBeforeRun = starts

  const repository = { applyCheck: async () => undefined } as unknown as CheckRepositoryShape
  const acknowledgement = new IncidentService(repository).acknowledge({} as CheckResult)
  const acknowledgementIsPromise = acknowledgement instanceof Promise
  if (acknowledgementIsPromise) await acknowledgement

  const controller = new AbortController()
  let adds = 0, removes = 0
  const add = controller.signal.addEventListener.bind(controller.signal)
  const remove = controller.signal.removeEventListener.bind(controller.signal)
  controller.signal.addEventListener = ((...args: Parameters<typeof add>) => { adds++; return add(...args) }) as typeof add
  controller.signal.removeEventListener = ((...args: Parameters<typeof remove>) => { removes++; return remove(...args) }) as typeof remove
  await new HttpProbeClient(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })).probe(target(), controller.signal)

  expect({ startsBeforeRun, acknowledgementIsPromise, listeners: [adds, removes] }).toEqual({
    startsBeforeRun: 0,
    acknowledgementIsPromise: true,
    listeners: [1, 1]
  })
  await run()
})

it("exposes lazy typed Effect programs whose interruption awaits cleanup", async () => {
  const main = await import("../../src/main.js") as any
  expect(main.startupEffect, "expose startup as a lazy Effect program").toBeTypeOf("function")

  let starts = 0
  const startup = main.startupEffect(async () => { starts++ })
  expect(Effect.isEffect(startup)).toBe(true)
  expect(starts).toBe(0)
  await Effect.runPromise(startup)
  expect(starts).toBe(1)

  const failure = new Error("save failed")
  let repositoryCalls = 0
  const service = new IncidentService({ applyCheck: async () => { repositoryCalls++; throw failure } } as unknown as CheckRepositoryShape) as any
  const acknowledgement = service.acknowledgeEffect({} as CheckResult)
  expect(Effect.isEffect(acknowledgement)).toBe(true)
  expect(repositoryCalls).toBe(0)
  await expect(Effect.runPromise(acknowledgement)).rejects.toBe(failure)

  let fetches = 0
  const client = new HttpProbeClient(async () => { fetches++; return new Response(JSON.stringify({ ok: true }), { status: 200 }) }) as any
  const probe = client.probeEffect(target())
  expect(Effect.isEffect(probe)).toBe(true)
  expect(fetches).toBe(0)
  await Effect.runPromise(probe)
  const failed = await Effect.runPromiseExit((new HttpProbeClient(async () => { throw new Error("offline") }) as any).probeEffect(target()))
  expect(Exit.hasFails(failed)).toBe(true)
  if (Exit.isFailure(failed)) expect(failed.cause.reasons.some((reason) => reason._tag === "Fail" && reason.error instanceof DnsError)).toBe(true)

  let requestStarted!: () => void
  const started = new Promise<void>(resolve => { requestStarted = resolve })
  let cleanupStarted!: () => void
  const cleaning = new Promise<void>(resolve => { cleanupStarted = resolve })
  let releaseCleanup!: () => void
  const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve })
  const cancelled = new HttpProbeClient((_input, init) => new Promise((_resolve, reject) => {
    requestStarted()
    init?.signal?.addEventListener("abort", async () => {
      cleanupStarted()
      await cleanupGate
      reject(init.signal!.reason)
    }, { once: true })
  })) as any
  const pending = Effect.runFork(cancelled.probeEffect(target()))
  await started
  let interruptionSettled = false
  const interruption = Effect.runPromise(Fiber.interrupt(pending)).then(() => { interruptionSettled = true })
  await cleaning
  await Promise.resolve()
  expect(interruptionSettled).toBe(false)
  releaseCleanup()
  await interruption
  const exit = await Effect.runPromise(Fiber.await(pending))
  expect(Exit.hasInterrupts(exit)).toBe(true)
})
