import { createHash } from "node:crypto";

import {
  validateApprovedSourceInput,
  type ApprovedSourceInputV1,
  type ValidatedApprovedSource,
} from "./native-planning-provisioner.js";
import {
  buildSourceManifest,
  computeArtifactDigest,
  type ApprovedSourceManifest,
  type SourceManifestAmendmentRecordedImpact,
} from "./source-manifest.js";
import {
  handoffSnapshotInputFromProjection,
  renderHandoffSnapshot,
  verifyHandoffSnapshotDigest,
} from "./handoff-snapshot.js";
import type { SchedulerProjection } from "./scheduler-store.js";

/**
 * T7b bounded planning-controls authority: authenticated source/amendment,
 * plan-readiness and explicit-start request validation, the amendment
 * manifest builder, and the read-only readiness/export documents.
 *
 * Nothing here appends events or dispatches workers. The kernel
 * (scheduler reducer, BuildRuntime, NativeBuildManager) owns every durable
 * effect; this module only validates shapes, derives deterministic
 * identities, and projects read-only views. Clocks stay server-side:
 * request bodies carry no timestamps, so an exact retry reproduces the
 * identical payload and dedupes harmlessly.
 */

export const T7B_EXPLICIT_START_AUTHORIZATION_VERSION = 1;
export const T7B_PLANNING_CONTROLS_VERSION = 1;

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const AMENDMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    fail(`${label} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value;
}

function digestString(value: unknown, label: string): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    fail(`${label} must be a 64-character lowercase hex digest.`);
  }
  return value;
}

function sequenceNumber(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(`${label} must be a positive integer event sequence.`);
  }
  return value as number;
}

// ---------------------------------------------------------------------------
// Explicit plan start.
// ---------------------------------------------------------------------------

/** Canonical current-plan authorization identity (T7b explicit start). */
export interface ExplicitStartIdentityV1 {
  readonly planRevisionId: string;
  readonly planDigest: string;
  readonly sourceManifestId: string;
  readonly sourceArtifactDigest: string;
  readonly planningPolicyVersion: 1;
  readonly projectDocsPolicyVersion: number;
}

/** Durable owner authorization record bound to one exact identity. */
export interface ExplicitStartAuthorizationV1 extends ExplicitStartIdentityV1 {
  readonly version: typeof T7B_EXPLICIT_START_AUTHORIZATION_VERSION;
  /** The owner's explicit choice (wording owned by T7c; bound exactly). */
  readonly ownerChoice: string;
}

export interface ExplicitStartRequestV1 extends ExplicitStartAuthorizationV1 {
  readonly idempotencyKey: string;
}

const EXPLICIT_START_BODY_KEYS = [
  "version",
  "planRevisionId",
  "planDigest",
  "sourceManifestId",
  "sourceArtifactDigest",
  "planningPolicyVersion",
  "projectDocsPolicyVersion",
  "ownerChoice",
  "idempotencyKey",
] as const;

/** Fail-closed validation of an explicit-start request body. */
export function validateExplicitStartRequest(
  input: unknown,
): ExplicitStartRequestV1 {
  if (!isRecord(input)) fail("Explicit plan start must be an object.");
  for (const key of Object.keys(input)) {
    if (!(EXPLICIT_START_BODY_KEYS as readonly string[]).includes(key)) {
      fail(`Explicit plan start has an unknown field: ${key}.`);
    }
  }
  if (input.version !== T7B_EXPLICIT_START_AUTHORIZATION_VERSION) {
    fail("Explicit plan start version must be 1.");
  }
  if (input.planningPolicyVersion !== 1) {
    fail("Explicit plan start requires planningPolicyVersion 1.");
  }
  const projectDocsPolicyVersion = input.projectDocsPolicyVersion;
  if (!Number.isSafeInteger(projectDocsPolicyVersion) || (projectDocsPolicyVersion as number) < 1) {
    fail("Explicit plan start projectDocsPolicyVersion must be a positive integer.");
  }
  return {
    version: T7B_EXPLICIT_START_AUTHORIZATION_VERSION,
    planRevisionId: boundedString(input.planRevisionId, "planRevisionId", 200),
    planDigest: digestString(input.planDigest, "planDigest"),
    sourceManifestId: boundedString(input.sourceManifestId, "sourceManifestId", 200),
    sourceArtifactDigest: digestString(input.sourceArtifactDigest, "sourceArtifactDigest"),
    planningPolicyVersion: 1,
    projectDocsPolicyVersion: projectDocsPolicyVersion as number,
    ownerChoice: boundedString(input.ownerChoice, "ownerChoice", 200).trim(),
    idempotencyKey: boundedString(input.idempotencyKey, "idempotencyKey", 200),
  };
}

/** Shape check for the reducer (payload carries no idempotency key). */
export function assertExecutionAuthorizationPayload(
  payload: unknown,
): ExplicitStartAuthorizationV1 {
  if (!isRecord(payload)) fail("Plan start refused: authorization payload must be an object.");
  const authorization = payload.authorization;
  if (!isRecord(authorization)) fail("Plan start refused: authorization payload must carry authorization.");
  for (const key of Object.keys(authorization)) {
    if (
      key !== "version" &&
      key !== "planRevisionId" &&
      key !== "planDigest" &&
      key !== "sourceManifestId" &&
      key !== "sourceArtifactDigest" &&
      key !== "planningPolicyVersion" &&
      key !== "projectDocsPolicyVersion" &&
      key !== "ownerChoice"
    ) {
      fail(`Plan start refused: authorization has an unknown field: ${key}.`);
    }
  }
  if (authorization.version !== T7B_EXPLICIT_START_AUTHORIZATION_VERSION) {
    fail("Plan start refused: authorization version must be 1.");
  }
  if (authorization.planningPolicyVersion !== 1) {
    fail("Plan start refused: authorization requires planningPolicyVersion 1.");
  }
  const projectDocsPolicyVersion = authorization.projectDocsPolicyVersion;
  if (!Number.isSafeInteger(projectDocsPolicyVersion) || (projectDocsPolicyVersion as number) < 1) {
    fail("Plan start refused: authorization projectDocsPolicyVersion must be a positive integer.");
  }
  return {
    version: T7B_EXPLICIT_START_AUTHORIZATION_VERSION,
    planRevisionId: boundedString(authorization.planRevisionId, "planRevisionId", 200),
    planDigest: digestString(authorization.planDigest, "planDigest"),
    sourceManifestId: boundedString(authorization.sourceManifestId, "sourceManifestId", 200),
    sourceArtifactDigest: digestString(authorization.sourceArtifactDigest, "sourceArtifactDigest"),
    planningPolicyVersion: 1,
    projectDocsPolicyVersion: projectDocsPolicyVersion as number,
    ownerChoice: boundedString(authorization.ownerChoice, "ownerChoice", 200).trim(),
  };
}

/** Exact field-wise identity comparison; any drift fails closed. */
export function explicitStartIdentitiesEqual(
  left: ExplicitStartIdentityV1,
  right: ExplicitStartIdentityV1,
): boolean {
  return (
    left.planRevisionId === right.planRevisionId &&
    left.planDigest === right.planDigest &&
    left.sourceManifestId === right.sourceManifestId &&
    left.sourceArtifactDigest === right.sourceArtifactDigest &&
    left.planningPolicyVersion === right.planningPolicyVersion &&
    left.projectDocsPolicyVersion === right.projectDocsPolicyVersion
  );
}

// ---------------------------------------------------------------------------
// Selection answers (FX-2 review r2 F1).
// ---------------------------------------------------------------------------

export interface SelectionAnswerV1 {
  readonly runtimeId: string;
  readonly idempotencyKey: string;
  readonly requiredSequence: number;
}

const SELECTION_ANSWER_KEYS = ["runtimeId", "idempotencyKey", "requiredSequence"] as const;

/** Fail-closed validation of a selection answer body. */
export function validateSelectionAnswer(input: unknown): SelectionAnswerV1 {
  if (!isRecord(input)) fail("Selection answer must be an object.");
  for (const key of Object.keys(input)) {
    if (!(SELECTION_ANSWER_KEYS as readonly string[]).includes(key)) {
      fail(`Selection answer has an unknown field: ${key}.`);
    }
  }
  const runtimeId = input.runtimeId;
  if (typeof runtimeId !== "string" || runtimeId.length === 0) {
    fail("Selection answer runtimeId must be a non-empty string.");
  }
  return {
    runtimeId,
    idempotencyKey: boundedString(input.idempotencyKey, "idempotencyKey", 200),
    requiredSequence: sequenceNumber(input.requiredSequence, "requiredSequence"),
  };
}

/**
 * Binds an answer to the exact pending requirement. A named sequence that is
 * not the current requirement is refused (stale answers never rebind to a
 * newer offer). An omitted sequence binds to the current requirement for
 * pre-T7b direct drivers only; the versioned API always requires the field.
 */
export function resolveSelectionAnswerSequence(input: {
  readonly provided: number | undefined;
  readonly current: number | undefined;
  readonly label: string;
}): number {
  if (input.provided !== undefined) {
    if (!Number.isSafeInteger(input.provided) || input.provided < 1) {
      fail(`${input.label} requiredSequence must be a positive integer event sequence.`);
    }
    if (input.current !== undefined && input.provided !== input.current) {
      fail(
        `${input.label} answer refused: requiredSequence ${input.provided} is stale; ` +
        `the current requirement is sequence ${input.current}.`,
      );
    }
    return input.provided;
  }
  if (input.current === undefined) {
    fail(`${input.label} answer refused: no pending requirement is recorded.`);
  }
  return input.current;
}

// ---------------------------------------------------------------------------
// Source amendments.
// ---------------------------------------------------------------------------

export interface SourceAmendmentImpactV1 {
  readonly addsSectionIds: readonly string[];
  readonly retiresSectionIds: readonly string[];
  readonly addsRequirementIds: readonly string[];
  readonly retiresRequirementIds: readonly string[];
}

export interface ValidatedSourceAmendmentRequest {
  readonly validated: ValidatedApprovedSource;
  readonly predecessorManifestId: string;
  readonly predecessorArtifactDigest: string;
  readonly amendmentId: string;
  readonly rationale: string;
  readonly impact: SourceAmendmentImpactV1;
  readonly idempotencyKey: string;
}

const AMENDMENT_BODY_KEYS = [
  "version",
  "approval",
  "bytesBase64",
  "mediaType",
  "encoding",
  "sections",
  "predecessorManifestId",
  "predecessorArtifactDigest",
  "amendmentId",
  "rationale",
  "impact",
  "idempotencyKey",
] as const;

function amendmentIdList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) fail(`Source amendment ${label} must be an array.`);
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 200) {
      fail(`Source amendment ${label} entries must be non-empty strings of at most 200 characters.`);
    }
    if (seen.has(entry)) fail(`Source amendment ${label} must not repeat ${entry}.`);
    seen.add(entry);
  }
  return [...seen];
}

/**
 * Fail-closed validation of a source amendment request. Layout/authority
 * rules reuse the T7a source helper: the bytes proposal is validated exactly
 * like an initial source before any predecessor, impact, or approval check.
 */
export function validateSourceAmendmentRequest(
  input: unknown,
): ValidatedSourceAmendmentRequest {
  if (!isRecord(input)) fail("Source amendment must be an object.");
  for (const key of Object.keys(input)) {
    if (!(AMENDMENT_BODY_KEYS as readonly string[]).includes(key)) {
      fail(`Source amendment has an unknown field: ${key}.`);
    }
  }
  if (input.version !== 1) fail("Source amendment version must be 1.");
  const validated = validateApprovedSourceInput({
    version: 1,
    approval: input.approval,
    bytesBase64: input.bytesBase64,
    mediaType: input.mediaType,
    encoding: input.encoding,
    ...(input.sections !== undefined ? { sections: input.sections } : {}),
  });
  const predecessorManifestId = boundedString(
    input.predecessorManifestId,
    "predecessorManifestId",
    200,
  );
  const predecessorArtifactDigest = digestString(
    input.predecessorArtifactDigest,
    "predecessorArtifactDigest",
  );
  const amendmentId = input.amendmentId;
  if (
    typeof amendmentId !== "string" ||
    !AMENDMENT_ID_PATTERN.test(amendmentId)
  ) {
    fail("Source amendment amendmentId must match [A-Za-z0-9][A-Za-z0-9._-]{0,99}.");
  }
  const rationale = boundedString(input.rationale, "rationale", 2000).trim();
  if (rationale.length === 0) fail("Source amendment rationale must not be blank.");
  const impact = input.impact;
  if (!isRecord(impact)) fail("Source amendment impact must be an object.");
  for (const key of Object.keys(impact)) {
    if (
      key !== "addsSectionIds" &&
      key !== "retiresSectionIds" &&
      key !== "addsRequirementIds" &&
      key !== "retiresRequirementIds"
    ) {
      fail(`Source amendment impact has an unknown field: ${key}.`);
    }
  }
  return {
    validated,
    predecessorManifestId,
    predecessorArtifactDigest,
    amendmentId,
    rationale,
    impact: {
      addsSectionIds: amendmentIdList(impact.addsSectionIds ?? [], "addsSectionIds"),
      retiresSectionIds: amendmentIdList(impact.retiresSectionIds ?? [], "retiresSectionIds"),
      addsRequirementIds: amendmentIdList(impact.addsRequirementIds ?? [], "addsRequirementIds"),
      retiresRequirementIds: amendmentIdList(impact.retiresRequirementIds ?? [], "retiresRequirementIds"),
    },
    idempotencyKey: boundedString(input.idempotencyKey, "idempotencyKey", 200),
  };
}

/** Deterministic amendment identity: stable across exact retries. */
export function deriveAmendmentManifestId(input: {
  readonly runId: string;
  readonly artifactDigest: string;
  readonly predecessorManifestId: string;
  readonly amendmentId: string;
  readonly mediaType: string;
  readonly encoding: string;
  readonly sections: readonly { readonly id: string; readonly title?: string; readonly startByte: number; readonly endByte: number }[];
}): string {
  const canonicalSections = input.sections.map((section) => [
    section.id,
    section.title ?? null,
    section.startByte,
    section.endByte,
  ]);
  return `manifest-${createHash("sha256")
    .update(
      JSON.stringify([
        "t7b-source-amendment-manifest/v1",
        input.runId,
        input.predecessorManifestId,
        input.amendmentId,
        input.artifactDigest,
        input.mediaType,
        input.encoding,
        canonicalSections,
      ]),
      "utf8",
    )
    .digest("hex")
    .slice(0, 32)}`;
}

/**
 * Builds the kernel amendment manifest. The chain identity (sourceId) comes
 * from the predecessor; every digest derives from the actual bytes;
 * authority records the authenticated user, never a caller-chosen value.
 */
export function buildAmendmentManifest(input: {
  readonly runId: string;
  readonly validated: ValidatedApprovedSource;
  readonly prior: ApprovedSourceManifest;
  readonly amendmentId: string;
  readonly approvedBy: string;
  readonly rationale: string;
  readonly impact: SourceAmendmentImpactV1;
  readonly createdAt: string;
}): ApprovedSourceManifest {
  const artifactDigest = computeArtifactDigest(input.validated.bytes);
  const manifestId = deriveAmendmentManifestId({
    runId: input.runId,
    artifactDigest,
    predecessorManifestId: input.prior.manifestId,
    amendmentId: input.amendmentId,
    mediaType: input.validated.mediaType,
    encoding: input.validated.encoding,
    sections: input.validated.sections,
  });
  const approver = input.approvedBy;
  if (typeof approver !== "string" || !approver || /[\s:]/.test(approver)) {
    fail("Source amendment approver must be a non-empty name without whitespace or colons.");
  }
  const recordedImpact: SourceManifestAmendmentRecordedImpact = {
    addsSectionIds: [...input.impact.addsSectionIds],
    retiresSectionIds: [...input.impact.retiresSectionIds],
    addsRequirementIds: [...input.impact.addsRequirementIds],
    retiresRequirementIds: [...input.impact.retiresRequirementIds],
  };
  return buildSourceManifest(input.validated.bytes, input.validated.sections, {
    manifestId,
    sourceId: input.prior.sourceId,
    mediaType: input.validated.mediaType,
    encoding: input.validated.encoding,
    authority: `user:${approver}`,
    createdAt: input.createdAt,
    amendment: {
      id: input.amendmentId,
      priorManifestId: input.prior.manifestId,
      priorArtifactDigest: input.prior.artifactDigest,
      authorizedBy: `user:${approver}`,
      rationale: input.rationale,
      recordedImpact,
    },
  });
}

/** Retry-stable amendment core: everything but the server clock. */
export function amendmentStableCore(
  manifest: ApprovedSourceManifest,
): Record<string, unknown> {
  const { createdAt: _omitted, ...core } = manifest as unknown as Record<string, unknown>;
  void _omitted;
  return JSON.parse(JSON.stringify(core)) as Record<string, unknown>;
}

export function sameAmendmentCore(
  left: ApprovedSourceManifest,
  right: ApprovedSourceManifest,
): boolean {
  return JSON.stringify(amendmentStableCore(left)) === JSON.stringify(amendmentStableCore(right));
}

// ---------------------------------------------------------------------------
// Plan readiness (read-only projection; omissions visible, never hidden).
// ---------------------------------------------------------------------------

export type PlanningReadinessStatus =
  | "not_opted_in"
  | "source_missing"
  | "not_ready"
  | "ready_start_required"
  | "ready_authorized"
  | "ready";

export interface PlanningReadinessSnapshot {
  readonly version: typeof T7B_PLANNING_CONTROLS_VERSION;
  readonly runId: string;
  readonly status: PlanningReadinessStatus;
  readonly planningPolicyVersion?: 1;
  readonly projectDocsPolicyVersion?: number;
  readonly triageDecision?: string;
  readonly runPolicy?: string;
  readonly planRevisionId?: string;
  readonly planDigest?: string;
  readonly sourceManifestId?: string;
  readonly sourceArtifactDigest?: string;
  readonly sourceSectionIds?: readonly string[];
  /** Sections at the current manifest no durable read covers. */
  readonly unreadSectionIds?: readonly string[];
  readonly explicitStartRequired: boolean;
  readonly explicitStartAuthorized: boolean;
  /** Owner-actionable blockers; source omissions appear here, never hidden. */
  readonly blockers: readonly string[];
}

interface ReadinessProjectionInput {
  readonly planningPolicyVersion?: 1;
  readonly projectDocsPolicyVersion?: number;
  readonly planningTriageDecision?: string;
  readonly runPolicy?: string;
  readonly planning?: {
    readonly readiness: "not_ready" | "ready";
    readonly source: {
      readonly currentManifestId: string;
      readonly sourceId: string;
      readonly artifactDigest: string;
      readonly manifestsById: Readonly<Record<string, ApprovedSourceManifest>>;
    };
    readonly sourceReadIndex: Readonly<Record<string, Readonly<Record<string, string>>>>;
    readonly plan?: {
      readonly currentRevisionId: string;
      readonly currentDigest: string;
    };
    readonly executionAuthorization?: { readonly version: number } | undefined;
  } | undefined;
}

/**
 * Canonical readiness snapshot from the actual projection. Legacy runs
 * project `not_opted_in` with no invented planning coverage; a missing
 * source, unread sections, and a missing explicit start are blockers.
 */
export function projectPlanningReadiness(input: {
  readonly runId: string;
  readonly projection: ReadinessProjectionInput;
  readonly explicitStartAuthorized: boolean;
}): PlanningReadinessSnapshot {
  const projection = input.projection;
  if (projection.planningPolicyVersion !== 1) {
    return {
      version: T7B_PLANNING_CONTROLS_VERSION,
      runId: input.runId,
      status: "not_opted_in",
      ...(projection.planningTriageDecision !== undefined
        ? { triageDecision: projection.planningTriageDecision }
        : {}),
      ...(projection.runPolicy !== undefined ? { runPolicy: projection.runPolicy } : {}),
      explicitStartRequired: false,
      explicitStartAuthorized: false,
      blockers: ["This run did not opt into evidence-gated planning."],
    };
  }
  const base = {
    version: T7B_PLANNING_CONTROLS_VERSION as typeof T7B_PLANNING_CONTROLS_VERSION,
    runId: input.runId,
    planningPolicyVersion: 1 as const,
    ...(projection.projectDocsPolicyVersion !== undefined
      ? { projectDocsPolicyVersion: projection.projectDocsPolicyVersion }
      : {}),
    ...(projection.planningTriageDecision !== undefined
      ? { triageDecision: projection.planningTriageDecision }
      : {}),
    ...(projection.runPolicy !== undefined ? { runPolicy: projection.runPolicy } : {}),
  };
  const planning = projection.planning;
  if (planning?.source.currentManifestId === undefined) {
    return {
      ...base,
      status: "source_missing",
      explicitStartRequired: false,
      explicitStartAuthorized: false,
      blockers: [
        "No approved source is registered. Approve the specification bytes to continue; the run cannot plan from the objective alone.",
      ],
    };
  }
  const manifest = planning.source.manifestsById[planning.source.currentManifestId];
  const sectionIds = manifest?.sections.map((section) => section.id) ?? [];
  const reads = planning.sourceReadIndex[planning.source.currentManifestId] ?? {};
  const unreadSectionIds = sectionIds.filter(
    (sectionId) => {
      const section = manifest?.sections.find((candidate) => candidate.id === sectionId);
      return section === undefined || reads[sectionId] !== section.digest;
    },
  );
  const blockers: string[] = [];
  if (projection.planningTriageDecision !== "build") {
    blockers.push(
      `Planning progress requires a durable triage decision of build; the current triage decision is ${projection.planningTriageDecision ?? "none"}.`,
    );
  }
  for (const sectionId of unreadSectionIds) {
    blockers.push(`Source section ${sectionId} has no durable read at the current manifest revision.`);
  }
  const executable = projection.runPolicy !== "plan_only" && projection.planningTriageDecision !== "answer";
  // An explicit start gates worker dispatch only; readiness itself is the
  // blocker until the plan is ready, and non-executable policies
  // (plan-only, answered) never take a start.
  if (planning.readiness !== "ready" || planning.plan === undefined) {
    if (planning.readiness !== "ready") blockers.push("The plan is not ready.");
    return {
      ...base,
      status: "not_ready",
      sourceManifestId: planning.source.currentManifestId,
      sourceArtifactDigest: planning.source.artifactDigest,
      sourceSectionIds: sectionIds,
      unreadSectionIds,
      explicitStartRequired: false,
      explicitStartAuthorized: false,
      blockers,
    };
  }
  const readyBase = {
    ...base,
    planRevisionId: planning.plan.currentRevisionId,
    planDigest: planning.plan.currentDigest,
    sourceManifestId: planning.source.currentManifestId,
    sourceArtifactDigest: planning.source.artifactDigest,
    sourceSectionIds: sectionIds,
    unreadSectionIds,
  };
  if (!executable) {
    return {
      ...readyBase,
      status: "ready",
      explicitStartRequired: false,
      explicitStartAuthorized: false,
      blockers,
    };
  }
  if (!input.explicitStartAuthorized) {
    blockers.push("The current ready plan has no explicit owner start authorization.");
    return {
      ...readyBase,
      status: "ready_start_required",
      explicitStartRequired: true,
      explicitStartAuthorized: false,
      blockers,
    };
  }
  return {
    ...readyBase,
    status: "ready_authorized",
    explicitStartRequired: false,
    explicitStartAuthorized: true,
    blockers,
  };
}

// ---------------------------------------------------------------------------
// On-demand planning export (read-only; C1-bounded, redacted).
// ---------------------------------------------------------------------------

const EXPORT_LIST_CAP = 200;

function capped<T>(items: readonly T[]): { items: readonly T[]; omittedCount: number } {
  if (items.length <= EXPORT_LIST_CAP) return { items, omittedCount: 0 };
  return { items: items.slice(0, EXPORT_LIST_CAP), omittedCount: items.length - EXPORT_LIST_CAP };
}

export interface PlanningExportDocument {
  readonly version: typeof T7B_PLANNING_CONTROLS_VERSION;
  readonly runId: string;
  readonly exportedAt: string;
  readonly readiness: PlanningReadinessSnapshot;
  /** C1-rendered bounded snapshot (200 lines / 16 KiB field caps, neutralized text). */
  readonly snapshot: { readonly text: string; readonly digestValid: boolean; readonly byteLength: number };
  readonly sourceManifests: ReadonlyArray<{
    readonly manifestId: string;
    readonly sourceId: string;
    readonly artifactDigest: string;
    readonly byteLength: number;
    readonly mediaType: string;
    readonly encoding: string;
    readonly authority: string;
    readonly createdAt: string;
    readonly amendmentId?: string;
    readonly sections: ReadonlyArray<{ readonly id: string; readonly startByte: number; readonly endByte: number; readonly digest: string }>;
  }>;
  readonly requirements: { readonly items: ReadonlyArray<{ readonly id: string; readonly purpose: string }>; readonly omittedCount: number };
  readonly phases: { readonly items: ReadonlyArray<{ readonly id: string; readonly purpose: string }>; readonly omittedCount: number };
  readonly tasks: { readonly items: ReadonlyArray<{ readonly id: string; readonly status: string }>; readonly omittedCount: number };
}

/**
 * On-demand planning export through the existing C1 renderer. References
 * evidence by identity only: no transcripts, credentials, or environment
 * travel in this document, and no project file is written.
 */
export function buildPlanningExportDocument(input: {
  readonly runId: string;
  readonly projection: SchedulerProjection;
  readonly readiness: PlanningReadinessSnapshot;
  readonly exportedAt: string;
}): PlanningExportDocument {
  const projection = input.projection;
  const planning = projection.planning;
  const snapshotText = renderHandoffSnapshot(handoffSnapshotInputFromProjection(projection));
  const manifests = planning === undefined
    ? []
    : planning.source.manifestHistoryIds.map((manifestId) => planning.source.manifestsById[manifestId]!);
  const requirements = capped(
    (planning?.ledger?.requirements ?? []).map((requirement) => ({
      id: requirement.id,
      purpose: requirement.purpose,
    })),
  );
  const phases = capped(
    (planning?.ledger?.phases ?? []).map((phase) => ({ id: phase.id, purpose: phase.purpose })),
  );
  const tasks = capped(
    Object.entries(projection.tasks).map(([id, task]) => ({ id, status: task.status })),
  );
  return {
    version: T7B_PLANNING_CONTROLS_VERSION,
    runId: input.runId,
    exportedAt: input.exportedAt,
    readiness: input.readiness,
    snapshot: {
      text: snapshotText,
      digestValid: verifyHandoffSnapshotDigest(snapshotText),
      byteLength: Buffer.byteLength(snapshotText, "utf8"),
    },
    sourceManifests: manifests.map((manifest) => ({
      manifestId: manifest.manifestId,
      sourceId: manifest.sourceId,
      artifactDigest: manifest.artifactDigest,
      byteLength: manifest.byteLength,
      mediaType: manifest.mediaType,
      encoding: manifest.encoding,
      authority: manifest.authority,
      createdAt: manifest.createdAt,
      ...(manifest.amendment !== undefined ? { amendmentId: manifest.amendment.id } : {}),
      sections: manifest.sections.map((section) => ({
        id: section.id,
        startByte: section.startByte,
        endByte: section.endByte,
        digest: section.digest,
      })),
    })),
    requirements,
    phases,
    tasks,
  };
}

export type { ApprovedSourceInputV1 };
