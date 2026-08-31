export type OwnedFenceHolderInspection = "same" | "absent" | "birth_mismatch" | "unknown";
export interface OwnedFenceLockOptions {
  readonly deadlineMs?: number;
  readonly retryDelayMs?: number;
  readonly holderPid?: number;
  readonly holderBirth?: string;
  readonly inspectHolder?: (pid: number, birth: string) => OwnedFenceHolderInspection;
  readonly afterClaim?: () => void;
  readonly retireAfterEffect?: boolean;
}
export class OwnedFenceLockUnavailableError extends Error {}
export function currentProcessBirthFingerprint(): string;
export function withOwnedFenceLockSync<T>(path: string, effect: () => T, options?: OwnedFenceLockOptions): T;
export function withOwnedFenceLock<T>(path: string, effect: () => T | Promise<T>, options?: OwnedFenceLockOptions): Promise<T>;
