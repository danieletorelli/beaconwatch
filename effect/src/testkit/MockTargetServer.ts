import { Effect } from "effect"
import http from "node:http"

export interface MockTargetServer { readonly baseUrl: string; readonly server: http.Server }

const makeServer = () => {
  let flaky = 0
  const recovers = new Map<number, number>()
  return http.createServer((req, res) => {
    const url = req.url ?? "/"
    if (url === "/ok") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ status: 200, body: { ok: true } })); return }
    if (url === "/slow") { setTimeout(() => { res.writeHead(200); res.end("slow") }, 50); return }
    if (url === "/flaky") { flaky++; res.writeHead(flaky < 2 ? 500 : 200); res.end(String(flaky)); return }
    if (url === "/bad-json") { res.writeHead(200, { "content-type": "application/json" }); res.end("{"); return }
    if (url === "/reset") { req.socket.destroy(); return }
    const match = /^\/recovers-after\/(\d+)$/.exec(url)
    if (match?.[1]) { const n = Number(match[1]); const c = (recovers.get(n) ?? 0) + 1; recovers.set(n, c); res.writeHead(c <= n ? 500 : 200); res.end(String(c)); return }
    res.writeHead(404); res.end("not found")
  })
}

export const make = Effect.acquireRelease(
  Effect.tryPromise({
    try: () => new Promise<MockTargetServer>((resolve, reject) => {
      const server = makeServer()
      server.on("error", reject)
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address()
        if (typeof addr === "object" && addr) resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server })
        else reject(new Error("no address"))
      })
    }),
    catch: () => new Error("listen failed")
  }),
  ({ server }) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve())))
)
