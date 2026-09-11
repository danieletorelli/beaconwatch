import { InMemoryCheckRepository } from "../repo/CheckRepository.js";
import { IncidentService } from "../services/IncidentService.js";
import { Fake } from "../services/IncidentSummarizer.js";
export class ManagedAppRuntime {
  static acquired = 0;
  static released = 0;
  readonly repository = new InMemoryCheckRepository();
  readonly incidents = new IncidentService(this.repository);
  readonly summarizer = Fake();
  private disposed = false;
  constructor() { ManagedAppRuntime.acquired++; }
  async runPromise<A>(work: (services: this) => Promise<A>) {
    if (this.disposed) throw new Error("runtime disposed");
    return work(this);
  }
  async dispose() {
    if (!this.disposed) ManagedAppRuntime.released++;
    this.disposed = true;
  }
}
export const runtime = new ManagedAppRuntime();
export const runPromise = <A>(work: (s: ManagedAppRuntime) => Promise<A>) =>
  runtime.runPromise(work);
export const dispose = () => runtime.dispose();
export const AppLayer = runtime;
