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
export class MalformedHistoryRow extends Error {
  readonly _tag = "MalformedHistoryRow";
  constructor(
    readonly line: number,
    readonly reason: string,
  ) {
    super(reason);
  }
}
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
export const decodeHistoryLine = async (line: string, lineNo: number) => {
  try {
    const x = JSON.parse(line);
    if (
      typeof x.id !== "string" ||
      typeof x.checkedAt !== "string" ||
      !(x.classification?._tag in classes) ||
      !(x.durationMillis > 0)
    )
      throw new Error("invalid history row");
    return x;
  } catch (e) {
    throw new MalformedHistoryRow(lineNo, String(e));
  }
};
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
export async function digestFromStream(
  rows:
    | AsyncIterable<CheckResult | MalformedHistoryRow>
    | Iterable<CheckResult | MalformedHistoryRow>,
): Promise<Digest> {
  const byId = new Map<string, CheckResult>();
  const conflicts = new Set<string>();
  let malformedRows = 0,
    processedRows = 0;
  for await (const row of rows) {
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
}
export const importHistory = async (path: string) => {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    throw new HistoryReadError({ path, cause: e });
  }
  const rows = await Promise.all(
    text
      .split(/\r?\n/)
      .filter((x) => x.trim())
      .map(async (line, i) => {
        try {
          return toCheck(await decodeHistoryLine(line, i + 1));
        } catch (e) {
          return e as MalformedHistoryRow;
        }
      }),
  );
  return digestFromStream(rows);
};

export const orderedDigestRows = async <A>(rows: readonly A[], inspect: (row: A) => Promise<A>) =>
  {
    const completionOrder: A[] = [];
    await Promise.all(rows.map(async (row) => completionOrder.push(await inspect(row))));
    return completionOrder;
  };
