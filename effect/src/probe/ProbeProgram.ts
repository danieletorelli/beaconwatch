import { randomUUID } from "node:crypto"
import { Ajv } from "ajv"
import { Clock, Duration, Effect, Result, Schedule } from "effect"
import { DnsError, HealthSchemaParseError, InvalidBody, TargetDisabled, TimeoutError, UnexpectedStatus, type DomainError } from "../domain/errors.js"
import { CheckFailure, CheckResult, Down, InvalidResponse, ResponseMetadata, Slow, Up, type Target, type TargetConfig } from "../domain/schema.js"
import { classifyProbe } from "../domain/values.js"
import { ProbeClient, type ProbeFailure } from "../services/ProbeClient.js"

const retryPolicy = Schedule.exponential("10 millis").pipe(Schedule.upTo({ times: 3 }), Schedule.jittered)
const isTransient = (e: DomainError): e is DnsError | TimeoutError => e._tag === "DnsError" || e._tag === "TimeoutError"
const bodyMatches = Effect.fn("ProbeProgram.bodyMatches")(
  function*(schemaJson: string, body: unknown) {
    return yield* Effect.try({
      try: () => {
        const schema = JSON.parse(schemaJson)
        const ajv = new Ajv({ strictSchema: false })
        const validate = ajv.compile(schema)
        if ((validate as typeof validate & { readonly $async?: boolean }).$async === true) throw new Error("async schemas are not supported")
        return validate(body) === true
      },
      catch: (cause) => new HealthSchemaParseError({ reason: String(cause) })
    })
  }
)

export const probeOnce = (target: Target | TargetConfig) => Effect.gen(function*() {
  if ("enabled" in target && !target.enabled) return yield* Effect.fail(new TargetDisabled({ targetId: target.id }))
  const client = yield* ProbeClient
  const start = yield* Clock.currentTimeMillis
  const rawResult = yield* client.probe(target).pipe(
    Effect.timeoutOption(target.timeout),
    Effect.flatMap((o) => o._tag === "None" ? Effect.fail(new TimeoutError({ timeout: Duration.format(target.timeout) })) : Effect.succeed(o.value)),
    Effect.retry({ schedule: retryPolicy, while: isTransient }),
    Effect.result
  )
  let status: number | undefined
  let bytes: number | undefined
  let failure: DomainError | undefined
  let bodyValid = true
  if (Result.isSuccess(rawResult)) {
    const rawStatus = rawResult.success.status
    if (Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599) {
      status = rawStatus
      if (!target.expectedStatus.includes(rawStatus)) failure = new UnexpectedStatus({ expected: target.expectedStatus, actual: rawStatus })
    }
    else failure = new UnexpectedStatus({ expected: target.expectedStatus, actual: rawStatus })
    bytes = target.method === "HEAD" ? 0 : rawResult.success.bytes
    if (failure === undefined && target.method !== "HEAD" && target.healthBodySchema !== undefined) {
      const matched = yield* Effect.result(bodyMatches(target.healthBodySchema, rawResult.success.body))
      if (Result.isSuccess(matched)) bodyValid = matched.success
      else failure = matched.failure
    }
  } else {
    failure = rawResult.failure as ProbeFailure
    if (failure._tag === "UnexpectedStatus" && Number.isInteger(failure.actual) && failure.actual >= 100 && failure.actual <= 599) status = failure.actual
  }
  const end = yield* Clock.currentTimeMillis
  const duration = Duration.millis(Math.max(1, end - start))
  const checkedAt = new Date(end)
  const classified = classifyProbe({ target, duration, bodyValid, ...(status === undefined ? {} : { status }), ...(failure === undefined ? {} : { failure }) })
  let classification = Result.isSuccess(classified) ? classified.success : new Down()
  if (Result.isFailure(classified)) failure = classified.failure
  if (failure && ["InvalidBody", "HealthSchemaParseError", "HealthBodyMismatch"].includes(failure._tag)) classification = new InvalidResponse()
  if (classification._tag === "Down" && !failure && status !== undefined) failure = new UnexpectedStatus({ expected: target.expectedStatus, actual: status })
  return new CheckResult({
    id: `check_${randomUUID()}`,
    targetId: target.id,
    checkedAt,
    duration,
    classification,
    ...(failure ? { failure: new CheckFailure({ reason: failure._tag }) } : {}),
    response: new ResponseMetadata({ ...(status === undefined ? {} : { status }), ...(bytes === undefined ? {} : { bytes }) })
  })
})
