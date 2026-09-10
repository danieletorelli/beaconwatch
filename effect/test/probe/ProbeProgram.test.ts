import { it } from "@effect/vitest"
import { Cause, Clock, Duration, Effect, Equal, Fiber, Layer, Random } from "effect"
import { TestClock } from "effect/testing"
import { ConfigError, DnsError, InvalidBody, UnexpectedStatus } from "../../src/domain/errors.js"
import { Target } from "../../src/domain/schema.js"
import { probeOnce } from "../../src/probe/ProbeProgram.js"
import { ProbeClient, ProbeClientFake } from "../../src/services/ProbeClient.js"
import { target } from "../helpers.js"

it.effect("classifies fake responses deterministically", () => Effect.gen(function*() {
  const t = target("target_up")
  const up = yield* probeOnce(t).pipe(Effect.provide(ProbeClientFake.Fake({ target_up: ProbeClientFake.valid() })))
  if (up.classification._tag !== "Up") throw new Error("expected Up")
  const down = yield* probeOnce(target("target_down")).pipe(Effect.provide(ProbeClientFake.Fake({ target_down: ProbeClientFake.statusError() })))
  if (down.classification._tag !== "Down") throw new Error("expected Down")
  const invalid = yield* probeOnce(target("target_bad")).pipe(Effect.provide(ProbeClientFake.Fake({ target_bad: ProbeClientFake.malformedBody() })))
  if (invalid.classification._tag !== "InvalidResponse") throw new Error("expected InvalidResponse")
}))

it.effect("treats successful JSON strings as ordinary bodies without a schema", () => Effect.gen(function*() {
  const result = yield* probeOnce(target("target_json_string")).pipe(Effect.provide(ProbeClientFake.Fake({ target_json_string: { status: 200, body: "not-json" } })))
  if (result.classification._tag !== "Up") throw new Error("a successful string body was treated as malformed")
}))

it.effect("HEAD bypasses configured body-schema validation", () => Effect.gen(function*() {
  const value = target("target_head_schema", { method: "HEAD", healthBodySchema: "not a schema" })
  const result = yield* probeOnce(value).pipe(Effect.provide(ProbeClientFake.Fake({ target_head_schema: { status: 200 } })))
  if (result.classification._tag !== "Up") throw new Error("HEAD validated its absent body")
}))

it.effect("rejects async JSON Schemas instead of accepting Promise truthiness", () => Effect.gen(function*() {
  const value = target("target_async_schema", { healthBodySchema: JSON.stringify({ $async: true, type: "object" }) })
  const result = yield* probeOnce(value).pipe(Effect.provide(ProbeClientFake.Fake({ target_async_schema: { status: 200, body: {} } })))
  if (result.classification._tag !== "InvalidResponse") throw new Error("async schema was accepted")
}))

it.effect("reuses identical Draft-7 schemas with an id and accepts extension keywords", () => Effect.gen(function*() {
  const healthBodySchema = JSON.stringify({
    $id: "https://beaconwatch.test/health.schema.json",
    type: "object",
    required: ["ok"],
    properties: { ok: { const: true } },
    "x-beaconwatch-note": "an allowed annotation"
  })
  for (const id of ["target_schema_first", "target_schema_second"]) {
    const result = yield* probeOnce(target(id, { healthBodySchema })).pipe(
      Effect.provide(ProbeClientFake.Fake({ [id]: { status: 200, body: { ok: true } } }))
    )
    if (result.classification._tag !== "Up") throw new Error(`identical schema failed for ${id}`)
  }
}))

it.effect("records completion only after configured body validation", () => Effect.gen(function*() {
  const clock = yield* Clock.Clock
  let validated = false
  const body = Object.defineProperty({}, "ok", {
    enumerable: true,
    get: () => {
      validated = true
      return true
    }
  })
  const timedClock: Clock.Clock = {
    ...clock,
    currentTimeMillisUnsafe: () => validated ? 25 : 10,
    currentTimeMillis: Effect.sync(() => validated ? 25 : 10)
  }
  const result = yield* probeOnce(target("target_validation_timing", {
    healthBodySchema: JSON.stringify({ type: "object", required: ["ok"], properties: { ok: { const: true } } })
  })).pipe(
    Effect.provideService(ProbeClient, { probe: () => Effect.succeed({ status: 200, body }) }),
    Effect.provideService(Clock.Clock, timedClock)
  )
  if (result.checkedAt.getTime() !== 25 || !Equal.equals(result.duration, Duration.millis(15))) {
    throw new Error(`validation was excluded from timing: ${result.checkedAt.getTime()}, ${Duration.format(result.duration)}`)
  }
}))

it.effect("skips schema validation for a successful fake response with an unexpected status", () => Effect.gen(function*() {
  let validated = false
  const body = Object.defineProperty({}, "ok", { enumerable: true, get: () => { validated = true; return false } })
  const result = yield* probeOnce(target("target_unexpected_fake", {
    healthBodySchema: JSON.stringify({ type: "object", required: ["ok"], properties: { ok: { const: true } } })
  })).pipe(Effect.provideService(ProbeClient, { probe: () => Effect.succeed({ status: 503, body }) }))
  if (validated) throw new Error("unexpected-status response body was validated")
  if (result.classification._tag !== "Down" || result.failure?.reason !== "UnexpectedStatus") throw new Error("expected Down/UnexpectedStatus")
  if (result.duration.pipe(Duration.toMillis) < 1) throw new Error("duration was not clamped")
}))

it.effect("retains the received HTTP status when the probe rejects an unexpected status", () => Effect.gen(function*() {
  const result = yield* probeOnce(target("target_unexpected_status")).pipe(
    Effect.provideService(ProbeClient, {
      probe: (value) => Effect.fail(new UnexpectedStatus({ expected: value.expectedStatus, actual: 503 }))
    })
  )
  if (result.response.status !== 503) {
    throw new Error(`expected response metadata status 503, got ${String(result.response.status)}`)
  }
}))

it.effect("omits an out-of-range received status while preserving UnexpectedStatus failure", () => Effect.gen(function*() {
  const result = yield* probeOnce(target("target_status_600")).pipe(
    Effect.provideService(ProbeClient, {
      probe: (value) => Effect.fail(new UnexpectedStatus({ expected: value.expectedStatus, actual: 600 }))
    })
  )
  if (result.classification._tag !== "Down" || result.failure?.reason !== "UnexpectedStatus") {
    throw new Error("expected Down with UnexpectedStatus")
  }
  if (result.response.status !== undefined) throw new Error("invalid status leaked into response metadata")
}))

it.effect("normalizes an out-of-range successful response to Down without status metadata", () => Effect.gen(function*() {
  const result = yield* probeOnce(target("target_success_status_600")).pipe(
    Effect.provide(ProbeClientFake.Fake({ target_success_status_600: ProbeClientFake.statusError(600) }))
  )
  if (result.classification._tag !== "Down" || result.failure?.reason !== "UnexpectedStatus") throw new Error("invalid successful status was not normalized")
  if (result.response.status !== undefined) throw new Error("invalid successful status leaked into metadata")
}))

it.effect("normalizes successful HEAD response bytes to zero", () => Effect.gen(function*() {
  const result = yield* probeOnce(target("target_head_bytes", { method: "HEAD" })).pipe(
    Effect.provide(ProbeClientFake.Fake({ target_head_bytes: { status: 200, bytes: 1234, body: "impossible" } }))
  )
  if (result.response.bytes !== 0) throw new Error(`expected HEAD bytes 0, got ${String(result.response.bytes)}`)
}))

it.effect("preserves every scripted probe failure on the failure channel", () => {
  const invalidBody = new InvalidBody({ reason: "sentinel-invalid-body" })
  return Effect.gen(function*() {
    const client = yield* ProbeClient
    const error = yield* Effect.flip(client.probe(target("target_scripted_failure")))
    if (error !== invalidBody) {
      throw new Error(`expected the scripted InvalidBody instance, got ${error._tag}`)
    }
  }).pipe(Effect.provide(ProbeClientFake.Fake({ target_scripted_failure: invalidBody })))
})

it.effect("rejects empty scripts and invalid recover-after counts at fake layer construction", () => Effect.gen(function*() {
  for (const scripts of [{ target_invalid_fake: [] }, { target_invalid_fake: ProbeClientFake.recoverAfter(-1) }]) {
    const exit = yield* ProbeClient.pipe(Effect.provide(ProbeClientFake.Fake(scripts)), Effect.exit)
    if (exit._tag !== "Failure") throw new Error("invalid fake script was accepted")
    const reason = exit.cause.reasons.find(Cause.isFailReason)
    if (!(reason?.error instanceof ConfigError)) throw new Error("invalid fake script did not fail as ConfigError")
  }
}))

it.effect("classifies a response that violates the configured health body schema as invalid", () => Effect.gen(function*() {
  const t = target("target_schema_body", {
    healthBodySchema: JSON.stringify({ type: "object", required: ["ok"], properties: { ok: { const: true } } })
  })
  const result = yield* probeOnce(t).pipe(Effect.provide(ProbeClientFake.Fake({
    target_schema_body: { status: 200, body: { ok: false }, bytes: 12 }
  })))
  if (result.classification._tag !== "InvalidResponse") {
    throw new Error(`expected InvalidResponse for schema-violating body, got ${result.classification._tag}`)
  }
  if (result.failure?.reason !== "HealthBodyMismatch") throw new Error(`expected HealthBodyMismatch, got ${result.failure?.reason}`)
}))

it.effect("does not treat an empty configured body schema as absent", () => Effect.gen(function*() {
  const t = target("target_empty_schema_body", { healthBodySchema: "" })
  const result = yield* probeOnce(t).pipe(Effect.provide(ProbeClientFake.Fake({
    target_empty_schema_body: { status: 200, body: { ok: true }, bytes: 11 }
  })))
  if (result.classification._tag !== "InvalidResponse") {
    throw new Error(`expected InvalidResponse for an invalid empty schema, got ${result.classification._tag}`)
  }
  if (result.failure?.reason !== "HealthSchemaParseError") throw new Error(`expected HealthSchemaParseError, got ${result.failure?.reason}`)
}))

it.effect("validates a present false health body schema", () => Effect.gen(function*() {
  const t = target("target_false_schema_body", { healthBodySchema: "false" })
  const result = yield* probeOnce(t).pipe(Effect.provide(ProbeClientFake.Fake({
    target_false_schema_body: { status: 200, body: { ok: true }, bytes: 11 }
  })))
  if (result.classification._tag !== "InvalidResponse") {
    throw new Error(`expected InvalidResponse for a false schema, got ${result.classification._tag}`)
  }
}))

it.effect("assigns unique IDs to concurrent checks that finish at the same time", () => Effect.gen(function*() {
  const t = target("target_concurrent_ids")
  const results = yield* Effect.all(
    [probeOnce(t), probeOnce(t)],
    { concurrency: "unbounded" }
  ).pipe(Effect.provide(ProbeClientFake.Fake({ target_concurrent_ids: ProbeClientFake.valid() })))
  if (new Set(results.map((result) => result.id)).size !== results.length) {
    throw new Error(`concurrent checks received duplicate ID ${results[0]?.id}`)
  }
}))

it.effect("rejects disabled targets without sending a probe", () => Effect.gen(function*() {
  const disabled = new Target({ ...target("target_disabled"), enabled: false })
  let probes = 0
  const exit = yield* probeOnce(disabled).pipe(
    Effect.provideService(ProbeClient, {
      probe: () => {
        probes++
        return Effect.succeed({ status: 200, body: { ok: true }, bytes: 2 })
      }
    }),
    Effect.exit
  )
  if (exit._tag !== "Failure") throw new Error("expected disabled target rejection")
  if (probes !== 0) throw new Error(`expected no network probe, got ${probes}`)
}))

it.effect("uses TestClock for production retry, jitter, per-attempt timeout, and slow classification", () => Effect.gen(function*() {
  const clock = yield* Clock.Clock
  const attempts: number[] = []
  const flaky = target("target_flaky", { timeout: Duration.millis(50) })
  const recoveredFiber = yield* probeOnce(flaky).pipe(
    Effect.provideService(ProbeClient, { probe: () => Effect.gen(function*() {
      attempts.push(clock.currentTimeMillisUnsafe())
      if (attempts.length === 1) yield* Effect.sleep("1 second")
      if (attempts.length < 4) return yield* Effect.fail(new DnsError({ host: "target_flaky.test" }))
      return ProbeClientFake.valid()
    }) }),
    Random.withSeed("probe-policy"),
    Effect.forkScoped
  )
  const exhaustedFiber = yield* probeOnce(target("target_exhausted")).pipe(Effect.provide(ProbeClientFake.Fake({ target_exhausted: ProbeClientFake.recoverAfter(4) })), Effect.forkScoped)
  yield* TestClock.adjust("1 second")
  const recovered = yield* Fiber.join(recoveredFiber)
  if (recovered.classification._tag !== "Up") throw new Error("expected recovery on the fourth and final attempt")
  if (attempts.length !== 4) throw new Error(`expected four attempts, got ${attempts.length}`)
  const gaps = attempts.slice(1).map((time, index) => time - attempts[index]!)
  if (gaps[0]! < 58 || gaps[0]! > 62 || gaps[1]! < 16 || gaps[1]! > 24 || gaps[2]! < 32 || gaps[2]! > 48) {
    throw new Error(`expected one 50ms timeout and jittered exponential delays, got ${gaps.join(",")}`)
  }
  const exhausted = yield* Fiber.join(exhaustedFiber)
  if (exhausted.classification._tag !== "Down") throw new Error("expected retry exhaustion after four attempts")
  const slowTarget = target("target_slow")
  const fiber = yield* probeOnce(slowTarget).pipe(Effect.provide(ProbeClientFake.Fake({ target_slow: ProbeClientFake.slow("600 millis") })), Effect.forkScoped)
  yield* TestClock.adjust("600 millis")
  const slow = yield* Fiber.join(fiber)
  if (slow.classification._tag !== "Slow") throw new Error(`expected Slow, got ${slow.classification._tag}`)
  if (!Equal.equals(slow.duration, Duration.millis(600))) throw new Error("duration not measured by clock")
}).pipe(Effect.scoped))
