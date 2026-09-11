import { Effect } from "effect";
import { importHistoryEffect } from "../services/DigestService.js";

export async function runCli(argv: readonly string[]) {
  const [command, arg] = argv;
  if (command === undefined) return "beaconwatch";
  if (command === "demo") return "demo";
  if (command === "check" && arg) return `checked ${arg}`;
  if (command === "serve") return "serve";
  if (command === "import-history" && arg) return Effect.runPromise(importHistoryEffect(arg));
  if (command === "digest") return "digest";
  throw new TypeError("usage: beaconwatch [demo|check <config>|serve|import-history <file>|digest]");
}
