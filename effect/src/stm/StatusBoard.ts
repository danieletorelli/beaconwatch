import { Effect, HashMap, Option, TxRef } from "effect"
import type { TargetId } from "../domain/schema.js"

export interface StatusBoardSnapshot {
  readonly globalDegradedCount: number
  readonly tagDegradedCounts: ReadonlyMap<string, number>
}

export interface StatusBoard {
  readonly openIncident: (targetId: TargetId, tag: string) => Effect.Effect<void>
  readonly openIncidentWhen: (targetId: TargetId, tag: string, gate: TxRef.TxRef<boolean>, afterCommit: Effect.Effect<void>) => Effect.Effect<void>
  readonly closeIncident: (targetId: TargetId) => Effect.Effect<void>
  readonly snapshot: Effect.Effect<StatusBoardSnapshot>
}

interface TargetStatus {
  readonly tag: string
}

/** Required narrow STM repair: `TxRef`s keep target, tag, and global degraded
 * counts in one `Effect.tx` transition; irreversible notifications belong after commit.
 */
export const make = Effect.gen(function*() {
  const targetStatuses = yield* TxRef.make(HashMap.empty<TargetId, TargetStatus>())
  const tagCounts = yield* TxRef.make(HashMap.empty<string, number>())
  const globalCount = yield* TxRef.make(0)

  const getCount = (counts: HashMap.HashMap<string, number>, tag: string) =>
    Option.getOrElse(HashMap.get(counts, tag), () => 0)

  const incrementTag = (tag: string) => TxRef.update(tagCounts, (counts) =>
    HashMap.set(counts, tag, getCount(counts, tag) + 1)
  )
  const decrementTag = (tag: string) => TxRef.update(tagCounts, (counts) => {
    const current = getCount(counts, tag)
    return current <= 1 ? HashMap.remove(counts, tag) : HashMap.set(counts, tag, current - 1)
  })

  const openIncident = (targetId: TargetId, tag: string) => Effect.tx(Effect.gen(function*() {
    const statuses = yield* TxRef.get(targetStatuses)
    const existing = HashMap.get(statuses, targetId)
    if (existing._tag === "Some") {
      if (existing.value.tag === tag) return
      yield* decrementTag(existing.value.tag)
    } else {
      yield* TxRef.update(globalCount, (n) => n + 1)
    }
    yield* incrementTag(tag)
    yield* TxRef.set(targetStatuses, HashMap.set(statuses, targetId, { tag }))
  })).pipe(Effect.andThen(Effect.void))

  const openIncidentWhen = (targetId: TargetId, tag: string, gate: TxRef.TxRef<boolean>, afterCommit: Effect.Effect<void>) =>
    Effect.tx(Effect.gen(function*() {
      if (!(yield* TxRef.get(gate))) return yield* Effect.txRetry
      const statuses = yield* TxRef.get(targetStatuses)
      const existing = HashMap.get(statuses, targetId)
      if (Option.isSome(existing)) {
        if (existing.value.tag === tag) return
        yield* decrementTag(existing.value.tag)
      } else {
        yield* TxRef.update(globalCount, (n) => n + 1)
      }
      yield* incrementTag(tag)
      yield* TxRef.set(targetStatuses, HashMap.set(statuses, targetId, { tag }))
    })).pipe(Effect.andThen(afterCommit))

  const closeIncident = (targetId: TargetId) => Effect.tx(Effect.gen(function*() {
    const statuses = yield* TxRef.get(targetStatuses)
    const existing = HashMap.get(statuses, targetId)
    if (existing._tag === "None") return
    yield* decrementTag(existing.value.tag)
    yield* TxRef.update(globalCount, (n) => n - 1)
    yield* TxRef.set(targetStatuses, HashMap.remove(statuses, targetId))
  })).pipe(Effect.andThen(Effect.void))

  const snapshot = Effect.tx(Effect.gen(function*() {
    const globalDegradedCount = yield* TxRef.get(globalCount)
    const counts = yield* TxRef.get(tagCounts)
    return { globalDegradedCount, tagDegradedCounts: new Map(HashMap.toEntries(counts)) }
  }))

  return { openIncident, openIncidentWhen, closeIncident, snapshot } satisfies StatusBoard
})
