import { randomUUID } from "node:crypto";
import {
  CheckFailure,
  CheckResult,
  Down,
  ResponseMetadata,
  type Target,
  type TargetConfig,
} from "../domain/schema.js";
import { DnsError, TimeoutError } from "../domain/errors.js";
export const degradedCheckResult = (
  t: Target | TargetConfig,
  e: DnsError | TimeoutError,
  checkedAt = new Date(0),
) =>
  new CheckResult({
    id: `degraded_${randomUUID()}`,
    targetId: t.id,
    checkedAt,
    duration: t.timeout,
    classification: new Down(),
    failure: new CheckFailure({ reason: e._tag }),
    response: new ResponseMetadata({}),
  });
export const recoverTransientProbe = async <A>(
  effect: Promise<A>,
  fallback: (e: DnsError | TimeoutError) => A,
) => {
  try {
    return await effect;
  } catch (e) {
    return fallback(e as DnsError | TimeoutError);
  }
};
