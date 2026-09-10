import { OpenApi } from "effect/unstable/httpapi"
import { BeaconWatchApi } from "./api.js"

export const openApiDocument = OpenApi.fromApi(BeaconWatchApi)
