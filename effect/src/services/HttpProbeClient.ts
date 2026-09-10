import { Effect, Layer, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { DnsError, InvalidBody, TimeoutError, UnexpectedStatus } from "../domain/errors.js"
import { ProbeClient, type RawProbeResponse } from "./ProbeClient.js"

const Envelope = Schema.Struct({ status: Schema.Number, body: Schema.Unknown })

export const Live = Layer.effect(ProbeClient)(Effect.gen(function*() {
  const client = yield* HttpClient.HttpClient
  return {
    probe: (target) => Effect.gen(function*() {
      yield* Effect.try({ try: () => new URL(target.url), catch: (cause) => new InvalidBody({ reason: `invalid URL: ${String(cause)}` }) })
      const response = yield* client.execute(HttpClientRequest.make(target.method)(target.url, { acceptJson: true }))
      if (!target.expectedStatus.includes(response.status)) {
        return yield* Effect.fail(new UnexpectedStatus({ expected: target.expectedStatus, actual: response.status }))
      }
      if (target.method === "HEAD") return { status: response.status, bytes: 0 }
      const bytes = new Uint8Array(yield* response.arrayBuffer)
      const decoded = yield* Effect.gen(function*() {
        const text = yield* Effect.try({
          try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          catch: (cause) => cause
        })
        const body = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(text)
        const envelope = yield* Schema.decodeUnknownEffect(Envelope)({ status: response.status, body })
        return envelope
      }).pipe(
        Effect.mapError((cause) => new InvalidBody({ reason: String(cause) }))
      )
      return { status: decoded.status, body: decoded.body, bytes: bytes.byteLength } satisfies RawProbeResponse
    }).pipe(
      Effect.timeout(target.timeout),
      Effect.mapError((e) => {
        if (typeof e === "object" && e !== null && "_tag" in e && e._tag === "TimeoutError") return new TimeoutError({ timeout: String(target.timeout) })
        if (e instanceof InvalidBody || e instanceof UnexpectedStatus) return e
        return new DnsError({ host: new URL(target.url).host, cause: e })
      }),
      Effect.provideService(HttpClient.HttpClient, client)
    )
  }
}))

export const HttpProbeClientLive = Layer.provide(Live, FetchHttpClient.layer)
