import { runCli } from "./cli/cli.js";
export const repositoryChoice = (env: Record<string, string | undefined>) =>
  env.BEACONWATCH_REPOSITORY === "sqlite"
    ? ("sqlite" as const)
    : ("memory" as const);
export const main = (argv = process.argv.slice(2)) => runCli(argv);
export const eagerStartup = (load: () => Promise<void>) => {
  const loading = load();
  return () => loading;
};
