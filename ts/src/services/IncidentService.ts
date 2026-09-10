import { Effect } from "effect";
import type { CheckResult } from "../domain/schema.js";
import type {
  CheckRepositoryShape,
  IncidentTransition,
} from "../repo/CheckRepository.js";
export class IncidentService {
  constructor(private repo: CheckRepositoryShape) {}
  applyCheck(check: CheckResult): Promise<IncidentTransition> {
    return this.repo.applyCheck(check);
  }
  acknowledge(check: CheckResult): Effect.Effect<IncidentTransition, Error> {
    return Effect.tryPromise({
      try: () => this.repo.applyCheck(check),
      catch: (e) => e as Error,
    });
  }
}
export const Live = (repo: CheckRepositoryShape) => new IncidentService(repo);
