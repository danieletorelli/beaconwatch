import {
  InvalidBody,
  TimeoutError,
  UnexpectedStatus,
  type DomainError,
} from "./errors.js";
import {
  Down,
  InvalidResponse,
  Slow,
  Unknown,
  Up,
  type Classification,
  type TargetConfig,
  type TargetId,
} from "./schema.js";
import { classifyDomainError } from "./classify-match.js";
export class ImmutableCheckResult {
  constructor(
    readonly id: string,
    readonly targetId: TargetId,
    readonly duration: number,
    readonly classification: Classification,
  ) {
  }
}
export const makeCheckResult = (x: {
  id: string;
  targetId: TargetId;
  duration: number;
  classification: Classification;
}) => new ImmutableCheckResult(x.id, x.targetId, x.duration, x.classification);
export const incidentCloseTime = (i: { closedAt?: Date }) => i.closedAt;
export const sameIncident = (a: object, b: object) => a === b;
export const renameCheck = (check: { id: string }, id: string) => {
  check.id = id;
  return check;
};
export const formatIncidentWindow = (
  i: { openedAt: Date; closedAt?: Date },
  timeZone: string,
) =>
  `${i.openedAt.toLocaleString("sv-SE", { timeZone })} – ${i.closedAt ? i.closedAt.toLocaleString("sv-SE", { timeZone }) : "open"}`;
export type Result<A, E> = { ok: true; value: A } | { ok: false; error: E };
export const classifyProbe = (i: {
  target: TargetConfig;
  status?: number;
  duration: number;
  bodyValid?: boolean;
  failure?: DomainError;
}): Result<Classification, DomainError> => {
  if (i.failure) {
    const d = classifyDomainError(i.failure);
    if (d === "operator-action") throw i.failure;
    return { ok: true, value: d === "ignore-disabled" ? new Unknown() : d === "invalid-response" ? new InvalidResponse() : new Down() };
  }
  if (i.status === undefined)
    return {
      ok: false,
      error: new TimeoutError({ timeout: String(i.target.timeout) }),
    };
  if (!i.target.expectedStatus.includes(i.status))
    return {
      ok: false,
      error: new UnexpectedStatus({
        expected: i.target.expectedStatus,
        actual: i.status,
      }),
    };
  if (i.bodyValid === false)
    return {
      ok: false,
      error: new InvalidBody({
        reason: "body did not match configured schema",
      }),
    };
  return {
    ok: true,
    value: i.duration > i.target.slowThreshold ? new Slow() : new Up(),
  };
};
