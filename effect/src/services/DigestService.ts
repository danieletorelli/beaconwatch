import { Data, Duration, Effect, Equal, FileSystem, Schema, SchemaGetter, Sink, Stream } from "effect"
import { Buffer } from "node:buffer"
import { HistoryReadError } from "../domain/errors.js"
import { AcceptedDate, CheckId, CheckResult, Classification, Incident, ResponseMetadata, TargetId, WellFormedString } from "../domain/schema.js"

const DurationMillis = Schema.Finite.check(
  Schema.makeFilter((millis) => millis > 0 && Number.isSafeInteger(millis * 1_000_000)
    ? undefined
    : "duration must be positive and exactly representable as a safe integer number of nanoseconds")
).pipe(Schema.decodeTo(Schema.Duration, {
  decode: SchemaGetter.transform((n) => Duration.nanos(BigInt(n * 1_000_000))),
  encode: SchemaGetter.transform((d) => Duration.toMillis(d))
}))

const rfc3339Instant = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/
const Rfc3339Instant = Schema.String.check(Schema.makeFilter((text) => {
  const match = rfc3339Instant.exec(text)
  if (!match) return "expected a strict RFC3339 instant"
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3])
  if (year < 1 || year > 9999) return "year must be between 0001 and 9999"
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return "expected a valid calendar instant"
  return Number.isNaN(Date.parse(text)) ? "expected a valid calendar instant" : undefined
})).pipe(Schema.decodeTo(AcceptedDate, {
  decode: SchemaGetter.transform((text) => new Date(text)),
  encode: SchemaGetter.transform((date) => date.toISOString())
}))

export class CheckHistoryRow extends Schema.Class<CheckHistoryRow>("CheckHistoryRow")({
  id: CheckId,
  targetId: TargetId,
  checkedAt: Rfc3339Instant,
  durationMillis: DurationMillis,
  classification: Classification,
  failure: Schema.optionalKey(Schema.Struct({ reason: WellFormedString })),
  response: ResponseMetadata
}) {}

export class MalformedHistoryRow extends Data.TaggedError("MalformedHistoryRow")<{ readonly line: number; readonly reason: string }> {}

export interface TargetDigest { readonly targetId: TargetId; readonly currentStatus: string; readonly p95LatencyMillis: number; readonly uptimePercent: number; readonly checks: number }
export interface Digest { readonly targets: ReadonlyArray<TargetDigest>; readonly incidents: ReadonlyArray<Incident>; readonly malformedRows: number; readonly processedRows: number }

type State = { readonly byTarget: Map<TargetId, CheckResult[]>; readonly checksById: Map<string, CheckResult>; readonly conflictingIds: Set<string>; readonly malformedRows: number; readonly processedRows: number }
const initial = (): State => ({ byTarget: new Map(), checksById: new Map(), conflictingIds: new Set(), malformedRows: 0, processedRows: 0 })

const toCheck = (row: CheckHistoryRow) => Schema.decodeUnknownEffect(CheckResult)({
  id: row.id, targetId: row.targetId, checkedAt: row.checkedAt, duration: row.durationMillis, classification: row.classification,
  ...(row.failure ? { failure: { _tag: "CheckFailure", reason: row.failure.reason } } : {}),
  response: {
    ...(row.response.status === undefined ? {} : { status: row.response.status }),
    ...(row.response.bytes === undefined ? {} : { bytes: row.response.bytes })
  }
})

export const decodeHistoryLine = (line: string, lineNo: number) => Effect.gen(function*() {
  const parsed = yield* Effect.try({ try: () => JSON.parse(line) as unknown, catch: (e) => new MalformedHistoryRow({ line: lineNo, reason: String(e) }) })
  return yield* Schema.decodeUnknownEffect(CheckHistoryRow)(parsed).pipe(Effect.mapError((e) => new MalformedHistoryRow({ line: lineNo, reason: String(e) })))
})

const addCheck = (state: State, check: CheckResult): State => {
  const processedRows = state.processedRows + 1
  if (state.conflictingIds.has(check.id)) return { ...state, processedRows }
  const existing = state.checksById.get(check.id)
  if (existing && Equal.equals(existing, check)) return { ...state, processedRows }
  if (existing) {
    const byTarget = new Map(state.byTarget)
    const retained = (byTarget.get(existing.targetId) ?? []).filter((candidate) => candidate.id !== check.id)
    if (retained.length === 0) byTarget.delete(existing.targetId)
    else byTarget.set(existing.targetId, retained)
    const conflictingIds = new Set(state.conflictingIds)
    conflictingIds.add(check.id)
    return { ...state, byTarget, conflictingIds, malformedRows: state.malformedRows + 1, processedRows }
  }
  const byTarget = new Map(state.byTarget)
  byTarget.set(check.targetId, [...(byTarget.get(check.targetId) ?? []), check])
  const checksById = new Map(state.checksById)
  checksById.set(check.id, check)
  return { ...state, byTarget, checksById, processedRows }
}

export const digestSink = Sink.fold<State, CheckResult | MalformedHistoryRow>(initial, () => true, (state, row) =>
  Effect.succeed(row instanceof MalformedHistoryRow ? { ...state, malformedRows: state.malformedRows + 1 } : addCheck(state, row))
)

const percentile95 = (xs: ReadonlyArray<number>) => {
  if (xs.length === 0) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0
}

const orderText = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b))

const finalize = (state: State): Digest => ({
  malformedRows: state.malformedRows,
  processedRows: state.processedRows,
  incidents: [],
  targets: [...state.byTarget.entries()].map(([targetId, checks]) => {
    const ordered = [...checks].sort((a, b) => a.checkedAt.getTime() - b.checkedAt.getTime() || orderText(a.id, b.id))
    const latest = ordered[ordered.length - 1]!
    const up = ordered.filter((c) => c.classification._tag === "Up").length
    return { targetId, currentStatus: latest.classification._tag, p95LatencyMillis: percentile95(ordered.map((c) => Duration.toMillis(c.duration))), uptimePercent: (up / ordered.length) * 100, checks: ordered.length }
  }).sort((a, b) => orderText(a.targetId, b.targetId))
})

export const digestFromStream = <E, R>(stream: Stream.Stream<CheckResult | MalformedHistoryRow, E, R>) => Stream.run(stream, digestSink).pipe(Effect.map(finalize))

export const historyRows = (path: string) => Stream.unwrap(Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  return Stream.suspend(() => {
    const decoder = new TextDecoder("utf-8", { fatal: true })
    return fs.stream(path).pipe(
      Stream.map((chunk) => ({ chunk, final: false })),
      Stream.concat(Stream.succeed({ chunk: new Uint8Array(), final: true })),
      Stream.mapEffect(({ chunk, final }) => Effect.try({
        try: () => decoder.decode(chunk, { stream: !final }),
        catch: (cause) => new HistoryReadError({ path, cause })
      })),
      Stream.splitLines,
      Stream.filter((line) => line.trim().length > 0),
      Stream.zipWithIndex,
      Stream.map(([line, index]) => ({ line, lineNo: index + 1 })),
      Stream.mapError((cause) => cause instanceof HistoryReadError ? cause : new HistoryReadError({ path, cause }))
    )
  })
}))

export const importHistoryWith = Effect.fn("importHistoryWith")(function*(path: string) {
  const stream = historyRows(path).pipe(
    Stream.mapEffect(({ line, lineNo }) => decodeHistoryLine(line, lineNo).pipe(
      Effect.flatMap(toCheck),
      Effect.match({ onFailure: (e) => e instanceof MalformedHistoryRow ? e : new MalformedHistoryRow({ line: lineNo, reason: String(e) }), onSuccess: (check) => check })
    ), { concurrency: 8 })
  )
  return yield* digestFromStream(stream)
})

/** The application boundary supplies FileSystem once for the entire CLI program. */
export const importHistory = importHistoryWith
