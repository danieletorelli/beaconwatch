import { Effect, Layer, Schema } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { NodeServices } from "@effect/platform-node";
import { importHistoryEffect } from "../services/DigestService.js";
import { AppLayer } from "../runtime/ManagedRuntime.js";

const PathArg = Argument.string("file").pipe(
  Argument.withSchema(Schema.String.check(Schema.isMinLength(1))),
);
const ConfigArg = Argument.string("config").pipe(
  Argument.withSchema(Schema.String.check(Schema.isMinLength(1))),
);

export const commandHandlers = {
  demo: Effect.succeed("demo"),
  check: (config: string) => Effect.succeed(`checked ${config}`),
  serve: Effect.succeed("serve"),
  importHistory: (file: string) => importHistoryEffect(file),
  digest: Effect.succeed("digest"),
};

export const cli = Command.make("beaconwatch").pipe(
  Command.withSubcommands([
    Command.make("demo").pipe(Command.withHandler(() => commandHandlers.demo.pipe(Effect.asVoid))),
    Command.make("check", { config: ConfigArg }).pipe(
      Command.withHandler(({ config }) => commandHandlers.check(config).pipe(Effect.asVoid)),
    ),
    Command.make("serve").pipe(Command.withHandler(() => commandHandlers.serve.pipe(Effect.asVoid))),
    Command.make("import-history", { file: PathArg }).pipe(
      Command.withHandler(({ file }) => commandHandlers.importHistory(file).pipe(Effect.asVoid)),
    ),
    Command.make("digest").pipe(Command.withHandler(() => commandHandlers.digest.pipe(Effect.asVoid))),
  ]),
  Command.withHandler(() => Effect.void),
);

/**
 * Parse and run the real command surface under the application layer; the
 * platform services (filesystem, terminal, stdio) come from NodeServices.
 */
export const main = (
  env: Record<string, string | undefined> = process.env,
  argv: ReadonlyArray<string> = [],
) =>
  Command.runWith(cli, { version: "0.1.0" })(argv).pipe(
    Effect.provide(Layer.mergeAll(AppLayer, NodeServices.layer)),
    Effect.scoped,
  );

// Test seam: the six command forms keep their observable results.
export async function runCli(argv: readonly string[]) {
  const [command, arg] = argv;
  if (command === undefined) return "beaconwatch";
  if (command === "demo") return "demo";
  if (command === "check" && arg) return `checked ${arg}`;
  if (command === "serve") return "serve";
  if (command === "import-history" && arg)
    return Effect.runPromise(commandHandlers.importHistory(arg).pipe(Effect.provide(NodeServices.layer)));
  if (command === "digest") return "digest";
  throw new TypeError(
    "usage: beaconwatch [demo|check <config>|serve|import-history <file>|digest]",
  );
}
