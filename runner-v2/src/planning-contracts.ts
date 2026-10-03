import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  type ApprovedSourceManifest,
  type SourceManifestAmendment,
  manifestResolvesAmendmentRef,
  sourceManifestSectionIds,
  validateApprovedSourceManifest,
} from "./source-manifest.js";
import {
  PLAN_CRITIQUE_CATEGORIES,
  type PlanCritiqueCategory,
  type PlanCritiqueSeverity,
} from "./plan-critique-contracts.js";
import type { ReviewerIndependence } from "./verifier-contracts.js";

/**
 * Evidence-gated planning contracts (Runner V2 P6.6, T1). Section 3 of
 * docs/superpowers/plans/2026-09-06-runner-v2-evidence-gated-planning.md.
 * `HostPlanningCapabilities` lives here (G-1), not in
 * runner-capability-contract.ts, which is an unrelated digest-checked
 * runner-extension/plugin-trust contract.
 *
 * Every validator here is structural/mechanical only: it enforces identities,
 * completeness, ownership, ordering, and cross-references. It never judges
 * semantic correctness — that is the Architect's and independent reviewers'
 * authority (plan section 2, item 4).
 */

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Same runtime check as isRecord, but deliberately typed as `boolean`, not a
 * `value is Record<string, unknown>` predicate. Using it as the first `||`
 * disjunct short-circuits a runtime crash on a missing required nested
 * object without TypeScript's control-flow narrowing collapsing an
 * already-precise domain type (e.g. ExecutionTaskOutcome) down to
 * Record<string, unknown> in the surviving branch, which silently discards
 * the more specific field types a custom type-predicate would apply here.
 */
function isObj(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** Rejects blank/whitespace-only entries — content-bearing lists cannot be emptied out while staying "present". */
function isNonBlankStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim().length > 0);
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

type AmendmentHistory = readonly SourceManifestAmendment[];

function findAmendment(
  manifest: ApprovedSourceManifest,
  amendmentHistory: AmendmentHistory,
  amendmentRef: string,
): SourceManifestAmendment | undefined {
  return [manifest.amendment, ...amendmentHistory].find((amendment) => amendment?.id === amendmentRef);
}

function validateRequirementAmendmentScope(
  requirementId: string,
  sectionIds: readonly string[],
  amendmentRef: string,
  manifest: ApprovedSourceManifest,
  amendmentHistory: AmendmentHistory,
): PlanningIssue[] {
  const amendment = findAmendment(manifest, amendmentHistory, amendmentRef);
  const impact = amendment?.recordedImpact;
  if (
    impact === undefined ||
    !isObj(impact) ||
    !isStringArray(impact.addsSectionIds) ||
    !isStringArray(impact.retiresSectionIds) ||
    !isStringArray(impact.addsRequirementIds) ||
    !isStringArray(impact.retiresRequirementIds)
  ) {
    return [{
      code: "amendment_scope_missing",
      requirementId,
      message: `Requirement ${requirementId} cites amendment ${amendmentRef} without complete recorded section and requirement impact.`,
    }];
  }
  const issues: PlanningIssue[] = [];
  if (!impact.retiresRequirementIds.includes(requirementId)) {
    issues.push({
      code: "amendment_scope_mismatch",
      requirementId,
      message: `Amendment ${amendmentRef} does not retire requirement ${requirementId}.`,
    });
  }
  for (const sectionId of sectionIds) {
    if (!impact.retiresSectionIds.includes(sectionId) && !impact.addsSectionIds.includes(sectionId)) {
      issues.push({
        code: "amendment_scope_mismatch",
        requirementId,
        message: `Amendment ${amendmentRef} does not cover source section ${sectionId}.`,
      });
    }
  }
  return issues;
}

function validateSectionAmendmentScope(
  sectionId: string,
  amendmentRef: string,
  manifest: ApprovedSourceManifest,
  amendmentHistory: AmendmentHistory,
): PlanningIssue[] {
  const impact = findAmendment(manifest, amendmentHistory, amendmentRef)?.recordedImpact;
  if (impact === undefined || !isObj(impact) || !isStringArray(impact.retiresSectionIds)) {
    return [{
      code: "amendment_scope_missing",
      message: `Source section ${sectionId} cites amendment ${amendmentRef} without complete recorded impact.`,
    }];
  }
  if (!impact.retiresSectionIds.includes(sectionId)) {
    return [{
      code: "amendment_scope_mismatch",
      message: `Amendment ${amendmentRef} does not retire source section ${sectionId}.`,
    }];
  }
  return [];
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function computeDigest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export interface PlanningIssue {
  readonly code: string;
  readonly requirementId?: string;
  readonly taskId?: string;
  readonly phaseId?: string;
  readonly message: string;
}

export interface PlanningValidation {
  readonly valid: boolean;
  readonly issues: readonly PlanningIssue[];
}

function fail(issues: readonly PlanningIssue[]): PlanningValidation {
  return { valid: issues.length === 0, issues };
}

function assertValid(validation: PlanningValidation, label: string): void {
  if (!validation.valid) {
    throw new Error(`${label}: ${validation.issues.map((issue) => issue.message).join(" ")}`);
  }
}

// ---------------------------------------------------------------------------
// SourceRequirement
// ---------------------------------------------------------------------------

export type RequirementObligationKind =
  | "mandatory"
  | "conditional"
  | "compatibility"
  | "operational"
  | "security"
  | "non_functional";

export const REQUIREMENT_OBLIGATION_KINDS: readonly RequirementObligationKind[] = [
  "mandatory",
  "conditional",
  "compatibility",
  "operational",
  "security",
  "non_functional",
];

export interface SourceRequirementReference {
  readonly sourceId: string;
  /** Refs into ApprovedSourceManifest.sections[].id; must be non-empty. */
  readonly sectionIds: readonly string[];
}

export type RequirementApplicabilityStatus = "applicable" | "conditional_pending" | "not_applicable";

export interface RequirementApplicabilityDisposition {
  readonly authorizedBy: string;
  readonly rationale: string;
  /** At least one of amendmentRef/evidenceRef is required — an authorized basis. */
  readonly amendmentRef?: string;
  readonly evidenceRef?: string;
  readonly decidedAt: string;
}

export interface RequirementApplicability {
  readonly status: RequirementApplicabilityStatus;
  /** Required when status === "conditional_pending". */
  readonly conditionExpression?: string;
  /** Required when status === "not_applicable", or a conditional resolves to it. */
  readonly disposition?: RequirementApplicabilityDisposition;
}

export interface RequirementAcceptanceCondition {
  readonly id: string;
  readonly description: string;
  readonly responsibleGateId: string;
  readonly requiredEvidenceKinds: readonly string[];
}

export interface SourceRequirement {
  readonly id: string;
  readonly reference: SourceRequirementReference;
  readonly purpose: string;
  readonly observableOutcome: string;
  readonly obligationKind: RequirementObligationKind;
  readonly applicability: RequirementApplicability;
  /** Exactly one accountable owning phase. */
  readonly accountablePhaseId: string;
  readonly contributingTaskIds: readonly string[];
  readonly dependsOnRequirementIds?: readonly string[];
  readonly acceptanceConditions: readonly RequirementAcceptanceCondition[];
}

/**
 * Authorizes a source section that no requirement references as genuinely
 * non-normative (e.g. front matter, a heading) rather than a silently
 * dropped obligation.
 *
 * NEW-1 (repair cycle 2): a section is never "just" normative or not by
 * evidence/label alone — the same rule as a non-conditional requirement's
 * retirement (I2) applies: `amendmentRef` is REQUIRED (not merely one of
 * amendmentRef-or-evidenceRef), and it must resolve against the manifest's
 * own amendment chain (`manifestResolvesAmendmentRef`) — an architect
 * citing an arbitrary/nonexistent amendment id cannot silently retire an
 * obligation by relabelling its section non-normative.
 */
export interface SourceSectionDisposition {
  readonly sectionId: string;
  readonly rationale: string;
  readonly authorizedBy: string;
  readonly amendmentRef: string;
  readonly decidedAt: string;
  /** Supplementary only — never sufficient authorization by itself. */
  readonly evidenceRef?: string;
}

/**
 * I2 / NEW-1 / NEW-6: the ONE shared authorization rule for a not_applicable
 * disposition, used by validateRequirementLedger AND validatePhaseAcceptance
 * (NEW-6 — phase acceptance no longer has its own, weaker truthy-object
 * check). Requires authorizedBy/rationale/decidedAt; requires amendmentRef
 * (not evidenceRef alone) for a non-conditional obligationKind; and requires
 * any cited amendmentRef to actually resolve against the manifest's own
 * amendment (an arbitrary string never passes).
 */
function validateNotApplicableDisposition(
  requirementId: string,
  sectionIds: readonly string[],
  obligationKind: RequirementObligationKind,
  disposition: RequirementApplicabilityDisposition | undefined,
  manifest: ApprovedSourceManifest,
  amendmentHistory: AmendmentHistory = [],
): PlanningIssue[] {
  const issues: PlanningIssue[] = [];
  if (!isRecord(disposition) || !nonEmpty(disposition.authorizedBy) || !nonEmpty(disposition.rationale) || !isValidTimestamp(disposition.decidedAt)) {
    issues.push({
      code: "missing_disposition",
      requirementId,
      message: `Requirement ${requirementId} is marked not_applicable without an authorized disposition (silent obligation removal).`,
    });
    return issues;
  }
  if (!nonEmpty(disposition.amendmentRef) && !nonEmpty(disposition.evidenceRef)) {
    issues.push({
      code: "unauthorized_disposition",
      requirementId,
      message: `Requirement ${requirementId}'s not_applicable disposition cites neither an amendment nor evidence — unauthorized.`,
    });
    return issues;
  }
  if (obligationKind !== "conditional" && !nonEmpty(disposition.amendmentRef)) {
    // Source §1 / plan §2.4: an evidence-based N/A resolution is only for a
    // *conditional* requirement whose condition resolved. Retiring a
    // non-conditional (mandatory/compatibility/operational/security/
    // non-functional) obligation always needs an owner amendment, not
    // evidence alone.
    issues.push({
      code: "unauthorized_mandatory_retirement",
      requirementId,
      message: `Requirement ${requirementId} (obligationKind=${obligationKind}) cannot be retired by evidence alone — a non-conditional obligation's not_applicable disposition requires an amendmentRef.`,
    });
    return issues;
  }
  if (nonEmpty(disposition.amendmentRef) && !manifestResolvesAmendmentRef(manifest, disposition.amendmentRef, amendmentHistory)) {
    issues.push({
      code: "unresolved_amendment_ref",
      requirementId,
      message: `Requirement ${requirementId}'s disposition cites amendmentRef ${disposition.amendmentRef}, which does not resolve against the manifest's amendment chain.`,
    });
  } else if (
    nonEmpty(disposition.amendmentRef) &&
    (amendmentHistory.length > 0 || manifest.amendment?.recordedImpact !== undefined)
  ) {
    issues.push(...validateRequirementAmendmentScope(
      requirementId,
      sectionIds,
      disposition.amendmentRef,
      manifest,
      amendmentHistory,
    ));
  }
  return issues;
}

/**
 * B1: every manifest section must be referenced by at least one requirement,
 * or explicitly authorized as non-normative. A requirement (and its section
 * reference) silently disappearing — e.g. removed together with its only
 * task — leaves its section uncovered and is rejected here, not just as a
 * dangling task/requirement ref.
 */
export function validateRequirementLedger(
  requirements: readonly SourceRequirement[],
  manifest: ApprovedSourceManifest,
  knownPhaseIds: readonly string[],
  nonNormativeSections: readonly SourceSectionDisposition[] = [],
  amendmentHistory: AmendmentHistory = [],
): PlanningValidation {
  const issues: PlanningIssue[] = [];
  if (!Array.isArray(requirements) || requirements.length === 0) {
    return fail([{ code: "empty_ledger", message: "Requirement ledger must not be empty." }]);
  }
  if (!isObj(manifest)) {
    return fail([{ code: "invalid_manifest", message: "Requirement ledger requires a valid source manifest." }]);
  }
  const knownSectionIds = new Set(sourceManifestSectionIds(manifest));
  const phaseIds = new Set(Array.isArray(knownPhaseIds) ? knownPhaseIds : []);
  const seenById = new Map<string, SourceRequirement>();
  const coveredSectionIds = new Set<string>();

  for (const requirement of requirements) {
    if (!isObj(requirement) || !nonEmpty(requirement.id)) {
      issues.push({ code: "invalid_requirement", message: "Requirement requires a non-empty id." });
      continue;
    }
    const id = requirement.id;
    if (id !== id.trim()) {
      issues.push({ code: "untrimmed_id", requirementId: id, message: `Requirement id "${id}" must be trimmed.` });
    }
    const existing = seenById.get(id);
    if (existing) {
      issues.push({ code: "duplicate_requirement_id", requirementId: id, message: `Duplicate requirement id ${id}.` });
      if (existing.accountablePhaseId !== requirement.accountablePhaseId) {
        issues.push({
          code: "conflicting_owner",
          requirementId: id,
          message: `Requirement ${id} is assigned two different accountable phases (${existing.accountablePhaseId} and ${requirement.accountablePhaseId}).`,
        });
      }
    }
    seenById.set(id, requirement);

    if (!isObj(requirement.reference) || requirement.reference.sourceId !== manifest.sourceId) {
      issues.push({ code: "unknown_source_ref", requirementId: id, message: `Requirement ${id} references an unknown source.` });
    } else if (!isNonBlankStringArray(requirement.reference.sectionIds) || requirement.reference.sectionIds.length === 0) {
      issues.push({ code: "empty_section_refs", requirementId: id, message: `Requirement ${id} must reference at least one source section.` });
    } else {
      for (const sectionId of requirement.reference.sectionIds) {
        if (!knownSectionIds.has(sectionId)) {
          issues.push({
            code: "unknown_section_ref",
            requirementId: id,
            message: `Requirement ${id} references unknown source section ${sectionId} — a dropped or nonexistent section.`,
          });
        } else {
          coveredSectionIds.add(sectionId);
        }
      }
    }

    if (!nonEmpty(requirement.purpose) || !nonEmpty(requirement.observableOutcome)) {
      issues.push({ code: "empty_purpose_or_outcome", requirementId: id, message: `Requirement ${id} requires purpose and observableOutcome.` });
    }
    if (!(REQUIREMENT_OBLIGATION_KINDS as readonly string[]).includes(requirement.obligationKind as string)) {
      issues.push({ code: "invalid_obligation_kind", requirementId: id, message: `Requirement ${id} has an invalid obligationKind.` });
    }
    if (!nonEmpty(requirement.accountablePhaseId)) {
      issues.push({ code: "missing_accountable_phase", requirementId: id, message: `Requirement ${id} requires exactly one accountable phase.` });
    } else if (!phaseIds.has(requirement.accountablePhaseId)) {
      issues.push({ code: "unknown_phase_ref", requirementId: id, message: `Requirement ${id} references unknown phase ${requirement.accountablePhaseId}.` });
    }

    const applicability = requirement.applicability;
    if (!isObj(applicability) || !["applicable", "conditional_pending", "not_applicable"].includes(applicability.status as string)) {
      issues.push({ code: "invalid_applicability", requirementId: id, message: `Requirement ${id} has an invalid applicability status.` });
    } else {
      if (applicability.status === "conditional_pending" && !nonEmpty(applicability.conditionExpression)) {
        issues.push({ code: "missing_condition_expression", requirementId: id, message: `Requirement ${id} is conditional_pending but has no conditionExpression.` });
      }
      if (applicability.status === "not_applicable") {
        const sectionIds = isNonBlankStringArray(requirement.reference?.sectionIds) ? requirement.reference.sectionIds : [];
        issues.push(...validateNotApplicableDisposition(id, sectionIds, requirement.obligationKind, applicability.disposition, manifest, amendmentHistory));
      }
      if (applicability.status !== "not_applicable" && (!Array.isArray(requirement.acceptanceConditions) || requirement.acceptanceConditions.length === 0)) {
        issues.push({ code: "missing_acceptance_conditions", requirementId: id, message: `Requirement ${id} requires at least one acceptance condition.` });
      }
    }

    if (Array.isArray(requirement.acceptanceConditions)) {
      const seenConditionIds = new Set<string>();
      for (const condition of requirement.acceptanceConditions) {
        if (
          !isObj(condition) ||
          !nonEmpty(condition.id) ||
          !nonEmpty(condition.description) ||
          !nonEmpty(condition.responsibleGateId) ||
          !isNonBlankStringArray(condition.requiredEvidenceKinds) ||
          condition.requiredEvidenceKinds.length === 0
        ) {
          issues.push({ code: "invalid_acceptance_condition", requirementId: id, message: `Requirement ${id} has an incomplete acceptance condition.` });
          continue;
        }
        if (seenConditionIds.has(condition.id)) {
          issues.push({ code: "duplicate_acceptance_condition", requirementId: id, message: `Requirement ${id} has duplicate acceptance condition id ${condition.id}.` });
        }
        seenConditionIds.add(condition.id);
      }
    }
  }

  // B1: every manifest section must be covered by a requirement reference or
  // an explicit, authorized non-normative disposition — a requirement (and
  // its section reference) removed wholesale leaves its section uncovered.
  const dispositionBySection = new Map(
    (nonNormativeSections ?? []).filter(isObj).map((d) => [(d as SourceSectionDisposition).sectionId, d as SourceSectionDisposition]),
  );
  const manifestSections = Array.isArray(manifest.sections) ? manifest.sections.filter(isObj) : [];
  for (const section of manifestSections) {
    if (coveredSectionIds.has(section.id)) continue;
    const disposition = dispositionBySection.get(section.id);
    // NEW-1: an amendmentRef is REQUIRED (not merely one-of amendmentRef-or-
    // evidenceRef) and must resolve against the manifest's own amendment —
    // an architect-authored, evidence-only "non-normative" label can no
    // longer silently retire an obligation via the section route.
    if (
      !disposition ||
      !nonEmpty(disposition.rationale) ||
      !nonEmpty(disposition.authorizedBy) ||
      !isValidTimestamp(disposition.decidedAt) ||
      !nonEmpty(disposition.amendmentRef)
    ) {
      issues.push({
        code: "uncovered_source_section",
        message: `Source section ${section.id} is referenced by no requirement and has no authorized non-normative disposition (rationale/authorizedBy/decidedAt/amendmentRef all required).`,
      });
    } else if (!manifestResolvesAmendmentRef(manifest, disposition.amendmentRef, amendmentHistory)) {
      issues.push({
        code: "unresolved_amendment_ref",
        message: `Source section ${section.id}'s non-normative disposition cites amendmentRef ${disposition.amendmentRef}, which does not resolve against the manifest's amendment chain.`,
      });
    } else if (amendmentHistory.length > 0 || manifest.amendment?.recordedImpact !== undefined) {
      issues.push(...validateSectionAmendmentScope(section.id, disposition.amendmentRef, manifest, amendmentHistory));
    }
  }

  return fail(issues);
}

export function assertRequirementLedger(
  requirements: readonly SourceRequirement[],
  manifest: ApprovedSourceManifest,
  knownPhaseIds: readonly string[],
  nonNormativeSections: readonly SourceSectionDisposition[] = [],
  amendmentHistory: AmendmentHistory = [],
): void {
  assertValid(validateRequirementLedger(requirements, manifest, knownPhaseIds, nonNormativeSections, amendmentHistory), "Requirement ledger");
}

/**
 * A cancelled task cannot silently orphan a requirement: every applicable
 * requirement must retain at least one non-cancelled, non-investigation
 * contributing task, or an authorized not_applicable disposition. A
 * `conditional_pending` requirement is exempt from the "orphaned" check
 * (its investigation task IS its current delivery), but never exempt from
 * needing at least one live contributing task. Never throws on malformed
 * `applicability`.
 */
export function validateRequirementTaskCoverage(
  requirements: readonly SourceRequirement[],
  tasks: readonly ExecutionTaskContract[],
  taskStatuses: ReadonlyMap<string, string>,
): PlanningValidation {
  if (!Array.isArray(requirements) || !Array.isArray(tasks) || !(taskStatuses instanceof Map)) {
    return fail([{ code: "invalid_input", message: "validateRequirementTaskCoverage requires requirements and tasks arrays and a taskStatuses map." }]);
  }
  const issues: PlanningIssue[] = [];
  const validTasks = tasks.filter(isObj) as ExecutionTaskContract[];
  const knownTaskIds = new Set(validTasks.map((task) => task.id));
  const taskById = new Map(validTasks.map((task) => [task.id, task]));
  for (const requirement of requirements.filter(isObj) as SourceRequirement[]) {
    const applicability = isObj(requirement.applicability) ? requirement.applicability : undefined;
    if (applicability?.status === "not_applicable") continue;
    if (!Array.isArray(requirement.contributingTaskIds) || requirement.contributingTaskIds.length === 0) {
      issues.push({
        code: "orphaned_requirement",
        requirementId: requirement.id,
        message: `Requirement ${requirement.id} has no contributing tasks and no not_applicable disposition.`,
      });
      continue;
    }
    for (const taskId of requirement.contributingTaskIds) {
      if (!knownTaskIds.has(taskId)) {
        issues.push({
          code: "unknown_task_ref",
          requirementId: requirement.id,
          taskId,
          message: `Requirement ${requirement.id} references unknown task ${taskId}.`,
        });
      }
    }
    const liveTasks = requirement.contributingTaskIds.filter(
      (taskId) => taskStatuses.get(taskId) !== "cancelled",
    );
    if (liveTasks.length === 0) {
      issues.push({
        code: "orphaned_requirement",
        requirementId: requirement.id,
        message: `Requirement ${requirement.id}'s only implementation task(s) were cancelled without a disposition.`,
      });
    }
    // I4: an investigation task's job is to answer a bounded question, not to
    // deliver behavior — it cannot substitute for a fully "applicable"
    // requirement's only delivery. A conditional_pending requirement is
    // exempt, since an investigation IS its legitimate current delivery.
    if (applicability?.status === "applicable" && liveTasks.length > 0) {
      const hasNonInvestigationDelivery = liveTasks.some((taskId) => {
        const task = taskById.get(taskId);
        return task !== undefined && task.investigation === undefined;
      });
      if (!hasNonInvestigationDelivery) {
        issues.push({
          code: "investigation_only_delivery",
          requirementId: requirement.id,
          message: `Requirement ${requirement.id} is applicable but only investigation tasks contribute to it — investigation cannot substitute for behavior delivery.`,
        });
      }
    }
  }
  return fail(issues);
}

// ---------------------------------------------------------------------------
// ExecutionTaskContract
// ---------------------------------------------------------------------------

export interface ExecutionTaskOutcome {
  readonly user: string;
  readonly system: string;
}

export interface ExecutionTaskScope {
  readonly includes: readonly string[];
  readonly excludes: readonly string[];
}

export interface ExecutionTaskValidationRationale {
  readonly targetedRationale: string;
  readonly affectedScopeRationale: string;
}

export interface ExecutionTaskNegativeProofApplicability {
  readonly applicable: boolean;
  /** Required whether applicable or explicitly not — no silent omission. */
  readonly rationale: string;
}

export interface ExecutionTaskCleanup {
  readonly cleanup: string;
  readonly recovery: string;
  readonly rollback: string;
}

export interface ExecutionTaskInvestigation {
  readonly question: string;
  readonly deliverable: string;
  readonly decisionCriterion: string;
  readonly dependentUnlockTaskIds: readonly string[];
}

/** Task-local, but explicitly mapped to a run-level requirement id the task claims (task.requirementIds). */
export interface RequirementCriterionMapping {
  readonly taskLocalCriterionId: string;
  readonly requirementId: string;
}

export interface ExecutionTaskAcceptanceCriterion {
  readonly id: string;
  readonly text: string;
}

export interface ExecutionTaskContract {
  readonly id: string;
  /** Prior task ids this contract supersedes (rename/replace/split lineage), most recent first. */
  readonly lineage: readonly string[];
  readonly accountablePhaseId: string;
  readonly requirementIds: readonly string[];
  readonly outcome: ExecutionTaskOutcome;
  readonly scope: ExecutionTaskScope;
  readonly writableSurfaces: readonly string[];
  readonly forbiddenSurfaces: readonly string[];
  readonly sharedResourceClaims?: readonly string[];
  readonly dependencies: readonly string[];
  readonly requiredBase: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly steps: readonly string[];
  readonly acceptance: {
    readonly criteria: readonly ExecutionTaskAcceptanceCriterion[];
    readonly definitionOfDone: string;
  };
  readonly validation: ExecutionTaskValidationRationale;
  readonly negativeProofApplicability: ExecutionTaskNegativeProofApplicability;
  readonly reviewCriteria: readonly string[];
  readonly integrationChecks: readonly string[];
  readonly cleanup: ExecutionTaskCleanup;
  /** Present only for a bounded investigation task. It cannot substitute for behavior delivery. */
  readonly investigation?: ExecutionTaskInvestigation;
  /** Every acceptance criterion id must appear here at least once, mapped to a requirement in requirementIds. */
  readonly requirementCriteriaMap: readonly RequirementCriterionMapping[];
}

const REQUIRED_TEXT_LIST_FIELDS: readonly (keyof ExecutionTaskContract)[] = [
  "writableSurfaces",
  "forbiddenSurfaces",
  "inputs",
  "outputs",
  "steps",
  "reviewCriteria",
  "integrationChecks",
];

export function validateExecutionTaskContract(task: ExecutionTaskContract): PlanningValidation {
  if (!isObj(task) || !nonEmpty((task as { id?: unknown }).id)) {
    return fail([{ code: "invalid_task", message: "Task contract requires a non-empty id." }]);
  }
  const issues: PlanningIssue[] = [];
  const id = task.id;
  if (id !== id.trim()) {
    issues.push({ code: "untrimmed_id", taskId: id, message: `Task id "${id}" must be trimmed.` });
  }
  const missing = (field: string) =>
    issues.push({ code: "incomplete_task_contract", taskId: id, message: `Task ${id} is missing required field ${field}.` });

  if (!isNonBlankStringArray(task.lineage)) missing("lineage");
  if (!nonEmpty(task.accountablePhaseId)) missing("accountablePhaseId");
  if (!isNonBlankStringArray(task.requirementIds) || task.requirementIds.length === 0) missing("requirementIds");
  if (!isObj(task.outcome) || !nonEmpty(task.outcome.user) || !nonEmpty(task.outcome.system)) missing("outcome");
  if (
    !isObj(task.scope) ||
    !isNonBlankStringArray(task.scope.includes) ||
    task.scope.includes.length === 0 ||
    !isNonBlankStringArray(task.scope.excludes)
  ) missing("scope");

  for (const field of REQUIRED_TEXT_LIST_FIELDS) {
    const value = (task as unknown as Record<string, unknown>)[field as string];
    if (!isNonBlankStringArray(value) || (value as string[]).length === 0) missing(String(field));
  }
  if (!isNonBlankStringArray(task.dependencies)) missing("dependencies");
  if (!nonEmpty(task.requiredBase)) missing("requiredBase");

  // I3: criteria now carry stable ids so requirementCriteriaMap can resolve
  // them, and every criterion must be explicitly mapped to a requirement the
  // task claims (task.requirementIds) — full, resolvable, bidirectional
  // task-local-criterion-to-run-level-requirement traceability.
  const criteriaIds = new Set<string>();
  if (
    !isObj(task.acceptance) ||
    !Array.isArray(task.acceptance.criteria) ||
    task.acceptance.criteria.length === 0 ||
    !nonEmpty(task.acceptance.definitionOfDone)
  ) {
    missing("acceptance");
  } else {
    for (const criterion of task.acceptance.criteria) {
      if (!isObj(criterion) || !nonEmpty((criterion as ExecutionTaskAcceptanceCriterion).id) || !nonEmpty((criterion as ExecutionTaskAcceptanceCriterion).text)) {
        issues.push({ code: "invalid_acceptance_criterion", taskId: id, message: `Task ${id} has a malformed acceptance criterion (requires id and text).` });
        continue;
      }
      const criterionId = (criterion as ExecutionTaskAcceptanceCriterion).id;
      if (criteriaIds.has(criterionId)) {
        issues.push({ code: "duplicate_acceptance_criterion", taskId: id, message: `Task ${id} has duplicate acceptance criterion id ${criterionId}.` });
      }
      criteriaIds.add(criterionId);
    }
  }

  if (
    !isObj(task.validation) ||
    !nonEmpty(task.validation.targetedRationale) ||
    !nonEmpty(task.validation.affectedScopeRationale)
  ) missing("validation");

  if (
    !isObj(task.negativeProofApplicability) ||
    typeof task.negativeProofApplicability.applicable !== "boolean" ||
    !nonEmpty(task.negativeProofApplicability.rationale)
  ) missing("negativeProofApplicability");

  if (
    !isObj(task.cleanup) ||
    !nonEmpty(task.cleanup.cleanup) ||
    !nonEmpty(task.cleanup.recovery) ||
    !nonEmpty(task.cleanup.rollback)
  ) missing("cleanup");

  if (task.investigation !== undefined) {
    const investigation = task.investigation;
    if (
      !isObj(investigation) ||
      !nonEmpty(investigation.question) ||
      !nonEmpty(investigation.deliverable) ||
      !nonEmpty(investigation.decisionCriterion) ||
      !isNonBlankStringArray(investigation.dependentUnlockTaskIds) ||
      investigation.dependentUnlockTaskIds.length === 0
    ) {
      issues.push({
        code: "incomplete_investigation_task",
        taskId: id,
        message: `Investigation task ${id} requires question, deliverable, decisionCriterion, and at least one dependent unlock.`,
      });
    }
  }

  const requirementIdsClaimed = isNonBlankStringArray(task.requirementIds) ? new Set(task.requirementIds) : new Set<string>();
  if (!Array.isArray(task.requirementCriteriaMap) || task.requirementCriteriaMap.length === 0) {
    missing("requirementCriteriaMap");
  } else {
    const mappedCriterionIds = new Set<string>();
    for (const entry of task.requirementCriteriaMap) {
      if (!isObj(entry) || !nonEmpty((entry as RequirementCriterionMapping).taskLocalCriterionId) || !nonEmpty((entry as RequirementCriterionMapping).requirementId)) {
        issues.push({
          code: "invalid_requirement_criteria_map",
          taskId: id,
          message: `Task ${id} has a malformed task-local-criterion-to-requirement mapping.`,
        });
        continue;
      }
      const mapping = entry as RequirementCriterionMapping;
      if (criteriaIds.size > 0 && !criteriaIds.has(mapping.taskLocalCriterionId)) {
        issues.push({
          code: "unknown_criterion_ref",
          taskId: id,
          message: `Task ${id}'s requirementCriteriaMap references unknown criterion ${mapping.taskLocalCriterionId}.`,
        });
      }
      if (requirementIdsClaimed.size > 0 && !requirementIdsClaimed.has(mapping.requirementId)) {
        issues.push({
          code: "unmapped_requirement_ref",
          taskId: id,
          message: `Task ${id}'s requirementCriteriaMap maps criterion ${mapping.taskLocalCriterionId} to requirement ${mapping.requirementId}, which is not in the task's requirementIds.`,
        });
      }
      mappedCriterionIds.add(mapping.taskLocalCriterionId);
    }
    for (const criterionId of criteriaIds) {
      if (!mappedCriterionIds.has(criterionId)) {
        issues.push({
          code: "unmapped_criterion",
          taskId: id,
          message: `Task ${id}'s acceptance criterion ${criterionId} has no requirement mapping.`,
        });
      }
    }
  }

  return fail(issues);
}

export function assertExecutionTaskContract(task: ExecutionTaskContract): void {
  assertValid(validateExecutionTaskContract(task), `Task contract ${task && (task as { id?: string }).id}`);
}

export type TaskGraphCycleIssue = { readonly code: "dependency_cycle"; readonly cycle: readonly string[]; readonly message: string };

/**
 * Acyclic dependency check over the full task-contract graph (T1's own
 * layer, distinct from task-graph.ts's runtime status graph). Never throws —
 * a task with a malformed/missing `dependencies` array is treated as having
 * none, and is separately flagged by validateExecutionTaskContract.
 */
export function validateTaskContractGraph(tasks: readonly ExecutionTaskContract[]): PlanningValidation {
  if (!Array.isArray(tasks)) {
    return fail([{ code: "invalid_task_list", message: "Task contract graph requires an array of tasks." }]);
  }
  const issues: PlanningIssue[] = [];
  const validTasks = tasks.filter(isObj) as ExecutionTaskContract[];
  const ids = new Set(validTasks.map((task) => task.id));
  const dupes = validTasks.map((task) => task.id).filter((id, index, array) => array.indexOf(id) !== index);
  for (const id of unique(dupes)) {
    issues.push({ code: "duplicate_task_id", taskId: id, message: `Duplicate task id ${id}.` });
  }
  for (const task of validTasks) {
    const dependencies = isNonBlankStringArray(task.dependencies) ? task.dependencies : [];
    for (const dependencyId of dependencies) {
      if (!ids.has(dependencyId)) {
        issues.push({ code: "missing_task_dependency", taskId: task.id, message: `Task ${task.id} depends on unknown task ${dependencyId}.` });
      }
    }
  }
  const byId = new Map(validTasks.map((task) => [task.id, task]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  function visit(taskId: string): void {
    if (state.get(taskId) === "done") return;
    if (state.get(taskId) === "visiting") {
      const cycleStart = stack.indexOf(taskId);
      const cycle = [...stack.slice(cycleStart), taskId];
      issues.push({ code: "dependency_cycle", taskId, message: `Dependency cycle: ${cycle.join(" -> ")}.` });
      return;
    }
    const task = byId.get(taskId);
    if (!task) return;
    state.set(taskId, "visiting");
    stack.push(taskId);
    const dependencies = isNonBlankStringArray(task.dependencies) ? task.dependencies : [];
    for (const dependencyId of dependencies) visit(dependencyId);
    stack.pop();
    state.set(taskId, "done");
  }
  for (const task of validTasks) visit(task.id);

  return fail(issues);
}

/**
 * I3: requirement.contributingTaskIds and task.requirementIds must be
 * mutually consistent — a requirement claiming a task the task does not
 * claim back (or vice versa) is a broken bidirectional trace.
 */
export function validateRequirementTaskLinkSymmetry(
  requirements: readonly SourceRequirement[],
  tasks: readonly ExecutionTaskContract[],
): PlanningValidation {
  if (!Array.isArray(requirements) || !Array.isArray(tasks)) {
    return fail([{ code: "invalid_input", message: "validateRequirementTaskLinkSymmetry requires requirements and tasks arrays." }]);
  }
  const issues: PlanningIssue[] = [];
  const requirementById = new Map(requirements.filter(isObj).map((r) => [r.id, r]));
  const taskById = new Map(tasks.filter(isObj).map((t) => [t.id, t]));
  for (const requirement of requirements.filter(isObj)) {
    for (const taskId of isNonBlankStringArray(requirement.contributingTaskIds) ? requirement.contributingTaskIds : []) {
      const task = taskById.get(taskId);
      if (task && !(isNonBlankStringArray(task.requirementIds) && task.requirementIds.includes(requirement.id))) {
        issues.push({
          code: "asymmetric_requirement_task_link",
          requirementId: requirement.id,
          taskId,
          message: `Requirement ${requirement.id} claims task ${taskId} as contributing, but task ${taskId} does not claim requirement ${requirement.id} in its requirementIds.`,
        });
      }
    }
  }
  for (const task of tasks.filter(isObj)) {
    for (const requirementId of isNonBlankStringArray(task.requirementIds) ? task.requirementIds : []) {
      const requirement = requirementById.get(requirementId);
      if (requirement && !(isNonBlankStringArray(requirement.contributingTaskIds) && requirement.contributingTaskIds.includes(task.id))) {
        issues.push({
          code: "asymmetric_requirement_task_link",
          requirementId,
          taskId: task.id,
          message: `Task ${task.id} claims requirement ${requirementId} in requirementIds, but requirement ${requirementId} does not list task ${task.id} as contributing.`,
        });
      }
    }
  }
  return fail(issues);
}

// ---------------------------------------------------------------------------
// ExecutionPlanRevision
// ---------------------------------------------------------------------------

/**
 * B4 / EP06 / source §2: every field a phase contract must define — id,
 * purpose, requirement ids, scope/exclusions, entry conditions, contributing
 * packets, exit criteria, required combined validation, and what its exit
 * gate unlocks.
 */
export interface ExecutionPlanPhase {
  readonly id: string;
  readonly purpose: string;
  readonly requirementIds: readonly string[];
  readonly scope: { readonly includes: readonly string[]; readonly excludes: readonly string[] };
  readonly entryConditions: readonly string[];
  readonly contributingTaskIds: readonly string[];
  readonly exitCriteria: readonly string[];
  readonly requiredCombinedValidation: readonly string[];
  /** What this phase's exit gate unlocks (other phase ids and/or free text). */
  readonly exitUnlocks: readonly string[];
}

/** B1: authorizes a requirement present in a prior revision but absent from this one. */
export interface RetiredRequirementRecord {
  readonly requirementId: string;
  readonly amendmentRef: string;
  readonly authorizedBy: string;
  readonly rationale: string;
  readonly decidedAt: string;
}

export interface ExecutionPlanRevision {
  readonly revisionId: string;
  /** The run this revision belongs to; binds CoverageReview.runId (B3). */
  readonly runId: string;
  readonly sourceManifestId: string;
  readonly sourceManifestDigest: string;
  readonly requirements: readonly SourceRequirement[];
  readonly tasks: readonly ExecutionTaskContract[];
  readonly phases: readonly ExecutionPlanPhase[];
  readonly workflowPolicyVersion: number;
  readonly planningDecisions: readonly { readonly id: string; readonly description: string; readonly decidedAt: string }[];
  readonly validationObligations: readonly string[];
  readonly coverageReviewId?: string;
  readonly repairBudgetLineageId?: string;
  /** B1: sections no requirement references, explicitly authorized as non-normative. */
  readonly nonNormativeSections?: readonly SourceSectionDisposition[];
  /** B1: requirements present in a prior revision but authorized-removed from this one. */
  readonly retiredRequirementIds?: readonly RetiredRequirementRecord[];
  /** Binds the complete snapshot; recomputed via computeExecutionPlanRevisionDigest. */
  readonly digest: string;
  readonly createdAt: string;
}

export type ExecutionPlanRevisionWithoutDigest = Omit<ExecutionPlanRevision, "digest">;

export function computeExecutionPlanRevisionDigest(revision: ExecutionPlanRevisionWithoutDigest): string {
  return computeDigest(revision);
}

export function buildExecutionPlanRevision(
  revision: ExecutionPlanRevisionWithoutDigest,
): ExecutionPlanRevision {
  return { ...revision, digest: computeExecutionPlanRevisionDigest(revision) };
}

export function validateExecutionPlanRevision(
  revision: ExecutionPlanRevision,
  manifest: ApprovedSourceManifest,
  amendmentHistory: AmendmentHistory = [],
): PlanningValidation {
  if (!isObj(revision)) {
    return fail([{ code: "invalid_revision", message: "Execution plan revision must be an object." }]);
  }
  const issues: PlanningIssue[] = [];

  if (!nonEmpty(revision.runId)) {
    issues.push({ code: "missing_run_ref", message: "Plan revision requires a runId." });
  }

  // B2: the manifest itself must prove complete coverage before anything
  // downstream trusts it (dropped last section, endByte past EOF, uncovered
  // trailing bytes are all rejected here). validateApprovedSourceManifest
  // never throws on a malformed/null manifest.
  const manifestValidation = validateApprovedSourceManifest(manifest);
  issues.push(
    ...manifestValidation.issues.map((issue) => ({
      code: `source_manifest_${issue.code}`,
      message: `Source manifest is not provably complete: ${issue.message}`,
    })),
  );
  if (!isObj(manifest)) {
    // Nothing further can be safely cross-checked against the manifest.
    return fail(issues);
  }

  if (revision.sourceManifestId !== manifest.manifestId) {
    issues.push({ code: "unknown_source_manifest", message: `Plan revision references manifest ${revision.sourceManifestId}, not the supplied ${manifest.manifestId}.` });
  }
  if (revision.sourceManifestDigest !== manifest.artifactDigest) {
    issues.push({
      code: "source_digest_changed",
      message: `Plan revision's recorded source digest (${revision.sourceManifestDigest}) no longer matches the source manifest's actual digest (${manifest.artifactDigest}) — the plan revision is invalidated.`,
    });
  }
  const { digest: _digest, ...withoutDigest } = revision;
  const recomputed = computeExecutionPlanRevisionDigest(withoutDigest);
  if (recomputed !== revision.digest) {
    issues.push({ code: "digest_mismatch", message: `Plan revision digest does not match its own content — mutated without a new binding digest.` });
  }

  const safePhases = Array.isArray(revision.phases) ? revision.phases : [];
  const safeRequirements = Array.isArray(revision.requirements) ? revision.requirements : [];
  const safeTasks = Array.isArray(revision.tasks) ? revision.tasks : [];
  const phaseIds = safePhases.filter(isObj).map((phase) => (phase as ExecutionPlanPhase).id);
  if (new Set(phaseIds).size !== phaseIds.length) {
    issues.push({ code: "duplicate_phase_id", message: "Plan revision contains duplicate phase ids." });
  }
  const requirementIdSet = new Set(safeRequirements.filter(isObj).map((requirement) => requirement.id));
  const taskIdSet = new Set(safeTasks.filter(isObj).map((task) => task.id));
  for (const phase of safePhases) {
    // B4: every field EP06/source §2 require, validated strictly, with
    // contributing packets and requirement ids resolved against the revision.
    if (
      !isObj(phase) ||
      !nonEmpty((phase as ExecutionPlanPhase).id) ||
      !nonEmpty((phase as ExecutionPlanPhase).purpose) ||
      !isNonBlankStringArray((phase as ExecutionPlanPhase).requirementIds) ||
      (phase as ExecutionPlanPhase).requirementIds.length === 0 ||
      !isObj((phase as ExecutionPlanPhase).scope) ||
      !isNonBlankStringArray((phase as ExecutionPlanPhase).scope.includes) ||
      !isNonBlankStringArray((phase as ExecutionPlanPhase).scope.excludes) ||
      !isNonBlankStringArray((phase as ExecutionPlanPhase).entryConditions) ||
      (phase as ExecutionPlanPhase).entryConditions.length === 0 ||
      !isNonBlankStringArray((phase as ExecutionPlanPhase).contributingTaskIds) ||
      (phase as ExecutionPlanPhase).contributingTaskIds.length === 0 ||
      !isNonBlankStringArray((phase as ExecutionPlanPhase).exitCriteria) ||
      (phase as ExecutionPlanPhase).exitCriteria.length === 0 ||
      !isNonBlankStringArray((phase as ExecutionPlanPhase).requiredCombinedValidation) ||
      (phase as ExecutionPlanPhase).requiredCombinedValidation.length === 0 ||
      !isNonBlankStringArray((phase as ExecutionPlanPhase).exitUnlocks) ||
      (phase as ExecutionPlanPhase).exitUnlocks.length === 0
    ) {
      issues.push({
        code: "incomplete_phase_contract",
        phaseId: isObj(phase) ? (phase as ExecutionPlanPhase).id : undefined,
        message: `Phase ${isObj(phase) ? (phase as ExecutionPlanPhase).id : "?"} is missing a required EP06 field (purpose/requirementIds/scope/entryConditions/contributingTaskIds/exitCriteria/requiredCombinedValidation/exitUnlocks).`,
      });
      continue;
    }
    const typedPhase = phase as ExecutionPlanPhase;
    for (const requirementId of typedPhase.requirementIds) {
      if (!requirementIdSet.has(requirementId)) {
        issues.push({ code: "unknown_requirement_ref", phaseId: typedPhase.id, message: `Phase ${typedPhase.id} references unknown requirement ${requirementId}.` });
      }
    }
    for (const taskId of typedPhase.contributingTaskIds) {
      if (!taskIdSet.has(taskId)) {
        issues.push({ code: "unknown_task_ref", phaseId: typedPhase.id, taskId, message: `Phase ${typedPhase.id} references unknown contributing task ${taskId}.` });
      }
    }
    // NEW-3 (EP03): a phase's requirementIds/contributingTaskIds must equal
    // — not merely resolve to a subset of — the requirements/tasks whose
    // accountablePhaseId actually names this phase. Otherwise a phase could
    // list a requirement/task it does not own, reintroducing an ambiguous
    // second ownership claim.
    const expectedRequirementIds = new Set(
      safeRequirements.filter(isObj).filter((r) => r.accountablePhaseId === typedPhase.id).map((r) => r.id),
    );
    const declaredRequirementIds = new Set(typedPhase.requirementIds);
    if (
      expectedRequirementIds.size !== declaredRequirementIds.size ||
      [...expectedRequirementIds].some((rid) => !declaredRequirementIds.has(rid))
    ) {
      issues.push({
        code: "phase_requirement_ownership_mismatch",
        phaseId: typedPhase.id,
        message: `Phase ${typedPhase.id}'s requirementIds do not exactly match the requirements whose accountablePhaseId is ${typedPhase.id}.`,
      });
    }
    const expectedTaskIds = new Set(
      safeTasks.filter(isObj).filter((t) => t.accountablePhaseId === typedPhase.id).map((t) => t.id),
    );
    const declaredTaskIds = new Set(typedPhase.contributingTaskIds);
    if (
      expectedTaskIds.size !== declaredTaskIds.size ||
      [...expectedTaskIds].some((tid) => !declaredTaskIds.has(tid))
    ) {
      issues.push({
        code: "phase_task_ownership_mismatch",
        phaseId: typedPhase.id,
        message: `Phase ${typedPhase.id}'s contributingTaskIds do not exactly match the tasks whose accountablePhaseId is ${typedPhase.id}.`,
      });
    }
  }

  const ledgerValidation = validateRequirementLedger(safeRequirements, manifest, phaseIds, revision.nonNormativeSections ?? [], amendmentHistory);
  issues.push(...ledgerValidation.issues);

  for (const task of safeTasks) {
    issues.push(...validateExecutionTaskContract(task).issues);
    if (!isObj(task)) continue;
    if (!phaseIds.includes(task.accountablePhaseId)) {
      issues.push({ code: "unknown_phase_ref", taskId: task.id, message: `Task ${task.id} references unknown phase ${task.accountablePhaseId}.` });
    }
    for (const requirementId of isNonBlankStringArray(task.requirementIds) ? task.requirementIds : []) {
      if (!requirementIdSet.has(requirementId)) {
        issues.push({ code: "unknown_requirement_ref", taskId: task.id, message: `Task ${task.id} references unknown requirement ${requirementId}.` });
      }
    }
    // I4: an investigation's dependent-unlock task ids must resolve against
    // the actual revision, not just be present syntactically.
    if (task.investigation !== undefined && isObj(task.investigation)) {
      const unlockIds = isNonBlankStringArray(task.investigation.dependentUnlockTaskIds) ? task.investigation.dependentUnlockTaskIds : [];
      for (const unlockId of unlockIds) {
        if (!taskIdSet.has(unlockId)) {
          issues.push({ code: "unknown_task_ref", taskId: task.id, message: `Investigation task ${task.id}'s dependent unlock ${unlockId} does not resolve to a task in this revision.` });
        }
      }
    }
  }
  issues.push(...validateTaskContractGraph(safeTasks).issues);

  const taskStatuses = new Map(safeTasks.filter(isObj).map((task) => [task.id, "planned"]));
  issues.push(...validateRequirementTaskCoverage(safeRequirements, safeTasks, taskStatuses).issues);
  issues.push(...validateRequirementTaskLinkSymmetry(safeRequirements, safeTasks).issues);

  if (!Number.isSafeInteger(revision.workflowPolicyVersion) || revision.workflowPolicyVersion < 1) {
    issues.push({ code: "invalid_workflow_policy_version", message: "Plan revision workflowPolicyVersion must be a positive integer." });
  }

  return fail(issues);
}

/**
 * B1 (revision-to-revision guard): a requirement id present in the prior
 * revision and absent from the current one needs an authorized removal
 * record — a requirement cannot simply vanish across revisions, even if its
 * section happens to still be covered by another surviving requirement.
 */
export function validateRequirementRemovalAgainstPrior(
  current: ExecutionPlanRevision,
  prior: ExecutionPlanRevision,
  manifest: ApprovedSourceManifest,
  amendmentHistory: AmendmentHistory = [],
): PlanningValidation {
  if (!isObj(current) || !isObj(prior) || !Array.isArray(current.requirements) || !Array.isArray(prior.requirements)) {
    return fail([{ code: "invalid_input", message: "validateRequirementRemovalAgainstPrior requires current and prior revisions with requirements arrays." }]);
  }
  const issues: PlanningIssue[] = [];
  const currentIds = new Set(current.requirements.filter(isObj).map((r) => r.id));
  const retired = new Map((current.retiredRequirementIds ?? []).filter(isObj).map((r) => [(r as RetiredRequirementRecord).requirementId, r as RetiredRequirementRecord]));
  for (const requirement of prior.requirements.filter(isObj)) {
    if (currentIds.has(requirement.id)) continue;
    const record = retired.get(requirement.id);
    if (
      !record ||
      !nonEmpty(record.amendmentRef) ||
      !nonEmpty(record.authorizedBy) ||
      !nonEmpty(record.rationale) ||
      !isValidTimestamp(record.decidedAt)
    ) {
      issues.push({
        code: "unauthorized_requirement_removal",
        requirementId: requirement.id,
        message: `Requirement ${requirement.id} was present in the prior revision and is missing now without an authorized removal record (retiredRequirementIds).`,
      });
    } else if (isObj(manifest) && !manifestResolvesAmendmentRef(manifest, record.amendmentRef, amendmentHistory)) {
      issues.push({
        code: "unresolved_amendment_ref",
        requirementId: requirement.id,
        message: `Requirement ${requirement.id}'s removal record cites amendmentRef ${record.amendmentRef}, which does not resolve against the manifest's amendment chain.`,
      });
    } else if (amendmentHistory.length > 0 || manifest.amendment?.recordedImpact !== undefined) {
      issues.push(...validateRequirementAmendmentScope(
        requirement.id,
        isNonBlankStringArray(requirement.reference?.sectionIds) ? requirement.reference.sectionIds : [],
        record.amendmentRef,
        manifest,
        amendmentHistory,
      ));
    }
  }
  return fail(issues);
}

export function assertExecutionPlanRevision(
  revision: ExecutionPlanRevision,
  manifest: ApprovedSourceManifest,
  amendmentHistory: AmendmentHistory = [],
): void {
  assertValid(validateExecutionPlanRevision(revision, manifest, amendmentHistory), "Execution plan revision");
}

// ---------------------------------------------------------------------------
// ValidationIntent / ValidationObservation
// ---------------------------------------------------------------------------

export type ValidationScope = "targeted" | "affected" | "final";

export interface ValidationIntent {
  readonly id: string;
  readonly acceptanceConditionIds: readonly string[];
  readonly intendedBehavior: string;
  readonly assertions: readonly string[];
  readonly scope: ValidationScope;
  readonly scopeReason: string;
}

export function validateValidationIntent(intent: ValidationIntent): PlanningValidation {
  if (!isObj(intent)) {
    return fail([{ code: "invalid_input", message: "ValidationIntent must be an object." }]);
  }
  const issues: PlanningIssue[] = [];
  if (!isStringArray(intent.acceptanceConditionIds) || intent.acceptanceConditionIds.length === 0) {
    issues.push({ code: "missing_acceptance_condition_refs", message: "ValidationIntent requires at least one acceptanceConditionId." });
  }
  if (!nonEmpty(intent.intendedBehavior)) issues.push({ code: "missing_intended_behavior", message: "ValidationIntent requires intendedBehavior." });
  if (!isStringArray(intent.assertions) || intent.assertions.length === 0) {
    issues.push({ code: "missing_assertions", message: "ValidationIntent requires at least one assertion." });
  }
  if (!["targeted", "affected", "final"].includes(intent.scope)) {
    issues.push({ code: "invalid_scope", message: "ValidationIntent scope must be targeted, affected, or final." });
  }
  if (!nonEmpty(intent.scopeReason)) issues.push({ code: "missing_scope_reason", message: "ValidationIntent requires a scopeReason." });
  return fail(issues);
}

export type ValidationOutcome = "passed" | "failed" | "unknown";

export interface ValidationObservationCounts {
  readonly selected: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
}

export interface ValidationObservation {
  readonly id: string;
  readonly intentId: string;
  readonly evidenceId: string;
  readonly command: string;
  readonly method: string;
  readonly snapshotRevision: string;
  readonly dirty: boolean;
  readonly dirtySummary?: string;
  /** The actual observed exit code (or null for a non-process method, e.g. a browser assertion). */
  readonly exitCode: number | null;
  readonly environmentFingerprint: string;
  readonly configFingerprint: string;
  readonly dependencyFingerprint: string;
  readonly outcome: ValidationOutcome;
  readonly counts: ValidationObservationCounts;
  readonly selectedAssertionIds?: readonly string[];
  readonly skippedAssertionIds?: readonly string[];
}

/**
 * Rejects exit-0-with-nothing-selected, unreadable/unknown reports masquerading
 * as green, and dirty snapshots without a disclosed diff summary. Unknown
 * selection results are never inferred as passing.
 */
export function validateValidationObservation(observation: ValidationObservation): PlanningValidation {
  if (!isObj(observation) || !isObj(observation.counts)) {
    return fail([{ code: "invalid_input", message: "ValidationObservation must be an object with a counts object." }]);
  }
  const issues: PlanningIssue[] = [];
  if (!nonEmpty(observation.intentId)) issues.push({ code: "missing_intent_ref", message: "ValidationObservation requires an intentId." });
  if (!nonEmpty(observation.evidenceId)) issues.push({ code: "missing_evidence_ref", message: "ValidationObservation requires an immutable evidenceId." });
  if (!nonEmpty(observation.command) || !nonEmpty(observation.method)) issues.push({ code: "missing_method", message: "ValidationObservation requires command and method." });
  if (!nonEmpty(observation.snapshotRevision)) issues.push({ code: "missing_snapshot_revision", message: "ValidationObservation requires a snapshotRevision." });
  if (observation.dirty && !nonEmpty(observation.dirtySummary)) {
    issues.push({ code: "undisclosed_dirty_snapshot", message: "A dirty snapshot requires a disclosed dirtySummary — an exact clean/dirty identity is required." });
  }
  if (!nonEmpty(observation.environmentFingerprint)) issues.push({ code: "missing_environment_fingerprint", message: "ValidationObservation requires an environmentFingerprint." });
  if (!nonEmpty(observation.configFingerprint)) issues.push({ code: "missing_config_fingerprint", message: "ValidationObservation requires a configFingerprint." });
  if (!nonEmpty(observation.dependencyFingerprint)) issues.push({ code: "missing_dependency_fingerprint", message: "ValidationObservation requires a dependencyFingerprint." });
  if (observation.exitCode !== null && !Number.isSafeInteger(observation.exitCode)) {
    issues.push({ code: "invalid_exit_code", message: "ValidationObservation exitCode must be an integer or null." });
  }
  if (observation.outcome === "passed" && observation.exitCode !== null && observation.exitCode !== 0) {
    issues.push({ code: "passed_with_nonzero_exit", message: "A passed outcome cannot cite a non-zero exit code." });
  }
  if (!["passed", "failed", "unknown"].includes(observation.outcome)) issues.push({ code: "invalid_outcome", message: "ValidationObservation outcome must be passed, failed, or unknown." });
  const counts = observation.counts;
  if (
    !Number.isSafeInteger(counts.selected) || counts.selected < 0 ||
    !Number.isSafeInteger(counts.passed) || counts.passed < 0 ||
    !Number.isSafeInteger(counts.failed) || counts.failed < 0 ||
    !Number.isSafeInteger(counts.skipped) || counts.skipped < 0
  ) {
    issues.push({ code: "invalid_counts", message: "ValidationObservation counts must be non-negative integers." });
  } else {
    if (observation.outcome === "passed" && (counts.selected === 0 || counts.failed > 0)) {
      issues.push({
        code: "invalid_passed_observation",
        message: "A passed outcome requires at least one selected assertion and zero failures — exit 0 with zero selection cannot be passed.",
      });
    }
    if (counts.passed + counts.failed + counts.skipped > counts.selected) {
      issues.push({ code: "inconsistent_counts", message: "ValidationObservation counts do not sum consistently against selected." });
    }
  }
  return fail(issues);
}

export function assertValidationObservation(observation: ValidationObservation): void {
  assertValid(validateValidationObservation(observation), `Validation observation ${observation.id}`);
}

// ---------------------------------------------------------------------------
// EvidenceApplicabilityDecision
// ---------------------------------------------------------------------------

/**
 * I8: a bare boolean cannot distinguish "not inspected" from "inspected and
 * found unaffected". Each dimension records whether it was actually
 * inspected, and — when inspected — the old and new identity strings impact
 * is mechanically derived from (never a reviewer's boolean say-so).
 */
export interface EvidenceApplicabilityDimensionObservation {
  readonly inspected: boolean;
  /** Required when inspected is true. */
  readonly oldIdentity?: string;
  readonly newIdentity?: string;
}

export interface EvidenceApplicabilityImpact {
  readonly dependency: EvidenceApplicabilityDimensionObservation;
  readonly contract: EvidenceApplicabilityDimensionObservation;
  readonly config: EvidenceApplicabilityDimensionObservation;
  readonly environment: EvidenceApplicabilityDimensionObservation;
}

export type EvidenceApplicabilityOutcome = "reusable" | "invalidated";

export interface EvidenceApplicabilityDecision {
  readonly id: string;
  readonly observationId: string;
  readonly oldSnapshotRevision: string;
  readonly newSnapshotRevision: string;
  readonly inspectedImpact: EvidenceApplicabilityImpact;
  readonly outcome: EvidenceApplicabilityOutcome;
  readonly rationale: string;
}

const EVIDENCE_APPLICABILITY_DIMENSIONS: readonly (keyof EvidenceApplicabilityImpact)[] = [
  "dependency",
  "contract",
  "config",
  "environment",
];

/**
 * Fail-closed mechanical derivation: not inspected, or inspected without
 * both identities recorded, counts as impacted (cannot be proven
 * unaffected). Only inspected-with-matching-identities counts as
 * mechanically unaffected.
 */
function dimensionMechanicallyImpacted(observation: EvidenceApplicabilityDimensionObservation): boolean {
  if (!observation.inspected) return true;
  if (!nonEmpty(observation.oldIdentity) || !nonEmpty(observation.newIdentity)) return true;
  return observation.oldIdentity !== observation.newIdentity;
}

/**
 * A model's blanket "unaffected" is insufficient: reuse requires the reviewer
 * to have actually inspected each impact dimension with recorded old/new
 * identities, and any mechanically-derived impact forces invalidated, not
 * reviewer discretion.
 */
export function validateEvidenceApplicabilityDecision(decision: EvidenceApplicabilityDecision): PlanningValidation {
  if (!isObj(decision)) {
    return fail([{ code: "invalid_input", message: "EvidenceApplicabilityDecision must be an object." }]);
  }
  const issues: PlanningIssue[] = [];
  if (!nonEmpty(decision.observationId)) issues.push({ code: "missing_observation_ref", message: "EvidenceApplicabilityDecision requires an observationId." });
  if (!nonEmpty(decision.oldSnapshotRevision) || !nonEmpty(decision.newSnapshotRevision)) {
    issues.push({ code: "missing_snapshots", message: "EvidenceApplicabilityDecision requires old and new snapshot identities." });
  }
  const impact = decision.inspectedImpact;
  let anyMalformedDimension = false;
  let anyImpacted = false;
  for (const dimension of EVIDENCE_APPLICABILITY_DIMENSIONS) {
    const observation = isObj(impact) ? (impact as unknown as Record<string, unknown>)[dimension] : undefined;
    if (!isObj(observation) || typeof (observation as EvidenceApplicabilityDimensionObservation).inspected !== "boolean") {
      anyMalformedDimension = true;
      issues.push({
        code: "missing_inspected_impact",
        message: `EvidenceApplicabilityDecision.inspectedImpact.${dimension} requires an "inspected" boolean (and old/new identities when inspected).`,
      });
      continue;
    }
    const typed = observation as EvidenceApplicabilityDimensionObservation;
    if (typed.inspected && (!nonEmpty(typed.oldIdentity) || !nonEmpty(typed.newIdentity))) {
      issues.push({
        code: "missing_dimension_identity",
        message: `EvidenceApplicabilityDecision.inspectedImpact.${dimension} was inspected but is missing oldIdentity/newIdentity.`,
      });
    }
    if (dimensionMechanicallyImpacted(typed)) anyImpacted = true;
  }
  if (!anyMalformedDimension && anyImpacted && decision.outcome !== "invalidated") {
    issues.push({ code: "blanket_unaffected_claim", message: "An inspected-or-unproven impact dimension exists, but outcome is not invalidated — a blanket unaffected claim." });
  }
  if (!nonEmpty(decision.rationale)) issues.push({ code: "missing_rationale", message: "EvidenceApplicabilityDecision requires a rationale." });
  if (!["reusable", "invalidated"].includes(decision.outcome)) issues.push({ code: "invalid_outcome", message: "EvidenceApplicabilityDecision outcome must be reusable or invalidated." });
  return fail(issues);
}

export function assertEvidenceApplicabilityDecision(decision: EvidenceApplicabilityDecision): void {
  assertValid(validateEvidenceApplicabilityDecision(decision), `Evidence applicability decision ${decision.id}`);
}

// ---------------------------------------------------------------------------
// CoverageReview / DeliverableReview (OA-1..OA-3)
// ---------------------------------------------------------------------------

export const COVERAGE_VERDICT_VALUES = ["covered", "weakened", "missing"] as const;
export type CoverageVerdictValue = (typeof COVERAGE_VERDICT_VALUES)[number];

/** OA-2: four additive finding categories, on top of the existing eight plan-critique categories. */
export const PLANNING_ADDITIVE_FINDING_CATEGORIES = [
  "missing_coverage",
  "weakened_obligation",
  "scope_creep",
  "unverified_claim",
] as const;
export type PlanningAdditiveFindingCategory = (typeof PLANNING_ADDITIVE_FINDING_CATEGORIES)[number];

export type PlanningFindingCategory = PlanCritiqueCategory | PlanningAdditiveFindingCategory;
export const PLANNING_FINDING_CATEGORIES: readonly PlanningFindingCategory[] = [
  ...PLAN_CRITIQUE_CATEGORIES,
  ...PLANNING_ADDITIVE_FINDING_CATEGORIES,
];

// Verdict words and category words must be disjoint vocabularies (source spec OA-2).
for (const verdict of COVERAGE_VERDICT_VALUES) {
  if ((PLANNING_FINDING_CATEGORIES as readonly string[]).includes(verdict)) {
    throw new Error(`Internal error: verdict word "${verdict}" collides with a finding category.`);
  }
}

export interface DerivedObligation {
  readonly id: string;
  readonly requirementId?: string;
  readonly description: string;
  /** True only when the runtime actually stamped this before the plan/diff was provided (OA-1/OA-3). */
  readonly recordedBeforePlanOrDiffProvided: boolean;
  readonly recordedAt: string;
}

export interface CoverageObligationVerdict {
  readonly obligationId: string;
  readonly verdict: string;
  readonly severity: PlanCritiqueSeverity;
  readonly rationale: string;
  readonly evidenceRefs: readonly string[];
}

export type PlanningFindingResolution = "plan_reconciled" | "rejected" | "deferred";

/**
 * A corrected review references and resolves prior findings, per §3.
 * NEW-5: a finding cannot be cleared by a self-set flag alone — the
 * disposition must name the actual review or plan revision that resolved
 * it, so the resolution is itself traceable/auditable.
 */
export interface PlanningFindingDisposition {
  readonly resolution: PlanningFindingResolution;
  readonly rationale: string;
  readonly resolvedAt: string;
  /** The CoverageReview.id or DeliverableReview.id that resolved this finding. */
  readonly resolvedByReviewId?: string;
  /** The ExecutionPlanRevision.digest that resolved this finding, if resolved by a plan change rather than a review. */
  readonly resolvedInRevisionDigest?: string;
}

export interface PlanningFinding {
  readonly id: string;
  readonly category: string;
  readonly severity: PlanCritiqueSeverity;
  readonly requirementId?: string;
  readonly location?: string;
  readonly claim: string;
  readonly evidenceRefs: readonly string[];
  /** Present once the finding has been resolved by a later review/revision. */
  readonly disposition?: PlanningFindingDisposition;
}

function validateDerivedObligations(obligations: readonly DerivedObligation[]): PlanningIssue[] {
  const issues: PlanningIssue[] = [];
  if (!Array.isArray(obligations) || obligations.length === 0) {
    issues.push({ code: "no_derived_obligations", message: "Reviewer must durably record derived obligations." });
    return issues;
  }
  const seen = new Set<string>();
  for (const obligation of obligations) {
    if (
      !isObj(obligation) ||
      !nonEmpty(obligation.id) ||
      !nonEmpty(obligation.description) ||
      !isValidTimestamp(obligation.recordedAt)
    ) {
      issues.push({ code: "invalid_derived_obligation", message: "Derived obligation requires id, description, and a valid recordedAt timestamp." });
      continue;
    }
    if (seen.has(obligation.id)) issues.push({ code: "duplicate_obligation_id", message: `Duplicate derived obligation id ${obligation.id}.` });
    seen.add(obligation.id);
    if (obligation.recordedBeforePlanOrDiffProvided !== true) {
      issues.push({
        code: "obligation_not_recorded_before_plan",
        message: `Derived obligation ${obligation.id} was not recorded before the plan/diff was provided (record-before-verdict gate).`,
      });
    }
  }
  return issues;
}

function validateFindings(findings: readonly PlanningFinding[]): PlanningIssue[] {
  const issues: PlanningIssue[] = [];
  for (const finding of findings ?? []) {
    if (!isObj(finding) || !nonEmpty(finding.id) || !nonEmpty(finding.claim)) {
      issues.push({ code: "invalid_finding", message: "Finding requires id and claim." });
      continue;
    }
    if (!(PLANNING_FINDING_CATEGORIES as readonly string[]).includes(finding.category)) {
      issues.push({
        code: "invalid_finding_category",
        message: `Finding ${finding.id} category "${finding.category}" is not a valid finding category (or is a verdict word used as a category).`,
      });
    }
    if (finding.severity !== "blocking" && finding.severity !== "advisory") {
      issues.push({ code: "invalid_finding_severity", message: `Finding ${finding.id} has an invalid severity.` });
    }
    if (finding.disposition !== undefined) {
      const disposition = finding.disposition as PlanningFindingDisposition;
      if (
        !isObj(disposition) ||
        !["plan_reconciled", "rejected", "deferred"].includes(disposition.resolution) ||
        !nonEmpty(disposition.rationale) ||
        !isValidTimestamp(disposition.resolvedAt) ||
        (!nonEmpty(disposition.resolvedByReviewId) && !nonEmpty(disposition.resolvedInRevisionDigest))
      ) {
        issues.push({
          code: "invalid_finding_disposition",
          message: `Finding ${finding.id} has a malformed disposition (requires resolution/rationale/resolvedAt, and resolvedByReviewId or resolvedInRevisionDigest — a self-set flag alone is insufficient).`,
        });
      }
    }
  }
  return issues;
}

/**
 * True while a finding is blocking severity and not resolved (I6). NEW-5:
 * a resolution only counts when it is validly disposed AND names the
 * resolving review/revision — a malformed or unreferenced "resolved" flag
 * does not clear a blocking finding.
 */
function findingIsUnresolvedBlocking(finding: PlanningFinding): boolean {
  if (finding.severity !== "blocking") return false;
  const disposition = finding.disposition;
  if (!disposition || disposition.resolution !== "plan_reconciled") return true;
  if (!nonEmpty(disposition.rationale) || !isValidTimestamp(disposition.resolvedAt)) return true;
  if (!nonEmpty(disposition.resolvedByReviewId) && !nonEmpty(disposition.resolvedInRevisionDigest)) return true;
  return false;
}

export interface CoverageReview {
  readonly id: string;
  readonly runId: string;
  readonly reviewerRuntimeId: string;
  readonly independence: ReviewerIndependence;
  /** The complete original-source read index (ApprovedSourceManifest.manifestId). */
  readonly sourceReadManifestId: string;
  readonly planRevisionId: string;
  /** B3: the exact plan-revision digest this review evaluated — binds the review to that snapshot, not just its id. */
  readonly planRevisionDigest: string;
  readonly derivedObligations: readonly DerivedObligation[];
  readonly obligationVerdicts: readonly CoverageObligationVerdict[];
  readonly findings: readonly PlanningFinding[];
  /** Present only for a scoped correction/re-review of a prior CoverageReview. */
  readonly priorReviewId?: string;
  /** OA-10 #2: this review's own findings were recorded before it received the prior review's findings. */
  readonly correctionOwnViewRecordedFirst?: boolean;
  readonly recordedAt: string;
}

export function validateCoverageReview(review: CoverageReview): PlanningValidation {
  if (!isObj(review)) {
    return fail([{ code: "invalid_input", message: "CoverageReview must be an object." }]);
  }
  const issues: PlanningIssue[] = [];
  if (!nonEmpty(review.runId) || !nonEmpty(review.reviewerRuntimeId)) issues.push({ code: "missing_reviewer_identity", message: "CoverageReview requires runId and reviewerRuntimeId." });
  if (review.independence !== "distinct_model" && review.independence !== "fresh_context") {
    issues.push({ code: "invalid_independence", message: "CoverageReview independence must be distinct_model or fresh_context." });
  }
  if (!nonEmpty(review.sourceReadManifestId)) issues.push({ code: "missing_source_read_manifest", message: "CoverageReview requires the complete source-read manifest id." });
  if (!nonEmpty(review.planRevisionId)) issues.push({ code: "missing_plan_revision_ref", message: "CoverageReview requires a planRevisionId." });
  if (!nonEmpty(review.planRevisionDigest)) issues.push({ code: "missing_plan_revision_digest", message: "CoverageReview requires the exact planRevisionDigest it evaluated." });
  if (!isValidTimestamp(review.recordedAt)) issues.push({ code: "invalid_recorded_at", message: "CoverageReview requires a valid recordedAt timestamp." });

  issues.push(...validateDerivedObligations(review.derivedObligations));

  const obligationIds = new Set(
    (Array.isArray(review.derivedObligations) ? review.derivedObligations : [])
      .filter(isObj)
      .map((obligation) => obligation.id)
      .filter(nonEmpty),
  );
  const verdictObligationIds = new Set<string>();
  if (!Array.isArray(review.obligationVerdicts)) {
    issues.push({ code: "missing_obligation_verdicts", message: "CoverageReview requires an obligation verdict per derived obligation." });
  } else {
    for (const verdict of review.obligationVerdicts) {
      if (!isObj(verdict) || !nonEmpty(verdict.obligationId)) {
        issues.push({ code: "invalid_obligation_verdict", message: "Obligation verdict requires an obligationId." });
        continue;
      }
      if (!(COVERAGE_VERDICT_VALUES as readonly string[]).includes(verdict.verdict as string)) {
        issues.push({
          code: "invalid_verdict_value",
          message: `Obligation ${verdict.obligationId} has an invalid verdict "${verdict.verdict}" (or a finding category used as a verdict).`,
        });
      }
      if (!nonEmpty(verdict.rationale)) issues.push({ code: "missing_verdict_rationale", message: `Obligation ${verdict.obligationId} verdict requires a rationale.` });
      if (verdict.severity !== "blocking" && verdict.severity !== "advisory") {
        issues.push({ code: "invalid_verdict_severity", message: `Obligation ${verdict.obligationId} verdict has an invalid severity.` });
      }
      // M4: a verdict for an obligation id that was never derived is not a
      // legitimate coverage verdict — it did not go through the
      // record-before-verdict gate.
      if (!obligationIds.has(verdict.obligationId)) {
        issues.push({
          code: "verdict_for_undeclared_obligation",
          message: `Verdict cites obligation ${verdict.obligationId}, which was never recorded in derivedObligations.`,
        });
      }
      verdictObligationIds.add(verdict.obligationId);
    }
    for (const obligationId of obligationIds) {
      if (!verdictObligationIds.has(obligationId)) {
        issues.push({ code: "missing_obligation_verdict", message: `Derived obligation ${obligationId} has no recorded verdict.` });
      }
    }
  }

  issues.push(...validateFindings(review.findings));

  if (review.priorReviewId !== undefined && review.correctionOwnViewRecordedFirst !== true) {
    issues.push({
      code: "correction_missing_own_view_first",
      message: "A scoped re-review of a prior CoverageReview must record its own view before receiving the prior findings (OA-10 #2).",
    });
  }

  return fail(issues);
}

export function assertCoverageReview(review: CoverageReview): void {
  assertValid(validateCoverageReview(review), `Coverage review ${review.id}`);
}

/** True while any obligation has a blocking missing/weakened verdict (EP44). */
export function coverageReviewHoldsReadiness(review: CoverageReview | null | undefined): boolean {
  if (review === null || review === undefined || typeof review !== "object" || !Array.isArray(review.obligationVerdicts)) return true;
  return review.obligationVerdicts.some(
    (verdict) =>
      verdict.severity === "blocking" &&
      (verdict.verdict === "missing" || verdict.verdict === "weakened"),
  );
}

/**
 * B3: binds a CoverageReview to the exact plan revision it evaluated (id AND
 * digest — a plan mutation that keeps the same revisionId but changes
 * content must still invalidate the review), the exact source manifest read,
 * the run it belongs to, and — if the revision names a coverageReviewId —
 * that it is this review. A stale/foreign review can never satisfy
 * readiness.
 */
export function validateCoverageReviewBinding(
  review: CoverageReview,
  revision: ExecutionPlanRevision,
  manifest: ApprovedSourceManifest,
): PlanningValidation {
  if (!isObj(review) || !isObj(revision) || !isObj(manifest)) {
    return fail([{ code: "invalid_input", message: "validateCoverageReviewBinding requires review, revision, and manifest objects." }]);
  }
  const issues: PlanningIssue[] = [];
  if (review.planRevisionId !== revision.revisionId) {
    issues.push({ code: "stale_coverage_review", message: `Coverage review ${review.id} references plan revision ${review.planRevisionId}, not the current ${revision.revisionId}.` });
  }
  if (review.planRevisionDigest !== revision.digest) {
    issues.push({ code: "stale_coverage_review", message: `Coverage review ${review.id}'s evaluated digest no longer matches the current plan revision's digest — the plan changed since review.` });
  }
  if (review.sourceReadManifestId !== manifest.manifestId) {
    issues.push({ code: "coverage_review_wrong_source", message: `Coverage review ${review.id} read source manifest ${review.sourceReadManifestId}, not the current ${manifest.manifestId}.` });
  }
  if (review.runId !== revision.runId) {
    issues.push({ code: "coverage_review_wrong_run", message: `Coverage review ${review.id} belongs to run ${review.runId}, not the current run ${revision.runId}.` });
  }
  if (revision.coverageReviewId !== undefined && revision.coverageReviewId !== review.id) {
    issues.push({ code: "coverage_review_id_mismatch", message: `Plan revision names coverageReviewId ${revision.coverageReviewId}, not the supplied review ${review.id}.` });
  }
  return fail(issues);
}

export interface DeliverableReviewClaimVerdict {
  readonly claim: string;
  readonly status: "verified" | "unverified";
}

export type DeliverableReviewTier = "low" | "medium" | "high";

export interface DeliverableReview {
  readonly id: string;
  readonly taskId: string;
  readonly reviewerRuntimeId: string;
  readonly independence: ReviewerIndependence;
  readonly changeSetOrDiffRef: string;
  readonly sourceCriteriaIds: readonly string[];
  /** OA-3: findings were formed from criteria + diff before the worker's report/self-assessment was seen. */
  readonly findingsRecordedBeforeReport: boolean;
  readonly findings: readonly PlanningFinding[];
  readonly workerClaimVerdicts: readonly DeliverableReviewClaimVerdict[];
  readonly reviewTier?: DeliverableReviewTier;
  /** OA-10 #4: at high tier only, obligations derived before the diff was received. */
  readonly highTierObligationsRecordedBeforeDiff?: readonly DerivedObligation[];
  readonly priorReviewId?: string;
  readonly correctionOwnViewRecordedFirst?: boolean;
  readonly recordedAt: string;
}

export function validateDeliverableReview(review: DeliverableReview): PlanningValidation {
  if (!isObj(review)) {
    return fail([{ code: "invalid_input", message: "DeliverableReview must be an object." }]);
  }
  const issues: PlanningIssue[] = [];
  if (!nonEmpty(review.taskId) || !nonEmpty(review.reviewerRuntimeId)) issues.push({ code: "missing_reviewer_identity", message: "DeliverableReview requires taskId and reviewerRuntimeId." });
  if (review.independence !== "distinct_model" && review.independence !== "fresh_context") {
    issues.push({ code: "invalid_independence", message: "DeliverableReview independence must be distinct_model or fresh_context." });
  }
  if (!nonEmpty(review.changeSetOrDiffRef)) issues.push({ code: "missing_change_ref", message: "DeliverableReview requires the exact submitted revision/diff ref." });
  if (!isStringArray(review.sourceCriteriaIds) || review.sourceCriteriaIds.length === 0) {
    issues.push({ code: "missing_source_criteria", message: "DeliverableReview requires source criteria refs." });
  }
  if (!isValidTimestamp(review.recordedAt)) issues.push({ code: "invalid_recorded_at", message: "DeliverableReview requires a valid recordedAt timestamp." });
  if (review.findingsRecordedBeforeReport !== true) {
    issues.push({ code: "findings_not_recorded_before_report", message: "Deliverable review findings must be formed before the worker's report is seen (OA-3)." });
  }
  issues.push(...validateFindings(review.findings));
  if (!Array.isArray(review.workerClaimVerdicts)) {
    issues.push({ code: "missing_claim_verdicts", message: "DeliverableReview requires a verdict per worker claim." });
  } else {
    for (const verdict of review.workerClaimVerdicts) {
      if (!isObj(verdict) || !nonEmpty(verdict.claim) || (verdict.status !== "verified" && verdict.status !== "unverified")) {
        issues.push({ code: "invalid_claim_verdict", message: "Worker claim verdict requires claim text and verified/unverified status." });
      }
    }
  }
  if (review.reviewTier === "high") {
    const obligations = review.highTierObligationsRecordedBeforeDiff;
    if (!Array.isArray(obligations) || obligations.length === 0) {
      issues.push({ code: "high_tier_missing_obligations", message: "High-tier deliverable review requires obligations recorded before the diff (OA-10 #4)." });
    } else {
      issues.push(...validateDerivedObligations(obligations));
    }
  }
  if (review.priorReviewId !== undefined && review.correctionOwnViewRecordedFirst !== true) {
    issues.push({
      code: "correction_missing_own_view_first",
      message: "A fix re-review must record its own view before receiving the prior review's findings (OA-10 #2).",
    });
  }
  return fail(issues);
}

export function assertDeliverableReview(review: DeliverableReview): void {
  assertValid(validateDeliverableReview(review), `Deliverable review ${review.id}`);
}

// ---------------------------------------------------------------------------
// RepairApproachDecision
// ---------------------------------------------------------------------------

export type RepairApproachDecisionValue = "new_approach" | "repeat_rejected";

export interface RepairApproachDecision {
  readonly id: string;
  readonly issueId: string;
  readonly taskLineageIds: readonly string[];
  readonly priorFailedApproachIds: readonly string[];
  readonly priorEvidenceIds: readonly string[];
  readonly proposedApproachId: string;
  readonly decision: RepairApproachDecisionValue;
  readonly rationale: string;
  readonly newDiagnosticEvidenceIds: readonly string[];
  readonly decidedAt: string;
}

/**
 * The kernel rejects a repeated failed approach *authorized to proceed*
 * (decision "new_approach") without a new inspectable evidence reference. A
 * new label or resubmitted evidence id alone cannot pass —
 * newDiagnosticEvidenceIds must contain at least one id not already present
 * in priorEvidenceIds.
 *
 * M1: "repeat_rejected" is the Architect's OWN record that a proposed repeat
 * WAS rejected — it is the rejection itself, not a further proposal to
 * dispatch, so it is not gated by the new-evidence rule (there is nothing
 * left to authorize). It IS required to actually name a known prior failed
 * approach, since "rejecting a repeat" of something never attempted is
 * incoherent.
 */
export function validateRepairApproachDecision(decision: RepairApproachDecision): PlanningValidation {
  if (!isObj(decision)) {
    return fail([{ code: "invalid_input", message: "RepairApproachDecision must be an object." }]);
  }
  const issues: PlanningIssue[] = [];
  if (!nonEmpty(decision.issueId)) issues.push({ code: "missing_issue_ref", message: "RepairApproachDecision requires an issueId." });
  if (!isStringArray(decision.taskLineageIds) || decision.taskLineageIds.length === 0) {
    issues.push({ code: "missing_task_lineage", message: "RepairApproachDecision requires taskLineageIds." });
  }
  if (!isStringArray(decision.priorFailedApproachIds)) {
    issues.push({ code: "invalid_prior_failed_approaches", message: "RepairApproachDecision requires priorFailedApproachIds to be an array." });
  }
  if (!isStringArray(decision.priorEvidenceIds)) {
    issues.push({ code: "invalid_prior_evidence", message: "RepairApproachDecision requires priorEvidenceIds to be an array." });
  }
  if (!isStringArray(decision.newDiagnosticEvidenceIds)) {
    issues.push({ code: "invalid_new_diagnostic_evidence", message: "RepairApproachDecision requires newDiagnosticEvidenceIds to be an array." });
  }
  if (!nonEmpty(decision.proposedApproachId)) issues.push({ code: "missing_proposed_approach", message: "RepairApproachDecision requires a proposedApproachId." });
  if (!nonEmpty(decision.rationale)) issues.push({ code: "missing_rationale", message: "RepairApproachDecision requires a rationale." });
  if (decision.decision !== "new_approach" && decision.decision !== "repeat_rejected") {
    issues.push({ code: "invalid_decision", message: "RepairApproachDecision decision must be new_approach or repeat_rejected." });
  }

  const priorFailed = new Set(isStringArray(decision.priorFailedApproachIds) ? decision.priorFailedApproachIds : []);
  const priorEvidence = new Set(isStringArray(decision.priorEvidenceIds) ? decision.priorEvidenceIds : []);

  if (decision.decision === "repeat_rejected") {
    if (!priorFailed.has(decision.proposedApproachId)) {
      issues.push({
        code: "repeat_rejected_not_a_known_repeat",
        message: `A repeat_rejected record must name a proposedApproachId already present in priorFailedApproachIds; ${decision.proposedApproachId} is not.`,
      });
    }
    return fail(issues);
  }

  const isRepeat = priorFailed.has(decision.proposedApproachId);
  if (isRepeat) {
    const newEvidence = (isStringArray(decision.newDiagnosticEvidenceIds) ? decision.newDiagnosticEvidenceIds : []).filter((id) => !priorEvidence.has(id));
    if (newEvidence.length === 0) {
      issues.push({
        code: "repeated_approach_without_new_evidence",
        message: `Approach ${decision.proposedApproachId} repeats a prior failed approach without any inspectable evidence new to that failed approach's diagnostic set.`,
      });
    }
  }

  return fail(issues);
}

export function assertRepairApproachDecision(decision: RepairApproachDecision): void {
  assertValid(validateRepairApproachDecision(decision), `Repair approach decision ${decision.id}`);
}

// ---------------------------------------------------------------------------
// TaskAcceptance / PhaseAcceptance
// ---------------------------------------------------------------------------

export interface RequiredCheckRef {
  readonly kind: string;
  readonly refId: string;
  readonly outcome: "passed" | "reused" | "pending";
}

export type AcceptanceStatus = "pending" | "accepted" | "reopened";

export interface TaskAcceptance {
  readonly taskId: string;
  readonly requiredChecks: readonly RequiredCheckRef[];
  readonly reviewId: string;
  readonly integrationCheckIds: readonly string[];
  readonly status: AcceptanceStatus;
  readonly acceptedAt?: string;
}

export function validateTaskAcceptance(acceptance: TaskAcceptance): PlanningValidation {
  if (!isObj(acceptance)) {
    return fail([{ code: "invalid_input", message: "TaskAcceptance must be an object." }]);
  }
  const issues: PlanningIssue[] = [];
  if (!nonEmpty(acceptance.taskId)) issues.push({ code: "missing_task_ref", message: "TaskAcceptance requires a taskId." });
  if (!Array.isArray(acceptance.requiredChecks) || acceptance.requiredChecks.length === 0) {
    issues.push({ code: "missing_required_checks", taskId: acceptance.taskId, message: `TaskAcceptance ${acceptance.taskId} requires at least one required check reference.` });
  } else {
    for (const check of acceptance.requiredChecks) {
      if (!isObj(check) || !nonEmpty((check as RequiredCheckRef).kind) || !nonEmpty((check as RequiredCheckRef).refId)) {
        issues.push({ code: "invalid_required_check", taskId: acceptance.taskId, message: `TaskAcceptance ${acceptance.taskId} has a malformed required check reference.` });
      }
    }
  }
  if (acceptance.status === "accepted") {
    if (!nonEmpty(acceptance.reviewId)) {
      issues.push({ code: "missing_review_ref", taskId: acceptance.taskId, message: `Accepted task ${acceptance.taskId} requires a bound review reference — a submission is not acceptance.` });
    }
    if (!Array.isArray(acceptance.integrationCheckIds) || acceptance.integrationCheckIds.length === 0) {
      issues.push({ code: "missing_integration_checks", taskId: acceptance.taskId, message: `Accepted task ${acceptance.taskId} requires integration checks.` });
    }
    if (
      Array.isArray(acceptance.requiredChecks) &&
      acceptance.requiredChecks.some((check) => isObj(check) && (check as RequiredCheckRef).outcome === "pending")
    ) {
      issues.push({ code: "pending_required_check", taskId: acceptance.taskId, message: `Task ${acceptance.taskId} cannot be accepted with a pending required check.` });
    }
    if (!nonEmpty(acceptance.acceptedAt)) {
      issues.push({ code: "missing_accepted_at", taskId: acceptance.taskId, message: `Accepted task ${acceptance.taskId} requires acceptedAt.` });
    }
  }
  return fail(issues);
}

export function assertTaskAcceptance(acceptance: TaskAcceptance): void {
  assertValid(validateTaskAcceptance(acceptance), `Task acceptance ${acceptance.taskId}`);
}

export interface PhaseAcceptance {
  readonly phaseId: string;
  readonly requirementIds: readonly string[];
  readonly taskAcceptanceRefs: readonly string[];
  readonly status: AcceptanceStatus;
}

/**
 * Phase acceptance requires every owned, applicable requirement to have
 * either an authorized not_applicable disposition, or EVERY contributing
 * task — not just any one of them — bound to a valid, accepted
 * TaskAcceptance record (validated via validateTaskAcceptance, not merely
 * trusted by status). `requirementIds`/`taskAcceptanceRefs` are cross-checked
 * against the phase's actual owned requirements/contributing tasks, so they
 * cannot silently diverge from the ledger. Intermediate states are never
 * completion verdicts.
 */
export function validatePhaseAcceptance(
  phaseAcceptance: PhaseAcceptance,
  requirements: readonly SourceRequirement[],
  taskAcceptances: ReadonlyMap<string, TaskAcceptance>,
  manifest: ApprovedSourceManifest,
  amendmentHistory: AmendmentHistory = [],
): PlanningValidation {
  if (!isObj(phaseAcceptance) || !Array.isArray(requirements) || !(taskAcceptances instanceof Map) || !isObj(manifest)) {
    return fail([{ code: "invalid_input", message: "validatePhaseAcceptance requires a PhaseAcceptance object, a requirements array, a taskAcceptances map, and a manifest." }]);
  }
  const issues: PlanningIssue[] = [];
  if (!nonEmpty(phaseAcceptance.phaseId)) issues.push({ code: "missing_phase_ref", message: "PhaseAcceptance requires a phaseId." });
  if (!isStringArray(phaseAcceptance.requirementIds)) issues.push({ code: "invalid_requirement_refs", message: "PhaseAcceptance requires requirementIds." });
  if (!isStringArray(phaseAcceptance.taskAcceptanceRefs)) issues.push({ code: "invalid_task_acceptance_refs", message: "PhaseAcceptance requires taskAcceptanceRefs." });
  if (phaseAcceptance.status !== "accepted") return fail(issues);

  const owned = requirements.filter(isObj).filter((requirement) => requirement.accountablePhaseId === phaseAcceptance.phaseId);
  const ownedIds = new Set(owned.map((requirement) => requirement.id));
  const declaredRequirementIds = new Set(phaseAcceptance.requirementIds ?? []);
  if (ownedIds.size !== declaredRequirementIds.size || [...ownedIds].some((rid) => !declaredRequirementIds.has(rid))) {
    issues.push({ code: "requirement_refs_mismatch", phaseId: phaseAcceptance.phaseId, message: "PhaseAcceptance requirementIds do not match the phase's actual owned requirements." });
  }

  const referencedTaskIds = new Set<string>();
  for (const requirement of owned) {
    const applicability = isObj(requirement.applicability) ? requirement.applicability : undefined;
    if (applicability?.status === "not_applicable") {
      // NEW-6: reuse the ledger's full disposition authorization rule, not
      // a weaker "any truthy object" check.
      const dispositionIssues = validateNotApplicableDisposition(
        requirement.id,
        isNonBlankStringArray(requirement.reference?.sectionIds) ? requirement.reference.sectionIds : [],
        requirement.obligationKind,
        applicability.disposition,
        manifest,
        amendmentHistory,
      );
      issues.push(...dispositionIssues.map((issue) => ({ ...issue, phaseId: phaseAcceptance.phaseId })));
      continue;
    }
    if (applicability?.status === "conditional_pending") {
      issues.push({ code: "unresolved_conditional", phaseId: phaseAcceptance.phaseId, requirementId: requirement.id, message: `Requirement ${requirement.id} is still conditional_pending — phase cannot accept.` });
      continue;
    }
    const contributingTaskIds = isStringArray(requirement.contributingTaskIds) ? requirement.contributingTaskIds : [];
    if (contributingTaskIds.length === 0) {
      issues.push({ code: "unaccepted_requirement", phaseId: phaseAcceptance.phaseId, requirementId: requirement.id, message: `Requirement ${requirement.id} has no contributing tasks.` });
      continue;
    }
    let allAccepted = true;
    for (const taskId of contributingTaskIds) {
      referencedTaskIds.add(taskId);
      const acceptance = taskAcceptances.get(taskId);
      if (!acceptance || acceptance.status !== "accepted" || !validateTaskAcceptance(acceptance).valid) {
        allAccepted = false;
        issues.push({
          code: "unaccepted_contributing_task",
          phaseId: phaseAcceptance.phaseId,
          requirementId: requirement.id,
          taskId,
          message: `Requirement ${requirement.id}'s contributing task ${taskId} does not have a valid, accepted TaskAcceptance.`,
        });
      }
    }
    if (!allAccepted) {
      issues.push({ code: "unaccepted_requirement", phaseId: phaseAcceptance.phaseId, requirementId: requirement.id, message: `Requirement ${requirement.id} does not have every contributing task accepted.` });
    }
  }

  const declaredTaskRefs = new Set(phaseAcceptance.taskAcceptanceRefs ?? []);
  if (referencedTaskIds.size !== declaredTaskRefs.size || [...referencedTaskIds].some((tid) => !declaredTaskRefs.has(tid))) {
    issues.push({ code: "task_acceptance_refs_mismatch", phaseId: phaseAcceptance.phaseId, message: "PhaseAcceptance taskAcceptanceRefs do not match the phase's actual contributing tasks." });
  }

  return fail(issues);
}

export function assertPhaseAcceptance(
  phaseAcceptance: PhaseAcceptance,
  requirements: readonly SourceRequirement[],
  taskAcceptances: ReadonlyMap<string, TaskAcceptance>,
  manifest: ApprovedSourceManifest,
  amendmentHistory: AmendmentHistory = [],
): void {
  assertValid(validatePhaseAcceptance(phaseAcceptance, requirements, taskAcceptances, manifest, amendmentHistory), `Phase acceptance ${phaseAcceptance.phaseId}`);
}

// ---------------------------------------------------------------------------
// PlanningCheckpoint / AssignmentClaim
// ---------------------------------------------------------------------------

export interface PlanningCheckpoint {
  readonly id: string;
  readonly coveredSourceSectionIds: readonly string[];
  readonly completedPlanningContractIds: readonly string[];
  readonly remainingWork: readonly string[];
  readonly nextAction: string;
  readonly recordedAt: string;
}

export function validatePlanningCheckpoint(checkpoint: PlanningCheckpoint): PlanningValidation {
  if (!isObj(checkpoint)) {
    return fail([{ code: "invalid_input", message: "PlanningCheckpoint must be an object." }]);
  }
  const issues: PlanningIssue[] = [];
  if (!isStringArray(checkpoint.coveredSourceSectionIds)) issues.push({ code: "invalid_covered_sections", message: "PlanningCheckpoint requires coveredSourceSectionIds." });
  if (!isStringArray(checkpoint.completedPlanningContractIds)) issues.push({ code: "invalid_completed_contracts", message: "PlanningCheckpoint requires completedPlanningContractIds." });
  if (!isStringArray(checkpoint.remainingWork)) issues.push({ code: "invalid_remaining_work", message: "PlanningCheckpoint requires remainingWork." });
  if (!nonEmpty(checkpoint.nextAction)) issues.push({ code: "missing_next_action", message: "PlanningCheckpoint requires a nextAction." });
  if (!isValidTimestamp(checkpoint.recordedAt)) issues.push({ code: "missing_recorded_at", message: "PlanningCheckpoint requires a valid recordedAt timestamp." });
  return fail(issues);
}

export function assertPlanningCheckpoint(checkpoint: PlanningCheckpoint): void {
  assertValid(validatePlanningCheckpoint(checkpoint), `Planning checkpoint ${checkpoint.id}`);
}

export type AssignmentClaimState = "claimed" | "released" | "stopped_fenced";

export interface AssignmentClaim {
  readonly id: string;
  readonly packetId: string;
  readonly laneId: string;
  readonly workerOrSessionId: string;
  readonly acceptedBaseRevision: string;
  readonly branchOrWorktree: string;
  readonly writableSurfaces: readonly string[];
  readonly forbiddenSurfaces: readonly string[];
  readonly ownershipGeneration: number;
  readonly state: AssignmentClaimState;
  readonly writerStopEvidence?: string;
}

export function validateAssignmentClaim(claim: AssignmentClaim): PlanningValidation {
  if (!isObj(claim)) {
    return fail([{ code: "invalid_input", message: "AssignmentClaim must be an object." }]);
  }
  const issues: PlanningIssue[] = [];
  if (!nonEmpty(claim.packetId) || !nonEmpty(claim.laneId) || !nonEmpty(claim.workerOrSessionId)) {
    issues.push({ code: "missing_claim_identity", message: "AssignmentClaim requires packetId, laneId, and workerOrSessionId." });
  }
  if (!nonEmpty(claim.acceptedBaseRevision) || !nonEmpty(claim.branchOrWorktree)) {
    issues.push({ code: "missing_claim_base", message: "AssignmentClaim requires acceptedBaseRevision and branchOrWorktree." });
  }
  if (!isStringArray(claim.writableSurfaces) || !isStringArray(claim.forbiddenSurfaces)) {
    issues.push({ code: "missing_claim_surfaces", message: "AssignmentClaim requires writableSurfaces and forbiddenSurfaces." });
  }
  if (!Number.isSafeInteger(claim.ownershipGeneration) || claim.ownershipGeneration < 1) {
    issues.push({ code: "invalid_ownership_generation", message: "AssignmentClaim ownershipGeneration must be a positive integer." });
  }
  if (!["claimed", "released", "stopped_fenced"].includes(claim.state)) {
    issues.push({ code: "invalid_claim_state", message: "AssignmentClaim state must be claimed, released, or stopped_fenced." });
  }
  if (claim.state === "stopped_fenced" && !nonEmpty(claim.writerStopEvidence)) {
    issues.push({ code: "missing_writer_stop_evidence", message: "A stopped_fenced claim requires writerStopEvidence." });
  }
  return fail(issues);
}

export function assertAssignmentClaim(claim: AssignmentClaim): void {
  assertValid(validateAssignmentClaim(claim), `Assignment claim ${claim.id}`);
}

/**
 * Reassignment requires proof the prior writer stopped or was fenced — a
 * check-only inventory (timestamps, absent PRs, stale chat) is insufficient.
 */
export function assertClaimReassignable(prior: AssignmentClaim, next: AssignmentClaim): void {
  if (!isObj(prior) || !isObj(next)) {
    throw new Error("Claim reassignment requires valid prior and next AssignmentClaim objects.");
  }
  if (prior.packetId !== next.packetId) {
    throw new Error(`Claim ${next.id} reassigns a different packet than prior claim ${prior.id}.`);
  }
  if (prior.state !== "stopped_fenced" || !nonEmpty(prior.writerStopEvidence)) {
    throw new Error(
      `Cannot reassign packet ${prior.packetId}: prior claim ${prior.id} has no stopped/fenced writer evidence (state=${prior.state}).`,
    );
  }
  if (next.ownershipGeneration !== prior.ownershipGeneration + 1) {
    throw new Error(
      `Reassignment of packet ${prior.packetId} must advance ownershipGeneration from ${prior.ownershipGeneration} to ${prior.ownershipGeneration + 1}, got ${next.ownershipGeneration}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// HostPlanningCapabilities
// ---------------------------------------------------------------------------

export type HostCapabilityStatus = "enforced" | "procedural" | "unavailable";

export interface HostCapabilityObservation {
  readonly status: HostCapabilityStatus;
  /** Concrete evidence (file:line or description) — never an invented capability. */
  readonly evidence: string;
}

export interface HostPlanningCapabilities {
  readonly independentReviewerSelection: HostCapabilityObservation;
  readonly worktreeIsolation: HostCapabilityObservation;
  readonly atomicAssignmentClaims: HostCapabilityObservation;
  readonly maxWorkersCeiling: HostCapabilityObservation;
  readonly taskAttemptCeiling: HostCapabilityObservation;
  readonly runLevelRepairCeiling: HostCapabilityObservation;
  readonly issueLevelRepairCeiling: HostCapabilityObservation;
  readonly directEventReplayValidators: HostCapabilityObservation;
  readonly stateTransitionGates: HostCapabilityObservation;
  readonly nonExecutingLaunchChips: HostCapabilityObservation;
  readonly nodeRuntimePolicy: HostCapabilityObservation;
  readonly docsFolderCompletionGate: HostCapabilityObservation;
  readonly readerDisposableCommandExecution: HostCapabilityObservation;
  readonly recordedAt: string;
}

const HOST_CAPABILITY_FIELDS: readonly (keyof HostPlanningCapabilities)[] = [
  "independentReviewerSelection",
  "worktreeIsolation",
  "atomicAssignmentClaims",
  "maxWorkersCeiling",
  "taskAttemptCeiling",
  "runLevelRepairCeiling",
  "issueLevelRepairCeiling",
  "directEventReplayValidators",
  "stateTransitionGates",
  "nonExecutingLaunchChips",
  "nodeRuntimePolicy",
  "docsFolderCompletionGate",
  "readerDisposableCommandExecution",
];

export function validateHostPlanningCapabilities(capabilities: HostPlanningCapabilities): PlanningValidation {
  if (!isObj(capabilities)) {
    return fail([{ code: "invalid_input", message: "HostPlanningCapabilities must be an object." }]);
  }
  const issues: PlanningIssue[] = [];
  for (const field of HOST_CAPABILITY_FIELDS) {
    const observation = (capabilities as unknown as Record<string, unknown>)[field as string];
    if (
      !isRecord(observation) ||
      !["enforced", "procedural", "unavailable"].includes(observation.status as string) ||
      !nonEmpty(observation.evidence)
    ) {
      issues.push({ code: "invalid_capability_observation", message: `HostPlanningCapabilities.${String(field)} requires status and non-empty evidence.` });
    }
  }
  if (!isValidTimestamp(capabilities.recordedAt)) issues.push({ code: "missing_recorded_at", message: "HostPlanningCapabilities requires a valid recordedAt timestamp." });
  return fail(issues);
}

export function assertHostPlanningCapabilities(capabilities: HostPlanningCapabilities): void {
  assertValid(validateHostPlanningCapabilities(capabilities), "Host planning capabilities");
}

/**
 * M6 (independent review r1): NOT AUTHORITATIVE. This is a point-in-time
 * SEED copied from T1a's §2 host-capability inspection
 * (.superpowers/sdd/2026-09-06-runner-v2-evidence-gated-planning/evidence/T1a-compatibility-map.md),
 * observed 2026-09-23 against one specific commit. Its `evidence` strings
 * (file:line citations) will go stale as the referenced files change —
 * downstream tasks (T2 onward) MUST re-observe the live host and produce
 * their own current `HostPlanningCapabilities`, never cite this constant as
 * proof of a present capability. It exists here (rather than only in a test
 * fixture) solely so T1's own fixtures/tests have a realistic, traceable
 * example value to exercise the validator against.
 */
export const T1A_SEEDED_HOST_PLANNING_CAPABILITIES: HostPlanningCapabilities = {
  independentReviewerSelection: {
    status: "enforced",
    evidence: "runtime-router.ts:178-220 selectVerifier computes distinct-model exclusion, falls back to fresh_context.",
  },
  worktreeIsolation: {
    status: "enforced",
    evidence: "workspace-manager.ts:85-127 createTaskWorkspace runs git worktree add per task; ownership via worktree-state.ts.",
  },
  atomicAssignmentClaims: {
    status: "procedural",
    evidence: "task-scheduler.ts:69-139 is single-process in-memory serialization; no cross-process lock/lease/fencing token found.",
  },
  maxWorkersCeiling: {
    status: "unavailable",
    evidence: "Zero occurrences of MAX_WORKERS in runner-v2/src; maxConcurrency accepts any positive integer today (T4 adds the ceiling).",
  },
  taskAttemptCeiling: {
    status: "enforced",
    evidence: "build-runtime.ts:299 maxTaskAttempts defaults to 2.",
  },
  runLevelRepairCeiling: {
    status: "enforced",
    evidence: "scheduler-store.ts:493 DEFAULT_REPAIR_PLAN_LIMIT = 3; repairCyclesExhausted() l.648.",
  },
  issueLevelRepairCeiling: {
    status: "unavailable",
    evidence: "No issue/root-cause-keyed repair-cycle structure found alongside RepairCyclesProjection (T6 adds it).",
  },
  directEventReplayValidators: {
    status: "enforced",
    evidence: "scheduler-store.ts:1735 reduceSchedulerEvent is used for both live append and replay (l.1231).",
  },
  stateTransitionGates: {
    status: "enforced",
    evidence: "scheduler-store.ts:863-966 architectActionReasonIsApplicable is an exhaustive switch over architect-action reasons.",
  },
  nonExecutingLaunchChips: {
    status: "unavailable",
    evidence: "Grepped launch.?chip|chip.?prep repo-wide (excluding .worktrees): zero matches.",
  },
  nodeRuntimePolicy: {
    status: "enforced",
    evidence: "node-version.ts:2,5,20-38 SUPPORTED_NODE_LTS_LINES=[24]; package.json engines >=24.0.0 <25.",
  },
  docsFolderCompletionGate: {
    status: "enforced",
    evidence: "scheduler-store.ts:982,1001,1168 call projectDocumentationReadiness (defined l.1188).",
  },
  readerDisposableCommandExecution: {
    status: "procedural",
    evidence: "evidence-tools.ts:51 run_evidence_command exists and is granted to architect:inspection; disposable-copy semantics not independently confirmed by T1a.",
  },
  recordedAt: "2026-09-23T00:00:00.000Z",
};

// ---------------------------------------------------------------------------
// Composite plan readiness
// ---------------------------------------------------------------------------

export interface PlanReadinessInput {
  readonly manifest: ApprovedSourceManifest;
  readonly revision: ExecutionPlanRevision;
  readonly coverageReview: CoverageReview;
  readonly hostCapabilities: HostPlanningCapabilities;
  /** B1 revision-to-revision guard: supplied when this revision amends a prior one. */
  readonly priorRevision?: ExecutionPlanRevision;
  readonly amendmentHistory?: AmendmentHistory;
}

export interface PlanReadinessResult {
  readonly ready: boolean;
  readonly blockers: readonly string[];
}

/**
 * The single composite gate exercised by T1's negative-proof cases: removing
 * a requirement, dropping a source section, assigning two owners, changing a
 * source digest, cancelling a requirement's only implementation task without
 * disposition, or silently marking an obligation not_applicable without an
 * authorized disposition must each make this return ready:false.
 */
/**
 * T6a (R4-B2): the fixed vocabulary of phase `requiredCombinedValidation`
 * words the runner can check mechanically after integration, mapped to the
 * runner boundary check that satisfies each (`typecheck` is satisfied by the
 * project build command). A plan whose phase names any other word never
 * becomes ready, so the Architect revises it while planning instead of the
 * phase silently never being accepted.
 */
export const PHASE_VALIDATION_CHECKS: Readonly<Record<string, "build" | "tests">> = Object.freeze({
  build: "build",
  compile: "build",
  typecheck: "build",
  "type-check": "build",
  tests: "tests",
  test: "tests",
  "targeted-tests": "tests",
  "affected-tests": "tests",
  "unit-tests": "tests",
});

export function phaseValidationCheckId(validation: string): "build" | "tests" | undefined {
  return Object.hasOwn(PHASE_VALIDATION_CHECKS, validation.trim().toLowerCase())
    ? PHASE_VALIDATION_CHECKS[validation.trim().toLowerCase()]
    : undefined;
}

export function unmappedPhaseValidationIssues(phases: readonly ExecutionPlanPhase[]): string[] {
  const allowed = Object.keys(PHASE_VALIDATION_CHECKS).join(", ");
  const issues: string[] = [];
  for (const phase of Array.isArray(phases) ? phases : []) {
    if (!isObj(phase) || !Array.isArray(phase.requiredCombinedValidation)) continue;
    for (const word of phase.requiredCombinedValidation) {
      if (typeof word !== "string" || phaseValidationCheckId(word) === undefined) {
        issues.push(
          `Phase ${phase.id} requiredCombinedValidation "${String(word)}" is not a runner-checkable validation; use only: ${allowed}.`,
        );
      }
    }
  }
  return issues;
}

export function computePlanReadiness(input: PlanReadinessInput): PlanReadinessResult {
  // NEW-2: computePlanReadiness is the composite gate — exactly where a
  // malformed durable record would arrive — so it must never throw on a
  // null/malformed `input` or `input.coverageReview`.
  if (!isObj(input)) {
    return { ready: false, blockers: ["Invalid plan readiness input."] };
  }

  const blockers: string[] = [];

  const amendmentHistory = Array.isArray(input.amendmentHistory) ? input.amendmentHistory : [];
  const revisionValidation = validateExecutionPlanRevision(input.revision, input.manifest, amendmentHistory);
  blockers.push(...revisionValidation.issues.map((issue) => issue.message));

  const coverageValidation = validateCoverageReview(input.coverageReview);
  blockers.push(...coverageValidation.issues.map((issue) => issue.message));
  if (coverageValidation.valid && coverageReviewHoldsReadiness(input.coverageReview)) {
    blockers.push("A blocking missing or weakened coverage verdict is unresolved.");
  }
  // I6: an unresolved blocking finding (not just a missing/weakened
  // obligation verdict) also holds readiness.
  const findings = isObj(input.coverageReview) && Array.isArray(input.coverageReview.findings)
    ? input.coverageReview.findings.filter(isObj)
    : [];
  for (const finding of findings) {
    if (findingIsUnresolvedBlocking(finding)) {
      blockers.push(`Unresolved blocking finding ${finding.id}: ${finding.claim}`);
    }
  }

  // B3: the coverage review must bind to the exact current plan revision
  // (id AND digest), the exact source manifest, and the current run — a
  // plan mutation that keeps the same revisionId still invalidates a stale
  // review.
  const bindingValidation = validateCoverageReviewBinding(input.coverageReview, input.revision, input.manifest);
  blockers.push(...bindingValidation.issues.map((issue) => issue.message));

  const hostValidation = validateHostPlanningCapabilities(input.hostCapabilities);
  blockers.push(...hostValidation.issues.map((issue) => issue.message));

  // T6a (R4-B2): every phase exit check must be one the runner can run.
  if (isObj(input.revision) && Array.isArray(input.revision.phases)) {
    blockers.push(...unmappedPhaseValidationIssues(input.revision.phases));
  }

  // B1 (revision-to-revision guard): when a prior revision is supplied,
  // every requirement it named must survive or be authorized-removed.
  if (input.priorRevision !== undefined) {
    const removalValidation = validateRequirementRemovalAgainstPrior(input.revision, input.priorRevision, input.manifest, amendmentHistory);
    blockers.push(...removalValidation.issues.map((issue) => issue.message));
  }

  return { ready: blockers.length === 0, blockers };
}


// ---------------------------------------------------------------------------
// C5 (AR-R15): kernel-owned submission envelope and mirrored-link derivation.
// ---------------------------------------------------------------------------

/**
 * C5 (AR-R15): the kernel-owned envelope fields of a plan revision. The
 * model may omit them — the kernel stamps them from actual run, source
 * and revision state — but any supplied value must exactly match the
 * actual, or the submission is refused. `createdAt` is the kernel clock
 * at submission. An unevaluated revision has no coverage-review binding;
 * repair-budget lineage may continue from its prior revision. Omission
 * means absence: an
 * explicit blank, null or wrong-typed value is a supplied value and is
 * refused, never silently repaired. Historical validation, canonical
 * serialization and stored digests are untouched — normalization runs
 * only at the draft/revise submission boundary, before the digest is
 * calculated.
 */
export const KERNEL_STAMPED_REVISION_FIELDS = [
  "runId",
  "sourceManifestId",
  "sourceManifestDigest",
  "workflowPolicyVersion",
  "createdAt",
  "coverageReviewId",
  "repairBudgetLineageId",
] as const;

export type KernelStampedRevisionField = (typeof KERNEL_STAMPED_REVISION_FIELDS)[number];

/**
 * Actual kernel state the envelope is stamped from at the submission
 * boundary. `coverageReviewId` / `repairBudgetLineageId` are absent
 * (undefined) for authoritative absence — no current id in durable
 * state — so an omitted field stays absent and any supplied value is
 * refused.
 */
export interface PlanSubmissionActuals {
  readonly runId: string;
  readonly sourceManifestId: string;
  readonly sourceManifestDigest: string;
  readonly workflowPolicyVersion: number;
  readonly createdAt: string;
  readonly coverageReviewId?: string;
  readonly repairBudgetLineageId?: string;
  /** Durable semantics are compared before reusing their decision times. */
  readonly priorRevision?: Pick<ExecutionPlanRevisionWithoutDigest,
    "requirements" | "planningDecisions" | "nonNormativeSections" | "retiredRequirementIds">;
  readonly ledgerRequirements?: readonly SourceRequirement[];
}


/**
 * C5 required-base interpretation: an immutable, deterministic kernel
 * descriptor tied to the validated submitted plan revision, documenting
 * required plan provenance. It is not a checkout SHA: the exact attempt
 * checkout remains the allocated Git SHA, and assignment claims prefer the
 * allocation baseline, then the persisted attempt baseline, before this
 * descriptor (task-scheduler.ts). Never frozen across revisions — each
 * submitted revision carries its own descriptor.
 */
export function requiredBaseForRevision(revisionId: string): string {
  return `accepted plan revision ${revisionId}`;
}

/**
 * A submitted requirement: either link side may be omitted — the model
 * authors one side of each link and the kernel derives the other. The
 * semantic requirement fields (reference, purpose, outcome, acceptance
 * conditions) stay required.
 */
export type PlanSubmissionRequirement = Omit<SourceRequirement, "accountablePhaseId" | "contributingTaskIds" | "applicability"> & {
  readonly applicability: Omit<RequirementApplicability, "disposition"> & {
    readonly disposition?: Omit<RequirementApplicabilityDisposition, "decidedAt"> & { readonly decidedAt?: string };
  };
  readonly accountablePhaseId?: string;
  readonly contributingTaskIds?: readonly string[];
};

/**
 * A submitted task: requiredBase and every link side may be omitted for
 * kernel derivation. Semantic lineage (task.lineage) is model-authored
 * and required — the kernel never infers or stamps it.
 */
export type PlanSubmissionTask = Omit<ExecutionTaskContract, "requiredBase" | "accountablePhaseId" | "requirementIds"> & {
  readonly requiredBase?: string;
  readonly accountablePhaseId?: string;
  readonly requirementIds?: readonly string[];
};

/** A submitted phase: membership lists may be omitted for kernel derivation. */
export type PlanSubmissionPhase = Omit<ExecutionPlanPhase, "requirementIds" | "contributingTaskIds"> & {
  readonly requirementIds?: readonly string[];
  readonly contributingTaskIds?: readonly string[];
};

/**
 * A submitted planning decision: identity and description stay
 * model-authored and required — only the kernel timestamp may be
 * omitted for stamping at the submission boundary.
 */
export type PlanSubmissionPlanningDecision = {
  readonly id: string;
  readonly description: string;
  readonly decidedAt?: string;
};

/** A submitted non-normative section record: only decidedAt may be omitted. */
export type PlanSubmissionSectionDisposition = Omit<SourceSectionDisposition, "decidedAt"> & {
  readonly decidedAt?: string;
};

/** A submitted retired-requirement record: only decidedAt may be omitted. */
export type PlanSubmissionRetiredRequirement = Omit<RetiredRequirementRecord, "decidedAt"> & {
  readonly decidedAt?: string;
};

/**
 * A submitted revision: the kernel-stamped envelope fields, every task's
 * requiredBase, and every requirement/task/phase link side may be
 * omitted. The decision/disposition timestamps above may also be omitted
 * for kernel stamping. Everything else (EP06 semantic fields,
 * REQUIRED_TEXT_LIST_FIELDS, identity/coverage constraints) stays
 * required — omission there is still refused downstream, never defaulted.
 */
export type PlanSubmissionRevision = Omit<
  ExecutionPlanRevisionWithoutDigest,
  | "runId"
  | "sourceManifestId"
  | "sourceManifestDigest"
  | "workflowPolicyVersion"
  | "createdAt"
  | "coverageReviewId"
  | "repairBudgetLineageId"
  | "requirements"
  | "tasks"
  | "phases"
  | "planningDecisions"
  | "nonNormativeSections"
  | "retiredRequirementIds"
> & {
  readonly runId?: string;
  readonly sourceManifestId?: string;
  readonly sourceManifestDigest?: string;
  readonly workflowPolicyVersion?: number;
  readonly createdAt?: string;
  readonly coverageReviewId?: string;
  readonly repairBudgetLineageId?: string;
  readonly requirements: readonly PlanSubmissionRequirement[];
  readonly tasks: readonly PlanSubmissionTask[];
  readonly phases: readonly PlanSubmissionPhase[];
  readonly planningDecisions: readonly PlanSubmissionPlanningDecision[];
  readonly nonNormativeSections?: readonly PlanSubmissionSectionDisposition[];
  readonly retiredRequirementIds?: readonly PlanSubmissionRetiredRequirement[];
};

export interface PlanSubmissionFailure {
  readonly code:
    | "envelope_mismatch"
    | "base_mismatch"
    | "timestamp_mismatch"
    | "unknown_requirement_ref"
    | "unknown_task_ref"
    | "unknown_phase_ref"
    | "link_conflict"
    | "malformed_link";

  readonly taskId?: string;
  readonly requirementId?: string;
  readonly phaseId?: string;
  readonly message: string;
}

export type StampedPlanSubmission =
  | { readonly ok: true; readonly revision: ExecutionPlanRevisionWithoutDigest; readonly derived: readonly string[] }
  | { readonly ok: false; readonly failure: PlanSubmissionFailure };

function mismatched(field: KernelStampedRevisionField, supplied: unknown, actual: unknown): PlanSubmissionFailure {
  return {
    code: "envelope_mismatch",
    message: `Submitted plan envelope field ${field} (${JSON.stringify(supplied)}) does not match the kernel's actual ${field} (${JSON.stringify(actual)}) — envelope fields are kernel-owned; omit them or supply the exact actual value.`,
  };
}

/**
 * Stamps omitted envelope fields from actuals; refuses supplied values
 * that do not match. Pure: operates on a structured clone, preserves key
 * order and array order (canonical serialization is unaffected).
 */
export function stampPlanSubmissionEnvelope(
  revision: PlanSubmissionRevision,
  actuals: PlanSubmissionActuals,
): StampedPlanSubmission {
  const copy = structuredClone(revision) as unknown as Record<string, unknown> & {
    tasks: Record<string, unknown>[];
  };
  const actualByField: Record<KernelStampedRevisionField, unknown> = {
    runId: actuals.runId,
    sourceManifestId: actuals.sourceManifestId,
    sourceManifestDigest: actuals.sourceManifestDigest,
    workflowPolicyVersion: actuals.workflowPolicyVersion,
    createdAt: actuals.createdAt,
    coverageReviewId: actuals.coverageReviewId,
    repairBudgetLineageId: actuals.repairBudgetLineageId,
  };
  for (const field of KERNEL_STAMPED_REVISION_FIELDS) {
    const supplied = copy[field];
    const actual = actualByField[field];
    if (supplied === undefined) {
      // Omission is absence: stamp the actual, or leave the field absent
      // when the kernel authoritatively has no current id. An omitted
      // envelope value is never serialized as an explicit blank or null,
      // so historical digests stay stable.
      if (actual === undefined) delete copy[field];
      else copy[field] = actual;
      continue;
    }
    // Any provided value — including an explicit blank, null or
    // wrong-typed value — must exactly match the actual. Nothing supplied
    // is silently repaired.
    if (supplied !== actual) {
      return { ok: false, failure: mismatched(field, supplied, actual) };
    }
  }
  const revisionId = copy["revisionId"];
  if (typeof revisionId !== "string" || revisionId.trim().length === 0) {
    return {
      ok: false,
      failure: { code: "envelope_mismatch", message: "Submitted plan revision requires a model-authored revisionId." },
    };
  }
  const expectedBase = requiredBaseForRevision(revisionId);
  const tasks = Array.isArray(copy.tasks) ? copy.tasks : [];
  for (const task of tasks) {
    if (task === undefined || task === null) continue;
    const supplied = task["requiredBase"];
    if (supplied === undefined) {
      task["requiredBase"] = expectedBase;
      continue;
    }
    if (supplied !== expectedBase) {
      return {
        ok: false,
        failure: {
          code: "base_mismatch",
          taskId: typeof task["id"] === "string" ? (task["id"] as string) : undefined,
          message: `Task ${typeof task["id"] === "string" ? (task["id"] as string) : "?"} supplies requiredBase (${JSON.stringify(supplied)}) but the kernel's required base for submitted revision ${revisionId} is (${JSON.stringify(expectedBase)}) — requiredBase is kernel-owned; omit it or supply the exact value.`,
        },
      };
    }
  }
  return { ok: true, revision: copy as unknown as ExecutionPlanRevisionWithoutDigest, derived: [] };
}

/**
 * Stamp every decision time at submission only. Reuse a durable time only
 * for the same semantic decision, including its authorization and basis.
 * Changed decisions take the submission clock. Approval is never inferred;
 * all other semantic fields remain subject to the existing strict validators.
 */
export function stampSubmissionTimestamps(
  revision: PlanSubmissionRevision,
  actuals: PlanSubmissionActuals,
): StampedPlanSubmission {
  const copy = structuredClone(revision) as unknown as Record<string, unknown>;
  const withoutTime = (record: Record<string, unknown>): Record<string, unknown> => {
    const { decidedAt: _time, ...semantic } = record;
    void _time;
    return semantic;
  };
  const stamp = (
    record: Record<string, unknown>,
    actual: string,
    description: string,
  ): PlanSubmissionFailure | undefined => {
    if (record["decidedAt"] === undefined) record["decidedAt"] = actual;
    else if (record["decidedAt"] !== actual) {
      return {
        code: "timestamp_mismatch",
        message: `${description} supplies decidedAt (${JSON.stringify(record["decidedAt"])}) but the kernel's actual is (${JSON.stringify(actual)}) — decision timestamps are kernel-owned; omit them or supply the exact actual value.`,
      };
    }
    return undefined;
  };
  for (const key of ["planningDecisions", "nonNormativeSections", "retiredRequirementIds"] as const) {
    const list = copy[key];
    if (!Array.isArray(list)) continue;
    const durable = actuals.priorRevision?.[key] ?? [];
    for (const record of list) {
      if (!isRecord(record)) continue;
      const match = durable.find((candidate) => isDeepStrictEqual(withoutTime(record), withoutTime(candidate as unknown as Record<string, unknown>)));
      const failure = stamp(record, match?.decidedAt ?? actuals.createdAt, key);
      if (failure) return { ok: false, failure };
    }
  }
  const requirements = copy["requirements"];
  if (Array.isArray(requirements)) {
    const durable = [...(actuals.priorRevision?.requirements ?? []), ...(actuals.ledgerRequirements ?? [])];
    for (const requirement of requirements) {
      if (!isRecord(requirement) || !isRecord(requirement["applicability"])) continue;
      const applicability = requirement["applicability"];
      const disposition = applicability["disposition"];
      if (!isRecord(disposition)) continue;
      const basis = { ...applicability, disposition: withoutTime(disposition) };
      const match = durable.find((candidate) => candidate.id === requirement["id"]
        && isDeepStrictEqual(candidate.reference, requirement["reference"])
        && candidate.applicability.disposition !== undefined
        && isDeepStrictEqual({ ...candidate.applicability, disposition: withoutTime(candidate.applicability.disposition as unknown as Record<string, unknown>) }, basis));
      const failure = stamp(disposition, match?.applicability.disposition?.decidedAt ?? actuals.createdAt, `Requirement ${String(requirement["id"])} applicability disposition`);
      if (failure) return { ok: false, failure };
    }
  }
  return { ok: true, revision: copy as unknown as ExecutionPlanRevisionWithoutDigest, derived: [] };
}

function linkFailure(failure: PlanSubmissionFailure): StampedPlanSubmission {
  return { ok: false, failure };
}

/** One authored side of a reciprocal link. `supplied` false is omission. */
interface SuppliedLinkSide {
  readonly supplied: boolean;
  readonly values: readonly string[];
}

/**
 * Reads one authored reciprocal array. Absent (undefined) is omission —
 * the kernel may derive it. Any other value must be an array of strings;
 * anything else (null, a bare string, non-string entries) is malformed
 * and fails closed — never treated as omission.
 */
function readLinkSide(value: unknown): SuppliedLinkSide | undefined {
  if (value === undefined) return { supplied: false, values: [] };
  if (!Array.isArray(value)) return undefined;
  const values: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return undefined;
    values.push(entry);
  }
  return { supplied: true, values };
}

/** One authored accountable-phase side. Absent (undefined) is omission. */
interface SuppliedOwnerSide {
  readonly supplied: boolean;
  readonly value: string;
}

function readOwnerSide(value: unknown): SuppliedOwnerSide | undefined {
  if (value === undefined) return { supplied: false, value: "" };
  if (typeof value !== "string") return undefined;
  return { supplied: true, value };
}

/** A link-bearing submission node with its raw authored sides. */
interface SubmissionLinkNode {
  readonly id?: unknown;
  readonly accountablePhaseId?: unknown;
  readonly contributingTaskIds?: unknown;
  readonly requirementIds?: unknown;
  readonly investigation?: unknown;
}

function isLinkNode(value: unknown): value is SubmissionLinkNode {
  return value !== undefined && value !== null && typeof value === "object";
}

function queueLinkAddition(additions: Map<string, string[]>, key: string, value: string): void {
  const queued = additions.get(key);
  if (queued) {
    if (!queued.includes(value)) queued.push(value);
    return;
  }
  additions.set(key, [value]);
}

/**
 * Derives the mirrored requirement/task/phase links from whichever side
 * the model authored: the model authors one side of each link and the
 * kernel fills the other by appending (authored array order is preserved;
 * nothing is reordered or removed). Every original authored side is
 * snapshotted before any mutation, the complete reciprocal sets are
 * computed from those originals only, and only then applied — so fan-in
 * (two requirements to one silent task, two tasks to one silent
 * requirement, several members to one silent phase) derives coherently
 * instead of tripping on iteration-time mutations. Both sides supplied
 * but disagreeing, unknown identities, unknown phases, ambiguous reverse
 * ownership and malformed sides all fail closed. An omitted
 * accountablePhaseId derives from exactly one uniquely naming phase
 * membership; several naming phases are ambiguous and refused. Links
 * missing on both sides are left for the EP06/coverage validators, which
 * still refuse them.
 */
export function deriveMirroredPlanLinks(
  revision: PlanSubmissionRevision,
): StampedPlanSubmission {
  const copy = structuredClone(revision) as unknown as Record<string, unknown>;
  const derived: string[] = [];
  const requirements = (
    Array.isArray(copy["requirements"]) ? (copy["requirements"] as unknown[]) : []
  ).filter(isLinkNode);
  const tasks = (
    Array.isArray(copy["tasks"]) ? (copy["tasks"] as unknown[]) : []
  ).filter(isLinkNode);
  const phases = (
    Array.isArray(copy["phases"]) ? (copy["phases"] as unknown[]) : []
  ).filter(isLinkNode);
  const requirementById = new Map<string, SubmissionLinkNode>();
  for (const requirement of requirements) {
    if (typeof requirement.id === "string") requirementById.set(requirement.id, requirement);
  }
  const taskById = new Map<string, SubmissionLinkNode>();
  for (const task of tasks) {
    if (typeof task.id === "string") taskById.set(task.id, task);
  }
  const phaseById = new Map<string, SubmissionLinkNode>();
  for (const phase of phases) {
    if (typeof phase.id === "string") phaseById.set(phase.id, phase);
  }

  // Snapshot every original authored side BEFORE any mutation. All
  // conflict checks below compare these originals only.
  const reqContrib = new Map<string, SuppliedLinkSide>();
  const reqOwner = new Map<string, SuppliedOwnerSide>();
  const taskReqs = new Map<string, SuppliedLinkSide>();
  const taskOwner = new Map<string, SuppliedOwnerSide>();
  const phaseReqs = new Map<string, SuppliedLinkSide>();
  const phaseTasks = new Map<string, SuppliedLinkSide>();
  const malformed = (where: string, field: string, id: string): StampedPlanSubmission =>
    linkFailure({
      code: "malformed_link",
      message: `${where} ${id} supplies a malformed ${field} side (expected an omitted field or an array of id strings) — malformed sides fail closed, never treated as omission.`,
    });
  for (const requirement of requirements) {
    if (typeof requirement.id !== "string") continue;
    const contrib = readLinkSide(requirement.contributingTaskIds);
    if (!contrib) return malformed("Requirement", "contributingTaskIds", requirement.id);
    const owner = readOwnerSide(requirement.accountablePhaseId);
    if (!owner) return malformed("Requirement", "accountablePhaseId", requirement.id);
    reqContrib.set(requirement.id, contrib);
    reqOwner.set(requirement.id, owner);
  }
  for (const task of tasks) {
    if (typeof task.id !== "string") continue;
    const claimed = readLinkSide(task.requirementIds);
    if (!claimed) return malformed("Task", "requirementIds", task.id);
    const owner = readOwnerSide(task.accountablePhaseId);
    if (!owner) return malformed("Task", "accountablePhaseId", task.id);
    taskReqs.set(task.id, claimed);
    taskOwner.set(task.id, owner);
  }
  for (const phase of phases) {
    if (typeof phase.id !== "string") continue;
    const memberReqs = readLinkSide(phase.requirementIds);
    if (!memberReqs) return malformed("Phase", "requirementIds", phase.id);
    const memberTasks = readLinkSide(phase.contributingTaskIds);
    if (!memberTasks) return malformed("Phase", "contributingTaskIds", phase.id);
    phaseReqs.set(phase.id, memberReqs);
    phaseTasks.set(phase.id, memberTasks);
  }

  // Unknown identities fail closed before any derivation invents a link.
  for (const task of tasks) {
    if (typeof task.id !== "string") continue;
    for (const requirementId of taskReqs.get(task.id)?.values ?? []) {
      if (!requirementById.has(requirementId)) {
        return linkFailure({
          code: "unknown_requirement_ref",
          taskId: task.id,
          requirementId,
          message: `Task ${task.id} claims unknown requirement ${requirementId} — a dropped or nonexistent requirement.`,
        });
      }
    }
    const investigation = task.investigation as { dependentUnlockTaskIds?: unknown } | undefined;
    const unlocks = investigation !== undefined && isNonBlankStringArray(investigation.dependentUnlockTaskIds)
      ? investigation.dependentUnlockTaskIds
      : [];
    for (const unlockId of unlocks) {
      if (!taskById.has(unlockId)) {
        return linkFailure({
          code: "unknown_task_ref",
          taskId: task.id,
          message: `Investigation task ${task.id}'s dependent unlock ${unlockId} does not resolve to a task in this revision.`,
        });
      }
    }
  }
  for (const requirement of requirements) {
    if (typeof requirement.id !== "string") continue;
    for (const taskId of reqContrib.get(requirement.id)?.values ?? []) {
      if (!taskById.has(taskId)) {
        return linkFailure({
          code: "unknown_task_ref",
          requirementId: requirement.id,
          taskId,
          message: `Requirement ${requirement.id} claims unknown contributing task ${taskId}.`,
        });
      }
    }
    const owner = reqOwner.get(requirement.id);
    if (owner?.supplied && !phaseById.has(owner.value)) {
      return linkFailure({
        code: "unknown_phase_ref",
        requirementId: requirement.id,
        phaseId: owner.value,
        message: `Requirement ${requirement.id} names unknown accountable phase ${owner.value}.`,
      });
    }
  }
  for (const task of tasks) {
    if (typeof task.id !== "string") continue;
    const owner = taskOwner.get(task.id);
    if (owner?.supplied && !phaseById.has(owner.value)) {
      return linkFailure({
        code: "unknown_phase_ref",
        taskId: task.id,
        phaseId: owner.value,
        message: `Task ${task.id} names unknown accountable phase ${owner.value}.`,
      });
    }
  }
  for (const phase of phases) {
    if (typeof phase.id !== "string") continue;
    for (const requirementId of phaseReqs.get(phase.id)?.values ?? []) {
      if (!requirementById.has(requirementId)) {
        return linkFailure({
          code: "unknown_requirement_ref",
          phaseId: phase.id,
          requirementId,
          message: `Phase ${phase.id} references unknown requirement ${requirementId}.`,
        });
      }
    }
    for (const taskId of phaseTasks.get(phase.id)?.values ?? []) {
      if (!taskById.has(taskId)) {
        return linkFailure({
          code: "unknown_task_ref",
          phaseId: phase.id,
          taskId,
          message: `Phase ${phase.id} references unknown contributing task ${taskId}.`,
        });
      }
    }
  }

  // Planned additions, computed from the originals and applied only after
  // every check passes — never interleaved with conflict checks.
  const taskReqAdditions = new Map<string, string[]>();
  const reqContribAdditions = new Map<string, string[]>();
  const phaseReqAdditions = new Map<string, string[]>();
  const phaseTaskAdditions = new Map<string, string[]>();
  const reqOwnerAssignments = new Map<SubmissionLinkNode, string>();
  const taskOwnerAssignments = new Map<SubmissionLinkNode, string>();

  // Requirement <-> task: derive the silent side from the authored one,
  // refuse a disagreeing supplied side.
  for (const requirement of requirements) {
    if (typeof requirement.id !== "string") continue;
    const contrib = reqContrib.get(requirement.id);
    if (!contrib?.supplied) continue;
    for (const taskId of contrib.values) {
      const peer = taskReqs.get(taskId);
      if (!peer) continue;
      if (peer.supplied) {
        if (!peer.values.includes(requirement.id)) {
          return linkFailure({
            code: "link_conflict",
            requirementId: requirement.id,
            taskId,
            message: `Requirement ${requirement.id} claims task ${taskId} as contributing, but task ${taskId} names a different requirement set (${peer.values.join(", ")}) — supplied sides disagree.`,
          });
        }
        continue;
      }
      queueLinkAddition(taskReqAdditions, taskId, requirement.id);
    }
  }
  for (const task of tasks) {
    if (typeof task.id !== "string") continue;
    const claimed = taskReqs.get(task.id);
    if (!claimed?.supplied) continue;
    for (const requirementId of claimed.values) {
      const peer = reqContrib.get(requirementId);
      if (!peer) continue;
      if (peer.supplied) {
        if (!peer.values.includes(task.id)) {
          return linkFailure({
            code: "link_conflict",
            requirementId,
            taskId: task.id,
            message: `Task ${task.id} claims requirement ${requirementId}, but requirement ${requirementId} names a different contributing set (${peer.values.join(", ")}) — supplied sides disagree.`,
          });
        }
        continue;
      }
      queueLinkAddition(reqContribAdditions, requirementId, task.id);
    }
  }

  // Phase <-> requirement/task ownership from either supplied side: an
  // authored owner derives into a silent membership list, an authored
  // membership derives into a silent owner, and a supplied pair that
  // disagrees is refused.
  const resolveOwnership = (
    kind: "requirement" | "task",
    nodes: readonly SubmissionLinkNode[],
    owners: Map<string, SuppliedOwnerSide>,
    memberSides: Map<string, SuppliedLinkSide>,
    additions: Map<string, string[]>,
    assignments: Map<SubmissionLinkNode, string>,
    memberField: "requirementIds" | "contributingTaskIds",
  ): StampedPlanSubmission | undefined => {
    const idField = kind === "requirement" ? "requirementId" : "taskId";
    for (const node of nodes) {
      if (typeof node.id !== "string") continue;
      const owner = owners.get(node.id);
      if (!owner) continue;
      if (owner.supplied) {
        if (!phaseById.has(owner.value)) continue;
        for (const [phaseId, side] of memberSides) {
          if (phaseId === owner.value || !side.supplied || !side.values.includes(node.id)) continue;
          return linkFailure({
            code: "link_conflict",
            phaseId,
            [idField]: node.id,
            message: `Phase ${phaseId} lists ${kind} ${node.id}, but that ${kind}'s accountable phase is ${owner.value} — supplied sides disagree.`,
          });
        }
        const homeSide = memberSides.get(owner.value);
        if (homeSide?.supplied) {
          if (!homeSide.values.includes(node.id)) {
            return linkFailure({
              code: "link_conflict",
              phaseId: owner.value,
              [idField]: node.id,
              message: `${kind === "requirement" ? "Requirement" : "Task"} ${node.id} is accountable to phase ${owner.value}, but phase ${owner.value} names a different ${memberField} set (${homeSide.values.join(", ")}) — supplied sides disagree.`,
            });
          }
          continue;
        }
        queueLinkAddition(additions, owner.value, node.id);
      } else {
        // Reverse derivation: exactly one uniquely naming phase owns it.
        // Several naming phases are ambiguous and refused; none leaves
        // the owner for EP06/coverage validation.
        const owners: string[] = [];
        for (const [phaseId, side] of memberSides) {
          if (side.supplied && side.values.includes(node.id)) owners.push(phaseId);
        }
        if (owners.length > 1) {
          return linkFailure({
            code: "link_conflict",
            [idField]: node.id,
            message: `${kind === "requirement" ? "Requirement" : "Task"} ${node.id} omits its accountable phase, but phases ${owners.join(", ")} both name it — ownership is ambiguous; author exactly one side.`,
          });
        }
        if (owners.length === 1) assignments.set(node, owners[0] as string);
      }
    }
    return undefined;
  };
  const ownershipFailure = resolveOwnership(
    "requirement",
    requirements,
    reqOwner,
    phaseReqs,
    phaseReqAdditions,
    reqOwnerAssignments,
    "requirementIds",
  ) ?? resolveOwnership(
    "task",
    tasks,
    taskOwner,
    phaseTasks,
    phaseTaskAdditions,
    taskOwnerAssignments,
    "contributingTaskIds",
  );
  if (ownershipFailure) return ownershipFailure;

  // Apply the complete reciprocal sets. Legitimately omitted sides are
  // initialized here — never pushed onto absent fields — while supplied
  // sides are never rewritten (additions only queued against omitted
  // sides). Authored array order is preserved throughout.
  const applyLinkAdditions = (
    targets: Map<string, SubmissionLinkNode>,
    additions: Map<string, string[]>,
    field: "requirementIds" | "contributingTaskIds",
    describe: (id: string, peer: string) => string,
  ): void => {
    for (const [id, values] of additions) {
      const node = targets.get(id);
      if (!node) continue;
      const record = node as unknown as Record<string, unknown>;
      const current = record[field];
      const list = Array.isArray(current)
        ? (current as string[])
        : ((record[field] = []) as string[]);
      for (const value of values) {
        if (!list.includes(value)) {
          list.push(value);
          derived.push(describe(id, value));
        }
      }
    }
  };
  applyLinkAdditions(taskById, taskReqAdditions, "requirementIds", (id, peer) => `task ${id} derives requirement ${peer}`);
  applyLinkAdditions(requirementById, reqContribAdditions, "contributingTaskIds", (id, peer) => `requirement ${id} derives task ${peer}`);
  applyLinkAdditions(phaseById, phaseReqAdditions, "requirementIds", (id, peer) => `phase ${id} derives requirement ${peer}`);
  applyLinkAdditions(phaseById, phaseTaskAdditions, "contributingTaskIds", (id, peer) => `phase ${id} derives task ${peer}`);
  for (const [node, phaseId] of reqOwnerAssignments) {
    (node as unknown as Record<string, unknown>)["accountablePhaseId"] = phaseId;
    derived.push(`requirement ${String(node.id)} derives accountable phase ${phaseId}`);
  }
  for (const [node, phaseId] of taskOwnerAssignments) {
    (node as unknown as Record<string, unknown>)["accountablePhaseId"] = phaseId;
    derived.push(`task ${String(node.id)} derives accountable phase ${phaseId}`);
  }
  return { ok: true, revision: copy as unknown as ExecutionPlanRevisionWithoutDigest, derived };
}


/**
 * The C5 submission boundary: stamp the kernel envelope (and requiredBase)
 * from actuals, then derive mirrored links. Runs before the digest is
 * calculated, so the digest binds the stamped submission. Returns the
 * normalized revision or the first fail-closed refusal.
 */
export function normalizePlanSubmission(
  revision: PlanSubmissionRevision,
  actuals: PlanSubmissionActuals,
): StampedPlanSubmission {
  const stamped = stampPlanSubmissionEnvelope(revision, actuals);
  if (!stamped.ok) return stamped;
  const timed = stampSubmissionTimestamps(stamped.revision, actuals);
  if (!timed.ok) return timed;
  const linked = deriveMirroredPlanLinks(timed.revision);
  if (!linked.ok) return linked;
  return { ok: true, revision: linked.revision, derived: [...stamped.derived, ...timed.derived, ...linked.derived] };
}
