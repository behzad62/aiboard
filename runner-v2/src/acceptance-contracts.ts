import {
  evidenceFactArtifactHashes,
  type EvidenceRecord,
} from "./evidence-store.js";

export interface AcceptanceCriterion {
  /** Stable task-local identity. It must not be reused for a different meaning. */
  id: string;
  /** Human-readable requirement text; the kernel never interprets its meaning. */
  text: string;
}

export interface CriterionEvidenceLink {
  criterionId: string;
  evidenceId: string;
  artifactHashes: string[];
  /** Filled by the scheduler when a submission is bound to a task attempt. */
  taskId?: string;
  attempt?: number;
}

export type CriterionReviewVerdictValue = "satisfied" | "unsatisfied";

export interface AcceptedEvidenceFailure {
  evidenceId: string;
  rationale: string;
}

export interface CriterionReviewVerdict {
  criterionId: string;
  verdict: CriterionReviewVerdictValue;
  rationale: string;
  evidenceIds: string[];
  artifactHashes?: string[];
  /** Explicit, audited acceptance of cited command evidence that did not succeed. */
  acceptedFailures?: AcceptedEvidenceFailure[];
}

export interface GreenEvidenceVerdict {
  verdict: string;
  evidenceIds: readonly string[];
  acceptedFailures?: readonly AcceptedEvidenceFailure[];
}

export function failingCommandEvidenceIds(
  records: readonly EvidenceRecord[],
): string[] {
  return records
    .filter((record) =>
      record.fact.kind === "command" &&
      (
        record.fact.exitCode !== 0 ||
        record.fact.signal !== null ||
        record.fact.timedOut ||
        record.fact.cancelled
      ),
    )
    .map((record) => record.id);
}

export function assertSatisfiedVerdictsCiteGreenEvidence(
  verdicts: readonly GreenEvidenceVerdict[],
  records: readonly EvidenceRecord[],
  label: string,
): void {
  const failing = new Set(failingCommandEvidenceIds(records));
  for (const verdict of verdicts) {
    const accepted = new Map(
      (verdict.acceptedFailures ?? []).map((failure) => [failure.evidenceId, failure]),
    );
    for (const failure of accepted.values()) {
      if (!failure.rationale.trim()) {
        throw new Error(`${label} accepted failure ${failure.evidenceId} requires a rationale.`);
      }
      if (!failing.has(failure.evidenceId) || !verdict.evidenceIds.includes(failure.evidenceId)) {
        throw new Error(
          `${label} accepted failure ${failure.evidenceId} is not failing command evidence cited by that verdict.`,
        );
      }
    }
    if (verdict.verdict !== "satisfied") continue;
    for (const evidenceId of verdict.evidenceIds) {
      if (failing.has(evidenceId) && !accepted.has(evidenceId)) {
        throw new Error(
          `${label} cites failing command evidence ${evidenceId} for a satisfied verdict without an accepted failure.`,
        );
      }
    }
  }
}

export interface AcceptanceContractValidation {
  valid: boolean;
  issues: string[];
  missingCriterionIds: string[];
  unknownCriterionIds: string[];
  duplicateCriterionIds: string[];
  unsatisfiedCriterionIds: string[];
}

export interface CriterionEvidenceValidationOptions {
  evidenceRecords?: readonly EvidenceRecord[];
  runId?: string;
  taskId?: string;
  attempt?: number;
  actorId?: string;
  actorRole?: EvidenceRecord["actor"]["role"];
  /** The accountable worker; subagent IDs must be a colon-delimited descendant. */
  assignedWorkerId?: string;
}

export type CriterionReviewValidationOptions = CriterionEvidenceValidationOptions;

const HASH_PATTERN = /^[a-f0-9]{64}$/;

export function assertAcceptanceCriteria(
  criteria: readonly AcceptanceCriterion[]
): void {
  const validation = validateAcceptanceCriteria(criteria);
  if (!validation.valid) {
    throw new Error(validation.issues.join(" "));
  }
}

export function validateAcceptanceCriteria(
  criteria: readonly AcceptanceCriterion[]
): AcceptanceContractValidation {
  const issues: string[] = [];
  const duplicateCriterionIds: string[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(criteria) || criteria.length === 0) {
    issues.push("At least one acceptance criterion is required.");
  }
  for (const [index, criterion] of (criteria ?? []).entries()) {
    if (!isRecord(criterion)) {
      issues.push(`Acceptance criterion ${index} must be an object.`);
      continue;
    }
    const id = criterion.id;
    const text = criterion.text;
    if (!nonEmpty(id)) {
      issues.push(`Acceptance criterion ${index} requires a non-empty id.`);
      continue;
    }
    if (!nonEmpty(text)) {
      issues.push(`Acceptance criterion ${id} requires non-empty text.`);
    }
    if (id !== id.trim()) {
      issues.push(`Acceptance criterion ${id} must use a trimmed stable id.`);
    }
    if (seen.has(id)) {
      duplicateCriterionIds.push(id);
      issues.push(`Duplicate acceptance criterion ${id}.`);
    }
    seen.add(id);
  }
  return result({
    issues,
    duplicateCriterionIds: unique(duplicateCriterionIds),
  });
}

export function criterionIds(
  criteria: readonly AcceptanceCriterion[]
): string[] {
  return criteria.map((criterion) => criterion.id);
}

export function validateCriterionEvidenceLinks(
  criteria: readonly AcceptanceCriterion[],
  links: readonly CriterionEvidenceLink[],
  options: CriterionEvidenceValidationOptions = {}
): AcceptanceContractValidation {
  const base = validateAcceptanceCriteria(criteria);
  const issues = [...base.issues];
  const duplicateCriterionIds: string[] = [...base.duplicateCriterionIds];
  const unknownCriterionIds: string[] = [];
  const missingCriterionIds: string[] = [];
  const expectedIds = new Set(criterionIds(criteria));
  const byCriterion = new Map<string, CriterionEvidenceLink>();
  if (!Array.isArray(links)) {
    issues.push("Criterion evidence links are required.");
  }
  for (const [index, candidate] of (links ?? []).entries()) {
    if (!isRecord(candidate)) {
      issues.push(`Criterion evidence link ${index} must be an object.`);
      continue;
    }
    const criterionId = candidate.criterionId;
    const evidenceId = candidate.evidenceId;
    const artifactHashes = candidate.artifactHashes;
    if (!nonEmpty(criterionId)) {
      issues.push(`Criterion evidence link ${index} requires criterionId.`);
      continue;
    }
    if (!expectedIds.has(criterionId)) {
      unknownCriterionIds.push(criterionId);
      issues.push(`Unknown criterion ${criterionId} in evidence mapping.`);
    }
    if (byCriterion.has(criterionId)) {
      duplicateCriterionIds.push(criterionId);
      issues.push(`Duplicate evidence mapping for criterion ${criterionId}.`);
    }
    if (!nonEmpty(evidenceId)) {
      issues.push(`Evidence mapping for criterion ${criterionId} requires evidenceId.`);
    }
    if (!Array.isArray(artifactHashes) || artifactHashes.length === 0) {
      issues.push(`Evidence mapping for criterion ${criterionId} requires artifact hashes.`);
    } else {
      for (const hash of artifactHashes) {
        if (typeof hash !== "string" || !HASH_PATTERN.test(hash)) {
          issues.push(`Evidence mapping for criterion ${criterionId} contains an invalid artifact hash.`);
        }
      }
    }
    if (candidate.taskId !== undefined && !nonEmpty(candidate.taskId)) {
      issues.push(`Evidence mapping for criterion ${criterionId} has an invalid taskId.`);
    }
    if (
      candidate.attempt !== undefined &&
      (!Number.isSafeInteger(candidate.attempt) || candidate.attempt < 1)
    ) {
      issues.push(`Evidence mapping for criterion ${criterionId} has an invalid attempt.`);
    }
    if (nonEmpty(evidenceId) && Array.isArray(artifactHashes)) {
      byCriterion.set(criterionId, candidate as unknown as CriterionEvidenceLink);
    }
  }
  for (const id of expectedIds) {
    if (!byCriterion.has(id)) {
      missingCriterionIds.push(id);
      issues.push(`Missing evidence mapping for criterion ${id}.`);
    }
  }

  const recordsById = new Map(
    (options.evidenceRecords ?? []).map((record) => [record.id, record])
  );
  if (options.evidenceRecords) {
    for (const [criterionId, link] of byCriterion) {
      const record = recordsById.get(link.evidenceId);
      if (!record) {
        issues.push(
          `Evidence record ${link.evidenceId} for criterion ${criterionId} is missing.`
        );
        continue;
      }
      if (options.runId !== undefined && record.runId !== options.runId) {
        issues.push(
          `Evidence record ${link.evidenceId} for criterion ${criterionId} belongs to another run.`
        );
      }
      if (options.taskId !== undefined && record.taskId !== options.taskId) {
        issues.push(
          `Evidence record ${link.evidenceId} for criterion ${criterionId} belongs to another task.`
        );
      }
      if (link.taskId !== undefined && link.taskId !== record.taskId) {
        issues.push(
          `Evidence record ${link.evidenceId} for criterion ${criterionId} does not match the mapping task.`
        );
      }
      if (options.taskId !== undefined && link.taskId !== options.taskId) {
        issues.push(
          `Evidence mapping for criterion ${criterionId} is not bound to task ${options.taskId}.`
        );
      }
      if (options.actorId !== undefined && record.actor.id !== options.actorId) {
        issues.push(
          `Evidence record ${link.evidenceId} for criterion ${criterionId} belongs to another actor.`
        );
      }
      if (options.actorRole !== undefined && record.actor.role !== options.actorRole) {
        issues.push(
          `Evidence record ${link.evidenceId} for criterion ${criterionId} has an invalid actor role.`
        );
      }
      if (
        options.assignedWorkerId !== undefined &&
        !isAssignedWorkerEvidence(record, options.assignedWorkerId)
      ) {
        issues.push(
          `Evidence record ${link.evidenceId} for criterion ${criterionId} belongs outside the assigned worker ${options.assignedWorkerId}.`
        );
      }
      const recordAttempt = (record as EvidenceRecord & { attempt?: number }).attempt;
      if (options.attempt !== undefined && recordAttempt !== options.attempt) {
        issues.push(
          `Evidence record ${link.evidenceId} for criterion ${criterionId} is stale for attempt ${options.attempt}.`
        );
      }
      if (link.attempt !== undefined && recordAttempt !== link.attempt) {
        issues.push(
          `Evidence record ${link.evidenceId} for criterion ${criterionId} does not match the mapping attempt.`
        );
      }
      if (options.attempt !== undefined && link.attempt !== options.attempt) {
        issues.push(
          `Evidence mapping for criterion ${criterionId} is not bound to attempt ${options.attempt}.`
        );
      }
      const availableArtifacts = new Set(evidenceFactArtifactHashes(record.fact));
      for (const hash of link.artifactHashes) {
        if (!availableArtifacts.has(hash)) {
          issues.push(
            `Artifact ${hash} for criterion ${criterionId} is not recorded by evidence ${link.evidenceId}.`
          );
        }
      }
    }
  }
  return result({
    issues,
    missingCriterionIds,
    unknownCriterionIds: unique(unknownCriterionIds),
    duplicateCriterionIds: unique(duplicateCriterionIds),
  });
}

function isAssignedWorkerEvidence(
  record: EvidenceRecord,
  assignedWorkerId: string
): boolean {
  if (record.actor.role === "worker") return record.actor.id === assignedWorkerId;
  return (
    record.actor.role === "subagent" &&
    record.actor.id.startsWith(`${assignedWorkerId}:`)
  );
}

export function assertCriterionEvidenceCoverage(
  criteria: readonly AcceptanceCriterion[],
  links: readonly CriterionEvidenceLink[],
  options: CriterionEvidenceValidationOptions = {}
): void {
  const validation = validateCriterionEvidenceLinks(criteria, links, options);
  if (!validation.valid) throw new Error(validation.issues.join(" "));
}

export function validateCriterionReviewVerdicts(
  criteria: readonly AcceptanceCriterion[],
  verdicts: readonly CriterionReviewVerdict[],
  links?: readonly CriterionEvidenceLink[],
  options: CriterionReviewValidationOptions = {}
): AcceptanceContractValidation {
  const base = validateAcceptanceCriteria(criteria);
  const issues = [...base.issues];
  const duplicateCriterionIds: string[] = [...base.duplicateCriterionIds];
  const unknownCriterionIds: string[] = [];
  const missingCriterionIds: string[] = [];
  const unsatisfiedCriterionIds: string[] = [];
  const expectedIds = new Set(criterionIds(criteria));
  const linksByCriterion = new Map(
    (links ?? []).map((link) => [link.criterionId, link])
  );
  const verdictByCriterion = new Map<string, CriterionReviewVerdict>();
  if (!Array.isArray(verdicts)) issues.push("Criterion review verdicts are required.");
  for (const [index, candidate] of (verdicts ?? []).entries()) {
    if (!isRecord(candidate)) {
      issues.push(`Criterion review verdict ${index} must be an object.`);
      continue;
    }
    const criterionId = candidate.criterionId;
    if (!nonEmpty(criterionId)) {
      issues.push(`Criterion review verdict ${index} requires criterionId.`);
      continue;
    }
    if (!expectedIds.has(criterionId)) {
      unknownCriterionIds.push(criterionId);
      issues.push(`Unknown criterion ${criterionId} in review verdict.`);
    }
    if (verdictByCriterion.has(criterionId)) {
      duplicateCriterionIds.push(criterionId);
      issues.push(`Duplicate review verdict for criterion ${criterionId}.`);
    }
    if (candidate.verdict !== "satisfied" && candidate.verdict !== "unsatisfied") {
      issues.push(`Review verdict for criterion ${criterionId} is invalid.`);
    } else if (candidate.verdict === "unsatisfied") {
      unsatisfiedCriterionIds.push(criterionId);
    }
    if (!nonEmpty(candidate.rationale)) {
      issues.push(`Review verdict for criterion ${criterionId} requires rationale.`);
    }
    if (!Array.isArray(candidate.evidenceIds) || candidate.evidenceIds.length === 0) {
      issues.push(`Review verdict for criterion ${criterionId} requires evidence.`);
    } else if (candidate.evidenceIds.some((id) => !nonEmpty(id))) {
      issues.push(`Review verdict for criterion ${criterionId} has invalid evidence IDs.`);
    }
    if (candidate.artifactHashes !== undefined) {
      if (!Array.isArray(candidate.artifactHashes) || candidate.artifactHashes.length === 0) {
        issues.push(`Review verdict for criterion ${criterionId} has invalid artifact hashes.`);
      } else if (candidate.artifactHashes.some((hash) => typeof hash !== "string" || !HASH_PATTERN.test(hash))) {
        issues.push(`Review verdict for criterion ${criterionId} has invalid artifact hashes.`);
      }
    }
    if (candidate.acceptedFailures !== undefined && !isAcceptedFailures(candidate.acceptedFailures)) {
      issues.push(`criterion ${criterionId} acceptedFailures is malformed`);
    }
    verdictByCriterion.set(criterionId, candidate as unknown as CriterionReviewVerdict);
  }
  for (const id of expectedIds) {
    if (!verdictByCriterion.has(id)) {
      missingCriterionIds.push(id);
      issues.push(`Missing review verdict for criterion ${id}.`);
    }
  }
  if (links) {
    for (const [criterionId, verdict] of verdictByCriterion) {
      const link = linksByCriterion.get(criterionId);
      if (!link) {
        issues.push(`Review verdict for criterion ${criterionId} has no evidence mapping.`);
        continue;
      }
      const linkEvidence = new Set([link.evidenceId]);
      for (const evidenceId of verdict.evidenceIds) {
        if (!linkEvidence.has(evidenceId)) {
          issues.push(
            `Review verdict for criterion ${criterionId} cites evidence outside its submitted mapping.`
          );
        }
      }
      if (verdict.artifactHashes) {
        const linkArtifacts = new Set(link.artifactHashes);
        for (const hash of verdict.artifactHashes) {
          if (!linkArtifacts.has(hash)) {
            issues.push(
              `Review verdict for criterion ${criterionId} cites an artifact outside its submitted mapping.`
            );
          }
        }
      }
    }
  }
  if (options.evidenceRecords && links) {
    const evidenceValidation = validateCriterionEvidenceLinks(criteria, links, options);
    issues.push(...evidenceValidation.issues);
  }
  return result({
    issues,
    missingCriterionIds,
    unknownCriterionIds: unique(unknownCriterionIds),
    duplicateCriterionIds: unique(duplicateCriterionIds),
    unsatisfiedCriterionIds: unique(unsatisfiedCriterionIds),
  });
}

export function assertCriterionReviewCoverage(
  criteria: readonly AcceptanceCriterion[],
  verdicts: readonly CriterionReviewVerdict[],
  links?: readonly CriterionEvidenceLink[],
  options: CriterionReviewValidationOptions = {}
): void {
  const validation = validateCriterionReviewVerdicts(criteria, verdicts, links, options);
  if (!validation.valid) throw new Error(validation.issues.join(" "));
}

function result(input: {
  issues: string[];
  missingCriterionIds?: string[];
  unknownCriterionIds?: string[];
  duplicateCriterionIds?: string[];
  unsatisfiedCriterionIds?: string[];
}): AcceptanceContractValidation {
  const missingCriterionIds = unique(input.missingCriterionIds ?? []);
  const unknownCriterionIds = unique(input.unknownCriterionIds ?? []);
  const duplicateCriterionIds = unique(input.duplicateCriterionIds ?? []);
  const unsatisfiedCriterionIds = unique(input.unsatisfiedCriterionIds ?? []);
  return {
    valid: input.issues.length === 0,
    issues: [...input.issues],
    missingCriterionIds,
    unknownCriterionIds,
    duplicateCriterionIds,
    unsatisfiedCriterionIds,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isAcceptedFailures(value: unknown): value is AcceptedEvidenceFailure[] {
  if (!Array.isArray(value)) return false;
  const evidenceIds: string[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || !nonEmpty(candidate.evidenceId) || !nonEmpty(candidate.rationale)) {
      return false;
    }
    evidenceIds.push(candidate.evidenceId);
  }
  return new Set(evidenceIds).size === evidenceIds.length;
}
