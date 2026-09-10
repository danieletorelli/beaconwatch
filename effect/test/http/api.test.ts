import { describe, expect, it } from "vitest"
import { Cause, Effect, Layer, Option, Schema } from "effect"
import { HttpApiTest } from "effect/unstable/httpapi"
import { Etag } from "effect/unstable/http"
import { NodeFileSystem, NodeHttpPlatform, NodePath } from "@effect/platform-node"
import { IncidentParams, BeaconWatchApi } from "../../src/http/api.js"
import { ApiHandlers } from "../../src/http/server.js"
import { CheckRepository } from "../../src/repo/CheckRepository.js"
import { CheckResult, Incident, ResponseMetadata, Target, Up, type TargetId } from "../../src/domain/schema.js"
import { target } from "../helpers.js"

describe("HttpApi model", () => {
  it("validates incident ids at the endpoint schema boundary", async () => {
    const good = await Effect.runPromise(Schema.decodeUnknownEffect(IncidentParams)({ id: "incident_1" }))
    expect(good.id).toBe("incident_1")
    await expect(Effect.runPromise(Schema.decodeUnknownEffect(IncidentParams)({ id: "bad" }))).rejects.toBeTruthy()
    await expect(Effect.runPromise(Schema.decodeUnknownEffect(IncidentParams)({ id: "incident_1\n" }))).rejects.toBeTruthy()
  })

  it("routes generated client calls through HttpApi handlers and declared schemas", async () => {
    const targetId = "target_api" as TargetId
    const apiTarget = new Target({ ...target(targetId), enabled: true })
    const check = new CheckResult({ id: "check_api", targetId, checkedAt: new Date(0), duration: apiTarget.timeout, classification: new Up(), response: new ResponseMetadata({ status: 200 }) })
    const incident = new Incident({
      id: "incident_api",
      targetId,
      openedAt: new Date(0),
      closedAt: Option.none(),
      status: "Open",
      reason: "down",
      latestCheckId: "check_api",
      summary: Option.none()
    })
    const fakeRepo = {
      saveTarget: () => Effect.void,
      listTargets: () => Effect.succeed([apiTarget]),
      saveCheck: () => Effect.void,
      listChecks: () => Effect.succeed([check]),
      getIncident: (requested: string) => Effect.succeed(requested === incident.id ? Option.some(incident) : Option.none()),
      getOpenIncident: (requested: TargetId) => Effect.succeed(requested === targetId ? Option.some(incident) : Option.none()),
      saveIncident: () => Effect.void,
      applyCheck: () => Effect.succeed("Unchanged" as const),
      applyCheckWithIncident: () => Effect.succeed({ transition: "Unchanged" as const, openIncident: Option.none() })
    }
    const appLayer = Layer.mergeAll(ApiHandlers, NodeFileSystem.layer, NodePath.layer, NodeHttpPlatform.layer, Etag.layer)
    const program = Effect.scoped(Effect.gen(function*() {
      const client = yield* HttpApiTest.groups(BeaconWatchApi, ["default"]).pipe(Effect.provideService(CheckRepository, fakeRepo))
      const targets = yield* client.default.getTargets({}).pipe(Effect.provideService(CheckRepository, fakeRepo))
      const checks = yield* client.default.getChecks({}).pipe(Effect.provideService(CheckRepository, fakeRepo))
      const ok = yield* client.default.getIncident({ params: { id: "incident_api" } }).pipe(Effect.provideService(CheckRepository, fakeRepo))
      const badRequest = yield* client.default.getIncident({ params: { id: "bad" } }).pipe(Effect.provideService(CheckRepository, fakeRepo), Effect.exit)
      const notFound = yield* client.default.getIncident({ params: { id: "incident_missing" } }).pipe(Effect.provideService(CheckRepository, fakeRepo), Effect.exit)
      return { targets, checks, ok, badRequest, notFound }
    }).pipe(Effect.provide(appLayer))) as unknown as Effect.Effect<{
      readonly targets: ReadonlyArray<{ readonly id: string; readonly name: string; readonly url: string; readonly enabled: boolean }>
      readonly checks: ReadonlyArray<{ readonly id: string; readonly targetId: string; readonly classification: string }>
      readonly ok: { readonly id: string; readonly targetId: string; readonly status: string; readonly reason: string }
      readonly badRequest: unknown
      readonly notFound: unknown
    }, unknown>
    const result = await Effect.runPromise(program)

    expect(result.targets).toEqual([{ id: "target_api", name: "target_api", url: "http://target_api.test/health", enabled: true }])
    expect(result.checks).toEqual([{ id: "check_api", targetId: "target_api", classification: "Up" }])
    expect(result.ok).toMatchObject({ id: "incident_api", targetId: "target_api", status: "Open", reason: "down" })
    expect((result.badRequest as { readonly _tag: string })._tag).toBe("Failure")
    expect((result.notFound as { readonly _tag: string })._tag).toBe("Failure")
    if ((result.notFound as { readonly _tag: string })._tag === "Failure") {
      const notFound = result.notFound as { readonly cause: Cause.Cause<unknown> }
      const reason = notFound.cause.reasons.find(Cause.isFailReason)
      expect(reason?.error).toMatchObject({ message: "incident not found: incident_missing" })
    }
  })
})
