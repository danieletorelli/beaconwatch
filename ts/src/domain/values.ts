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
export const renameCheck = (check: { id: string }, id: string) => ({
  ...check, id,
});
// ISO timestamp with a numeric offset in the requested named time zone. An
// invalid time-zone request throws (RangeError) instead of falling back.
const isoInZone = (d: Date, timeZone: string) => {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const p = (type: string) =>
    fmt.formatToParts(d).find((x) => x.type === type)?.value ?? "00";
  const zoneAsUTC = Date.UTC(
    Number(p("year")),
    Number(p("month")) - 1,
    Number(p("day")),
    Number(p("hour")),
    Number(p("minute")),
    Number(p("second")),
  );
  const offsetMinutes = Math.round((zoneAsUTC - d.getTime()) / 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  return `${p("year")}-${p("month")}-${p("day")}T${p("hour")}:${p("minute")}:${p("second")}${offset}`;
};
export const formatIncidentWindow = (
  i: { openedAt: Date; closedAt: Option.Option<Date> },
  timeZone: string,
) =>
  `${isoInZone(i.openedAt, timeZone)} – ${Option.isSome(i.closedAt) ? isoInZone(i.closedAt.value, timeZone) : "open"}`;
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
