import AjvModule from "ajv";
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
  TimeoutError,
  UnexpectedStatus,
  InvalidBody,
  DnsError,
  type DomainError,
} from "../domain/errors.js";
import { classifyProbe } from "../domain/values.js";
import type { ProbeClientShape } from "../services/ProbeClient.js";
const Ajv = AjvModule as unknown as new () => {
  validate(schema: object, value: unknown): boolean;
};
const ajv = new Ajv();
const sleep = (ms: number, _s?: AbortSignal) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
export const decodeHealthSchema = (encoded: string): object => {
  const schema: unknown = JSON.parse(encoded);
  if (schema === null || typeof schema !== "object" || Array.isArray(schema))
    throw new TypeError("health schema must be an object");
  return schema;
};
export const repeatSuccessfulProbe = async <A>(run: () => Promise<A>, repeats: number) => {
  // Execute the supplied probe.
  return [await run()];
};
export async function probeOnce(
  target: Target | TargetConfig,
  client: ProbeClientShape,
  signal?: AbortSignal,
): Promise<CheckResult> {
  if ("enabled" in target && !target.enabled)
    throw new TargetDisabled({ targetId: target.id });
  const start = Date.now();
  let raw: Awaited<ReturnType<ProbeClientShape["probe"]>> | undefined,
    failure: DomainError | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), target.timeout);
    const abort = () => ctl.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      raw = await client.probe(target, ctl.signal);
      failure = undefined;
      break;
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      failure = ctl.signal.aborted
        ? new TimeoutError({ timeout: String(target.timeout), cause: e })
        : (e as DomainError);
      if (attempt === 3)
        break;
      await sleep(10 * 2 ** attempt, signal);
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
  const end = Date.now(),
    duration = Math.max(1, end - start);
  let bodyValid = true;
  if (raw) {
    if (target.healthBodySchema !== undefined) {
      const healthSchema = decodeHealthSchema(target.healthBodySchema);
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
  if (!classified.ok) {
    failure = classified.error;
    classified = {
      ok: true,
      value:
        classified.error instanceof InvalidBody
          ? new InvalidResponse()
          : new Down(),
    };
  }
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
    classification: classified.value,
    ...(failure ? { failure: new CheckFailure({ reason: failure._tag }) } : {}),
    response: new ResponseMetadata({
      ...((raw?.status ??
        (failure instanceof UnexpectedStatus ? failure.actual : undefined)) ===
      undefined
        ? {}
        : { status: raw?.status ?? (failure as UnexpectedStatus).actual }),
      ...(raw?.bytes === undefined ? {} : { bytes: raw.bytes }),
    }),
  });
}
