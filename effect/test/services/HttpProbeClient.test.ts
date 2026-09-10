import { it } from "@effect/vitest"
import { Cause, Effect, Fiber, Ref } from "effect"
import { TestClock } from "effect/testing"
import http from "node:http"
import { DnsError, InvalidBody, UnexpectedStatus } from "../../src/domain/errors.js"
import { probeOnce } from "../../src/probe/ProbeProgram.js"
import { ProbeClient } from "../../src/services/ProbeClient.js"
import { HttpProbeClientLive } from "../../src/services/HttpProbeClient.js"
import * as MockTargetServer from "../../src/testkit/MockTargetServer.js"
import { target } from "../helpers.js"

const serveJson = (transportStatus: number, body: unknown) => Effect.acquireRelease(
  Effect.promise(() => new Promise<{ readonly url: string; readonly server: http.Server }>((resolve, reject) => {
    const server = http.createServer((_request, response) => {
      response.writeHead(transportStatus, { "content-type": "application/json" })
      response.end(JSON.stringify(body))
    })
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address === "object" && address !== null) resolve({ url: `http://127.0.0.1:${address.port}`, server })
      else reject(new Error("server did not bind to a TCP port"))
    })
  })),
  ({ server }) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve())))
)

const serveRawJson = (body: Uint8Array) => Effect.acquireRelease(
  Effect.promise(() => new Promise<{ readonly url: string; readonly server: http.Server }>((resolve, reject) => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(body)
    })
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address === "object" && address !== null) resolve({ url: `http://127.0.0.1:${address.port}`, server })
      else reject(new Error("server did not bind to a TCP port"))
    })
  })),
  ({ server }) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve())))
)

it.effect("probes a real scoped localhost target", () => Effect.scoped(Effect.gen(function*() {
  const server = yield* MockTargetServer.make
  const client = yield* ProbeClient
  const response = yield* client.probe(target("target_http", { url: `${server.baseUrl}/ok` }))
  if (response.status !== 200) throw new Error("bad status")
})).pipe(Effect.provide(HttpProbeClientLive)))

it.effect("maps malformed response bodies to InvalidBody", () => Effect.scoped(Effect.gen(function*() {
  const server = yield* MockTargetServer.make
  const client = yield* ProbeClient
  const exit = yield* client.probe(target("target_bad_body", { url: `${server.baseUrl}/bad-json` })).pipe(Effect.exit)
  const reason = exit._tag === "Failure" ? exit.cause.reasons.find(Cause.isFailReason) : undefined
  if (!(reason?.error instanceof InvalidBody)) throw new Error("expected InvalidBody")
})).pipe(Effect.provide(HttpProbeClientLive)))

it.effect("rejects JSON response bodies containing invalid UTF-8", () => Effect.scoped(Effect.gen(function*() {
  const endpoint = yield* serveRawJson(Uint8Array.from([0x22, 0xc3, 0x28, 0x22]))
  const client = yield* ProbeClient
  const exit = yield* client.probe(target("target_invalid_utf8", { url: endpoint.url })).pipe(Effect.exit)
  const reason = exit._tag === "Failure" ? exit.cause.reasons.find(Cause.isFailReason) : undefined
  if (!(reason?.error instanceof InvalidBody)) throw new Error("expected invalid UTF-8 JSON to fail with InvalidBody")
})).pipe(Effect.provide(HttpProbeClientLive)))

it.effect("maps unexpected statuses to UnexpectedStatus", () => Effect.scoped(Effect.gen(function*() {
  const server = yield* MockTargetServer.make
  const client = yield* ProbeClient
  const exit = yield* client.probe(target("target_404", { url: `${server.baseUrl}/missing` })).pipe(Effect.exit)
  const reason = exit._tag === "Failure" ? exit.cause.reasons.find(Cause.isFailReason) : undefined
  if (!(reason?.error instanceof UnexpectedStatus)) throw new Error("expected UnexpectedStatus")
})).pipe(Effect.provide(HttpProbeClientLive)))

it.effect("reports the HTTP response status rather than an untrusted body field", () => Effect.scoped(Effect.gen(function*() {
  const endpoint = yield* serveJson(200, { status: 503, body: { ok: true } })
  const client = yield* ProbeClient
  const response = yield* client.probe(target("target_status_source", { url: endpoint.url }))
  if (response.status !== 200) {
    throw new Error(`expected transport status 200, got body-controlled status ${response.status}`)
  }
})).pipe(Effect.provide(HttpProbeClientLive)))

it.effect("reports response body size in bytes for non-ASCII JSON", () => Effect.scoped(Effect.gen(function*() {
  const body = { message: "é" }
  const payload = { status: 200, body }
  const endpoint = yield* serveJson(200, payload)
  const client = yield* ProbeClient
  const response = yield* client.probe(target("target_unicode_bytes", { url: endpoint.url }))
  const expected = Buffer.byteLength(JSON.stringify(payload), "utf8")
  if (response.bytes !== expected) {
    throw new Error(`expected ${expected} UTF-8 bytes, got ${response.bytes}`)
  }
})).pipe(Effect.provide(HttpProbeClientLive)))

it.effect("supports configured HEAD probes without requiring a JSON body", () => Effect.scoped(Effect.gen(function*() {
  const endpoint = yield* serveJson(200, { ignored: true })
  const client = yield* ProbeClient
  const response = yield* client.probe(target("target_head", { method: "HEAD", url: endpoint.url }))
  if (response.status !== 200) throw new Error(`expected HEAD status 200, got ${response.status}`)
})).pipe(Effect.provide(HttpProbeClientLive)))

it.effect("maps a socket reset after headers to DnsError and retries it", () => Effect.scoped(Effect.gen(function*() {
  let attempts = 0
  const endpoint = yield* Effect.acquireRelease(
    Effect.promise(() => new Promise<{ readonly url: string; readonly server: http.Server }>((resolve, reject) => {
      const server = http.createServer((_request, response) => {
        attempts += 1
        response.writeHead(200, { "content-type": "application/json", "content-length": "100" })
        response.flushHeaders()
        response.write("{")
        setImmediate(() => response.destroy(new Error("intentional body reset")))
      })
      server.on("error", reject)
      server.listen(0, "127.0.0.1", () => {
        const address = server.address()
        if (typeof address === "object" && address) resolve({ url: `http://127.0.0.1:${address.port}`, server })
      })
    })),
    ({ server }) => Effect.sync(() => {
      server.closeAllConnections()
      server.close()
    })
  )
  const client = yield* ProbeClient
  const direct = yield* client.probe(target("target_reset_direct", { url: endpoint.url })).pipe(Effect.flip)
  if (!(direct instanceof DnsError)) throw new Error(`expected DnsError, got ${direct._tag}`)
  const fiber = yield* probeOnce(target("target_reset_retry", { url: endpoint.url })).pipe(Effect.forkScoped)
  yield* TestClock.adjust("1 second")
  yield* TestClock.adjust("1 second")
  yield* TestClock.adjust("1 second")
  yield* TestClock.adjust("1 second")
  const result = yield* Fiber.join(fiber)
  if (result.failure?.reason !== "DnsError") throw new Error(`expected retry exhaustion as DnsError, got ${result.failure?.reason}`)
  if (attempts !== 5) throw new Error(`expected one direct attempt plus four retry attempts, got ${attempts}`)
})).pipe(Effect.provide(HttpProbeClientLive)))
