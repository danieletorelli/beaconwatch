import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { Command } from "effect/unstable/cli"
import { NodeServices } from "@effect/platform-node"
import { cli, commandHandlers } from "../../src/cli/cli.js"

describe("cli handlers", () => {
  it("runs digest handler", async () => {
    await expect(Effect.runPromise(commandHandlers.digest)).resolves.toBe("digest")
  })

  it("parses and dispatches real CLI arguments", async () => {
    const run = Command.runWith(cli, { version: "0.0.0" })
    await expect(Effect.runPromise(run(["check", "config.json"]).pipe(Effect.provide(NodeServices.layer), Effect.scoped))).resolves.toBeUndefined()

    const missingArgument = await Effect.runPromise(Effect.exit(run(["check"])).pipe(Effect.provide(NodeServices.layer), Effect.scoped))
    expect(Exit.isFailure(missingArgument)).toBe(true)
  })
})
