import { Effect, Layer, ManagedRuntime } from "effect"
import { InMemory as CheckRepositoryInMemory } from "../repo/CheckRepository.js"
import { Live as IncidentServiceLive } from "../services/IncidentService.js"
import { Fake as IncidentSummarizerFake } from "../services/IncidentSummarizer.js"

export const AppLayer = Layer.mergeAll(CheckRepositoryInMemory, IncidentServiceLive, IncidentSummarizerFake())
export const runtime = ManagedRuntime.make(AppLayer)
export type AppServices = ManagedRuntime.ManagedRuntime.Services<typeof runtime>
export const runPromise = <A, E>(effect: Effect.Effect<A, E, AppServices>) => runtime.runPromise(effect)
export const dispose = () => runtime.dispose()
