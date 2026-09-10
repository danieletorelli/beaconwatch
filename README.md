# BeaconWatch

BeaconWatch is a proof-of-concept HTTP endpoint monitor for teams that need a clear answer
to a basic operational question: **is this service healthy right now, and what
happened while nobody was watching?**

It probes configured HTTP targets, records checks, opens and closes incidents,
and turns newline-delimited check history into per-target availability and
latency summaries. Its bounded scheduler and explicit resource lifecycle make
it suitable for continuously watching many endpoints without allowing slow
targets to create unbounded work. These capabilities are individually usable,
but the 0.1 executable does not yet compose them into one monitoring daemon.

BeaconWatch is intentionally focused. It provides monitoring and query
capabilities without trying to replace a full telemetry, paging, or incident
management platform.

## What BeaconWatch provides

- `GET`, `POST`, and `HEAD` health probes with per-target timeouts.
- Expected-status, JSON, UTF-8, and optional JSON Schema validation.
- `Up`, `Slow`, `Down`, `InvalidResponse`, and `Unknown` classifications.
- Automatic incident opening, updating, and recovery.
- In-memory or SQLite repositories with the same observable behavior.
- Transactional SQLite outbox records for post-commit incident delivery.
- Bounded concurrent scheduling with backpressure and clean cancellation.
- Streaming NDJSON history import with p95 latency and uptime summaries.
- A typed read-only HTTP API with generated OpenAPI documentation.

## Requirements and installation

- Node.js 22.19 or newer
- npm

Install dependencies and compile the application:

```sh
cd effect
npm ci
npm exec tsc
```

The executable is then available at `dist/src/bin.js`:

```sh
node dist/src/bin.js --help
```

The examples below assume this local alias:

```sh
alias beaconwatch='node dist/src/bin.js'
```

## Command-line interface

```text
beaconwatch
beaconwatch demo
beaconwatch check <config>
beaconwatch serve
beaconwatch import-history <file>
beaconwatch digest
```

Use `beaconwatch <command> --help` for command-specific syntax. The CLI also
supports `--version`, shell completion generation, wizard mode, and
`--log-level`.

### Choose a repository

BeaconWatch uses its in-memory repository by default. Set
`BEACONWATCH_REPOSITORY=sqlite` to use a process-temporary SQLite database:

```sh
BEACONWATCH_REPOSITORY=sqlite beaconwatch demo
```

Any other value selects the in-memory repository. The command-line SQLite mode
does not currently accept a durable database path, so do not use it as a
durable monitoring store.

### Run the command surface

`demo`, `check`, `serve`, and `digest` are placeholder commands representing
future application boundaries. `check` requires a non-empty configuration
argument:

```sh
beaconwatch demo
beaconwatch check config.json
beaconwatch serve
beaconwatch digest
```

These commands currently complete silently at the process boundary. The
`check` argument is acknowledged as a string; it is not yet loaded as a target
configuration file. Likewise, `serve` dispatches the server command but does
not itself bind an HTTP listener. Applications that host BeaconWatch should
use the probe, scheduler, repository, and HTTP server layers directly.

### Import check history

Import an NDJSON history file with:

```sh
beaconwatch import-history ./history.ndjson
```

The importer reads incrementally, accepts LF or CRLF input, ignores blank
lines, and continues past malformed rows. A valid row has this shape:

```json
{"id":"check_001","targetId":"target_api","checkedAt":"2026-09-09T12:00:00Z","durationMillis":42,"classification":{"_tag":"Up"},"response":{"status":200,"bytes":11}}
```

The resulting digest contains, for each target, its current classification,
nearest-rank p95 latency, uptime percentage, and retained check count. Every
valid occurrence counts as processed; exact duplicates contribute one retained
check. Conflicting values for the same check ID are excluded and reported as
malformed. Only `Up` counts toward uptime—`Slow` does not—and importing history
does not reconstruct incidents.

The current process presentation layer does not print the returned digest. Use
the `importHistory` capability directly when a host needs to display or persist
the result.

## HTTP API

BeaconWatch provides an embeddable read-only API model and Node server layer.
The routes are available when that layer is mounted by a host application; the
CLI does not bind it automatically.

| Method | Path | Response |
|---|---|---|
| `GET` | `/targets` | Stored targets as `{ id, name, url, enabled }`. |
| `GET` | `/status` | Service status as `{ ok: true, targets }`. |
| `GET` | `/incidents/:id` | One incident as `{ id, targetId, status, reason }`. |
| `GET` | `/checks` | Checks as `{ id, targetId, classification }`. |
| `GET` | `/openapi.json` | Generated OpenAPI document. |

Example responses:

```json
{"ok":true,"targets":3}
```

```json
{"id":"incident_api_001","targetId":"target_api","status":"Open","reason":"TimeoutError"}
```

Incident IDs must match `incident_[a-z0-9][a-z0-9_-]*`. Missing incidents and
repository failures return a stable `{ "message": "..." }` error body. The
API deliberately does not expose internal storage errors.

The API is currently query-only. Targets are populated through the repository
capability; there are no create, update, authentication, authorization,
pagination, or filtering endpoints.

## Incident delivery API

When SQLite persistence is selected, the application layer also provides the
`OutboxDelivery` service. Incident transitions and their outbox rows commit in
one transaction. A host supplies the transport when it runs a delivery pass:

```ts
const deliver = OutboxDelivery.use((outbox) =>
  outbox.deliverPending((eventId) => notificationGateway.send({ eventId }))
)
```

A failed send leaves the event pending. A later pass retries the same event ID,
and a successful send is acknowledged so subsequent passes skip it. Delivery is
therefore at least once, not exactly once; receivers should use the event ID as
an idempotency key.

## Probe behavior

Each enabled target defines a URL, method, expected HTTP statuses, interval,
timeout, slow threshold, and optional JSON Schema for its health response.
BeaconWatch retries only DNS and timeout failures, up to four total attempts,
with jittered exponential backoff. Other failures are reported immediately.

`HEAD` probes validate status without reading a body. Successful `GET` and
`POST` probes require valid UTF-8 JSON and, when configured, a matching
Draft-7 JSON Schema. A response is `Slow` only when its duration is strictly
greater than the target threshold.

## Persistence and operational limits

The in-memory repository lasts for the process lifetime. The SQLite repository
provides atomic check-and-incident transitions and equivalent ordering,
identity, and isolation semantics.

Scheduler queue capacity must be between 1 and 1,000,000, worker count between
1 and 1024, and database pool size between 1 and 1024. BeaconWatch applies
backpressure when capacity is exhausted and cancels owned producers, workers,
probes, and resources together during shutdown.

## Scope

BeaconWatch does not currently provide a built-in email, webhook, or paging
transport, a web dashboard,
authentication, target-management HTTP endpoints, user-selected durable
command-line storage, request bodies or custom headers for `POST` probes, or
response-size limits. Integrate it with your existing telemetry and incident
notification systems for those concerns.

For the complete implementation-neutral behavioral contract, see
[`SPEC.md`](./SPEC.md).
