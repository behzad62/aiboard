import type { BackpressuredOutputMetadata } from "./interactive-process-channel.js";
import type { ProcessEffectFence } from "./process-backend.js";
import type { OwnedFenceLockOptions } from "./owned-fence-lock.mjs";

export type PortableFenceEffectOutcome<T> =
  | { readonly status: "applied"; readonly value: T }
  | { readonly status: "stale" }
  | { readonly status: "unavailable"; readonly cause: "authority" | "coordination"; readonly error: unknown }
  | { readonly status: "outcome_unknown"; readonly error: unknown };
export type PortableFenceSnapshotOutcome<T> =
  | { readonly status: "applied"; readonly value: T }
  | { readonly status: "stale" }
  | { readonly status: "unavailable"; readonly cause: "authority" | "coordination"; readonly error: unknown }
  | { readonly status: "blocked"; readonly error: unknown };
export class PortableAuthorityUnavailableError extends Error {}
export class PortableOutputRetirementBlockedError extends Error { readonly code: "portable_output_retirement_blocked"; }
export function runPortableFenceEffectSync<T>(options: { readonly lockPath: string; readonly expectedFence: ProcessEffectFence; readonly readCurrentFence: () => ProcessEffectFence; readonly effect: () => T; readonly lockOptions?: OwnedFenceLockOptions }): PortableFenceEffectOutcome<T>;
export function runPortableFenceSnapshotSync<T>(options: { readonly lockPath: string; readonly expectedFence: ProcessEffectFence; readonly readCurrentFence: () => ProcessEffectFence; readonly read: () => T; readonly lockOptions?: OwnedFenceLockOptions }): PortableFenceSnapshotOutcome<T>;
export function settlePortableSupervisorCommand<T>(options: { readonly expectedFence: ProcessEffectFence; readonly readCurrentFence: () => ProcessEffectFence; readonly commit: (fence: ProcessEffectFence, effect: () => T) => PortableFenceEffectOutcome<T>; readonly apply: () => T; readonly retireStale: () => T }): PortableFenceEffectOutcome<T> | { readonly status: "stale"; readonly retirement: "applied" | "deferred" };
export function retirePortableOutputAcknowledgement(options: { readonly channelDirectory: string; readonly nonce: string; readonly fence: ProcessEffectFence; readonly name: string; readonly metadata: BackpressuredOutputMetadata; readonly atomicWrite?: (path: string, value: string) => void; readonly afterBoundary?: (boundary: "intent" | "output" | "checkpoint" | "ack") => void }): void;
export function resumePortableOutputRetirement(options: { readonly channelDirectory: string; readonly nonce: string; readonly fence: ProcessEffectFence; readonly atomicWrite?: (path: string, value: string) => void }): { readonly name: string; readonly metadata: BackpressuredOutputMetadata } | undefined;
export interface PortableOutputSnapshot { readonly checkpoint: { readonly nonce: string; readonly stdout: { readonly sequence: number; readonly endOffset: number }; readonly stderr: { readonly sequence: number; readonly endOffset: number } }; readonly output: ReadonlyArray<{ readonly name: string; readonly metadata: BackpressuredOutputMetadata; readonly bytes: Uint8Array }>; readonly acknowledgements: readonly string[]; }
export function readPortableOutputSnapshot(options: { readonly channelDirectory: string; readonly nonce: string; readonly supervisorPid?: number }): PortableOutputSnapshot;
export function validatePortableAcknowledgements(acknowledgementDirectory: string, nonce: string, output: ReadonlyArray<{ readonly name: string; readonly metadata: BackpressuredOutputMetadata }>): string[];
