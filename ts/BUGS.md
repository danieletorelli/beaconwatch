# BeaconWatch TypeScript Bug Report

This document catalogues bugs in the original BeaconWatch TypeScript implementation
identified during the Effect migration. Bugs are grouped by semantic category.

The reproduction ledger below is part of the report, not a list of hypothetical
concerns. Each entry gives a minimal observation against the original source
(`git show HEAD:<path>`), the expected result, and a proposed resolution. Run
the snippets from `beaconwatch/ts` after `npm ci`; where an entry is a static
finding rather than a runtime failure, the reproduction is an exact source or
type-check command and is marked accordingly. The original source is kept in
Git because the working tree contains the migrated implementation.

---

## 1. Never-Resolving Promises (Hang / Deadlock)

### 1.1 `TargetTagsBackend.loadMany` — Unknown targets produce a never-resolving promise

**File:** `src/obs/TargetTagsResolver.ts`
**Severity:** Critical

```ts
return x
  ? { ...x, tags: [...x.tags] }
  : new Promise<TargetMeta>(() => {});  // never resolves
```

When a target ID is not found in the backing map, a promise is created with an
empty executor that never calls `resolve` or `reject`. Any `await` on this
promise hangs the entire application.

**Fix:** Return `undefined` (later migrated to `Option.none()`).

### 1.2 `TelemetryExporter.shutdown` — Never-resolving promise

**File:** `src/obs/Telemetry.ts`
**Severity:** Critical

```ts
async shutdown() { await new Promise<void>(() => {}); }
```

The `shutdown` method creates a promise that never resolves. Since
`useTelemetryExporter` awaits `exporter.shutdown()`, the entire function hangs
after the work completes, leaking the caller's execution context.

**Fix:** Make `shutdown` synchronous (later migrated to a synchronous no-op).

### 1.3 `StatusBoard.snapshotDuringAbort` — Gate promise may never settle

**File:** `src/stm/StatusBoard.ts`
**Severity:** High

```ts
const gate = new Promise<void>((_, reject) => { rejectGate = reject; });
const write = board.openIncident(id, tag, () => gate);
```

The `gate` promise is only resolved via `rejectGate`. If `openIncident` calls
`afterTargetWrite` (the gate) but the abort signal never fires, the gate
remains pending. Since `openIncident` awaits the gate, the write never
completes, and `await write` hangs.

**Fix:** Restructured to use Effect's structured concurrency.

---

## 2. Logic Bugs

### 2.1 `repeatSuccessfulProbe` — Only executes once regardless of `repeats`

**File:** `src/probe/ProbeProgram.ts`
**Severity:** Critical

```ts
export const repeatSuccessfulProbe = async <A>(run: () => Promise<A>, repeats: number) => {
  return [await run()];  // ignores `repeats`, always runs once
};
```

The function is documented and typed to execute the probe `repeats` times, but
the implementation always executes exactly once. The `repeats` parameter is
silently ignored.

**Fix:** Implement actual loop (`Effect.forEach(Array.from({ length: repeats }), () => run)`).

### 2.2 `classifyProbe` — Throws instead of returning error for "operator-action"

**File:** `src/domain/values.ts`
**Severity:** High

```ts
if (d === "operator-action") throw i.failure;
```

The `classifyProbe` function returns `Result<Classification, DomainError>` for
all other error paths, but for the "operator-action" case it throws an exception
instead. This breaks the Result contract and forces callers to use try/catch
around a function that claims to be pure.

**Fix:** Return `Result.fail(i.failure)` consistently.

### 2.3 `sameIncident` — Uses reference equality instead of structural equality

**File:** `src/domain/values.ts`
**Severity:** Medium

```ts
export const sameIncident = (a: object, b: object) => a === b;
```

For domain objects that may be cloned (which `CheckRepository` does), reference
equality will report two structurally identical incidents as different. The
function name implies structural comparison.

**Fix:** Use `Equal.equals(a, b)` from Effect.

### 2.4 `classifyDomainError` — Unhandled error tags fall through to "operator-action"

**File:** `src/domain/classify-match.ts`
**Severity:** Medium

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

`RepositoryError`, `ConfigError`, `HistoryReadError`, and `ValidationError` are
in the `DomainError` union but not handled by the classification. They fall
through to the default `"operator-action"` disposition, which causes
`classifyProbe` to throw the error. These errors represent infrastructure
failures, not operator actions.

**Fix:** Handle all `DomainError` tags explicitly.

### 2.5 `durationMillis` — Number input treated as seconds, string input as milliseconds

**File:** `src/domain/schema.ts`
**Severity:** Medium

```ts
if (typeof input === "number") return input * 1_000;  // 5 → 5000ms (5 seconds)
// vs.
const match = /^\s*(-?\d+(?:\.\d+)?)\s*(ms|...)?\s*$/i.exec(input);
// default unit is "ms", so "5" → 5ms
```

`durationMillis(5)` returns `5000` (interpreted as 5 seconds), but
`durationMillis("5")` returns `5` (interpreted as 5 milliseconds). The
semantics differ based on the input type, which is confusing and error-prone.

**Fix:** Document the convention or unify the behavior.

### 2.6 `StatusBoard.retriedUpdate` — Version race between capture and increment

**File:** `src/stm/StatusBoard.ts`
**Severity:** Medium

```ts
const first = transaction();  // captures version = 0
version++;                     // now version = 1
if (!await first) await transaction();  // second transaction sees version = 1
```

The `version` is captured inside `transaction()` before `version++` executes.
The intent is to detect concurrent modifications, but since JavaScript is
single-threaded, the version is always incremented between the first and second
transaction. The retry logic may not detect actual concurrent modifications
correctly.

**Fix:** Restructured to use Effect's `Ref` for atomic state.

### 2.7 `probeOnce` — Classification failure path loses error context

**File:** `src/probe/ProbeProgram.ts`
**Severity:** Medium

```ts
if (!classified.ok) {
  failure = classified.error;
  classified = { ok: true, value: classified.error instanceof InvalidBody
    ? new InvalidResponse() : new Down() };
}
```

When `classifyProbe` returns a failure, the error is stored in `failure` and
the classification is overridden to `InvalidResponse` or `Down`. However, the
`failure` variable was already set to the probe transport error. This means the
classify-level error overwrites the transport-level error, losing diagnostic
information.

**Fix:** Restructured to use `Option` and clearer variable naming.

### 2.8 `Readiness.fail` — Does nothing, errors silently swallowed

**File:** `src/watch/StatusState.ts`
**Severity:** Medium

```ts
fail(_error: unknown) {}
```

The `fail` method accepts an error parameter but does nothing with it. If the
readiness check fails, the error is silently discarded. Callers waiting on
`wait()` will hang forever because `ready` is never set to `true` and `result`
is never set.

**Fix:** Migrated to `ReadinessEffect` using `Deferred.fail`.

### 2.9 `appConfig` — `telemetryEnabled` is always `true`

**File:** `src/services/Config.ts`
**Severity:** Medium

```ts
telemetryEnabled: Boolean(env.telemetryEnabled || env.TELEMETRY_ENABLED || true),
```

The `|| true` means `telemetryEnabled` is always `true`, regardless of the
environment variable. Setting `TELEMETRY_ENABLED=false` or
`telemetryEnabled=false` has no effect.

**Fix:** Use `??` instead of `||`: `Boolean(env.telemetryEnabled ?? env.TELEMETRY_ENABLED ?? false)`.

### 2.10 `appConfig` — `maxIncidents=0` is not possible

**File:** `src/services/Config.ts`
**Severity:** Low

```ts
maxIncidents: Number(env.maxIncidents || env.MAX_INCIDENTS || 100),
```

The `|| 100` means a value of `0` is treated as falsy and replaced with `100`.
Setting `MAX_INCIDENTS=0` has no effect.

**Fix:** Use `??` instead of `||`.

---

## 3. Resource Leaks

### 3.1 `HttpProbeClient.probe` — Timer not cleared on success

**File:** `src/services/HttpProbeClient.ts`
**Severity:** Medium

```ts
const own = new AbortController();
setTimeout(() => own.abort(), target.timeout);
```

The `setTimeout` creates a timer that calls `own.abort()` after the timeout.
If the probe succeeds before the timeout, the timer is never cleared. While
Node.js will eventually GC the timer, it keeps the `AbortController` and its
associated resources alive until the timer fires.

**Fix:** Clear timer in `finally` block (migrated to Effect's `Effect.sleep`).

### 3.2 `HttpProbeClient.probe` — Event listener not removed on success

**File:** `src/services/HttpProbeClient.ts`
**Severity:** Low

```ts
signal?.addEventListener("abort", abort, { once: true });
// ... probe completes successfully ...
// listener is NOT removed
```

The `abort` event listener is only removed in the `catch` block (via `finally`).
If the probe succeeds, the listener remains attached to the signal. Since it
uses `{ once: true }`, it will be auto-removed on the next abort, but if the
signal is never aborted, the listener leaks.

**Fix:** Moved `removeEventListener` to `finally` block.

### 3.3 `ProbeProgram.probeOnce` — Timer not cleared in finally

**File:** `src/probe/ProbeProgram.ts`
**Severity:** Low

```ts
const timer = setTimeout(() => ctl.abort(), target.timeout);
// ... in finally:
signal?.removeEventListener("abort", abort);
// timer is NOT cleared
```

The `setTimeout` timer is never cleared. If the probe succeeds, the timer
fires after `target.timeout` ms and calls `ctl.abort()` on an already-resolved
controller. This is harmless but wasteful.

**Fix:** Migrated to Effect's structured concurrency.

### 3.4 `probeOnce` — `sleep` ignores AbortSignal parameter

**File:** `src/probe/ProbeProgram.ts`
**Severity:** Low

```ts
const sleep = (ms: number, _s?: AbortSignal) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
```

The `_s` parameter is accepted but never used. The backoff sleep between
retry attempts cannot be cancelled via the abort signal, meaning the probe
continues retrying even after the caller signals abort.

**Fix:** Migrated to `Effect.sleep` which integrates with fiber interruption.

---

## 4. Fire-and-Forget / Lost Error Information

### 4.1 `IncidentService.acknowledge` — Discards promise result

**File:** `src/services/IncidentService.ts`
**Severity:** High

```ts
acknowledge(check: CheckResult) {
  void this.repo.applyCheck(check);  // discards the promise!
  return "acknowledged";
}
```

The `void` operator discards the promise returned by `applyCheck`. The method
returns `"acknowledged"` synchronously regardless of whether the operation
succeeds or fails. Callers have no way to know if the check was actually
applied.

**Fix:** Return `Effect.tryPromise` wrapping the operation.

### 4.2 `StatusBoard.openIncident` — `afterTargetWrite` callback error leaves state inconsistent

**File:** `src/stm/StatusBoard.ts`
**Severity:** Medium

```ts
async openIncident(id: TargetId, tag: string, afterTargetWrite?: () => Promise<void>) {
  await Promise.resolve();
  // ... modify state (remove old tag, set new tag) ...
  await afterTargetWrite?.();  // if this throws, bump(tag, 1) is skipped
  this.bump(tag, 1);           // tag count never incremented
}
```

If `afterTargetWrite` throws, `bump(tag, 1)` is never called, leaving the
tag count inconsistent. The `targets` map has the new tag, but `tags` count
doesn't reflect it. Subsequent snapshots will show incorrect degradation counts.

**Fix:** Restructured to use Effect's `Effect.gen` with proper error propagation.

### 4.3 `startWatching` — Fire-and-forget swallows watchLoop errors

**File:** `src/watch/Scheduler.ts`
**Severity:** Medium

```ts
export const startWatching = (...) => {
  const controller = new AbortController();
  void watchLoop(targets, options, s, controller.signal);  // discards promise
  return controller;
};
```

The `void` operator discards the promise from `watchLoop`. If `watchLoop` throws
(e.g., due to a repository error or probe failure), the error is silently
swallowed. The caller receives an `AbortController` but has no way to detect
that the watch loop has stopped.

**Fix:** Store the promise and expose error handling.

### 4.4 `withProbeSpan` — Span not updated on promise rejection

**File:** `src/obs/Telemetry.ts`
**Severity:** Low

```ts
export const withProbeSpan = async <A>(_id: TargetId, p: Promise<A>) => {
  const span = { name: "probe", start: Date.now(), end: undefined as number | undefined };
  metrics.spans.push(span);
  const value = await p;
  span.end = Date.now();  // only set on success
  return value;
};
```

If the promise `p` rejects, `span.end` is never set, leaving the span
permanently "open" in the metrics. The error is re-thrown (correct), but
the span data is incomplete.

**Fix:** Use `try/finally` to always set `span.end`.

---

## 5. Incorrect State / Invariant Violations

### 5.1 `TargetTagsBackend.loadMany` — Key lookup always uses first unique ID

**File:** `src/obs/TargetTagsResolver.ts`
**Severity:** High

```ts
const x = this.backing.get(id === unique[0] ? id : unique[0]!);
```

When looking up metadata for multiple IDs, the lookup always uses the first
unique ID for all IDs except the first one. This means different target IDs
incorrectly receive the same metadata. For example, if `unique = ["a", "b", "c"]`,
then "b" and "c" both look up "a"'s metadata.

**Fix:** Use `id` directly: `this.backing.get(id)`.

### 5.2 `SqliteCheckRepository.applyCheck` — Reloads entire database into memory on every call

**File:** `src/repo/SqliteCheckRepository.ts`
**Severity:** Medium

```ts
const targets = await this.listTargets();
const checks = await this.listChecks();
for (const t of targets) await this.memory.saveTarget(t);
for (const x of checks) await this.memory.saveCheck(x);
for (const r of this.db.prepare("select json from incidents").all() as Row[])
  await this.memory.saveIncident(this.incident(String(r.json)));
```

Every `applyCheck` call loads ALL targets, checks, and incidents from SQLite
into the in-memory repository. For a system with thousands of checks, this
is O(n) per probe cycle, which scales poorly.

**Fix:** Maintain the in-memory cache incrementally instead of reloading.

### 5.3 `nestedResources` — Release order is outer-before-inner

**File:** `src/repo/ConnectionPool.ts`
**Severity:** Low

```ts
await outer.release();
await inner.release();
```

Resources are released in acquisition order (outer first, then inner). The
standard pattern for resource management is LIFO (last-in, first-out): release
inner first, then outer. If the inner resource depends on the outer resource
(e.g., a transaction on a connection), releasing the outer first could cause
the inner release to fail.

**Fix:** Reverse the release order.

### 5.4 `ClientCache.invalidate` — Returns client to pool instead of discarding

**File:** `src/repo/ConnectionPool.ts`
**Severity:** Low

```ts
invalidate(client: ConnectionHandle) { this.release(client); }
```

The `invalidate` method calls `release`, which puts the client back in the
pool for reuse. "Invalidate" implies the client should be discarded (e.g.,
due to a broken connection), not recycled. A broken client returned to the
pool will be checked out again and fail.

**Fix:** Don't call `release` — just remove from active count without returning
to the pool.

---

## 6. Type Safety Issues

### 6.1 `schema.ts:Incident` — `Object.assign(this, input)` bypasses type checking

**File:** `src/domain/schema.ts`
**Severity:** Medium

```ts
constructor(input: { ... }) {
  Object.assign(this, input);  // copies ALL properties from input to this
  this.id = input.id;          // then re-assigns some properties
}
```

`Object.assign(this, input)` copies every property from `input` to `this`,
including properties that may not be in the constructor's type signature. This
bypasses TypeScript's type checking and could silently assign unexpected
properties at runtime.

**Fix:** Explicit field assignment.

### 6.2 `errors.ts:DomainError` — Missing `ValidationError`

**File:** `src/domain/errors.ts`
**Severity:** Low

The `DomainError` union type doesn't include `ValidationError`, which is a
domain error thrown by schema validation. This means `ValidationError` is
handled by generic `catch` blocks rather than type-safe error handling.

**Fix:** Added `ValidationError` to `DomainError` union.

### 6.3 `values.ts:Result` — Conflicts with Effect's `Result` type

**File:** `src/domain/values.ts`
**Severity:** Low

```ts
export type Result<A, E> = { ok: true; value: A } | { ok: false; error: E };
```

This hand-rolled `Result` type shadows Effect's `Result` type, causing
confusion when both are in scope. The hand-rolled version also lacks the
combinators (`map`, `flatMap`, `match`) that Effect's `Result` provides.

**Fix:** Re-export `Result` from Effect (`export type { Result } from "effect"`).

### 6.4 `defects.ts:exitKind` — Doesn't distinguish defect from interruption

**File:** `src/domain/defects.ts`
**Severity:** Low

```ts
export const exitKind = <A, E>(e: Exit<A, E>) =>
  e.ok ? "success" : "error";
```

The `Exit` type has three error kinds: "failure", "defect", and "interruption".
The `exitKind` function returns "error" for all of them, losing the
distinction. A defect (bug) should be handled differently from an interruption
(cancellation).

**Fix:** Return the specific `cause.kind` instead of a generic "error".

---

## 7. Incorrect Error Types

### 7.1 All schema validation errors throw generic `TypeError`

**File:** `src/domain/schema.ts`
**Severity:** Medium

```ts
if (!this.name) throw new TypeError("empty name");
// ...
throw new TypeError("invalid URL");
// ...
throw new TypeError("invalid method");
// ...
throw new TypeError("invalid statuses");
// ...
throw new TypeError("duration must be positive");
// ...
throw new TypeError("invalid status");
// ...
throw new TypeError("invalid bytes");
// ...
throw new TypeError("open incident has close time");
// ...
throw new TypeError("closed incident lacks close time");
// ...
throw new TypeError("close before open");
```

All validation errors throw generic `TypeError` instead of a domain-specific
error. This makes it impossible to distinguish validation failures from actual
JavaScript type errors in catch blocks.

**Fix:** Use `ValidationError` (added during migration).

### 7.2 `decodeHealthSchema` — Throws generic `TypeError`

**File:** `src/probe/ProbeProgram.ts`
**Severity:** Low

```ts
if (schema === null || typeof schema !== "object" || Array.isArray(schema))
  throw new TypeError("health schema must be an object");
```

Throws a generic `TypeError` instead of `InvalidBody`. Callers must use generic
`catch` blocks instead of typed error handling.

**Fix:** Return `Effect.fail(new InvalidBody({ ... }))`.

### 7.3 `MalformedHistoryRow` — Extends `Error` instead of `Data.TaggedError`

**File:** `src/services/DigestService.ts`
**Severity:** Low

```ts
export class MalformedHistoryRow extends Error {
  readonly _tag = "MalformedHistoryRow";
  constructor(readonly line: number, readonly reason: string) {
    super(reason);
  }
}
```

Manual `_tag` property instead of using Effect's `Data.TaggedError`. Misses
structural equality, serialization, and `catchTag` support. The constructor
also takes positional arguments instead of a single object, which is
inconsistent with the codebase convention.

**Fix:** `extends Data.TaggedError("MalformedHistoryRow")<{ line: number; reason: string }>`.

### 7.4 `IncidentSummaryError` — Same issue as 7.3

**File:** `src/services/IncidentSummarizer.ts`
**Severity:** Low

Same pattern as `MalformedHistoryRow`.

### 7.5 `durationMillis` — Throws generic `TypeError` for invalid input

**File:** `src/domain/schema.ts`
**Severity:** Low

```ts
if (!match) throw new TypeError("invalid duration");
```

**Fix:** Use `ValidationError`.

### 7.6 `targetId` — Throws generic `TypeError` for invalid input

**File:** `src/domain/schema.ts`
**Severity:** Low

```ts
if (typeof value !== "string" || !/^target_[a-z0-9][a-z0-9_-]*$/.test(value))
  throw new TypeError("invalid target id");
```

**Fix:** Use `ValidationError`.

---

## 8. Dead Code / Unused Definitions

### 8.1 `orderedDigestRows` — Exported but never imported

**File:** `src/services/DigestService.ts`
**Severity:** Low

The function is exported but never imported or used anywhere in the codebase.

### 8.2 `defects.ts:Exit` type and helper functions — Defined but never used

**File:** `src/domain/defects.ts`
**Severity:** Low

The `Exit` type, `exitKind`, and `firstTypedFailure` are defined but never
used anywhere in the codebase. They appear to be a hand-rolled version of
Effect's `Exit` type.

### 8.3 `policyDecision` — Defined but never used

**File:** `src/domain/classify-match.ts`
**Severity:** Low

```ts
export const policyDecision = (policy: { _tag: string }) => {
  switch (policy._tag) {
    case "Ignore": return "ignored";
    case "Escalate": return "escalated";
    default: return "accepted";
  }
};
```

The function is exported but never imported or used anywhere.

### 8.4 Telemetry helper functions — Defined but never used in core workflow

**File:** `src/obs/Telemetry.ts`
**Severity:** Low

`annotateTarget`, `annotateCheck`, `withProbeSpan`, `runTargetCheck`,
`withDigestSpan` are all exported but never imported by the core probe/scheduler
workflow. They appear to be instrumentation hooks for future use.

### 8.5 `validatePositiveInterval` — `async` function that never awaits

**File:** `src/domain/defects.ts`
**Severity:** Low

```ts
export const validatePositiveInterval = async (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new ConfigError({ reason: "interval must be positive" });
  return seconds;
};
```

Declared `async` but contains no `await`. Returns `Promise<number>` when it
could just return `number`. Unnecessary allocation.

### 8.6 `assertCheckInvariant` — `async` function that never awaits

**File:** `src/domain/defects.ts`
**Severity:** Low

Same issue as 8.5.

### 8.7 `decodeHistoryLine` — `async` function that never awaits

**File:** `src/services/DigestService.ts`
**Severity:** Low

```ts
export const decodeHistoryLine = async (line: string, lineNo: number) => {
```

Declared `async` but contains no `await`. Returns `Promise<x>` when it could
just return `x`.

### 8.8 `greet` — `async` function that never awaits

**File:** `src/smoke.ts`
**Severity:** Low

```ts
export const greet = async (name: string) => `hello ${name}`;
```

Returns `Promise<string>` when it could just return `string`.

### 8.9 `decodeTargetConfig` — `async` function that never awaits

**File:** `src/domain/schema.ts`
**Severity:** Low

```ts
export const decodeTargetConfig = async (input: unknown) =>
  new TargetConfig(input as TargetConfigInput);
```

Returns `Promise<TargetConfig>` when it could just return `TargetConfig`.

---

## 9. Fragile Patterns

### 9.1 `orderedDigestRows` — Completion order not guaranteed despite name

**File:** `src/services/DigestService.ts`
**Severity:** Low

```ts
export const orderedDigestRows = async <A>(rows: readonly A[], inspect: (row: A) => Promise<A>) => {
  const completionOrder: A[] = [];
  await Promise.all(rows.map(async (row) => completionOrder.push(await inspect(row))));
  return completionOrder;
};
```

The function name suggests rows are returned in order, but `Promise.all` doesn't
guarantee completion order. The `push` happens when each promise resolves, so
the result order depends on which `inspect` call finishes first.

---

## 10. API / HTTP Issues

### 10.1 `createApiHandler` — Incident ID validated after database lookup

**File:** `src/http/server.ts`
**Severity:** Low

```ts
const i = await repo.getIncident(id);        // DB lookup first
if (!incidentIdPattern.test(id))              // validation second
  return send(400, { message: "invalid incident id" });
```

The incident ID is validated after the database lookup. A request with an
invalid ID would query the database before returning a 400 error. The
validation should happen first.

### 10.2 `createApiHandler` — Error swallowed without logging

**File:** `src/http/server.ts`
**Severity:** Low

```ts
} catch {
  return send(500, { message: "internal server error" });
}
```

The catch block discards the error entirely. No logging, no error details.
In production, this makes debugging impossible.

### 10.3 `SqliteCheckRepository.incident` — JSON deserialization with `any` cast

**File:** `src/repo/SqliteCheckRepository.ts`
**Severity:** Low

```ts
private incident(s: string) {
  const x = JSON.parse(s) as any;
  return new Incident({ ...x, openedAt: new Date(x.openedAt), ... });
}
```

The `as any` cast bypasses all type checking. If the stored JSON has an
unexpected shape (e.g., after a schema migration), the constructor may throw
at runtime with an unhelpful error.

---

## 11. Concurrency / Async Issues

### 11.1 `StatusState.update` — Fake `await Promise.resolve()` yield point

**File:** `src/watch/StatusState.ts`
**Severity:** Low

```ts
async update(check: CheckResult, incident?: Incident) {
  // ...
  await Promise.resolve();  // yields to microtask, but no concurrency benefit
  this.state.set(check.targetId, copy({ latest: check, ... }));
}
```

The `await Promise.resolve()` yields to the microtask queue but provides no
real concurrency benefit. The method is `async` but doesn't need to be.

---

## 12. Additional Domain and Boundary Bugs

### 12.1 `CheckResult` accepts invalid IDs and timestamps

**File:** `src/domain/schema.ts`
**Severity:** High

`CheckResult` only brands `targetId`, converts `checkedAt` with `new Date`,
and never validates the check ID, timestamp validity, UTC year, or Unicode.

**Reproduction:** Construct a check with `id: ""` and `checkedAt: new Date("invalid")`.
It succeeds and stores an invalid date. The same probe works with lone-surrogate
IDs, despite the contract requiring well-formed Unicode check IDs.

**Resolution:** Validate ID and timestamp at the domain boundary; reject invalid
dates and enforce the documented year and Unicode constraints.

### 12.2 `Incident` accepts invalid identity, status, and string fields at runtime

**File:** `src/domain/schema.ts`
**Severity:** High

The constructor trusts the compile-time types. It does not validate the
`incident_` ID shape, status value, reason, latest check ID, or summary bounds.

**Reproduction:** Call the constructor through JavaScript or `as any` with
`id: "x"`, `status: "Bogus"`, and `latestCheckId: "\ud800"`; it constructs an
object successfully.

**Resolution:** Decode/validate runtime input with a schema and enforce the
`incident_` identity, Unicode, and summary contracts.

### 12.3 `TargetConfig` retains caller-owned mutable arrays

**File:** `src/domain/schema.ts`
**Severity:** High

`expectedStatus` and `tags` are assigned directly and the target is not frozen.
**Reproduction:** Construct a target with `const statuses = [200]`, mutate
`statuses[0] = 500`, and observe `target.expectedStatus[0] === 500`.
**Resolution:** copy arrays at construction and freeze immutable domain values.

### 12.4 `formatIncidentWindow` does not produce the specified timestamp format

**File:** `src/domain/values.ts`
**Severity:** Medium

`toLocaleString("sv-SE")` produces a local-looking `YYYY-MM-DD HH:mm:ss`
string without the requested numeric offset and does not guarantee the required
ISO timestamp representation.

**Reproduction:** Format a UTC incident and assert the result contains the
required numeric offset; the original output is `2026-01-01 00:00:00 – open`.

**Resolution:** use an explicit formatter that emits ISO timestamps with the
requested zone's numeric offset and preserves invalid-zone failures.

### 12.5 `targetJsonSchemaDocument` omits validation schemas for required fields

**File:** `src/domain/json-schema.ts`
**Severity:** Medium

The document requires `interval`, `timeout`, and `slowThreshold` but does not
define their properties, and omits `healthBodySchema` and `tags` entirely.
It therefore cannot validate the actual target boundary.

**Reproduction:** Validate a target containing `interval: {}`, `timeout: []`,
and `slowThreshold: null` against the exported document; the document does not
reject those values because their schemas are absent.

**Resolution:** define every field's type and constraints, or remove the
document until it is a complete boundary schema.

## 13. Additional Probe and Test-Double Bugs

### 13.1 `probeOnce` retries non-retryable failures

**File:** `src/probe/ProbeProgram.ts`
**Severity:** High

The loop retries every exception, although the contract permits retries only
for DNS and timeout failures.

**Reproduction:** Use a client that always throws `InvalidBody` and count calls;
the original makes four calls instead of one.

**Resolution:** retry only `DnsError` and `TimeoutError`; immediately classify
other failures.

### 13.2 `FakeProbeClient` delays ignore timeout and cancellation

**File:** `src/services/ProbeClient.ts`
**Severity:** High

The fake delay uses an uncancellable `setTimeout` and never observes the signal.
**Reproduction:** Probe a target with a 5 ms timeout using `slow(20)`; the call
does not fail at 5 ms and completes after roughly 20 ms.

**Resolution:** make fake delays use the application clock/signal and reject on
interruption or timeout.

### 13.3 String body `"not-json"` is incorrectly treated as malformed JSON

**File:** `src/probe/ProbeProgram.ts`
**Severity:** Medium

Without a health schema, the code uses `raw.body !== "not-json"` as a sentinel.
**Reproduction:** Return `{ status: 200, body: "not-json" }` from a client with
no configured schema; the result is `InvalidResponse` instead of `Up`.
**Resolution:** distinguish transport/parser failures from decoded values; do
not use a valid application value as a sentinel.

### 13.4 Out-of-range transport statuses crash response construction

**File:** `src/probe/ProbeProgram.ts`
**Severity:** High

The contract deliberately omits response metadata for statuses such as 600,
**Reproduction:** Return `{ status: 600, body: {} }` from a probe client; the
original throws `TypeError("invalid status")` rather than returning `Down` with
no status metadata.

**Resolution:** retain the unexpected-status failure while conditionally adding
only valid response metadata.

### 13.5 Health-schema failures lack the required error categories

**File:** `src/probe/ProbeProgram.ts`, `src/domain/errors.ts`
**Severity:** High

Invalid schema JSON, `$async` schemas, schema compilation failures, and valid
schemas that reject a body are collapsed into generic exceptions or `InvalidBody`.
The contract requires distinct `HealthSchemaParseError` and
`HealthBodyMismatch` categories.
**Reproduction:** Probe with an empty schema, `{ "$async": true }`, and a valid
schema that rejects `{}`; observe generic parse/Ajv failures or `InvalidBody`
with no required tag.

**Resolution:** compile synchronous Draft-7 schemas explicitly and map compile
failures and body mismatches to separate tagged errors.

### 13.6 Retry backoff has no jitter

**File:** `src/probe/ProbeProgram.ts`
**Severity:** Medium

The delays are exactly 10, 20, and 40 ms. The contract requires exponentially
increasing delays with jitter.

**Reproduction:** stub the timer and record delays across two failing probes;
the sequence is deterministic and identical every time.

**Resolution:** inject a clock/random source and add bounded jitter to each

### 13.7 `FakeProbeClient` accepts invalid scripts

**File:** `src/services/ProbeClient.ts`
**Severity:** Medium

Empty sequences and negative, fractional, or infinite `recover-after` counts
are accepted even though the test-support contract requires construction to
reject them.

**Reproduction:** Construct `new FakeProbeClient({ target_x: [] })` and
`recoverAfter(-1)`; both succeed, and the latter recovers immediately.

**Resolution:** validate scripts and recover counts in the constructor/helper.

### 13.8 HTTP probes do not send an `Accept: application/json` header

**File:** `src/services/HttpProbeClient.ts`
**Severity:** Low

The HTTP exchange asks for JSON but the fetch request contains no `Accept`
header.

**Reproduction:** Inject a fetcher that records its init object; `headers` is
absent.

**Resolution:** send an explicit JSON accept header while preserving configured

## 14. Additional Scheduler and Cancellation Bugs

### 14.1 Scheduler ignores queue capacity and worker count

**File:** `src/watch/Scheduler.ts`
**Severity:** Critical

`runOnce` creates one promise per active target with `Promise.all`; neither
`queueCapacity` nor `workerCount` bounds work.

**Reproduction:** Run ten targets with `workerCount: 1` and instrument the
client; all ten probes begin before any completes.

**Resolution:** implement a bounded queue and exactly `workerCount` workers;
propagate failure and cancellation to producers and siblings.

### 14.2 Scheduler accepts values outside documented limits

**File:** `src/watch/Scheduler.ts`
**Severity:** Medium

Validation checks only positive integers, not queue capacity ≤ 1,000,000 or
worker count ≤ 1,024.

**Reproduction:** `runOnce([], { queueCapacity: 1_000_001, workerCount: 1 })`
and the equivalent worker-count value complete instead of failing `ConfigError`.

**Resolution:** enforce both lower and upper bounds.

### 14.3 Empty `watchLoop` can become a busy loop

**File:** `src/watch/Scheduler.ts`
**Severity:** High

With no active targets, `Math.min(...[])` is `Infinity`; Node clamps an infinite
timer to a short delay, so the loop repeatedly runs an empty cycle.
**Reproduction:** Start `watchLoop([], validOptions, signal)` and count timer
callbacks; it continues instead of completing or waiting meaningfully.

**Resolution:** complete immediately for an empty active set, or make the loop
interruptible with an explicit lifecycle policy.

### 14.4 `watchLoop` schedules every target at the fastest interval

**File:** `src/watch/Scheduler.ts`
**Severity:** High

Each iteration probes all active targets, then waits for the minimum interval.
**Reproduction:** Run targets with 10 ms and 100 ms intervals and count calls
for 250 ms; the 100 ms target is probed approximately every 10 ms.

**Resolution:** schedule each target independently through the bounded queue.

### 14.5 Scheduler cancellation does not interrupt its wait timer

**File:** `src/watch/Scheduler.ts`
**Severity:** Medium

The interval timer is not connected to the signal and is never cleared. A
cancelled watch loop remains pending until the current delay ends.
**Reproduction:** Start a watch with a long interval, abort immediately, and

**Resolution:** race the timer with cancellation and clear it in finalization.

### 14.6 Worker failure does not cancel sibling work

**File:** `src/watch/Scheduler.ts`
**Severity:** High

`Promise.all` rejects when one worker fails, but other probes continue running
and may persist checks after the caller has already received the failure.
**Reproduction:** Make one client call reject and another block until released;
`runOnce` rejects while the second call remains active.

**Resolution:** supervise workers in a scope and interrupt siblings on the first
failure.

## 15. Additional Repository, Pool, and Resource Bugs

### 15.1 In-memory incident transitions are not serialized

**File:** `src/repo/CheckRepository.ts`
**Severity:** Critical

`applyCheck` awaits between checking for an open incident and saving one. Two
concurrent failures can both observe absence and open two incidents.

**Reproduction:** `Promise.all([repo.applyCheck(failureA), repo.applyCheck(failureB)])`
with a shared target can return two `Opened` transitions and leave two open
incidents.

**Resolution:** serialize transitions per repository/target or use an atomic
state primitive/transaction.

### 15.2 SQLite sends delivery events before commit

**File:** `src/repo/SqliteCheckRepository.ts`
**Severity:** Critical

`send(event.id)` runs inside the transaction before the outbox row and commit.
 A receiver can accept an event that is later rolled back, violating the
post-commit outbox contract.

**Reproduction:** In `send`, query `delivery_outbox`; the event is absent, and
make the subsequent insert/commit fail. The receiver was called despite no
committed outbox row.

**Resolution:** commit the incident event and outbox row first; deliver only in
`deliverPending` after commit.

### 15.3 SQLite check/incident transition is not atomic

**File:** `src/repo/SqliteCheckRepository.ts`
**Severity:** Critical

The memory transition, check save, incident save, and event work are separate
operations without one encompassing transaction. A failure between them leaves
partial state.

**Reproduction:** Force `send` or a later SQLite write to fail and inspect the
checks/incidents tables; earlier writes remain unless they were inside the
small event transaction.

**Resolution:** use one transaction for the persisted check, incident state,
and outbox row; update the in-memory projection only after commit.

### 15.4 SQLite malformed rows leak parser/type errors

**File:** `src/repo/SqliteCheckRepository.ts`
**Severity:** High

`listTargets`, `listChecks`, and incident reads call JSON parsing and domain
constructors directly. They do not map malformed data to `RepositoryError`.

**Reproduction:** Insert malformed JSON into `checks.json` and call
`listChecks()`; the caller receives `SyntaxError`, not `RepositoryError`.

**Resolution:** decode persisted rows inside a typed error boundary and fail the
whole read without partial results.

### 15.5 SQLite does not support the documented duration encodings

**File:** `src/repo/SqliteCheckRepository.ts`, `src/domain/schema.ts`
**Severity:** High

Persistence reconstructs `duration` as a plain number and does not decode tagged
millisecond/nanosecond or infinity encodings required by the contract.

**Reproduction:** Insert a check JSON row with a tagged duration object and call
`listChecks()`; `positive` receives an object and rejects it.

**Resolution:** define a versioned duration codec shared by both repositories.

### 15.6 Connection-pool work failures leak capacity

**File:** `src/repo/ConnectionPool.ts`
**Severity:** Critical

`active--` and waiter wake-up occur only after successful work and release.
Any rejection from `work`, `onAcquire`, or `onRelease` leaves the pool active
count elevated forever.

**Reproduction:** Use a pool of size one with work that rejects, then submit a
second work item; the second item remains pending indefinitely.

**Resolution:** release in `finally`, and combine/report release failures
without losing capacity cleanup.

### 15.7 Promise work starts before pool acquisition

**File:** `src/repo/ConnectionPool.ts`
**Severity:** High

The overload accepts a `Promise<A>`, but a promise is already running before
`withConnection` receives it. The pool cannot limit that work.

**Reproduction:** Call `pool.withConnection(blockingPromise)` while the pool is
full; the blocking operation starts before a handle is acquired.

**Resolution:** accept only a lazy `(handle) => Promise<A>` operation or rename
the overload to make its non-pooled semantics explicit.

### 15.8 `nestedResources` leaks on use and release failures

**File:** `src/repo/ConnectionPool.ts`
**Severity:** Critical

If use throws, neither resource is released. If outer release throws, inner
release is skipped. Both violate structured resource lifetime.

**Reproduction:** Call `nestedResources(events, { use: true })` and with
`{ outerRelease: true }`; event logs show missing release steps.

**Resolution:** acquire/release with nested `try/finally`, release inner before
outer, and preserve all failures.

## 16. Additional Runtime-Lifetime Bugs

### 16.1 Request cancellation does not interrupt child work

**File:** `src/runtime/ManagedRuntime.ts`
**Severity:** Critical

`runRequestChild` rejects the race when the parent signal aborts but never
aborts its child controller. The work continues after the request has finished.

**Reproduction:** Start work that waits on `child.signal`, abort the parent, and
observe that the work's signal is never aborted and its side effect still runs.

**Resolution:** forward parent cancellation to the child and remove the parent
listener in finalization.

### 16.2 `RequestRuntimeHost` leaks request runtimes

**File:** `src/runtime/ManagedRuntime.ts`
**Severity:** High

`handle` adds each runtime to a set but never removes or disposes it after the
request completes.

**Reproduction:** Call `handle` repeatedly with immediately resolved work and
inspect the private set through a cast; its size grows with every request.

**Resolution:** bracket each request runtime with acquisition/release and delete
it in `finally`.

### 16.3 Host shutdown does not dispose request runtimes

**File:** `src/runtime/ManagedRuntime.ts`
**Severity:** High

`RequestRuntimeHost.shutdown()` disposes only the process-global `runtime`, not
any runtime stored in `runtimes`.

**Reproduction:** Handle a request, call `shutdown()`, and inspect
`ManagedAppRuntime.released`; the request runtime is not released.

**Resolution:** interrupt/drain and dispose every owned request runtime before
returning from shutdown.

## 17. Additional Cache and History Bugs

### 17.1 `DigestCache.getByIdentity` never hits its cache

**File:** `src/obs/DigestCache.ts`
**Severity:** High

It creates a fresh object key on every call, so the identity map can never find
an earlier entry and grows without bound.

**Reproduction:** Call `getByIdentity("target_x")` twice; `compute` runs twice.

**Resolution:** key by the stable target identity or remove this unused cache.

### 17.2 `DigestCache.invalidate` deletes the wrong key

**File:** `src/obs/DigestCache.ts`
**Severity:** High

`get` stores `digest:${id.toLowerCase()}` but `invalidate` deletes only the raw
ID, so cached values remain after invalidation.

**Reproduction:** Get a value, invalidate it, get again, and count compute calls;
the second get is served from cache.

**Resolution:** centralize key construction and delete the exact cache key.

### 17.3 `DigestCache.getConcurrent` does not deduplicate and ignores expiry

**File:** `src/obs/DigestCache.ts`
**Severity:** High

Concurrent misses each run `compute`, and any existing entry is returned without
checking `expires`, so an expired value is served forever through this method.

**Reproduction:** Start two unresolved `getConcurrent` calls; `compute` runs
twice. Advance time past TTL and call again; the old value is still returned.

**Resolution:** store the in-flight promise before awaiting and apply TTL checks
consistently.

### 17.4 Failed digest computations use the success TTL

**File:** `src/obs/DigestCache.ts`
**Severity:** Medium

Rejected promises remain cached for the full `ttl` (default one minute), while
the contract requires a one-second failure TTL followed by recomputation.

**Reproduction:** Use a compute function that rejects, call `get` after 2 ms and
observe the same rejection without another compute attempt.

**Resolution:** record success and failure expiry separately and replace/remove
failed entries after the failure TTL.

### 17.5 History import reads the entire file eagerly

**File:** `src/services/DigestService.ts`
**Severity:** High

`readFile` and `split` load the entire history before decoding; finite consumers
cannot stop after a prefix and large files require proportional memory.

**Reproduction:** Supply a large file or a stream-like file capability and
observe that `importHistory` has no incremental read boundary.

**Resolution:** consume a UTF-8 line stream incrementally with bounded decode
concurrency.

### 17.6 History import silently replacement-decodes invalid UTF-8

**File:** `src/services/DigestService.ts`
**Severity:** High

`readFile(path, "utf8")` uses replacement decoding, so malformed byte sequences
become `�` rather than producing `HistoryReadError`.

**Reproduction:** Write a file containing byte `0xff` and import it; the
original does not fail at file-read level.

**Resolution:** decode with a fatal UTF-8 decoder and map the failure to
`HistoryReadError`.

### 17.7 History row decoding is unbounded

**File:** `src/services/DigestService.ts`
**Severity:** Medium

`Promise.all` starts one decode task per nonblank line, ignoring the documented
concurrency limit of eight.

**Reproduction:** Import a file with thousands of rows and instrument
`decodeHistoryLine`; all mapped promises are created immediately.

**Resolution:** use a bounded worker pool of eight or a streaming decoder.

### 17.8 History validation accepts malformed rows

**File:** `src/services/DigestService.ts`
**Severity:** Critical

`decodeHistoryLine` checks only four shallow properties. It accepts invalid
dates, malformed target IDs, missing response objects, non-finite/out-of-range
durations, invalid statuses/bytes, lone surrogates, and non-RFC3339 dates.

**Reproduction:** Decode a row with `checkedAt: "nope"`, missing `response`, or
`durationMillis: 1e309`; invalid data is accepted or fails later with the wrong
error category.

**Resolution:** use one complete row schema matching the history contract before
constructing a `CheckResult`.

### 17.9 `importHistory` misclassifies conversion errors

**File:** `src/services/DigestService.ts`
**Severity:** Critical

The catch around `toCheck` casts every error to `MalformedHistoryRow`. A
`TypeError` from `targetId` or `ResponseMetadata` is not an instance of that
class, so `digestFromStream` treats it as a check and can crash on `row.id` or
`row.targetId`.

**Reproduction:** Import a syntactically valid row with `targetId: "bad"`; the
original fails during digest aggregation instead of returning one malformed row.

**Resolution:** convert every row conversion failure to a real structured
`MalformedHistoryRow` carrying the filtered line number.

## 18. Additional Status and Observability Bugs

### 18.1 `StatusState.update` can let an older check overwrite a newer one

**File:** `src/watch/StatusState.ts`
**Severity:** High

The ordering check occurs before an async yield. Two updates can both pass
against the same old state, then commit in the opposite order.

**Reproduction:** Start a newer update, start an older update before the first
continuation resumes, and schedule the older continuation last; the snapshot
contains the older check.

**Resolution:** perform compare-and-set atomically with a Ref/STM primitive.

### 18.2 `Readiness.reset` preserves the previous generation's result

**File:** `src/watch/StatusState.ts`
**Severity:** High

`reset()` clears only `ready`. `runGeneration` sees the old `result` and returns
it without waiting for or recording the new generation.

**Reproduction:** Complete with `"old"`, call `reset()`, then
`runGeneration("new")`; it returns `"old"`.

**Resolution:** reset the result/error state and use a generation-scoped
Deferred rather than polling mutable fields.

### 18.3 `recordCheckMetrics` leaks the active gauge on failure

**File:** `src/obs/Telemetry.ts`
**Severity:** High

`metrics.active--` is after the awaited callback, not in `finally`.

**Reproduction:** Call `recordCheckMetrics(check, async () => { throw new Error() })`
and observe `metrics.active` remains incremented.

**Resolution:** decrement in unconditional finalization and record failure status.

### 18.4 `runTargetCheck` leaves spans open on load or probe failure

**File:** `src/obs/Telemetry.ts`
**Severity:** Medium

The local `flat` helper closes spans only after successful work.

**Reproduction:** Reject `load` or `probe` and inspect `metrics.spans`; the
corresponding span has no `end`.

**Resolution:** close spans and record failure in `finally`.

### 18.5 Temporary log-level override is not restored on failure

**File:** `src/obs/references.ts`
**Severity:** High

`withMinimumLogLevel` restores the global level only after successful work.

**Reproduction:** Reject `work`, then call `fiberLocalMinimumLogLevelDemo()`;
its `before` and `after` levels remain `Debug` instead of the original level.

**Resolution:** restore in `finally`; use fiber-local state if concurrent
overrides must be isolated.

## 19. Additional API and Error-Mapping Bugs

### 19.1 API repository failures violate stable error messages

**File:** `src/http/server.ts`
**Severity:** Medium

All repository failures are caught by one generic handler returning
`internal server error`, while the contract requires route-specific stable
messages such as `failed to list targets` and `failed to read incident`.

**Reproduction:** Make each repository method reject and request its route; every
route returns the same message.

**Resolution:** catch/map repository errors per route while keeping causes out
of the public response.

## 20. Additional Recovery and Configuration Bugs

### 20.1 `recoverTransientProbe` recovers non-transient failures

**File:** `src/services/RecoveryPolicy.ts`
**Severity:** High

The recovery helper catches every rejection and casts it to `DnsError | TimeoutError`.
It can therefore turn `InvalidBody`, `UnexpectedStatus`, or programmer errors
into a successful fallback, contrary to the policy contract.

**Reproduction:** Call `recoverTransientProbe(Promise.reject(new Error("bug")), fallback)`;
the fallback is invoked even though the error is not a DNS or timeout failure.

**Resolution:** inspect the error tag and invoke the fallback only for
`DnsError` and `TimeoutError`; rethrow every other failure unchanged.

### 20.2 `appConfig` accepts a missing poll interval as `NaN`

**File:** `src/services/Config.ts`
**Severity:** High

The configuration checks `pollInterval <= 0` but never checks finiteness. A
missing or non-numeric poll interval becomes `NaN`, and comparisons with `NaN`
are false.

**Reproduction:** Call `appConfig({ probeTimeout: 1, slowThreshold: 1,
workerConcurrency: 1 })`; it returns a config whose `pollInterval` is `NaN`.

**Resolution:** require a finite positive value and reject missing fields before
constructing the configuration.

### 20.3 `appConfig` partially parses malformed poll intervals

**File:** `src/services/Config.ts`
**Severity:** Medium

`parseInt` accepts a valid prefix and ignores trailing junk.

**Reproduction:** Call `appConfig({ pollInterval: "10 bananas", probeTimeout: 1,
slowThreshold: 1, workerConcurrency: 1 })`; it accepts `pollInterval: 10`.

**Resolution:** parse the complete duration string with the same strict duration
decoder used for the other fields.

---

## Reproduction and Resolution Ledger

The following ledger gives a concrete check for the original entries. The
additional entries in sections 12–19 contain their reproduction and resolution
inline. For runtime entries, evaluate the shown expression in a temporary test
copied from the original revision (`git show HEAD:<file>`). For source/type
entries, the command itself is the reproducible check.

To execute the original modules without changing the working tree, export the
baseline to a temporary directory and compile it before running a probe:

```sh
rm -rf /tmp/beaconwatch-original && mkdir -p /tmp/beaconwatch-original
git archive HEAD beaconwatch/ts | tar -x --strip-components=2 -C /tmp/beaconwatch-original
docker run --rm -v /tmp/beaconwatch-original:/workspace -w /workspace node:22-slim \
  bash -c 'npm ci && npx tsc && node --input-type=module ./repro.mjs'
```

The runtime probes listed below were checked against that exported baseline;
the current migrated implementation is intentionally expected not to exhibit
the confirmed runtime failures.

### 1.1–1.3 Never-resolving promises

- **1.1 — confirmed.** Create `new TargetTagsBackend(new Map()).loadMany([targetId("target_missing")])`; race the returned promise with a timer such as `Promise.race([p, new Promise(r => setTimeout(() => r("timeout"), 20))])`. The timer wins because the original promise remains pending. **Resolution:** return `undefined`/`Option.none()` for a missing key and make `loadMany`’s result type express absence.
- **1.2 — confirmed.** Run `Promise.race([useTelemetryExporter(new TelemetryExporter(), async () => "ok"), new Promise(r => setTimeout(() => r("timeout"), 20))])`; the timeout wins because the original exporter path never settles. **Resolution:** make shutdown a completed effect/no-op, or await a real flush with a bounded failure path.
- **1.3 — confirmed.** Call `snapshotDuringAbort(board, id, "down", new AbortController().signal)` and do not abort the controller. The original function waits forever at the gate. **Resolution:** use scoped interruption/racing; never create a gate without a guaranteed completion or cancellation path.

### 2.1–2.10 Logic

- **2.1 — confirmed.** Set `calls = 0`, call original `repeatSuccessfulProbe(async () => ++calls, 3)`, and assert `calls === 1` and result length `=== 1`; both fail the documented contract. **Resolution:** iterate exactly `repeats` times and define behavior for zero/negative counts.
- **2.2 — confirmed.** Supply a probe input whose disposition is `"operator-action"`; original `classifyProbe` throws, while its other branches return a failed `Result`. **Resolution:** return `Result.fail(i.failure)` consistently and test every disposition.
- **2.3 — confirmed.** Construct two separately allocated but equal incidents and call original `sameIncident(a, b)`; it returns `false` because `a !== b`. **Resolution:** use structural domain equality (`Equal.equals`) or compare the documented identity fields.
- **2.4 — confirmed.** Call original `classifyDomainError(new RepositoryError(...))`, `ConfigError`, and `HistoryReadError`; each returns `"operator-action"` because the tags are not matched. `ValidationError` was introduced during migration and has no original constructor, so it is not part of this runtime reproduction. **Resolution:** exhaustively classify the union, or make the fallback explicit and tested.
- **2.5 — confirmed.** Evaluate original `durationMillis(5)` and `durationMillis("5")`; results are `5000` and `5`. **Resolution:** choose one default unit and apply it consistently, or reject unitless strings.
- **2.6 — confirmed as an algorithmic flaw.** Instrument `notify` and call `retriedUpdate`; the function increments `version` immediately after starting the first transaction, so the first transaction observes a manufactured conflict even without a concurrent writer. **Resolution:** replace optimistic local state with an atomic Effect `Ref`/STM operation.
- **2.7 — confirmed.** Make `classifyProbe` return a failure after the transport failure has already populated `failure`; original `probeOnce` overwrites the transport error with the classification error. **Resolution:** keep transport and classification failures separate, then choose the documented primary failure.
- **2.8 — confirmed.** Call original `new Readiness().fail(new Error("x"))`, then race `wait()` against a timeout; `wait()` remains pending. **Resolution:** complete the readiness primitive with a typed failure (`Deferred.fail`) and reset both success/failure state.
- **2.9 — confirmed.** Call `appConfig({ workerConcurrency: 1, telemetryEnabled: false, ...validDurations })`; original `telemetryEnabled` is `true` because of `|| true`. **Resolution:** parse booleans explicitly and use nullish/default semantics without a trailing `|| true`.
- **2.10 — confirmed.** Call `appConfig({ maxIncidents: 0, workerConcurrency: 1, ...validDurations })`; original result is `100`. **Resolution:** use `??` after validating the supplied numeric value.

### 3.1–3.4 Resource and cancellation issues

- **3.1 — confirmed by source/instrumentation.** Stub `setTimeout` and call original `HttpProbeClient.probe` with a fetch that resolves immediately; the timer callback remains registered after the promise resolves. **Resolution:** retain the timer handle and clear it in `finally`, or use a scoped timeout effect.
- **3.2 — confirmed by source/instrumentation.** Use an `AbortSignal` spy that counts `addEventListener`/`removeEventListener`, run the successful original probe, and observe that the success path leaves the listener attached. **Resolution:** remove the listener in unconditional cleanup.
- **3.3 — confirmed by source/instrumentation.** Stub `setTimeout`, run original `probeOnce` with a successful client, and inspect the scheduled callbacks after return; the timeout callback was not cleared. **Resolution:** clear the timer in `finally` or use structured timeout ownership.
- **3.4 — confirmed.** Pass an already-aborted signal to original `sleep`/the retry path; the plain `setTimeout` promise does not settle until its delay expires. **Resolution:** make backoff interruptible with the caller’s signal/effect fiber.

### 4.1–4.4 Fire-and-forget and telemetry

- **4.1 — confirmed.** Give original `acknowledge` a repository whose `applyCheck` returns `Promise.reject(new Error("write failed"))`; `acknowledge` immediately returns `"acknowledged"` and loses the rejection. **Resolution:** return/await the repository effect and expose its error channel.
- **4.2 — confirmed.** Call original `openIncident` with an `afterTargetWrite` callback that rejects, then inspect `snapshot()`; the target write occurred but the tag count was not incremented. **Resolution:** make the state update transactional or compensate on callback failure; propagate the failure.
- **4.3 — confirmed.** Make `watchLoop` reject on its first repository operation, call `startWatching`, and attach an `unhandledRejection` listener; the returned controller gives no completion/error signal. **Resolution:** return a fiber/promise handle and supervise its failure.
- **4.4 — confirmed.** Call original `withProbeSpan("target_x", Promise.reject(new Error("x")))`; the promise rejects while the inserted span has `end === undefined`. **Resolution:** set span completion/status in `finally`.

### 5.1–5.4 State and repository invariants

- **5.1 — confirmed.** Load two IDs from a map containing distinct metadata; original `loadMany([a, b])` returns `a`’s metadata twice because non-first IDs use `unique[0]`. **Resolution:** look up each `id` directly and test distinct IDs.
- **5.2 — confirmed performance behavior.** Populate SQLite with `n` checks, instrument `listChecks`/`listTargets`, and call original `applyCheck` twice; each call reloads all rows, giving O(n) work per check. **Resolution:** update the memory projection incrementally or remove it from the write path.
- **5.3 — confirmed.** Call original `nestedResources(events)` and assert the event order; it is `acquire-outer, acquire-inner, use, release-outer, release-inner`, not LIFO. **Resolution:** release inner before outer and preserve both releases with `try/finally`/cause combination.
- **5.4 — confirmed semantic defect.** `const c = cache.checkout(); cache.invalidate(c); const d = cache.checkout()` returns the same handle in the original implementation. **Resolution:** destroy/drop invalid handles and wake/replace capacity separately from normal release.

### 6.1–6.4 Type and boundary safety

- **6.1 — confirmed.** Construct original `Incident` with an extra enumerable property and inspect it; `Object.assign` copies the property even though it is absent from the constructor contract. **Resolution:** assign only declared fields.
- **6.2 — confirmed by type inspection.** Run `git show HEAD:beaconwatch/ts/src/domain/errors.ts | rg 'ValidationError|DomainError'`; the original union omits the validation error. **Resolution:** include every thrown domain error in the union and compile a `catch`/classification probe.
- **6.3 — confirmed by source inspection.** Run `rg 'type Result|from "effect"'` against the original values module; it defines a local Result rather than using Effect’s API. **Resolution:** use/re-export the pinned Effect `Result` and add a type-level combinator probe.
- **6.4 — confirmed.** Evaluate original `exitKind({ ok: false, cause: { kind: "defect", defect: new Error() } })` and the interruption variant; both return `"error"`. **Resolution:** preserve the cause kind (`failure`, `defect`, `interruption`).

### 7.1–7.6 Error representation

- **7.1 — confirmed.** Construct each invalid `TargetConfig`, `ResponseMetadata`, `CheckResult`, and `Incident` case from the original module and inspect `error.constructor.name`; validation failures are generic `TypeError`, not the domain validation tag. **Resolution:** throw/return `ValidationError` consistently.
- **7.2 — confirmed.** Call original `decodeHealthSchema("[]")`; it throws `TypeError("health schema must be an object")` instead of the probe’s typed invalid-body error. **Resolution:** return/fail with `InvalidBody`.
- **7.3 — confirmed by API probe.** Instantiate original `new MalformedHistoryRow(1, "bad")`; it has a manually assigned `_tag` and positional constructor, not the project’s `Data.TaggedError` convention. **Resolution:** migrate to `Data.TaggedError` and object construction.
- **7.4 — confirmed by source/API probe.** Instantiate original `IncidentSummaryError` and inspect its prototype and constructor signature; it has the same manual Error pattern. **Resolution:** use `Data.TaggedError` with structured fields.
- **7.5 — confirmed.** Call original `durationMillis("not-a-duration")`; it throws generic `TypeError`. **Resolution:** use `ValidationError` (or an explicit Result/Effect failure).
- **7.6 — confirmed.** Call original `targetId("not-a-target")`; it throws generic `TypeError`. **Resolution:** use the domain validation error and document the throwing-validator API.

### 8.1–8.9 Dead code and unnecessary async

- **8.1 — confirmed statically.** Run `rg 'orderedDigestRows' src test`; only its declaration is found. **Resolution:** delete it or add a real caller/test; do not export unused API.
- **8.2 — confirmed statically.** Run `rg 'exitKind|firstTypedFailure|Exit' src test`; only declarations/usages within the helper file are found. **Resolution:** remove the duplicate Exit abstraction or replace it with Effect `Exit` and use it.
- **8.3 — confirmed statically.** Run `rg 'policyDecision' src test`; only the declaration is found. **Resolution:** delete it or cover and use it in policy handling.
- **8.4 — confirmed statically.** Run `rg 'annotateTarget|annotateCheck|withProbeSpan|runTargetCheck|withDigestSpan' src test`; no core workflow imports them. **Resolution:** wire them into the workflow or remove the unused hooks.
- **8.5 — confirmed statically.** Run `rg -n 'async.*validatePositiveInterval'` and `tsc --noEmit`; the function has no `await` and unnecessarily returns a promise. **Resolution:** make it synchronous or return an explicit Effect.
- **8.6 — confirmed statically.** Run the same check for `assertCheckInvariant`; no `await` exists. **Resolution:** make it synchronous or model the failure explicitly.
- **8.7 — confirmed statically.** Run the same check for `decodeHistoryLine`; its body has no `await`. **Resolution:** make decoding synchronous, or return an Effect if parsing is intentionally fallible.
- **8.8 — confirmed statically.** Run the same check for `greet`; it returns a string wrapped only by `async`. **Resolution:** return `string` directly.
- **8.9 — confirmed statically.** Run the same check for `decodeTargetConfig`; the original function only constructs synchronously and casts input to the constructor type. **Resolution:** make it synchronous and validate input through a schema/Effect.

### 9.1 Fragile patterns

- **9.1 — confirmed.** Call original `orderedDigestRows([1, 2], async n => { await delay(3 - n); return n })`; result is `[2, 1]`, proving completion order rather than input order. **Resolution:** use `Promise.all(rows.map(inspect))` or rename the function to state completion ordering.

### 10.1–10.3 HTTP and persistence boundaries

- **10.1 — confirmed.** Send `GET /incidents/not-valid` to the original handler using a repository spy; `getIncident("not-valid")` is called before the 400 response. **Resolution:** validate/decode the ID before any repository call.
- **10.2 — confirmed observability issue.** Make `listTargets()` reject and capture the process logger; original handler returns 500 without logging the caught error. **Resolution:** log a structured internal error while keeping response details generic.
- **10.3 — confirmed boundary weakness.** Put malformed JSON (for example `{ "closedAt": {} }`) in the original incident row and call `getIncident`; the `any` cast defers failure to the constructor/runtime. **Resolution:** decode persisted JSON with a schema and return a typed repository error.

### 11.1 Concurrency and async issues

- **11.1 — confirmed as unnecessary async.** Static inspection plus `await update(...)` shows the only yield is `Promise.resolve`; the method can be synchronous for the current map implementation. **Resolution:** remove the fake yield or replace the map with an explicitly synchronized state abstraction.

## Summary

| Category | Count | Severity Range |
|----------|-------|---------------|
| 1. Never-resolving promises | 3 | Critical–High |
| 2. Logic bugs | 10 | Critical–Low |
| 3. Resource leaks | 4 | Medium–Low |
| 4. Fire-and-forget / lost errors | 4 | High–Low |
| 5. Incorrect state / invariant violations | 4 | High–Low |
| 6. Type safety issues | 4 | Medium–Low |
| 7. Incorrect error types | 6 | Medium–Low |
| 8. Dead code / unused | 9 | Low |
| 9. Fragile patterns | 1 | Low |
| 10. API / HTTP issues | 3 | Low |
| 11. Concurrency / async issues | 1 | Low |
| 12. Additional domain/boundary bugs | 5 | High–Medium |
| 13. Additional probe/test-double bugs | 8 | Critical–Low |
| 14. Additional scheduler bugs | 6 | Critical–Medium |
| 15. Additional repository/resource bugs | 8 | Critical–High |
| 16. Additional runtime-lifetime bugs | 3 | Critical–High |
| 17. Additional cache/history bugs | 9 | Critical–Medium |
| 18. Additional status/observability bugs | 5 | High–Medium |
| 19. Additional API/error-mapping bugs | 1 | Medium |
| 20. Additional recovery/configuration bugs | 3 | High–Medium |
| **Total** | **97** | |

All 97 entries are now either runtime-reproduced against the original baseline
or directly reproduced by source/type-boundary probes documented in their
entry. Duplicate or unconfirmed findings from the prior audit were removed.
