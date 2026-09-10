import { describe, expect, it } from "vitest"
import { Deferred, Effect, Fiber, FileSystem, Layer, Stream } from "effect"
import { buildAppLayer, main, repositoryChoice } from "../src/main.js"
import { CheckRepository } from "../src/repo/CheckRepository.js"
import { OutboxDelivery } from "../src/repo/SqliteCheckRepository.js"
import { commandHandlers } from "../src/cli/cli.js"

describe("Part 15.1 — application boundary", () => {
  it("selects the repository implementation from the environment", () => {
    expect(repositoryChoice({})).toBe("memory")
    expect(repositoryChoice({ BEACONWATCH_REPOSITORY: "sqlite" })).toBe("sqlite")
    expect(repositoryChoice({ BEACONWATCH_REPOSITORY: "other" })).toBe("memory")
  })

  it("builds an app layer that provides the CheckRepository service", async () => {
    const provided = await Effect.runPromise(
      Effect.scoped(CheckRepository.pipe(Effect.provide(buildAppLayer("memory"))))
    )
    expect(typeof provided.saveCheck).toBe("function")
    expect(typeof provided.listTargets).toBe("function")
  })

  it("selects the SQLite layer rather than the in-memory repository", async () => {
    let sqliteBuilt = false
    const sqlite = () => {
      sqliteBuilt = true
      return Layer.mergeAll(
        Layer.succeed(CheckRepository)({} as CheckRepository["Service"]),
        Layer.succeed(OutboxDelivery)({} as OutboxDelivery["Service"])
      )
    }
    await Effect.runPromise(Effect.scoped(CheckRepository.pipe(
      Effect.provide(buildAppLayer(repositoryChoice({ BEACONWATCH_REPOSITORY: "sqlite" }), sqlite))
    )))
    expect(sqliteBuilt).toBe(true)
  })

  it("propagates CLI import interruption to the filesystem stream", async () => {
    let finalized = false
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const fileSystem = FileSystem.makeNoop({
        stream: () => Stream.fromEffect(Deferred.succeed(started, undefined).pipe(Effect.as(new Uint8Array()))).pipe(
          Stream.concat(Stream.never),
          Stream.ensuring(Effect.sync(() => { finalized = true }))
        )
      })
      const fiber = yield* commandHandlers.importHistory("history.ndjson").pipe(
        Effect.provide(Layer.succeed(FileSystem.FileSystem, fileSystem)),
        Effect.forkScoped
      )
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
    })))
    expect(finalized).toBe(true)
  })

  it("runs the process command surface end to end under the in-memory wiring", async () => {
    // main() is an ordinary Effect value (nothing runs at import time); we can
    // run it directly under a test runtime.
    await expect(Effect.runPromise(main({}))).resolves.not.toThrow()
    await expect(Effect.runPromise(main({}, ["check", "config.json"]))).resolves.not.toThrow()
    await expect(Effect.runPromise(main({}, ["check"]))).rejects.toBeTruthy()
  })
})
