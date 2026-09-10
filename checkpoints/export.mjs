import { execFileSync } from "node:child_process"
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve, sep } from "node:path"
import { checkpointModules, deliveryRoles, FIXED_GIT_DATE, tagFor } from "./manifest.mjs"

const identity = { GIT_AUTHOR_NAME: "BeaconWatch Workshop", GIT_AUTHOR_EMAIL: "workshop@local.invalid", GIT_COMMITTER_NAME: "BeaconWatch Workshop", GIT_COMMITTER_EMAIL: "workshop@local.invalid", GIT_AUTHOR_DATE: FIXED_GIT_DATE, GIT_COMMITTER_DATE: FIXED_GIT_DATE, TZ: "UTC" }
const run = (cwd, args, options = {}) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...identity }, stdio: options.quiet ? "pipe" : ["ignore", "pipe", "pipe"] }).trim()
const tracked = (root, path) => run(root, ["ls-files", "--", path]).split("\n").filter(Boolean)
const moduleNumber = value => { const number = String(value).padStart(2, "0"); if (!checkpointModules.some(x => x.module === number)) throw new Error("module must be an integer from 00 through 16"); return number }
const forbiddenCheckpointMaterial = /(?:Amp-Thread-ID|workshop\/beaconwatch\/(?:effect|checkpoints\/acceptance)|research\/|checkpoints\/patches|DP-\d+|(?:defect|bug)[-_ ](?:injection|trigger|recipe)|(?:planted|injected|deliberately[-_ ]introduced)[-_ ](?:defect|bug|failure)|hidden[-_ ](?:defect|bug)[-_ ]trigger|broken[-_ ]on[-_ ]purpose|private[-_ ](?:ledger|manifest|acceptance|selector|test|pack)|(?:completed|complete|reference|solution)[-_ ]Effect[-_ ]implementation|(?:trigger|reproduction)[-_ ]recipe)/i

export const assertPublicCheckpointMaterial = (path, content) => {
  if (forbiddenCheckpointMaterial.test(path) || forbiddenCheckpointMaterial.test(content)) throw new Error(`forbidden content in checkpoint material ${path}`)
}

const copyTracked = (root, sourceRoot, target, filter = () => true) => {
  const files = tracked(root, sourceRoot).filter(filter)
  if (!files.length) throw new Error(`role source has no tracked files: ${sourceRoot}`)
  for (const file of files) {
    const entry = lstatSync(join(root, file)); if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`unsafe role source: ${file}`)
    const relative = file.slice(sourceRoot.length + 1), destination = join(target, relative)
    mkdirSync(dirname(destination), { recursive: true }); cpSync(join(root, file), destination)
  }
}

const changedByPatch = (root, patch) => run(root, ["apply", "--numstat", patch]).split("\n").filter(Boolean).map(row => row.split("\t").at(-1))
const openingPath = (path, module) => path === "package.json" || path === "package-lock.json" || path.startsWith(`test/checkpoint-${module}/`)
const openingTemplateRoot = "workshop/beaconwatch/checkpoints/opening-templates"
const migrationTemplateRoot = "workshop/beaconwatch/checkpoints/test-migrations"
const commit = (app, message, allowEmpty = false) => run(app, ["commit", "-q", ...(allowEmpty ? ["--allow-empty"] : []), "-m", message])
const citationPattern = /\{\/\* beaconwatch-citation: (incoming|outgoing) (src\/[A-Za-z0-9_./-]+)#([A-Za-z_$][A-Za-z0-9_$.]*) \*\/\}/g

const sourceTokens = source => {
  const tokens = []
  for (let index = 0; index < source.length;) {
    const char = source[index], next = source[index + 1]
    if (char === "/" && next === "/") { index = source.indexOf("\n", index + 2); if (index < 0) break; continue }
    if (char === "/" && next === "*") { index = source.indexOf("*/", index + 2); if (index < 0) break; index += 2; continue }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char
      for (index++; index < source.length; index++) {
        if (source[index] === "\\") { index++; continue }
        if (source[index] === quote) { index++; break }
      }
      tokens.push("#literal")
      continue
    }
    if (char === "\n") { tokens.push("\n"); index++; continue }
    const number = source.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?n?/)?.[0]
    if (number) { tokens.push("#literal"); index += number.length; continue }
    const identifier = source.slice(index).match(/^[A-Za-z_$][A-Za-z0-9_$]*/)?.[0]
    if (identifier) { tokens.push(identifier); index += identifier.length; continue }
    if ("{}();,.*=?:<>[]+-/&|!".includes(char)) tokens.push(char)
    index++
  }
  return tokens
}

const importDefines = (tokens, start, name) => {
  const end = tokens.indexOf("from", start + 1)
  if (end < 0) return false
  let cursor = start + 1
  if (tokens[cursor] === "type") cursor++
  if (/^[A-Za-z_$]/.test(tokens[cursor] ?? "") && tokens[cursor] !== "from") {
    if (tokens[cursor] === name) return true
    cursor++
    if (tokens[cursor] === ",") cursor++
  }
  if (tokens[cursor] === "*" && tokens[cursor + 1] === "as") return tokens[cursor + 2] === name
  if (tokens[cursor] !== "{") return false
  for (cursor++; cursor < end && tokens[cursor] !== "}";) {
    if (tokens[cursor] === "type") cursor++
    const imported = tokens[cursor++]
    const local = tokens[cursor] === "as" ? (cursor++, tokens[cursor++]) : imported
    if (local === name) return true
    while (cursor < end && tokens[cursor] !== "," && tokens[cursor] !== "}") cursor++
    if (tokens[cursor] === ",") cursor++
  }
  return false
}

const classDefinesMethod = (tokens, open, member) => {
  const modifiers = new Set(["public", "private", "protected", "static", "readonly", "async", "get", "set", "override", "abstract", "declare"])
  let cursor = open + 1
  while (cursor < tokens.length && tokens[cursor] !== "}") {
    while (tokens[cursor] === ";" || tokens[cursor] === "\n") cursor++
    while (modifiers.has(tokens[cursor])) { cursor++; while (tokens[cursor] === "\n") cursor++ }
    const candidate = tokens[cursor++]
    if (!candidate || candidate === "}") break
    while (tokens[cursor] === "\n") cursor++
    if (tokens[cursor] === "?") cursor++
    if (tokens[cursor] === "<") {
      let angles = 0
      do { if (tokens[cursor] === "<") angles++; if (tokens[cursor] === ">") angles--; cursor++ } while (cursor < tokens.length && angles > 0)
    }
    if (tokens[cursor] === "(") {
      if (candidate === member) return true
      let parens = 0
      do { if (tokens[cursor] === "(") parens++; if (tokens[cursor] === ")") parens--; cursor++ } while (cursor < tokens.length && parens > 0)
      while (cursor < tokens.length && tokens[cursor] !== "{" && tokens[cursor] !== ";") cursor++
      if (tokens[cursor] === "{") {
        let braces = 0
        do { if (tokens[cursor] === "{") braces++; if (tokens[cursor] === "}") braces--; cursor++ } while (cursor < tokens.length && braces > 0)
      } else cursor++
      continue
    }
    let braces = 0
    while (cursor < tokens.length) {
      if (tokens[cursor] === "{") braces++
      else if (tokens[cursor] === "}") { if (braces === 0) return false; braces-- }
      if (tokens[cursor] === ";" && braces === 0) { cursor++; break }
      cursor++
    }
  }
  return false
}

const afterBalanced = (tokens, open, left, right) => {
  let depth = 0
  for (let cursor = open; cursor < tokens.length; cursor++) {
    if (tokens[cursor] === left) depth++
    else if (tokens[cursor] === right && --depth === 0) return cursor + 1
  }
  return tokens.length
}

const walkModuleDeclarations = (tokens, visit) => {
  const modifiers = new Set(["export", "default", "declare", "abstract", "async"])
  const continuation = new Set(["=", ",", ".", "(", "[", "<", ">", "?", ":", "*", "+", "-", "/", "&", "|", "!"])
  for (let cursor = 0; cursor < tokens.length;) {
    while (tokens[cursor] === ";" || tokens[cursor] === "\n") cursor++
    const statementStart = cursor
    while (modifiers.has(tokens[cursor])) cursor++
    const kind = tokens[cursor]
    let nameIndex = cursor + 1
    if (kind === "function" && tokens[nameIndex] === "*") nameIndex++
    if (visit({ kind, name: tokens[nameIndex], start: cursor })) return true
    if (["class", "interface", "enum", "function"].includes(kind)) {
      const open = tokens.indexOf("{", nameIndex + 1)
      if (open >= 0) { cursor = afterBalanced(tokens, open, "{", "}"); continue }
    }
    let braces = 0, parens = 0, brackets = 0
    cursor = statementStart
    while (cursor < tokens.length) {
      if (tokens[cursor] === "{") braces++
      else if (tokens[cursor] === "}") braces--
      else if (tokens[cursor] === "(") parens++
      else if (tokens[cursor] === ")") parens--
      else if (tokens[cursor] === "[") brackets++
      else if (tokens[cursor] === "]") brackets--
      let previous = cursor - 1
      while (tokens[previous] === "\n") previous--
      const boundary = tokens[cursor] === ";" || (tokens[cursor] === "\n" && !continuation.has(tokens[previous]))
      if (boundary && braces === 0 && parens === 0 && brackets === 0) { cursor++; break }
      cursor++
    }
  }
  return false
}

export const sourceDefinesCitationSymbol = (source, symbol) => {
  const tokens = sourceTokens(source), [owner, member, ...rest] = symbol.split(".")
  if (member) {
    if (rest.length) return false
    return walkModuleDeclarations(tokens, declaration => {
      if (declaration.kind !== "class" || declaration.name !== owner) return false
      const open = tokens.indexOf("{", declaration.start + 2)
      return open >= 0 && classDefinesMethod(tokens, open, member)
    })
  }
  return walkModuleDeclarations(tokens, declaration =>
    declaration.kind === "import"
      ? importDefines(tokens, declaration.start, owner)
      : ["class", "interface", "type", "function", "enum", "const", "let", "var"].includes(declaration.kind) && declaration.name === owner)
}

export const parseCheckpointCitations = (content, module) => {
  const citations = [...content.matchAll(citationPattern)]
  const declared = [...content.matchAll(/beaconwatch-citation:/g)]
  if (declared.length !== citations.length) throw new Error(`module-${module}.mdx has a malformed BeaconWatch checkpoint citation`)
  if (!citations.length) throw new Error(`module-${module}.mdx has no BeaconWatch checkpoint citation`)
  return citations.map(match => {
    const [, edge, path, symbol] = match
    const preceding = content.slice(Math.max(0, match.index - 500), match.index)
    if (!preceding.includes(`\`${symbol}\``)) throw new Error(`module-${module}.mdx citation for ${symbol} is not adjacent to that documented symbol`)
    return { edge, path, symbol }
  })
}

export const auditCheckpointCitation = (app, { module, edge, path, symbol }) => {
  if (edge !== "incoming" && edge !== "outgoing") throw new Error(`invalid citation edge: ${edge}`)
  const tag = tagFor(moduleNumber(module), edge === "incoming" ? "start" : "complete")
  try { run(app, ["cat-file", "-e", `${tag}:${path}`], { quiet: true }) } catch { throw new Error(`${tag} citation path does not exist: ${path}`) }
  const source = run(app, ["show", `${tag}:${path}`], { quiet: true })
  if (!sourceDefinesCitationSymbol(source, symbol)) throw new Error(`${tag} citation symbol does not exist in ${path}: ${symbol}`)
}

export const auditCheckpointCitations = (root, app, through = "16") => {
  const last = moduleNumber(through)
  for (const { module } of checkpointModules.filter(({ module }) => module <= last)) {
    const path = join(root, `workshop/site/content/modules/module-${module}.mdx`)
    const content = readFileSync(path, "utf8")
    for (const citation of parseCheckpointCitations(content, module)) auditCheckpointCitation(app, { module, ...citation })
  }
}

const installOpeningTests = (root, app, module, tests) => {
  const templates = tracked(root, `${openingTemplateRoot}/module-${module}`)
  const expected = tests.map(path => basename(path)).sort()
  const actual = templates.map(path => basename(path)).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`module ${module} opening templates do not exactly match its public tests`)
  mkdirSync(join(app, `test/checkpoint-${module}`), { recursive: true })
  for (const path of templates) writeFileSync(join(app, `test/checkpoint-${module}`, basename(path)), readFileSync(join(root, path)))
}

const installTestMigrations = (root, app, module) => {
  const sourceRoot = `${migrationTemplateRoot}/module-${module}`
  return tracked(root, sourceRoot).map(path => {
    const relative = path.slice(sourceRoot.length + 1)
    assertPublicCheckpointMaterial(relative, readFileSync(join(root, path), "utf8"))
    mkdirSync(dirname(join(app, relative)), { recursive: true })
    writeFileSync(join(app, relative), readFileSync(join(root, path)))
    return relative
  })
}

export const auditCheckpointRepository = (app, releasedModule = null) => {
  const dirty = run(app, ["status", "--porcelain=v1", "--untracked-files=all"])
  if (dirty) throw new Error(`checkpoint repository is dirty:\n${dirty}`)
  if (run(app, ["remote"])) throw new Error("checkpoint repository contains a remote")
  const refs = run(app, ["for-each-ref", "--format=%(refname)"]).split("\n").filter(Boolean)
  if (refs.some(ref => !/^refs\/(heads\/main|tags\/bw-module-\d{2}-(?:start|complete))$/.test(ref))) throw new Error("checkpoint repository contains an unexpected ref")
  if (releasedModule !== null && refs.some(ref => { const m = ref.match(/bw-module-(\d{2})-/); return m && m[1] > releasedModule })) throw new Error("checkpoint repository contains a future ref")
  const unreachable = run(app, ["fsck", "--no-reflogs", "--unreachable"], { quiet: true }); if (unreachable) throw new Error("checkpoint repository contains unreachable objects")
  const objects = run(app, ["rev-list", "--objects", "--all"]).split("\n").filter(Boolean)
  for (const row of objects) { const [oid, ...name] = row.split(" "); try { assertPublicCheckpointMaterial(name.join(" "), run(app, ["cat-file", "-p", oid], { quiet: true })) } catch { throw new Error(`forbidden content in checkpoint object ${oid}`) } }
  return { refs, objects: objects.length }
}

const buildCanonical = (root, app, through) => {
  copyTracked(root, deliveryRoles.learner.appStarter, app)
  const packagePath = join(app, "package.json"); writeFileSync(packagePath, readFileSync(packagePath, "utf8").replace('  "private": true,\n', '  "private": true,\n  "engines": { "node": ">=22.19.0" },\n'))
  run(app, ["init", "-q", "-b", "main"]); run(app, ["config", "user.name", identity.GIT_AUTHOR_NAME]); run(app, ["config", "user.email", identity.GIT_AUTHOR_EMAIL])
  for (const item of checkpointModules.slice(0, Number(through) + 1)) {
    const patch = tracked(root, `${item.patch}*.patch`)[0]; if (!patch) throw new Error(`missing patch for module ${item.module}`)
    const paths = changedByPatch(root, join(root, patch))
    const apply = ["apply", "--exclude=test/checkpoint-*", join(root, patch)]
    run(app, ["apply", "--check", "--exclude=test/checkpoint-*", join(root, patch)]); run(app, apply)
    const opening = paths.filter(path => openingPath(path, item.module)); if (!opening.includes("package.json") || !opening.some(path => path.startsWith(`test/checkpoint-${item.module}/`))) throw new Error(`module ${item.module} has no public checkpoint transition`)
    const tests = opening.filter(path => path.startsWith(`test/checkpoint-${item.module}/`))
    installOpeningTests(root, app, item.module, tests)
    const migrations = installTestMigrations(root, app, item.module)
    run(app, item.module === "00" ? ["add", "-A"] : ["add", "--", ...opening, ...migrations]); commit(app, `Open BeaconWatch module ${item.module}`); run(app, ["tag", tagFor(item.module, "start")])
    run(app, ["add", "-A"]); commit(app, `Complete BeaconWatch module ${item.module}`, item.module === "00"); run(app, ["tag", tagFor(item.module, "complete")])
  }
}

export const exportCheckpointRepository = (repositoryRoot, outputDirectory, requestedModule, options = {}) => {
  const root = realpathSync(resolve(repositoryRoot)), output = resolve(outputDirectory), number = moduleNumber(requestedModule)
  if (output === root || output.startsWith(root + sep)) throw new Error("checkpoint output must be outside the source repository")
  if (existsSync(output)) throw new Error(`output already exists: ${output}`)
  if (!options.allowDirty && run(root, ["status", "--porcelain=v1", "--untracked-files=all"])) throw new Error("checkpoint export requires a clean source tree")
  const stage = `${output}.stage-${process.pid}`; rmSync(stage, { recursive: true, force: true })
  try {
    buildCanonical(root, stage, number)
    auditCheckpointCitations(root, stage, number)
    run(stage, ["checkout", "-q", "--detach", tagFor(number, "start")]); run(stage, ["branch", "-f", "main", tagFor(number, "start")]); run(stage, ["checkout", "-q", "main"])
    run(stage, ["reflog", "expire", "--expire=now", "--all"]); run(stage, ["gc", "--prune=now", "--quiet"])
    auditCheckpointRepository(stage, number); writeFileSync(join(stage, ".git", "checkpoint-module"), `${number}\n`); renameSync(stage, output)
  } catch (error) { rmSync(stage, { recursive: true, force: true }); throw error }
  return { module: number, output, head: run(output, ["rev-parse", "HEAD"]), complete: run(output, ["rev-parse", tagFor(number, "complete")]), tag: tagFor(number, "start") }
}

export const exportCheckpointBundle = (repositoryRoot, outputFile, requestedModule, options = {}) => {
  const number = moduleNumber(requestedModule), parent = mkdtempSync(join(tmpdir(), "bw-bundle-")), app = join(parent, "app")
  try {
    exportCheckpointRepository(repositoryRoot, app, number, options)
    const refs = [tagFor(number, "start"), tagFor(number, "complete")], args = ["bundle", "create", resolve(outputFile), ...refs]
    if (number !== "00") args.push(`^${tagFor(String(Number(number) - 1).padStart(2, "0"), "complete")}`)
    run(app, args); return { module: number, prerequisite: number === "00" ? "empty repository" : tagFor(String(Number(number) - 1).padStart(2, "0"), "complete"), refs }
  } finally { rmSync(parent, { recursive: true, force: true }) }
}

export const importCheckpointBundle = (app, bundle, requestedModule) => {
  const number = moduleNumber(requestedModule)
  if (run(app, ["status", "--porcelain"])) throw new Error("commit or stash work before importing a checkpoint bundle")
  if (number !== "00") {
    const prior = tagFor(String(Number(number) - 1).padStart(2, "0"), "complete")
    try { run(app, ["rev-parse", "--verify", `refs/tags/${prior}^{commit}`]) } catch { throw new Error(`missing prerequisite ${prior}`) }
    const verify = run(app, ["bundle", "verify", resolve(bundle)], { quiet: true }); if (!verify.includes(run(app, ["rev-parse", prior]))) throw new Error(`wrong prerequisite ${prior}`)
  }
  run(app, ["fetch", resolve(bundle), `refs/tags/${tagFor(number, "start")}:refs/tags/${tagFor(number, "start")}`, `refs/tags/${tagFor(number, "complete")}:refs/tags/${tagFor(number, "complete")}`])
  run(app, ["checkout", "-q", "-b", `bw-module-${number}-work`, tagFor(number, "start")])
  writeFileSync(join(app, ".git", "checkpoint-module"), `${number}\n`)
  return { head: run(app, ["rev-parse", "HEAD"]), complete: run(app, ["rev-parse", tagFor(number, "complete")]) }
}

if (process.argv[1] && basename(process.argv[1]) === basename(new URL(import.meta.url).pathname)) {
  const [module, output] = process.argv.slice(2); if (!module || !output) throw new Error("usage: node export.mjs MODULE /external/new-directory")
  console.log(JSON.stringify(exportCheckpointRepository(resolve(import.meta.dirname, "../../.."), output, module), null, 2))
}
