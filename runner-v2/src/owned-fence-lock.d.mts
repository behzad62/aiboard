export interface OwnedFenceLockOptions {
  readonly deadlineMs?: number;
  /** Optional absolute wall-clock deadline (ms); the claim ends at whichever of the two comes first. */
  readonly deadlineAt?: number;
  readonly retryDelayMs?: number;
  /** Tests only: runs with the lock held, before the effect. */
  readonly afterClaim?: () => void;
  /** Tests only: a failure here stands for a failed ROLLBACK, so the lock is kept until the process exits. */
  readonly beforeRelease?: () => void;
  /** After a successful effect and the lock's release: remove the lock file, or run `retireAuthority` instead. */
  readonly retireAfterEffect?: boolean;
  readonly retireAuthority?: () => void;
  /** Runs right after this claim created the lock file; a refusal removes that file again. */
  readonly assertAuthority?: () => void;
}
/** The default claim deadline (ms); see the measurements at the constant. */
export const OWNED_FENCE_DEFAULT_DEADLINE_MS: number;
export class OwnedFenceLockUnavailableError extends Error {}
export class OwnedFenceContentionError extends OwnedFenceLockUnavailableError {}
export class OwnedFenceAuthorityRetirementError extends Error {}
export function isOwnedFenceLockContention(error: unknown): boolean;
export function retryRetiredOwnedFenceCleanup(path: string, cleanup: () => void, options?: Pick<OwnedFenceLockOptions, "deadlineMs" | "retryDelayMs">): Promise<void>;
export function retiredOwnedFenceCleanupAvailable(path: string): boolean;
export function recoverRevokedOwnedFenceLock(
  path: string,
  options: Pick<OwnedFenceLockOptions, "deadlineMs" | "retryDelayMs"> & { readonly assertRevoked: () => void },
): Promise<void>;
export function withOwnedFenceLockSync<T>(path: string, effect: () => T, options?: OwnedFenceLockOptions): T;
export function withOwnedFenceLock<T>(path: string, effect: () => T | Promise<T>, options?: OwnedFenceLockOptions): Promise<T>;
