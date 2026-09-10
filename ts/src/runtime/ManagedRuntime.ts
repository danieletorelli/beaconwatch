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
export const runtimeForRequest = () => new ManagedAppRuntime();
export const runRequestChild = async <A>(
  runtime: ManagedAppRuntime,
  work: (services: ManagedAppRuntime, signal: AbortSignal) => Promise<A>,
  signal: AbortSignal,
) => {
  const child = new AbortController();
  const running = runtime.runPromise((services) => work(services, child.signal));
  const cancelled = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  return Promise.race([running, cancelled]);
};
export class RequestRuntimeHost {
  private runtimes = new Set<ManagedAppRuntime>();
  async handle<A>(work: (s: ManagedAppRuntime, signal: AbortSignal) => Promise<A>, signal = new AbortController().signal) {
    const requestRuntime = runtimeForRequest();
    this.runtimes.add(requestRuntime);
    return runRequestChild(requestRuntime, work, signal);
  }
  async shutdown() {
    await runtime.dispose();
  }
}
export const runPromise = <A>(work: (s: ManagedAppRuntime) => Promise<A>) =>
  runtime.runPromise(work);
export const dispose = () => runtime.dispose();
export const AppLayer = runtime;
