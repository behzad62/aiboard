/**
 * Validation observations (Runner V2 P6.6 T5, EP17/EP18 + OA-14 observation half).
 *
 * Pure, deterministic, zero model calls. Typed observations carry command/
 * method, revision plus uncommitted-content digest, environment/capability/
 * config/dependency fingerprints, actual outcomes/counts, and inspectable
 * artifacts. Unsupported output is `unknown`, never guessed green.
 *
 * Reuses T1's frozen `ValidationObservation` vocabulary; this module adds the
 * meaningful-observation guards (zero selection, unexplained skip, stale
 * dirty hash, substituted artifact, wrong environment, unrelated RED, prose
 * claim, RG-2) plus RED->GREEN, fault-injection, and flaky-isolation records.
 */
import {
  validateValidationObservation,
  type ValidationObservation,
  type ValidationOutcome,
} from "./planning-contracts.js";
import { assertSatisfiedVerdictsCiteGreenEvidence } from "./acceptance-contracts.js";
import type { EvidenceRecord } from "./evidence-store.js";

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Observation creation with meaningful-observation guards
// ---------------------------------------------------------------------------

export interface ObservationFingerprints {
  readonly environment: string;
  readonly capability: string;
  readonly config: string;
  readonly dependency: string;
}

export interface CreateObservationInput {
  readonly id: string;
  readonly intentId: string;
  readonly evidenceId: string;
  readonly command: string;
  readonly method: string;
  /** False when the method's output has no machine-readable adapter. */
  readonly methodSupported: boolean;
  readonly snapshotRevision: string;
  readonly dirty: boolean;
  readonly dirtySummary?: string;
  /** Required when dirty: digest of the relevant uncommitted content. */
  readonly uncommittedContentDigest?: string;
  readonly exitCode: number | null;
  readonly fingerprints: ObservationFingerprints;
  readonly outcome: ValidationOutcome;
  readonly counts: { readonly selected: number; readonly passed: number; readonly failed: number; readonly skipped: number };
  readonly selectedAssertionIds?: readonly string[];
  readonly skippedAssertionIds?: readonly string[];
  /** Required when skipped > 0: why each skip is legitimate. */
  readonly skipRationale?: string;
  /** Inspectable artifact hashes (stdout/stderr/report). Non-empty required. */
  readonly artifactHashes: readonly string[];
}

export interface MeaningfulObservation {
  readonly observation: ValidationObservation;
  readonly capabilityFingerprint: string;
  readonly uncommittedContentDigest?: string;
  readonly artifactHashes: readonly string[];
  readonly skipRationale?: string;
}

/**
 * Create a validated observation. Rejects: dirty without digest, empty
 * artifacts, unsupported method claiming passed, zero-selected passed
 * (via T1), unexplained skips, and malformed fingerprints.
 */
export function createValidationObservation(input: CreateObservationInput): MeaningfulObservation {
  if (typeof input !== "object" || input === null) {
    throw new Error("CreateObservationInput must be an object.");
  }
  if (!nonEmpty(input.id) || !nonEmpty(input.intentId) || !nonEmpty(input.evidenceId)) {
    throw new Error("Observation requires id, intentId, and evidenceId.");
  }
  if (!nonEmpty(input.command) || !nonEmpty(input.method)) {
    throw new Error("Observation requires command and method.");
  }
  if (input.methodSupported !== true && input.methodSupported !== false) {
    throw new Error("Observation requires methodSupported boolean.");
  }
  if (!nonEmpty(input.snapshotRevision)) {
    throw new Error("Observation requires snapshotRevision.");
  }
  if (input.dirty && !nonEmpty(input.uncommittedContentDigest)) {
    throw new Error("A dirty observation requires uncommittedContentDigest (relevant uncommitted content digest).");
  }
  if (!input.fingerprints || !nonEmpty(input.fingerprints.environment) || !nonEmpty(input.fingerprints.capability) ||
      !nonEmpty(input.fingerprints.config) || !nonEmpty(input.fingerprints.dependency)) {
    throw new Error("Observation requires environment/capability/config/dependency fingerprints.");
  }
  if (!Array.isArray(input.artifactHashes) || input.artifactHashes.length === 0 ||
      input.artifactHashes.some((h) => !nonEmpty(h))) {
    throw new Error("Observation requires at least one inspectable artifact hash.");
  }
  if (input.methodSupported === false && input.outcome === "passed") {
    throw new Error("Unsupported output is unknown, never passed: methodSupported=false cannot yield outcome passed.");
  }
  if (input.outcome === "passed" && input.counts.passed === 0) {
    throw new Error("A passed outcome requires at least one passing assertion (nothing-ran is unknown, never passed).");
  }
  if (input.counts.skipped > 0 && (!nonEmpty(input.skipRationale) ||
      !Array.isArray(input.skippedAssertionIds) || input.skippedAssertionIds.length === 0)) {
    throw new Error("Skipped assertions require skippedAssertionIds and an explicit skipRationale (unexplained skip is not green).");
  }
  const observation: ValidationObservation = {
    id: input.id,
    intentId: input.intentId,
    evidenceId: input.evidenceId,
    command: input.command,
    method: input.method,
    snapshotRevision: input.snapshotRevision,
    dirty: input.dirty,
    ...(input.dirtySummary !== undefined ? { dirtySummary: input.dirtySummary } : {}),
    exitCode: input.exitCode,
    environmentFingerprint: input.fingerprints.environment,
    configFingerprint: input.fingerprints.config,
    dependencyFingerprint: input.fingerprints.dependency,
    outcome: input.outcome,
    counts: { ...input.counts },
    ...(input.selectedAssertionIds !== undefined ? { selectedAssertionIds: [...input.selectedAssertionIds] } : {}),
    ...(input.skippedAssertionIds !== undefined ? { skippedAssertionIds: [...input.skippedAssertionIds] } : {}),
  };
  const validation = validateValidationObservation(observation);
  if (!validation.valid) {
    throw new Error(`Observation ${input.id} is invalid: ${validation.issues.map((i) => i.message).join(" ")}`);
  }
  return {
    observation,
    capabilityFingerprint: input.fingerprints.capability,
    ...(input.uncommittedContentDigest !== undefined ? { uncommittedContentDigest: input.uncommittedContentDigest } : {}),
    artifactHashes: [...input.artifactHashes],
    ...(input.skipRationale !== undefined ? { skipRationale: input.skipRationale } : {}),
  };
}

// ---------------------------------------------------------------------------
// Acceptance assessment: what cannot satisfy acceptance
// ---------------------------------------------------------------------------

export interface AcceptanceAssessmentInput {
  readonly observation: MeaningfulObservation;
  /** Assertions the intent requires (every one selected, executed, and passed). */
  readonly requiredAssertionIds: readonly string[];
  readonly expectedSnapshotRevision: string;
  readonly expectedDirty: boolean;
  readonly expectedUncommittedContentDigest?: string;
  readonly expectedEnvironmentFingerprint: string;
  readonly expectedCapabilityFingerprint: string;
  readonly expectedConfigFingerprint?: string;
  readonly expectedDependencyFingerprint?: string;
  readonly expectedArtifactHashes: readonly string[];
  /** True when this check is a required passing test (RG-2 applies). */
  readonly isRequiredPassingTest: boolean;
  /** Evidence records cited by the verdict (for RG-2 failing-command check). */
  readonly citedEvidenceRecords?: readonly EvidenceRecord[];
  /** Accepted-failure entries on the verdict, if any. */
  readonly acceptedFailures?: readonly { readonly evidenceId: string; readonly rationale: string }[];
  /** Rationale offered for a failing observation (never a loophole for required GREEN). */
  readonly rationale?: string;
}

/**
 * Machine-readable validation methods: only these may discharge acceptance.
 * Anything else (a manual claim, reviewer prose under another name, or a
 * bare `command` / `exit_code` record with caller-synthesised counts) is a
 * prose claim without machine-readable outcome/counts, never green: OA-13
 * says exit status alone is not proof that a test ran.
 */
export const MACHINE_READABLE_METHODS: ReadonlySet<string> = new Set([
  "junit",
  "trx",
  "gtest",
  "pytest",
  "jest",
  "jest_junit",
  "cargo",
  "cargo_nextest",
  "go_junit",
  "dotnet_trx",
  "maven_surefire",
  "surefire",
  "xunit",
  "nunit",
  "browser_assertion",
]);

export interface AcceptanceAssessment {
  readonly satisfies: boolean;
  readonly reasons: readonly string[];
}

/**
 * Decide whether an observation can satisfy acceptance. Any of: exit 0 with
 * zero selected, no relevant assertions, unexplained skip, stale dirty-tree
 * hash, substituted artifact, wrong environment/capability, unrelated RED,
 * prose claim, or RG-2 failing-command-for-required-GREEN fails closed.
 */
export function assessObservationForAcceptance(input: AcceptanceAssessmentInput): AcceptanceAssessment {
  const reasons: string[] = [];
  const obs = input.observation.observation;

  if (obs.outcome !== "passed") {
    reasons.push(`Outcome is ${obs.outcome}, not passed.`);
  }
  if (obs.counts.selected === 0) {
    reasons.push("Zero selected tests cannot satisfy acceptance (exit 0 with nothing selected is not green).");
  }
  if (!MACHINE_READABLE_METHODS.has(obs.method.toLowerCase()) || obs.command.trim() === "") {
    reasons.push("A prose claim without machine-readable outcome/counts cannot satisfy acceptance.");
  }
  if (obs.counts.passed === 0) {
    reasons.push("No passing assertions: an observation with zero passed tests cannot satisfy acceptance.");
  }
  if (input.requiredAssertionIds.length === 0) {
    reasons.push("No required assertions declared: the contract requires assertions, so acceptance is unknown.");
  } else {
    const selected = new Set(obs.selectedAssertionIds ?? []);
    const skipped = new Set(obs.skippedAssertionIds ?? []);
    const missing = input.requiredAssertionIds.filter((id) => !selected.has(id));
    if (missing.length > 0) {
      reasons.push(`Required assertions never exercised: ${missing.sort().join(", ")}.`);
    }
    const skippedRequired = input.requiredAssertionIds.filter((id) => skipped.has(id));
    if (skippedRequired.length > 0) {
      reasons.push(`Required assertions skipped, not executed: ${skippedRequired.sort().join(", ")} (a skip rationale never covers a required assertion).`);
    }
  }
  if (obs.counts.skipped > 0 && !nonEmpty(input.observation.skipRationale)) {
    reasons.push("Unexplained skip cannot satisfy acceptance.");
  }
  if (obs.snapshotRevision !== input.expectedSnapshotRevision) {
    reasons.push(`Stale snapshot: observed ${obs.snapshotRevision}, expected ${input.expectedSnapshotRevision}.`);
  }
  const expectedDigest = input.expectedUncommittedContentDigest;
  const observedDigest = input.observation.uncommittedContentDigest;
  if (obs.dirty !== input.expectedDirty) {
    reasons.push(
      obs.dirty
        ? "Stale dirty-tree evidence: the observation describes uncommitted content but the current tree is clean."
        : "Stale clean-tree evidence: the current tree is dirty but the observation claims a clean tree.",
    );
  } else if (obs.dirty) {
    if (!nonEmpty(observedDigest) || !nonEmpty(expectedDigest)) {
      reasons.push("Dirty-tree identity unknown: a missing uncommitted-content digest on either side is not a match.");
    } else if (observedDigest !== expectedDigest) {
      reasons.push("Stale dirty-tree hash: uncommitted content digest does not match.");
    }
  } else if (nonEmpty(observedDigest) || nonEmpty(expectedDigest)) {
    reasons.push("Clean-tree identity mismatch: a clean observation must not carry a dirty-tree digest.");
  }
  const observedArtifacts = new Set(input.observation.artifactHashes);
  if (input.expectedArtifactHashes.length === 0) {
    reasons.push("No expected artifacts declared: the contract cites inspectable artifacts, so an empty expectation cannot satisfy acceptance.");
  }
  for (const expected of input.expectedArtifactHashes) {
    if (!observedArtifacts.has(expected)) {
      reasons.push(`Substituted artifact: expected artifact ${expected} is not recorded by the observation.`);
    }
  }
  if (obs.environmentFingerprint !== input.expectedEnvironmentFingerprint) {
    reasons.push("Wrong environment: environment fingerprint does not match.");
  }
  if (input.observation.capabilityFingerprint !== input.expectedCapabilityFingerprint) {
    reasons.push("Wrong capability: capability fingerprint does not match.");
  }
  if (input.expectedConfigFingerprint === undefined || input.expectedDependencyFingerprint === undefined) {
    reasons.push("Missing config/dependency expectation: without both fingerprints acceptance is unknown.");
  } else {
    if (obs.configFingerprint !== input.expectedConfigFingerprint) {
      reasons.push("Wrong config: config fingerprint does not match.");
    }
    if (obs.dependencyFingerprint !== input.expectedDependencyFingerprint) {
      reasons.push("Wrong dependency: dependency fingerprint does not match.");
    }
  }
  // RG-2: a failing command cannot discharge a required passing test, even
  // with a rationale or an acceptedFailures entry. acceptedFailures proves
  // defect detection (RED), never required GREEN.
  if (input.isRequiredPassingTest && obs.exitCode !== null && obs.exitCode !== 0) {
    reasons.push("RG-2: failing-command evidence cannot satisfy a required passing test (no rationale loophole).");
  }
  if (input.isRequiredPassingTest && input.citedEvidenceRecords !== undefined) {
    try {
      assertSatisfiedVerdictsCiteGreenEvidence(
        [{ verdict: "satisfied", evidenceIds: input.citedEvidenceRecords.map((r) => r.id), acceptedFailures: input.acceptedFailures }],
        input.citedEvidenceRecords,
        "T5 acceptance",
      );
      // Even when RG-2's citation rule passes (accepted failure cited), a
      // required passing test still needs a GREEN observation, not an
      // accepted RED. The exit-code check above already rejects it; this
      // keeps the verdict-level rule visibly enforced here too.
      const failing = input.citedEvidenceRecords.some((r) =>
        r.fact.kind === "command" && (r.fact.exitCode !== 0 || r.fact.signal !== null || r.fact.timedOut || r.fact.cancelled));
      if (failing) {
        reasons.push("RG-2: an accepted RED citation proves detection; it cannot discharge a required passing test.");
      }
    } catch (error) {
      reasons.push(`RG-2 citation rule violated: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { satisfies: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// RED -> GREEN pairs (EP17)
// ---------------------------------------------------------------------------

export interface RedGreenPairInput {
  readonly defectId: string;
  readonly red: MeaningfulObservation;
  readonly green: MeaningfulObservation;
  /** Harness/setup/import failures are not behavior proof. */
  readonly redFailureClass: string;
}

export interface RedGreenPair {
  readonly defectId: string;
  readonly redObservationId: string;
  readonly greenObservationId: string;
}

const HARNESS_FAILURE_CLASSES = new Set(["harness", "setup", "import", "harness_failure", "setup_failure"]);

/**
 * Record a meaningful pre-fix RED and post-fix GREEN for the same defect.
 * Both must share the intent; the RED must be a genuine behavior failure,
 * not a harness/setup failure; an unrelated RED cannot pair.
 */
export function recordRedGreenPair(input: RedGreenPairInput): RedGreenPair {
  if (!nonEmpty(input.defectId)) throw new Error("RED->GREEN pair requires a defectId.");
  if (input.red.observation.outcome !== "failed") {
    throw new Error("RED->GREEN pair requires the red observation outcome to be failed.");
  }
  if (input.green.observation.outcome !== "passed") {
    throw new Error("RED->GREEN pair requires the green observation outcome to be passed.");
  }
  if (input.red.observation.intentId !== input.green.observation.intentId) {
    throw new Error("RED->GREEN pair requires both observations to share the same intent (unrelated RED cannot satisfy).");
  }
  if (HARNESS_FAILURE_CLASSES.has(input.redFailureClass.toLowerCase())) {
    throw new Error(`RED failure class "${input.redFailureClass}" is a harness/setup failure, not behavior proof.`);
  }
  if (input.red.observation.counts.selected === 0 || input.green.observation.counts.selected === 0) {
    throw new Error("RED->GREEN pair requires selected assertions on both sides.");
  }
  return {
    defectId: input.defectId,
    redObservationId: input.red.observation.id,
    greenObservationId: input.green.observation.id,
  };
}

// ---------------------------------------------------------------------------
// Controlled fault injection (EP17)
// ---------------------------------------------------------------------------

export interface FaultInjectionInput {
  readonly guardId: string;
  readonly defectId: string;
  readonly faultDescription: string;
  /** The test that catches the fault; it must be retained. */
  readonly retainedTestId: string;
  readonly testRetained: boolean;
  readonly originalSnapshotDigest: string;
  readonly restoredSnapshotDigest: string;
  /** Files changed by the injection (must be isolated to the guard). */
  readonly changedFiles: readonly string[];
  readonly allowedGuardFiles: readonly string[];
  /** True only when no meaningful RED->GREEN already proves this defect. */
  readonly noExistingRedGreenForDefect: boolean;
  /** Must be false: protected-evidence mutation is prohibited. */
  readonly protectedEvidenceMutated: boolean;
}

export interface FaultInjectionRecord {
  readonly guardId: string;
  readonly defectId: string;
  readonly retainedTestId: string;
}

/**
 * Record a controlled fault injection for an already-correct guard or a
 * distinct invariant only. Retains the test, restores only the fault
 * (byte-exact digest match), isolates changes to the guard, and refuses any
 * protected-evidence mutation or redundant same-defect mutation.
 */
export function recordFaultInjection(input: FaultInjectionInput): FaultInjectionRecord {
  if (!nonEmpty(input.guardId) || !nonEmpty(input.defectId) || !nonEmpty(input.faultDescription)) {
    throw new Error("Fault injection requires guardId, defectId, and faultDescription.");
  }
  if (!input.testRetained || !nonEmpty(input.retainedTestId)) {
    throw new Error("Fault injection must retain the catching test.");
  }
  if (input.protectedEvidenceMutated) {
    throw new Error("Fault injection must not mutate protected evidence.");
  }
  if (!input.noExistingRedGreenForDefect) {
    throw new Error("Redundant same-defect mutation refused: a meaningful RED->GREEN already proves this defect.");
  }
  if (input.originalSnapshotDigest !== input.restoredSnapshotDigest) {
    throw new Error("Fault injection must restore only the fault: restored snapshot digest must equal the original.");
  }
  const allowed = new Set(input.allowedGuardFiles);
  for (const file of input.changedFiles) {
    if (!allowed.has(file)) {
      throw new Error(`Fault injection touched ${file}, outside the isolated guard surface.`);
    }
  }
  return { guardId: input.guardId, defectId: input.defectId, retainedTestId: input.retainedTestId };
}

// ---------------------------------------------------------------------------
// Flaky isolation (OA-14 observation half, EP48)
// ---------------------------------------------------------------------------

export interface FlakyIsolationInput {
  readonly first: MeaningfulObservation;
  readonly rerun: MeaningfulObservation;
  /** Must be zero: the rerun happens once. */
  readonly priorRerunCount: number;
  /**
   * The failing assertion ids of the first run (required). The rerun must
   * select exactly these: a rerun of any other test the first run selected
   * proves nothing about the failure, and T1's observation carries no
   * per-assertion results to identify them mechanically.
   */
  readonly failedAssertionIds: readonly string[];
}

export interface FlakyIsolationObservation {
  readonly firstObservationId: string;
  readonly rerunObservationId: string;
  readonly rerunSelectedAssertionIds: readonly string[];
  readonly outcome: "flaky" | "consistent_failure";
}

/**
 * Record a re-run of exactly the failing tests, once, on the same revision
 * and environment. Pass on re-run records `flaky` (still blocks acceptance
 * until the check passes on its own run — T6's gate); fail again records
 * `consistent_failure`. The failing ids are an explicit input: without them
 * the rerun cannot be shown to repeat the failure, so the record is refused.
 */
export function recordFlakyIsolation(input: FlakyIsolationInput): FlakyIsolationObservation {
  if (input.priorRerunCount !== 0) {
    throw new Error("Flaky isolation re-runs only the failing tests once.");
  }
  const first = input.first.observation;
  const rerun = input.rerun.observation;
  if (first.outcome !== "failed") {
    throw new Error("Flaky isolation requires the first observation to have failed.");
  }
  if (!Array.isArray(input.failedAssertionIds) || input.failedAssertionIds.length === 0) {
    throw new Error("Flaky isolation requires the first run's failing assertion ids (failedAssertionIds): without them the rerun cannot be shown to repeat the failure.");
  }
  if (input.failedAssertionIds.length !== first.counts.failed) {
    throw new Error(`Flaky isolation declares ${input.failedAssertionIds.length} failing test(s) but the first run failed ${first.counts.failed}.`);
  }
  const firstSelected = new Set(first.selectedAssertionIds ?? []);
  for (const id of input.failedAssertionIds) {
    if (!firstSelected.has(id)) {
      throw new Error(`Flaky isolation declares failing test ${id}, which the first run never selected.`);
    }
  }
  if (first.snapshotRevision !== rerun.snapshotRevision) {
    throw new Error("Flaky isolation requires the same revision for first and rerun.");
  }
  if (input.first.uncommittedContentDigest !== input.rerun.uncommittedContentDigest) {
    throw new Error("Flaky isolation requires the same uncommitted-content digest for first and rerun.");
  }
  if (first.environmentFingerprint !== rerun.environmentFingerprint) {
    throw new Error("Flaky isolation requires the same environment for first and rerun.");
  }
  if (input.first.capabilityFingerprint !== input.rerun.capabilityFingerprint) {
    throw new Error("Flaky isolation requires the same capability fingerprint for first and rerun.");
  }
  if (first.configFingerprint !== rerun.configFingerprint) {
    throw new Error("Flaky isolation requires the same config fingerprint for first and rerun.");
  }
  if (first.dependencyFingerprint !== rerun.dependencyFingerprint) {
    throw new Error("Flaky isolation requires the same dependency fingerprint for first and rerun.");
  }
  const failedSet = new Set(input.failedAssertionIds);
  for (const id of rerun.selectedAssertionIds ?? []) {
    if (!firstSelected.has(id)) {
      throw new Error(`Flaky isolation re-runs only the failing tests: rerun repeats ${id}, which the first run never selected.`);
    }
  }
  if ((rerun.skippedAssertionIds ?? []).length > 0) {
    throw new Error("Flaky isolation re-runs the failing tests to completion: the rerun must not skip.");
  }
  if (first.intentId !== rerun.intentId) {
    throw new Error("Flaky isolation requires the same intent for first and rerun.");
  }
  const rerunSelected = [...(rerun.selectedAssertionIds ?? [])].sort();
  const failedSorted = [...failedSet].sort();
  if (rerunSelected.length !== failedSorted.length ||
      rerunSelected.some((id, index) => id !== failedSorted[index])) {
    throw new Error(`Flaky isolation re-runs only the failing tests: rerun selected [${rerunSelected.join(", ")}], first failed [${failedSorted.join(", ")}] (must match exactly).`);
  }
  return {
    firstObservationId: first.id,
    rerunObservationId: rerun.id,
    rerunSelectedAssertionIds: [...(rerun.selectedAssertionIds ?? [])],
    outcome: rerun.outcome === "passed" ? "flaky" : "consistent_failure",
  };
}
