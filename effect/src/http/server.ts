import { Effect, Layer, Option } from "effect"
import { NodeHttpServer } from "@effect/platform-node"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { createServer } from "node:http"
import { CheckRepository } from "../repo/CheckRepository.js"
import type { CheckResult, Incident, Target } from "../domain/schema.js"
import { BeaconWatchApi } from "./api.js"

const apiError = (message: string) => ({ message })
const toTargetDto = (target: Target) => ({ id: target.id, name: target.name, url: target.url, enabled: target.enabled })
const toIncidentDto = (incident: Incident) => ({ id: incident.id, targetId: incident.targetId, status: incident.status, reason: incident.reason })
const toCheckDto = (check: CheckResult) => ({ id: check.id, targetId: check.targetId, classification: check.classification._tag })

export const ApiHandlers = HttpApiBuilder.group(BeaconWatchApi, "default", (handlers) =>
  handlers
    .handle("getTargets", () => Effect.gen(function*() {
      const repo = yield* CheckRepository
      const targets = yield* repo.listTargets().pipe(
        Effect.mapError(() => apiError("failed to list targets"))
      )
      return targets.map(toTargetDto)
    }).pipe(
      Effect.mapError(() => apiError("failed to list targets"))
    ))
    .handle("getStatus", () => Effect.gen(function*() {
      const repo = yield* CheckRepository
      const targets = yield* repo.listTargets().pipe(
        Effect.mapError(() => apiError("failed to read status"))
      )
      return { ok: true, targets: targets.length }
    }))
    .handle("getIncident", ({ params }) => Effect.gen(function*() {
      const repo = yield* CheckRepository
      const maybe = yield* repo.getIncident(params.id).pipe(
        Effect.mapError(() => apiError("failed to read incident"))
      )
      if (Option.isSome(maybe)) return toIncidentDto(maybe.value)
      return yield* Effect.fail(apiError(`incident not found: ${params.id}`))
    }) )
    .handle("getChecks", () => Effect.gen(function*() {
      const repo = yield* CheckRepository
      const checks = yield* repo.listChecks().pipe(
        Effect.mapError(() => apiError("failed to list checks"))
      )
      return checks.map(toCheckDto)
    }))
)

export const ApiRoutes = HttpApiBuilder.layer(BeaconWatchApi, { openapiPath: "/openapi.json" }).pipe(
  Layer.provide(ApiHandlers)
)

/** Production Node binding; endpoint routing, request decoding, response encoding,
 * and OpenAPI all come from BeaconWatchApi. */
export const nodeServerLayer = (port: number) => HttpRouter.serve(ApiRoutes).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { port }))
)
