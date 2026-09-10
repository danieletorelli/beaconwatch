import { Data, Effect, Schema, Stream } from "effect";
import { readFile } from "node:fs/promises";
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
  targetId: Schema.optionalKey(Schema.String),
  failure: Schema.optionalKey(Schema.Struct({ reason: Schema.String })),
  response: Schema.optionalKey(Schema.Struct({
    status: Schema.optionalKey(Schema.Number),
    bytes: Schema.optionalKey(Schema.Number),
  })),
});

type HistoryRow = typeof HistoryRowSchema.Type;

const toCheck = (x: any) =>
  new CheckResult({
    id: x.id,
    targetId: targetId(x.targetId),
    checkedAt: new Date(x.checkedAt),
    duration: x.durationMillis,
    classification: new classes[
      x.classification._tag as keyof typeof classes
    ](),
    failure: x.failure && new CheckFailure(x.failure),
    response: new ResponseMetadata(x.response ?? {}),
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

export const decodeHistoryLineEffect = (line: string, lineNo: number): Effect.Effect<HistoryRow, MalformedHistoryRow> =>
  Effect.try({
    try: () => JSON.parse(line),
    catch: (e) => new MalformedHistoryRow({ line: lineNo, reason: String(e) }),
  }).pipe(
    Effect.flatMap((parsed) =>
      Schema.decodeUnknownEffect(HistoryRowSchema)(parsed).pipe(
        Effect.mapError(() => new MalformedHistoryRow({ line: lineNo, reason: "schema validation failed" })),
      )
    ),
  );

export const importHistoryEffect = (path: string): Effect.Effect<Digest, HistoryReadError> =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (e) => new HistoryReadError({ path, cause: e }),
  }).pipe(
    Effect.flatMap((text) => {
      const lines = text.split(/\r?\n/).filter((x) => x.trim());
      return Stream.fromIterable(lines).pipe(
        Stream.mapAccumEffect<number, string, CheckResult | MalformedHistoryRow, never, never>(
          () => 0,
          (i, line) =>
            decodeHistoryLineEffect(line, i + 1).pipe(
              Effect.match({
                onSuccess: (row) => [i + 1, [toCheck(row) as CheckResult]] as const,
                onFailure: (e) => [i + 1, [e] as ReadonlyArray<MalformedHistoryRow>] as const,
              })
            )
        ),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.flatMap((rows) => digestFromStreamEffect(rows)),
      );
    }),
  );
