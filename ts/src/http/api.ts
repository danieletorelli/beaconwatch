export interface TargetDto {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}
export interface StatusDto {
  ok: boolean;
  targets: number;
}
export interface IncidentDto {
  id: string;
  targetId: string;
  status: string;
  reason: string;
}
export interface CheckDto {
  id: string;
  targetId: string;
  classification: string;
}
export interface ApiError {
  message: string;
}
export const incidentIdPattern = /^incident_[a-z0-9][a-z0-9_-]*$/;
export const BeaconWatchApi = {
  name: "BeaconWatch",
  endpoints: [
    "GET /targets",
    "GET /status",
    "GET /incidents/:id",
    "GET /checks",
  ],
} as const;
