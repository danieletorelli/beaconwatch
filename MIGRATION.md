# BeaconWatch Effect Migration Guide

This document describes the semantic patterns used to migrate the BeaconWatch
TypeScript codebase from hand-rolled abstractions to Effect. Each pattern
groups semantically-related transformations applied consistently across the
codebase. Source paths in this document are relative to `ts/`, the carried
participant application; behavioral contracts refer to [`SPEC.md`](./SPEC.md).

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
- `probe/ProbeProgram.ts` — `probeOnce`
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
`AbortController`, `setTimeout`, and manual retry counting was replaced first
with an `Effect.gen` loop, and finally with `Effect.retry` driven by a named
Schedule policy: per-attempt `Effect.timeoutOption`, an exponentially increasing
delay starting at 10 ms with jitter, and a `while` predicate that retries only
transient transport failures.

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
const retryPolicy = Schedule.jittered(
  Schedule.exponential(10).pipe(Schedule.upTo({ times: 3 })),
);

const outcome = yield* client.probe(target).pipe(
  Effect.timeoutOption(target.timeout),
  Effect.flatMap((o) =>
    Option.isNone(o)
      ? Effect.fail(new TimeoutError({ timeout: String(target.timeout) }))
      : Effect.succeed(o.value)
  ),
  Effect.retry({ schedule: retryPolicy, while: isTransient }),
  Effect.match({
    onFailure: (e) => ({ tag: "failure" as const, error: e }),
    onSuccess: (v) => ({ tag: "success" as const, value: v }),
  }),
);
```

**Why:**
- The policy is a named value: attempt count, backoff shape, jitter, and the
  transient predicate are stated once instead of spread through control flow
- `Effect.timeoutOption` applies the configured timeout to each attempt
- Only DNS and timeout failures consume retry budget; permanent failures
  propagate immediately
- `TestClock` can prove the timing shape without real wall-clock waits

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
- `repo/CheckRepository.ts` — `CheckRepository`, `InMemoryLayer`
- `watch/StatusState.ts` — `StatusState`, `StatusStateLayer`
- `watch/Scheduler.ts` — `checkPipeline` resolves the three tags from the R channel

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
- Scheduler workflows declare their capabilities in the R channel and resolve
  them with `yield* ProbeClient` instead of receiving a services bag as an
  argument — dependencies become visible types, and the implementation choice
  moves to one wiring boundary
- Layers (`Layer.succeed`, `Layer.effect`) provide implementations for tests
  and composition
- Type-safe service resolution at the Effect level

---

## Pattern 8: `Promise.all` Parallelism → `Effect.forEach` with Bounded Concurrency

**What changed:** `Promise.all(array.map(async ...))` patterns were converted
to `Effect.forEach(array, ..., { concurrency: N })` where `N` comes from the
configured worker count.

**Files affected:**
- `watch/Scheduler.ts` — `runOnceEffect`, `watchLoopEffect`

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

## Pattern 13: Unconditional Retry → Selective Retry with `while`

**What changed:** `Effect.retry(Schedule.exponential(...).pipe(Schedule.upTo(...)))`
retries every error; the live probe path now uses
`Effect.retry({ schedule: ..., while: predicate })` so only transient transport
errors trigger retries. Permanent errors (`TargetDisabled`, `UnexpectedStatus`,
`InvalidBody`) fail immediately. The selective policy lives inside `probeOnce`
(see Pattern 5); a separate `probeOnceWithRetry` wrapper would have multiplied
the attempt budget, so it was removed.

**Files affected:**
- `probe/ProbeProgram.ts` — `probeOnce` (retry policy + `while` predicate)

**Before:**
```ts
// retries every failure, including permanent ones
Effect.retry(Schedule.exponential(10).pipe(Schedule.upTo({ times: 3 })))
```

**After:**
```ts
const isTransient = (error: DomainError) =>
  error._tag === "DnsError" || error._tag === "TimeoutError";

Effect.retry({
  schedule: Schedule.jittered(Schedule.exponential(10).pipe(Schedule.upTo({ times: 3 }))),
  while: isTransient,
})
```

**Why:**
- Only transient transport errors (DNS, timeout) are retried
- Permanent failures propagate immediately without wasting retry budget
- `while` predicate is evaluated per-error, enabling targeted recovery policy
- `Schedule.jittered` spreads retry storms as required by the contract

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
      HealthSchemaParseError: () => "invalid-response" as const,
      HealthBodyMismatch: () => "invalid-response" as const,
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

## Pattern 19: Whole-File Read → Incremental Line Stream with Fatal Decoding

**What changed:** History import loaded the entire file with `readFile(path, "utf8")`
and split it eagerly. It now consumes a line `Stream` sourced from a decoded
read stream, so a consumer taking a finite prefix (`Stream.take`) never reads
the remainder, and malformed UTF-8 fails as `HistoryReadError` instead of being
silently replacement-decoded.

**Files affected:**
- `services/DigestService.ts` — `historyLines`, `importHistoryEffect`

**Before:**
```ts
const text = yield* Effect.tryPromise({ try: () => readFile(path, "utf8"), ... });
const lines = text.split(/\r?\n/).filter((x) => x.trim());
yield* Stream.fromIterable(lines).pipe(/* decode pipeline */);
```

**After:**
```ts
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
    Stream.mapAccum(() => "", (pending, chunk) => {
      const parts = (pending + chunk).split(/\r?\n/);
      return [parts.pop() ?? "", parts] as const;
    }),
  );
```

**Why:**
- `readFile(path, "utf8")` replacement-decodes invalid byte sequences, hiding corruption
- `{ fatal: true }` turns malformed UTF-8 into a typed failure at the boundary
- `Stream.mapAccum` splits chunk boundaries safely and emits lines lazily
- Line numbering follows the SPEC: blanks are skipped without consuming a number

---

## Pattern 20: Plain Duration Storage → Versioned Duration Codec

**What changed:** The SQLite paths stored `duration` as a plain JSON number and
re-decoded it through the duration boundary, re-scaling persisted milliseconds
by 1000 on every read. A shared codec now encodes integer milliseconds as plain
numbers, sub-millisecond precision as tagged nanoseconds, and positive infinity
as a tagged encoding; decode accepts legacy numbers, all tagged encodings, and
fails unknown tags as `RepositoryError`.

**Files affected:**
- `repo/SqliteCheckRepository.ts` — `decodeDuration`, `encodeDuration`
- `domain/schema.ts` — `positive` accepts positive infinity (it can only arrive through the tagged decode)

**Before:**
```ts
// decode: persisted 42 (ms) re-scaled to 42000 by the duration boundary
new CheckResult({ ...x, checkedAt: new Date(x.checkedAt), ... });
// encode: JSON.stringify(c) — Infinity silently became null
```

**After:**
```ts
const decodeDuration = (x: unknown): number => {
  if (typeof x === "number") return x; // legacy numeric milliseconds
  if (x !== null && typeof x === "object" && "tag" in x) {
    const t = x as { tag: unknown; millis?: unknown; nanos?: unknown; direction?: unknown };
    if (t.tag === "millis" && typeof t.millis === "number") return t.millis;
    if (t.tag === "nanos" && Number.isSafeInteger(t.nanos)) return (t.nanos as number) / 1_000_000;
    if (t.tag === "infinity") {
      if (t.direction === "positive") return Number.POSITIVE_INFINITY;
      if (t.direction === "negative") return Number.NEGATIVE_INFINITY;
    }
  }
  throw new RepositoryError({ operation: "decodeDuration", cause: `unknown duration encoding: ${JSON.stringify(x)}` });
};
const encodeDuration = (n: number): number | Record<string, unknown> => {
  if (n === Number.POSITIVE_INFINITY) return { tag: "infinity", direction: "positive" };
  if (Number.isInteger(n)) return n;
  const nanos = n * 1_000_000;
  if (Number.isSafeInteger(nanos)) return { tag: "nanos", nanos };
  throw new RepositoryError({ operation: "saveCheck", cause: `duration ${String(n)} is not representable` });
};
```

**Why:**
- Round-trip stability: persisted values decode to the same duration they had when saved
- Nanosecond values round-trip exactly; unknown tags fail loudly instead of guessing
- Positive infinity satisfies the strictly-positive boundary; negative infinity does not

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
19. **History import** (`services/DigestService.ts`) — Incremental line stream with fatal UTF-8 decoding
20. **Duration persistence** (`repo/SqliteCheckRepository.ts`) — Versioned duration codec at the persistence boundary
21. **Schema classes** (`domain/schema.ts`) — Schema.Class domain with brands, transforms, and filters
22. **Typed repository services** (`repo/CheckRepository.ts`, `repo/SqliteCheckRepository.ts`) — Effect channels, atomic Ref state, Effect SQL transactions
23. **R-channel dependency injection** (`probe/ProbeProgram.ts`, `watch/Scheduler.ts`) — probeOnce resolves ProbeClient from the context
24. **Single configuration path** (`services/Config.ts`) — typed Config Effect with a Redacted secret
25. **Capability-based digest import** (`services/DigestService.ts`) — FileSystem capability, Sink aggregation, bounded decode concurrency
26. **Cache and batching** (`obs/DigestCache.ts`, `obs/TargetTagsResolver.ts`) — Cache.makeWith exit-based TTLs; grouped RequestResolver
27. **Queue scheduler and PubSub primitives** (`watch/Scheduler.ts`) — bounded queue with backpressure and Queue.end; scoped PubSub bus
28. **Platform API and CLI** (`http/api.ts`, `cli/cli.ts`, `bin.ts`) — HttpApi contract with generated OpenAPI; Command DSL; single process edge

---

## Phase 3: Full Effect-driven architecture (Patterns 21–28)

The final phase moved the migration from "Effect primitives where they fit"
to a fully Effect-driven architecture while keeping every behavioral contract
pinned by tests.

### Pattern 21: Hand-Validated Classes → `Schema.Class` Domain

**What changed:** The hand-written constructor checks were replaced by
schema-backed classes — `TargetConfig`, `Target`, `CheckResult`,
`CheckFailure`, `ResponseMetadata`, `Incident`, and the five classifications
become `Schema.Class`/`Schema.TaggedClass` values whose constructors validate
against one shared schema.

**Why:**
- Branded `TargetId`/`CheckId`/`IncidentId` fields; well-formed Unicode
  strings; lexical http(s) URL filter; trimmed non-empty names
- Durations are first-class `Duration` values from a strictly positive
  transform (bare numbers are milliseconds, unit strings use their unit);
  nanosecond precision is exact; positive infinity satisfies the boundary
- Accepted dates enforce calendar validity and the UTC year 0001–9999 range
- Incident windows keep their cross-field constraints as a struct filter
- The JSON Schema artifact derives from the classes, so the artifact and the
  decoder can never disagree

### Pattern 22: Promise-Shaped Repositories → Typed Services with One Decision

**What changed:** The repository shape declares typed channels — every method
returns `Effect<..., RepositoryError>`. The volatile implementation holds all
state in one atomic `Ref` (transitions serialize by construction), the SQLite
implementation runs on the Effect SQL client with `withTransaction`, and the
incident transition decision is a shared pure function so both repositories
keep identical semantics from one source. Event and outbox rows are written
inside the commit transaction; external delivery starts only after commit.

### Pattern 23: Parameter Injection → R-Channel Resolution

**What changed:** `probeOnce` declares `ProbeClient` as a Context requirement
instead of a parameter; the scheduler resolves repository services from the R
channel. Implementations are wired once at a boundary through Layers.

### Pattern 24: Dual Configuration Paths → One Typed Path

**What changed:** The sync env-parsing fallback is gone. Reading
configuration is an Effect built from the Config module — typed Duration
fields, bounded integer validation, and a `Redacted` secret as `Option`.

### Pattern 25: Hard-Wired Node APIs → Capabilities, Sinks, Bounds

**What changed:** History import consumes the replaceable `FileSystem`
capability through a fatal-decoding line stream, aggregates through a
`Sink`, and decodes rows with a bounded concurrency limit.

### Pattern 26: Repeated Lookups → `Cache` and `RequestResolver`

**What changed:** The digest cache runs on `Cache.makeWith` (single-flight,
bounded, exit-based TTLs: one minute for successes, one second for
failures). Metadata lookups go through a grouped `RequestResolver`, so
concurrent requests collapse into one batched call per window.

### Pattern 27: Hand-Rolled Coordination → `Queue` and `PubSub`

**What changed:** The scheduler is a real producer/consumer pipeline: a
bounded queue with capacity backpressure, a producer that signals completion
with `Queue.end`, and `workerCount` consumers draining until the Done signal.
`BulletinBus` and `WorkerBroadcast` are PubSub- and Queue-backed scoped
primitives.

### Pattern 28: Manual Surfaces → Platform Contracts

**What changed:** The HTTP API contract is expressed as `HttpApi` endpoints
with typed DTO schemas and a typed `ApiError`; the served OpenAPI artifact is
generated from the contract. The CLI is the `Command` DSL with
schema-validated arguments. `bin.ts` is the only process edge.
