// Types of the frozen pre-FL2 module, as these tests call it. It still took a holder row and a holder probe.
export interface OwnedFenceLockV1Options {
  readonly deadlineMs?: number;
  readonly deadlineAt?: number;
  readonly retryDelayMs?: number;
  readonly holderPid?: number;
  readonly holderBirth?: string;
  readonly inspectHolder?: (pid: number, birth: string, remainingMs?: number) => "same" | "absent" | "birth_mismatch" | "unknown";
  readonly retireAfterEffect?: boolean;
  readonly retireAuthority?: () => void;
}
export function withOwnedFenceLockSync<T>(lockPath: string, effect: () => T, options?: OwnedFenceLockV1Options): T;
export function withOwnedFenceLock<T>(lockPath: string, effect: () => T | Promise<T>, options?: OwnedFenceLockV1Options): Promise<T>;
