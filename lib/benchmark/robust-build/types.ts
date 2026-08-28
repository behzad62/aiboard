export const ROBUST_BUILD_HARNESS_IDS = [
  "deepseek-harness",
  "runner-v2",
] as const;

export type RobustBuildHarnessId = (typeof ROBUST_BUILD_HARNESS_IDS)[number];

/** The only network modes the sealed parity schema can describe. */
export const HARNESS_NETWORK_POLICIES = ["none", "dependency-only"] as const;

export type HarnessNetworkPolicy = (typeof HARNESS_NETWORK_POLICIES)[number];

/** Capabilities are deliberately semantic, not adapter-specific labels. */
export const HARNESS_PERMISSION_CAPABILITIES = [
  "workspace-read",
  "workspace-write",
  "run-allowlisted-command",
] as const;

export type HarnessPermissionCapability = (typeof HARNESS_PERMISSION_CAPABILITIES)[number];

export const HARNESS_PLATFORMS = [
  "aix",
  "android",
  "darwin",
  "freebsd",
  "haiku",
  "linux",
  "openbsd",
  "sunos",
  "win32",
  "cygwin",
] as const;

export type HarnessPlatform = (typeof HARNESS_PLATFORMS)[number];

export const HARNESS_ARCHITECTURES = [
  "arm",
  "arm64",
  "ia32",
  "loong64",
  "mips",
  "mipsel",
  "ppc",
  "ppc64",
  "riscv64",
  "s390",
  "s390x",
  "x64",
] as const;

export type HarnessArchitecture = (typeof HARNESS_ARCHITECTURES)[number];

export const HARNESS_MONOTONIC_CLOCK_SOURCES = ["monotonic-clock-v1"] as const;

export type HarnessMonotonicClockSource =
  (typeof HARNESS_MONOTONIC_CLOCK_SOURCES)[number];

export const HARNESS_DEADLINE_POLICIES = ["monotonic-hard-deadline"] as const;

export type HarnessDeadlinePolicy = (typeof HARNESS_DEADLINE_POLICIES)[number];

export const HARNESS_DEPENDENCY_POLICIES = ["locked-prefetched"] as const;

export type HarnessDependencyPolicy = (typeof HARNESS_DEPENDENCY_POLICIES)[number];

export const HARNESS_ISOLATION_POLICIES = ["fresh-isolated"] as const;

export type HarnessIsolationPolicy = (typeof HARNESS_ISOLATION_POLICIES)[number];

export const HARNESS_PROCESS_TREE_POLICIES = ["owned-process-tree"] as const;

export type HarnessProcessTreePolicy = (typeof HARNESS_PROCESS_TREE_POLICIES)[number];

export const HARNESS_PORT_POLICIES = ["exclusive-reserved"] as const;

export type HarnessPortPolicy = (typeof HARNESS_PORT_POLICIES)[number];

export interface HarnessParityRole {
  readonly role: string;
  readonly available: true;
  readonly providerId: string;
  readonly modelId: string;
  readonly reasoningEffort: string;
}

export interface HarnessParityLimits {
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxModelCalls: number;
  readonly maxToolCalls: number;
  readonly maxCostUsd: number;
  readonly maxWallClockMs: number;
}

/**
 * The sealed source that produced an arm. A tree hash may describe a Git
 * checkout or a harness artifact; the dependency lock is recorded separately
 * so a matching revision alone cannot be treated as sufficient evidence.
 */
export interface HarnessParitySource {
  readonly revision: string;
  readonly treeHash: string;
  readonly dependencyLockHash: string;
}

export interface HarnessParityPolicy {
  readonly version: 1;
  readonly permissions: readonly HarnessPermissionCapability[];
  readonly network: HarnessNetworkPolicy;
}

/**
 * The effective host/environment restrictions that apply to a scored arm.
 * Every field is semantic and versioned; adapters attest this exact structure
 * immediately before their callback may start model work.
 */
export interface HarnessParityEnvironment {
  readonly version: 1;
  readonly platform: HarnessPlatform;
  readonly architecture: HarnessArchitecture;
  readonly clock: Readonly<{
    source: HarnessMonotonicClockSource;
    deadlinePolicy: HarnessDeadlinePolicy;
  }>;
  readonly dependencies: Readonly<{
    policy: HarnessDependencyPolicy;
    prefetchManifestHash: string;
  }>;
  readonly workspace: HarnessIsolationPolicy;
  readonly state: HarnessIsolationPolicy;
  readonly processTree: HarnessProcessTreePolicy;
  readonly ports: HarnessPortPolicy;
}

export interface HarnessParityArm {
  readonly harness: RobustBuildHarnessId;
  readonly source: HarnessParitySource;
  readonly providerId: string;
  readonly modelId: string;
  readonly reasoningEffort: string;
  readonly roles: readonly HarnessParityRole[];
  readonly limits: HarnessParityLimits;
  readonly policy: HarnessParityPolicy;
  readonly environment: HarnessParityEnvironment;
  readonly baseRepositoryHash: string;
  readonly caseHash: string;
}

export interface HarnessParityContract {
  readonly schemaVersion: 1;
  readonly requiredRoles: readonly string[];
  readonly executionOrder: readonly [RobustBuildHarnessId, RobustBuildHarnessId];
  readonly arms: Readonly<Record<RobustBuildHarnessId, HarnessParityArm>>;
}

export type HarnessParityContractInput = HarnessParityContract;

/**
 * Adapter evidence captured at the launch boundary. It deliberately repeats
 * the arm's effective values so runtime configuration cannot silently differ
 * from the independently sealed contract.
 */
export interface HarnessParityLaunchAttestation extends HarnessParityArm {
  readonly schemaVersion: 1;
}

export type HarnessParityArmCallback<T> = (input: {
  readonly harness: RobustBuildHarnessId;
  readonly arm: HarnessParityArm;
  readonly attestation: HarnessParityLaunchAttestation;
  readonly contract: HarnessParityContract;
}) => T | Promise<T>;

export interface HarnessParityLaunchRecord<T> {
  readonly attestation: HarnessParityLaunchAttestation;
  readonly callback: HarnessParityArmCallback<T>;
}

export type HarnessParityLaunchRecords<T> = Readonly<
  Record<RobustBuildHarnessId, HarnessParityLaunchRecord<T>>
>;

export interface PairedHarnessArmResult<T> {
  readonly harness: RobustBuildHarnessId;
  readonly attestation: HarnessParityLaunchAttestation;
  readonly result: T;
}
