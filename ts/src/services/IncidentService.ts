import { Context, Effect, Layer } from "effect";
import type { CheckResult } from "../domain/schema.js";
import type { IncidentTransition } from "../repo/CheckRepository.js";
import { CheckRepository } from "../repo/CheckRepository.js";
import { RepositoryError } from "../domain/errors.js";

export interface IncidentServiceShape {
  readonly applyCheck: (
    check: CheckResult,
  ) => Effect.Effect<IncidentTransition, RepositoryError>;
  readonly acknowledge: (
    check: CheckResult,
  ) => Effect.Effect<IncidentTransition, RepositoryError>;
}
export class IncidentService extends Context.Service<IncidentService, IncidentServiceShape>()("beaconwatch/IncidentService") {}

export const IncidentServiceLive = Layer.effect(IncidentService)(
  Effect.gen(function*() {
    const repo = yield* CheckRepository;
    return {
      applyCheck: (check) => repo.applyCheck(check),
      // Acknowledging a check is a settled effect: the repository failure is
      // typed, never discarded (BUGS 4.1).
      acknowledge: (check) => repo.applyCheck(check),
    };
  }),
);
