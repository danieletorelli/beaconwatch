import { expect, it } from "vitest"
import { Duration, Effect, FileSystem, Layer, Path, Stream } from "effect"
import { CheckFailure, CheckResult, Down, ResponseMetadata, targetId } from "../../../src/domain/schema.js"
import { RepositoryError } from "../../../src/domain/errors.js"
import { startServer } from "../../../src/http/server.js"
import { SqliteCheckRepository } from "../../../src/repo/SqliteCheckRepository.js"
import { importHistory } from "../../../src/services/DigestService.js"
import * as Board from "../../../src/stm/StatusBoard.js"
const check = new CheckResult({ id: "check_dp", targetId: targetId("target_dp"), checkedAt: new Date(0), duration: Duration.millis(1), classification: new Down(), failure: new CheckFailure({ reason: "down" }), response: new ResponseMetadata({}) })
const execute = (repo: any, statement: string) => typeof repo.execute === "function" ? repo.execute(statement) : Promise.resolve(repo.db.exec(statement))
const runMaybe = <A>(value: A | Promise<A> | Effect.Effect<A>) => Effect.isEffect(value) ? Effect.runPromise(value) : Promise.resolve(value)
const makeBoard = () => runMaybe(typeof Board.make === "function" ? Board.make() : Board.make)
it("keeps malformed history rows out of imported aggregates", async () => { const line = (overrides: Record<string, unknown> = {}) => JSON.stringify({ id: "check_history", targetId: "target_history", checkedAt: "2026-01-01T12:34:56.123+05:30", durationMillis: 0.000001, classification: { _tag: "Up" }, response: {}, ...overrides }); const text = [line(), line({ checkedAt: "2026-01-01" }), line({ checkedAt: "2026-02-30T00:00:00Z" }), line({ durationMillis: 0.0000009 })].join("\n"); const fs = FileSystem.makeNoop({ stream: () => Stream.succeed(new TextEncoder().encode(text)) }); const digest = await Effect.runPromise(importHistory("virtual").pipe(Effect.provide(Layer.succeed(FileSystem.FileSystem)(fs)), Effect.provide(Path.layer))); expect([digest.processedRows, digest.malformedRows, digest.targets[0]?.checks]).toEqual([1, 3, 1]) })
it("preserves one-nanosecond distinctions in imported history", async () => { const line = (durationMillis: number) => JSON.stringify({ id: "check_precision_conflict", targetId: "target_history", checkedAt: "2026-01-01T00:00:00Z", durationMillis, classification: { _tag: "Up" }, response: {} }); const text = `${line(4_503_599_627.370497)}\n${line(4_503_599_627.370498)}\n`; const fs = FileSystem.makeNoop({ stream: () => Stream.succeed(new TextEncoder().encode(text)) }); const digest = await Effect.runPromise(importHistory("virtual").pipe(Effect.provide(Layer.succeed(FileSystem.FileSystem)(fs)), Effect.provide(Path.layer))); expect(digest).toEqual({ targets: [], incidents: [], malformedRows: 1, processedRows: 2 }) })
it("DP-13", async () => {
  const closed = new SqliteCheckRepository();
  await closed.close();
  const infrastructure = await closed.listChecks().catch(error => error);
  expect(infrastructure).toBeInstanceOf(RepositoryError);
  expect(infrastructure.operation).toBe("listChecks");
  expect(infrastructure.cause).toBeTruthy();

  const corrupt = new SqliteCheckRepository();
  await execute(corrupt, "insert into incidents values('incident_bad','not-json')");
  const decode = await corrupt.getIncident("incident_bad").catch(error => error);
  expect(decode).toBeInstanceOf(RepositoryError);
  expect(decode.operation).toBe("getIncident");
  expect(decode.cause).toBeTruthy();
  await corrupt.close();

  const runner = new SqliteCheckRepository();
  const expectedFailure = new RepositoryError({ operation: "test", cause: "expected" });
  await expect((runner as any).run("test", Effect.fail(expectedFailure))).rejects.toBe(expectedFailure);
  const sentinel = { defect: "driver invariant" };
  await expect((runner as any).run("test", Effect.die(sentinel))).rejects.toBe(sentinel);
  await runner.close();
})
it("DP-69", async () => { let calls = 0; const { server, baseUrl } = await startServer({ getIncident: async () => (++calls, undefined), listTargets: async () => [], listChecks: async () => [] } as any); try { expect((await fetch(`${baseUrl}/incidents/bad`)).status).toBe(400); expect(calls).toBe(0) } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) } })
it("DP-70", async () => { for (const table of ["incidents", "incident_events", "delivery_outbox"]) { const r = new SqliteCheckRepository(); await execute(r, `create trigger fail before insert on ${table} begin select raise(abort, 'forced'); end`); await expect(r.applyCheck(check)).rejects.toBeTruthy(); expect(await r.listChecks()).toEqual([]); await r.close() } })
it("DP-71", async () => { const ids: number[] = []; const send = (id: number) => { ids.push(id); if (ids.length === 1) throw new Error("delivery interrupted") }; const r = new SqliteCheckRepository(":memory:", send); await r.applyCheck(check); await r.deliverPending(send).catch(() => undefined); await r.deliverPending(send); await r.deliverPending(send); expect(ids).toHaveLength(2); expect(ids[1]).toBe(ids[0]); await r.close() })
it("DP-72", async () => { const board = await makeBoard(); let external = 0; await runMaybe(Board.retriedUpdate(board as any, check.targetId, "api", () => { external++ })); expect(external).toBe(1) })
it("DP-73", async () => { const board: any = await makeBoard(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve }); const running = runMaybe(board.openIncident(check.targetId, "api", () => gate)); await Promise.resolve(); try { const state = await runMaybe(typeof board.snapshot === "function" ? board.snapshot() : board.snapshot); expect(state.globalDegradedCount).toBe([...state.tagDegradedCounts.values()].reduce((a: number, b: number) => a + b, 0)) } finally { release(); await running } })
