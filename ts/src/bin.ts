import { Effect } from "effect";
import { main } from "./main.js";

// The only process edge: hand the program to the runtime and map failures to
// an exit code. Everything else stays testable Effect values.
Effect.runFork(main(process.env, process.argv.slice(2)).pipe(
  Effect.tapCause((cause) =>
    Effect.sync(() => {
      console.error(cause);
      process.exitCode = 1;
    }),
  ),
));
