import type { BudgetLimits } from "./budget-ledger.js";
import type { PermissionProfile } from "./contracts.js";
import { assertBudgetLimits } from "./budget-policy.js";
import {
  assertRunnerCapabilityContract,
  cloneRunnerCapabilityContract,
  type RunnerCapabilityContract,
} from "./runner-capability-contract.js";
import {
  PLAN_CRITIQUE_MODES,
  type PlanCritiqueMode,
} from "./plan-critique-contracts.js";

export type NativeBuildRunPolicy = "finish" | "budgeted" | "plan_only";

/**
 * Evidence-gated planning (P6.6 T1) versioned opt-in. Absent on every legacy
 * spec, which stays valid and readable exactly as before — this field is
 * never retrofitted onto an existing active run (build-spec.ts is the only
 * source of truth for whether a run opted in, and only at provisioning time).
 *
 * Honest scope of the "old reader rejects unsupported new-policy data"
 * guarantee (I1, independent review r1): `validateBuildSpecCore` — the ONE
 * reader implementation, built from T1 onward — rejects a `planningPolicy`
 * whose `version` is outside `PLANNING_POLICY_VERSIONS`. That is a
 * forward-compatibility guard: it stops a build spec written by a *later*
 * PLANNING_POLICY_VERSIONS from being silently misread by *this* build.
 * It is NOT a backward guard: a reader built BEFORE this field existed has
 * no unknown-key rejection anywhere in this module (plain object literals
 * accept and silently pass through unknown properties), so such a reader
 * would accept a spec carrying `planningPolicy` and run it under legacy
 * rules. NEW-4 (repair cycle 2, independent review r2): every runner build
 * before T1 — including `main` as of this writing — is exactly such a
 * reader; this is not a theoretical/future case. Running an older runner
 * build against a state directory that already contains a
 * `planningPolicy`-opted run (a downgrade) is the realistic scenario this
 * gap describes. Opting a run into `planningPolicy` is therefore not safe
 * against a downgrade to a pre-T1 runner build. See
 * docs/runner-v2/evidence-gated-planning.md for the same disclosure.
 */
export const PLANNING_POLICY_VERSIONS = [1] as const;
export type PlanningPolicyVersion = (typeof PLANNING_POLICY_VERSIONS)[number];

export interface NativeBuildPlanningPolicy {
  readonly version: PlanningPolicyVersion;
}

export interface NativeBuildBenchmarkPolicy {
  attemptId: string;
  allowedCommands: string[];
  hiddenPaths: string[];
  protectedPaths: string[];
}

export interface NativeBuildSpec {
  version: 2;
  runId: string;
  projectId: string;
  objective: string;
  architectRuntimeId: string;
  workerRuntimeIds: string[];
  verifierRuntimeIds: string[];
  /** Strengthens low-risk qualification; it never disables the high-risk gate. */
  alwaysRequireIndependentVerifier: boolean;
  /** Kernel-counted repair plans per run; omitted means the runtime default. */
  repairPlanLimit?: number;
  maxConcurrency: number;
  permissionProfile: PermissionProfile;
  runPolicy: NativeBuildRunPolicy;
  /**
   * C2b run options (CD-5): verbatim approved-spec copy (default true) and
   * handoff file handling (default "commit"). Absent on legacy specs, which
   * stay valid and read exactly as before.
   */
  specCopy?: boolean;
  handoffFiles?: "commit" | "export_only";
  /** Digest-only manifests by default; "full" also stores rendered pack text. */
  contextRecording?: "manifest" | "full";
  /** Plan-critique policy; omitted means the runtime default of risk_based. */
  planCritique?: PlanCritiqueMode;
  /** Two-pass independent verification; omitted on legacy specs, default true for new runs. */
  verifierTwoPass?: boolean;
  budgetLimits: BudgetLimits;
  createdAt: string;
  idempotencyKey: string;
  /** Durable identity of executable extension and language-provider capabilities. */
  capabilityContract?: RunnerCapabilityContract;
  benchmark?: NativeBuildBenchmarkPolicy;
  /** Opt-in only, set at provisioning; absent means legacy (pre-evidence-gated-planning) behavior. */
  planningPolicy?: NativeBuildPlanningPolicy;
}

export type LegacyNativeBuildSpec = Omit<
  NativeBuildSpec,
  "version" | "runPolicy" | "verifierRuntimeIds" | "alwaysRequireIndependentVerifier"
> & {
  version: 1;
} & Partial<Pick<
  NativeBuildSpec,
  "runPolicy" | "verifierRuntimeIds" | "alwaysRequireIndependentVerifier"
>>;

export interface BuildSpecStore {
  save(spec: NativeBuildSpec): NativeBuildSpec;
  get(runId: string): NativeBuildSpec;
  list(): NativeBuildSpec[];
  close(): void;
}

function validateBuildSpecCore(spec: NativeBuildSpec): void {
  if (spec.version !== 2) throw new Error("Unsupported Build spec version.");
  if (
    !spec.runId ||
    !spec.projectId ||
    !spec.objective.trim() ||
    !spec.architectRuntimeId ||
    !spec.idempotencyKey
  ) throw new Error("Build spec identity is incomplete.");
  if (Number.isNaN(Date.parse(spec.createdAt))) {
    throw new Error("Build spec createdAt must be an ISO timestamp.");
  }
  if (
    !Array.isArray(spec.workerRuntimeIds) ||
    spec.workerRuntimeIds.length < 1 ||
    spec.workerRuntimeIds.some((id) => !id)
  ) throw new Error("Build spec requires at least one worker runtime.");
  if (
    !Array.isArray(spec.verifierRuntimeIds) ||
    spec.verifierRuntimeIds.length < 1
  ) {
    throw new Error("Build spec requires at least one verifier runtime.");
  }
  if (
    spec.verifierRuntimeIds.some(
      (id) => typeof id !== "string" || !id.trim() || id !== id.trim()
    )
  ) {
    throw new Error("Build spec verifier runtime IDs must be non-empty normalized strings.");
  }
  if (new Set(spec.verifierRuntimeIds).size !== spec.verifierRuntimeIds.length) {
    throw new Error("Build spec contains a duplicate verifier runtime.");
  }
  if (typeof spec.alwaysRequireIndependentVerifier !== "boolean") {
    throw new Error(
      "Build spec independent verifier qualification must be a boolean."
    );
  }
  if (
    spec.repairPlanLimit !== undefined &&
    (!Number.isSafeInteger(spec.repairPlanLimit) || spec.repairPlanLimit < 0)
  ) {
    throw new Error("Build spec repairPlanLimit must be a non-negative integer.");
  }
  if (!Number.isSafeInteger(spec.maxConcurrency) || spec.maxConcurrency < 1) {
    throw new Error("Build spec maxConcurrency must be positive.");
  }
  if (!(["guarded", "project", "full"] as unknown[]).includes(spec.permissionProfile)) {
    throw new Error("Build spec permission profile is invalid.");
  }
  if (!(["finish", "budgeted", "plan_only"] as unknown[]).includes(spec.runPolicy)) {
    throw new Error("Build spec run policy is invalid.");
  }
  if (spec.specCopy !== undefined && typeof spec.specCopy !== "boolean") {
    throw new Error("Build spec specCopy must be a boolean.");
  }
  if (
    spec.handoffFiles !== undefined &&
    spec.handoffFiles !== "commit" &&
    spec.handoffFiles !== "export_only"
  ) {
    throw new Error("Build spec handoffFiles must be commit or export_only.");
  }
  if (
    spec.contextRecording !== undefined &&
    spec.contextRecording !== "manifest" &&
    spec.contextRecording !== "full"
  ) {
    throw new Error("Build spec contextRecording must be manifest or full.");
  }
  if (
    spec.planCritique !== undefined &&
    !(PLAN_CRITIQUE_MODES as readonly string[]).includes(spec.planCritique)
  ) {
    throw new Error("Build spec planCritique must be risk_based, always, or off.");
  }
  if (spec.verifierTwoPass !== undefined && typeof spec.verifierTwoPass !== "boolean") {
    throw new Error("Build spec verifierTwoPass must be a boolean.");
  }
  assertBudgetLimits(spec.budgetLimits);
  if (spec.capabilityContract !== undefined) {
    assertRunnerCapabilityContract(spec.capabilityContract);
  }
  if (spec.planningPolicy !== undefined) {
    if (
      typeof spec.planningPolicy !== "object" ||
      spec.planningPolicy === null ||
      !(PLANNING_POLICY_VERSIONS as readonly number[]).includes(spec.planningPolicy.version)
    ) {
      throw new Error(
        `Build spec planningPolicy version is unsupported (this reader supports ${PLANNING_POLICY_VERSIONS.join(", ")}).`
      );
    }
    // M3: reject unknown keys explicitly rather than silently stripping them
    // on clone — an extra key is a signal the writer meant something this
    // reader does not understand.
    const allowedKeys = new Set(["version"]);
    const extraKeys = Object.keys(spec.planningPolicy).filter((key) => !allowedKeys.has(key));
    if (extraKeys.length > 0) {
      throw new Error(`Build spec planningPolicy has unknown fields: ${extraKeys.join(", ")}.`);
    }
  }
  if (spec.benchmark) {
    if (!spec.benchmark.attemptId.trim()) {
      throw new Error("Build spec benchmark attempt identity is incomplete.");
    }
    if (
      !Array.isArray(spec.benchmark.allowedCommands) ||
      spec.benchmark.allowedCommands.some(
        (command) => typeof command !== "string" || !command.trim()
      )
    ) {
      throw new Error("Build spec benchmark commands must be non-empty strings.");
    }
    const normalized = spec.benchmark.allowedCommands.map((command) => command.trim());
    if (new Set(normalized).size !== normalized.length) {
      throw new Error("Build spec contains a duplicate benchmark command.");
    }
    for (const [label, paths] of [
      ["hidden", spec.benchmark.hiddenPaths],
      ["protected", spec.benchmark.protectedPaths],
    ] as const) {
      if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string" || !path.trim())) {
        throw new Error(`Build spec benchmark ${label} paths must be non-empty strings.`);
      }
      if (new Set(paths.map((path) => path.trim())).size !== paths.length) {
        throw new Error(`Build spec contains a duplicate benchmark ${label} path.`);
      }
    }
  }
}

export function assertBuildRunPolicyLimits(
  runPolicy: NativeBuildRunPolicy,
  budgetLimits: BudgetLimits
): void {
  if (runPolicy !== "budgeted") {
    if (Object.keys(budgetLimits).length > 0) {
      throw new Error(`${runPolicy} runs require empty budgetLimits.`);
    }
    return;
  }
  if (
    (budgetLimits.maxEstimatedCostMicros ?? 0) <= 0 &&
    (budgetLimits.maxActiveMs ?? 0) <= 0
  ) {
    throw new Error(
      "Budgeted runs require a positive maxEstimatedCostMicros or maxActiveMs limit."
    );
  }
}

export function validateBuildSpec(spec: NativeBuildSpec): void {
  validateBuildSpecCore(spec);
  assertBuildRunPolicyLimits(spec.runPolicy, spec.budgetLimits);
}

export function recoverLegacyBuildSpec(
  spec: LegacyNativeBuildSpec
): NativeBuildSpec {
  if (spec.version !== 1) {
    throw new Error("Unsupported legacy Build spec version.");
  }
  const legacyRunPolicy = spec.runPolicy === undefined;
  const recovered: NativeBuildSpec = {
    ...spec,
    version: 2,
    runPolicy: spec.runPolicy ?? "finish",
    budgetLimits: legacyRunPolicy ? {} : { ...spec.budgetLimits },
    verifierRuntimeIds:
      spec.verifierRuntimeIds === undefined
        ? [...new Set(spec.workerRuntimeIds)]
        : [...spec.verifierRuntimeIds],
    alwaysRequireIndependentVerifier:
      spec.alwaysRequireIndependentVerifier ?? false,
  };
  validateBuildSpec(recovered);
  return recovered;
}

export function cloneBuildSpec(spec: NativeBuildSpec): NativeBuildSpec {
  return {
    ...spec,
    workerRuntimeIds: [...spec.workerRuntimeIds],
    verifierRuntimeIds: [...spec.verifierRuntimeIds],
    budgetLimits: { ...spec.budgetLimits },
    ...(spec.capabilityContract
      ? { capabilityContract: cloneRunnerCapabilityContract(spec.capabilityContract) }
      : {}),
    ...(spec.repairPlanLimit !== undefined ? { repairPlanLimit: spec.repairPlanLimit } : {}),
    ...(spec.contextRecording !== undefined ? { contextRecording: spec.contextRecording } : {}),
    ...(spec.planCritique !== undefined ? { planCritique: spec.planCritique } : {}),
    ...(spec.verifierTwoPass !== undefined ? { verifierTwoPass: spec.verifierTwoPass } : {}),
    ...(spec.planningPolicy !== undefined
      ? { planningPolicy: { version: spec.planningPolicy.version } }
      : {}),
    ...(spec.benchmark
      ? {
          benchmark: {
            attemptId: spec.benchmark.attemptId,
            allowedCommands: [...spec.benchmark.allowedCommands],
            hiddenPaths: [...spec.benchmark.hiddenPaths],
            protectedPaths: [...spec.benchmark.protectedPaths],
          },
        }
      : {}),
  };
}
