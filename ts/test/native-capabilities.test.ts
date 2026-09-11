import { describe, expect, it } from "vitest";
import { Duration, Effect, Option } from "effect";
import { Target, CheckResult, ResponseMetadata, Up, targetId, durationMillis, type CheckId, type TargetId } from "../src/domain/schema.js";
import { CheckRepository, InMemoryLayer } from "../src/repo/CheckRepository.js";
import { FakeProbeClient, valid } from "../src/services/ProbeClient.js";
import { probeOnce } from "../src/probe/ProbeProgram.js";
import { digestFromStreamEffect } from "../src/services/DigestService.js";
import { appConfig } from "../src/services/Config.js";
import { Fake as fakeSummary } from "../src/services/IncidentSummarizer.js";
import { runtime } from "../src/runtime/ManagedRuntime.js";
import { greet } from "../src/smoke.js";

const target = () => new Target({ id: "target_api" as TargetId, name: "API", url: "http://example.test", method: "GET", expectedStatus: [200] as [number, ...number[]], interval: Duration.millis(10), timeout: Duration.millis(50), slowThreshold: Duration.millis(100), enabled: true });
const check = () => new CheckResult({ id: "check_a" as CheckId, targetId: targetId("target_api"), checkedAt: new Date(0), duration: Duration.millis(1), classification: new Up(), failure: Option.none(), response: new ResponseMetadata({ status: Option.some(200), bytes: Option.none() }) });

describe("BeaconWatch attendee happy paths", () => {
  it("parses explicit duration strings", () => expect(durationMillis("2 seconds")).toBe(2000));
  it("constructs a target", () => expect(target().name).toBe("API"));
  it("stores and lists targets", () => Effect.gen(function*() { const r = yield* CheckRepository; yield* r.saveTarget(target()); expect((yield* r.listTargets())).toHaveLength(1); }).pipe(Effect.provide(InMemoryLayer)));
  it("stores and lists checks", () => Effect.gen(function*() { const r = yield* CheckRepository; yield* r.saveCheck(check()); expect((yield* r.listChecks())).toHaveLength(1); }).pipe(Effect.provide(InMemoryLayer)));
  it("probes a healthy target", () => Effect.gen(function*() { expect((yield* probeOnce(target(), new FakeProbeClient({ target_api: valid() }))).classification._tag).toBe("Up"); }));
  it("builds a digest", () => expect(Effect.runSync(digestFromStreamEffect([check()])).targets).toHaveLength(1));
  it("loads ordinary config", () => expect(appConfig({ pollInterval: "1000", probeTimeout: "2 seconds", workerConcurrency: 2, slowThreshold: "3 seconds" }).workerConcurrency).toBe(2));
  it("summarizes incidents", async () => expect((await fakeSummary().summarize([])).text).toContain("stable"));
  it("runs managed work", () => runtime.runPromise(Effect.succeed(1)).then((x) => expect(x).toBe(1)));
  it("retains the command smoke path", async () => expect(await greet("BeaconWatch")).toBe("hello BeaconWatch"));
});
