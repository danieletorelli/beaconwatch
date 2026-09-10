import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { CheckId, HttpUrl, IncidentId, TargetId, TargetName } from "../domain/schema.js"

const NonNegativeSafeInteger = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))
export const TargetDto = Schema.Struct({ id: TargetId, name: TargetName, url: HttpUrl, enabled: Schema.Boolean })
export const StatusDto = Schema.Struct({ ok: Schema.Literal(true), targets: NonNegativeSafeInteger })
export const IncidentDto = Schema.Struct({ id: IncidentId, targetId: TargetId, status: Schema.Literals(["Open", "Closed"]), reason: Schema.String })
export const CheckDto = Schema.Struct({ id: CheckId, targetId: TargetId, classification: Schema.Literals(["Up", "Slow", "Down", "InvalidResponse", "Unknown"]) })
export const ApiError = Schema.Struct({ message: Schema.String })
export const IncidentParams = Schema.Struct({ id: IncidentId })

export const getTargets = HttpApiEndpoint.make("GET")("getTargets", "/targets", { success: Schema.Array(TargetDto), error: ApiError })
export const getStatus = HttpApiEndpoint.make("GET")("getStatus", "/status", { success: StatusDto, error: ApiError })
export const getIncident = HttpApiEndpoint.make("GET")("getIncident", "/incidents/:id", { params: IncidentParams, success: IncidentDto, error: ApiError })
export const getChecks = HttpApiEndpoint.make("GET")("getChecks", "/checks", { success: Schema.Array(CheckDto), error: ApiError })

export const BeaconWatchApi = HttpApi.make("BeaconWatch").add(
  HttpApiGroup.make("default").add(getTargets, getStatus, getIncident, getChecks)
)
