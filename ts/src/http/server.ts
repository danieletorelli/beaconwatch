import http from "node:http";
import { Effect, Option } from "effect";
import type { CheckRepositoryShape } from "../repo/CheckRepository.js";
import { incidentIdPattern } from "./api.js";
import { openApiDocument } from "./api.js";
export const createApiHandler =
  (repo: CheckRepositoryShape) =>
  async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    // Repository failures map to stable route-specific messages; internal
    // causes are logged but never exposed.
    const repoFailure = (message: string) => (e: unknown) => {
      console.error("repository failure:", e);
      return send(500, { message });
    };
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method !== "GET")
      return send(405, { message: "method not allowed" });
    if (url.pathname === "/openapi.json") return send(200, openApiDocument);
    if (url.pathname === "/targets") {
      try {
        const targets = await Effect.runPromise(repo.listTargets());
        return send(
          200,
          targets.map(({ id, name, url, enabled }) => ({
            id,
            name,
            url,
            enabled,
          })),
        );
      } catch (e) {
        return repoFailure("failed to list targets")(e);
      }
    }
    if (url.pathname === "/status") {
      try {
        const targets = await Effect.runPromise(repo.listTargets());
        return send(200, { ok: true, targets: targets.length });
      } catch (e) {
        return repoFailure("failed to read status")(e);
      }
    }
    if (url.pathname === "/checks") {
      try {
        const checks = await Effect.runPromise(repo.listChecks());
        return send(
          200,
          checks.map((c) => ({
            id: c.id,
            targetId: c.targetId,
            classification: c.classification._tag,
          })),
        );
      } catch (e) {
        return repoFailure("failed to list checks")(e);
      }
    }
    if (url.pathname.startsWith("/incidents/")) {
      const id = decodeURIComponent(url.pathname.slice(11));
      if (!incidentIdPattern.test(id))
        return send(400, { message: "invalid incident id" });
      try {
        const iResult = await Effect.runPromise(repo.getIncident(id));
        return Option.isSome(iResult)
          ? send(200, {
              id: iResult.value.id,
              targetId: iResult.value.targetId,
              status: iResult.value.status,
              reason: iResult.value.reason,
            })
          : send(404, { message: `incident not found: ${id}` });
      } catch (e) {
        return repoFailure("failed to read incident")(e);
      }
    }
    return send(404, { message: "not found" });
  };
export const startServer = (repo: CheckRepositoryShape, port = 0) =>
  new Promise<{ server: http.Server; baseUrl: string }>((resolve, reject) => {
    const server = http.createServer(
      (q, r) => void createApiHandler(repo)(q, r),
    );
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const a = server.address();
      if (typeof a !== "object" || !a) return reject(new Error("no address"));
      resolve({ server, baseUrl: `http://127.0.0.1:${a.port}` });
    });
  });
export const ServerLayer = startServer;
