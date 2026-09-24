/**
 * Change risk (Runner V2 P6.6 T5, OA-4/EP38).
 *
 * Pure, deterministic, zero model calls: no clock, randomness, environment
 * lookup, or model call. Six signals as exported constants. Distinct from
 * risk-policy.ts (`BuildRiskLevel`/`assessBuildRisk`, which gates the
 * independent final verifier): this module (`ChangeRiskLevel`/
 * `assessChangeRisk`) sets per-task deliverable-review depth. The two models
 * coexist; neither replaces the other (G-8).
 */
import { createHash } from "node:crypto";
import { isTestFile } from "./affected-tests.js";

// ---------------------------------------------------------------------------
// Six signals as exported constants (OA-4)
// ---------------------------------------------------------------------------

export const SIGNAL_AUTHOR_MODEL_TIER = "author_model_tier" as const;
export const SIGNAL_SHARED_KERNEL_SURFACE = "shared_kernel_surface" as const;
export const SIGNAL_SOURCE_WITHOUT_TEST = "source_without_test" as const;
export const SIGNAL_MULTIPLE_ATTEMPTS = "multiple_attempts" as const;
export const SIGNAL_ACCEPTED_FAILURES_WAIVER = "accepted_failures_waiver" as const;
export const SIGNAL_SIZE = "size" as const;

export const CHANGE_RISK_SIGNALS = [
  SIGNAL_AUTHOR_MODEL_TIER,
  SIGNAL_SHARED_KERNEL_SURFACE,
  SIGNAL_SOURCE_WITHOUT_TEST,
  SIGNAL_MULTIPLE_ATTEMPTS,
  SIGNAL_ACCEPTED_FAILURES_WAIVER,
  SIGNAL_SIZE,
] as const;

export type ChangeRiskSignal = (typeof CHANGE_RISK_SIGNALS)[number];

// ---------------------------------------------------------------------------
// Tiers and thresholds (exported constants; measured against P6.5 in tests)
// ---------------------------------------------------------------------------

export type ChangeRiskLevel = "low" | "medium" | "high";

/** Author model tier. A lower tier RAISES risk. */
export type ModelTier = "frontier" | "standard" | "fast";

export const DEFAULT_MODEL_TIER: ModelTier = "standard";

/** Points per author tier (lower tier = more points = higher risk). */
export const CHANGE_RISK_AUTHOR_TIER_POINTS: Readonly<Record<ModelTier, number>> = {
  frontier: 0,
  standard: 1,
  fast: 2,
};

export const CHANGE_RISK_KERNEL_TOUCHED_POINTS = 2;
export const CHANGE_RISK_SOURCE_WITHOUT_TEST_POINTS = 2;
export const CHANGE_RISK_MULTIPLE_ATTEMPTS_POINTS = 1;
export const CHANGE_RISK_ACCEPTED_FAILURES_POINTS = 1;

/** Size points: 0 when both dims are at/below LOW maxima; 2 when either dim reaches HIGH minima; else 1. */
export const CHANGE_RISK_SIZE_FILES_LOW_MAX = 3;
export const CHANGE_RISK_SIZE_LINES_LOW_MAX = 120;
export const CHANGE_RISK_SIZE_FILES_HIGH_MIN = 10;
export const CHANGE_RISK_SIZE_LINES_HIGH_MIN = 800;
export const CHANGE_RISK_SIZE_POINTS_LOW = 0;
export const CHANGE_RISK_SIZE_POINTS_MEDIUM = 1;
export const CHANGE_RISK_SIZE_POINTS_HIGH = 2;

/** Tier bands over total points. */
export const CHANGE_RISK_LOW_MAX_SCORE = 1;
export const CHANGE_RISK_HIGH_MIN_SCORE = 4;

/**
 * Shared kernel surface: explicit named set of basenames (not prose).
 * A change touching any of these files raises risk. UI/client files are
 * deliberately absent: a large UI-only change is medium via size, not high
 * via kernel.
 */
export const SHARED_KERNEL_SURFACE: ReadonlySet<string> = new Set([
  "scheduler-store.ts",
  "build-runtime.ts",
  "build-runtime-registry.ts",
  "task-scheduler.ts",
  "task-graph.ts",
  "task-contracts.ts",
  "acceptance-contracts.ts",
  "verifier-contracts.ts",
  "verifier-tools.ts",
  "verifier-verdict-authority.ts",
  "build-spec.ts",
  "architect-tools.ts",
  "worker-lifecycle-tools.ts",
  "native-build-factory.ts",
  "native-build-manager.ts",
  "native-verifier-runtime.ts",
  "native-worker-driver.ts",
  "native-architect-runtime.ts",
  "native-plan-critic-runtime.ts",
  "agent-contracts.ts",
  "agent-loop.ts",
  "agent-prompts.ts",
  "plan-critique-contracts.ts",
  "plan-critique-authority.ts",
  "plan-critique-tools.ts",
  "context-manifest-store.ts",
  "sqlite-context-manifest-store.ts",
  "control-server.ts",
]);

// ---------------------------------------------------------------------------
// OA-16 track-record snapshot (deterministic tier derivation)
// ---------------------------------------------------------------------------

export interface ModelTrackRecord {
  readonly tasksReviewed: number;
  readonly defectsFound: number;
}

export interface ModelTrackRecordSnapshot {
  readonly records: Readonly<Record<string, ModelTrackRecord>>;
  /** Opaque snapshot id for audit (e.g. digest); does not affect scoring. */
  readonly snapshotId: string;
}

export interface ResolvedAuthorTier {
  readonly tier: ModelTier;
  /** True when no history existed and the recorded default was used. */
  readonly usedDefault: boolean;
}

/**
 * Derive the author tier from an OA-16 snapshot, else the recorded default.
 * Deterministic for identical inputs. Rules: no record or zero reviews ->
 * default; >=5 reviews with zero defects -> frontier; defect rate < 0.2 ->
 * standard; otherwise fast.
 */
export function resolveAuthorTier(input: {
  readonly authorModelId: string;
  readonly snapshot?: ModelTrackRecordSnapshot;
  readonly defaultTier?: ModelTier;
}): ResolvedAuthorTier {
  const defaultTier = input.defaultTier ?? DEFAULT_MODEL_TIER;
  const record = input.snapshot?.records[input.authorModelId];
  if (!record || !Number.isSafeInteger(record.tasksReviewed) || !Number.isSafeInteger(record.defectsFound) ||
      record.tasksReviewed <= 0 || record.defectsFound < 0 || record.defectsFound > record.tasksReviewed) {
    return { tier: defaultTier, usedDefault: true };
  }
  if (record.tasksReviewed >= 5 && record.defectsFound === 0) {
    return { tier: "frontier", usedDefault: false };
  }
  const rate = record.defectsFound / record.tasksReviewed;
  if (rate < 0.2) return { tier: "standard", usedDefault: false };
  return { tier: "fast", usedDefault: false };
}

// ---------------------------------------------------------------------------
// Path classification (pure helpers, exported for tests)
// ---------------------------------------------------------------------------

export function basenameOf(path: string): string {
  return path.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? path;
}

export function isTestPath(path: string): boolean {
  return isTestFile(path);
}

export function isDocsOrLedgerPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  return normalized.endsWith(".md") || normalized.includes("docs/") ||
    normalized.includes(".superpowers/") || normalized.includes("progress.md");
}

export function isBinaryOrBundlePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  return normalized.startsWith("public/") || normalized.endsWith(".zip") ||
    normalized.endsWith(".png") || normalized.endsWith(".jpg") || normalized.endsWith(".jpeg");
}

export function isProductSourcePath(path: string): boolean {
  return !isTestPath(path) && !isDocsOrLedgerPath(path) && !isBinaryOrBundlePath(path);
}

export function isKernelPath(path: string): boolean {
  return isKernelPathIn(path, SHARED_KERNEL_SURFACE);
}

/** Kernel membership against a caller-supplied named set (project policy). */
export function isKernelPathIn(path: string, surface: ReadonlySet<string>): boolean {
  return surface.has(basenameOf(path));
}

// ---------------------------------------------------------------------------
// Assessment (pure, deterministic)
// ---------------------------------------------------------------------------

export interface ChangeRiskInput {
  readonly authorModelId: string;
  readonly trackRecordSnapshot?: ModelTrackRecordSnapshot;
  readonly defaultTier?: ModelTier;
  /**
   * Project-configurable shared-kernel surface (basenames). The Runner V2
   * set (SHARED_KERNEL_SURFACE) applies only when the project policy
   * selects it by passing it here; when omitted the kernel signal is
   * recorded as `unconfigured` (visible, 0 points), never silently
   * computed from the Runner V2 default.
   */
  readonly kernelSurface?: readonly string[];
  readonly changedFiles: readonly string[];
  readonly linesAdded: number;
  readonly linesRemoved: number;
  readonly attempts: number;
  readonly acceptedFailuresUsed: boolean;
}

export interface ChangeRiskSignalScore {
  readonly signal: ChangeRiskSignal;
  readonly points: number;
  readonly detail: string;
}

export interface ChangeRiskAssessment {
  readonly tier: ChangeRiskLevel;
  readonly score: number;
  readonly signals: readonly ChangeRiskSignalScore[];
  readonly authorTier: ModelTier;
  readonly authorTierUsedDefault: boolean;
  readonly digest: string;
}

export function sizePoints(files: number, lines: number): number {
  if (files <= CHANGE_RISK_SIZE_FILES_LOW_MAX && lines <= CHANGE_RISK_SIZE_LINES_LOW_MAX) {
    return CHANGE_RISK_SIZE_POINTS_LOW;
  }
  if (files >= CHANGE_RISK_SIZE_FILES_HIGH_MIN || lines >= CHANGE_RISK_SIZE_LINES_HIGH_MIN) {
    return CHANGE_RISK_SIZE_POINTS_HIGH;
  }
  return CHANGE_RISK_SIZE_POINTS_MEDIUM;
}

/**
 * Assess change risk deterministically. Lower author tier raises risk;
 * kernel touch, source-without-test, multiple attempts, waiver use, and
 * size each add points. Bands: score <= LOW_MAX -> low; score >= HIGH_MIN
 * -> high; else medium.
 */
export function assessChangeRisk(input: ChangeRiskInput): ChangeRiskAssessment {
  if (typeof input !== "object" || input === null) {
    throw new Error("ChangeRiskInput must be an object.");
  }
  if (typeof input.authorModelId !== "string" || !input.authorModelId.trim()) {
    throw new Error("ChangeRiskInput requires authorModelId.");
  }
  if (!Array.isArray(input.changedFiles)) {
    throw new Error("ChangeRiskInput requires changedFiles array.");
  }
  if (!Number.isSafeInteger(input.linesAdded) || input.linesAdded < 0 ||
      !Number.isSafeInteger(input.linesRemoved) || input.linesRemoved < 0) {
    throw new Error("ChangeRiskInput requires non-negative linesAdded/linesRemoved.");
  }
  if (!Number.isSafeInteger(input.attempts) || input.attempts < 1) {
    throw new Error("ChangeRiskInput requires attempts >= 1.");
  }
  if (typeof input.acceptedFailuresUsed !== "boolean") {
    throw new Error("ChangeRiskInput requires acceptedFailuresUsed boolean.");
  }
  const resolved = resolveAuthorTier({
    authorModelId: input.authorModelId,
    ...(input.trackRecordSnapshot !== undefined ? { snapshot: input.trackRecordSnapshot } : {}),
    ...(input.defaultTier !== undefined ? { defaultTier: input.defaultTier } : {}),
  });
  const files = input.changedFiles.length;
  const lines = input.linesAdded + input.linesRemoved;
  const surface = input.kernelSurface === undefined ? undefined : new Set(input.kernelSurface);
  const kernelTouched = surface !== undefined && input.changedFiles.some((p) => isKernelPathIn(p, surface));
  const kernelNames = surface === undefined
    ? []
    : input.changedFiles.filter((p) => isKernelPathIn(p, surface)).map(basenameOf).sort();
  const sourceChanged = input.changedFiles.some(isProductSourcePath);
  const testChanged = input.changedFiles.some(isTestPath);
  const sourceWithoutTest = sourceChanged && !testChanged;

  const signals: ChangeRiskSignalScore[] = [
    {
      signal: SIGNAL_AUTHOR_MODEL_TIER,
      points: CHANGE_RISK_AUTHOR_TIER_POINTS[resolved.tier],
      detail: `author tier ${resolved.tier}${resolved.usedDefault ? " (recorded default, no history)" : ""}`,
    },
    {
      signal: SIGNAL_SHARED_KERNEL_SURFACE,
      points: kernelTouched ? CHANGE_RISK_KERNEL_TOUCHED_POINTS : 0,
      detail: surface === undefined
        ? "kernel surface unconfigured (no project policy selected; Runner V2 default not applied)"
        : kernelTouched
          ? `kernel surface touched (${kernelNames.join(",")})`
          : "no kernel surface touched",
    },
    {
      signal: SIGNAL_SOURCE_WITHOUT_TEST,
      points: sourceWithoutTest ? CHANGE_RISK_SOURCE_WITHOUT_TEST_POINTS : 0,
      detail: sourceWithoutTest ? "source changed with no test changed" : "source/test pairing ok",
    },
    {
      signal: SIGNAL_MULTIPLE_ATTEMPTS,
      points: input.attempts > 1 ? CHANGE_RISK_MULTIPLE_ATTEMPTS_POINTS : 0,
      detail: input.attempts > 1 ? `${input.attempts} attempts` : "single attempt",
    },
    {
      signal: SIGNAL_ACCEPTED_FAILURES_WAIVER,
      points: input.acceptedFailuresUsed ? CHANGE_RISK_ACCEPTED_FAILURES_POINTS : 0,
      detail: input.acceptedFailuresUsed ? "acceptedFailures waiver used" : "no waiver",
    },
    {
      signal: SIGNAL_SIZE,
      points: sizePoints(files, lines),
      detail: `${files} files, ${lines} lines`,
    },
  ];
  const score = signals.reduce((sum, s) => sum + s.points, 0);
  const tier: ChangeRiskLevel = score <= CHANGE_RISK_LOW_MAX_SCORE
    ? "low"
    : score >= CHANGE_RISK_HIGH_MIN_SCORE
      ? "high"
      : "medium";
  const digest = createHash("sha256")
    .update(JSON.stringify({
      authorModelId: input.authorModelId,
      tier: resolved.tier,
      usedDefault: resolved.usedDefault,
      kernelSurface: input.kernelSurface === undefined ? "default" : [...input.kernelSurface].sort(),
      files: [...input.changedFiles].sort(),
      linesAdded: input.linesAdded,
      linesRemoved: input.linesRemoved,
      attempts: input.attempts,
      acceptedFailuresUsed: input.acceptedFailuresUsed,
      score,
      level: tier,
    }))
    .digest("hex");
  return { tier, score, signals, authorTier: resolved.tier, authorTierUsedDefault: resolved.usedDefault, digest };
}
