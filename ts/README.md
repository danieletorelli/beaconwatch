# BeaconWatch workshop app

BeaconWatch is a TypeScript endpoint monitor that you will improve in Modules
00–16. It requires Node.js 22.19 or newer. This directory is the source template;
the checkpoint exporter turns it into the learner Git repository. In that
released repository, read the current two-digit module number from
`.git/checkpoint-module`.

To verify the source template itself, run:

```sh
npm ci
npm run typecheck
npm test
```

## Start and verify a released checkpoint

```sh
npm ci
cat .git/checkpoint-module
npm run checkpoint:NN
```

Replace `NN` with the displayed number. The checkpoint command runs strict
typechecking, every public check through that module, the native compatibility
suite, and the smoke edge. Module 00's characterization checks already pass;
Modules 01–16 open with a failing focused test to make pass without breaking
earlier checks.

## Architecture map

- `src/domain`: values, validation, and failure vocabulary.
- `src/services`: probe, configuration, incident, and digest capabilities.
- `src/repo`: volatile/SQLite persistence and scarce connection ownership.
- `src/probe`, `src/watch`, `src/stm`: probe policy and coordinated work/state.
- `src/http`, `src/cli`, `src/runtime`, `src/bin.ts`: application boundaries.
- `src/obs`: logging, tracing, metrics, caching, and metadata batching.
- `test/checkpoint-NN`: focused public migration checks.

Preserve the observable behavior in `../SPEC.md` when that file is supplied
beside this repository. Do not rewrite unrelated architecture or skip modules.

## Dependency transitions

Modules 01, 05, 06, and 16 change `package-lock.json`. After entering one of those
openings, run `npm ci` and confirm `npm ls --depth=0` before the focused check.
Use the lockfile exactly as supplied; do not upgrade workshop dependencies.

## Compare and recover

```sh
git diff bw-module-NN-start..bw-module-NN-complete
git switch -c my-module-NN-work bw-module-NN-start
```

Save useful work on a branch before recovery. To catch up, create a new branch
from `bw-module-NN-complete`, rerun `npm ci` when the lockfile changed, and run
`npm run checkpoint:NN`. Never reset or overwrite uncommitted work.

For an incremental module bundle, first commit your work on its current branch
and retain the prior `bw-module-PP-complete` tag. Then verify and import the
supplied bundle onto a new module branch:

```sh
git bundle verify /path/to/module-NN.bundle
git fetch /path/to/module-NN.bundle \
  refs/tags/bw-module-NN-start:refs/tags/bw-module-NN-start \
  refs/tags/bw-module-NN-complete:refs/tags/bw-module-NN-complete
git switch -c bw-module-NN-work bw-module-NN-start
printf '%s\n' NN > .git/checkpoint-module
```

If verification reports a missing prerequisite, obtain the preceding module
instead of forcing the import. Replace `NN` with the two-digit module number;
the marker lets workshop tooling and troubleshooting agree on the imported
checkpoint. The import never moves your previous branch; if the new module
branch name already exists, choose another unused name instead of force-moving
it.

## Local troubleshooting

- Wrong module: inspect `.git/checkpoint-module` and `git tag`.
- Missing packages: use Node 22.19+ and rerun `npm ci`; never copy `node_modules`.
- Unexpected later code: start from the released `bw-module-NN-start` tag.
- Failed cumulative check: run the named `test/checkpoint-PP` directory first,
  where `PP` is the earliest failing module.
