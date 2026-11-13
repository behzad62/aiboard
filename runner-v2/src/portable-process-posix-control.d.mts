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

export function readPosixProcessCommandLine(pid: number): string | undefined;
export function posixProcessGroupAlive(groupId: number, confirm?: boolean, listMembers?: (groupId: number) => readonly number[] | undefined): boolean | undefined;
export function inspectPosixProcessIdentities(pids: readonly number[]): Map<number, PosixProcessIdentityInspection>;
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
export type PosixDescendantAttestation =
  | { readonly state: "ready"; readonly members: readonly number[] }
  | { readonly state: "empty" }
  | { readonly state: "identity_mismatch" | "outcome_unknown" };
export function reattestOwnedPosixDescendants(
  workloadGroup: PosixWorkloadGroupIdentity,
  recordedMembers: ReadonlyMap<number, string>,
  inspect?: (pid: number) => PosixProcessIdentityInspection,
  listMembers?: (groupId: number) => readonly number[] | undefined,
): PosixDescendantAttestation;
export function parseLinuxProcStatCpu(pid: number, stat: string): { readonly groupId: number; readonly ticks: number } | undefined;
export function parsePosixCpuClock(value: string): number | undefined;
export function parsePosixPsCpu(output: string, groupId: number): Map<number, number> | undefined;
export function readLinuxProcCpu(
  pids: readonly number[],
  groupId: number,
  readStat?: (pid: number) => string,
  ticksPerSecond?: () => number,
): Map<number, number> | undefined;
export function readPosixPsCpu(pids: readonly number[], groupId: number): Map<number, number> | undefined;
export function readOwnedPosixCpu(pids: readonly number[], groupId: number): Map<number, number> | undefined;
export interface PosixCpuSample {
  readonly cpuTimeMs: number;
  readonly sampledAt: string;
}
export function createPosixCpuSampler(options: {
  readonly groupId: number;
  readonly leaderPid: number;
  readonly publish: (sample: PosixCpuSample) => void;
  readonly read?: (pids: readonly number[], groupId: number) => ReadonlyMap<number, number> | undefined;
  readonly now?: () => number;
  readonly intervalMs?: number;
}): { tick(members: readonly number[]): void };
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
