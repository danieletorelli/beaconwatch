import { Context, Effect, Layer } from "effect"
import type { CheckResult } from "../domain/schema.js"
import { CheckRepository, type IncidentTransition } from "../repo/CheckRepository.js"

export interface IncidentServiceShape { readonly applyCheck: (check: CheckResult) => Effect.Effect<IncidentTransition, import("../domain/errors.js").RepositoryError, CheckRepository> }
export class IncidentService extends Context.Service<IncidentService, IncidentServiceShape>()("beaconwatch/IncidentService") {}

export const Live = Layer.succeed(IncidentService)({
  applyCheck: (check) => Effect.gen(function*() {
    const repo = yield* CheckRepository
    return yield* repo.applyCheck(check)
  })
})
