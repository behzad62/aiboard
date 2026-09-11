export interface PosixWorkloadGroupIdentity {
  readonly groupId: number;
  readonly leaderPid: number;
  readonly leaderBirth: string;
}
export interface PosixProcessIdentity {
  readonly pid: number;
  readonly groupId: number;
  readonly birth: string;
}
export type PosixProcessIdentityInspection =
  | { readonly state: "present"; readonly value: PosixProcessIdentity }
  | { readonly state: "absent" | "unknown" };
export type PosixAnchorAttestation =
  | { readonly state: "ready"; readonly members: readonly number[] }
  | { readonly state: "identity_mismatch" | "outcome_unknown" };

export function parseLinuxProcStatIdentity(pid: number, stat: string): PosixProcessIdentity | undefined;
export function inspectPosixProcessIdentity(pid: number): PosixProcessIdentityInspection;
export function parsePosixPsIdentity(pid: number, row: string): PosixProcessIdentity | undefined;
export function listOwnedPosixGroupMembers(groupId: number): readonly number[] | undefined;
export function parsePosixGroupMembers(output: string, groupId: number): readonly number[] | undefined;
export function reattestOwnedPosixAnchor(
  workloadGroup: PosixWorkloadGroupIdentity,
  inspect?: (pid: number) => PosixProcessIdentityInspection,
  listMembers?: (groupId: number) => readonly number[] | undefined,
): PosixAnchorAttestation;
export function parsePosixBootstrapPrepared(
  value: unknown,
  nonce: string,
  expectedLeaderPid: number,
): PosixWorkloadGroupIdentity | undefined;
export function parsePosixBootstrapGo(
  value: unknown,
  nonce: string,
  workloadGroup: PosixWorkloadGroupIdentity,
): { readonly supervisorPid: number; readonly supervisorBirth: string } | undefined;
export function isExactPosixAnchorRelease(
  value: unknown,
  nonce: string,
  workloadGroup: PosixWorkloadGroupIdentity,
  expectedSupervisor: { readonly supervisorPid: number; readonly supervisorBirth: string },
  currentFence: { readonly ownerId: string; readonly fencingToken: number },
): boolean;
export function signalOwnedPosixGroup(
  action: "terminate" | "force_terminate",
  signal: (pid: number, signal: NodeJS.Signals) => unknown,
  groupId: number,
): void;
