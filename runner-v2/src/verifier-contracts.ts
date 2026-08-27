import type { BuildTask } from "./task-contracts.js";
import { isFinalVerificationTask } from "./task-contracts.js";

export interface VerifierCriterionReference {
  taskId: string;
  criterionId: string;
}

export interface VerifierRuntimeBinding {
  runtimeId: string;
  providerId: string;
  modelId: string;
  modelIdentity: string;
  sessionId: string;
}

export interface VerifierExcludedModel {
  source: "architect" | "accepted_change_author";
  runtimeId: string;
  modelIdentity: string;
}

export interface VerifierCriterionVerdict extends VerifierCriterionReference {
  verdict: "satisfied" | "unsatisfied";
  rationale: string;
  evidenceIds: string[];
}

export interface VerifierVerdictProjection {
  reviewId: string;
  targetRevision: string;
  sessionId: string;
  satisfied: boolean;
  criterionVerdicts: VerifierCriterionVerdict[];
  submittedAt: string;
}

export interface VerifierReviewProjection {
  reviewId: string;
  targetRevision: string;
  finalVerificationGenerationId: string;
  runtime: VerifierRuntimeBinding;
  excludedModels: VerifierExcludedModel[];
  criteria: VerifierCriterionReference[];
  status: "requested" | "submitted";
  state: "current" | "invalidated" | "superseded";
  requestedAt: string;
  invalidatedByRevision?: string;
  invalidatedByGuidanceId?: string;
  supersededByReviewId?: string;
  verdict?: VerifierVerdictProjection;
}

export interface VerifierProjection {
  current?: VerifierReviewProjection;
  history: VerifierReviewProjection[];
}

export function canonicalModelIdentity(modelId: string): string {
  const qualifiedModelId = modelId.trim().toLowerCase().replaceAll("\\", "/");
  return qualifiedModelId.split("/").filter(Boolean).at(-1) ?? qualifiedModelId;
}

export function expectedVerifierCriteria(
  tasks: Readonly<Record<string, BuildTask>>,
): VerifierCriterionReference[] {
  return Object.values(tasks)
    .filter((task) => task.status !== "cancelled" && !isFinalVerificationTask(task))
    .flatMap((task) => (task.acceptanceCriteria ?? []).map((criterion) => ({
      taskId: task.id,
      criterionId: criterion.id,
    })))
    .sort(compareCriterionReferences);
}

export function parseVerifierReviewRequest(
  payload: Record<string, unknown>,
  expectedCriteria: readonly VerifierCriterionReference[],
  requestedAt: string,
): VerifierReviewProjection {
  const reviewId = requiredString(payload, "reviewId");
  const targetRevision = requiredString(payload, "targetRevision");
  const finalVerificationGenerationId = requiredString(
    payload,
    "finalVerificationGenerationId",
  );
  const runtime = parseRuntimeBinding(payload.runtime);
  const excludedModels = parseExcludedModels(payload.excludedModels);
  const criteria = parseCriterionReferences(payload.criteria, "Verifier request");
  assertExactVerifierCriteria(criteria, expectedCriteria, "Verifier request");
  const excludedIdentities = new Set(
    excludedModels.map((excluded) => excluded.modelIdentity),
  );
  if (excludedIdentities.has(runtime.modelIdentity)) {
    throw new Error(
      "Verifier model is not independent from the Architect or an accepted change author.",
    );
  }
  return {
    reviewId,
    targetRevision,
    finalVerificationGenerationId,
    runtime,
    excludedModels,
    criteria: expectedCriteria.map((criterion) => ({ ...criterion })),
    status: "requested",
    state: "current",
    requestedAt,
  };
}

export function parseVerifierVerdict(
  payload: Record<string, unknown>,
  review: VerifierReviewProjection,
  submittedAt: string,
): VerifierVerdictProjection {
  const reviewId = requiredString(payload, "reviewId");
  const targetRevision = requiredString(payload, "targetRevision");
  const sessionId = requiredString(payload, "sessionId");
  if (
    reviewId !== review.reviewId ||
    targetRevision !== review.targetRevision ||
    sessionId !== review.runtime.sessionId
  ) {
    throw new Error("Verifier verdict is stale or foreign to the current review session.");
  }
  const criterionVerdicts = parseVerifierCriterionVerdicts(
    payload.criterionVerdicts,
  );
  assertExactVerifierCriteria(
    criterionVerdicts,
    review.criteria,
    "Verifier verdict",
  );
  const byCriterion = new Map(
    criterionVerdicts.map((verdict) => [criterionKey(verdict), verdict]),
  );
  const ordered = review.criteria.map((criterion) => {
    const verdict = byCriterion.get(criterionKey(criterion));
    if (!verdict) {
      throw new Error(
        `Verifier verdict omits criterion ${criterion.taskId}:${criterion.criterionId}.`,
      );
    }
    return cloneCriterionVerdict(verdict);
  });
  return {
    reviewId,
    targetRevision,
    sessionId,
    satisfied: ordered.every((verdict) => verdict.verdict === "satisfied"),
    criterionVerdicts: ordered,
    submittedAt,
  };
}

export function parseVerifierCriterionVerdicts(
  value: unknown,
): VerifierCriterionVerdict[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Verifier verdict requires criterion verdicts.");
  }
  return value.map((candidate, index) =>
    parseCriterionVerdict(candidate, index),
  );
}

export function cloneVerifierProjection(
  projection: VerifierProjection,
): VerifierProjection {
  return {
    ...(projection.current
      ? { current: cloneVerifierReview(projection.current) }
      : {}),
    history: projection.history.map(cloneVerifierReview),
  };
}

export function cloneVerifierReview(
  review: VerifierReviewProjection,
): VerifierReviewProjection {
  return {
    ...review,
    runtime: { ...review.runtime },
    excludedModels: review.excludedModels.map((excluded) => ({ ...excluded })),
    criteria: review.criteria.map((criterion) => ({ ...criterion })),
    ...(review.verdict
      ? {
          verdict: {
            ...review.verdict,
            criterionVerdicts: review.verdict.criterionVerdicts.map(
              cloneCriterionVerdict,
            ),
          },
        }
      : {}),
  };
}

export function sameVerifierReview(
  left: VerifierReviewProjection,
  right: VerifierReviewProjection,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function parseRuntimeBinding(value: unknown): VerifierRuntimeBinding {
  const runtime = requiredRecord(value, "Verifier runtime binding");
  const binding = {
    runtimeId: requiredString(runtime, "runtimeId"),
    providerId: requiredString(runtime, "providerId"),
    modelId: requiredString(runtime, "modelId"),
    modelIdentity: requiredString(runtime, "modelIdentity"),
    sessionId: requiredString(runtime, "sessionId"),
  };
  const canonical = canonicalModelIdentity(binding.modelId);
  if (!canonical || binding.modelIdentity !== canonical) {
    throw new Error("Verifier model identity conflicts with its configured model ID.");
  }
  return binding;
}

function parseExcludedModels(value: unknown): VerifierExcludedModel[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Verifier request requires excluded model identities.");
  }
  const excluded = value.map((candidate, index) => {
    const record = requiredRecord(candidate, `Excluded verifier model ${index}`);
    const source = requiredString(record, "source");
    if (source !== "architect" && source !== "accepted_change_author") {
      throw new Error(`Excluded verifier model ${index} has an invalid source.`);
    }
    const modelIdentity = requiredString(record, "modelIdentity");
    if (canonicalModelIdentity(modelIdentity) !== modelIdentity) {
      throw new Error(`Excluded verifier model ${index} identity is not canonical.`);
    }
    return {
      source,
      runtimeId: requiredString(record, "runtimeId"),
      modelIdentity,
    } as VerifierExcludedModel;
  });
  if (!excluded.some((candidate) => candidate.source === "architect")) {
    throw new Error("Verifier request must exclude the Architect model identity.");
  }
  const keys = excluded.map(
    (candidate) => `${candidate.source}\u0000${candidate.runtimeId}\u0000${candidate.modelIdentity}`,
  );
  if (new Set(keys).size !== keys.length) {
    throw new Error("Verifier request contains duplicate excluded model identities.");
  }
  return excluded.map((candidate) => ({ ...candidate }));
}

function parseCriterionReferences(
  value: unknown,
  label: string,
): VerifierCriterionReference[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} requires at least one criterion.`);
  }
  return value.map((candidate, index) => {
    const record = requiredRecord(candidate, `${label} criterion ${index}`);
    return {
      taskId: requiredString(record, "taskId"),
      criterionId: requiredString(record, "criterionId"),
    };
  });
}

function parseCriterionVerdict(
  value: unknown,
  index: number,
): VerifierCriterionVerdict {
  const record = requiredRecord(value, `Verifier criterion verdict ${index}`);
  const verdict = requiredString(record, "verdict");
  if (verdict !== "satisfied" && verdict !== "unsatisfied") {
    throw new Error(`Verifier criterion verdict ${index} has an invalid verdict.`);
  }
  const evidenceIds = requiredStringArray(record, "evidenceIds");
  if (evidenceIds.length === 0 || new Set(evidenceIds).size !== evidenceIds.length) {
    throw new Error(
      `Verifier criterion verdict ${index} requires unique durable evidence IDs.`,
    );
  }
  return {
    taskId: requiredString(record, "taskId"),
    criterionId: requiredString(record, "criterionId"),
    verdict,
    rationale: requiredString(record, "rationale").trim(),
    evidenceIds: [...evidenceIds],
  };
}

export function assertExactVerifierCriteria(
  actual: readonly VerifierCriterionReference[],
  expected: readonly VerifierCriterionReference[],
  label: string,
): void {
  if (expected.length === 0) {
    throw new Error(`${label} has no authoritative build criteria.`);
  }
  const actualKeys = actual.map(criterionKey);
  if (new Set(actualKeys).size !== actualKeys.length) {
    throw new Error(`${label} contains duplicate criteria.`);
  }
  const expectedKeys = expected.map(criterionKey).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.sort().some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error(`${label} must represent every build criterion exactly once.`);
  }
}

function cloneCriterionVerdict(
  verdict: VerifierCriterionVerdict,
): VerifierCriterionVerdict {
  return { ...verdict, evidenceIds: [...verdict.evidenceIds] };
}

function compareCriterionReferences(
  left: VerifierCriterionReference,
  right: VerifierCriterionReference,
): number {
  return left.taskId.localeCompare(right.taskId) ||
    left.criterionId.localeCompare(right.criterionId);
}

function criterionKey(criterion: VerifierCriterionReference): string {
  return `${criterion.taskId}\u0000${criterion.criterionId}`;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required.`);
  }
  return value;
}

function requiredStringArray(
  payload: Record<string, unknown>,
  key: string,
): string[] {
  const value = payload[key];
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !item.trim())
  ) {
    throw new Error(`${key} must contain non-empty strings.`);
  }
  return [...value] as string[];
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
