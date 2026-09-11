import { Data, Duration, Effect, Option, Schema, Sink, Stream } from "effect";
import * as FileSystem from "effect/FileSystem";
import { HistoryReadError } from "../domain/errors.js";
import {
  CheckFailure,
  CheckId,
  CheckResult,
  Down,
  InvalidResponse,
  ResponseMetadata,
  Slow,
  Unknown,
  Up,
  targetId,
  type TargetId,
} from "../domain/schema.js";

export class MalformedHistoryRow extends Data.TaggedError("MalformedHistoryRow")<{
  readonly line: number;
  readonly reason: string;
}> {}

export interface TargetDigest {
  targetId: TargetId;
  currentStatus: string;
  p95LatencyMillis: number;
  uptimePercent: number;
  checks: number;
}

export interface Digest {
  targets: readonly TargetDigest[];
  incidents: readonly [];
  malformedRows: number;
  processedRows: number;
}

const classes = { Up, Slow, Down, InvalidResponse, Unknown };

// SPEC 7.1: finite, strictly positive, and exactly representable as a safe
// integer number of nanoseconds.
const DurationMillis = Schema.Number.pipe(
  Schema.check(
    Schema.makeFilter((millis: number) =>
      Number.isFinite(millis) && millis > 0 && Number.isSafeInteger(millis * 1_000_000)
        ? undefined
        : "durationMillis must be positive with a safe-integer nanosecond value"
    ),
  ),
);

const HistoryRowSchema = Schema.Struct({
  id: Schema.String,
  checkedAt: Schema.String,
  classification: Schema.Struct({ _tag: Schema.Literals(["Up", "Slow", "Down", "InvalidResponse", "Unknown"]) }),
  durationMillis: DurationMillis,
  targetId: Schema.String,
  failure: Schema.optionalKey(Schema.Struct({ reason: Schema.String })),
  response: Schema.Struct({
    status: Schema.optionalKey(Schema.Number),
    bytes: Schema.optionalKey(Schema.Number),
  }),
});

type HistoryRow = typeof HistoryRowSchema.Type;

const toCheck = (x: HistoryRow) =>
  new CheckResult({
    id: x.id as CheckId,
    targetId: targetId(x.targetId),
    checkedAt: new Date(x.checkedAt),
    duration: Duration.millis(x.durationMillis),
    classification: new classes[
      x.classification._tag as keyof typeof classes
    ](),
    ...(x.failure
      ? { failure: Option.some(new CheckFailure({ reason: x.failure.reason })) }
      : { failure: Option.none() }),
    response: new ResponseMetadata({
      status: x.response.status === undefined ? Option.none() : Option.some(x.response.status),
      bytes: x.response.bytes === undefined ? Option.none() : Option.some(x.response.bytes),
    }),
  });

type State = {
  readonly byTarget: Map<TargetId, CheckResult[]>;
  readonly checksById: Map<string, CheckResult>;
  readonly conflictingIds: Set<string>;
  readonly malformedRows: number;
  readonly processedRows: number;
};
const initial = (): State => ({
  byTarget: new Map(),
  checksById: new Map(),
  conflictingIds: new Set(),
  malformedRows: 0,
  processedRows: 0,
});

const addCheck = (state: State, check: CheckResult): State => {
  const processedRows = state.processedRows + 1;
  if (state.conflictingIds.has(check.id)) return { ...state, processedRows };
  const existing = state.checksById.get(check.id);
  if (existing && JSON.stringify(existing) === JSON.stringify(check))
    return { ...state, processedRows };
  if (existing) {
    // Conflicting duplicate: the id is excluded entirely and one malformed
    // row is counted (SPEC 7.2).
    const byTarget = new Map(state.byTarget);
    const retained = (byTarget.get(existing.targetId) ?? []).filter(
      (candidate) => candidate.id !== check.id,
    );
    if (retained.length === 0) byTarget.delete(existing.targetId);
    else byTarget.set(existing.targetId, retained);
    const conflictingIds = new Set(state.conflictingIds);
    conflictingIds.add(check.id);
    return {
      ...state,
      byTarget,
      conflictingIds,
      malformedRows: state.malformedRows + 1,
      processedRows,
    };
  }
  const byTarget = new Map(state.byTarget);
  byTarget.set(check.targetId, [...(byTarget.get(check.targetId) ?? []), check]);
  const checksById = new Map(state.checksById);
  checksById.set(check.id, check);
  return { ...state, byTarget, checksById, processedRows };
};

export const digestSink = Sink.fold<State, CheckResult | MalformedHistoryRow>(
  initial,
  () => true,
  (state, row) =>
    Effect.succeed(
      row instanceof MalformedHistoryRow
        ? { ...state, malformedRows: state.malformedRows + 1 }
        : addCheck(state, row),
    ),
);

const percentile95 = (xs: ReadonlyArray<number>) => {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
};
const orderText = (a: string, b: string) =>
  Buffer.compare(Buffer.from(a), Buffer.from(b));

const finalize = (state: State): Digest => ({
  malformedRows: state.malformedRows,
  processedRows: state.processedRows,
  incidents: [],
  targets: [...state.byTarget.entries()]
    .map(([targetId, checks]) => {
      const ordered = [...checks].sort(
        (a, b) =>
          a.checkedAt.getTime() - b.checkedAt.getTime() ||
          orderText(a.id, b.id),
      );
      const latest = ordered[ordered.length - 1]!;
      const up = ordered.filter((c) => c.classification._tag === "Up").length;
      return {
        targetId,
        currentStatus: latest.classification._tag,
        p95LatencyMillis: percentile95(
          ordered.map((c) => Duration.toMillis(c.duration)),
        ),
        uptimePercent: (up / ordered.length) * 100,
        checks: ordered.length,
      };
    })
    .sort((a, b) => orderText(a.targetId, b.targetId)),
});

export const digestFromStreamEffect = <E, R = never>(
  stream: Stream.Stream<CheckResult | MalformedHistoryRow, E, R>,
): Effect.Effect<Digest, E, R> =>
  Stream.run(stream, digestSink).pipe(Effect.map(finalize));
export const digestFromRows = (rows: Array<CheckResult | MalformedHistoryRow>) =>
  digestFromStreamEffect(Stream.fromIterable(rows));

export const decodeHistoryLineEffect = (
  line: string,
  lineNo: number,
): Effect.Effect<CheckResult, MalformedHistoryRow> =>
  Effect.try({
    try: () => JSON.parse(line),
    catch: (e) => new MalformedHistoryRow({ line: lineNo, reason: String(e) }),
  }).pipe(
    Effect.flatMap((parsed) =>
      Schema.decodeUnknownEffect(HistoryRowSchema)(parsed).pipe(
        Effect.mapError(() => new MalformedHistoryRow({ line: lineNo, reason: "schema validation failed" })),
      )
    ),
    // Every row-conversion failure becomes a structured MalformedHistoryRow
    // carrying the filtered line number (17.9).
    Effect.flatMap((row) =>
      Effect.try({
        try: () => toCheck(row),
        catch: (e) => new MalformedHistoryRow({ line: lineNo, reason: String(e) }),
      }),
    ),
  );

// Incremental UTF-8 line source through the replaceable FileSystem
// capability, with fatal decoding: malformed byte sequences fail as
// HistoryReadError instead of being replacement-decoded (17.6), and consumers
// taking a finite prefix never read the remainder (17.5).
export const historyLines = (
  path: string,
): Stream.Stream<{ line: string; lineNo: number }, HistoryReadError, FileSystem.FileSystem> =>
  Stream.unwrap(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return fs.stream(path).pipe(
      Stream.map((chunk) => ({ chunk, final: false })),
      Stream.concat(Stream.succeed({ chunk: new Uint8Array(), final: true })),
      Stream.mapEffect(
        ({ chunk, final }) =>
          Effect.try({
            try: () => decoder.decode(chunk, { stream: !final }),
            catch: (cause) => new HistoryReadError({ path, cause }),
          }),
      ),
      Stream.splitLines,
      Stream.filter((line) => line.trim().length > 0),
      Stream.zipWithIndex,
      Stream.map(([line, index]) => ({ line, lineNo: index + 1 })),
      Stream.mapError((cause) =>
        cause instanceof HistoryReadError ? cause : new HistoryReadError({ path, cause }),
      ),
    );
  }));

export const importHistoryEffect = (
  path: string,
): Effect.Effect<Digest, HistoryReadError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const rows = yield* historyLines(path).pipe(
      // Decoding may happen concurrently, bounded (SPEC 7.1).
      Stream.mapEffect(
        ({ line, lineNo }: { line: string; lineNo: number }) =>
          decodeHistoryLineEffect(line, lineNo).pipe(
            Effect.match({
              onFailure: (e) => e as CheckResult | MalformedHistoryRow,
              onSuccess: (check) => check as CheckResult | MalformedHistoryRow,
            }),
          ),
        { concurrency: 8 },
      ),
      Stream.runCollect,
    );
    return yield* digestFromStreamEffect(Stream.fromIterable(Array.from(rows)));
  }).pipe(Effect.withSpan("digest"));
