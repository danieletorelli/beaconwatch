import { Effect, Layer, ManagedRuntime } from "effect";
import { InMemoryLayer as CheckRepositoryInMemory } from "../repo/CheckRepository.js";
import { IncidentServiceLive } from "../services/IncidentService.js";
import { FakeLayer as IncidentSummarizerFakeLayer } from "../services/IncidentSummarizer.js";

/**
 * Part 15 — the single application boundary.
 *
 * Everything the app needs is wired into ONE layer here; the program is an
 * ordinary `Effect` value. Nothing runs at import time — `src/bin.ts` is the
 * only place that hands programs to the runtime. That keeps the wiring
 * testable while the process edge stays a tiny untested boundary.
 */
export const AppLayer = Layer.mergeAll(
  CheckRepositoryInMemory,
  // The service consumes the repository from its R channel; the volatile
  // implementation is provided to it and kept in the composition.
  Layer.provide(IncidentServiceLive, CheckRepositoryInMemory),
  IncidentSummarizerFakeLayer(),
);
export const runtime = ManagedRuntime.make(AppLayer);
export const runPromise = <A, E>(
  effect: Effect.Effect<A, E, never>,
): Promise<A> => runtime.runPromise(effect);
export const dispose = () => runtime.dispose();
