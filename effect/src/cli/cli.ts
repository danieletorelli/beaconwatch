import { Effect, Schema } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import { importHistory } from "../services/DigestService.js"

const PathArg = Argument.string("file").pipe(Argument.withSchema(Schema.String.check(Schema.isMinLength(1))))
const ConfigArg = Argument.string("config").pipe(Argument.withSchema(Schema.String.check(Schema.isMinLength(1))))

export const commandHandlers = {
  demo: Effect.succeed("demo"),
  check: (config: string) => Effect.succeed(`checked ${config}`),
  serve: Effect.succeed("serve"),
  importHistory: (file: string) => importHistory(file),
  digest: Effect.succeed("digest")
}

export const cli = Command.make("beaconwatch", {}, () => Effect.succeed("beaconwatch")).pipe(
  Command.withSubcommands([
    Command.make("demo", {}, () => commandHandlers.demo),
    Command.make("check", { config: ConfigArg }, ({ config }) => commandHandlers.check(config)),
    Command.make("serve", {}, () => commandHandlers.serve),
    Command.make("import-history", { file: PathArg }, ({ file }) => commandHandlers.importHistory(file)),
    Command.make("digest", {}, () => commandHandlers.digest)
  ])
)
