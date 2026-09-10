import { describe, expect, it } from "vitest"
import { Effect, Fiber, Schema, TxRef } from "effect"
import * as StatusBoard from "../../src/stm/StatusBoard.js"
import { TargetId } from "../../src/domain/schema.js"

describe("StatusBoard", () => {
  it("counts repeated concurrent opens for one target exactly once", async () => {
    const snapshot = await Effect.runPromise(Effect.gen(function*() {
      const board = yield* StatusBoard.make
      const targetId = Schema.decodeSync(TargetId)("target_duplicate_open")
      yield* Effect.all(
        Array.from({ length: 32 }, () => board.openIncident(targetId, "edge")),
        { concurrency: "unbounded", discard: true }
      )
      return yield* board.snapshot
    }))

    expect(snapshot.globalDegradedCount).toBe(1)
    expect(snapshot.tagDegradedCounts.get("edge")).toBe(1)
  })

  it("preserves the global equals per-tag degraded-count invariant under concurrent transitions", async () => {
    const snapshot = await Effect.runPromise(Effect.gen(function*() {
      const board = yield* StatusBoard.make
      const targetId = (n: number) => `target_${n}` as TargetId
      const transitions = Array.from({ length: 80 }, (_, n) => Effect.gen(function*() {
        yield* board.openIncident(targetId(n % 20), n % 2 === 0 ? "edge" : "origin")
        if (n % 3 === 0) {
          yield* board.openIncident(targetId(n % 20), "database")
        }
        if (n % 4 === 0) {
          yield* board.closeIncident(targetId(n % 20))
        }
      }))

      yield* Effect.all(transitions, { concurrency: "unbounded", discard: true })
      return yield* board.snapshot
    }))

    const tagSum = Array.from(snapshot.tagDegradedCounts.values()).reduce((sum, n) => sum + n, 0)
    expect(snapshot.globalDegradedCount).toBe(tagSum)
  })

  it("retries on contention, runs post-commit work once, and interruption leaves no partial edit", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const board = yield* StatusBoard.make
      const id = Schema.decodeSync(TargetId)("target_gate")
      const gate = yield* TxRef.make(false).pipe(Effect.tx)
      let delivered = 0
      const blocked = yield* Effect.forkChild(board.openIncidentWhen(id, "edge", gate, Effect.sync(() => { delivered++ })))
      yield* Effect.yieldNow
      expect(delivered).toBe(0)
      yield* Fiber.interrupt(blocked)
      expect((yield* board.snapshot).globalDegradedCount).toBe(0)

      const retrying = yield* Effect.forkChild(board.openIncidentWhen(id, "edge", gate, Effect.sync(() => { delivered++ })))
      yield* TxRef.set(gate, true).pipe(Effect.tx)
      yield* Fiber.join(retrying)
      expect(delivered).toBe(1)
      expect((yield* board.snapshot).globalDegradedCount).toBe(1)
    }))
  })
})
