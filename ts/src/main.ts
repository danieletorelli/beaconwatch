import { main as runCommand } from "./cli/cli.js";
import { tempLayer } from "./repo/SqliteCheckRepository.js";
import { InMemoryLayer } from "./repo/CheckRepository.js";

export type RepositoryChoice = "memory" | "sqlite";

export const repositoryChoice = (env: Record<string, string | undefined>): RepositoryChoice =>
  env.BEACONWATCH_REPOSITORY === "sqlite" ? "sqlite" : "memory";

export const buildAppLayer = (choice: RepositoryChoice) =>
  choice === "sqlite" ? tempLayer() : InMemoryLayer;

export const main = (
  env: Record<string, string | undefined> = process.env,
  argv: ReadonlyArray<string> = process.argv.slice(2),
) => runCommand(env, argv);

export const eagerStartup = (load: () => Promise<void>) => {
  const loading = load();
  return () => loading;
};
