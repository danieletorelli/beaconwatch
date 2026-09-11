import AjvModule from "ajv";
import { Clock, Effect, Result, Schedule } from "effect";
import { randomUUID } from "node:crypto";
import {
  CheckFailure,
  CheckResult,
  Down,
  InvalidResponse,
  ResponseMetadata,
  type Classification,
  type Target,
  type TargetConfig,
} from "../domain/schema.js";
import {
  TargetDisabled,
  UnexpectedStatus,
  InvalidBody,
  HealthSchemaParseError,
  HealthBodyMismatch,
  type DomainError,
} from "../domain/errors.js";
import { classifyProbe } from "../domain/values.js";
import type { ProbeClientShape, RawProbeResponse } from "../services/ProbeClient.js";
const Ajv = AjvModule as unknown as new (opts?: object) => {
  compile(schema: object): (data: unknown) => boolean;
};
const ajv = new Ajv({ strict: false });
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
  Effect.try({
    try: () => ajv.compile(schema)(body),
    catch: (e) => new HealthSchemaParseError({ reason: `invalid health schema: ${String(e)}` }),
  });
export const repeatSuccessfulProbe = <A>(run: Effect.Effect<A>, repeats: number): Effect.Effect<A[]> =>
  Effect.forEach(Array.from({ length: repeats }), () => run);
export const probeOnce = (
  target: Target | TargetConfig,
  client: ProbeClientShape,
): Effect.Effect<CheckResult, DomainError> =>
  Effect.gen(function*() {
    if ("enabled" in target && !target.enabled)
      return yield* Effect.fail(new TargetDisabled({ targetId: target.id }));
    const start = yield* Clock.currentTimeMillis;
    let raw: RawProbeResponse | undefined;
    let failure: DomainError | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      const result = yield* client.probe(target).pipe(
        Effect.match({
          onFailure: (e) => ({ tag: "failure" as const, error: e as DomainError }),
          onSuccess: (v) => ({ tag: "success" as const, value: v }),
        }),
      );
      if (result.tag === "success") {
        raw = result.value;
        failure = undefined;
        break;
      }
      failure = result.error;
      if (attempt === 3) break;
      yield* Effect.sleep(10 * 2 ** attempt);
    }
    const end = yield* Clock.currentTimeMillis,
      duration = Math.max(1, end - start);
    if (raw && target.healthBodySchema !== undefined) {
      const healthSchema = yield* decodeHealthSchema(target.healthBodySchema);
      if (!(yield* validateBody(healthSchema, raw.body)))
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
      id: `check_${randomUUID()}`,
      targetId: target.id,
      checkedAt: new Date(end),
      duration,
      classification,
      ...(recordedFailure ? { failure: new CheckFailure({ reason: recordedFailure._tag }) } : {}),
      response: new ResponseMetadata({
        // Out-of-range transport values (for example 600) are deliberately
        // omitted from response metadata.
        ...(metaStatus !== undefined && metaStatus >= 100 && metaStatus <= 599
          ? { status: metaStatus }
          : {}),
        ...(raw !== undefined && raw.bytes !== undefined ? { bytes: raw.bytes } : {}),
      }),
    });
  });

const isTransient = (error: DomainError) =>
  error._tag === "DnsError" || error._tag === "TimeoutError";

export const probeOnceWithRetry = (
  target: Target | TargetConfig,
  client: ProbeClientShape,
): Effect.Effect<CheckResult, DomainError> =>
  probeOnce(target, client).pipe(
    Effect.retry({ schedule: Schedule.jittered(Schedule.exponential(10).pipe(Schedule.upTo({ times: 3 }))), while: isTransient }),
  );
