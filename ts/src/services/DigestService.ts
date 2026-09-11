import { Data, Effect, Schema, Stream } from "effect";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { HistoryReadError } from "../domain/errors.js";
import {
  CheckFailure,
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

const HistoryRowSchema = Schema.Struct({
  id: Schema.String,
  checkedAt: Schema.String,
  classification: Schema.Struct({ _tag: Schema.Literals(["Up", "Slow", "Down", "InvalidResponse", "Unknown"]) }),
  durationMillis: Schema.Number,
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
    id: x.id,
    targetId: targetId(x.targetId),
    checkedAt: new Date(x.checkedAt),
    duration: x.durationMillis,
    classification: new classes[
      x.classification._tag as keyof typeof classes
    ](),
    ...(x.failure ? { failure: new CheckFailure(x.failure) } : {}),
    response: new ResponseMetadata(x.response),
  });

export const digestFromStreamEffect = (
  rows: Iterable<CheckResult | MalformedHistoryRow>,
): Effect.Effect<Digest> =>
  Effect.sync(() => {
    const byId = new Map<string, CheckResult>();
    const conflicts = new Set<string>();
    let malformedRows = 0,
      processedRows = 0;
    for (const row of rows) {
      if (row instanceof MalformedHistoryRow) {
        malformedRows++;
        continue;
      }
      processedRows++;
      if (conflicts.has(row.id)) continue;
      const old = byId.get(row.id);
      if (old && JSON.stringify(old) !== JSON.stringify(row)) {
        byId.delete(row.id);
        conflicts.add(row.id);
        malformedRows++;
      } else if (!old) byId.set(row.id, row);
    }
    const grouped = new Map<TargetId, CheckResult[]>();
    for (const c of byId.values())
      grouped.set(c.targetId, [...(grouped.get(c.targetId) ?? []), c]);
    const targets = [...grouped]
      .map(([id, checks]) => {
        checks.sort(
          (a, b) =>
            a.checkedAt.getTime() - b.checkedAt.getTime() ||
            Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)),
        );
        const lat = checks.map((x) => x.duration).sort((a, b) => a - b);
        return {
          targetId: id,
          currentStatus: checks.at(-1)!.classification._tag,
          p95LatencyMillis: lat[Math.ceil(lat.length * 0.95) - 1] ?? 0,
          uptimePercent:
            (checks.filter((x) => x.classification._tag === "Up").length /
              checks.length) *
            100,
          checks: checks.length,
        };
      })
      .sort((a, b) =>
        Buffer.compare(Buffer.from(a.targetId), Buffer.from(b.targetId)),
      );
    return { targets, incidents: [], malformedRows, processedRows };
  });

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

// Incremental UTF-8 line source with fatal decoding: malformed byte sequences
// fail as HistoryReadError instead of being replacement-decoded (17.6), and
// consumers taking a finite prefix never read the remainder (17.5).
const historyLines = (path: string): Stream.Stream<string, HistoryReadError> =>
  Stream.fromAsyncIterable(
    (async function* () {
      const decoded = Readable.toWeb(createReadStream(path)).pipeThrough(
        new TextDecoderStream("utf-8", { fatal: true }),
      );
      for await (const chunk of decoded as AsyncIterable<string>) yield chunk;
      yield "\n"; // flush a final line without trailing newline
    })(),
    (e) => new HistoryReadError({ path, cause: e }),
  ).pipe(
    // mapAccum spreads the returned line array as individual elements
    Stream.mapAccum(() => "", (pending: string, chunk: string) => {
      const parts = (pending + chunk).split(/\r?\n/);
      return [parts.pop() ?? "", parts] as const;
    }),
  );

export const importHistoryEffect = (path: string): Effect.Effect<Digest, HistoryReadError> =>
  historyLines(path).pipe(
    Stream.mapAccumEffect<number, string, CheckResult | MalformedHistoryRow, never, never>(
      () => 0,
      (i, line) =>
        line.trim() === ""
          ? Effect.succeed([i, []] as const) // blank lines are ignored and unnumbered
          : decodeHistoryLineEffect(line, i + 1).pipe(
              Effect.match({
                onSuccess: (row) => [i + 1, [row]] as const,
                onFailure: (e) => [i + 1, [e] as ReadonlyArray<MalformedHistoryRow>] as const,
              })
            ),
    ),
    Stream.runCollect,
    Effect.flatMap((chunk) => digestFromStreamEffect(Array.from(chunk))),
  );
