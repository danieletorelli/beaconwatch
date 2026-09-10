import http from "node:http";
export interface MockTargetServer {
  baseUrl: string;
  server: http.Server;
  close(): Promise<void>;
}
export const make = () =>
  new Promise<MockTargetServer>((resolve, reject) => {
    let flaky = 0;
    const counts = new Map<number, number>();
    const server = http.createServer((req, res) => {
      const u = req.url ?? "/";
      if (u === "/ok") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ status: 200, body: { ok: true } }));
      }
      if (u === "/slow")
        return void setTimeout(() => {
          res.writeHead(200);
          res.end("slow");
        }, 50);
      if (u === "/bad-json") {
        res.writeHead(200);
        return res.end("{");
      }
      if (u === "/invalid-utf8") {
        res.writeHead(200);
        return res.end(Buffer.from([0xff]));
      }
      if (u === "/reset") return req.socket.destroy();
      if (u === "/flaky") {
        flaky++;
        res.writeHead(flaky < 2 ? 500 : 200);
        return res.end(String(flaky));
      }
      const m = /^\/recovers-after\/(\d+)$/.exec(u);
      if (m) {
        const n = Number(m[1]),
          c = (counts.get(n) ?? 0) + 1;
        counts.set(n, c);
        res.writeHead(c <= n ? 500 : 200);
        return res.end(String(c));
      }
      res.writeHead(404);
      res.end("not found");
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      if (typeof a !== "object" || !a) return reject(new Error("no address"));
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${a.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
