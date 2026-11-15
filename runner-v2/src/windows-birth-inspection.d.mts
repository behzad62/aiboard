import type { NativeProcessOperations } from './native-process-backend.js';

export class WindowsBirthInspectionOwner {
  constructor();
  registerCleanup(register: (cleanup: (absoluteDeadline?: number) => Promise<void>) => void): void;
  prepareInspection(absoluteDeadline?: number): Promise<void>;
  closeInspection(absoluteDeadline?: number): Promise<void>;
  operations(): Pick<NativeProcessOperations,'inspectProcessBirth'|'inspectProcessBirthAsync'|'inspectProcessBirths'>;
  /** This process's own birth identity, learned once through the prepared inspection. */
  selfBirth(absoluteDeadline?: number): string;
  receipt(): {readonly state:string;readonly session:unknown};
}
