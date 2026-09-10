import { describe, expect, it } from "vitest";
import { Target, CheckResult, ResponseMetadata, Up, targetId, durationMillis } from "../src/domain/schema.js";
import { InMemoryCheckRepository } from "../src/repo/CheckRepository.js";
import { FakeProbeClient, valid } from "../src/services/ProbeClient.js";
import { probeOnce } from "../src/probe/ProbeProgram.js";
import { digestFromStream } from "../src/services/DigestService.js";
import { appConfig } from "../src/services/Config.js";
import { Fake as fakeSummary } from "../src/services/IncidentSummarizer.js";
import { ManagedAppRuntime } from "../src/runtime/ManagedRuntime.js";
import { greet } from "../src/smoke.js";

const target = () => new Target({ id: "target_api", name: "API", url: "http://example.test", method: "GET", expectedStatus: [200], interval: "10 ms", timeout: "50 ms", slowThreshold: "100 ms", enabled: true });
const check = () => new CheckResult({ id: "check_a", targetId: targetId("target_api"), checkedAt: new Date(0), duration: "1 ms", classification: new Up(), response: new ResponseMetadata({ status: 200 }) });

describe("BeaconWatch attendee happy paths", () => {
  it("parses explicit duration strings", () => expect(durationMillis("2 seconds")).toBe(2000));
  it("constructs a target", () => expect(target().name).toBe("API"));
  it("stores and lists targets", async () => { const r = new InMemoryCheckRepository(); await r.saveTarget(target()); expect(await r.listTargets()).toHaveLength(1); });
  it("stores and lists checks", async () => { const r = new InMemoryCheckRepository(); await r.saveCheck(check()); expect(await r.listChecks()).toHaveLength(1); });
  it("probes a healthy target", async () => expect((await probeOnce(target(), new FakeProbeClient({ target_api: valid() }))).classification._tag).toBe("Up"));
  it("builds a digest", async () => expect((await digestFromStream([check()])).targets).toHaveLength(1));
  it("loads ordinary config", () => expect(appConfig({ pollInterval: "1000", probeTimeout: "2 seconds", workerConcurrency: 2, slowThreshold: "3 seconds" }).workerConcurrency).toBe(2));
  it("summarizes incidents", async () => expect((await fakeSummary().summarize([])).text).toContain("stable"));
  it("runs managed work", async () => expect(await new ManagedAppRuntime().runPromise(async () => 1)).toBe(1));
  it("retains the command smoke path", async () => expect(await greet("BeaconWatch")).toBe("hello BeaconWatch"));
});
