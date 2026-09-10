import http from "node:http";
import { Option } from "effect";
import type { CheckRepositoryShape } from "../repo/CheckRepository.js";
import { incidentIdPattern } from "./api.js";
import { openApiDocument } from "./openapi.js";
export const createApiHandler =
  (repo: CheckRepositoryShape) =>
  async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method !== "GET")
        return send(405, { message: "method not allowed" });
      if (url.pathname === "/openapi.json") return send(200, openApiDocument);
      if (url.pathname === "/targets")
        return send(
          200,
          (await repo.listTargets()).map(({ id, name, url, enabled }) => ({
            id,
            name,
            url,
            enabled,
          })),
        );
      if (url.pathname === "/status")
        return send(200, {
          ok: true,
          targets: (await repo.listTargets()).length,
        });
      if (url.pathname === "/checks")
        return send(
          200,
          (await repo.listChecks()).map((c) => ({
            id: c.id,
            targetId: c.targetId,
            classification: c.classification._tag,
          })),
        );
      if (url.pathname.startsWith("/incidents/")) {
        const id = decodeURIComponent(url.pathname.slice(11));
        const iResult = await repo.getIncident(id);
        if (!incidentIdPattern.test(id))
          return send(400, { message: "invalid incident id" });
        return Option.isSome(iResult)
          ? send(200, {
              id: iResult.value.id,
              targetId: iResult.value.targetId,
              status: iResult.value.status,
              reason: iResult.value.reason,
            })
          : send(404, { message: `incident not found: ${id}` });
      }
      return send(404, { message: "not found" });
    } catch {
      return send(500, { message: "internal server error" });
    }
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
