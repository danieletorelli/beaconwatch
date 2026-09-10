import { ConfigError } from "./errors.js";
export const validatePositiveInterval = async (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new ConfigError({ reason: "interval must be positive" });
  return seconds;
};
export const assertCheckInvariant = async (condition: boolean) => {
  if (!condition) throw new Error("BeaconWatch invariant violated");
};
export type Exit<A, E> =
  | { ok: true; value: A }
  | { ok: false; cause: { kind: "failure"; error: E } }
  | { ok: false; cause: { kind: "defect"; defect: unknown } }
  | { ok: false; cause: { kind: "interruption"; reason?: unknown } };
export const exitKind = <A, E>(e: Exit<A, E>) =>
  e.ok ? "success" : "error";
export const firstTypedFailure = <A, E>(e: Exit<A, E>) =>
  !e.ok && e.cause.kind === "failure" ? e.cause.error : undefined;
