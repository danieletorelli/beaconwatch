import { Equal, Option, Result } from "effect";
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
export const incidentCloseTime = (i: { closedAt: Option.Option<Date> }): Option.Option<Date> =>
  i.closedAt;
export const sameIncident = (a: object, b: object) => Equal.equals(a, b)
export const renameCheck = (check: { id: string }, id: string) => {
  check.id = id;
  return check;
};
export const formatIncidentWindow = (
  i: { openedAt: Date; closedAt: Option.Option<Date> },
  timeZone: string,
) =>
  `${i.openedAt.toLocaleString("sv-SE", { timeZone })} – ${Option.isSome(i.closedAt) ? i.closedAt.value.toLocaleString("sv-SE", { timeZone }) : "open"}`;
export type { Result } from "effect";
export const classifyProbe = (i: {
  target: TargetConfig;
  status?: number;
  duration: number;
  bodyValid?: boolean;
  failure?: DomainError;
}): Result.Result<Classification, DomainError> => {
  if (i.failure) {
    const d = classifyDomainError(i.failure);
    if (d === "operator-action") return Result.fail(i.failure);
    return Result.succeed(d === "ignore-disabled" ? new Unknown() : d === "invalid-response" ? new InvalidResponse() : new Down());
  }
  if (i.status === undefined)
    return Result.fail(
      new TimeoutError({ timeout: String(i.target.timeout) }),
    );
  if (!i.target.expectedStatus.includes(i.status))
    return Result.fail(
      new UnexpectedStatus({
        expected: i.target.expectedStatus,
        actual: i.status,
      }),
    );
  if (i.bodyValid === false)
    return Result.fail(
      new InvalidBody({
        reason: "body did not match configured schema",
      }),
    );
  return Result.succeed(
    i.duration > i.target.slowThreshold ? new Slow() : new Up(),
  );
};
