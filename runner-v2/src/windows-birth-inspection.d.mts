import type { NativeProcessOperations } from './native-process-backend.js';

/** The birth helper compiled on this machine from its pinned source (no binary ships). */
export interface WindowsBirthHelperAssembly { readonly path: string; readonly sha256: string; readonly sourceSha256: string }
export type WindowsBirthHelperAssemblyProvider = (source: Uint8Array, sourceSha256: string) => Promise<WindowsBirthHelperAssembly>;

export function loadInstalledSession(assemblyProvider: WindowsBirthHelperAssemblyProvider): Promise<unknown>;

export class WindowsBirthInspectionOwner {
  constructor(
    load?: (assemblyProvider?: WindowsBirthHelperAssemblyProvider) => Promise<unknown>,
    options?: { readonly assembly?: WindowsBirthHelperAssemblyProvider },
  );
  registerCleanup(register: (cleanup: (absoluteDeadline?: number) => Promise<void>) => void): void;
  prepareInspection(absoluteDeadline?: number): Promise<void>;
  closeInspection(absoluteDeadline?: number): Promise<void>;
  operations(): Pick<NativeProcessOperations,'inspectProcessBirth'|'inspectProcessBirthAsync'|'inspectProcessBirths'>;
  /** This process's own birth identity, learned once through the prepared inspection. */
  selfBirth(absoluteDeadline?: number): string;
  /** The compiled helper this prepared inspection runs, for a supervisor to reuse; null until ready. */
  assembly(): WindowsBirthHelperAssembly | null;
  receipt(): {readonly state:string;readonly session:unknown};
}
