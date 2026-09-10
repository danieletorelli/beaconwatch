# BeaconWatch behavioral specification

## 1. Scope and conformance

BeaconWatch is a proof-of-concept HTTP endpoint monitor. This document specifies
observable behavior, independently of implementation technique. It covers the
domain boundary, probing, check and incident persistence, scheduling, status
views, history digests, command and HTTP surfaces, operational metadata, and
resource lifetime.

The individually callable capabilities below are contracts even where the
proof-of-concept executable does not compose them into one daemon. A conforming
replacement may use different storage, concurrency, HTTP, or serialization
libraries, provided it preserves these behaviors.

## 2. Domain values and validation

### 2.1 Targets

A target has:

| Field | Contract |
|---|---|
| `id` | A string matching `^target_[a-z0-9][a-z0-9_-]*$`. Matching is against the whole input. |
| `name` | Decoded boundary text is trimmed and must then be non-empty. Type-side/class construction requires already-trimmed, non-empty text. |
| `url` | An absolute `http:` or `https:` URL with a non-empty hostname. Scheme matching is ASCII case-insensitive; raw control/whitespace characters, backslashes, and malformed lexical schemes are rejected before WHATWG URL parsing. |
| `method` | Exactly `GET`, `POST`, or `HEAD`. |
| `expectedStatus` | A non-empty list of integer HTTP status codes from 100 through 599. |
| `interval` | A strictly positive duration; positive sub-millisecond durations are valid. |
| `timeout` | A strictly positive duration. |
| `slowThreshold` | A strictly positive duration. |
| `healthBodySchema` | Optional text containing a JSON Schema. Presence is significant: an empty string is an invalid configured schema, not absence. |
| `tags` | Optional string list. No uniqueness, normalization, or vocabulary is imposed. |
| `enabled` | Required for a stored target. Target configurations used directly by a one-shot probe may omit it and are treated as enabled. |

Invalid boundary data is rejected rather than repaired, except for target-name
trimming. In particular, fractional status codes, malformed URLs, trailing
characters in IDs, and zero or negative durations are rejected.

### 2.2 Checks

A check contains a well-formed Unicode string ID (no unpaired surrogates), target ID, valid timestamp whose UTC year is 0001–9999, strictly positive
duration, classification, optional well-formed Unicode failure reason, and response metadata.
Classifications are `Up`, `Slow`, `Down`, `InvalidResponse`, and `Unknown`.
Response status, when present, is an integer from 100 through 599. Response byte
count, when present, is a non-negative safe integer.

Generated check IDs begin with `check_` and are unique, including for concurrent
checks completing at the same clock instant. Recovered/degraded checks begin
with `degraded_` and are likewise unique.

### 2.3 Incidents

An incident contains an `incident_` ID satisfying the target-style ASCII suffix rules, target ID, opening time, optional closing time (each timestamp has UTC year 0001–9999),
`Open` or `Closed` status, reason, latest check ID, and optional summary.
Latest check IDs, reasons, and summaries are well-formed Unicode strings; lone
surrogates are rejected at their domain boundaries.

The following invariants always hold:

- an open incident has no closing time;
- a closed incident has a closing time;
- closing time is not before opening time;
- summaries, when produced by the summarization boundary, contain 1–240
  UTF-16 code units.

Incident windows are rendered as ISO timestamps with numeric offsets in the
requested named time zone, separated by ` – `. An open end is rendered as
`open`. An invalid time-zone request is not silently replaced with a default.

## 3. Probe behavior

### 3.1 HTTP exchange

The probe sends the configured method to the configured URL and asks for JSON.
The transport's HTTP status is authoritative; a `status` property in the body
cannot override it.

- A status outside `expectedStatus` fails as `UnexpectedStatus`, carrying both
  the expected list and actual status. Check response metadata retains the
  actual status only when it is an integer from 100 through 599; out-of-range
  transport values (for example 600) are deliberately omitted.
- `HEAD` succeeds without reading or validating a body and reports zero bytes.
- Other successful responses must be valid UTF-8 and valid JSON. Byte count is
  the received payload's UTF-8 byte length, not character count.
- Malformed JSON or invalid UTF-8 fails as `InvalidBody`.
- Other transport failures fail as `DnsError`, carrying the URL host and the
  underlying cause where available.
- Exceeding the target timeout fails as `TimeoutError`.

### 3.2 Attempts, timing, and classification

A disabled stored target is rejected as `TargetDisabled` before any network
request. A probe retries only DNS and timeout failures. It makes at most four
attempts total, using exponentially increasing delays starting at 10 ms with
jitter, and applies the configured timeout to each attempt.

The resulting duration spans the complete operation, including retries and
delays, and is measured with the application clock. It is clamped to at least
1 ms. `checkedAt` is the completion time.

After a successful transport exchange:

1. an unexpected status is `Down` with failure reason `UnexpectedStatus`;
2. for non-`HEAD` requests, a present `healthBodySchema` must be a valid
   synchronous Draft-7 schema and match the body; invalid, `$async`, and
   mismatching schemas are `InvalidResponse`. Invalid JSON, invalid schemas, and
   `$async` schemas record `HealthSchemaParseError`; a valid schema that rejects
   the response records `HealthBodyMismatch`. Draft-7 extension and annotation
   keywords are accepted, and `HEAD` bypasses this validation;
3. without a schema, every successfully decoded JSON value (including strings)
   is ordinary data;
4. duration strictly greater than `slowThreshold` is `Slow`;
5. otherwise the result is `Up` (duration equal to the threshold is not slow).

An exhausted DNS or timeout failure becomes `Down` and records that failure
tag. A directly reported invalid body becomes `InvalidResponse`. The actual
status is retained in response metadata when an unexpected-status failure
supplies one.

For standalone classification, a disabled failure maps to `Unknown`; invalid
body, malformed health schema, and health-body mismatch map to
`InvalidResponse`; and DNS, timeout, unexpected status, repository,
configuration, and history-read failures map to `Down`. Repository,
configuration, and history-read failures are separately categorized as
requiring operator action; they are not transient probe failures.

The optional recovery policy may convert only DNS and timeout failures to a
caller-provided fallback. It must propagate every other failure unchanged. Its
standard degraded fallback is a `Down` check whose duration equals the target
timeout, whose failure reason is the failure tag, and which has no response
metadata.

## 4. Persistence contract

Two supported repositories—volatile memory and SQLite—have the same public
semantics.

### 4.1 Saves, reads, identity, and isolation

- Saving a target replaces all fields of the target with the same ID.
- Targets are listed in ascending bytewise UTF-8 ID order.
- Saving a check returns no value. The first value for an ID is retained.
  Saving a structurally identical value again is an idempotent success and does
  not duplicate history. Reusing the ID with different contents fails with a
  `RepositoryError` whose operation is `saveCheck` and whose cause identifies
  the conflicting ID.
- Checks are listed by ascending `checkedAt`, then ascending bytewise UTF-8 ID.
  An optional target filter returns only that target's checks.
- Saving an incident replaces all fields of the incident with the same ID and
  returns no value.
- Looking up a missing incident by ID, or the open incident for a target when
  none is open, returns absence, not an error.
- If malformed persisted data cannot satisfy the domain schema, the read fails
  as a `RepositoryError`; invalid rows are never partially returned.
- Caller-owned mutable data is copied on save and read. Mutating dates, arrays,
  or nested records supplied to or returned by the volatile repository cannot
  mutate retained state. Value wrappers documented as immutable must be treated
  as immutable; mutating their private runtime representation is outside this
  contract. SQLite provides the same observable isolation.

SQLite accepts legacy numeric millisecond durations and current tagged
millisecond/nanosecond encodings. Nanosecond values round-trip exactly.
Current infinity encodings are also recognized; positive infinity satisfies the
current strictly-positive duration boundary, while negative infinity does not.
Unknown duration encoding tags fail as repository errors.

### 4.2 Applying a check and incident transitions

Applying a check atomically saves the check and updates incident state, returning
one of `Opened`, `Updated`, `Closed`, or `Unchanged`.

For the latest check of a target:

- `Down`, `InvalidResponse`, or `Slow` opens an incident if none is open;
- a subsequent such check updates the selected open incident's reason and
  `latestCheckId`;
- `Up` closes every open incident for the target and updates each one's
  `latestCheckId`;
- `Unknown` changes no incident.

The incident reason is the check failure reason when present, otherwise the
classification name. A newly opened incident uses the transition time as its
opening time, starts without summary, and receives a unique `incident_` ID.
A close uses the transition time, except it is raised to the opening time if
the clock is earlier, preserving the incident invariant. A later failure after
a close creates a distinct incident even in the same millisecond.

When multiple open incidents already exist, reads and failing updates select
the one with greatest opening time, breaking a tie by greatest bytewise UTF-8
incident ID. Recovery closes all of them.

An arriving check older than any already stored check for the target is saved
in history but returns `Unchanged` and cannot alter incident state. Equal-time
checks are applied in serialized arrival order; unlike history and status reads,
incident transitions do not use the check ID as an equal-time tie-breaker.

The entire check/incident transition is atomic and serialized against
concurrent transitions. Concurrent failures for one target produce exactly one
`Opened` and one `Updated` transition, not two incidents. If any write fails,
neither the check nor incident changes remain. An exact duplicate apply returns `Unchanged`;
a conflicting duplicate fails without changing state.

### 4.3 SQLite post-commit event delivery

The SQLite repository additionally records a delivery-outbox row for each
committed incident transition in the same database transaction. The volatile
repository has no external-delivery capability. SQLite external delivery starts
only after the transaction has committed. If sending fails, its outbox row
remains pending. A later delivery pass retries the same event and acknowledges
the row only after a successful send; later passes skip acknowledged rows.

This is an **at-least-once** contract. A process can fail after the receiver
accepts an event but before BeaconWatch records its acknowledgement, so a retry
may send the event again. Consumers must use the event ID as an idempotency key.
BeaconWatch does not promise exactly-once external delivery.

## 5. Scheduling and lifecycle

Scheduler queue capacity must be a safe integer from 1 through 1,000,000;
worker count must be a safe integer from 1 through 1024.
Invalid values fail promptly as `ConfigError`; they must not create a blocked
schedule.

`runOnce` filters disabled targets, enqueues each remaining target once in input
order, and processes them with no more than `workerCount` concurrent workers.
The bounded queue applies backpressure at `queueCapacity`. It completes after
all accepted targets have produced, persisted, and published a check. An empty
active set completes without probing. A worker failure fails the run promptly
and cancels blocked producers and sibling workers; it is not swallowed.

`watchLoop` filters disabled targets once at startup. Each active target is
offered immediately, then repeatedly at that target's configured interval.
Offers share the same bounded queue, so congestion delays offers rather than
creating unbounded work. The loop runs until failed or cancelled.

On cancellation or scope exit, producers, workers, queued waits, probes, and
owned resources are cancelled/released together. A scheduler does not claim to
finish queued checks after cancellation.

Database operations are limited by the configured connection-pool size. Pool
size must be an integer from 1 through 1024. Failure or cancellation does not
consume pool capacity, and every acquired pooled handle is released when its
owning lifetime ends.

## 6. Status views

The per-target status view stores the latest check and the open incident observed
immediately after its transition. Updates are atomic. A check with an earlier
timestamp cannot replace the current entry; equal timestamps are resolved by
greatest bytewise UTF-8 check ID. Both update inputs and returned entries or
snapshots isolate caller-owned mutable dates, arrays, and nested records. As with
repository values, private internals of immutable value wrappers are not a
supported mutation surface.

The degraded-count view maintains one optional degraded membership per target,
labelled by one tag:

- repeatedly opening the same target/tag is idempotent;
- reopening under a different tag transfers one count from old tag to new tag
  without changing the global count;
- closing an absent target is idempotent;
- closing a present target decrements global and tag counts and removes a zero
  tag count;
- every snapshot atomically satisfies
  `globalDegradedCount = sum(tagDegradedCounts)` and all counts are non-negative,
  including during concurrent transitions.

These are separate read capabilities. The public `/status` endpoint described
below reports service reachability and target count, not either detailed view.

## 7. History import and digest

### 7.1 Input

History import accepts a filesystem path to UTF-8 newline-delimited JSON and
consumes it incrementally. A consumer that requests a finite prefix does not
read the remainder of the source. File access is replaceable at the capability
boundary so deterministic callers need not touch the live filesystem.
Failure to read the file is `HistoryReadError` and includes the requested path
and underlying cause. Malformed UTF-8 is rejected as `HistoryReadError` rather
than replacement-decoded. CRLF and LF are accepted. Blank or whitespace-only lines
are ignored and do not receive line numbers; non-blank lines are numbered in
their filtered order starting at 1.

Each row has this exact implementation-neutral JSON shape (unknown fields at
any object level are ignored):

| Key | Presence | JSON shape |
|---|---|---|
| `id` | Required | Well-formed Unicode string check ID (no unpaired surrogate). |
| `targetId` | Required | String satisfying the target-ID contract. |
| `checkedAt` | Required | String in the RFC3339 profile below. |
| `durationMillis` | Required | Finite JSON number strictly greater than zero whose value in nanoseconds (`durationMillis * 1,000,000`) is a safe integer. |
| `classification` | Required | Tagged object `{ "_tag": "Up" }`, `{ "_tag": "Slow" }`, `{ "_tag": "Down" }`, `{ "_tag": "InvalidResponse" }`, or `{ "_tag": "Unknown" }`. |
| `failure` | Optional | Object `{ "reason": <well-formed Unicode string> }`; lone surrogates are rejected. |
| `response` | Required | Object with optional `status` (integer 100–599) and optional `bytes` (non-negative safe integer); `{}` is valid. |

The accepted represented date and its offset-normalized UTC instant both have
a year from 0001 through 9999 and a valid calendar
date, uppercase `T`, mandatory seconds from `00` to `59`, optional fractional
seconds with one to three digits, and uppercase `Z` or a valid numeric `±HH:mm`
timezone offset. A
syntactically or structurally invalid row becomes
a malformed-row value carrying its line and diagnostic. Import continues after
such rows. Decoding may happen concurrently (limit 8), but downstream digest
semantics are independent of completion and arrival order.

### 7.2 Aggregation

For each target with retained checks, the digest reports:

- `currentStatus`: classification of the greatest check by `checkedAt`, then
  greatest bytewise UTF-8 check ID;
- `p95LatencyMillis`: nearest-rank percentile after ascending numeric sort,
  at index `ceil(n * 0.95) - 1`;
- `uptimePercent`: `Up` checks divided by retained checks times 100; `Slow` is
  not counted as up;
- `checks`: number of retained unique checks.

Targets are output in ascending bytewise UTF-8 target-ID order. The digest's
`incidents` list is currently always empty; history import does not reconstruct
incidents.

`processedRows` counts every successfully decoded check row, including exact
and conflicting duplicates. `malformedRows` counts decoding failures plus one
for each check ID whose distinct valid representations conflict.

An exact duplicate ID/value is counted as processed but contributes one check.
On the first conflicting value for an ID, all representations of that ID are
excluded from all target aggregates and the malformed count increases once.
Later occurrences of that ID remain processed but do not increase malformed
count. This result is independent of representation arrival order.

### 7.3 Digest cache and metadata batching

Per-target digest caching defaults to a 1-minute successful-value time-to-live,
a 1-second failed-lookup time-to-live, and a maximum of 128 keys. Concurrent
cache misses for the same key share one computation and the same result. A
failure is replayed during its short TTL to prevent a retry stampede, then the
next get recomputes; a successful value remains cached across that failure-TTL
boundary. Explicit invalidation removes one key. Returned digest objects are
copies and cannot mutate cached state.

Target metadata requests made together—including duplicate requests for the
same ID—join one batch. The backend key list may deduplicate those IDs, but every
original request still completes with the correctly paired result. Requests
made sequentially form separate batches. Missing target metadata resolves to
empty tags and no latest incident. Returned tag arrays are copies.

## 8. Configuration

Application configuration requires:

- `pollInterval`, `probeTimeout`, and `slowThreshold`: parseable, strictly
  positive duration strings, including positive nanoseconds;
- `workerConcurrency`: an integer from 1 through 1024;
- optional `realLlmToken`.

Missing required fields, malformed values, and non-positive values fail at the
configuration boundary. The token's ordinary string representation is redacted;
authorized code may explicitly reveal its original value. No application-level
defaults are supplied for required fields.

Repository selection is the one executable environment default:
`BEACONWATCH_REPOSITORY=sqlite` selects a temporary SQLite repository; every
other value, including absence and different casing, selects volatile memory.
The SQLite choice is process-temporary rather than a user-selected durable path.

## 9. Command surface and process entry

The command grammar is:

```text
beaconwatch
beaconwatch demo
beaconwatch check <non-empty-config>
beaconwatch serve
beaconwatch import-history <non-empty-file>
beaconwatch digest
```

Missing required positional arguments fail parsing. Successful commands produce
`beaconwatch`, `demo`, `checked <config>`, `serve`, the history digest object, or
`digest`, respectively. Process exit and presentation layers may render or
discard those values; that choice does not alter command-handler conformance.

## 10. HTTP API

The API model defines these `GET` routes and `/openapi.json` documentation:

| Route | Success body |
|---|---|
| `/targets` | Array of `{ id, name, url, enabled }`, preserving repository order. |
| `/status` | `{ ok: true, targets: <stored-target-count> }`. |
| `/incidents/:id` | `{ id, targetId, status, reason }`. |
| `/checks` | Array of `{ id, targetId, classification }`, preserving repository order. |

Incident route IDs must match
`^incident_[a-z0-9][a-z0-9_-]*$`; malformed parameters fail request decoding.
A well-formed absent incident fails with `{ message: "incident not found: <id>" }`.
Repository failures are deliberately mapped to stable messages:
`failed to list targets`, `failed to read status`, `failed to read incident`, or
`failed to list checks`. Internal causes are not exposed.

The API declares one error shape, `{ message: string }`, but does not specify
HTTP status-code distinctions between validation, absence, and repository
failure. A transport listener is not part of the present executable contract.

## 11. Operational observability

Where telemetry is installed, each recorded check:

- observes duration in milliseconds in histogram
  `beaconwatch_probe_latency_ms`, with boundaries 10, 50, 100, 250, 500, 1000,
  2500, and 5000;
- adds 1 to `beaconwatch_target_state_total` for `Up`, otherwise adds 0.

Probe and digest operations expose spans named `probe` and `digest` when
instrumentation is installed; probe
spans carry `target_id`. Log annotations use `target_id` and `check_id` and do
not change operation results. A temporary minimum log-level override is local
to the operation that applies it and reverts afterward.

Every opened span closes on success, failure, and cancellation and records the
matching outcome. Active-operation gauges return to their prior value on every
exit. An installed exporter is owned by the application lifetime: many requests
share it, and application shutdown attempts its bounded cleanup exactly once.
Request cancellation reaches owned child work before the request finishes.

Telemetry exporters, log formatting/destinations, metric persistence, alerting,
and cardinality controls are not specified. The current executable does not
automatically instrument every probe or digest.

## 12. Test-support behavior

The scripted probe double accepts scripts keyed by target ID when that key is
present, otherwise by URL. A scalar script is treated as a one-element sequence.
Sequences consume from the front and repeat their final step indefinitely.
Empty sequences and recover-after counts that are negative or not safe integers
are rejected when the fake layer is constructed.
An absent script returns a default 200 response with `{ ok: true }` and 11 bytes.
It can return responses, preserve supplied probe failures by identity, delay a
response using the application clock, or fail a configured number of calls
before recovery. Recovery counters are maintained per resolved script key.

Convenience scripts provide valid 200 JSON, delayed success, malformed-body,
status-error, DNS-error, timeout, and recover-after behavior.

The scoped local target server binds to an ephemeral loopback port and exposes:

| Path | Behavior |
|---|---|
| `/ok` | 200 JSON envelope `{ status: 200, body: { ok: true } }`. |
| `/slow` | 200 text `slow` after about 50 ms. |
| `/flaky` | First request 500, later requests 200; body is request count. |
| `/bad-json` | 200 with malformed JSON text `{`. |
| `/reset` | Destroys the request socket. |
| `/recovers-after/N` | For that `N`, first N requests return 500 and later requests 200; body is request count. |
| any other path | 404 text `not found`. |

Flaky/recovery counters belong to one server instance. Acquiring the server
fails as `listen failed` if binding fails. Releasing its owning lifetime closes
the listener and waits for close completion; the old URL is no longer reachable.

The fake incident summarizer supports deterministic valid, malformed,
schema-invalid, provider-error, and fallback scripts. Malformed/schema-invalid
outputs and provider failures surface as `IncidentSummaryError`; the fallback
text is `No recent incidents.`.

## 13. Failure contract

Operational failures have these stable categories and payloads:

| Category | Required data / meaning |
|---|---|
| `DnsError` | host and optional cause; transport/name-resolution class failure |
| `TimeoutError` | formatted timeout and optional cause |
| `UnexpectedStatus` | expected status list and actual status |
| `InvalidBody` | diagnostic reason |
| `HealthSchemaParseError` | diagnostic reason; configured schema could not be compiled as a supported synchronous Draft-7 schema |
| `HealthBodyMismatch` | a valid configured schema rejected the decoded response body |
| `TargetDisabled` | target ID; no probe attempted |
| `RepositoryError` | operation and optional cause; storage/decoding/transaction failure |
| `ConfigError` | diagnostic reason |
| `HistoryReadError` | path and optional cause |
| `MalformedHistoryRow` | one-based filtered line number and reason; recoverable within import |
| `IncidentSummaryError` | reason; provider or summary validation failure |

Invariant violations are unrecoverable defects, not expected failures. Unknown
programmer exceptions and worker defects remain failures and are not converted
to successful checks. Public HTTP responses sanitize repository errors as
specified in section 10.

## 14. Explicit non-goals and limits

- This specification does not require a particular programming model,
  dependency-wiring scheme, storage driver, or concurrency primitive.
- Command handlers, API handlers, and long-running monitoring may be hosted
  independently; conformance does not require one monolithic process mode.
- There is no target create/update HTTP route, authentication, authorization,
  TLS listener configuration, pagination, filtering API, or stable HTTP error
  status mapping.
- `POST` probes have no configured request body or custom headers.
- Redirect policy, proxy behavior, DNS-vs-other-network error refinement, and
  response size limits are delegated to the HTTP transport.
- Digests do not reconstruct incidents and count only `Up` as uptime.
- Incident summaries are not automatically generated or persisted.
- Detailed status views, degraded counters, digest cache, metadata batching,
  and telemetry are capabilities, not automatically connected to HTTP output.
- The volatile repository has process lifetime. Selecting SQLite without a
  durable path does not imply a durable-storage contract.
- No delivery guarantee is made for in-flight or queued checks after shutdown.
