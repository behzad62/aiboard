export const ROBUST_BUILD_HARNESS_IDS = [
  "deepseek-harness",
  "runner-v2",
] as const;

export type RobustBuildHarnessId = (typeof ROBUST_BUILD_HARNESS_IDS)[number];

export interface HarnessParityRole {
  readonly role: string;
  readonly available: boolean;
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

export interface HarnessParityPolicy {
  readonly permissions: readonly string[];
  readonly network: string;
}

export interface HarnessParityArm {
  readonly harness: RobustBuildHarnessId;
  readonly sourceRevision: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly reasoningEffort: string;
  readonly roles: readonly HarnessParityRole[];
  readonly limits: HarnessParityLimits;
  readonly policy: HarnessParityPolicy;
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

export type HarnessParityArmCallback<T> = (input: {
  readonly harness: RobustBuildHarnessId;
  readonly arm: HarnessParityArm;
  readonly contract: HarnessParityContract;
}) => T;

export type HarnessParityArmCallbacks<T> = Readonly<
  Record<RobustBuildHarnessId, HarnessParityArmCallback<T>>
>;

export interface PairedHarnessArmResult<T> {
  readonly harness: RobustBuildHarnessId;
  readonly result: T;
}
