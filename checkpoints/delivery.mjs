import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve, sep } from "node:path"
import { execFileSync } from "node:child_process"
import { exportGoldLearnerCorpus } from "../../game/scripts/gold-test/learner-corpus.mjs"
import { auditCheckpointRepository, exportCheckpointRepository } from "./export.mjs"
import { deliveryRoles } from "./manifest.mjs"

const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
const filesUnder = (root, path) => git(root, ["ls-files", "--", path]).split("\n").filter(Boolean)
const privatePattern = /(?:DP-\d{2}|(?:defect|bug)[-_ ](?:injection|trigger|recipe)|(?:planted|injected|deliberately[-_ ]introduced)[-_ ](?:defect|bug|failure)|hidden[-_ ](?:defect|bug)[-_ ]trigger|broken[-_ ]on[-_ ]purpose|private[-_ ](?:ledger|manifest|acceptance|selector|test|pack)|(?:completed|complete|reference|solution)[-_ ]Effect[-_ ]implementation|(?:trigger|reproduction)[-_ ]recipe|workshop\/beaconwatch\/(?:effect|checkpoints\/acceptance)|research\/beaconwatch-defect-(?:inventory|injection-manifest))/i

export const assertPublicWorkshopMaterial = (path, content) => {
  if (privatePattern.test(path) || privatePattern.test(content)) throw new Error(`private material leaked through ${path}`)
}

const copyTracked = (root, source, stage, destination = source) => {
  const paths = filesUnder(root, source)
  if (paths.length === 0) throw new Error(`role source has no tracked files: ${source}`)
  for (const path of paths) {
    const entry = lstatSync(join(root, path))
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`unsafe role source: ${path}`)
    const target = join(stage, destination, path.slice(source.length + (path === source ? 0 : 1)))
    mkdirSync(dirname(target), { recursive: true }); cpSync(join(root, path), target)
  }
}

const auditPublicRole = (stage) => {
  for (const path of filesUnderDirectory(stage)) {
    assertPublicWorkshopMaterial(path, readFileSync(join(stage, path), "utf8"))
  }
  auditCheckpointRepository(join(stage, "beaconwatch"))
}

const filesUnderDirectory = root => {
  const rows = []
  const visit = relative => {
    for (const entry of (awaitReadDirectory(join(root, relative)))) {
      const path = join(relative, entry.name)
      if (entry.isDirectory()) { if (entry.name !== ".git") visit(path) }
      else if (entry.isFile()) rows.push(path)
    }
  }
  visit(""); return rows
}

const makeWritable = root => {
  if (!existsSync(root)) return
  const entry = lstatSync(root)
  if (entry.isSymbolicLink()) return
  if (!entry.isDirectory()) { chmodSync(root, 0o600); return }
  chmodSync(root, 0o700)
  for (const child of awaitReadDirectory(root)) makeWritable(join(root, child.name))
}

// Kept behind one helper so the recursive walk cannot accidentally follow links.
import { readdirSync } from "node:fs"
const awaitReadDirectory = path => readdirSync(path, { withFileTypes: true })

export const exportWorkshopRole = (repositoryRoot, outputDirectory, role, options = {}) => {
  if (!Object.hasOwn(deliveryRoles, role)) throw new Error(`unknown delivery role: ${role}`)
  const root = resolve(repositoryRoot), output = resolve(outputDirectory)
  if (output === root || output.startsWith(root + sep)) throw new Error("role output must be outside the repository")
  if (existsSync(output)) throw new Error(`output already exists: ${output}`)
  const parent = mkdtempSync(join(tmpdir(), "bw-role-")), learner = join(parent, "learner"), stage = `${output}.stage-${process.pid}`
  rmSync(stage, { recursive: true, force: true })
  try {
    exportGoldLearnerCorpus(root, learner, options)
    cpSync(learner, stage, { recursive: true })
    if (role !== "learner") {
      copyTracked(root, deliveryRoles["live-instructor"].guide, stage, "instructor/README.md")
    }
    if (role === "maintainer") {
      copyTracked(root, deliveryRoles.maintainer.solution, stage, "maintainer/effect")
      copyTracked(root, deliveryRoles.maintainer.acceptance, stage, "maintainer/checkpoints")
      for (const path of deliveryRoles.maintainer.privateResearch) copyTracked(root, path, stage, `maintainer/${basename(path)}`)
      copyTracked(root, deliveryRoles.maintainer.provenance, stage, "maintainer/decisions.md")
      exportCheckpointRepository(root, join(stage, "maintainer/checkpoint-app"), "16", { allowDirty: options.allowDirty })
      writeFileSync(join(stage, "maintainer/README.md"), `# BeaconWatch maintainer bundle

Run the bundled private transition smoke test with:

\`node checkpoints/acceptance.mjs --smoke\`

Run the complete 73-selector transition and cumulative acceptance gate by omitting \`--smoke\`. The canonical checkpoint Git history is in \`checkpoint-app/\`. The patch, exporter, and delivery scripts are retained as source and provenance; rebuilding role artifacts still requires the source workshop monorepo.
`)
    } else auditPublicRole(stage)
    makeWritable(stage)
    renameSync(stage, output)
  } catch (error) { rmSync(stage, { recursive: true, force: true }); throw error }
  finally { makeWritable(parent); rmSync(parent, { recursive: true, force: true }) }
  return { role, output }
}

if (process.argv[1] && basename(process.argv[1]) === basename(new URL(import.meta.url).pathname)) {
  const [role, output, throughModule = "00"] = process.argv.slice(2)
  if (!role || !output) throw new Error("usage: node delivery.mjs ROLE /external/new-directory [MODULE]")
  console.log(JSON.stringify(exportWorkshopRole(resolve(import.meta.dirname, "../../.."), output, role, { throughModule }), null, 2))
}
