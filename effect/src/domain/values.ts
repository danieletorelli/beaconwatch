import { Data, DateTime, Duration, Option, Result } from "effect"
import { HealthBodyMismatch, TimeoutError, UnexpectedStatus, type DomainError } from "./errors.js"
import { Down, InvalidResponse, Slow, Up, Unknown, type Classification, type TargetConfig, type TargetId } from "./schema.js"
import { classifyDomainError } from "./classify-match.js"

export class ImmutableCheckResult extends Data.Class<{
  readonly id: string
  readonly targetId: TargetId
  readonly duration: Duration.Duration
  readonly classification: Classification
}> {}

export const makeCheckResult = (input: {
  readonly id: string
  readonly targetId: TargetId
  readonly duration: Duration.Duration
  readonly classification: Classification
}) => new ImmutableCheckResult(input)

export const incidentCloseTime = (incident: { readonly closedAt: Option.Option<Date> }) => incident.closedAt

export const formatIncidentWindow = (incident: { readonly openedAt: Date; readonly closedAt: Option.Option<Date> }, timeZone: string) => {
  const format = (date: Date) => DateTime.formatIsoOffset(DateTime.makeZonedUnsafe(date, { timeZone }))
  return `${format(incident.openedAt)} – ${Option.match(incident.closedAt, { onNone: () => "open", onSome: format })}`
}

export const classifyProbe = (input: {
  readonly target: TargetConfig
  readonly status?: number
  readonly duration: Duration.Duration
  readonly bodyValid?: boolean
  readonly failure?: DomainError
}): Result.Result<Classification, DomainError> => {
  if (input.failure) {
    const disposition = classifyDomainError(input.failure)
    if (disposition === "ignore-disabled") return Result.succeed(new Unknown())
    if (disposition === "invalid-response") return Result.succeed(new InvalidResponse())
    return Result.succeed(new Down())
  }
  if (input.status === undefined) return Result.fail(new TimeoutError({ timeout: Duration.format(input.target.timeout) }))
  if (!input.target.expectedStatus.includes(input.status)) {
    return Result.fail(new UnexpectedStatus({ expected: input.target.expectedStatus, actual: input.status }))
  }
  if (input.bodyValid === false) return Result.fail(new HealthBodyMismatch())
  if (Duration.isGreaterThan(input.duration, input.target.slowThreshold)) return Result.succeed(new Slow())
  return Result.succeed(new Up())
}
