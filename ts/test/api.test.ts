import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Option } from "effect";
import type { Server } from "node:http";
import { InMemoryCheckRepository } from "../src/repo/CheckRepository.js";
import type { TargetId } from "../src/domain/schema.js";
import {
  CheckResult,
  Down,
  Incident,
  ResponseMetadata,
  Target,
  Up,
  targetId,
} from "../src/domain/schema.js";
import type { CheckId, IncidentId } from "../src/domain/schema.js";
import { startServer } from "../src/http/server.js";

const check = (id: string, tag: "Up" | "Down") =>
  new CheckResult({
    id: id as CheckId,
    targetId: targetId("target_api"),
    checkedAt: new Date(0),
    duration: Duration.millis(1),
    classification: tag === "Up" ? new Up() : new Down(),
    failure: Option.none(),
    response: new ResponseMetadata({ status: Option.some(200), bytes: Option.none() }),
  });

const makeTarget = () =>
  new Target({
    id: "target_api" as TargetId,
    name: "API",
    url: "http://example.test",
    method: "GET",
    expectedStatus: [200] as [number, ...number[]],
    interval: Duration.millis(10),
    timeout: Duration.millis(50),
    slowThreshold: Duration.millis(100),
    enabled: true,
  });

// Repository that fails every read, so any premature lookup turns into a 500.
const brokenRepo = {
  saveTarget: async () => {},
  listTargets: async () => {
    throw new Error("secret database detail");
  },
  saveCheck: async () => {},
  listChecks: async () => {
    throw new Error("secret database detail");
  },
  getIncident: async () => {
    throw new Error("secret database detail");
  },
  getOpenIncident: async () => {
    throw new Error("secret database detail");
  },
  saveIncident: async () => {},
  applyCheck: async () => "Unchanged" as const,
};

const serve = async (repo: unknown) => {
  const { server, baseUrl } = await startServer(repo as never);
  return { server, baseUrl, close: () => new Promise<void>((r) => server.close(() => r())) };
};

describe("api error mapping (BUGS 10.1, 10.2, 19.1)", () => {
  it("invalid incident ids are rejected before any repository lookup", async () => {
    const { baseUrl, close } = await serve(brokenRepo);
    try {
      const res = await fetch(`${baseUrl}/incidents/not-an-incident-id`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ message: "invalid incident id" });
    } finally {
      await close();
    }
  });

  it("repository failures map to stable route messages without leaking causes", async () => {
    const { baseUrl, close } = await serve(brokenRepo);
    try {
      for (const [path, message] of [
        ["/targets", "failed to list targets"],
        ["/status", "failed to read status"],
        ["/checks", "failed to list checks"],
        ["/incidents/incident_ok", "failed to read incident"],
      ] as const) {
        const res = await fetch(`${baseUrl}${path}`);
        expect(res.status).toBe(500);
        const body = (await res.json()) as { message: string };
        expect(body.message).toBe(message);
        expect(JSON.stringify(body)).not.toContain("secret database detail");
      }
    } finally {
      await close();
    }
  });

  it("serves openapi.json, 404s unknown routes and absent incidents", async () => {
    const repo = new InMemoryCheckRepository();
    await repo.saveTarget(makeTarget());
    await repo.saveCheck(check("check_1", "Down"));
    await repo.saveIncident(
      new Incident({
        id: "incident_ok" as IncidentId,
        targetId: targetId("target_api"),
        openedAt: new Date(100),
        status: "Open",
        reason: "Down",
        latestCheckId: "check_1",
        summary: Option.none(),
        closedAt: Option.none(),
      }),
    );
    const { baseUrl, close } = await serve(repo);
    try {
      expect((await fetch(`${baseUrl}/openapi.json`)).status).toBe(200);
      expect((await fetch(`${baseUrl}/incidents/incident_absent`)).status).toBe(404);
      const present = await fetch(`${baseUrl}/incidents/incident_ok`);
      expect(present.status).toBe(200);
      expect(((await present.json()) as { status: string }).status).toBe("Open");
      expect((await fetch(`${baseUrl}/nope`)).status).toBe(404);
      expect((await fetch(`${baseUrl}/targets`, { method: "POST" })).status).toBe(405);
    } finally {
      await close();
    }
  });

  it("exposes targets as DTO fields only", async () => {
    const repo = new InMemoryCheckRepository();
    await repo.saveTarget(makeTarget());
    const { baseUrl, close } = await serve(repo);
    try {
      const res = await fetch(`${baseUrl}/targets`);
      expect(res.status).toBe(200);
      expect((await res.json()) as unknown).toEqual([
        { id: "target_api", name: "API", url: "http://example.test", enabled: true },
      ]);
    } finally {
      await close();
    }
  });
});

// Keep Server type import referenced for the acquire/release pattern shared
// with other suites.
type ServerHandle = { server: Server };
void (0 as unknown as ServerHandle | null);
