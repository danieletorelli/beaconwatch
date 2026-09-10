import { describe, expect, it } from "vitest"
import { Cause, Duration, Effect, FileSystem, Layer, Stream } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { HistoryReadError } from "../../src/domain/errors.js"
import { CheckResult, Down, ResponseMetadata, Up } from "../../src/domain/schema.js"
import { decodeHistoryLine, digestFromStream, historyRows, importHistory, MalformedHistoryRow } from "../../src/services/DigestService.js"
import { target } from "../helpers.js"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

it("pulls history incrementally through an injected filesystem", async () => {
  let pulls = 0
  const bytes = (text: string) => new TextEncoder().encode(text)
  const stream = Stream.fromEffect(Effect.sync(() => { pulls++; return bytes("first\n") })).pipe(
    Stream.concat(Stream.fromEffect(Effect.sync(() => { pulls++; return bytes("second\n") })))
  )
  const fileSystem = FileSystem.makeNoop({ stream: () => stream })
  const rows = await Effect.runPromise(historyRows("virtual.ndjson").pipe(
    Stream.take(1),
    Stream.runCollect,
    Effect.provide(Layer.succeed(FileSystem.FileSystem, fileSystem))
  ))
  expect(rows.map(({ line }) => line)).toEqual(["first"])
  expect(pulls).toBe(1)
})

it("streams NDJSON history, skips malformed rows, and aggregates p95/uptime", async () => {
  const digest = await Effect.runPromise(importHistory("test/fixtures/check-history.ndjson").pipe(Effect.provide(NodeFileSystem.layer)))
  expect(digest.processedRows).toBe(200)
  expect(digest.malformedRows).toBe(2)
  const api = digest.targets.find((t) => t.targetId === "target_api")!
  expect(api.checks).toBe(100)
  expect(api.uptimePercent).toBe(90)
  expect(api.p95LatencyMillis).toBe(194)
})

it("surfaces missing history files as typed HistoryReadError", async () => {
  const exit = await Effect.runPromiseExit(importHistory("test/fixtures/missing-history.ndjson").pipe(Effect.provide(NodeFileSystem.layer)))
  expect(exit._tag).toBe("Failure")
  if (exit._tag === "Failure") {
    const reason = exit.cause.reasons.find(Cause.isFailReason)
    expect(reason?.error).toBeInstanceOf(HistoryReadError)
  }
})

it("rejects malformed UTF-8 history files without replacement decoding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "beaconwatch-history-"))
  const path = join(directory, "invalid.ndjson")
  await writeFile(path, Uint8Array.from([0x7b, 0x22, 0x80, 0x22, 0x7d]))
  try {
    const exit = await Effect.runPromiseExit(importHistory(path).pipe(Effect.provide(NodeFileSystem.layer)))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(exit.cause.reasons.find(Cause.isFailReason)?.error).toBeInstanceOf(HistoryReadError)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it("rejects history rows whose response metadata violates the domain schema", async () => {
  const row = JSON.stringify({
    id: "check_invalid_metadata",
    targetId: "target_history",
    checkedAt: "2026-01-01T00:00:00Z",
    durationMillis: 10,
    classification: { _tag: "Up" },
    response: { status: 999, bytes: -1 }
  })
  const exit = await Effect.runPromise(Effect.exit(decodeHistoryLine(row, 1)))
  expect(exit._tag).toBe("Failure")
})

it("counts a lone-surrogate failure reason as malformed and continues importing later rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "beaconwatch-history-"))
  const path = join(directory, "lone-surrogate.ndjson")
  const valid = JSON.stringify({ id: "check_after_surrogate", targetId: "target_history", checkedAt: "2026-01-01T00:00:00Z", durationMillis: 1, classification: { _tag: "Up" }, response: { status: 200 } })
  await writeFile(path, `{"id":"check_bad_reason","targetId":"target_history","checkedAt":"2026-01-01T00:00:00Z","durationMillis":1,"classification":{"_tag":"Down"},"failure":{"reason":"\\ud800"},"response":{}}\n${valid}\n`)
  try {
    const digest = await Effect.runPromise(importHistory(path).pipe(Effect.provide(NodeFileSystem.layer)))
    expect(digest.malformedRows).toBe(1)
    expect(digest.processedRows).toBe(1)
    expect(digest.targets[0]?.checks).toBe(1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it("rejects history rows with non-positive check durations", async () => {
  const row = JSON.stringify({
    id: "check_invalid_duration",
    targetId: "target_history",
    checkedAt: "2026-01-01T00:00:00Z",
    durationMillis: 0,
    classification: { _tag: "Up" },
    response: { status: 200, bytes: 1 }
  })
  const exit = await Effect.runPromise(Effect.exit(decodeHistoryLine(row, 1)))
  expect(exit._tag).toBe("Failure")
})

it.each([0.000001, 9_007_199_254.74099])("accepts exactly representable duration boundary %s ms", async (durationMillis) => {
  const row = JSON.stringify({ id: "check_duration_boundary", targetId: "target_history", checkedAt: "2026-01-01T00:00:00Z", durationMillis, classification: { _tag: "Up" }, response: {} })
  const decoded = await Effect.runPromise(decodeHistoryLine(row, 1))
  expect(Duration.toMillis(decoded.durationMillis)).toBe(durationMillis)
})

it.each([4_503_599_627.370497, 4_503_599_627.370498])("preserves distinct integral-nanosecond duration %s ms", async (durationMillis) => {
  const row = JSON.stringify({ id: "check_precise_duration", targetId: "target_history", checkedAt: "2026-01-01T00:00:00Z", durationMillis, classification: { _tag: "Up" }, response: {} })
  const decoded = await Effect.runPromise(decodeHistoryLine(row, 1))
  expect(Duration.toNanosUnsafe(decoded.durationMillis)).toBe(BigInt(durationMillis * 1_000_000))
})

it.each([0.0000009, 0.0000011])("rejects near-sub-nanosecond duration %s as malformed", async (durationMillis) => {
  const row = JSON.stringify({ id: "check_imprecise_duration", targetId: "target_history", checkedAt: "2026-01-01T00:00:00Z", durationMillis, classification: { _tag: "Up" }, response: {} })
  const decoded = await Effect.runPromise(decodeHistoryLine(row, 1).pipe(Effect.match({ onFailure: (error) => error, onSuccess: (value) => value })))
  expect(decoded).toBeInstanceOf(MalformedHistoryRow)
})

it("treats an overflowing raw NDJSON duration as malformed rather than an infinite p95", async () => {
  const row = `{"id":"overflow","targetId":"target_history","checkedAt":"2026-01-01T00:00:00Z","durationMillis":1e999,"classification":{"_tag":"Up"},"response":{}}`
  const decoded = await Effect.runPromise(decodeHistoryLine(row, 1).pipe(Effect.match({ onFailure: (error) => error, onSuccess: (value) => value })))
  expect(decoded).toBeInstanceOf(MalformedHistoryRow)
  if (!(decoded instanceof MalformedHistoryRow)) throw new Error("overflowing duration decoded")
  const digest = await Effect.runPromise(digestFromStream(Stream.fromIterable([decoded])))
  expect(digest.malformedRows).toBe(1)
  expect(digest.targets).toEqual([])
})

it.each([
  "0001-01-01T00:00:00Z",
  "2000-02-29T23:59:59Z",
  "9999-12-31T23:59:59.999Z",
  "2026-01-01T00:00:00Z",
  "2026-01-01T12:34:56.123+05:30",
  "2026-01-01T12:34:56-08:00"
])("accepts strict RFC3339 history instant %s", async (checkedAt) => {
  const row = JSON.stringify({ id: "check_time", targetId: "target_history", checkedAt, durationMillis: 1, classification: { _tag: "Up" }, response: {} })
  expect((await Effect.runPromise(decodeHistoryLine(row, 1))).checkedAt).toBeInstanceOf(Date)
})

it.each(["January 1, 2026", "0000-01-01T00:00:00Z", "1900-02-29T00:00:00Z", "2001-02-29T00:00:00Z", "2026-02-30T00:00:00Z", "2026-01-01 00:00:00Z", "2026-01-01T12:34:56.1234Z"])("rejects non-RFC3339 or invalid history instant %s", async (checkedAt) => {
  const row = JSON.stringify({ id: "check_time", targetId: "target_history", checkedAt, durationMillis: 1, classification: { _tag: "Up" }, response: {} })
  expect((await Effect.runPromise(Effect.exit(decodeHistoryLine(row, 1))))._tag).toBe("Failure")
})

it.each(["0001-01-01T00:00:00+23:59", "9999-12-31T23:59:59-23:59"])("rejects offset-normalized instants outside the accepted year range: %s", async (checkedAt) => {
  const row = JSON.stringify({ id: "check_extreme_offset", targetId: "target_history", checkedAt, durationMillis: 1, classification: { _tag: "Up" }, response: {} })
  expect((await Effect.runPromise(Effect.exit(decodeHistoryLine(row, 1))))._tag).toBe("Failure")
})

it("rejects lone-surrogate history IDs independently of input order", async () => {
  const row = (id: string) => JSON.stringify({ id, targetId: "target_history", checkedAt: "2026-01-01T00:00:00Z", durationMillis: 1, classification: { _tag: "Up" }, response: {} })
  const decode = async (rows: string[]) => Promise.all(rows.map((value, i) => Effect.runPromise(decodeHistoryLine(value, i + 1).pipe(Effect.exit))))
  const forward = await decode([row("check_ok"), row("check_\uD800")])
  const reverse = await decode([row("check_\uD800"), row("check_ok")])
  expect(forward.map((exit) => exit._tag).sort()).toEqual(reverse.map((exit) => exit._tag).sort())
  expect(forward.filter((exit) => exit._tag === "Failure")).toHaveLength(1)
})

it("ignores unknown history row fields", async () => {
  const row = JSON.stringify({ id: "check_extra", targetId: "target_history", checkedAt: "2026-01-01T00:00:00Z", durationMillis: 1, classification: { _tag: "Up", extra: true }, response: { extra: true }, extra: true })
  const decoded = await Effect.runPromise(decodeHistoryLine(row, 1))
  expect(decoded.id).toBe("check_extra")
})

it("uses check id to break equal-timestamp current-status ties deterministically", async () => {
  const makeCheck = (id: string, classification: Up | Down) => new CheckResult({
    id,
    targetId: target("target_digest_order").id,
    checkedAt: new Date(1),
    duration: Duration.millis(1),
    classification,
    response: new ResponseMetadata({})
  })
  const digest = await Effect.runPromise(digestFromStream(Stream.fromIterable([
    makeCheck("check_z", new Up()),
    makeCheck("check_a", new Down())
  ])))
  expect(digest.targets[0]?.currentStatus).toBe("Up")
})

it("orders Unicode check ids by code point when selecting current status", async () => {
  const makeCheck = (id: string, classification: Up | Down) => new CheckResult({
    id,
    targetId: target("target_digest_unicode_order").id,
    checkedAt: new Date(1),
    duration: Duration.millis(1),
    classification,
    response: new ResponseMetadata({})
  })
  const digest = await Effect.runPromise(digestFromStream(Stream.fromIterable([
    makeCheck("check_𐀀", new Up()),
    makeCheck("check_", new Down())
  ])))
  expect(digest.targets[0]?.currentStatus).toBe("Up")
})

it("orders target digests independently of history arrival order", async () => {
  const makeCheck = (targetId: "target_a" | "target_z") => new CheckResult({
    id: `check_${targetId}`,
    targetId: target(targetId).id,
    checkedAt: new Date(1),
    duration: Duration.millis(1),
    classification: new Up(),
    response: new ResponseMetadata({ status: 200 })
  })
  const a = makeCheck("target_a")
  const z = makeCheck("target_z")
  const forward = await Effect.runPromise(digestFromStream(Stream.fromIterable([a, z])))
  const reverse = await Effect.runPromise(digestFromStream(Stream.fromIterable([z, a])))
  expect(reverse.targets.map((entry) => entry.targetId)).toEqual(forward.targets.map((entry) => entry.targetId))
})

it("does not double-count an identical check id in imported history", async () => {
  const check = new CheckResult({
    id: "check_repeated_history",
    targetId: target("target_repeated_history").id,
    checkedAt: new Date(1),
    duration: Duration.millis(10),
    classification: new Up(),
    response: new ResponseMetadata({ status: 200 })
  })
  const digest = await Effect.runPromise(digestFromStream(Stream.fromIterable([check, check])))
  expect(digest.targets[0]?.checks).toBe(1)
})

it("excludes duplicate IDs whose wire durations differ by one nanosecond", async () => {
  const line = (durationMillis: number) => JSON.stringify({
    id: "check_precision_conflict",
    targetId: "target_precision_conflict",
    checkedAt: "2026-01-01T00:00:00Z",
    durationMillis,
    classification: { _tag: "Up" },
    response: {}
  })
  const fileSystem = FileSystem.makeNoop({
    stream: () => Stream.succeed(new TextEncoder().encode(`${line(4_503_599_627.370497)}\n${line(4_503_599_627.370498)}\n`))
  })
  const digest = await Effect.runPromise(importHistory("virtual.ndjson").pipe(
    Effect.provide(Layer.succeed(FileSystem.FileSystem, fileSystem))
  ))
  expect(digest).toEqual({ targets: [], incidents: [], malformedRows: 1, processedRows: 2 })
})

it("handles conflicting duplicate check ids independently of history arrival order", async () => {
  const makeCheck = (classification: Up | Down) => new CheckResult({
    id: "check_conflicting_history",
    targetId: target("target_conflicting_history").id,
    checkedAt: new Date(1),
    duration: Duration.millis(10),
    classification,
    response: new ResponseMetadata({ status: classification._tag === "Up" ? 200 : 500 })
  })
  const up = makeCheck(new Up())
  const down = makeCheck(new Down())
  const forward = await Effect.runPromise(digestFromStream(Stream.fromIterable([up, down])))
  const reverse = await Effect.runPromise(digestFromStream(Stream.fromIterable([down, up])))
  expect(reverse).toEqual(forward)
})

it("counts a conflicting check id once as malformed while processing every valid row", async () => {
  const makeCheck = (targetId: "target_conflict_a" | "target_conflict_b", classification: Up | Down) => new CheckResult({
    id: "check_conflicting_identity",
    targetId: target(targetId).id,
    checkedAt: new Date(1),
    duration: Duration.millis(10),
    classification,
    response: new ResponseMetadata({ status: classification._tag === "Up" ? 200 : 500 })
  })
  const digest = await Effect.runPromise(digestFromStream(Stream.fromIterable([
    makeCheck("target_conflict_a", new Up()),
    makeCheck("target_conflict_b", new Down()),
    makeCheck("target_conflict_a", new Up())
  ])))
  expect(digest).toEqual({ targets: [], incidents: [], malformedRows: 1, processedRows: 3 })
})
