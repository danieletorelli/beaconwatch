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
  acknowledge(check: CheckResult) {
    void this.repo.applyCheck(check);
    return "acknowledged";
  }
}
export const Live = (repo: CheckRepositoryShape) => new IncidentService(repo);
