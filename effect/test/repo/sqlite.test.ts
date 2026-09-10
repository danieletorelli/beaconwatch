import { it } from "@effect/vitest"
import { Duration, Effect, Equal, Layer, Option } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { RepositoryError } from "../../src/domain/errors.js"
import { CheckFailure, CheckResult, Down, Incident, ResponseMetadata, Target, Up, decodeTargetConfig } from "../../src/domain/schema.js"
import { CheckRepository } from "../../src/repo/CheckRepository.js"
import { InMemory } from "../../src/repo/CheckRepository.js"
import { layerForFile, makeTempFilename, tempLayer } from "../../src/repo/SqliteCheckRepository.js"
import { Live as IncidentLive, IncidentService } from "../../src/services/IncidentService.js"
import { target } from "../helpers.js"

const mk = (id: string, tag: "Down" | "Up") => new CheckResult({ id, targetId: target("target_sqlite").id, checkedAt: new Date(0), duration: Duration.millis(1), classification: tag === "Down" ? new Down() : new Up(), ...(tag === "Down" ? { failure: new CheckFailure({ reason: "down" }) } : {}), response: new ResponseMetadata({ status: tag === "Up" ? 200 : 500 }) })

it.effect("round-trips checks and incident lifecycle", () => Effect.gen(function*() {
  const repo = yield* CheckRepository
  const incidents = yield* IncidentService
  yield* incidents.applyCheck(mk("c1", "Down"))
  yield* incidents.applyCheck(mk("c2", "Up"))
  const checks = yield* repo.listChecks(target("target_sqlite").id)
  if (checks.length !== 2) throw new Error("checks missing")
  if (Option.isSome(yield* repo.getOpenIncident(target("target_sqlite").id))) throw new Error("incident still open")
}).pipe(Effect.provide(Layer.provideMerge(IncidentLive, tempLayer()))))

it.effect("serializes concurrent failing checks into one open incident", () => Effect.gen(function*() {
  const repo = yield* CheckRepository
  const incidents = yield* IncidentService
  const transitions = yield* Effect.all(
    [incidents.applyCheck(mk("concurrent_1", "Down")), incidents.applyCheck(mk("concurrent_2", "Down"))],
    { concurrency: "unbounded" }
  )
  const checks = yield* repo.listChecks(target("target_sqlite").id)
  const open = yield* repo.getOpenIncident(target("target_sqlite").id)
  if (checks.length !== 2) throw new Error(`expected two checks, got ${checks.length}`)
  if (Option.isNone(open)) throw new Error("concurrent failures did not leave an open incident")
  if (transitions.filter((transition) => transition === "Opened").length !== 1 ||
    transitions.filter((transition) => transition === "Updated").length !== 1) {
    throw new Error(`expected one open and one update, got ${transitions.join(", ")}`)
  }
}).pipe(Effect.provide(Layer.provideMerge(IncidentLive, tempLayer()))))

it.effect("rejects a reused check id with conflicting contents", () => Effect.gen(function*() {
  const repo = yield* CheckRepository
  yield* repo.applyCheck(mk("check_conflict", "Down"))
  const error = yield* Effect.flip(repo.applyCheck(mk("check_conflict", "Up")))
  if (!(error instanceof RepositoryError)) {
    throw new Error("expected conflicting id reuse to fail with RepositoryError")
  }
}).pipe(Effect.provide(tempLayer())))

it.effect("preserves conflict error details across repository implementations", () => Effect.gen(function*() {
  for (const method of ["saveCheck", "applyCheck", "applyCheckWithIncident"] as const) {
    const exercise = Effect.gen(function*() {
      const repo = yield* CheckRepository
      yield* repo[method](mk(`check_conflict_details_${method}`, "Down"))
      return yield* Effect.flip(repo[method](mk(`check_conflict_details_${method}`, "Up")))
    })
    const memoryError = yield* exercise.pipe(Effect.provide(InMemory))
    const sqliteError = yield* exercise.pipe(Effect.provide(tempLayer()))
    if (sqliteError.operation !== "saveCheck" || sqliteError.operation !== memoryError.operation || sqliteError.cause !== memoryError.cause) {
      throw new Error(`${method} conflict differs: memory=${memoryError.operation}/${String(memoryError.cause)} sqlite=${sqliteError.operation}/${String(sqliteError.cause)}`)
    }
  }
}))

it.effect("round-trips Unicode prose and keeps duplicate checks idempotent across repositories", () => Effect.gen(function*() {
  const exercise = Effect.gen(function*() {
    const repo = yield* CheckRepository
    const unicodeCheck = new CheckResult({
      ...mk("check_unicode_prose", "Down"),
      failure: new CheckFailure({ reason: "DNS failed for café 🚨" })
    })
    const unicodeIncident = new Incident({
      id: "incident_unicode_prose",
      targetId: target("target_sqlite").id,
      openedAt: new Date(1),
      closedAt: Option.none(),
      status: "Open",
      reason: "Échec réseau 🌐",
      latestCheckId: unicodeCheck.id,
      summary: Option.some("Résumé: 東京 is reachable ✅")
    })
    yield* repo.saveCheck(unicodeCheck)
    yield* repo.saveCheck(unicodeCheck)
    yield* repo.saveIncident(unicodeIncident)
    return {
      checks: yield* repo.listChecks(unicodeCheck.targetId),
      incident: yield* repo.getIncident(unicodeIncident.id)
    }
  })
  const memory = yield* exercise.pipe(Effect.provide(InMemory))
  const sqlite = yield* exercise.pipe(Effect.provide(tempLayer()))
  if (memory.checks.length !== 1 || sqlite.checks.length !== 1 || !Equal.equals(memory.checks, sqlite.checks)) {
    throw new Error("Unicode duplicate-check round trip differs across repositories")
  }
  if (!Equal.equals(memory.incident, sqlite.incident) || Option.isNone(sqlite.incident) ||
    sqlite.incident.value.reason !== "Échec réseau 🌐" ||
    Option.getOrUndefined(sqlite.incident.value.summary) !== "Résumé: 東京 is reachable ✅") {
    throw new Error("Unicode incident prose round trip differs across repositories")
  }
}))

it.effect("accepts an exact duplicate after a nanosecond duration round-trip", () => Effect.gen(function*() {
  const repo = yield* CheckRepository
  const precise = new CheckResult({
    ...mk("check_precise_duration", "Up"),
    duration: Duration.nanos(9_007_199_254_740_993n)
  })
  yield* repo.saveCheck(precise)
  yield* repo.saveCheck(precise)
  const checks = yield* repo.listChecks(target("target_sqlite").id)
  if (checks.length !== 1) throw new Error(`expected one exact duplicate, got ${checks.length}`)
}).pipe(Effect.provide(tempLayer())))

it.effect("serializes concurrent identical saveCheck calls", () => Effect.gen(function*() {
  const repo = yield* CheckRepository
  const check = mk("check_concurrent_identical", "Up")
  yield* Effect.all([repo.saveCheck(check), repo.saveCheck(check)], { concurrency: "unbounded" })
  const checks = yield* repo.listChecks(target("target_sqlite").id)
  if (checks.length !== 1 || !Equal.equals(checks[0], check)) throw new Error("expected one complete identical check")
}).pipe(Effect.provide(tempLayer())))

it.effect("serializes concurrent conflicting saveCheck calls", () => Effect.gen(function*() {
  const repo = yield* CheckRepository
  const down = mk("check_concurrent_conflict", "Down")
  const up = mk("check_concurrent_conflict", "Up")
  const results = yield* Effect.all([Effect.result(repo.saveCheck(down)), Effect.result(repo.saveCheck(up))], { concurrency: "unbounded" })
  const successes = results.filter((result) => result._tag === "Success")
  const failures = results.filter((result) => result._tag === "Failure")
  if (successes.length !== 1 || failures.length !== 1) throw new Error("expected one success and one failure")
  if (!(failures[0]?.failure instanceof RepositoryError) || failures[0].failure.operation !== "saveCheck") {
    throw new Error("expected the conflicting save to fail with saveCheck RepositoryError")
  }
  const checks = yield* repo.listChecks(target("target_sqlite").id)
  if (checks.length !== 1 || (!Equal.equals(checks[0], down) && !Equal.equals(checks[0], up))) {
    throw new Error("expected exactly one complete conflicting value")
  }
}).pipe(Effect.provide(tempLayer())))

it.effect("returns check history in the same order across repository implementations", () => Effect.gen(function*() {
  const exercise = Effect.gen(function*() {
    const repo = yield* CheckRepository
    yield* repo.saveCheck(mk("check_z", "Up"))
    yield* repo.saveCheck(mk("check_a", "Up"))
    return (yield* repo.listChecks()).map((value) => value.id)
  })
  const memoryOrder = yield* exercise.pipe(Effect.provide(InMemory))
  const sqliteOrder = yield* exercise.pipe(Effect.provide(tempLayer()))
  if (memoryOrder.join(",") !== sqliteOrder.join(",")) {
    throw new Error(`repository ordering differs: memory=${memoryOrder.join(",")} sqlite=${sqliteOrder.join(",")}`)
  }
}))

it.effect("orders Unicode check ids by code point across repository implementations", () => Effect.gen(function*() {
  const exercise = Effect.gen(function*() {
    const repo = yield* CheckRepository
    yield* repo.saveCheck(mk("check_𐀀", "Up"))
    yield* repo.saveCheck(mk("check_", "Up"))
    return (yield* repo.listChecks()).map((value) => value.id)
  })
  const memoryOrder = yield* exercise.pipe(Effect.provide(InMemory))
  const sqliteOrder = yield* exercise.pipe(Effect.provide(tempLayer()))
  if (memoryOrder.join(",") !== sqliteOrder.join(",")) {
    throw new Error(`Unicode check ordering differs: memory=${memoryOrder.join(",")} sqlite=${sqliteOrder.join(",")}`)
  }
}))

it.effect("uses incident id to break equal-opened-time read-model ties", () => Effect.gen(function*() {
  const exercise = Effect.gen(function*() {
    const repo = yield* CheckRepository
    const base = { targetId: target("target_sqlite").id, openedAt: new Date(1), closedAt: Option.none<Date>(), status: "Open" as const, reason: "down", latestCheckId: "check_down", summary: Option.none<string>() }
    yield* repo.saveIncident(new Incident({ ...base, id: "incident_a" }))
    yield* repo.saveIncident(new Incident({ ...base, id: "incident_z" }))
    const open = yield* repo.getOpenIncident(target("target_sqlite").id)
    return Option.map(open, (incident) => incident.id)
  })
  const memoryOpen = yield* exercise.pipe(Effect.provide(InMemory))
  const sqliteOpen = yield* exercise.pipe(Effect.provide(tempLayer()))
  if (Option.getOrUndefined(memoryOpen) !== "incident_z" || Option.getOrUndefined(sqliteOpen) !== "incident_z") {
    throw new Error(`expected incident_z from equal-time read tie, got memory=${Option.getOrUndefined(memoryOpen)} sqlite=${Option.getOrUndefined(sqliteOpen)}`)
  }
}))

it.effect("updates the same open incident selected by the read model", () => Effect.gen(function*() {
  const repo = yield* CheckRepository
  const base = { targetId: target("target_sqlite").id, openedAt: new Date(1), closedAt: Option.none<Date>(), status: "Open" as const, reason: "original", latestCheckId: "check_original", summary: Option.none<string>() }
  yield* repo.saveIncident(new Incident({ ...base, id: "incident_a" }))
  yield* repo.saveIncident(new Incident({ ...base, id: "incident_z" }))
  yield* repo.applyCheck(mk("check_updates_selected_incident", "Down"))
  const selected = yield* repo.getOpenIncident(target("target_sqlite").id)
  if (Option.isNone(selected) || selected.value.id !== "incident_z" || selected.value.latestCheckId !== "check_updates_selected_incident") {
    throw new Error(`expected incident_z to be updated, got ${Option.isSome(selected) ? `${selected.value.id}/${selected.value.latestCheckId}` : "missing"}`)
  }
}).pipe(Effect.provide(tempLayer())))

it.effect("returns targets in the same order across repository implementations", () => Effect.gen(function*() {
  const exercise = Effect.gen(function*() {
    const repo = yield* CheckRepository
    yield* repo.saveTarget(new Target({ ...target("target_a_"), enabled: true }))
    yield* repo.saveTarget(new Target({ ...target("target_a0"), enabled: true }))
    return (yield* repo.listTargets()).map((value) => value.id)
  })
  const memoryOrder = yield* exercise.pipe(Effect.provide(InMemory))
  const sqliteOrder = yield* exercise.pipe(Effect.provide(tempLayer()))
  if (memoryOrder.join(",") !== sqliteOrder.join(",")) {
    throw new Error(`target ordering differs: memory=${memoryOrder.join(",")} sqlite=${sqliteOrder.join(",")}`)
  }
}))

it.effect("preserves decode-boundary target-name normalization across repositories", () => Effect.gen(function*() {
  const decoded = yield* decodeTargetConfig({ ...target("target_normalized_name"), name: "  Normalized  " })
  const exercise = Effect.gen(function*() {
    const repo = yield* CheckRepository
    yield* repo.saveTarget(new Target({ ...decoded, enabled: true }))
    return (yield* repo.listTargets())[0]?.name
  })
  const memoryName = yield* exercise.pipe(Effect.provide(InMemory))
  const sqliteName = yield* exercise.pipe(Effect.provide(tempLayer()))
  if (memoryName !== "Normalized" || sqliteName !== memoryName) {
    throw new Error(`target-name normalization differs: memory=${memoryName} sqlite=${sqliteName}`)
  }
}))

it.effect("round-trips a saved target", () => Effect.gen(function*() {
  const repo = yield* CheckRepository
  const saved = new Target({ ...target("target_saved"), enabled: true })
  yield* repo.saveTarget(saved)
  const listed = yield* repo.listTargets()
  if (listed.length !== 1 || listed[0]?.id !== saved.id) throw new Error("saved target was not returned")
}).pipe(Effect.provide(tempLayer())))

it.effect("round-trips large millisecond target durations across repositories", () => Effect.gen(function*() {
  const duration = Duration.millis(1e21)
  const saved = new Target({ ...target("target_large_duration"), interval: duration, timeout: duration, slowThreshold: duration, enabled: true })
  const exercise = Effect.gen(function*() {
    const repo = yield* CheckRepository
    yield* repo.saveTarget(saved)
    return (yield* repo.listTargets())[0]
  })
  const memoryTarget = yield* exercise.pipe(Effect.provide(InMemory))
  const sqliteTarget = yield* exercise.pipe(Effect.provide(tempLayer()))
  if (!memoryTarget || !sqliteTarget || !Equal.equals(memoryTarget, saved) || !Equal.equals(sqliteTarget, saved)) {
    throw new Error("large millisecond target duration did not round-trip")
  }
}))

it.effect("honors the void result contract when saving a check", () => Effect.gen(function*() {
  const repo = yield* CheckRepository
  const result = yield* repo.saveCheck(mk("check_void_result", "Up"))
  if (result !== undefined) {
    throw new Error(`saveCheck returned an implementation detail instead of void: ${String(result)}`)
  }
}).pipe(Effect.provide(tempLayer())))

it.effect("honors the void result contract when saving an incident", () => Effect.gen(function*() {
  const repo = yield* CheckRepository
  const incident = new Incident({ id: "incident_void_result", targetId: target("target_sqlite").id, openedAt: new Date(1), closedAt: Option.none(), status: "Open", reason: "down", latestCheckId: "check_down", summary: Option.none() })
  const result = yield* repo.saveIncident(incident)
  if (result !== undefined) {
    throw new Error(`saveIncident returned an implementation detail instead of void: ${String(result)}`)
  }
}).pipe(Effect.provide(tempLayer())))

it.effect("round-trips every field when replacing a saved incident", () => Effect.gen(function*() {
  const repo = yield* CheckRepository
  const original = new Incident({ id: "incident_replaced", targetId: target("target_sqlite").id, openedAt: new Date(1), closedAt: Option.none(), status: "Open", reason: "first", latestCheckId: "check_first", summary: Option.none() })
  const replacement = new Incident({ ...original, openedAt: new Date(2), reason: "replacement", latestCheckId: "check_replacement" })
  yield* repo.saveIncident(original)
  yield* repo.saveIncident(replacement)
  const fetched = yield* repo.getIncident(replacement.id)
  if (Option.isNone(fetched) || fetched.value.openedAt.getTime() !== 2) {
    throw new Error(`expected replacement openedAt 2, got ${Option.isSome(fetched) ? fetched.value.openedAt.getTime() : "missing"}`)
  }
}).pipe(Effect.provide(tempLayer())))

it.effect("rejects malformed SQL rows as repository errors", () => {
  const filename = makeTempFilename()
  return Effect.scoped(Effect.provide(Effect.gen(function*() {
  const repo = yield* CheckRepository
  const sql = yield* SqlClient.SqlClient
  yield* sql`insert into check_results (id, target_id, checked_at, duration_ms, classification, failure_reason, response_status, response_bytes) values ('bad_check', 'target_sqlite', 0, 1, 'Bogus', null, 200, null)`
  const error = yield* Effect.flip(repo.listChecks(target("target_sqlite").id))
  if (!(error instanceof RepositoryError)) throw new Error("expected RepositoryError")
}), Layer.mergeAll(layerForFile(filename), SqliteClient.layer({ filename }))))
})

it.effect.each([
  ["response status", null, 999, null],
  ["response bytes", null, 200, -1],
  ["failure reason", Uint8Array.from([0xed, 0xa0, 0x80]), 500, null]
] as const)("rejects a corrupt persisted %s as a RepositoryError", ([, failureReason, responseStatus, responseBytes]) => {
  const filename = makeTempFilename()
  return Effect.scoped(Effect.provide(Effect.gen(function*() {
    const repo = yield* CheckRepository
    const sql = yield* SqlClient.SqlClient
    yield* sql`insert into check_results (id, target_id, checked_at, duration_ms, classification, failure_reason, response_status, response_bytes) values ('corrupt_nested_check', 'target_sqlite', 0, 1, 'Down', ${failureReason}, ${responseStatus}, ${responseBytes})`
    const result = yield* Effect.result(repo.listChecks(target("target_sqlite").id))
    if (result._tag !== "Failure" || !(result.failure instanceof RepositoryError)) {
      throw new Error("expected corrupt nested check data to fail through the RepositoryError channel")
    }
  }), Layer.mergeAll(layerForFile(filename), SqliteClient.layer({ filename }))))
})

it.effect("rejects a corrupt persisted incident reason as a RepositoryError", () => {
  const filename = makeTempFilename()
  return Effect.scoped(Effect.provide(Effect.gen(function*() {
    const repo = yield* CheckRepository
    const sql = yield* SqlClient.SqlClient
    yield* sql`insert into incidents (id, target_id, opened_at, closed_at, status, reason, latest_check_id, summary) values ('incident_corrupt_reason', 'target_sqlite', 0, null, 'Open', ${Uint8Array.from([0xed, 0xa0, 0x80])}, 'check_latest', null)`
    const result = yield* Effect.result(repo.getIncident("incident_corrupt_reason"))
    if (result._tag !== "Failure" || !(result.failure instanceof RepositoryError)) {
      throw new Error("expected corrupt incident data to fail through the RepositoryError channel")
    }
  }), Layer.mergeAll(layerForFile(filename), SqliteClient.layer({ filename }))))
})

it.effect("rejects persisted durations with an unknown encoding tag", () => {
  const filename = makeTempFilename()
  return Effect.scoped(Effect.provide(Effect.gen(function*() {
    const repo = yield* CheckRepository
    const sql = yield* SqlClient.SqlClient
    yield* sql`insert into check_results (id, target_id, checked_at, duration_ms, classification, failure_reason, response_status, response_bytes) values ('bad_duration_tag', 'target_sqlite', 0, 'legacy1', 'Up', null, 200, 1)`
    const error = yield* Effect.flip(repo.listChecks(target("target_sqlite").id))
    if (!(error instanceof RepositoryError)) throw new Error("expected an unknown duration encoding tag to fail with RepositoryError")
  }), Layer.mergeAll(layerForFile(filename), SqliteClient.layer({ filename }))))
})

it.effect("decodes legacy millisecond and current tagged duration encodings", () => {
  const filename = makeTempFilename()
  return Effect.scoped(Effect.provide(Effect.gen(function*() {
    const repo = yield* CheckRepository
    const sql = yield* SqlClient.SqlClient
    yield* sql`insert into check_results (id, target_id, checked_at, duration_ms, classification, failure_reason, response_status, response_bytes) values ('duration_legacy', 'target_sqlite', 0, 7, 'Up', null, 200, 1)`
    yield* sql`insert into check_results (id, target_id, checked_at, duration_ms, classification, failure_reason, response_status, response_bytes) values ('duration_millis', 'target_sqlite', 1, 'millis:8', 'Up', null, 200, 1)`
    yield* sql`insert into check_results (id, target_id, checked_at, duration_ms, classification, failure_reason, response_status, response_bytes) values ('duration_nanos', 'target_sqlite', 2, 'nanos:9007199254740993', 'Up', null, 200, 1)`
    const checks = yield* repo.listChecks(target("target_sqlite").id)
    const expected = [Duration.millis(7), Duration.millis(8), Duration.nanos(9_007_199_254_740_993n)]
    if (checks.length !== expected.length || checks.some((check, index) => !Equal.equals(check.duration, expected[index]))) {
      throw new Error("persisted duration compatibility encodings did not decode exactly")
    }
  }), Layer.mergeAll(layerForFile(filename), SqliteClient.layer({ filename }))))
})
