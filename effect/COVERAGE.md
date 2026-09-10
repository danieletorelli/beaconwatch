---
inputs:
  - research/syllogism.md
  - research/example-app-candidate-b.md
  - workshop/beaconwatch/effect/src
  - workshop/beaconwatch/effect/test
date_created: 2026-06-25
date_updated: 2026-09-09
summary: >
  Auditable map from every Part / sub-section of research/syllogism.md to where
  the BeaconWatch reference implementation demonstrates it, with treatment depth
  (BUILD = hands-on code + test, DEMO = guided demo module, TOUR = architectural
  note / minimal demo, REF = reference-only). Used as the contract the
  3-reviewer + 1-judge coverage loop checks the POC against. Effect 4.0
  RC.112; APIs verified against the installed package declarations and tests.
---

# BeaconWatch POC — syllogism coverage map

Toolchain: `effect@4.0.0-rc.112`, `@effect/platform-node`, `@effect/sql-sqlite-node`,
`@effect/vitest@4.0.0-rc.112`, TypeScript 5.9.3, and Vitest 4.1.0. Verify with
`npx tsc --noEmit && npx vitest run` (currently: tsc clean, 218 tests passing).

Depth legend: **BUILD** = real code + test · **DEMO** = guided demo module + test ·
**TOUR** = architectural note / minimal demo · **REF** = reference-only (not in POC).

| Syllogism unit | Depth | POC source | POC test |
| --- | --- | --- | --- |
| 0.1 Problems with ordinary TS | n/a | (motivational; shown via anti-patterns throughout) | — |
| 0.2 `Effect<A,E,R>` mental model | BUILD | pervasive | all |
| 1.1 `Option`, `Result` | BUILD | `src/domain/values.ts`, `src/probe/ProbeProgram.ts` | `test/domain/values.test.ts` |
| 1.2 `Data` | BUILD | `src/domain/errors.ts`, `src/domain/values.ts` | `test/domain/values.test.ts` |
| 1.3 `Duration` | BUILD | `src/domain/schema.ts`, `src/probe/ProbeProgram.ts` | `test/probe/ProbeProgram.test.ts` |
| 2.0 `Exit` (just-in-time) | BUILD | `src/domain/defects.ts` | `test/domain/defects.test.ts` |
| 2.1 Constructing effects | BUILD | `src/probe/ProbeProgram.ts`, `src/services/*` | many |
| 2.2 Running at the edge | BUILD | `src/bin.ts` (single `runMain`), `src/main.ts` (program/wiring) | `test/main.test.ts` |
| 2.3 Sequencing / `gen` / `pipe` | BUILD | pervasive | all |
| 2.4 `Effect.all` / traversal | BUILD | `src/watch/Scheduler.ts`, `src/obs/Telemetry.ts` | `test/watch/Scheduler.test.ts` |
| 2.5 First tests (design loop) | BUILD | — | `test/domain/values.test.ts` (+all) |
| 3.1 Domain failures as values | BUILD | `src/domain/errors.ts` | `test/services/RecoveryPolicy.test.ts` |
| 3.2 `Match` | BUILD | `src/domain/classify-match.ts` | `test/domain/classify-match.test.ts` |
| 3.2a Error boundary policy | BUILD | `src/services/RecoveryPolicy.ts` | `test/services/RecoveryPolicy.test.ts` |
| 3.3 Recovering selectively (`catchTags`) | BUILD | `src/services/RecoveryPolicy.ts` | `test/services/RecoveryPolicy.test.ts` |
| 3.4 Defects, `Cause`, `Exit` | BUILD | `src/domain/defects.ts` | `test/domain/defects.test.ts` |
| 3.5 Advanced cause handling | TOUR | `src/domain/defects.ts` (`Cause.findDie`) | `test/domain/defects.test.ts` |
| 3.6 Testing the failure model | BUILD | — | `test/domain/defects.test.ts`, `test/services/RecoveryPolicy.test.ts` |
| 3½ Boundary data with Schema | BUILD | `src/domain/schema.ts` | `test/domain/schema.test.ts` |
| 5.1 Declaring/using services | BUILD | `src/services/ProbeClient.ts`, `src/services/Config.ts` | `test/services/Config.test.ts` |
| 5.2 Providing implementations | BUILD | `src/services/*` layers | many |
| 5.3 DI testing payoff | BUILD | `src/services/ProbeClient.ts` (fake layer) | `test/probe/ProbeProgram.test.ts` |
| 5.3a Service needing services | BUILD | `src/services/IncidentService.ts` | `test/services/*` |
| 5.4 Composing graphs with `Layer` | BUILD | `src/main.ts`, `src/repo/SqliteCheckRepository.ts` | `test/repo/sqlite.test.ts` |
| 5.5 Layer discipline | BUILD | `src/repo/*`, `src/services/*` | (typed boundaries) |
| 6.1 Acquire/use/release | BUILD | `src/testkit/MockTargetServer.ts`, `src/repo/ConnectionPool.ts` | `test/testkit/MockTargetServer.test.ts` |
| 6.2 Resourceful scoped layers | BUILD | `src/repo/ConnectionPool.ts`, `src/repo/SqliteCheckRepository.ts` | `test/repo/pool.test.ts` |
| 6.3 Testing finalizers | BUILD | — | `test/repo/pool.test.ts`, `test/probe/ProbeProgram.test.ts` |
| 6.4 Testing scoped services | BUILD | — | `test/repo/pool.test.ts`, `test/probe/ProbeProgram.test.ts` |
| 7.1 Fibers / structured concurrency | BUILD | `src/watch/Scheduler.ts` | `test/watch/Scheduler.test.ts` |
| 7.2 `forkDetach` footgun | TOUR | (anti-pattern note) | `test/watch/Scheduler.test.ts` |
| 7.3 Bounded parallelism / timeout | BUILD | `src/watch/Scheduler.ts`, `src/probe/ProbeProgram.ts` | `test/watch/Scheduler.test.ts` |
| 8.1 `Ref` / `SynchronizedRef` | BUILD | `src/watch/StatusState.ts` | `test/watch/Scheduler.test.ts` |
| 8.2 `Queue` (the one primitive) | BUILD | `src/watch/Scheduler.ts` | `test/watch/Scheduler.test.ts` |
| 8.3 Concurrency integration tests | BUILD | `src/watch/Scheduler.ts` | `test/watch/Scheduler.test.ts` |
| 9.1 `Deferred` | TOUR | (used in tests as latch) | `test/repo/pool.test.ts` |
| 9.2 `PubSub` | BUILD | `src/watch/Scheduler.ts` (`BulletinBus`) | `test/watch/Scheduler.test.ts` |
| 10.1 `Clock`, `DateTime` | BUILD | `src/probe/ProbeProgram.ts` (Clock), `src/domain/values.ts` (DateTime) | `test/domain/values.test.ts` |
| 10.2 `Schedule`, retry/repeat | BUILD | `src/probe/ProbeProgram.ts` | `test/probe/ProbeProgram.test.ts` |
| 10.3 `TestClock` | BUILD | — | `test/probe/ProbeProgram.test.ts`, `test/watch/Scheduler.test.ts` |
| 10.4 `Config`, `ConfigProvider`, `Redacted` | BUILD | `src/services/Config.ts` | `test/services/Config.test.ts` |
| 10.5 `Semaphore` | BUILD | `src/repo/ConnectionPool.ts` | `test/repo/pool.test.ts` |
| 10.6 `Pool` | BUILD | `src/repo/ConnectionPool.ts` | `test/repo/pool.test.ts` |
| 11.1 Schema classes/transforms/defaults | BUILD | `src/domain/schema.ts` | `test/domain/schema.test.ts` |
| 11.2 `JsonSchema` artifact | BUILD | `src/domain/json-schema.ts` | `test/domain/json-schema.test.ts` |
| 11.3 Property testing from schemas | BUILD | — | `test/domain/schema.test.ts` (Arbitrary) |
| 12.1 Streams: create/transform/run | BUILD | `src/services/DigestService.ts` | `test/services/DigestService.test.ts` |
| 12.2 `Sink`; resourceful/concurrent streams | BUILD | `src/services/DigestService.ts` | `test/services/DigestService.test.ts` |
| 12.3 Testing streams | BUILD | — | `test/services/DigestService.test.ts` |
| 12.4 `Channel` | REF | — | — |
| 13.0 Runtime `References` | BUILD | `src/obs/references.ts` | `test/obs/telemetry.test.ts` |
| 13.1 Structured logging | BUILD | `src/obs/Telemetry.ts` | `test/obs/telemetry.test.ts` |
| 13.2 Tracing/spans | BUILD | `src/obs/Telemetry.ts` | `test/obs/telemetry.test.ts` |
| 13.3 Metrics | BUILD | `src/obs/Telemetry.ts` | `test/obs/telemetry.test.ts` |
| 13.4 Exporting telemetry | DEMO | `src/obs/Telemetry.ts` (in-memory exporter) | `test/obs/telemetry.test.ts` |
| 14.1 `Cache` | BUILD | `src/obs/DigestCache.ts` | `test/obs/DigestCache.test.ts` |
| 14.2 `Cache` | BUILD | `src/obs/DigestCache.ts` | `test/obs/DigestCache.test.ts` |
| 14.3 `Request`/`RequestResolver` | DEMO | `src/obs/TargetTagsResolver.ts` | `test/obs/TargetTagsResolver.test.ts` |
| 15.1 Default entrypoint (`runMain`) | BUILD | `src/main.ts` (testable wiring) + `src/bin.ts` (process edge) | `test/main.test.ts` |
| 15.2 `ManagedRuntime` | DEMO | `src/runtime/ManagedRuntime.ts` | `test/runtime/ManagedRuntime.test.ts` |
| 15.3 Platform & unstable modules | BUILD | `src/http/*`, `src/repo/*`, `src/cli/cli.ts` | `test/http/*` |
| 16.1 HTTP boundary (`HttpApi`) | BUILD | `src/http/api.ts`, `src/http/server.ts` | `test/http/api.test.ts` |
| 16.2 SQL persistence | BUILD | `src/repo/SqliteCheckRepository.ts` | `test/repo/sqlite.test.ts` |
| 16.3 Transactions | BUILD | `src/repo/SqliteCheckRepository.ts` (`applyCheck`) | `test/repo/transactions.test.ts` |
| 16.4 Artifacts (OpenAPI/client) | DEMO | `src/http/openapi.ts` | `test/http/openapi.test.ts` |
| 16.5 Artifacts (OpenAPI/client) | DEMO | `src/http/openapi.ts` | `test/http/openapi.test.ts` |
| 16.6 HTTP client (live) | BUILD | `src/services/HttpProbeClient.ts` | `test/services/HttpProbeClient.test.ts` |
| 16.7 CLI | BUILD | `src/cli/cli.ts` | `test/cli/cli.test.ts` |
| 16.8 RPC & Workflow | TOUR | (architectural note below) | — |
| 16.9 Cluster | TOUR | (architectural note below) | — |
| 16.10 AI integration | DEMO | `src/services/IncidentSummarizer.ts` | `test/services/IncidentSummarizer.test.ts` |
| 16.11 STM (`Tx*`) | BUILD (required narrow repair; broader STM is TOUR) | `src/stm/StatusBoard.ts` | `test/stm/StatusBoard.test.ts` |

## Known modeling notes / honest gaps

- **`src/http/server.ts`** wires HttpApi handlers + generated OpenAPI as a Layer
  and exports a platform-node listening layer. Focused tests exercise the same
  `HttpApiBuilder` routes through the in-memory web handler to avoid binding a
  nondeterministic test port.
- **`test/obs/DigestCache.test.ts`** covers single-flight and TTL expiry with
  `@effect/vitest`'s test environment and `TestClock.adjust`; it does not sleep on
  the real wall clock.
- **`src/repo/ConnectionPool.ts`** models a bounded reusable-handle `Pool` +
  `Semaphore` guarding DB access rather than a driver-native SQLite connection pool
  (the sqlite layer owns its own connection); see `// COVERAGE NOTE` in source.
- **16.8 RPC/Workflow, 16.9 Cluster** are TOUR-only per the BeaconWatch design
  contract (`research/example-app-candidate-b.md`): architectural discussion, not
  required build code. **12.4 `Channel`** is reference-only.
- Depth labels match the syllogism's own tiering (hands-on / demo / mention /
  reference-only); TOUR/REF items are intentionally not full builds.
