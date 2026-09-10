import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"
import { readAcceptanceManifest } from "./acceptance.mjs"
import { assertPublicWorkshopMaterial, exportWorkshopRole } from "./delivery.mjs"
import { assertPublicCheckpointMaterial, auditCheckpointCitation, auditCheckpointCitations, auditCheckpointRepository, exportCheckpointBundle, exportCheckpointRepository, importCheckpointBundle, parseCheckpointCitations, sourceDefinesCitationSymbol } from "./export.mjs"
import { deliveryRoles } from "./manifest.mjs"

const root = resolve(import.meta.dirname, "../../..")
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
const makeWritable = path => { if (!existsSync(path)) return; const entry = lstatSync(path); chmodSync(path, entry.isDirectory() ? 0o700 : 0o600); if (entry.isDirectory()) for (const child of readdirSync(path)) makeWritable(join(path, child)) }
const temporary = fn => { const parent = mkdtempSync(join(tmpdir(), "bw-checkpoints-")); try { return fn(parent) } finally { makeWritable(parent); rmSync(parent, { recursive: true, force: true }) } }

test("declares learner, live-instructor, and maintainer delivery roles", () => {
  assert.deepEqual(Object.keys(deliveryRoles), ["learner", "live-instructor", "maintainer"])
  assert.equal(deliveryRoles["live-instructor"].extends, "learner"); assert.equal(deliveryRoles.maintainer.extends, "live-instructor")
})

test("maps every canonical defect to one owner acceptance selector", () => {
  const rows = readAcceptanceManifest(root)
  assert.equal(rows.length, 73)
  assert.equal(new Set(rows.map(row => row.id)).size, 73)
})

test("privacy scans reject solution and defect-trigger language without blocking neutral curriculum", () => {
  for (const phrase of ["broken on purpose", "planted defect", "hidden bug trigger", "completed Effect implementation", "trigger recipe", "private acceptance selector", "workshop/beaconwatch/checkpoints/acceptance"]) {
    assert.throws(() => assertPublicWorkshopMaterial("lesson.md", phrase), /private material/)
    assert.throws(() => assertPublicCheckpointMaterial("lesson.md", phrase), /forbidden content/)
  }
  const neutral = "Complete the Effect exercise, observe the public failure, and learn how hidden implementation details stay encapsulated."
  assert.doesNotThrow(() => assertPublicWorkshopMaterial("book/modules/module-03.md", neutral))
  assert.doesNotThrow(() => assertPublicCheckpointMaterial("test/checkpoint-03/public.test.ts", neutral))
})

test("exports role-safe learner, instructor, and maintainer artifacts", { timeout: 120_000 }, () => temporary(parent => {
  const learner = join(parent, "learner"), instructor = join(parent, "instructor"), maintainer = join(parent, "maintainer")
  exportWorkshopRole(root, learner, "learner", { allowDirty: true, throughModule: "00" })
  exportWorkshopRole(root, instructor, "live-instructor", { allowDirty: true, throughModule: "00" })
  exportWorkshopRole(root, maintainer, "maintainer", { allowDirty: true, throughModule: "00" })
  assert.equal(readFileSync(join(learner, "SPEC.md"), "utf8").startsWith("# BeaconWatch"), true)
  const learnerManifest = JSON.parse(readFileSync(join(learner, "corpus-manifest.json"), "utf8")); assert.equal(learnerManifest.files.some(file => file.path === "SPEC.md"), true)
  assert.equal(readFileSync(join(instructor, "instructor/README.md"), "utf8").startsWith("# Instructor notebook guide"), true)
  assert.equal(existsSync(join(instructor, "instructor/module-16/module-16.walkthrough.md")), false)
  assert.equal(readFileSync(join(maintainer, "maintainer/beaconwatch-defect-injection-manifest.md"), "utf8").includes("DP-73"), true)
  assert.equal(readFileSync(join(maintainer, "maintainer/effect/package.json"), "utf8").includes('"effect"'), true)
  assert.equal(existsSync(join(learner, "instructor")), false)
  assert.equal(existsSync(join(instructor, "maintainer")), false)
  assert.notEqual(process.getuid?.(), 0, "writability check must run as an ordinary user")
  for (const path of [
    join(learner, "book/intro.md"),
    join(instructor, "notebooks/package-lock.json"),
    join(maintainer, "maintainer/effect/package.json"),
  ]) assert.notEqual(lstatSync(path).mode & 0o200, 0, `${path} must be owner-writable`)
  writeFileSync(join(instructor, "instructor/session-notes.md"), "# Session notes\n")
  execFileSync("npm", ["ci", "--ignore-scripts"], { cwd: join(instructor, "notebooks"), stdio: "ignore" })
  const smoke = execFileSync("node", ["checkpoints/acceptance.mjs", "--smoke"], { cwd: join(maintainer, "maintainer"), encoding: "utf8" })
  assert.deepEqual(JSON.parse(smoke), { selectors: 1, checkpoints: 1, smoke: true })
}))

test("exports deterministic two-commit module transitions at the opening", () => temporary(parent => {
  const a = join(parent, "a"), b = join(parent, "b"); exportCheckpointRepository(root, a, "02", { allowDirty: true }); exportCheckpointRepository(root, b, "02", { allowDirty: true })
  assert.equal(git(a, ["rev-list", "--count", "bw-module-02-complete"]), "6")
  assert.equal(git(a, ["rev-parse", "HEAD"]), git(a, ["rev-parse", "bw-module-02-start"]))
  assert.notEqual(git(a, ["rev-parse", "bw-module-01-complete"]), git(a, ["rev-parse", "bw-module-02-start"]))
  assert.equal(git(a, ["rev-parse", "bw-module-02-complete"]), git(b, ["rev-parse", "bw-module-02-complete"]))
  assert.match(JSON.parse(readFileSync(join(a, "package.json"), "utf8")).scripts["checkpoint:02"], /checkpoint-02/)
  assert.equal(auditCheckpointRepository(a, "02").refs.length, 7)
}))

test("audits documented paths and symbols at their cited checkpoint", () => temporary(parent => {
  const app = join(parent, "app")
  exportCheckpointRepository(root, app, "16", { allowDirty: true })
  assert.doesNotThrow(() => auditCheckpointCitations(root, app))
  assert.throws(
    () => auditCheckpointCitation(app, { module: "12", edge: "outgoing", path: "src/services/Missing.ts", symbol: "historyRows" }),
    /citation path does not exist/,
  )
  assert.throws(
    () => auditCheckpointCitation(app, { module: "11", edge: "outgoing", path: "src/services/DigestService.ts", symbol: "historyRows" }),
    /citation symbol does not exist/,
  )
  assert.throws(
    () => auditCheckpointCitation(app, { module: "00", edge: "incoming", path: "src/watch/StatusState.ts", symbol: "StatusState.complete" }),
    /citation symbol does not exist/,
  )
  assert.equal(sourceDefinesCitationSymbol('// ghost\nconst text = "ghost"', "ghost"), false)
  assert.equal(sourceDefinesCitationSymbol("class Owner {} class Other { member() {} }", "Owner.member"), false)
  assert.equal(sourceDefinesCitationSymbol("class Other { static member() {} } class Owner { value = Other.member() }", "Owner.member"), false)
  assert.equal(sourceDefinesCitationSymbol('import { original as renamed } from "pkg"', "original"), false)
  assert.equal(sourceDefinesCitationSymbol("function outer() { const nested = 1 }", "nested"), false)
  assert.equal(sourceDefinesCitationSymbol("function outer() { class Owner { member() {} } }", "Owner.member"), false)
  assert.equal(sourceDefinesCitationSymbol("const Alias = class Owner { member() {} };", "Owner.member"), false)
  assert.equal(sourceDefinesCitationSymbol("const run = function hidden() {};", "hidden"), false)
  assert.equal(sourceDefinesCitationSymbol("const Alias =\nclass Owner { member() {} };", "Owner.member"), false)
  assert.equal(sourceDefinesCitationSymbol("const run =\nfunction hidden() {};", "hidden"), false)
  assert.equal(sourceDefinesCitationSymbol("const Alias =\n\nclass Owner { member() {} };", "Owner.member"), false)
  assert.equal(sourceDefinesCitationSymbol("const run =\n// explanation\nfunction hidden() {};", "hidden"), false)
  assert.equal(sourceDefinesCitationSymbol("const value = make()\nclass Owner { member() {} }", "Owner.member"), true)
  assert.equal(sourceDefinesCitationSymbol('const value = "done"\nclass Owner { member() {} }', "Owner.member"), true)
  assert.equal(sourceDefinesCitationSymbol("const value = 1\nfunction visible() {}", "visible"), true)
  assert.equal(sourceDefinesCitationSymbol('import Default, { direct, original as renamed } from "pkg"', "renamed"), true)
  assert.equal(sourceDefinesCitationSymbol("class Owner { async member<T>() {} }", "Owner.member"), true)
  assert.throws(
    () => parseCheckpointCitations("`real`\n{/* beaconwatch-citation: outgoing src/real.ts#real */}\n{/* beaconwatch-citation: later src/fake.ts#fake */}", "00"),
    /malformed BeaconWatch checkpoint citation/,
  )
}))

test("every opening pack fails for focused behavior and passes unchanged at completion", { timeout: 120_000 }, () => temporary(parent => {
  const app = join(parent, "app"); exportCheckpointRepository(root, app, "16", { allowDirty: true }); execFileSync("npm", ["ci", "--ignore-scripts"], { cwd: app, stdio: "ignore" })
  for (let index = 0; index <= 16; index++) {
    const module = String(index).padStart(2, "0")
    git(app, ["checkout", "-q", `bw-module-${module}-start`])
    const opening = spawnSync("npx", ["vitest", "run", `test/checkpoint-${module}`], { cwd: app, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } })
    const output = `${opening.stdout}\n${opening.stderr}`
    if (module === "00") {
      assert.equal(opening.status, 0)
      assert.match(output, /Tests\s+2 passed/)
    } else {
      assert.notEqual(opening.status, 0)
      assert.match(output, /Tests\s+[12] failed/)
      assert.doesNotMatch(output, /Failed to resolve import|does not provide an export|Tests\s+no tests/)
    }
    git(app, ["checkout", "-q", `bw-module-${module}-complete`])
    const paths = git(app, ["ls-tree", "-r", "--name-only", `bw-module-${module}-start`, `test/checkpoint-${module}`]).split("\n").filter(Boolean)
    for (const path of paths) {
      assert.equal(git(app, ["show", `bw-module-${module}-start:${path}`]), git(app, ["show", `bw-module-${module}-complete:${path}`]), `${path} changed between opening and completion`)
    }
    const completion = spawnSync("npx", ["vitest", "run", `test/checkpoint-${module}`], { cwd: app, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } })
    assert.equal(completion.status, 0, `module ${module} completion failed:\n${completion.stdout}\n${completion.stderr}`)
  }
}))

test("every cumulative checkpoint command passes at its canonical completion", { timeout: 300_000 }, () => temporary(parent => {
  const app = join(parent, "app"); exportCheckpointRepository(root, app, "16", { allowDirty: true })
  let installedLockfile
  for (let index = 0; index <= 16; index++) {
    const module = String(index).padStart(2, "0")
    git(app, ["checkout", "-q", `bw-module-${module}-complete`])
    const lockfile = readFileSync(join(app, "package-lock.json"), "utf8")
    if (lockfile !== installedLockfile) {
      execFileSync("npm", ["ci", "--ignore-scripts"], { cwd: app, stdio: "ignore" })
      installedLockfile = lockfile
    }
    const completion = spawnSync("npm", ["run", `checkpoint:${module}`], { cwd: app, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } })
    assert.equal(completion.status, 0, `checkpoint:${module} failed at canonical completion:\n${completion.stdout}\n${completion.stderr}`)
  }
}))

test("incremental bundle refuses a missing prerequisite and imports exact canonical ids", () => temporary(parent => {
  const previous = join(parent, "previous"), canonical = join(parent, "canonical"), bundle = join(parent, "01.bundle")
  exportCheckpointRepository(root, previous, "00", { allowDirty: true }); exportCheckpointRepository(root, canonical, "01", { allowDirty: true }); exportCheckpointBundle(root, bundle, "01", { allowDirty: true })
  const empty = join(parent, "empty"); git(parent, ["init", "-q", "-b", "main", empty]); assert.throws(() => importCheckpointBundle(empty, bundle, "01"), /missing prerequisite/)
  writeFileSync(join(previous, "learner-note"), "retained\n"); git(previous, ["add", "learner-note"]); git(previous, ["commit", "-q", "-m", "Retain learner work"])
  const learnerTip = git(previous, ["rev-parse", "main"])
  const result = importCheckpointBundle(previous, bundle, "01")
  assert.equal(result.head, git(canonical, ["rev-parse", "bw-module-01-start"])); assert.equal(result.complete, git(canonical, ["rev-parse", "bw-module-01-complete"]))
  assert.equal(git(previous, ["rev-parse", "main"]), learnerTip)
  assert.equal(git(previous, ["branch", "--show-current"]), "bw-module-01-work")
  assert.equal(readFileSync(join(previous, ".git", "checkpoint-module"), "utf8"), "01\n")
}))

test("refuses unsafe output and dirty exported repositories", () => temporary(parent => {
  assert.throws(() => exportCheckpointRepository(root, join(root, "unsafe"), 0, { allowDirty: true }), /outside/)
  const output = join(parent, "app"); exportCheckpointRepository(root, output, 0, { allowDirty: true }); writeFileSync(join(output, "dirty"), "x"); assert.throws(() => auditCheckpointRepository(output), /dirty/)
}))
