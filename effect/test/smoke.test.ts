import { it } from "@effect/vitest"
import { Effect } from "effect"
import { greet } from "../src/smoke.js"

it.effect("greet builds and runs", () =>
  Effect.gen(function* () {
    const result = yield* greet("beaconwatch")
    yield* Effect.sync(() => {
      if (result !== "hello beaconwatch") throw new Error(`got ${result}`)
    })
  })
)
