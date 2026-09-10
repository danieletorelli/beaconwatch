export const checkpointModules = Array.from({ length: 17 }, (_, index) => ({
  module: String(index).padStart(2, "0"),
  patch: `workshop/beaconwatch/checkpoints/patches/${String(index + 1).padStart(4, "0")}`
}))

export const deliveryRoles = Object.freeze({
  learner: {
    bookIntro: "workshop/site/content/intro.mdx",
    bookModules: "workshop/site/content/modules",
    notebookRoot: "workshop/instructors-notebook",
    readme: "workshop/README.md",
    agents: "workshop/AGENTS.md",
    spec: "workshop/beaconwatch/SPEC.md",
    appStarter: "workshop/beaconwatch/ts",
    excludes: ["**/*.walkthrough.md"]
  },
  "live-instructor": {
    extends: "learner",
    guide: "workshop/instructors-notebook/INSTRUCTOR-GUIDE.md"
  },
  maintainer: {
    extends: "live-instructor",
    solution: "workshop/beaconwatch/effect",
    privateResearch: [
      "research/beaconwatch-migration-curriculum-ledger.md",
      "research/beaconwatch-defect-inventory.md",
      "research/beaconwatch-defect-injection-manifest.md",
      "research/beaconwatch-mandatory-migration-docs-plan.md"
    ],
    acceptance: "workshop/beaconwatch/checkpoints",
    provenance: "decisions.md"
  }
})

// Backwards-compatible, manifest-derived names consumed by the gold harness.
export const learnerRoles = deliveryRoles.learner
export const tagFor = (module, edge) => `bw-module-${module}-${edge}`
export const FIXED_GIT_DATE = "2026-01-01T00:00:00Z"
