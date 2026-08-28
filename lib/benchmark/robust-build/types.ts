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

/**
 * A trusted probe can report a known unsafe dependency state so a sealed lease
 * can fail as drift instead of treating the value as an adapter-specific label.
 */
export const HARNESS_DEPENDENCY_POLICIES = [
  "locked-prefetched",
  "unlocked-or-unprefetched",
] as const;

export type HarnessDependencyPolicy = (typeof HARNESS_DEPENDENCY_POLICIES)[number];

/**
 * Both states are reportable observations. Only fresh-isolated is legal in a
 * sealed contract; a trusted lease can report the known unsafe state so
 * revalidation exposes drift before the corresponding launcher can begin.
 */
export const HARNESS_ISOLATION_POLICIES = ["fresh-isolated", "shared-or-reused"] as const;

export type HarnessIsolationPolicy = (typeof HARNESS_ISOLATION_POLICIES)[number];

export const HARNESS_PROCESS_TREE_POLICIES = [
  "owned-process-tree",
  "unowned-process-tree",
] as const;

export type HarnessProcessTreePolicy = (typeof HARNESS_PROCESS_TREE_POLICIES)[number];

export const HARNESS_PORT_POLICIES = ["exclusive-reserved", "shared-or-unreserved"] as const;

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
 * Every field is semantic and versioned; a trusted lease observes this exact
 * structure immediately before its launcher may start model work.
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

declare const observedHarnessParityFactsBrand: unique symbol;

/**
 * Facts observed independently by a trusted preparation lease. This branded
 * shape is deliberately distinct from the caller-authored contract: P6.2
 * adapters must populate it from real checkout, lockfile, provider, budget,
 * policy, and environment probes rather than copying contract JSON.
 */
export type HarnessParityObservedFacts = HarnessParityArm & {
  readonly [observedHarnessParityFactsBrand]?: never;
};

export type HarnessParityMaybePromise<T> = T | Promise<T>;

export interface HarnessParityLaunchInput {
  readonly harness: RobustBuildHarnessId;
  readonly arm: HarnessParityArm;
  readonly observedFacts: HarnessParityObservedFacts;
  readonly contract: HarnessParityContract;
}

export interface HarnessParityPreparationInput {
  readonly harness: RobustBuildHarnessId;
  readonly arm: HarnessParityArm;
  readonly contract: HarnessParityContract;
}

/**
 * A trusted, model-free preparation lease. Its functions must be supplied by
 * adapter code that owns the actual resources. In P6.2 that means probing the
 * sealed checkout/tree/lock and effective provider, budgets, policies, and
 * isolation state; retaining the owned workspace/state/process/port leases;
 * and releasing those leases without model calls.
 */
export interface TrustedHarnessParityLease<T> {
  readonly observedFacts: HarnessParityObservedFacts;
  readonly revalidate: () => HarnessParityMaybePromise<HarnessParityObservedFacts>;
  readonly launch: (input: HarnessParityLaunchInput) => HarnessParityMaybePromise<T>;
  readonly release: () => HarnessParityMaybePromise<void>;
}

/**
 * Trusted P6.1 preparation boundary. It is intentionally the only source of
 * launch functions: execution never accepts caller-provided callbacks or
 * caller-authored attestation records. Implementations must be model-free.
 */
export interface HarnessParityPreparationAdapter<T> {
  readonly prepare: (
    input: HarnessParityPreparationInput
  ) => HarnessParityMaybePromise<TrustedHarnessParityLease<T>>;
}

declare const trustedHarnessParityAuthorityBrand: unique symbol;

/**
 * Opaque authority issued only by createTrustedHarnessParityAuthority(). A
 * plain object with a prepare callback is never an authority at the launch
 * boundary. P6.2 adapters must enter through that factory and use real
 * filesystem/Git/lock/environment probes plus owned launcher leases; they must
 * also atomically clean up anything they acquire if prepare throws or cannot
 * return an envelope with an own enumerable data-function release, because the
 * parity module cannot release a resource it never received safely.
 */
export interface TrustedHarnessParityAuthority<T> {
  readonly [trustedHarnessParityAuthorityBrand]: T;
}

declare const preparedHarnessParityPairBrand: unique symbol;

/**
 * Opaque module-issued capability. A plain object, clone, or serialized copy
 * is not a valid prepared pair at runtime; only the parity module registry can
 * bind one to trusted leases. A recovery pair attached to a cleanup error is
 * cleanup-only: it can be released, but never executed.
 */
export interface PreparedHarnessParityPair<T> {
  readonly [preparedHarnessParityPairBrand]: T;
}

export interface PairedHarnessArmResult<T> {
  readonly harness: RobustBuildHarnessId;
  readonly observedFacts: HarnessParityObservedFacts;
  readonly result: T;
}
