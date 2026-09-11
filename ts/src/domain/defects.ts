import { ConfigError } from "./errors.js";
export const validatePositiveInterval = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new ConfigError({ reason: "interval must be positive" });
  return seconds;
};
export const assertCheckInvariant = (condition: boolean) => {
  if (!condition) throw new Error("BeaconWatch invariant violated");
};
