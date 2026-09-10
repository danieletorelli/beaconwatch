import { expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "../src/cli/cli.js";

it("implements all six native command forms", async () => {
  const directory = await mkdtemp(join(tmpdir(), "beaconwatch-cli-"));
  const history = join(directory, "history.ndjson");
  await writeFile(history, `${JSON.stringify({ id: "check_cli", targetId: "target_cli", checkedAt: "2026-01-01T00:00:00.000Z", durationMillis: 1, classification: { _tag: "Up" }, response: {} })}\n`);
  expect(await runCli([])).toBe("beaconwatch");
  expect(await runCli(["demo"])).toBe("demo");
  expect(await runCli(["check", "target.json"])).toBe("checked target.json");
  expect(await runCli(["serve"])).toBe("serve");
  expect(await runCli(["import-history", history])).toMatchObject({ processedRows: 1, malformedRows: 0 });
  expect(await runCli(["digest"])).toBe("digest");
  await expect(runCli(["check"])).rejects.toBeInstanceOf(TypeError);
  await expect(runCli(["import-history"])).rejects.toBeInstanceOf(TypeError);
});
