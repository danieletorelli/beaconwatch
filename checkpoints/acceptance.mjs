import { execFileSync, spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { exportCheckpointRepository } from "./export.mjs"
import { tagFor } from "./manifest.mjs"

const moduleNumber = owner => owner.slice(1)
const run = (cwd, command, args, options = {}) => execFileSync(command, args, { cwd, encoding: "utf8", stdio: options.quiet ? "ignore" : "pipe" })
const check = (cwd, args) => spawnSync("npx", ["vitest", "run", ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } })
const layoutFor = root => existsSync(join(root, "maintainer/checkpoint-app/.git"))
  ? {
      ledger: join(root, "maintainer/beaconwatch-migration-curriculum-ledger.md"),
      tests: join(root, "maintainer/checkpoints/acceptance"),
      app: join(root, "maintainer/checkpoint-app")
    }
  : {
      ledger: join(root, "research/beaconwatch-migration-curriculum-ledger.md"),
      tests: join(root, "workshop/beaconwatch/checkpoints/acceptance"),
      app: undefined
    }

export const readAcceptanceManifest = repositoryRoot => {
  const root = resolve(repositoryRoot), layout = layoutFor(root)
  const ledger = readFileSync(layout.ledger, "utf8")
  const match = ledger.match(/```csv\nid,owner\n([\s\S]*?)```/)
  if (!match) throw new Error("canonical acceptance CSV is missing")
  const rows = match[1].trim().split("\n").map(line => { const [id, owner] = line.split(","); return { id, owner } })
  if (rows.length !== 73 || new Set(rows.map(row => row.id)).size !== 73) throw new Error("canonical acceptance CSV must declare 73 unique defects")
  const tests = new Map()
  const source = layout.tests
  for (const directory of readdirSync(source, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    const file = join(source, directory.name, "defects.test.ts")
    const text = readFileSync(file, "utf8")
    for (const id of text.matchAll(/\bit(?:\.effect)?\("(DP-\d{2})"/g)) {
      if (tests.has(id[1])) throw new Error(`duplicate private selector ${id[1]}`)
      tests.set(id[1], { file, module: directory.name.slice("module-".length) })
    }
  }
  for (const row of rows) {
    const test = tests.get(row.id)
    if (!test) throw new Error(`missing private selector ${row.id}`)
    if (test.module !== moduleNumber(row.owner)) throw new Error(`${row.id} is filed under module ${test.module}, not ${row.owner}`)
  }
  if (tests.size !== rows.length) throw new Error("private selectors include IDs outside the canonical ledger")
  return rows.map(row => ({ ...row, ...tests.get(row.id) }))
}

export const verifyAcceptanceTransitions = (repositoryRoot, options = {}) => {
  const root = resolve(repositoryRoot), layout = layoutFor(root), allRows = readAcceptanceManifest(root)
  const rows = options.smoke ? allRows.slice(0, 1) : allRows
  const parent = mkdtempSync(join(tmpdir(), "bw-acceptance-")), app = join(parent, "app"), privateRoot = join(app, "test/private")
  try {
    if (layout.app) cpSync(layout.app, app, { recursive: true })
    else exportCheckpointRepository(root, app, "16", { allowDirty: true })
    mkdirSync(privateRoot, { recursive: true })
    for (const row of rows) {
      const destination = join(privateRoot, `module-${row.module}`, "defects.test.ts")
      mkdirSync(join(privateRoot, `module-${row.module}`), { recursive: true }); cpSync(row.file, destination)
    }
    run(app, "npm", ["ci", "--ignore-scripts"], { quiet: true })
    for (const row of rows) {
      const file = `test/private/module-${row.module}/defects.test.ts`, selector = `${row.id}$`
      run(app, "git", ["checkout", "-q", tagFor(row.module, "start")])
      const before = check(app, [file, "-t", selector])
      const beforeOutput = `${before.stdout}\n${before.stderr}`
      if (before.status === 0) throw new Error(`${row.id} already passes at ${tagFor(row.module, "start")}`)
      if (!/Tests\s+1 failed/.test(beforeOutput) || /Failed to resolve import|does not provide an export|Test Files\s+1 failed[^\n]*Tests\s+no tests/i.test(beforeOutput))
        throw new Error(`${row.id} does not fail through its behavioral assertion at owner start\n${beforeOutput}`)
      run(app, "git", ["checkout", "-q", tagFor(row.module, "complete")])
      const after = check(app, [file, "-t", selector])
      if (after.status !== 0) throw new Error(`${row.id} does not pass at ${tagFor(row.module, "complete")}\n${after.stdout}\n${after.stderr}`)
    }
    for (let module = 1; !options.smoke && module <= 16; module++) {
      const number = String(module).padStart(2, "0")
      run(app, "git", ["checkout", "-q", tagFor(number, "complete")])
      const files = [...new Set(rows.filter(row => Number(row.module) <= module).map(row => `test/private/module-${row.module}/defects.test.ts`))]
      const result = check(app, files)
      if (result.status !== 0) throw new Error(`accepted selectors regress at ${tagFor(number, "complete")}\n${result.stdout}\n${result.stderr}`)
    }
    return options.smoke
      ? { selectors: rows.length, checkpoints: 1, smoke: true }
      : { selectors: rows.length, checkpoints: 16 }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  const sourceRoot = resolve(import.meta.dirname, "../../.."), bundleRoot = resolve(import.meta.dirname, "../..")
  const root = existsSync(join(sourceRoot, "research/beaconwatch-migration-curriculum-ledger.md")) ? sourceRoot : bundleRoot
  console.log(JSON.stringify(verifyAcceptanceTransitions(root, { smoke: process.argv.includes("--smoke") }), null, 2))
}
