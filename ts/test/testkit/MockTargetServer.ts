import { createServer, type Server } from "node:http";
import { Effect } from "effect";

// Scoped local target server (contract section 12): binds to an ephemeral
// loopback port; acquiring fails as "listen failed" if binding fails;
// releasing the owning lifetime closes the listener and waits for close.
export interface MockTargetServer {
  readonly url: string;
  /** Headers of the last received probe request, for contract assertions. */
  readonly lastAccept: { value: string | undefined };
}

const lastAccept: { value: string | undefined } = { value: undefined };

export const mockTargetServer = Effect.acquireRelease(
  Effect.callback<Server, Error>((resume) => {
    let flakyCount = 0;
    const server = createServer((req, res) => {
      lastAccept.value = req.headers.accept;
      const path = (req.url ?? "/").split("?")[0]!;
      if (path === "/ok") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: 200, body: { ok: true } }));
      } else if (path === "/slow") {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("slow");
        }, 50);
      } else if (path === "/flaky") {
        flakyCount++;
        res.writeHead(flakyCount === 1 ? 500 : 200);
        res.end(String(flakyCount));
      } else if (path === "/invalid-utf8") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(Buffer.concat([Buffer.from('{\"ok\":\"'), Buffer.from([0xff, 0xfe]), Buffer.from('\"}')]));
      } else if (path === "/bad-json") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("{");
      } else if (path === "/reset") {
        req.socket.destroy();
      } else if (path.startsWith("/recovers-after/")) {
        const n = Number(path.slice("/recovers-after/".length)) || 0;
        flakyCount++;
        res.writeHead(flakyCount <= n ? 500 : 200);
        res.end(String(flakyCount));
      } else {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      }
    });
    server.once("error", (e) =>
      resume(Effect.fail(new Error(`listen failed: ${String(e)}`))),
    );
    server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
  }),
  (server) =>
    Effect.callback<void>((resume) => {
      server.close(() => resume(Effect.void));
    }),
).pipe(
  Effect.map((server) => {
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("listen failed: no ephemeral port");
    return { url: `http://127.0.0.1:${address.port}`, lastAccept } satisfies MockTargetServer;
  }),
);
