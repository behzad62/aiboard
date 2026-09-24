/**
 * Evidence applicability (Runner V2 P6.6 T5, EP19/EP20 + OA-2/EP35).
 *
 * Pure, deterministic, zero model calls. Conservative dependency-based reuse:
 * reusable / invalidated / unknown with an applicability proof. Changed
 * behavior/config/dependency/environment invalidates affected and downstream
 * required checks; unrelated commits alone do not. Missing impact info yields
 * a bounded investigation plus relevant expansion, never unconditional reuse
 * or a blind full rerun.
 *
 * Reuses T1's frozen `EvidenceApplicabilityDecision` for reusable/invalidated
 * outcomes; `unknown` is a T5-level pending state with an investigation plan.
 */
import {
  validateEvidenceApplicabilityDecision,
  type EvidenceApplicabilityDecision,
  type EvidenceApplicabilityImpact,
} from "./planning-contracts.js";
import type { EvidenceRecord } from "./evidence-store.js";

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export type ApplicabilityOutcome = "reusable" | "invalidated" | "unknown";

export interface ApplicabilityProof {
  readonly outcome: ApplicabilityOutcome;
  /** Mechanical per-dimension comparison (inspected + old/new identities). */
  readonly impact: EvidenceApplicabilityImpact;
  readonly rationale: string;
  /** Bounded investigation steps when outcome is unknown. */
  readonly investigation?: readonly string[];
  /** Relevant expansion (extra checks to run) when outcome is unknown. */
  readonly expandedChecks?: readonly string[];
  /** Downstream required checks invalidated with this decision. */
  readonly invalidatedDownstreamCheckIds?: readonly string[];
}

/** Source-content / dirty-tree identity of the check's input closure. */
export interface CodeImpactObservation {
  readonly inspected: boolean;
  /** Required when inspected is true. */
  readonly oldIdentity?: string;
  readonly newIdentity?: string;
}

export interface ApplicabilityInput {
  readonly observationId: string;
  readonly oldSnapshotRevision: string;
  readonly newSnapshotRevision: string;
  readonly inspectedImpact: EvidenceApplicabilityImpact;
  readonly rationale: string;
  /** Dependency edges from this check to downstream required checks. */
  readonly downstreamCheckIds?: readonly string[];
  /**
   * Checks whose behavior changed (by id); affected checks invalidate.
   * Omitted (behavior impact never inspected), or explicitly marked
   * uninspected via behaviorImpactInspected: false, is missing impact info:
   * unknown, never reusable.
   */
  readonly changedCheckIds?: readonly string[];
  /** False when the behavior/code impact was never inspected. */
  readonly behaviorImpactInspected?: boolean;
  /**
   * Source-content / uncommitted-digest identity of the check's input
   * closure. Missing or uninspected is missing impact info: unknown.
   */
  readonly codeImpact?: CodeImpactObservation;
  readonly checkId: string;
}

function dimensionImpacted(
  dimension: { readonly inspected: boolean; readonly oldIdentity?: string; readonly newIdentity?: string },
): boolean | "missing_info" {
  if (!dimension.inspected) return "missing_info";
  if (!nonEmpty(dimension.oldIdentity) || !nonEmpty(dimension.newIdentity)) return "missing_info";
  return dimension.oldIdentity !== dimension.newIdentity;
}

/**
 * Decide applicability mechanically. All four dimensions inspected with
 * matching identities and no behavior change => reusable with proof. Any
 * inspected mismatch or behavior change affecting this check => invalidated
 * (plus downstream). Any missing impact info => unknown with a bounded
 * investigation and relevant expansion — never unconditional reuse, never a
 * blind full rerun.
 */
export function decideApplicability(input: ApplicabilityInput): ApplicabilityProof {
  if (typeof input !== "object" || input === null) {
    throw new Error("Applicability input must be an object.");
  }
  if (!nonEmpty(input.observationId) || !nonEmpty(input.oldSnapshotRevision) ||
      !nonEmpty(input.newSnapshotRevision) || !nonEmpty(input.rationale) || !nonEmpty(input.checkId)) {
    throw new Error("Applicability input requires observationId, snapshots, rationale, and checkId.");
  }
  const impact = input.inspectedImpact;
  if (typeof impact !== "object" || impact === null) {
    throw new Error("Applicability input requires inspectedImpact.");
  }
  const dimensions = ["dependency", "contract", "config", "environment"] as const;
  let missingInfo = false;
  let impacted = false;
  for (const dimension of dimensions) {
    const observation = (impact as unknown as Record<string, unknown>)[dimension] as
      | { inspected: boolean; oldIdentity?: string; newIdentity?: string }
      | undefined;
    if (!observation || typeof observation.inspected !== "boolean") {
      throw new Error(`inspectedImpact.${dimension} requires an inspected boolean.`);
    }
    const result = dimensionImpacted(observation);
    if (result === "missing_info") missingInfo = true;
    if (result === true) impacted = true;
  }
  const behaviorList = input.changedCheckIds;
  const behaviorMissing = behaviorList === undefined || input.behaviorImpactInspected === false;
  const behaviorChanged = (behaviorList ?? []).includes(input.checkId);
  const code = input.codeImpact;
  const codeMissing = !code || !code.inspected || !nonEmpty(code.oldIdentity) || !nonEmpty(code.newIdentity);
  const codeChanged = !codeMissing && code.oldIdentity !== code.newIdentity;

  if (impacted || behaviorChanged || codeChanged) {
    const downstream = [...(input.downstreamCheckIds ?? [])].sort();
    return {
      outcome: "invalidated",
      impact,
      rationale: behaviorChanged
        ? `Check ${input.checkId} behavior changed; affected and ${downstream.length} downstream required check(s) invalidated. ${input.rationale}`
        : codeChanged
          ? `Check ${input.checkId} source content changed; affected and ${downstream.length} downstream required check(s) invalidated. ${input.rationale}`
          : `Impact detected; check ${input.checkId} and ${downstream.length} downstream required check(s) invalidated. ${input.rationale}`,
      invalidatedDownstreamCheckIds: downstream,
    };
  }
  if (missingInfo || behaviorMissing || codeMissing) {
    const uninspected: string[] = dimensions.filter((d) => {
      const observation = (impact as unknown as Record<string, { inspected: boolean; oldIdentity?: string; newIdentity?: string }>)[d];
      return dimensionImpacted(observation) === "missing_info";
    });
    if (behaviorMissing) uninspected.push("behavior");
    if (codeMissing) uninspected.push("code");
    const investigation = uninspected.map((d) => `Inspect ${d} identities for check ${input.checkId} (old vs new).`);
    return {
      outcome: "unknown",
      impact,
      rationale: `Missing impact info for ${uninspected.join(",")}; bounded investigation required, not unconditional reuse. ${input.rationale}`,
      investigation,
      expandedChecks: [input.checkId, ...(input.downstreamCheckIds ?? [])].sort(),
    };
  }
  return {
    outcome: "reusable",
    impact,
    rationale: `All dimensions inspected with matching identities across ${input.oldSnapshotRevision}..${input.newSnapshotRevision}; unrelated commit does not invalidate. ${input.rationale}`,
  };
}

/**
 * Convert a reusable/invalidated proof into T1's frozen decision record.
 * Unknown proofs cannot convert (they are pending investigation, not a
 * decision) — callers must resolve the investigation first.
 */
export function toFrozenDecision(
  id: string,
  input: ApplicabilityInput,
  proof: ApplicabilityProof,
): EvidenceApplicabilityDecision {
  if (proof.outcome === "unknown") {
    throw new Error("An unknown applicability proof is pending investigation; it cannot be recorded as a reusable/invalidated decision.");
  }
  const decision: EvidenceApplicabilityDecision = {
    id,
    observationId: input.observationId,
    oldSnapshotRevision: input.oldSnapshotRevision,
    newSnapshotRevision: input.newSnapshotRevision,
    inspectedImpact: proof.impact,
    outcome: proof.outcome,
    rationale: proof.rationale,
  };
  const validation = validateEvidenceApplicabilityDecision(decision);
  if (!validation.valid) {
    throw new Error(`Applicability decision ${id} is invalid: ${validation.issues.map((i) => i.message).join(" ")}`);
  }
  return decision;
}

/**
 * Propagate invalidation downstream: every invalidated check invalidates its
 * downstream required checks. Returns the full invalidated set (sorted).
 * Independent checks with no path from an invalidated check stay valid.
 */
export function propagateInvalidation(
  invalidatedCheckIds: readonly string[],
  edges: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  const invalidated = new Set(invalidatedCheckIds);
  const queue = [...invalidatedCheckIds];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    for (const downstream of edges.get(current) ?? []) {
      if (!invalidated.has(downstream)) {
        invalidated.add(downstream);
        queue.push(downstream);
      }
    }
  }
  return [...invalidated].sort();
}

// ---------------------------------------------------------------------------
// OA-2 (EP35): mechanical unverified_claim decision
// ---------------------------------------------------------------------------

export interface ClaimCitation {
  readonly evidenceId: string;
  /** Executable only (no joined argument string: argv compares structurally). */
  readonly command: string;
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly snapshotRevision: string;
  readonly artifactHashes: readonly string[];
}

export type UnverifiedClaimVerdict =
  | { readonly status: "verified"; readonly reason: string }
  | { readonly status: "unverified_claim"; readonly reason: string }
  | { readonly status: "reviewer_judgement"; readonly reason: string };

/**
 * Decide `unverified_claim` mechanically where possible: the cited evidence
 * record exists and its command, exit, revision, and artifacts match the
 * claim. Any mismatch is `unverified_claim`. When the claim asserts semantic
 * content beyond these mechanical fields (caller passes
 * `hasSemanticResidue: true`), the residue is labelled reviewer judgement.
 */
export function decideUnverifiedClaim(input: {
  readonly claim: ClaimCitation;
  readonly recordsById: ReadonlyMap<string, EvidenceRecord>;
  readonly hasSemanticResidue: boolean;
  readonly semanticNote?: string;
}): UnverifiedClaimVerdict {
  const record = input.recordsById.get(input.claim.evidenceId);
  if (!record) {
    return { status: "unverified_claim", reason: `Cited evidence ${input.claim.evidenceId} does not exist.` };
  }
  if (record.fact.kind !== "command") {
    if (input.hasSemanticResidue) {
      return {
        status: "reviewer_judgement",
        reason: `Cited evidence ${record.id} is ${record.fact.kind}, not a command record; mechanical command/exit/revision/artifact comparison does not apply. Residue: ${input.semanticNote ?? "reviewer judgement required"}.`,
      };
    }
    return { status: "unverified_claim", reason: `Cited evidence ${record.id} is ${record.fact.kind}; claim asserts a command record.` };
  }
  const mismatches: string[] = [];
  if (!nonEmpty(input.claim.snapshotRevision)) {
    mismatches.push("claim cites an empty revision (no revision to verify)");
  }
  if (input.claim.artifactHashes.length === 0) {
    mismatches.push("claim cites no artifacts (nothing inspectable to verify)");
  }
  if (record.fact.command !== input.claim.command) {
    mismatches.push(`command mismatch (record "${record.fact.command}", claim "${input.claim.command}")`);
  }
  const actualArgs = [...record.fact.args];
  const claimedArgs = [...input.claim.args];
  if (actualArgs.length !== claimedArgs.length || actualArgs.some((a, i) => a !== claimedArgs[i])) {
    mismatches.push(`args mismatch (record [${actualArgs.join(", ")}], claim [${claimedArgs.join(", ")}])`);
  }
  if (record.fact.exitCode !== input.claim.exitCode) {
    mismatches.push(`exit mismatch (record ${String(record.fact.exitCode)}, claim ${String(input.claim.exitCode)})`);
  }
  if ((record.fact.repositoryRevision ?? "") !== input.claim.snapshotRevision) {
    mismatches.push(`revision mismatch (record "${record.fact.repositoryRevision ?? ""}", claim "${input.claim.snapshotRevision}")`);
  }
  const actualArtifacts = new Set([record.fact.stdoutArtifactHash, record.fact.stderrArtifactHash]);
  for (const hash of input.claim.artifactHashes) {
    if (!actualArtifacts.has(hash)) mismatches.push(`artifact ${hash} not recorded by evidence ${record.id}`);
  }
  if (mismatches.length > 0) {
    return { status: "unverified_claim", reason: mismatches.join("; ") };
  }
  if (input.hasSemanticResidue) {
    return {
      status: "reviewer_judgement",
      reason: `Mechanical fields match for ${record.id}; residue labelled reviewer judgement: ${input.semanticNote ?? "semantic scope beyond command/exit/revision/artifacts"}.`,
    };
  }
  return { status: "verified", reason: `Cited evidence ${record.id} exists and command/exit/revision/artifacts match.` };
}
