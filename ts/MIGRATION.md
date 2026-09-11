# BeaconWatch Effect Migration Guide

This document describes the semantic patterns used to migrate the BeaconWatch
TypeScript codebase from hand-rolled abstractions to Effect. Each pattern
groups semantically-related transformations applied consistently across the
codebase.

---

## Pattern 1: Hand-Rolled Error Types → `Data.TaggedError`

**What changed:** All custom error classes that extended `Error` or a hand-rolled
`TaggedError` base class were converted to `Data.TaggedError("Tag")<{ fields }>`.

**Files affected:**
- `domain/errors.ts` — All 9 error types (`DnsError`, `TimeoutError`, `UnexpectedStatus`, `InvalidBody`, `TargetDisabled`, `RepositoryError`, `ConfigError`, `HistoryReadError`, `ValidationError`)
- `services/DigestService.ts` — `MalformedHistoryRow`
- `services/IncidentSummarizer.ts` — `IncidentSummaryError`

**Before:**
```ts
class TaggedError extends Error {
  constructor(readonly _tag: string, message: string) {
    super(message);
    this.name = _tag;
  }
}
export class DnsError extends TaggedError {
  readonly host: string;
  override readonly cause?: unknown;
  constructor(x: { host: string; cause?: unknown }) {
    super("DnsError", `DNS error: ${x.host}`);
    this.host = x.host;
    this.cause = x.cause;
  }
}
```

**After:**
```ts
export class DnsError extends Data.TaggedError("DnsError")<{
  readonly host: string;
  readonly cause?: unknown;
}> {}
```

**Why:**
- Structural equality via `Equal.equals` (needed for STM, retry, etc.)
- Automatic `_tag` discriminant for `Effect.catchTag` / `Effect.catchTags`
- Serialization support
- No manual constructor boilerplate

**Gotcha:** `Data.TaggedError` constructor takes a single object argument.
Call `new DnsError({ host, cause })`, not `new DnsError(host, cause)`.

---

## Pattern 2: Hand-Rolled Result → Effect `Result`

**What changed:** The hand-rolled `Result<A, E> = { ok: true; value: A } | { ok: false; error: E }` was replaced with Effect's `Result<A, E>`.

**Files affected:**
- `domain/values.ts` — `classifyProbe` return type

**Before:**
```ts
export type Result<A, E> = { ok: true; value: A } | { ok: false; error: E };
export const classifyProbe = (...): Result<Classification, DomainError> => {
  if (i.failure) {
    if (d === "operator-action") throw i.failure;  // BUG: throws instead of returning
    return { ok: true, value: ... };
  }
  return { ok: false, error: new TimeoutError(...) };
};
```

**After:**
```ts
export type { Result } from "effect";
export const classifyProbe = (...): Result.Result<Classification, DomainError> => {
  if (i.failure) {
    if (d === "operator-action") return Result.fail(i.failure);  // consistent
    return Result.succeed(...);
  }
  return Result.fail(new TimeoutError(...));
};
```

**Why:**
- Access to `Result.match`, `Result.flatMap`, `Result.map`, `Result.isFailure`, `Result.isSuccess`
- Consistent error channel (no more mixed throw/return)
- Eliminates the "operator-action" throw bug

**Callers:** Updated from `classified.ok` / `classified.value` / `classified.error` to `Result.isSuccess(classified)` / `classified.success` / `classified.failure`.

---

## Pattern 3: `undefined`/Optional Fields → `Option.Option`

**What changed:** Domain model fields and repository return types that used `T | undefined` to represent "value may be absent" were converted to `Option.Option<T>`.

**Files affected:**
- `domain/schema.ts` — `CheckResult.failure`, `ResponseMetadata.status`, `ResponseMetadata.bytes`, `Incident.closedAt`, `Incident.summary`
- `repo/CheckRepository.ts` — `getIncident`, `getOpenIncident` return types
- `repo/SqliteCheckRepository.ts` — Same methods
- `watch/StatusState.ts` — `StatusEntry.openIncident`, `StatusStateEffect.get`
- `obs/TargetTagsResolver.ts` — `TargetMeta.latestIncident`, `loadManyEffect`, `loadEffect`
- `domain/values.ts` — `incidentCloseTime`, `formatIncidentWindow` parameters
- `http/server.ts` — `getIncident` consumer

**Before:**
```ts
// Schema
class CheckResult {
  readonly failure?: CheckFailure;
  constructor(input: { failure?: CheckFailure; ... }) {
    if (input.failure) this.failure = input.failure;
  }
}

// Repository
getIncident(id: string): Promise<Incident | undefined>;
getOpenIncident(id: TargetId): Promise<Incident | undefined>;

// Consumer
const i = await repo.getIncident(id);
return i ? send(200, { ... }) : send(404, { ... });
```

**After:**
```ts
// Schema
class CheckResult {
  readonly failure: Option.Option<CheckFailure>;
  constructor(input: { failure?: CheckFailure; ... }) {
    this.failure = input.failure !== undefined ? Option.some(input.failure) : Option.none();
  }
}

// Repository
getIncident(id: string): Promise<Option.Option<Incident>>;
getOpenIncident(id: TargetId): Promise<Option.Option<Incident>>;

// Consumer
const iResult = await repo.getIncident(id);
return Option.isSome(iResult) ? send(200, { ... }) : send(404, { ... });
```

**Why:**
- Explicit "absence is a meaningful domain concept" vs. "parameter not provided"
- Type-safe: `Option.isSome(result)` narrows the type, `result.value` is safe
- Enables `Option.match`, `Option.map`, `Option.flatMap` for composition
- Eliminates `x && x.property` patterns that conflate `undefined` with `false`

**Convention:** Constructor inputs stay as `?` for ergonomics (callers don't need to wrap in `Option.some`), but the class field is `Option.Option<T>`.

**Gotcha:** When spreading an object with Option fields into a constructor that expects plain values, you must unwrap explicitly:
```ts
// DON'T: ...i spreads closedAt: Option.Option<Date> into constructor expecting Date
new Incident({ ...i, closedAt: new Date(...) })

// DO: unwrap explicitly
new Incident({
  id: i.id,
  targetId: i.targetId,
  openedAt: i.openedAt,
  ...(Option.isSome(i.closedAt) ? { closedAt: new Date(i.closedAt.value) } : {}),
})
```

---

## Pattern 4: `async`/`await` + `Promise` → `Effect.gen` + `Effect.tryPromise`

**What changed:** Functions that used `async`/`await` with `Promise` for
effectful operations (I/O, network, database) were converted to `Effect.gen`
with `Effect.tryPromise` for error capture and `Effect.sleep` for delays.

**Files affected:**
- `services/HttpProbeClient.ts` — `probe` method
- `services/ProbeClient.ts` — `FakeProbeClient.probe`
- `probe/ProbeProgram.ts` — `probeOnce`, `probeOnceWithRetry`
- `services/DigestService.ts` — `importHistoryEffect`, `digestFromStreamEffect`
- `obs/Telemetry.ts` — `recordCheckMetricsEffect`

**Before:**
```ts
async probe(target: ProbeTarget, signal?: AbortSignal): Promise<RawProbeResponse> {
  const own = new AbortController();
  setTimeout(() => own.abort(), target.timeout);
  try {
    const response = await this.fetcher(url, { signal: own.signal });
    // ...
  } catch (e) {
    if (own.signal.aborted) throw new TimeoutError({ ... });
    throw new DnsError({ ... });
  }
}
```

**After:**
```ts
probe(target: ProbeTarget, signal?: AbortSignal): Effect.Effect<RawProbeResponse, ProbeFailure> {
  const fetcher = this.fetcher;
  return probeOnceImpl(fetcher, target, signal);
}

const probeOnceImpl = (...) => Effect.gen(function*() {
  const own = new AbortController();
  yield* Effect.sync(() => setTimeout(() => own.abort(), target.timeout));
  const response = yield* Effect.tryPromise({
    try: () => fetcher(url, { signal: own.signal }),
    catch: (e) => {
      if (own.signal.aborted) return new TimeoutError({ ... });
      return new DnsError({ ... });
    },
  });
  // ...
});
```

**Why:**
- Typed error channel (no more `catch (e) { e as DomainError }` casts)
- `Effect.tryPromise` captures promise rejections as typed errors
- `Effect.gen` provides sequential composition without callback nesting
- `Effect.sleep` replaces `setTimeout` + `new Promise`

**Key conversions:**
| Before | After |
|--------|-------|
| `await fetch(...)` | `yield* Effect.tryPromise({ try: () => fetch(...), catch: ... })` |
| `setTimeout(() => ..., ms)` | `yield* Effect.sync(() => setTimeout(() => ..., ms))` |
| `new Promise<void>(r => setTimeout(r, ms))` | `yield* Effect.sleep(ms)` |
| `throw new SomeError(...)` | `return yield* Effect.fail(new SomeError(...))` |

---

## Pattern 5: Imperative Loop with AbortController → `Effect.gen` + `Effect.sleep`

**What changed:** The hand-rolled retry loop in `probeOnce` that used
`AbortController`, `setTimeout`, and manual retry counting was replaced with
`Effect.gen` using `Effect.match` for error capture and `Effect.sleep` for
backoff delays.

**Files affected:**
- `probe/ProbeProgram.ts` — `probeOnce`

**Before:**
```ts
for (let attempt = 0; attempt < 4; attempt++) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), target.timeout);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    raw = await client.probe(target, ctl.signal);
    break;
  } catch (e) {
    if (signal?.aborted) throw signal.reason;
    failure = ctl.signal.aborted
      ? new TimeoutError({ timeout: String(target.timeout), cause: e })
      : (e as DomainError);
    if (attempt === 3) break;
    await sleep(10 * 2 ** attempt, signal);
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
```

**After:**
```ts
for (let attempt = 0; attempt < 4; attempt++) {
  const result = yield* client.probe(target).pipe(
    Effect.match({
      onFailure: (e) => ({ tag: "failure" as const, error: e as DomainError }),
      onSuccess: (v) => ({ tag: "success" as const, value: v }),
    }),
  );
  if (result.tag === "success") {
    raw = result.value;
    failure = undefined;
    break;
  }
  failure = result.error;
  if (attempt === 3) break;
  yield* Effect.sleep(10 * 2 ** attempt);
}
```

**Why:**
- `Effect.match` captures both success and failure without try/catch
- `Effect.sleep` handles backoff without manual `setTimeout`
- No manual `AbortController` management (the probe client handles timeout)
- Typed error channel propagates `ProbeFailure` automatically

---

## Pattern 6: Fake Async (yield points) → `Effect.sync`

**What changed:** Functions that used `await Promise.resolve()` as fake yield
points to simulate async behavior were converted to `Effect.sync` (synchronous)
or `Effect.sleep(0)` (explicit yield point).

**Files affected:**
- `stm/StatusBoard.ts` — All methods
- `smoke.ts` — `greet`

**Before:**
```ts
private async atomic(work: () => void) {
  await Promise.resolve();  // fake yield point
  work();
}
async openIncident(id: TargetId, tag: string) {
  await Promise.resolve();  // fake yield point
  // ... synchronous work ...
}
```

**After:**
```ts
openIncidentEffect(id: TargetId, tag: string): Effect.Effect<void> {
  return Effect.sync(() => {
    // ... synchronous work ...
  });
}
```

**Why:**
- `await Promise.resolve()` provides no real concurrency benefit in single-threaded JS
- `Effect.sync` explicitly marks the code as synchronous but wrapped in Effect
- `Effect.sleep(0)` provides an explicit yield point when needed for retry semantics

---

## Pattern 7: Hand-Rolled Service Tags → `Context.Service`

**What changed:** Service interfaces that were plain TypeScript interfaces without
Effect context integration were given `Context.Service` companion classes for
dependency injection.

**Files affected:**
- `services/ProbeClient.ts` — `ProbeClient`
- `repo/CheckRepository.ts` — `CheckRepository`

**Before:**
```ts
export interface ProbeClientShape {
  probe(target: ProbeTarget, signal?: AbortSignal): Promise<RawProbeResponse>;
}
// No context tag
```

**After:**
```ts
export interface ProbeClientShape {
  probe(target: ProbeTarget, signal?: AbortSignal): Effect.Effect<RawProbeResponse, ProbeFailure>;
}
export class ProbeClient extends Context.Service<ProbeClient, ProbeClientShape>()("beaconwatch/ProbeClient") {}
```

**Why:**
- Enables `Effect.provide(ProbeClient.make(liveImpl))` for dependency injection
- Enables `Effect.service(ProbeClient)` for service access
- Type-safe service resolution at the Effect level

---

## Pattern 8: `Promise.all` Parallelism → `Effect.forEach` with Bounded Concurrency

**What changed:** `Promise.all(array.map(async ...))` patterns were converted
to `Effect.forEach(array, ..., { concurrency: N })` where `N` comes from the
configured worker count.

**Files affected:**
- `watch/Scheduler.ts` — `runOnceEffect`
- `probe/ProbeProgram.ts` — `repeatSuccessfulProbe`

**Before:**
```ts
await Promise.all(queue.map(worker));
```

**After:**
```ts
yield* Effect.forEach(queue, (target) =>
  Effect.gen(function*() {
    const check = yield* probeOnce(target, s.client);
    // ...
  }), { concurrency: options.workerCount });
```

**Why:**
- `Effect.forEach` with bounded `concurrency` limits in-flight work to the configured capacity
- Typed error propagation (first error short-circuits)
- Composable with other Effect combinators

---

## Pattern 9: `for await` Streams → `Effect.gen` + Iteration

**What changed:** `async function` with `for await` loops were converted to
`Effect.gen` with synchronous iteration (when the source is synchronous) or
`Stream` (when truly async).

**Files affected:**
- `services/DigestService.ts` — `digestFromStreamEffect`

**Before:**
```ts
export async function digestFromStream(
  rows: AsyncIterable<CheckResult | MalformedHistoryRow> | Iterable<...>
): Promise<Digest> {
  for await (const row of rows) { ... }
}
```

**After:**
```ts
export const digestFromStreamEffect = (
  rows: Iterable<CheckResult | MalformedHistoryRow>,
): Effect.Effect<Digest> =>
  Effect.sync(() => {
    for (const row of rows) { ... }
  });
```

**Why:**
- When the input is actually synchronous (`Iterable`), `for await` is unnecessary
- `Effect.sync` wraps the pure computation in Effect

---

## Pattern 10: Manual `Effect.tryPromise` Wrapping → Native Effect

**What changed:** Functions that were wrapped in `Effect.tryPromise` to bridge
from Promise-based code were converted to native Effect implementations.

**Files affected:**
- `probe/ProbeProgram.ts` — `probeOnceEffect` removed (now `probeOnce` returns Effect directly)
- `watch/Scheduler.ts` — `runOnceEffect` uses `probeOnce` directly instead of `Effect.runPromise(probeOnce(...))`

**Before:**
```ts
export const probeOnceEffect = (target, client) =>
  Effect.tryPromise({
    try: () => probeOnce(target, client),
    catch: (e) => e as Error,
  });
```

**After:**
```ts
// probeOnce now returns Effect directly
export const probeOnce = (target, client): Effect.Effect<CheckResult, DomainError> =>
  Effect.gen(function*() { ... });
```

**Why:**
- Eliminates the `tryPromise` wrapper and its `catch: (e) => e as Error` cast
- Error type is now precise (`DomainError`) instead of generic `Error`
- Enables `Effect.retry`, `Effect.catchTag`, and other Effect combinators directly

---

## Pattern 11: Config Input `?` Fields → Keep as `?`

**What changed:** Config input interfaces (`TargetConfigInput`, `AppConfig`) that
use `?` for optional fields were **not** converted to `Option`. The `?` syntax
is conventional for configuration objects.

**Files affected:** None (intentionally left as-is).

**Why:**
- Config objects are external input, not domain values
- `?` is the standard TypeScript convention for optional config fields
- Callers shouldn't need to wrap config values in `Option.some()`
- The `Schema.optionalKey` / `Schema.optional` in Effect Schema handles `?` natively

---

## Pattern 12: Error `cause` Fields → Keep as `?`

**What changed:** Error types with `cause?: unknown` fields were **not**
converted to `Option`. The `cause` field follows the standard JavaScript error
wrapping convention.

**Files affected:** None (intentionally left as-is).

**Why:**
- `cause` is a standard JavaScript error property (TC39 Error cause proposal)
- `unknown` is the correct type for arbitrary underlying causes
- `Option<unknown>` would be less idiomatic for error chains

---

## Pattern 13: `Effect.retry(Schedule)` → Selective Retry with `while`

**What changed:** `Effect.retry(Schedule.exponential(...).pipe(Schedule.upTo(...)))`
was changed to `Effect.retry({ schedule: ..., while: predicate })` so only
transient transport errors trigger retries. Permanent errors (`TargetDisabled`,
`UnexpectedStatus`, `InvalidBody`) fail immediately.

**Files affected:**
- `probe/ProbeProgram.ts` — `probeOnceWithRetry`

**Before:**
```ts
probeOnce(target, client).pipe(
  Effect.retry(Schedule.exponential(10).pipe(Schedule.upTo({ times: 3 })))
);
```

**After:**
```ts
const isTransient = (error: DomainError) =>
  error._tag === "DnsError" || error._tag === "TimeoutError";

probeOnce(target, client).pipe(
  Effect.retry({ schedule: Schedule.exponential(10).pipe(Schedule.upTo({ times: 3 })), while: isTransient })
);
```

**Why:**
- Only transient transport errors (DNS, timeout) are retried
- Permanent failures propagate immediately without wasting retry budget
- `while` predicate is evaluated per-error, enabling targeted recovery policy

---

## Pattern 14: Success-Only Gauge Update → `Effect.ensuring`

**What changed:** Active gauge increments/decrements that only ran on success
were wrapped with `Effect.ensuring` so the decrement happens on every exit path.

**Files affected:**
- `obs/Telemetry.ts` — `recordCheckMetricsEffect`

**Before:**
```ts
export const recordCheckMetricsEffect = (c: CheckResult): Effect.Effect<void> =>
  Effect.gen(function*() {
    yield* Metric.update(probeLatencyMetric, c.duration);
    yield* Metric.update(probeCountMetric, 1);
    if (c.classification._tag !== "Up") yield* Metric.update(errorCountMetric, 1);
  });
```

**After:**
```ts
export const recordCheckMetricsEffect = (c: CheckResult): Effect.Effect<void> =>
  Effect.gen(function*() {
    yield* Metric.modify(activeProbeGauge, 1);
    yield* Metric.update(probeLatencyMetric, c.duration);
    yield* Metric.update(probeCountMetric, 1);
    if (c.classification._tag !== "Up") yield* Metric.update(errorCountMetric, 1);
  }).pipe(Effect.ensuring(Metric.modify(activeProbeGauge, -1)));
```

**Why:**
- `Effect.ensuring` decrements on success, failure, and interruption
- Without it, a failed probe leaves the gauge permanently inflated

---

## Pattern 15: Ternary Chain with Catch-All → `Match.tagsExhaustive`

**What changed:** Manual `_tag ===` comparisons with a catch-all default branch
were replaced with `Match.tagsExhaustive` so adding a new `DomainError` variant
produces a compile error instead of silently falling through.

**Files affected:**
- `domain/classify-match.ts` — `classifyDomainError`

**Before:**
```ts
export const classifyDomainError = (e: DomainError): ErrorDisposition =>
  e._tag === "TargetDisabled"
    ? "ignore-disabled"
    : e._tag === "InvalidBody"
      ? "invalid-response"
      : ["DnsError", "TimeoutError", "UnexpectedStatus"].includes(e._tag)
        ? "service-down"
        : "operator-action";
```

**After:**
```ts
export const classifyDomainError = (e: DomainError): ErrorDisposition =>
  Match.value(e).pipe(
    Match.tagsExhaustive({
      TargetDisabled: () => "ignore-disabled" as const,
      InvalidBody: () => "invalid-response" as const,
      DnsError: () => "service-down" as const,
      TimeoutError: () => "service-down" as const,
      UnexpectedStatus: () => "service-down" as const,
      RepositoryError: () => "operator-action" as const,
      ConfigError: () => "operator-action" as const,
      HistoryReadError: () => "operator-action" as const,
      ValidationError: () => "operator-action" as const,
    }),
  );
```

**Why:**
- Exhaustive: adding a new `DomainError` variant forces a compile error
- No catch-all default that silently absorbs new variants
- `Match.tagsExhaustive` is the idiomatic Effect pattern for discriminated unions

---

## Pattern 16: `Date.now()` → `Clock.currentTimeMillis`

**What changed:** Ambient `Date.now()` calls inside Effect workflows were replaced
with `Clock.currentTimeMillis` for testability with `TestClock`.

**Files affected:**
- `probe/ProbeProgram.ts` — `probeOnce`

**Before:**
```ts
const start = Date.now();
// ... probe logic ...
const end = Date.now(), duration = Math.max(1, end - start);
```

**After:**
```ts
const start = yield* Clock.currentTimeMillis;
// ... probe logic ...
const end = yield* Clock.currentTimeMillis;
const duration = Math.max(1, end - start);
```

**Why:**
- `Date.now()` reads ambient time — not controllable in tests
- `Clock.currentTimeMillis` reads from the Effect `Clock` service
- `TestClock` can fast-forward time deterministically in tests

---

## Pattern 17: Manual Config Parsing → Effect `Config`

**What changed:** Manual `process.env` parsing with `parseInt`/`Number()`/throw
was replaced with `Config.all` composing typed `Config` values.

**Files affected:**
- `services/Config.ts` — `appConfigLayer`

**Before:**
```ts
export const appConfig = (env = process.env): AppConfig => {
  const workerConcurrency = Number(env.workerConcurrency ?? env.WORKER_CONCURRENCY);
  if (!Number.isSafeInteger(workerConcurrency) || workerConcurrency <= 0)
    throw new Error("workerConcurrency must be positive");
  // ... manual parsing ...
};
```

**After:**
```ts
export const appConfigLayer = Config.all({
  pollInterval: Config.duration("POLL_INTERVAL").pipe(Config.withDefault(Duration.seconds(10))),
  probeTimeout: Config.duration("PROBE_TIMEOUT").pipe(Config.withDefault(Duration.seconds(5))),
  workerConcurrency: Config.int("WORKER_CONCURRENCY").pipe(Config.withDefault(2)),
  slowThreshold: Config.duration("SLOW_THRESHOLD").pipe(Config.withDefault(Duration.seconds(3))),
  telemetryEnabled: Config.boolean("TELEMETRY_ENABLED").pipe(Config.withDefault(true)),
  maxIncidents: Config.int("MAX_INCIDENTS").pipe(Config.withDefault(100)),
  realLlmToken: Config.redacted("REAL_LLM_TOKEN"),
}).pipe(
  Config.map((raw) => ({
    pollInterval: Duration.toMillis(raw.pollInterval),
    // ...
  })),
);
```

**Why:**
- `Config` provides typed, composable, testable configuration
- `Config.redacted` wraps secrets in `Redacted<T>` — safe to log
- `Config.withDefault` provides fallback values declaratively
- `Duration` fields are parsed as `Duration` objects, not raw numbers

---

## Pattern 18: Immutable Replacement → Return New Object

**What changed:** Functions that mutated their input arguments were changed to
return new objects with the updated fields.

**Files affected:**
- `domain/values.ts` — `renameCheck`

**Before:**
```ts
export const renameCheck = (check: { id: string }, id: string) => {
  check.id = id;  // mutates input
  return check;
};
```

**After:**
```ts
export const renameCheck = (check: { id: string }, id: string) => ({
  ...check, id,
});
```

**Why:**
- Mutation violates referential transparency
- Callers may hold references to the original object
- Immutable replacement is the standard Effect pattern

---

## Migration Order

The migration was performed in this order to minimize ripple effects:

1. **Error types** (`domain/errors.ts`) — Foundation for all typed error handling
2. **Schema fields** (`domain/schema.ts`) — Core data model
3. **Repository interface** (`repo/CheckRepository.ts`) — Uses Option for return types
4. **Repository implementation** (`repo/SqliteCheckRepository.ts`) — Matches interface
5. **Status state** (`watch/StatusState.ts`) — Uses Option for `openIncident`
6. **Target tags** (`obs/TargetTagsResolver.ts`) — Uses Option for `latestIncident`
7. **Domain values** (`domain/values.ts`) — Uses Option for `incidentCloseTime`
8. **Probe client** (`services/ProbeClient.ts`) — Returns Effect instead of Promise
9. **HTTP client** (`services/HttpProbeClient.ts`) — Returns Effect
10. **Probe program** (`probe/ProbeProgram.ts`) — Native Effect implementation
11. **Scheduler** (`watch/Scheduler.ts`) — Uses native Effect probe
12. **Server** (`http/server.ts`) — Consumer of Option return types
13. **Digest service** (`services/DigestService.ts`) — Native Effect aggregation
14. **Status board** (`stm/StatusBoard.ts`) — Effect.sync for synchronous state
15. **Policy decisions** (`domain/classify-match.ts`) — Match.tagsExhaustive for exhaustive matching
16. **Clock** (`probe/ProbeProgram.ts`) — Clock.currentTimeMillis for testability
17. **Configuration** (`services/Config.ts`) — Effect Config layer with Config.all, Config.redacted
18. **Immutability** (`domain/values.ts`) — Immutable replacement instead of mutation
