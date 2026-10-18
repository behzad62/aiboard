/**
 * Published input schemas for the evidence-gated planning tools. The tools used to declare their
 * payloads as bare `{ type: "object" }` / `{ type: "array" }`, so models could only guess the
 * contract: the tunnel test run's DeepSeek Architect tried ~40 field names before asking the owner,
 * and P7's Architects read runner source to learn it. These mirror planning-contracts.ts
 * (SourceRequirement, ExecutionPlanPhase, ExecutionTaskContract and their PlanSubmission* forms).
 * They describe and guide; the kernel validators stay the authority, so properties are documented
 * but additional ones are not rejected here.
 */

import { PHASE_VALIDATION_CHECKS } from "./planning-contracts.js";

type Schema = Record<string, unknown>;

const text = (description?: string): Schema =>
  ({ type: "string", minLength: 1, ...(description ? { description } : {}) });
const nonEmptyTexts = (description?: string): Schema =>
  ({ type: "array", minItems: 1, items: { type: "string", minLength: 1 }, ...(description ? { description } : {}) });
const texts = (description?: string): Schema =>
  ({ type: "array", items: { type: "string" }, ...(description ? { description } : {}) });

export const REQUIREMENT_SCHEMA: Schema = {
  type: "object",
  description: "One requirement derived from the approved source.",
  properties: {
    id: text("Requirement id, e.g. AC1."),
    reference: {
      type: "object",
      description: "Links the requirement to the approved source: the current manifest's sourceId and the section ids it comes from.",
      properties: {
        sourceId: text("The approved source id (src-...)."),
        sectionIds: { type: "array", minItems: 1, items: { type: "string" }, description: "Manifest section ids, e.g. [\"section-1\"]." },
      },
      required: ["sourceId", "sectionIds"],
    },
    purpose: text(),
    observableOutcome: text(),
    obligationKind: { type: "string", enum: ["mandatory", "conditional", "compatibility", "operational", "security", "non_functional"] },
    applicability: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["applicable", "conditional_pending", "not_applicable"] },
        conditionExpression: text("Required when status is conditional_pending."),
      },
      required: ["status"],
    },
    accountablePhaseId: text("The phase accountable for this requirement. Every phase must be accountable for at least one requirement (a setup phase owns e.g. the workspace/build requirement)."),
    contributingTaskIds: texts("Omit in a plan revision: the kernel derives it from each task's requirementIds. If supplied it must match those tasks exactly, or the draft is refused."),
    dependsOnRequirementIds: texts(),
    acceptanceConditions: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          id: text(),
          description: text(),
          responsibleGateId: text("Free-form gate id that proves it, e.g. e2e-tests."),
          requiredEvidenceKinds: { type: "array", minItems: 1, items: { type: "string" }, description: "e.g. [\"test\"]." },
        },
        required: ["id", "description", "responsibleGateId", "requiredEvidenceKinds"],
      },
    },
  },
  required: ["id", "reference", "purpose", "observableOutcome", "obligationKind", "applicability", "acceptanceConditions"],
};

export const PHASE_SCHEMA: Schema = {
  type: "object",
  properties: {
    id: text(),
    purpose: text(),
    requirementIds: texts("Omit: derived from the requirements whose accountablePhaseId is this phase (must come out non-empty)."),
    scope: {
      type: "object",
      properties: { includes: texts(), excludes: texts() },
      required: ["includes", "excludes"],
    },
    entryConditions: nonEmptyTexts(),
    contributingTaskIds: texts("Omit: derived from the tasks whose accountablePhaseId is this phase (must come out non-empty)."),
    exitCriteria: nonEmptyTexts(),
    requiredCombinedValidation: {
      type: "array",
      minItems: 1,
      items: { type: "string", enum: Object.keys(PHASE_VALIDATION_CHECKS) },
      description: "Runner-checkable validation keywords only (the runner runs them at the phase exit); put free-text checks in exitCriteria.",
    },
    exitUnlocks: nonEmptyTexts("What finishing this phase unlocks; must be non-empty even for the last phase (e.g. \"run-completion\")."),
  },
  required: ["id", "purpose", "scope", "entryConditions", "exitCriteria", "requiredCombinedValidation", "exitUnlocks"],
};

export const TASK_CONTRACT_SCHEMA: Schema = {
  type: "object",
  description: "A complete task contract. requiredBase, accountablePhaseId and requirementIds may be omitted (kernel-derived).",
  properties: {
    id: text(),
    lineage: texts("Prior task ids this task replaces or splits from; [] for new tasks."),
    accountablePhaseId: text(),
    requirementIds: texts("The requirements this task delivers: the one place requirement-task links are written."),
    outcome: {
      type: "object",
      properties: { user: text("The user-visible outcome (workers run exactly this)."), system: text() },
      required: ["user", "system"],
    },
    scope: { type: "object", properties: { includes: texts(), excludes: texts() }, required: ["includes", "excludes"] },
    writableSurfaces: texts("Paths/globs the task may write."),
    forbiddenSurfaces: texts(),
    sharedResourceClaims: texts(),
    dependencies: texts("Task ids that must finish first."),
    inputs: texts(),
    outputs: texts(),
    steps: texts(),
    acceptance: {
      type: "object",
      properties: {
        criteria: {
          type: "array",
          minItems: 1,
          items: { type: "object", properties: { id: text(), text: text() }, required: ["id", "text"] },
        },
        definitionOfDone: text(),
      },
      required: ["criteria", "definitionOfDone"],
    },
    validation: {
      type: "object",
      properties: { targetedRationale: text(), affectedScopeRationale: text() },
      required: ["targetedRationale", "affectedScopeRationale"],
    },
    negativeProofApplicability: {
      type: "object",
      properties: { applicable: { type: "boolean" }, rationale: text() },
      required: ["applicable", "rationale"],
    },
    reviewCriteria: texts(),
    integrationChecks: texts(),
    cleanup: {
      type: "object",
      properties: { cleanup: text(), recovery: text(), rollback: text() },
      required: ["cleanup", "recovery", "rollback"],
    },
    investigation: {
      type: "object",
      description: "Only for investigation tasks.",
      properties: { question: text(), deliverable: text(), decisionCriterion: text(), dependentUnlockTaskIds: texts() },
      required: ["question", "deliverable", "decisionCriterion", "dependentUnlockTaskIds"],
    },
    requirementCriteriaMap: {
      type: "array",
      description: "Maps each task-local acceptance criterion id to the requirement it proves.",
      items: {
        type: "object",
        properties: { taskLocalCriterionId: text(), requirementId: text() },
        required: ["taskLocalCriterionId", "requirementId"],
      },
    },
  },
  required: [
    "id", "lineage", "outcome", "scope", "writableSurfaces", "forbiddenSurfaces", "dependencies", "inputs",
    "outputs", "steps", "acceptance", "validation", "negativeProofApplicability", "reviewCriteria",
    "integrationChecks", "cleanup", "requirementCriteriaMap",
  ],
};

export const PLAN_REVISION_SCHEMA: Schema = {
  type: "object",
  description: "A plan revision. Envelope fields (runId, sourceManifestId/Digest, workflowPolicyVersion, createdAt, coverageReviewId, repairBudgetLineageId) are kernel-stamped; omit them.",
  properties: {
    revisionId: text("A new id for each revision."),
    requirements: { type: "array", minItems: 1, items: REQUIREMENT_SCHEMA },
    phases: { type: "array", minItems: 1, items: PHASE_SCHEMA },
    tasks: { type: "array", minItems: 1, items: TASK_CONTRACT_SCHEMA },
    planningDecisions: {
      type: "array",
      items: { type: "object", properties: { id: text(), description: text() }, required: ["id", "description"] },
    },
    validationObligations: texts(),
  },
  required: ["revisionId", "requirements", "phases", "tasks", "planningDecisions", "validationObligations"],
};
