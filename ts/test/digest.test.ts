import { describe, expect, it } from "@effect/vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Result } from "effect";
import { layer as NodeFileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import { decodeHistoryLineEffect, importHistoryEffect } from "../src/services/DigestService.js";
import { HistoryReadError } from "../src/domain/errors.js";

const row = (id: string, tag: string, millis: number) =>
  JSON.stringify({
    id,
    targetId: "target_cli",
    checkedAt: "2026-01-01T00:00:00.000Z",
    durationMillis: millis,
    classification: { _tag: tag },
    response: {},
  });

describe("history import and digest", () => {
  it.effect("ignores blanks without line numbers and counts malformed rows", () =>
    Effect.gen(function*() {
      const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "bw-digest-")));
      const path = join(dir, "history.ndjson");
      yield* Effect.promise(() =>
        writeFile(path, [row("a", "Up", 10), "", "   ", row("b", "Down", 20), '{"broken"', row("c", "Slow", 5)].join("\n") + "\n"),
      );
      const digest = yield* importHistoryEffect(path).pipe(Effect.provide(NodeFileSystemLayer));
      // a=Up, b=Down, c=Slow processed; one malformed line; blanks unnumbered.
      expect(digest.processedRows).toBe(3);
      expect(digest.malformedRows).toBe(1);
      expect(digest.targets).toHaveLength(1);
      const t = digest.targets[0]!;
      expect(t.currentStatus).toBe("Slow");
      expect(t.checks).toBe(3);
      expect(t.p95LatencyMillis).toBe(20);
      expect(t.uptimePercent).toBeCloseTo((1 / 3) * 100, 5);
    }));

  it.effect("conflicting duplicate ids exclude the id and add one malformed", () =>
    Effect.gen(function*() {
      const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "bw-digest-")));
      const path = join(dir, "conflict.ndjson");
      yield* Effect.promise(() =>
        writeFile(path, [row("a", "Up", 10), row("a", "Down", 99), row("b", "Up", 5)].join("\n") + "\n"),
      );
      const digest = yield* importHistoryEffect(path).pipe(Effect.provide(NodeFileSystemLayer));
      expect(digest.processedRows).toBe(3);
      expect(digest.malformedRows).toBe(1); // conflicting id penalty
      const t = digest.targets[0]!;
      expect(t.checks).toBe(1); // only the non-conflicting id contributes
      expect(t.targetId).toBe("target_cli");
    }));

  it.effect("missing files fail as HistoryReadError with the path", () =>
    Effect.gen(function*() {
      const outcome = yield* Effect.result(
        importHistoryEffect(join(tmpdir(), "bw-digest-missing.ndjson")).pipe(Effect.provide(NodeFileSystemLayer)),
      );
      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure") {
        expect(outcome.failure._tag).toBe("HistoryReadError");
        expect(String(outcome.failure.path)).toContain("missing");
      }
    }));

  it.effect("malformed UTF-8 fails as HistoryReadError", () =>
    Effect.gen(function*() {
      const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "bw-digest-")));
      const path = join(dir, "bad.ndjson");
      yield* Effect.promise(() => writeFile(path, new Uint8Array([0xff, 0xfe])));
      const outcome = yield* Effect.result(importHistoryEffect(path).pipe(Effect.provide(NodeFileSystemLayer)));
      expect(outcome._tag === "Failure" && outcome.failure._tag === "HistoryReadError").toBe(true);
    }));

  it.effect("durations violating the nanosecond bound are malformed rows", () =>
    Effect.gen(function*() {
      const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "bw-digest-")));
      const path = join(dir, "huge.ndjson");
      yield* Effect.promise(() =>
        writeFile(path, [row("a", "Up", 10), row("b", "Up", 1e308)].join("\n") + "\n"),
      );
      const digest = yield* importHistoryEffect(path).pipe(Effect.provide(NodeFileSystemLayer));
      expect(digest.processedRows).toBe(1);
      expect(digest.malformedRows).toBe(1);
    }));

  it.effect("row-conversion failures become structured rows with line numbers (BUGS 17.9)", () =>
    Effect.gen(function*() {
      const malformedLine = JSON.stringify({
        id: "bad",
        targetId: "nope", // violates the target id shape
        checkedAt: "2026-01-01T00:00:00.000Z",
        durationMillis: 1,
        classification: { _tag: "Up" },
        response: {},
      });
      const outcome = yield* Effect.result(
        decodeHistoryLineEffect(malformedLine, 7),
      );
      expect(Result.isFailure(outcome)).toBe(true);
      if (Result.isFailure(outcome)) {
        expect(outcome.failure._tag).toBe("MalformedHistoryRow");
        expect(outcome.failure.line).toBe(7);
        expect(outcome.failure.reason.length).toBeGreaterThan(0);
      }
    }));
});

expect(typeof HistoryReadError).toBe("function");

describe("digest aggregation details (contract 7.2)", () => {
  it.effect("unknown row fields are ignored", () =>
    Effect.gen(function*() {
      const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "bw-digest-")));
      const path = join(dir, "extra.ndjson");
      const extra = JSON.stringify({
        ...JSON.parse(row("a", "Up", 10)),
        unknownField: "ignored",
        nested: { deep: true },
      });
      yield* Effect.promise(() => writeFile(path, extra + "\n"));
      const digest = yield* importHistoryEffect(path).pipe(Effect.provide(NodeFileSystemLayer));
      expect(digest.processedRows).toBe(1);
      expect(digest.malformedRows).toBe(0);
      expect(digest.targets[0]!.checks).toBe(1);
    }));

  it.effect("equal-timestamp current-status ties break by check id", () =>
    Effect.gen(function*() {
      const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "bw-digest-")));
      const path = join(dir, "tie.ndjson");
      yield* Effect.promise(() =>
        writeFile(path, [row("check_b", "Down", 10), row("check_a", "Up", 10)].join("\n") + "\n"),
      );
      const digest = yield* importHistoryEffect(path).pipe(Effect.provide(NodeFileSystemLayer));
      // Same timestamp: the greater bytewise id wins for current status.
      expect(digest.targets[0]!.currentStatus).toBe("Down");
      expect(digest.targets[0]!.checks).toBe(2);
    }));

  it.effect("non-positive and non-finite durations are malformed rows", () =>
    Effect.gen(function*() {
      const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "bw-digest-")));
      const path = join(dir, "bad-durations.ndjson");
      yield* Effect.promise(() =>
        writeFile(
          path,
          [row("a", "Up", 0), row("b", "Up", -5), row("c", "Up", 7)].join("\n") + "\n",
        ),
      );
      const digest = yield* importHistoryEffect(path).pipe(Effect.provide(NodeFileSystemLayer));
      expect(digest.processedRows).toBe(1);
      expect(digest.malformedRows).toBe(2);
    }));

  it.effect("rows with lone-surrogate ids fail independently and later rows still import", () =>
    Effect.gen(function*() {
      const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "bw-digest-")));
      const path = join(dir, "surrogate.ndjson");
      yield* Effect.promise(() =>
        writeFile(
          path,
          [
            row("check_\uD800", "Up", 10),
            row("check_ok", "Up", 10),
          ].join("\n") + "\n",
        ),
      );
      const digest = yield* importHistoryEffect(path).pipe(Effect.provide(NodeFileSystemLayer));
      expect(digest.processedRows).toBe(1);
      expect(digest.malformedRows).toBe(1);
      expect(digest.targets[0]!.targetId).toBe("target_cli");
    }));
});
