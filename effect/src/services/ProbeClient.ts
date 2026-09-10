import { Context, Effect, Layer, Ref } from "effect"
import { ConfigError, DnsError, InvalidBody, TimeoutError, UnexpectedStatus } from "../domain/errors.js"
import type { Target, TargetConfig } from "../domain/schema.js"

export interface RawProbeResponse {
  readonly status: number
  readonly body?: unknown
  readonly bytes?: number
}

export type ProbeFailure = DnsError | TimeoutError | UnexpectedStatus | InvalidBody
export type ProbeTarget = Target | TargetConfig

export interface ProbeClientShape {
  readonly probe: (target: ProbeTarget) => Effect.Effect<RawProbeResponse, ProbeFailure>
}

export class ProbeClient extends Context.Service<ProbeClient, ProbeClientShape>()("beaconwatch/ProbeClient") {}

type ScriptStep =
  | RawProbeResponse
  | ProbeFailure
  | { readonly _tag: "delay"; readonly duration: string; readonly response: RawProbeResponse }
  | { readonly _tag: "recover-after"; readonly failures: number; readonly response: RawProbeResponse }

export const valid = (status = 200): RawProbeResponse => ({ status, body: { ok: true }, bytes: 11 })
export const slow = (duration = "2 seconds", status = 200): ScriptStep => ({ _tag: "delay", duration, response: valid(status) })
export const malformedBody = (_status = 200): InvalidBody => new InvalidBody({ reason: "malformed response body" })
export const statusError = (status = 500): RawProbeResponse => ({ status, body: { ok: false }, bytes: 12 })
export const transportError = (host = "fake.local") => new DnsError({ host })
export const timeoutError = (timeout = "1 second") => new TimeoutError({ timeout })
export const recoverAfter = (failures: number, response: RawProbeResponse = valid()): ScriptStep => ({ _tag: "recover-after", failures, response })

export const Fake = (scripts: Record<string, ScriptStep | ReadonlyArray<ScriptStep>>) =>
  Layer.effect(ProbeClient)(Effect.gen(function*() {
    for (const [key, value] of Object.entries(scripts)) {
      const steps = Array.isArray(value) ? value : [value]
      if (steps.length === 0) return yield* Effect.fail(new ConfigError({ reason: `empty fake script: ${key}` }))
      if (steps.some((step) => !(step instanceof Error) && "_tag" in step && step._tag === "recover-after" && (!Number.isSafeInteger(step.failures) || step.failures < 0))) {
        return yield* Effect.fail(new ConfigError({ reason: `invalid recover-after count: ${key}` }))
      }
    }
    const state = yield* Ref.make(new Map(Object.entries(scripts).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]] as const)))
    const counts = yield* Ref.make(new Map<string, number>())
    const next = (target: ProbeTarget) => Effect.gen(function*() {
      const key = stateKey(target, scripts)
      const step = yield* Ref.modify(state, (m) => {
        const arr = m.get(key) ?? [valid()]
        const [head = valid(), ...tail] = arr
        const nextMap = new Map(m)
        nextMap.set(key, tail.length > 0 ? tail : [head])
        return [head, nextMap] as const
      })
      if (step instanceof DnsError || step instanceof TimeoutError || step instanceof UnexpectedStatus || step instanceof InvalidBody) {
        return yield* Effect.fail(step)
      }
      if ("_tag" in step && step._tag === "delay") {
        yield* Effect.sleep(step.duration)
        return step.response
      }
      if ("_tag" in step && step._tag === "recover-after") {
        const attempt = yield* Ref.modify(counts, (m) => {
          const n = (m.get(key) ?? 0) + 1
          const nm = new Map(m); nm.set(key, n)
          return [n, nm] as const
        })
        if (attempt <= step.failures) return yield* Effect.fail(new DnsError({ host: new URL(target.url).host }))
        return step.response
      }
      return step
    })
    return { probe: next }
  }))

const stateKey = (target: ProbeTarget, scripts: Record<string, unknown>) => target.id in scripts ? target.id : target.url

export const ProbeClientFake = { Fake, valid, slow, malformedBody, statusError, transportError, timeoutError, recoverAfter }
