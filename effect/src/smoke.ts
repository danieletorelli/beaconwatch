import { Effect } from "effect"

export const greet = (name: string): Effect.Effect<string> =>
  Effect.sync(() => `hello ${name}`)
