import { Duration, Option } from "effect"
import { CheckFailure, CheckResult, Down, Incident, InvalidResponse, ResponseMetadata, Slow, Target, Unknown, Up, type Classification } from "./schema.js"

export const cloneDuration = Duration.match({
  onMillis: Duration.millis,
  onNanos: Duration.nanos,
  onInfinity: () => Duration.millis(Infinity),
  onNegativeInfinity: () => Duration.millis(-Infinity)
})

const cloneOption = <A, B>(option: Option.Option<A>, clone: (value: A) => B): Option.Option<B> =>
  Option.isNone(option) ? Option.none() : Option.some(clone(option.value))

const cloneClassification = (classification: Classification): Classification => {
  switch (classification._tag) {
    case "Up": return new Up()
    case "Slow": return new Slow()
    case "Down": return new Down()
    case "InvalidResponse": return new InvalidResponse()
    case "Unknown": return new Unknown()
  }
}

export const cloneCheck = (check: CheckResult): CheckResult => new CheckResult({
  ...check,
  checkedAt: new Date(check.checkedAt),
  duration: cloneDuration(check.duration),
  classification: cloneClassification(check.classification),
  ...(check.failure === undefined ? {} : { failure: new CheckFailure({ ...check.failure }) }),
  response: new ResponseMetadata({ ...check.response })
})

export const cloneIncident = (incident: Incident): Incident => new Incident({
  ...incident,
  openedAt: new Date(incident.openedAt),
  closedAt: cloneOption(incident.closedAt, (closedAt) => new Date(closedAt)),
  summary: cloneOption(incident.summary, (summary) => summary)
})

export const cloneTarget = (target: Target): Target => new Target({
  ...target,
  expectedStatus: [...target.expectedStatus],
  interval: cloneDuration(target.interval),
  timeout: cloneDuration(target.timeout),
  slowThreshold: cloneDuration(target.slowThreshold),
  ...(target.tags === undefined ? {} : { tags: [...target.tags] })
})
