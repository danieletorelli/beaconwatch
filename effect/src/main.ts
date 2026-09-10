import { Effect, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"
import { Command } from "effect/unstable/cli"
import { InMemory } from "./repo/CheckRepository.js"
import { tempLayer } from "./repo/SqliteCheckRepository.js"
import { cli } from "./cli/cli.js"

/**
 * Part 15.1 — the single application boundary.
 *
 * Everything the app needs is wired into ONE layer here; the program is an
 * ordinary `Effect` value. Nothing runs at import time — `src/bin.ts` is the
 * only place that hands this program to the platform runtime (`runMain`). That
 * keeps the wiring testable (build the layer / run the program under a test
 * runtime) while the actual process edge stays a tiny untested boundary.
 */
export type RepositoryChoice = "memory" | "sqlite"

export const repositoryChoice = (env: Record<string, string | undefined>): RepositoryChoice =>
  env.BEACONWATCH_REPOSITORY === "sqlite" ? "sqlite" : "memory"

export const buildAppLayer = (choice: RepositoryChoice, sqliteLayer = tempLayer) =>
  Layer.mergeAll(choice === "sqlite" ? sqliteLayer() : InMemory)

/** Parse and run the real command surface under the chosen repository. */
export const main = (
  env: Record<string, string | undefined> = process.env,
  argv: ReadonlyArray<string> = [],
) => Command.runWith(cli, { version: "0.1.0" })(argv).pipe(
  Effect.provide(Layer.mergeAll(buildAppLayer(repositoryChoice(env)), NodeServices.layer)),
  Effect.scoped,
)
