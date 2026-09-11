import AjvModule from "ajv";
import { Clock, Effect, Option, Result, Schedule } from "effect";
import { randomUUID } from "node:crypto";
import {
  CheckFailure,
  CheckResult,
  Down,
  InvalidResponse,
  ResponseMetadata,
  type Target,
  type TargetConfig,
} from "../domain/schema.js";
import {
  TargetDisabled,
  UnexpectedStatus,
  InvalidBody,
  type DomainError,
} from "../domain/errors.js";
import { classifyProbe } from "../domain/values.js";
import type { ProbeClientShape, RawProbeResponse } from "../services/ProbeClient.js";
const Ajv = AjvModule as unknown as new () => {
  validate(schema: object, value: unknown): boolean;
};
const ajv = new Ajv();
export const decodeHealthSchema = (encoded: string): Effect.Effect<object, InvalidBody> =>
  Effect.try({
    try: () => {
      const schema: unknown = JSON.parse(encoded);
      if (schema === null || typeof schema !== "object" || Array.isArray(schema))
        throw new Error("health schema must be an object");
      return schema;
    },
    catch: (e) => new InvalidBody({ reason: `invalid health schema: ${String(e)}` }),
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
    let bodyValid = true;
    if (raw) {
      if (target.healthBodySchema !== undefined) {
        const healthSchema = yield* decodeHealthSchema(target.healthBodySchema);
        bodyValid = Boolean(ajv.validate(healthSchema, raw.body));
      } else bodyValid = raw.body !== "not-json";
    }
    let classified = classifyProbe({
      target,
      duration,
      bodyValid,
      ...(raw ? { status: raw.status } : {}),
      ...(failure ? { failure } : {}),
    });
    if (Result.isFailure(classified)) {
      failure = classified.failure;
      classified = Result.succeed(
        classified.failure instanceof InvalidBody
          ? new InvalidResponse()
          : new Down(),
      );
    }
    const classification = Result.isSuccess(classified) ? classified.success : new Down();
    if (raw && !target.expectedStatus.includes(raw.status))
      failure = new UnexpectedStatus({
        expected: target.expectedStatus,
        actual: raw.status,
      });
    return new CheckResult({
      id: `check_${randomUUID()}`,
      targetId: target.id,
      checkedAt: new Date(end),
      duration,
      classification,
      ...(failure ? { failure: new CheckFailure({ reason: failure._tag }) } : {}),
      response: new ResponseMetadata({
        ...(raw !== undefined
          ? { status: raw.status }
          : failure instanceof UnexpectedStatus
            ? { status: failure.actual }
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
    Effect.retry({ schedule: Schedule.exponential(10).pipe(Schedule.upTo({ times: 3 })), while: isTransient }),
  );
