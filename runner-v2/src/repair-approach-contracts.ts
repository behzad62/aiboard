export interface RepairApproachDecision {
  readonly approachId: string;
  readonly repeat: boolean;
  readonly hypothesis: string;
  readonly diagnosticSet: readonly string[];
  readonly evidenceIds: readonly string[];
}

export interface RepairApproachHistoryEntry {
  readonly approachId: string;
  readonly failed: boolean;
  readonly hypothesis: string;
  readonly diagnosticSet: readonly string[];
  /** Evidence the approach was decided on (its immutable diagnostic evidence). */
  readonly evidenceIds: readonly string[];
  /** Evidence produced by this approach's failed correction attempts. */
  readonly failureEvidenceIds: readonly string[];
}

export interface RepairApproachValidationInput {
  readonly actorRole: "architect";
  readonly actorId: string;
  readonly decisionActorRole: "architect";
  readonly decisionActorId: string;
  readonly priorApproaches: readonly RepairApproachHistoryEntry[];
  readonly decision: RepairApproachDecision;
  /**
   * T6b repair (B4): immutable evidence ids known to the evidence store, or
   * undefined when the caller has no store to check against. Every cited id
   * must exist; the kernel always supplies the store, so production never
   * accepts a fabricated evidence id.
   */
  readonly knownEvidenceIds?: readonly string[];
}

/**
 * T6b repair (B4): the kernel validates actor, lineage, prior failure, and
 * immutable evidence references before every repair dispatch. A failed
 * approach id can never be relabelled or resubmitted without an explicit
 * repeat (a new id with a failed approach's hypothesis and diagnostic set
 * is a relabel); a repeat needs evidence NEW to the failed approach's whole
 * diagnostic set (its diagnosticSet, its decided evidence, and its failure
 * evidence) and must not cite the failure's own evidence; with prior
 * approaches a new decision needs NON-EMPTY evidence outside every prior
 * excluded set; fabricated evidence ids are refused against the store.
 * T6b repair (N-1/R2-B5): a new decision supersedes the pending latest
 * approach — a recorded approach that never resolved counts as failed for
 * these lineage checks. The reducer applies the same rule to its draft, so
 * the tool refusal and the kernel backstop agree.
 */
export function validateRepairApproachDecision(input: RepairApproachValidationInput): void {
  if (input.actorRole !== input.decisionActorRole || input.actorId !== input.decisionActorId) {
    throw new Error("Repair approach decisions require the current Architect actor.");
  }
  if (!input.decision.approachId.trim() || !input.decision.hypothesis.trim()) {
    throw new Error("Repair approach decision requires approachId and hypothesis.");
  }
  if (input.knownEvidenceIds !== undefined) {
    const known = new Set(input.knownEvidenceIds);
    const fabricated = input.decision.evidenceIds.find((id) => !known.has(id));
    if (fabricated !== undefined) {
      throw new Error(`Repair approach decision cites unknown evidence id ${fabricated}.`);
    }
  }
  const priors = input.priorApproaches.map((entry, index, all) =>
    index === all.length - 1 && !entry.failed ? { ...entry, failed: true } : entry);
  const diagnosticKnown = new Set(priors.flatMap((entry) => entry.diagnosticSet));
  const decidedKnown = new Set(priors.flatMap((entry) => entry.evidenceIds));
  const failureKnown = new Set(priors.flatMap((entry) => entry.failureEvidenceIds));
  const excluded = new Set([...diagnosticKnown, ...decidedKnown, ...failureKnown]);
  const prior = priors.find((entry) => entry.approachId === input.decision.approachId);
  if (!input.decision.repeat && prior?.failed) {
    throw new Error("A failed repair approach cannot be relabelled or resubmitted without an explicit repeat and evidence NEW to its diagnostic set.");
  }
  if (input.decision.repeat || prior?.failed) {
    const citesFailureEvidence = input.decision.evidenceIds.some((id) => failureKnown.has(id));
    if (citesFailureEvidence) {
      throw new Error("A repeated repair approach must not cite the failure's own evidence.");
    }
    const newEvidence = input.decision.evidenceIds.some((id) => !excluded.has(id));
    if (!newEvidence) {
      throw new Error("A repeated failed repair approach requires evidence NEW to its diagnostic set.");
    }
    return;
  }
  // T6b repair (R2-B3): with prior approaches, a decision that is neither
  // an explicit repeat nor a retry of its own failed id must cite
  // NON-EMPTY evidence with at least one id outside every prior
  // approach's excluded set; empty evidence never passes. A new id that
  // reuses a failed approach's hypothesis and diagnostic set is a
  // relabel, not a new approach.
  if (priors.length > 0) {
    if (!input.decision.evidenceIds.some((id) => !excluded.has(id))) {
      throw new Error("A renamed repair approach with identical evidence cannot pass as a new approach; empty evidence never passes.");
    }
    const relabel = priors.some((entry) =>
      entry.failed &&
      entry.hypothesis === input.decision.hypothesis &&
      sameStringSet(entry.diagnosticSet, input.decision.diagnosticSet));
    if (relabel) {
      throw new Error("A new repair approach id with a failed approach's hypothesis and diagnostic set is a relabel, not a new approach.");
    }
  }
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id) => right.includes(id));
}
