import { NodeRuntime } from "@effect/platform-node"
import { main } from "./main.js"

// Part 15.1 — the process edge. This is the ONE place that hands the app
// program to the platform runtime. Kept deliberately tiny and untested: the
// testable wiring lives in `main.ts`.
NodeRuntime.runMain(main(process.env, process.argv.slice(2)))
