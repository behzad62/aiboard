import type { AgentModel, AgentModelRequest, ModelTurn } from "../../src/agent-contracts.js";
import {
  buildExecutionPlanRevision,
  type ExecutionPlanPhase,
  type ExecutionTaskContract,
  type SourceRequirement,
} from "../../src/planning-contracts.js";
import {
  buildApprovedSourceManifest,
  validateApprovedSourceInput,
  type ApprovedSourceInputV1,
} from "../../src/native-planning-provisioner.js";
import type { RunnerProviderConfig } from "../../src/provider-config-store.js";
import type { SchedulerProjection } from "../../src/scheduler-store.js";
import { computeArtifactDigest } from "../../src/source-manifest.js";

/**
 * T8 test-only evidence-gated journey fixture. Minimal deterministic
 * single-requirement scenario plus synthetic Architect/worker/coverage
 * models that drive the real NativeBuildFactory/ControlServer/SQLite/Git
 * path to a ready plan without any external model service.
 *
 * Shape mirrors the proven T7c/T7d product journeys (one REQ, one phase,
 * one task) with T8 identities. The coverage reviewer is intentionally
 * minimal: only blind obligations plus verdict, which is all the scheduler
 * needs before ready. Delivery/verifier passes are out of scope for the
 * T8 source->plan->review->export->explicit-start gate.
 */

export const T8_CLOCK = "2026-10-07T00:00:00.000Z";
export const T8_SOURCE =
  "SECTION s1: MANDATORY. The value module must export the value 2.\r\nSECTION s2: OPERATIONAL. Keep the change to src/value.mjs only; caf\u00e9 stays byte-exact.\r\n";
export const T8_LOW_CONTENT = "export const value = 2;\n";
export const T8_VALUE_TEST =
  "import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../src/value.mjs'; test('value', () => assert.equal(value, 2));\n";

function sourceBytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"));
}

export function t8SourceInput(
  text: string,
  sections?: ApprovedSourceInputV1["sections"],
): ApprovedSourceInputV1 {
  return {
    version: 1,
    approval: "approved_spec",
    bytesBase64: Buffer.from(text).toString("base64"),
    mediaType: "text/plain",
    encoding: "utf-8",
    ...(sections !== undefined ? { sections } : {}),
  };
}

export function t8JourneySections(): [
  { id: string; startByte: number; endByte: number },
  { id: string; startByte: number; endByte: number },
] {
  const firstEnd = Buffer.byteLength(`${T8_SOURCE.split("\n")[0]!}\n`, "utf8");
  return [
    { id: "s1", startByte: 0, endByte: firstEnd },
    { id: "s2", startByte: firstEnd, endByte: Buffer.byteLength(T8_SOURCE, "utf8") },
  ];
}

export function t8JourneyScenario(runId: string) {
  const bytes = sourceBytes(T8_SOURCE);
  const validated = validateApprovedSourceInput(t8SourceInput(T8_SOURCE, [...t8JourneySections()]));
  const manifest = buildApprovedSourceManifest({
    runId,
    validated,
    artifactDigest: computeArtifactDigest(bytes),
    approvedBy: "local-user",
    createdAt: T8_CLOCK,
  });
  const requirements: SourceRequirement[] = [
    {
      id: "REQ-1",
      reference: { sourceId: manifest.sourceId, sectionIds: ["s1", "s2"] },
      purpose: "Export the value 2.",
      observableOutcome: "The value module exports 2.",
      obligationKind: "mandatory",
      applicability: { status: "applicable" },
      accountablePhaseId: "P1",
      contributingTaskIds: ["T1"],
      acceptanceConditions: [
        {
          id: "REQ-1-ac1",
          description: "value is 2.",
          responsibleGateId: "P1-exit",
          requiredEvidenceKinds: ["command"],
        },
      ],
    },
  ];
  const phases: ExecutionPlanPhase[] = [
    {
      id: "P1",
      purpose: "Deliver the value module.",
      requirementIds: ["REQ-1"],
      scope: { includes: ["src/value.mjs"], excludes: ["docs/project/STATE.md"] },
      entryConditions: ["Plan ready."],
      contributingTaskIds: ["T1"],
      exitCriteria: ["The value module is accepted."],
      requiredCombinedValidation: ["tests"],
      exitUnlocks: ["final verification"],
    },
  ];
  const tasks: ExecutionTaskContract[] = [
    {
      id: "T1",
      lineage: [],
      accountablePhaseId: "P1",
      requirementIds: ["REQ-1"],
      outcome: {
        user: "Create src/value.mjs exporting value = 2.",
        system: "The value module exports 2.",
      },
      scope: { includes: ["src/value.mjs"], excludes: ["test/value.test.mjs"] },
      writableSurfaces: ["src/value.mjs"],
      forbiddenSurfaces: ["test/value.test.mjs"],
      dependencies: [],
      requiredBase: "accepted plan revision revision_t8",
      inputs: ["accepted plan revision"],
      outputs: ["src/value.mjs"],
      steps: ["Write the module.", "Run the tests."],
      acceptance: {
        criteria: [{ id: "c1", text: "src/value.mjs exports value = 2 and the tests pass." }],
        definitionOfDone: "Tests pass.",
      },
      validation: {
        targetedRationale: "The value test.",
        affectedScopeRationale: "The module only.",
      },
      negativeProofApplicability: {
        applicable: false,
        rationale: "A new module has no prior-incorrect case.",
      },
      reviewCriteria: ["Independent review confirms the value."],
      integrationChecks: ["Post-integration tests."],
      cleanup: { cleanup: "None.", recovery: "Retry.", rollback: "Revert." },
      requirementCriteriaMap: [{ taskLocalCriterionId: "c1", requirementId: "REQ-1" }],
    },
  ];
  const revision = buildExecutionPlanRevision({
    revisionId: "revision_t8",
    runId,
    sourceManifestId: manifest.manifestId,
    sourceManifestDigest: manifest.artifactDigest,
    requirements,
    tasks,
    phases,
    workflowPolicyVersion: 1,
    planningDecisions: [],
    validationObligations: ["tests"],
    createdAt: T8_CLOCK,
  });
  return { manifest, requirements, phases, revision };
}

const journeyCall = (name: string, args: unknown, id: string): ModelTurn => ({
  blocks: [{ type: "tool_call", callId: id, name, arguments: args }],
  stopReason: "tool_calls",
  usage: { inputTokens: 8, outputTokens: 4 },
});

function journeyLastToolValue(request: AgentModelRequest): Record<string, unknown> | undefined {
  const message = [...request.messages].reverse().find((candidate) => candidate.role === "tool");
  const content = (message?.content as { content?: Array<{ type: string; value?: unknown }> } | undefined)
    ?.content;
  return content?.find((item) => item.type === "json")?.value as Record<string, unknown> | undefined;
}

export class T8JourneyArchitect implements AgentModel {
  readonly requests: AgentModelRequest[] = [];
  private calls = 0;
  constructor(
    private readonly projection: () => SchedulerProjection,
    private readonly scenario: ReturnType<typeof t8JourneyScenario>,
  ) {}
  private call(name: string, args: unknown): ModelTurn {
    this.calls += 1;
    return journeyCall(name, args, `t8-arch-${this.calls}`);
  }
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const projection = this.projection();
    const planning = projection.planning;
    if (projection.planningTriageDecision === undefined) {
      return this.call("record_triage", {
        decision: "build",
        rationale: "T8 product: change request with an approved source.",
      });
    }
    const manifestId = planning?.source.currentManifestId;
    if (!manifestId) throw new Error("the approved source is registered before planning reads");
    const reads = planning?.sourceReadIndex[manifestId] ?? {};
    const sections = this.scenario.manifest.sections;
    if (sections.some((section) => reads[section.id] !== section.digest)) {
      const pending = sections.find((section) => reads[section.id] !== section.digest)!;
      const seen = this.requests.length;
      if (seen <= 2) return this.call("read_planning_source_section", {});
      return this.call("read_planning_source_section", { sectionId: pending.id });
    }
    if (!planning?.ledger) {
      return this.call("persist_planning_ledger", {
        id: "ledger-1",
        requirements: this.scenario.requirements,
        phases: this.scenario.phases,
        nonNormativeSections: [],
      });
    }
    if (!planning?.plan) {
      const { digest: _digest, runId: _run, createdAt: _created, ...rest } =
        this.scenario.revision as unknown as Record<string, unknown>;
      void _digest;
      void _run;
      void _created;
      return this.call("draft_planning_plan", { revision: rest });
    }
    if (Object.keys(planning?.coverageRequests ?? {}).length === 0) {
      return this.call("request_coverage_review", { reviewId: "coverage_t8" });
    }
    const task = projection.tasks.T1!;
    if (task.status === "submitted" || task.status === "architect_review") {
      const links = task.criterionEvidenceLinks ?? [];
      return this.call("review_task", {
        taskId: "T1",
        decision: "approved",
        summary: "The deliverable review is satisfied and the evidence passes.",
        evidenceArtifactHashes: [...new Set(links.flatMap((link) => link.artifactHashes))],
        criterionVerdicts: [
          {
            criterionId: "c1",
            verdict: "satisfied",
            rationale: "Tests pass.",
            evidenceIds: links.map((link) => link.evidenceId),
            artifactHashes: [...new Set(links.flatMap((link) => link.artifactHashes))],
          },
        ],
      });
    }
    if (task.status === "approved") return this.call("request_integration", { taskId: "T1" });
    throw new Error(`T8 journey script exhausted at T1 ${task.status}.`);
  }
}

export class T8JourneyWorker implements AgentModel {
  readonly requests: AgentModelRequest[] = [];
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const toolCount = request.messages.filter((message) => message.role === "tool").length;
    if (toolCount === 0) {
      return journeyCall(
        "fs.write",
        { path: "src/value.mjs", content: T8_LOW_CONTENT, createDirectories: true },
        "write-1",
      );
    }
    if (toolCount === 1) {
      return journeyCall(
        "run_evidence_command",
        { label: "tests", command: process.execPath, args: ["--test"] },
        "evidence-1",
      );
    }
    const record = journeyLastToolValue(request)!;
    const fact = record.fact as { stdoutArtifactHash: string };
    return journeyCall(
      "submit_task",
      {
        summary: "Added src/value.mjs exporting value = 2; node --test passes.",
        readiness: "ready_for_architect_review",
        unresolvedConcerns: [],
        criterionEvidenceLinks: [
          { criterionId: "c1", evidenceId: record.id, artifactHashes: [fact.stdoutArtifactHash] },
        ],
      },
      "submit-1",
    );
  }
}

export class T8JourneyCoverageReviewer implements AgentModel {
  readonly requests: AgentModelRequest[] = [];
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const tools = new Set(request.tools.map((tool) => tool.name));
    const seen = request.messages.filter((message) => message.role === "tool").length;
    if (tools.has("record_coverage_obligations")) {
      return journeyCall(
        "record_coverage_obligations",
        {
          obligations: [{ id: "obl-REQ-1", description: "Export the value 2.", requirementId: "REQ-1" }],
          sectionCoverage: [
            { sectionId: "s1", obligationIds: ["obl-REQ-1"] },
            { sectionId: "s2", obligationIds: ["obl-REQ-1"] },
          ],
        },
        `obl-${seen}`,
      );
    }
    if (tools.has("submit_coverage_verdict")) {
      return journeyCall(
        "submit_coverage_verdict",
        {
          obligationVerdicts: [
            {
              obligationId: "obl-REQ-1",
              verdict: "covered",
              severity: "advisory",
              rationale: "T1 covers it.",
              evidenceRefs: ["ledger:REQ-1"],
            },
          ],
          findings: [],
        },
        `verdict-${seen}`,
      );
    }
    throw new Error(`T8 coverage reviewer received unexpected tools: ${[...tools].join(", ")}.`);
  }
}

export function t8Provider(runtimeId: string, priority: number): RunnerProviderConfig {
  const [providerId, modelId] = runtimeId.split(":");
  return {
    runtimeId,
    providerId: providerId!,
    modelId: modelId!,
    transport: "openai-compatible",
    baseUrl: "http://127.0.0.1:9",
    secret: "unused",
    capabilities: ["code"],
    priority,
  };
}
