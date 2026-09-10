import { it } from "@effect/vitest"
import { Effect } from "effect"
import { make } from "../../src/testkit/MockTargetServer.js"

it.effect("starts and finalizes a scoped local server", () => Effect.gen(function*() {
  let url = ""
  yield* Effect.scoped(Effect.gen(function*() {
    const server = yield* make
    url = `${server.baseUrl}/ok`
    const text = yield* Effect.tryPromise(() => fetch(url).then((r) => r.text()))
    if (!text.includes("ok")) throw new Error("route failed")
  }))
  const exit = yield* Effect.exit(Effect.tryPromise(() => fetch(url)))
  if (exit._tag !== "Failure") throw new Error("server still reachable after scope")
}))
