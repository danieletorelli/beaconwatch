import AjvModule from "ajv";
import { Clock, Duration, Effect, Option, Result, Schedule } from "effect";
import { randomUUID } from "node:crypto";
import {
  CheckFailure,
  CheckResult,
  Down,
  InvalidResponse,
  ResponseMetadata,
  type Classification,
  type Target,
  type CheckId,
  type TargetConfig,
} from "../domain/schema.js";
import {
  TargetDisabled,
  UnexpectedStatus,
  InvalidBody,
  TimeoutError,
  HealthSchemaParseError,
  HealthBodyMismatch,
  type DomainError,
} from "../domain/errors.js";
import { classifyProbe } from "../domain/values.js";
import { ProbeClient, type RawProbeResponse } from "../services/ProbeClient.js";
const Ajv = AjvModule as unknown as new (opts?: object) => {
  compile(schema: object): (data: unknown) => boolean;
};

export const decodeHealthSchema = (encoded: string): Effect.Effect<object, HealthSchemaParseError> =>
  Effect.try({
    try: () => {
      const schema: unknown = JSON.parse(encoded);
      if (schema === null || typeof schema !== "object" || Array.isArray(schema))
        throw new Error("health schema must be an object");
      if ((schema as { $async?: unknown }).$async)
        throw new Error("$async schemas are not supported");
      return schema as object;
    },
    catch: (e) => new HealthSchemaParseError({ reason: `invalid health schema: ${String(e)}` }),
  });
const validateBody = (schema: object, body: unknown): Effect.Effect<boolean, HealthSchemaParseError> =>
  // A fresh compiler per call: Ajv memoizes compiled schemas by $id, so
  // reusing an identical schema must not collide (contract 3.2 rule 2).
  Effect.try({
    try: () => new Ajv({ strict: false }).compile(schema)(body),
    catch: (e) => new HealthSchemaParseError({ reason: `invalid health schema: ${String(e)}` }),
  });
const isTransient = (error: DomainError) =>
  error._tag === "DnsError" || error._tag === "TimeoutError";

// At most four attempts total, exponentially increasing delays starting at
// 10 ms with jitter, retried only for transient transport failures (SPEC 3.2).
const retryPolicy = Schedule.jittered(
  Schedule.exponential(10).pipe(Schedule.upTo({ times: 3 })),
);

export const probeOnce = (
  target: Target | TargetConfig,
): Effect.Effect<CheckResult, DomainError, ProbeClient> =>
  Effect.gen(function*() {
    if ("enabled" in target && !target.enabled)
      return yield* Effect.fail(new TargetDisabled({ targetId: target.id }));
    const start = yield* Clock.currentTimeMillis;
    // Each attempt is cut by the configured timeout; a hanging exchange
    // becomes a transient timeout failure the retry policy may recover.
    const client = yield* ProbeClient;
    const attempt = client.probe(target).pipe(
      Effect.timeoutOption(target.timeout),
      Effect.flatMap((o) =>
        Option.isNone(o)
          ? Effect.fail(new TimeoutError({ timeout: String(target.timeout) }))
          : Effect.succeed(o.value)
      ),
    );
    const outcome = yield* attempt.pipe(
      Effect.retry({ schedule: retryPolicy, while: isTransient }),
      Effect.match({
        onFailure: (e) => ({ tag: "failure" as const, error: e }),
        onSuccess: (v) => ({ tag: "success" as const, value: v }),
      }),
    );
    let raw: RawProbeResponse | undefined;
    let failure: DomainError | undefined;
    if (outcome.tag === "success") raw = outcome.value;
    else failure = outcome.error;
    const end = yield* Clock.currentTimeMillis,
      duration = Math.max(1, end - start);
    // Body-schema validation applies to non-HEAD probes only; HEAD bypasses
    // the validation entirely (contract 3.2 rule 2).
    if (raw && target.method !== "HEAD" && target.healthBodySchema !== undefined) {
      // Schema parse failures are recorded on the check (InvalidResponse with
      // HealthSchemaParseError), not propagated as probe failures.
      const response = raw;
      const healthOutcome = yield* Effect.result(
        Effect.flatMap(
          decodeHealthSchema(target.healthBodySchema),
          (schema) => validateBody(schema, response.body),
        ),
      );
      if (Result.isFailure(healthOutcome)) failure = healthOutcome.failure;
      else if (!healthOutcome.success)
        failure = new HealthBodyMismatch({ reason: "body did not match configured schema" });
    }
    // Without a health schema, every successfully decoded JSON value (including
    // strings) is ordinary data; malformed JSON already failed as InvalidBody
    // at the transport boundary.
    const unexpected = raw !== undefined && !target.expectedStatus.includes(raw.status);
    let classified: Result.Result<Classification, DomainError>;
    if (failure !== undefined && !unexpected) {
      classified = classifyProbe({ target, duration, failure });
    } else {
      classified = classifyProbe({ target, duration, ...(raw ? { status: raw.status } : {}) });
    }
    let recordedFailure = failure;
    if (Result.isFailure(classified)) {
      // Status is authoritative: an unexpected status overrides any earlier
      // body failure; otherwise a transport failure stays primary and a
      // classification failure is only used when no transport error exists.
      recordedFailure = unexpected || failure === undefined ? classified.failure : failure;
      classified = Result.succeed(
        classified.failure instanceof InvalidBody ? new InvalidResponse() : new Down(),
      );
    }
    const classification = Result.isSuccess(classified) ? classified.success : new Down();
    const metaStatus =
      raw !== undefined
        ? raw.status
        : recordedFailure instanceof UnexpectedStatus
          ? recordedFailure.actual
          : undefined;
    return new CheckResult({
      id: `check_${randomUUID()}` as CheckId,
      targetId: target.id,
      checkedAt: new Date(end),
      duration: Duration.millis(duration),
      classification,
      ...(recordedFailure
        ? { failure: Option.some(new CheckFailure({ reason: recordedFailure._tag })) }
        : { failure: Option.none() }),
      response: new ResponseMetadata({
        // Out-of-range transport values (for example 600) are deliberately
        // omitted from response metadata.
        status:
          metaStatus !== undefined && metaStatus >= 100 && metaStatus <= 599
            ? Option.some(metaStatus)
            : Option.none(),
        bytes:
          raw !== undefined && raw.bytes !== undefined
            ? Option.some(raw.bytes)
            : Option.none(),
      }),
    });
  }).pipe(Effect.withSpan("probe", { attributes: { target_id: target.id } }));
