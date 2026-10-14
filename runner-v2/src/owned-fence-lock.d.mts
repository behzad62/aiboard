export type OwnedFenceHolderInspection = "same" | "absent" | "birth_mismatch" | "unknown";
export interface OwnedFenceLockOptions {
  readonly deadlineMs?: number;
  /** Optional original wall-clock deadline, including pre-acquisition identity observation. */
  readonly deadlineAt?: number;
  readonly retryDelayMs?: number;
  readonly holderPid?: number;
  readonly holderBirth?: string;
  readonly inspectHolder?: (pid: number, birth: string, remainingMs?: number) => OwnedFenceHolderInspection;
  readonly afterClaim?: () => void;
  readonly retireAfterEffect?: boolean;
  readonly retireAuthority?: () => void;
  readonly assertAuthority?: () => void;
}
export interface GenericPosixProcessInspectionOperations {
  readonly probeExistence: (pid: number) => "live" | "absent" | "permission" | "unknown";
  readonly inspectBirth: (pid: number, remainingMs?: number) =>
    | { readonly outcome: "ok"; readonly fingerprint: string }
    | { readonly outcome: "absent" | "timeout" | "malformed" | "failure" };
}
export class OwnedFenceLockUnavailableError extends Error {}
export class OwnedFenceContentionError extends OwnedFenceLockUnavailableError {}
export class OwnedFenceAuthorityRetirementError extends Error {}
export function isOwnedFenceLockContention(error: unknown): boolean;
export function currentProcessBirthFingerprint(remainingMs?: number): string;
export function inspectGenericPosixProcessBirth(
  pid: number,
  operations?: GenericPosixProcessInspectionOperations,
  remainingMs?: number,
): { readonly state: "same"; readonly fingerprint: string } | { readonly state: "absent" | "unknown" };
export function retryRetiredOwnedFenceCleanup(path: string, cleanup: () => void, options?: Pick<OwnedFenceLockOptions, "deadlineMs" | "retryDelayMs">): Promise<void>;
export function retiredOwnedFenceCleanupAvailable(path: string): boolean;
export function recoverRevokedOwnedFenceLock(
  path: string,
  options: Pick<OwnedFenceLockOptions, "deadlineMs" | "retryDelayMs"> & { readonly assertRevoked: () => void },
): Promise<void>;
export function withOwnedFenceLockSync<T>(path: string, effect: () => T, options?: OwnedFenceLockOptions): T;
export function withOwnedFenceLock<T>(path: string, effect: () => T | Promise<T>, options?: OwnedFenceLockOptions): Promise<T>;
