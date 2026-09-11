import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { OpenApi } from "effect/unstable/httpapi";
import { CheckIdField, IncidentIdField, TargetIdField } from "../domain/schema.js";

// ---------- DTO schemas (module 16.1): the API contract as schema values.

export const TargetDto = Schema.Struct({
  id: TargetIdField,
  name: Schema.String,
  url: Schema.String,
  enabled: Schema.Boolean,
});
export const StatusDto = Schema.Struct({
  ok: Schema.Literals([true]),
  targets: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
  ),
});
export const IncidentDto = Schema.Struct({
  id: IncidentIdField,
  targetId: TargetIdField,
  status: Schema.Literals(["Open", "Closed"]),
  reason: Schema.String,
});
export const CheckDto = Schema.Struct({
  id: CheckIdField,
  targetId: TargetIdField,
  classification: Schema.Literals(["Up", "Slow", "Down", "InvalidResponse", "Unknown"]),
});
export const ApiError = Schema.Struct({ message: Schema.String });
export const IncidentParams = Schema.Struct({ id: Schema.String });

export const getTargets = HttpApiEndpoint.make("GET")(
  "getTargets",
  "/targets",
  { success: Schema.Array(TargetDto), error: ApiError },
);
export const getStatus = HttpApiEndpoint.make("GET")(
  "getStatus",
  "/status",
  { success: StatusDto, error: ApiError },
);
export const getIncident = HttpApiEndpoint.make("GET")(
  "getIncident",
  "/incidents/:id",
  { params: IncidentParams, success: IncidentDto, error: ApiError },
);
export const getChecks = HttpApiEndpoint.make("GET")(
  "getChecks",
  "/checks",
  { success: Schema.Array(CheckDto), error: ApiError },
);

export const BeaconWatchApi = HttpApi.make("BeaconWatch").add(
  HttpApiGroup.make("default").add(getTargets, getStatus, getIncident, getChecks),
);

/** The served OpenAPI artifact derives from the API contract, not by hand. */
export const openApiDocument = OpenApi.fromApi(BeaconWatchApi);

export const incidentIdPattern = /^incident_[a-z0-9][a-z0-9_-]*$/;
