import type { NativeProcessOperations } from './native-process-backend.js';
import type { OwnedFenceLockOptions } from './owned-fence-lock.mjs';

export class WindowsBirthInspectionOwner {
  constructor();
  registerCleanup(register: (cleanup: (absoluteDeadline?: number) => Promise<void>) => void): void;
  prepareInspection(absoluteDeadline?: number): Promise<void>;
  closeInspection(absoluteDeadline?: number): Promise<void>;
  operations(): Pick<NativeProcessOperations,'inspectProcessBirth'|'inspectProcessBirthAsync'|'inspectProcessBirths'>;
  fenceOptions(absoluteDeadline?: number): OwnedFenceLockOptions;
  receipt(): {readonly state:string;readonly session:unknown};
}
