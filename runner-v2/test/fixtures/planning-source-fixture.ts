import {
  buildSourceManifest,
  type ApprovedSourceManifest,
} from "../../src/source-manifest.js";
import {
  buildExecutionPlanRevision,
  T1A_SEEDED_HOST_PLANNING_CAPABILITIES,
  type CoverageReview,
  type ExecutionPlanPhase,
  type ExecutionPlanRevision,
  type ExecutionTaskContract,
  type HostPlanningCapabilities,
  type SourceRequirement,
} from "../../src/planning-contracts.js";

/**
 * A complete synthetic spec fixture covering mandatory, conditional,
 * compatibility, operational, security, and non-functional obligations, plus
 * one authorized not_applicable retirement and one approved amendment.
 * Every obligation and source section is preserved across the fixture.
 */

const BASE_TEXT = [
  "SECTION 1: MANDATORY. The system must preserve every approved source obligation.",
  "SECTION 2: CONDITIONAL. If the host supports launch chips, prepare non-executing chips.",
  "SECTION 3: COMPATIBILITY. Legacy plan_only runs must remain readable and unmodified.",
  "SECTION 4: OPERATIONAL. Resume must reconcile actual worktree and evidence state.",
  "SECTION 5: SECURITY. Workers must never self-accept their own submitted work.",
  "SECTION 6: NON-FUNCTIONAL. Coverage review must complete within bounded reads.",
  "SECTION 7: RETIRED. This legacy obligation was superseded by amendment amend-1.",
].join("\n");

function sectionSpans(text: string): { id: string; startByte: number; endByte: number }[] {
  const lines = text.split("\n");
  const bytes = Buffer.from(text, "utf-8");
  const spans: { id: string; startByte: number; endByte: number }[] = [];
  let offset = 0;
  for (const [index, line] of lines.entries()) {
    const lineBytes = Buffer.from(line + (index < lines.length - 1 ? "\n" : ""), "utf-8");
    spans.push({ id: `s${index + 1}`, startByte: offset, endByte: offset + lineBytes.length });
    offset += lineBytes.length;
  }
  if (offset !== bytes.length) {
    throw new Error("Fixture section spans do not cover the full artifact byte length.");
  }
  return spans;
}

export function buildBaseManifest(): ApprovedSourceManifest {
  const bytes = Buffer.from(BASE_TEXT, "utf-8");
  return buildSourceManifest(bytes, sectionSpans(BASE_TEXT), {
    manifestId: "manifest_base",
    sourceId: "source_fixture",
    mediaType: "text/plain",
    encoding: "utf-8",
    authority: "owner",
    createdAt: "2026-09-08T00:00:00.000Z",
  });
}

const AMENDED_TEXT = BASE_TEXT + "\nSECTION 8: AMENDMENT. Section 7 is retired by this amendment.";

export function buildAmendedManifest(prior: ApprovedSourceManifest): ApprovedSourceManifest {
  const bytes = Buffer.from(AMENDED_TEXT, "utf-8");
  return buildSourceManifest(bytes, sectionSpans(AMENDED_TEXT), {
    manifestId: "manifest_amend_1",
    sourceId: "source_fixture",
    mediaType: "text/plain",
    encoding: "utf-8",
    authority: "owner",
    createdAt: "2026-09-22T00:00:00.000Z",
    amendment: {
      id: "amend-1",
      priorManifestId: prior.manifestId,
      priorArtifactDigest: prior.artifactDigest,
      authorizedBy: "owner",
      rationale: "Retire the legacy section 7 obligation and record its replacement.",
    },
  });
}

export const FIXTURE_PHASES: ExecutionPlanPhase[] = [
  {
    id: "BP1",
    purpose: "Source preservation, complete contracts and durable authority.",
    requirementIds: ["REQ-MANDATORY", "REQ-COMPAT", "REQ-SECURITY", "REQ-RETIRED"],
    scope: { includes: ["runner-v2/src/source-manifest.ts", "runner-v2/src/planning-contracts.ts"], excludes: ["runner-v2/src/scheduler-store.ts"] },
    entryConditions: ["P6, P6.5 and the agent-capability program are accepted."],
    contributingTaskIds: ["T1", "T2", "T4"],
    exitCriteria: ["Complete schema/replay/compatibility proof and accepted contracts."],
    requiredCombinedValidation: ["typecheck", "targeted-tests"],
    exitUnlocks: ["BP2"],
  },
  {
    id: "BP2",
    purpose: "Independently reviewed planning with no execution.",
    requirementIds: ["REQ-CONDITIONAL", "REQ-OPERATIONAL", "REQ-NONFUNC"],
    scope: { includes: ["runner-v2/src/planning-tools.ts"], excludes: ["runner-v2/src/build-runtime.ts"] },
    entryConditions: ["BP1 accepted."],
    contributingTaskIds: ["T3", "T5", "T-INV"],
    exitCriteria: ["A source-complete reviewed plan can reach ready."],
    requiredCombinedValidation: ["typecheck", "targeted-tests"],
    exitUnlocks: ["BP3", "BP4"],
  },
];

export function buildFixtureRequirements(manifest: ApprovedSourceManifest): SourceRequirement[] {
  const ref = (sectionId: string) => ({ sourceId: manifest.sourceId, sectionIds: [sectionId] });
  const condition = (id: string, gate: string) => [
    { id: `${id}-ac1`, description: `${id} is observably satisfied.`, responsibleGateId: gate, requiredEvidenceKinds: ["command"] },
  ];
  return [
    {
      id: "REQ-MANDATORY",
      reference: ref("s1"),
      purpose: "Preserve every approved source obligation.",
      observableOutcome: "The requirement ledger never silently drops an obligation.",
      obligationKind: "mandatory",
      applicability: { status: "applicable" },
      accountablePhaseId: "BP1",
      contributingTaskIds: ["T1"],
      acceptanceConditions: condition("REQ-MANDATORY", "BP1-exit"),
    },
    {
      id: "REQ-CONDITIONAL",
      reference: ref("s2"),
      purpose: "Prepare non-executing chips only when a host API exists.",
      observableOutcome: "Chip preparation is used only where actually supported.",
      obligationKind: "conditional",
      applicability: { status: "conditional_pending", conditionExpression: "host launch-chip API exists" },
      accountablePhaseId: "BP2",
      contributingTaskIds: ["T-INV"],
      acceptanceConditions: condition("REQ-CONDITIONAL", "BP2-exit"),
    },
    {
      id: "REQ-COMPAT",
      reference: ref("s3"),
      purpose: "Preserve legacy plan_only readability.",
      observableOutcome: "Old completed plan_only runs remain readable, unconverted.",
      obligationKind: "compatibility",
      applicability: { status: "applicable" },
      accountablePhaseId: "BP1",
      contributingTaskIds: ["T2"],
      acceptanceConditions: condition("REQ-COMPAT", "BP1-exit"),
    },
    {
      id: "REQ-OPERATIONAL",
      reference: ref("s4"),
      purpose: "Resume reconciles actual state.",
      observableOutcome: "Resume never infers success from an interrupted command.",
      obligationKind: "operational",
      applicability: { status: "applicable" },
      accountablePhaseId: "BP2",
      contributingTaskIds: ["T3"],
      acceptanceConditions: condition("REQ-OPERATIONAL", "BP2-exit"),
    },
    {
      id: "REQ-SECURITY",
      reference: ref("s5"),
      purpose: "Workers cannot self-accept.",
      observableOutcome: "submit_task never sets an accepted status.",
      obligationKind: "security",
      applicability: { status: "applicable" },
      accountablePhaseId: "BP1",
      contributingTaskIds: ["T4"],
      acceptanceConditions: condition("REQ-SECURITY", "BP1-exit"),
    },
    {
      id: "REQ-NONFUNC",
      reference: ref("s6"),
      purpose: "Coverage review completes within bounded reads.",
      observableOutcome: "The full source inventory is read without truncation.",
      obligationKind: "non_functional",
      applicability: { status: "applicable" },
      accountablePhaseId: "BP2",
      contributingTaskIds: ["T5"],
      acceptanceConditions: condition("REQ-NONFUNC", "BP2-exit"),
    },
    {
      id: "REQ-RETIRED",
      reference: { sourceId: manifest.sourceId, sectionIds: ["s7", "s8"] },
      purpose: "Legacy obligation superseded by amendment amend-1.",
      observableOutcome: "Retirement is authorized and evidenced, never silent.",
      obligationKind: "mandatory",
      applicability: {
        status: "not_applicable",
        disposition: {
          authorizedBy: "owner",
          rationale: "Superseded by amendment amend-1, section 8.",
          amendmentRef: "amend-1",
          decidedAt: "2026-09-22T00:00:00.000Z",
        },
      },
      accountablePhaseId: "BP1",
      contributingTaskIds: [],
      acceptanceConditions: [],
    },
  ];
}

function task(overrides: Partial<ExecutionTaskContract> & { id: string }): ExecutionTaskContract {
  const writableSurface = `runner-v2/src/${overrides.id.toLowerCase()}.ts`;
  return {
    lineage: [],
    accountablePhaseId: "BP1",
    requirementIds: [],
    outcome: { user: "A user-observable outcome.", system: "A system-observable outcome." },
    scope: { includes: [writableSurface], excludes: ["runner-v2/src/unrelated.ts"] },
    writableSurfaces: [writableSurface],
    forbiddenSurfaces: ["runner-v2/src/scheduler-store.ts"],
    dependencies: [],
    requiredBase: "accepted plan revision revision_1",
    inputs: ["accepted plan revision"],
    outputs: ["implemented behavior"],
    steps: ["Inspect the actual repository.", "Implement the behavior.", "Validate targeted and affected scope."],
    acceptance: {
      criteria: [{ id: "c1", text: "Behavior matches the requirement's observable outcome." }],
      definitionOfDone: "All acceptance conditions pass with current evidence.",
    },
    validation: { targetedRationale: "Exact new/changed behavior.", affectedScopeRationale: "Callers and shared contracts." },
    negativeProofApplicability: { applicable: true, rationale: "A prior-incorrect case is available to prove." },
    reviewCriteria: ["Independent review confirms the requirement is satisfied."],
    integrationChecks: ["Post-integration affected-boundary check."],
    cleanup: {
      cleanup: "Remove any scratch files created during the task.",
      recovery: "Retry from the last durable checkpoint.",
      rollback: "Revert the task's isolated worktree.",
    },
    requirementCriteriaMap: [],
    ...overrides,
  };
}

export function buildFixtureTasks(): ExecutionTaskContract[] {
  return [
    task({
      id: "T1",
      accountablePhaseId: "BP1",
      requirementIds: ["REQ-MANDATORY"],
      requirementCriteriaMap: [{ taskLocalCriterionId: "c1", requirementId: "REQ-MANDATORY" }],
    }),
    task({
      id: "T2",
      accountablePhaseId: "BP1",
      requirementIds: ["REQ-COMPAT"],
      dependencies: ["T1"],
      requirementCriteriaMap: [{ taskLocalCriterionId: "c1", requirementId: "REQ-COMPAT" }],
    }),
    task({
      id: "T3",
      accountablePhaseId: "BP2",
      requirementIds: ["REQ-OPERATIONAL"],
      requirementCriteriaMap: [{ taskLocalCriterionId: "c1", requirementId: "REQ-OPERATIONAL" }],
    }),
    task({
      id: "T4",
      accountablePhaseId: "BP1",
      requirementIds: ["REQ-SECURITY"],
      dependencies: ["T1"],
      requirementCriteriaMap: [{ taskLocalCriterionId: "c1", requirementId: "REQ-SECURITY" }],
    }),
    task({
      id: "T5",
      accountablePhaseId: "BP2",
      requirementIds: ["REQ-NONFUNC"],
      dependencies: ["T3"],
      requirementCriteriaMap: [{ taskLocalCriterionId: "c1", requirementId: "REQ-NONFUNC" }],
    }),
    task({
      id: "T-INV",
      accountablePhaseId: "BP2",
      requirementIds: ["REQ-CONDITIONAL"],
      investigation: {
        question: "Does any supported host expose a non-executing launch-chip API?",
        deliverable: "A recorded host-capability observation.",
        decisionCriterion: "An actual API call site is found, or none exists.",
        dependentUnlockTaskIds: ["T3"],
      },
      requirementCriteriaMap: [{ taskLocalCriterionId: "c1", requirementId: "REQ-CONDITIONAL" }],
    }),
  ];
}

export function buildFixtureRevision(manifest: ApprovedSourceManifest): ExecutionPlanRevision {
  return buildExecutionPlanRevision({
    revisionId: "revision_1",
    runId: "run_fixture",
    sourceManifestId: manifest.manifestId,
    sourceManifestDigest: manifest.artifactDigest,
    requirements: buildFixtureRequirements(manifest),
    tasks: buildFixtureTasks(),
    phases: FIXTURE_PHASES,
    workflowPolicyVersion: 1,
    planningDecisions: [{ id: "D3", description: "Node 24.x (OA-9).", decidedAt: "2026-09-22T00:00:00.000Z" }],
    validationObligations: ["typecheck", "targeted-tests"],
    createdAt: "2026-09-08T00:00:00.000Z",
  });
}

export function buildFixtureCoverageReview(revision: ExecutionPlanRevision, manifest: ApprovedSourceManifest): CoverageReview {
  const requirementIds = ["REQ-MANDATORY", "REQ-CONDITIONAL", "REQ-COMPAT", "REQ-OPERATIONAL", "REQ-SECURITY", "REQ-NONFUNC", "REQ-RETIRED"];
  return {
    id: "coverage_1",
    runId: "run_fixture",
    reviewerRuntimeId: "reviewer:distinct-model",
    independence: "distinct_model",
    sourceReadManifestId: manifest.manifestId,
    planRevisionId: revision.revisionId,
    planRevisionDigest: revision.digest,
    derivedObligations: requirementIds.map((id) => ({
      id: `obl-${id}`,
      requirementId: id,
      description: `Derived obligation for ${id}.`,
      recordedBeforePlanOrDiffProvided: true,
      recordedAt: "2026-09-08T00:05:00.000Z",
    })),
    obligationVerdicts: requirementIds.map((id) => ({
      obligationId: `obl-${id}`,
      verdict: "covered",
      severity: "advisory",
      rationale: `${id} is exercised by its contributing task(s) or an authorized disposition.`,
      evidenceRefs: [`ledger:${id}`],
    })),
    findings: [],
    recordedAt: "2026-09-08T00:10:00.000Z",
  };
}

export function buildFixtureHostCapabilities(): HostPlanningCapabilities {
  return T1A_SEEDED_HOST_PLANNING_CAPABILITIES;
}

export interface PlanningFixtureScenario {
  /** The active manifest requirements/revision/review are validated against. It IS an amendment (amendment.id = "amend-1"). */
  readonly manifest: ApprovedSourceManifest;
  /** @deprecated alias of `manifest`, kept for call sites that still say "the amended manifest". */
  readonly amendedManifest: ApprovedSourceManifest;
  /** The unamended predecessor manifest `manifest` supersedes (7 sections, no amendment). */
  readonly priorManifest: ApprovedSourceManifest;
  readonly phases: ExecutionPlanPhase[];
  readonly requirements: SourceRequirement[];
  readonly tasks: ExecutionTaskContract[];
  readonly revision: ExecutionPlanRevision;
  readonly coverageReview: CoverageReview;
  readonly hostCapabilities: HostPlanningCapabilities;
}

export function buildPlanningFixtureScenario(): PlanningFixtureScenario {
  const priorManifest = buildBaseManifest();
  const manifest = buildAmendedManifest(priorManifest);
  const revision = buildFixtureRevision(manifest);
  return {
    manifest,
    amendedManifest: manifest,
    priorManifest,
    phases: FIXTURE_PHASES,
    requirements: buildFixtureRequirements(manifest),
    tasks: buildFixtureTasks(),
    revision,
    coverageReview: buildFixtureCoverageReview(revision, manifest),
    hostCapabilities: buildFixtureHostCapabilities(),
  };
}
