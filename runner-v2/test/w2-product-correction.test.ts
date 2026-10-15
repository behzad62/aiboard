import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureGitBaseline, runGit } from "./support/git-fixture.js";
import type { AgentModel, AgentModelRequest, ModelTurn } from "../src/agent-contracts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { ControlServer } from "../src/control-server.js";
import { RunSupervisor } from "../src/run-supervisor.js";
import { SqliteEventStore } from "../src/sqlite-event-store.js";
import { SqliteBuildSpecStore } from "../src/sqlite-build-spec-store.js";
import { createExecutionHost } from "../src/execution-host.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { NativeBuildManager } from "../src/native-build-manager.js";
import type { RunnerProviderConfig } from "../src/provider-config-store.js";
import { buildExecutionPlanRevision, type ExecutionPlanPhase, type SourceRequirement } from "../src/planning-contracts.js";
import { NativeBuildFactory } from "../src/native-build-factory.js";
import { buildApprovedSourceManifest, validateApprovedSourceInput, type ApprovedSourceInputV1 } from "../src/native-planning-provisioner.js";
import { currentExplicitStartIdentity, type SchedulerProjection } from "../src/scheduler-store.js";
import { computeArtifactDigest } from "../src/source-manifest.js";

/**
 * W2 product correction (CD7): an authentic unseeded authenticated
 * NativeBuildFactory -> BuildRuntime.step journey over real SQLite/Git
 * proving delta-first re-review and bounded late findings.
 *
 * Attempt 1 ships value 2 plus an unpinned helper and fails on a real
 * blocking guard finding. Attempt 2 fixes only the reviewed file: the
 * re-review gets criteria, then the actual fix delta, then delta files
 * with no prior finding names, then invalidated evidence — blind, with
 * the full cumulative up front only because the retry escalates to high
 * tier. Its new observation on unchanged already-reviewed code lands in
 * nonblocking follow-up, the prior guard resolves, and the task accepts
 * within the normal two attempts.
 * Only the model transport is scripted; Git, SQLite, the scheduler,
 * sessions, artifacts and evidence are all real.
 */
const W2_RUN = "run_w2_product_correction";
const W2_CLOCK = "2026-10-03T00:00:00.000Z";
const W2_SOURCE = "SECTION s1: MANDATORY. The value module must export the value 2 with an upper-bound guard.\r\nSECTION s2: OPERATIONAL. Maintain the value behavior and its tests.\r\n";
const W2_VALUE_TEST = "import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../src/value.mjs'; test('value criterion', () => assert.equal(value, 2));\n";
const W2_VALUE_V1 = "export const value = 2;\n";
const W2_VALUE_V2 = "export const value = 2;\nexport const capped = Math.min(value, 9);\n";
const W2_EXTRA = "export const extra = 42;\n";

function w2SourceBytes(text: string): Uint8Array { return new Uint8Array(Buffer.from(text, "utf8")); }

function w2SourceInput(text: string): ApprovedSourceInputV1 {
  const firstEnd = Buffer.byteLength(`${text.split("\n")[0]!}\n`, "utf8");
  return {
    version: 1, approval: "approved_spec", bytesBase64: Buffer.from(text).toString("base64"),
    mediaType: "text/plain", encoding: "utf-8",
    sections: [
      { id: "s1", startByte: 0, endByte: firstEnd },
      { id: "s2", startByte: firstEnd, endByte: Buffer.byteLength(text, "utf8") },
    ],
  };
}

function w2JourneyScenario(runId: string) {
  const bytes = w2SourceBytes(W2_SOURCE);
  const validated = validateApprovedSourceInput(w2SourceInput(W2_SOURCE));
  const manifest = buildApprovedSourceManifest({
    runId, validated, artifactDigest: computeArtifactDigest(bytes), approvedBy: "local-user", createdAt: W2_CLOCK,
  });
  const requirements: SourceRequirement[] = [{
    id: "REQ-1",
    reference: { sourceId: manifest.sourceId, sectionIds: ["s1", "s2"] },
    purpose: "Export the value 2 with a guard.",
    observableOutcome: "The value module exports 2 with an upper-bound guard.",
    obligationKind: "mandatory",
    applicability: { status: "applicable" },
    accountablePhaseId: "P1",
    contributingTaskIds: ["T1"],
    acceptanceConditions: [{ id: "REQ-1-ac1", description: "value is 2 with a guard.", responsibleGateId: "P1-exit", requiredEvidenceKinds: ["command"] }],
  }];
  const phases: ExecutionPlanPhase[] = [{
    id: "P1",
    purpose: "Deliver the value module.",
    requirementIds: ["REQ-1"],
    scope: { includes: ["src/value.mjs", "src/extra.mjs", "test/value.test.mjs", "package.json"], excludes: [] },
    entryConditions: ["Plan ready."],
    contributingTaskIds: ["T1"],
    exitCriteria: ["The value module is accepted."],
    requiredCombinedValidation: ["tests"],
    exitUnlocks: ["final verification"],
  }];
  const revision = buildExecutionPlanRevision({
    revisionId: "revision_w2",
    runId,
    sourceManifestId: manifest.manifestId,
    sourceManifestDigest: manifest.artifactDigest,
    requirements,
    tasks: [{
      id: "T1",
      lineage: [],
      accountablePhaseId: "P1",
      requirementIds: ["REQ-1"],
      outcome: { user: "Create src/value.mjs exporting value = 2 with an upper-bound guard.", system: "The value module exports 2 with a guard." },
      scope: { includes: ["src/value.mjs", "src/extra.mjs", "test/value.test.mjs", "package.json"], excludes: [] },
      writableSurfaces: ["src/value.mjs", "src/extra.mjs", "test/value.test.mjs", "package.json"],
      forbiddenSurfaces: ["infra/**", "docs/plans/**"],
      dependencies: [],
      requiredBase: "accepted plan revision revision_w2",
      inputs: ["accepted plan revision"],
      outputs: ["src/value.mjs"],
      steps: ["Write the module.", "Run the tests."],
      acceptance: { criteria: [{ id: "c1", text: "src/value.mjs exports value = 2 with an upper-bound guard and the tests pass." }], definitionOfDone: "Tests pass." },
      validation: { targetedRationale: "The value test.", affectedScopeRationale: "The module only." },
      negativeProofApplicability: { applicable: false, rationale: "A new module has no prior-incorrect case." },
      reviewCriteria: ["Independent review confirms the value and the guard."],
      integrationChecks: ["Post-integration tests."],
      cleanup: { cleanup: "None.", recovery: "Retry.", rollback: "Revert." },
      requirementCriteriaMap: [{ taskLocalCriterionId: "c1", requirementId: "REQ-1" }],
    }],
    phases,
    workflowPolicyVersion: 1,
    planningDecisions: [],
    validationObligations: ["tests"],
    createdAt: W2_CLOCK,
  });
  return { manifest, requirements, phases, revision };
}

const w2Call = (name: string, args: unknown, id: string): ModelTurn => ({
  blocks: [{ type: "tool_call", callId: id, name, arguments: args }],
  stopReason: "tool_calls",
  usage: { inputTokens: 8, outputTokens: 4 },
});

function w2JourneyEnvironment() {
  const ambient = { ...snapshotNativeBuildAmbientEnvironment() };
  delete ambient.NODE_TEST_CONTEXT;
  return Object.freeze(ambient);
}

function w2LastToolValue(request: AgentModelRequest): Record<string, unknown> | undefined {
  const message = [...request.messages].reverse().find((candidate) => candidate.role === "tool");
  const content = (message?.content as { content?: Array<{ type: string; value?: unknown }> } | undefined)?.content;
  return content?.find((item) => item.type === "json")?.value as Record<string, unknown> | undefined;
}

function w2ToolResults(request: AgentModelRequest): Array<{ toolName?: string; isError?: boolean }> {
  return request.messages
    .filter((message) => message.role === "tool")
    .map((message) => (message.content ?? {}) as { toolName?: string; isError?: boolean });
}

function w2ReadText(request: AgentModelRequest, path: string): string | undefined {
  for (const message of request.messages) {
    if (message.role !== "tool") continue;
    const content = message.content as { toolName?: string; content?: Array<{ type: string; value?: unknown; text?: string }> };
    if (content.toolName !== "fs.read") continue;
    const meta = content.content?.find((item) => item.type === "json")?.value as { path?: string } | undefined;
    if (meta?.path !== path) continue;
    const text = content.content?.find((item) => item.type === "text")?.text;
    if (typeof text === "string") return text;
  }
  return undefined;
}

function w2HasToolResult(request: AgentModelRequest, toolName: string): boolean {
  return w2ToolResults(request).some((result) => result.toolName === toolName && result.isError !== true);
}

function w2ToolFailed(request: AgentModelRequest, toolName: string): boolean {
  return w2ToolResults(request).some((result) => result.toolName === toolName && result.isError === true);
}

function w2FailureDetail(request: AgentModelRequest, toolName: string): string {
  const failed = request.messages.filter((message) => message.role === "tool").reverse().find((message) => {
    const content = message.content as { toolName?: string; isError?: boolean } | undefined;
    return content?.toolName === toolName && content.isError === true;
  });
  return failed ? JSON.stringify(failed.content).slice(0, 800) : "no detail";
}

// Failures keyed by call-id prefix: every scripted call id embeds its
// purpose, so a repeated failure maps back to the exact re-issued call.
function w2CallFailures(request: AgentModelRequest, prefix: string): string[] {
  const details: string[] = [];
  for (const message of request.messages) {
    if (message.role !== "tool") continue;
    const content = message.content as { callId?: string; isError?: boolean; content?: Array<{ type: string; text?: string }> } | undefined;
    if (content?.isError !== true || typeof content.callId !== "string" || !content.callId.startsWith(prefix)) continue;
    details.push(content.content?.find((item) => item.type === "text")?.text ?? "unknown tool error");
  }
  return details;
}

function w2RequestText(request: AgentModelRequest): string {
  return request.messages.map((message) => typeof message.content === "string" ? message.content : "").join("\n");
}

const W2_FINDING_GAP = {
  id: "finding:value-guard-gap",
  category: "missing_coverage",
  severity: "blocking",
  claim: "src/value.mjs exports value 2 with no upper-bound guard.",
  location: "src/value.mjs",
  evidenceRefs: ["src/value.mjs:1"],
  defectClass: "missing coverage",
};

const W2_FINDING_LATE = {
  id: "finding:helper-unpinned",
  category: "missing_coverage",
  severity: "blocking",
  claim: "The extra helper has no pinning test.",
  location: "src/extra.mjs:1",
  evidenceRefs: ["src/extra.mjs:1"],
  defectClass: "missing coverage",
};

class W2JourneyReviewer implements AgentModel {
  readonly requests: AgentModelRequest[] = [];
  readonly generations: Array<{ pass: string; attempt: number }> = [];
  constructor(private readonly projection: () => SchedulerProjection) {}

  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    // Attempt/pass identity captured live: post-hoc occurrence indexes
    // cannot split multi-turn passes, so the assertions below select by
    // the generation the script saw when the request arrived.
    this.generations.push({
      pass: request.messages.find((message) => message.role === "system")?.id ?? "",
      attempt: this.projection().tasks.T1?.attempt ?? 1,
    });
    const tools = new Set(request.tools.map((tool) => tool.name));
    const seen = request.messages.filter((message) => message.role === "tool").length;
    if (tools.has("record_coverage_obligations")) {
      return w2Call("record_coverage_obligations", {
        obligations: [{ id: "obl-REQ-1", description: "Export the value 2 with a guard.", requirementId: "REQ-1" }],
        sectionCoverage: [
          { sectionId: "s1", obligationIds: ["obl-REQ-1"] },
          { sectionId: "s2", obligationIds: ["obl-REQ-1"] },
        ],
      }, `obl-${seen}`);
    }
    if (tools.has("submit_coverage_verdict")) {
      return w2Call("submit_coverage_verdict", {
        obligationVerdicts: [{ obligationId: "obl-REQ-1", verdict: "covered", severity: "advisory", rationale: "T1 covers it.", evidenceRefs: ["ledger:REQ-1"] }],
        findings: [],
      }, `verdict-${seen}`);
    }
    const system = request.messages.find((message) => message.role === "system");
    const pass = system?.id ?? "";
    const attempt = this.projection().tasks.T1?.attempt ?? 1;
    if (pass === "delivery-obligations-system") {
      return w2Call("record_deliverable_obligations", { obligations: [{ id: "o1", description: "value must be 2 with a guard." }] }, `obl-${seen}`);
    }
    if (pass === "delivery-findings-system") {
      const recorded = w2ToolResults(request).some(
        (result) => result.toolName === "record_deliverable_findings" && result.isError !== true,
      );
      if (recorded) throw new Error("Findings are already durably recorded; the pass is over.");
      // Fail fast instead of looping into turn_limit: a refused record is
      // deterministic, so its actual error throws rather than resubmits.
      if (w2ToolFailed(request, "record_deliverable_findings")) {
        throw new Error(`W2 fixture: record_deliverable_findings refused, not resubmitting blindly: ${w2FailureDetail(request, "record_deliverable_findings")}`);
      }
      // Read the actual checkout before judging: findings follow inspected bytes.
      // One retry covers transients; a twice-failed read throws its actual
      // error instead of burning the review budget until turn_limit.
      const moduleReadFailures = w2CallFailures(request, "findings-read-");
      if (moduleReadFailures.length >= 2) throw new Error(`W2 fixture: fs.read src/value.mjs failed twice, not retrying into turn_limit: ${moduleReadFailures[0]}`);
      if (w2ReadText(request, "src/value.mjs") === undefined) {
        return w2Call("fs.read", { path: "src/value.mjs" }, `findings-read-${seen}`);
      }
      // Both generations survey the helper file. Gen-1 puts its bytes on
      // the verified prior surface; gen-2 re-inspects the unchanged bytes
      // before judging them. No finding is recorded from prose alone.
      const extraReadFailures = w2CallFailures(request, "findings-extra-");
      if (extraReadFailures.length >= 2) throw new Error(`W2 fixture: fs.read src/extra.mjs failed twice, not retrying into turn_limit: ${extraReadFailures[0]}`);
      if (w2ReadText(request, "src/extra.mjs") === undefined) {
        return w2Call("fs.read", { path: "src/extra.mjs" }, `findings-extra-${seen}`);
      }
      // The cumulative probe is optional: a failed probe is skipped, never retried.
      if (attempt >= 2 && !w2HasToolResult(request, "artifact.read") && w2CallFailures(request, "findings-cumulative-").length === 0) {
        // Prove the cumulative tool reference is usable when the context
        // carries one. High-tier re-reviews include the cumulative up
        // front instead: no marker is then referenced and none is needed.
        // Never throw here: a missing marker must not stall the pass.
        const marker = /artifact read tool at hash ([a-f0-9]{64})/.exec(w2RequestText(request))?.[1];
        if (marker) {
          return w2Call("artifact.read", { hash: marker, maxBytes: 6000 }, `findings-cumulative-${seen}`);
        }
      }
      if (attempt > 2) throw new Error(`W2 journey allows two attempts, saw attempt ${attempt}.`);
      // Gen-1 reports the real guard gap. Gen-2 reports only the new late
      // observation on the unchanged helper: no critical rationale and no
      // failing test, so the kernel must demote it to follow-up.
      const findings = attempt === 1 ? [{ ...W2_FINDING_GAP }] : [{ ...W2_FINDING_LATE }];
      return w2Call("record_deliverable_findings", { findings }, `findings-${seen}`);
    }
    if (pass === "delivery-verdict-system") {
      // A refused verdict is deterministic: throw its actual error rather
      // than resubmitting the same verdict until turn_limit.
      if (w2ToolFailed(request, "submit_deliverable_verdict")) {
        throw new Error(`W2 fixture: submit_deliverable_verdict refused, not resubmitting blindly: ${w2FailureDetail(request, "submit_deliverable_verdict")}`);
      }
      const verdictReadFailures = w2CallFailures(request, "verdict-read-");
      if (verdictReadFailures.length >= 2) throw new Error(`W2 fixture: verdict fs.read src/value.mjs failed twice, not retrying into turn_limit: ${verdictReadFailures[0]}`);
      // The whole module: resolution needs the guard line, not just line 1.
      // A one-line read would blind the verdict to the actual correction.
      if (w2ReadText(request, "src/value.mjs") === undefined) {
        return w2Call("fs.read", { path: "src/value.mjs" }, `verdict-read-${seen}`);
      }
      // Extra authentic read: package.json joins the prior surface through
      // the kernel-captured ledger, never through prose.
      const packageReadFailures = w2CallFailures(request, "verdict-package-read-");
      if (packageReadFailures.length >= 2) throw new Error(`W2 fixture: verdict fs.read package.json failed twice, not retrying into turn_limit: ${packageReadFailures[0]}`);
      if (attempt === 1 && w2ReadText(request, "package.json") === undefined) {
        return w2Call("fs.read", { path: "package.json" }, `verdict-package-read-${seen}`);
      }
      const text = w2RequestText(request);
      const claimIds = [...new Set([...text.matchAll(/"id"\s*:\s*"(claim:[^"]+)"/g)].map((match) => match[1]!))];
      const ownSection = text.split("Your durably recorded findings:")[1]?.split("The worker's report")[0] ?? "";
      const ownBlocking = /"severity"\s*:\s*"blocking"/.test(ownSection);
      const priorSection = text.split("Prior review")[1] ?? "";
      const hasPrior = priorSection.length > 0;
      const priorIds = [...new Set([...priorSection.matchAll(/"id"\s*:\s*"((?!claim:)[^"]+)"/g)].map((match) => match[1]!))];
      // Resolution is read from the actual verdict-session checkout.
      const moduleText = w2ReadText(request, "src/value.mjs") ?? "";
      const checks = priorIds.map((findingId) => {
        if (findingId === W2_FINDING_GAP.id) {
          const guarded = moduleText.includes("capped");
          return guarded
            ? { findingId, resolution: "resolved", rationale: "The guard line is present; inspected in this session." }
            : { findingId, resolution: "outstanding", rationale: "The guard is still missing." };
        }
        return { findingId, resolution: "outstanding", rationale: "Unresolved in the current checkout." };
      });
      // The verdict pass shows recorded (pre-demotion) severities, so the
      // re-review applies the late-finding rule itself from context facts:
      // an own finding whose file is outside the runner-computed fix delta
      // is an unchanged-code observation and cannot block when every prior
      // finding is resolved. Initial reviews keep the plain reading.
      const deltaFiles = hasPrior
        ? (text.split("Changed files:")[1]?.split("Unified fix diff:")[0] ?? "")
          .split("\n").map((line) => line.trim()).filter((line) => line.startsWith("- "))
          .map((line) => line.slice(2).trim()).filter((line) => line.length > 0)
        : [];
      const ownFiles = [...new Set([...ownSection.matchAll(/"location"\s*:\s*"([^":]+)(?::\d+)?"/g)].map((match) => match[1]!))];
      const ownOnChanged = ownFiles.some((file) => deltaFiles.includes(file));
      const satisfied = hasPrior
        ? checks.every((check) => check.resolution === "resolved") && !ownOnChanged
        : !ownBlocking && checks.every((check) => check.resolution === "resolved");
      return w2Call("submit_deliverable_verdict", {
        summary: "Reviewed against the criteria.",
        satisfied,
        claimVerdicts: claimIds.map((claimId) => ({ claimId, status: "verified", rationale: "Checked in the checkout.", citations: [{ path: "src/value.mjs", line: 1 }] })),
        ...(hasPrior ? { priorFindingChecks: checks } : {}),
      }, `verdict-${seen}`);
    }
    throw new Error(`Unexpected reviewer system ${pass}.`);
  }
}

class W2JourneyWorker implements AgentModel {
  readonly requests: AgentModelRequest[] = [];
  private readonly attemptOffset = new Map<number, number>();
  constructor(private readonly projection: () => SchedulerProjection) {}

  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const attempt = this.projection().tasks.T1?.attempt ?? 1;
    const total = request.messages.filter((message) => message.role === "tool").length;
    if (!this.attemptOffset.has(attempt)) this.attemptOffset.set(attempt, total);
    const tools = total - this.attemptOffset.get(attempt)!;
    if (attempt > 2) throw new Error(`W2 journey allows two attempts, saw attempt ${attempt}.`);
    // Every attempt rebuilds its deliverable in its ACTUAL fresh workspace:
    // attempt workspaces start from the baseline revision, so attempt 1
    // ships value 2 without the guard plus the helper, and attempt 2 ships
    // the guard while recreating the helper byte-identical - the submitted
    // correction moves only the reviewed module. Omitting the helper would
    // delete it from the submission and fake an over-correction signal.
    // Real evidence every attempt; no budget inflation past two attempts.
    if (tools === 0) return w2Call("fs.read", { path: "src/value.mjs" }, `read-module-${attempt}`);
    if (tools === 1) return w2Call("fs.write", { path: "src/value.mjs", content: attempt === 1 ? W2_VALUE_V1 : W2_VALUE_V2, expectedSha256: (w2LastToolValue(request) as { sha256: string }).sha256 }, `write-module-${attempt}`);
    // The helper is a new file in every fresh attempt workspace: created
    // absent, so no expectedSha256 (the fence refuses a replacement sha
    // against a missing file).
    if (tools === 2) return w2Call("fs.write", { path: "src/extra.mjs", content: W2_EXTRA }, `write-extra-${attempt}`);
    if (tools === 3) return w2Call("run_evidence_command", { label: "tests", command: process.execPath, args: ["--test", "test/value.test.mjs"] }, `evidence-${attempt}`);
    const record = w2LastToolValue(request) as unknown as { id: string; fact: { stdoutArtifactHash: string } };
    return w2Call("submit_task", {
      summary: "Product value and real tests pass.",
      readiness: "ready_for_architect_review",
      unresolvedConcerns: [],
      criterionEvidenceLinks: [{ criterionId: "c1", evidenceId: record.id, artifactHashes: [record.fact.stdoutArtifactHash] }],
      validationScope: {
        changed: ["src/value.mjs", "src/extra.mjs"],
        verified: ["value exports 2"],
        testsRun: [{ command: "node --test test/value.test.mjs", counts: { selected: 1, passed: 1, failed: 0, skipped: 0 } }],
        notRun: [{ what: "full suite", why: "narrow change with no shared contract touched" }],
      },
    }, `submit-${attempt}`);
  }
}

class W2JourneyArchitect implements AgentModel {
  readonly requests: AgentModelRequest[] = [];
  private calls = 0;
  constructor(
    private readonly projection: () => SchedulerProjection,
    private readonly scenario: ReturnType<typeof w2JourneyScenario>,
  ) {}
  private next(name: string, args: unknown): ModelTurn {
    this.calls += 1;
    return w2Call(name, args, `w2-arch-${this.calls}`);
  }
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const projection = this.projection();
    const planning = projection.planning;
    if (projection.planningTriageDecision === undefined) {
      return this.next("record_triage", { decision: "build", rationale: "W2 product: change request with an approved source." });
    }
    const manifestId = planning?.source.currentManifestId;
    assert.ok(manifestId, "the approved source is registered before planning reads");
    const reads = planning?.sourceReadIndex[manifestId] ?? {};
    const sections = this.scenario.manifest.sections;
    if (sections.some((section) => reads[section.id] !== section.digest)) {
      const pending = sections.find((section) => reads[section.id] !== section.digest)!;
      return this.next("read_planning_source_section", this.requests.length <= 2 ? {} : { sectionId: pending.id });
    }
    if (!planning?.ledger) {
      return this.next("persist_planning_ledger", {
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
      return this.next("draft_planning_plan", { revision: rest });
    }
    if (Object.keys(planning?.coverageRequests ?? {}).length === 0) {
      return this.next("request_coverage_review", { reviewId: "coverage_w2" });
    }
    const task = projection.tasks.T1!;
    if (task.status === "submitted" || task.status === "architect_review") {
      const links = task.criterionEvidenceLinks ?? [];
      // The architect judges the actual latest completed correction review,
      // never the attempt counter alone: approval needs a satisfied review.
      const latest = projection.delivery?.reviews.T1;
      const approved = latest?.stage === "completed" && latest.satisfied === true;
      return this.next("review_task", {
        taskId: "T1",
        decision: approved ? "approved" : "rejected",
        summary: approved ? "The correction review is satisfied." : "Open review findings remain.",
        evidenceArtifactHashes: [...new Set(links.flatMap((link) => link.artifactHashes))],
        criterionVerdicts: [{ criterionId: "c1", verdict: approved ? "satisfied" : "unsatisfied", rationale: "Judged.", evidenceIds: links.map((link) => link.evidenceId), artifactHashes: [...new Set(links.flatMap((link) => link.artifactHashes))], ...(approved ? {} : { overrideReason: "The correction review left blocking findings open; the verified value claim alone does not satisfy the criterion." }) }],
      });
    }
    if (task.status === "approved") return this.next("request_integration", { taskId: "T1" });
    throw new Error(`W2 journey script exhausted at T1 ${task.status}.`);
  }
}

function w2Provider(runtimeId: string, priority: number): RunnerProviderConfig {
  const [providerId, modelId] = runtimeId.split(":");
  return { runtimeId, providerId: providerId!, modelId: modelId!, transport: "openai-compatible", baseUrl: "http://127.0.0.1:9", secret: "unused", capabilities: ["code"], priority };
}

function w2LastModelToolError(models: Array<{ requests: AgentModelRequest[] }>): string {
  for (let index = models.length - 1; index >= 0; index--) {
    const requests = models[index]!.requests;
    for (let i = requests.length - 1; i >= 0; i--) {
      const failed = requests[i]!.messages
        .filter((message) => message.role === "tool")
        .reverse()
        .find((message) => (message.content as { isError?: boolean } | undefined)?.isError === true);
      if (failed) return `last failing model tool call: ${JSON.stringify(failed.content).slice(0, 1500)}`;
    }
  }
  return "no failing model tool call recorded";
}

function w2PassRequestText(reviewer: W2JourneyReviewer, pass: "findings" | "verdict", attempt: number): string {
  const texts = reviewer.requests
    .map((request, index) => ({ request, generation: reviewer.generations[index] }))
    .filter((entry) => entry.generation !== undefined && entry.generation.pass === `delivery-${pass}-system` && entry.generation.attempt === attempt)
    .map((entry) => entry.request.messages.map((message) => typeof message.content === "string" ? message.content : "").join("\n"));
  assert.ok(texts.length > 0, `expected ${pass} request for attempt ${attempt}`);
  // Every turn repeats the full context; the last turn carries it all.
  return texts[texts.length - 1]!;
}

test("W2 product: delta-first re-review with bounded late findings accepts", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-w2-product-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(join(project, "test"), { recursive: true });
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "w2-journey", version: "1.0.0", type: "module", scripts: { test: "node --test" } }, null, 2));
  writeFileSync(join(project, "test", "value.test.mjs"), W2_VALUE_TEST);
  writeFileSync(join(project, "src", "value.mjs"), "export const value = 1;\n");
  await runGit({ cwd: project, args: ["init"] });
  await runGit({ cwd: project, args: ["config", "core.autocrlf", "false"] });
  const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId: W2_RUN });
  let executionHost = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts: new ArtifactStore(join(state, "artifacts")), ambientEnvironment: w2JourneyEnvironment() });
  const supervisor = new RunSupervisor(new SqliteEventStore(join(state, "events.sqlite")), { clock: () => W2_CLOCK });
  let server: ControlServer | undefined;
  let factory: NativeBuildFactory | undefined;
  let manager: NativeBuildManager | undefined;
  let runtime: { step: () => Promise<{ status: string; action?: string }>; projection: () => SchedulerProjection } | undefined;
  const workerA = new W2JourneyWorker(() => runtime!.projection());
  const reviewer = new W2JourneyReviewer(() => runtime!.projection());
  const architect = new W2JourneyArchitect(() => runtime!.projection(), w2JourneyScenario(W2_RUN));
  try {
    const installNative = () => {
      factory = new NativeBuildFactory({
      projectRoot: project, stateDirectory: state,
      providerConfigs: { load: () => [w2Provider("arch:architect", 1), w2Provider("workA:workerA", 2), w2Provider("rev:reviewer", 3)], save: () => undefined, close: () => undefined },
      executionHost, baselineFor: () => baseline.revision,
      providerModelFactory: (config) => config.runtimeId === "arch:architect" ? architect : config.runtimeId === "workA:workerA"
        ? { complete: (request) => request.tools.some((tool) => tool.name === "record_coverage_obligations" || tool.name === "submit_coverage_verdict") ? reviewer.complete(request) : workerA.complete(request) }
        : reviewer,
    });
    manager = new NativeBuildManager({ specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")), createRuntime: (spec) => factory!.create(spec).then((handle) => { runtime = handle.runtime as typeof runtime; return handle; }), prepareSpec: (spec, options) => factory!.prepareSpec(spec, options) });
    server = new ControlServer({ supervisor, token: "v2-token", builds: manager, buildProvisioner: manager, checkGit: async () => ({ available: true, version: "fixture-git", code: "git_ready", reason: null }), bootstrapRun: async () => ({ baselineRevision: baseline.revision, baselineRef: baseline.ref }) });
    };
    installNative();
    let address = await server!.start(0);
    const body = { runId: W2_RUN, projectPath: project, permissionProfile: "full", idempotencyKey: "w2-journey", build: { projectId: "w2-fixture", objective: "Deliver the value module with a guard.", architectRuntimeId: "arch:architect", workerRuntimeIds: ["workA:workerA"], verifierRuntimeIds: ["rev:reviewer"], alwaysRequireIndependentVerifier: false, maxConcurrency: 1, runPolicy: "finish", budgetLimits: {}, planningPolicy: { version: 1 }, specCopy: false, handoffFiles: "export_only" } };
    const created = await fetch(`${address.url}/v2/runs`, { method: "POST", headers: { Authorization: "Bearer v2-token", "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(created.status, 201, await created.text());
    const control = (path: string, input: unknown) => fetch(`${address.url}/v2/runs/${W2_RUN}/build/${path}`, { method: "POST", headers: { Authorization: "Bearer v2-token", "Content-Type": "application/json" }, body: JSON.stringify(input) });
    const approve = await control("source", { approvedSource: { version: 1, approval: "approved_spec", bytesBase64: Buffer.from(W2_SOURCE).toString("base64"), mediaType: "text/plain", encoding: "utf-8", sections: [{ id: "s1", startByte: 0, endByte: Buffer.byteLength(`${W2_SOURCE.split("\n")[0]!}\n`, "utf8") }, { id: "s2", startByte: Buffer.byteLength(`${W2_SOURCE.split("\n")[0]!}\n`, "utf8"), endByte: Buffer.byteLength(W2_SOURCE, "utf8") }] }, idempotencyKey: "approve-source" });
    assert.equal(approve.status, 200, await approve.text());
    const stepUntil = async (done: (p: SchedulerProjection) => boolean) => {
      for (let step = 0; step < 300; step++) {
        const p = runtime!.projection();
        if (done(p)) return p;
        if (p.status === "paused" || p.status === "failed") {
          throw new Error(`Unexpected ${p.status} ${JSON.stringify({ pause: p.pauseReason, task: p.tasks.T1, recentEvents: manager!.events(W2_RUN).slice(-12) })}`);
        }
        await runtime!.step();
      }
      throw new Error("W2 product correction not reached");
    };
    await stepUntil((p) => p.planning?.readiness === "ready");
    const start = await control("plan-start", { ...currentExplicitStartIdentity(runtime!.projection()), version: 1, ownerChoice: "execute", idempotencyKey: "explicit-start" });
    assert.equal(start.status, 200, await start.text());
    // Attempt 1: initial review fails on the real guard gap.
    const gen1done = await stepUntil((p) => (p.delivery?.reviews.T1?.stage === "completed" && (p.delivery?.reviews.T1?.submissionAttempt ?? 0) >= 1));
    const gen1 = gen1done.delivery!.reviews.T1!;
    assert.equal(gen1.satisfied, false, "attempt 1 fails on its blocking finding");
    assert.deepEqual(
      (gen1.findings ?? []).map((finding) => finding.id),
      [W2_FINDING_GAP.id],
      "attempt 1 carries exactly the real guard gap",
    );
    assert.equal(gen1.delta, undefined, "initial reviews carry no delta");
    t.diagnostic(`W2 native initial review failed: ${gen1.reviewId}`);
    await stepUntil((p) => p.tasks.T1?.status === "rejected");
    // Attempt 2: the fix moves only the reviewed file. The re-review is
    // delta-first and blind: criteria, fix delta, unnamed files and
    // invalidated evidence before any prior finding is released. The
    // retry escalates to high tier (attempts: 2 in the risk input), so
    // the full cumulative rides up front AFTER the correction sections.
    const gen2done = await stepUntil((p) => (p.delivery?.reviews.T1?.stage === "completed" && (p.delivery?.reviews.T1?.submissionAttempt ?? 0) >= 2));
    const gen2 = gen2done.delivery!.reviews.T1!;
    // Compact native state dump: the actual recorded review, never a model claim.
    t.diagnostic(`W2 gen2 state: satisfied=${gen2.satisfied} findings=${JSON.stringify((gen2.findings ?? []).map((finding) => finding.id))} followUp=${JSON.stringify((gen2.followUpFindings ?? []).map((finding) => finding.id))} checks=${JSON.stringify(gen2.priorFindingChecks)} deltaFiles=${JSON.stringify(gen2.delta?.deltaFiles)} fallback=${gen2.delta?.fallback} overCorrection=${gen2.delta?.overCorrection} shownKeys=${JSON.stringify(Object.keys(gen2.delta?.priorShownLines ?? {}))} invalidated=${JSON.stringify(gen2.delta?.invalidatedEvidenceIds)} hunks=${JSON.stringify(gen2.delta?.deltaHunks)}`);
    const submittedFiles = manager!.events(W2_RUN)
      .filter((event) => event.type === "task.transitioned")
      .map((event) => ((event.payload as unknown as { patch?: { submissionScope?: { files?: Array<{ path?: string }> } } }).patch?.submissionScope?.files ?? []).map((file) => file.path));
    t.diagnostic(`W2 attempt submission files: ${JSON.stringify(submittedFiles)}`);
    assert.ok(gen2.priorReviewId, "the re-review names its prior");
    assert.equal(gen2.priorReviewId, gen1.reviewId, "the re-review binds exactly the latest completed review");
    const delta = gen2.delta;
    assert.ok(delta, "the re-review records its runner-computed delta");
    assert.equal(delta!.fallback, undefined, "actual trees resolve: no fallback");
    assert.deepEqual([...delta!.deltaFiles].sort(), ["src/value.mjs"], "the fix delta is the actual correction");
    assert.deepEqual(delta!.filesWithoutPriorFindings, [], "every delta file was named by a prior finding location");
    assert.equal(delta!.overCorrection, false, "no over-correction signal on the contained repair");
    assert.equal(delta!.cumulativeIncludedUpFront, true, "the retry tier is high, so the cumulative rides up front");
    assert.match(delta!.priorHeadTree ?? "", /^[a-f0-9]{40}$|^[a-f0-9]{64}$/);
    assert.match(delta!.headTree ?? "", /^[a-f0-9]{40}$|^[a-f0-9]{64}$/);
    assert.notEqual(delta!.priorHeadTree, delta!.headTree, "the delta spans two distinct actual trees");
    assert.ok((delta!.priorReviewedFiles ?? []).includes("src/value.mjs"), "prior surface holds the reviewed file");
    assert.ok((delta!.priorReviewedFiles ?? []).includes("src/extra.mjs"), "prior surface holds the helper file");
    assert.ok(!(delta!.priorReviewedFiles ?? []).includes("package.json"), "tree-diff surface never invents an unchanged file");
    assert.ok(
      (delta!.priorReadRanges ?? []).some((range) => range.path === "package.json" && range.startLine === 1),
      "the authentic verdict-session read joins the range ledger",
    );
    // The helper line rides the verified prior surface through the prior
    // cumulative diff bytes (findings-pass reads are the reviewer's own
    // inspection, not the verdict-session capture the kernel ledgers).
    assert.ok(
      ((delta!.priorShownLines ?? {})["src/extra.mjs"] ?? []).includes(1),
      "the prior cumulative diff bytes showed the helper line",
    );
    // F6 invalidation reaches the prior finding's own evidence ref: the
    // guard-gap citation on the moved module is dead by tree identity.
    assert.ok(
      (delta!.invalidatedEvidenceIds ?? []).includes("src/value.mjs:1"),
      "the prior finding evidence ref is invalidated by the tree move",
    );
    const guardHunks = (delta!.deltaHunks ?? {})["src/value.mjs"] ?? [];
    assert.ok(
      guardHunks.some((hunk) => hunk.newStart <= 2 && 2 < hunk.newStart + hunk.newCount),
      `a verified hunk covers the guard line: ${JSON.stringify(guardHunks)}`,
    );
    assert.ok((gen2.followUpFindings ?? []).map((finding) => finding.id).includes(W2_FINDING_LATE.id), "the unchanged reviewed observation is retained as follow-up");
    // Blind-first ordering on the real captured requests: the findings
    // pass never names the prior finding; the verdict pass releases it.
    const findingsText = w2PassRequestText(reviewer, "findings", 2);
    assert.ok(!findingsText.includes(W2_FINDING_GAP.id), "the blind findings pass leaks no prior finding");
    assert.ok(!findingsText.includes("prior-findings"), "the blind findings pass carries no prior-findings section");
    assert.ok(findingsText.includes("fix delta") || findingsText.includes("Fix delta"), "the fix delta leads the re-review");
    assert.ok(findingsText.includes("capped"), "the actual correction bytes lead");
    assert.ok(
      findingsText.indexOf("Fix delta") < findingsText.indexOf("export const extra = 42;"),
      "the correction sections precede the high-tier cumulative",
    );
    const verdictText = w2PassRequestText(reviewer, "verdict", 2);
    assert.ok(verdictText.includes(W2_FINDING_GAP.id), "the verdict releases the prior finding after own findings");
    // Both directions explicit, every prior finding exactly once.
    assert.deepEqual(
      (gen2.priorFindingChecks ?? []).map((check) => ({ findingId: check.findingId, resolution: check.resolution })),
      [{ findingId: W2_FINDING_GAP.id, resolution: "resolved" }],
      "each prior finding is checked exactly once",
    );
    assert.deepEqual(gen2.findings ?? [], [], "the late observation is follow-up, not a blocking finding");
    assert.equal(gen2.satisfied, true, "the one real correction resolves the one real blocker");
    t.diagnostic(`W2 native re-review satisfied with retained follow-up: ${gen2.reviewId}`);
    // Real SQLite close/reopen: the delta, findings and follow-up replay.
    const frozen = structuredClone(gen2);
    await server!.close();
    await manager!.close();
    await factory!.close();
    await executionHost.close();
    executionHost = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts: new ArtifactStore(join(state, "artifacts")), ambientEnvironment: w2JourneyEnvironment() });
    installNative();
    const recovery = await manager!.recover();
    assert.deepEqual(recovery.failures, [], "real SQLite/native recovery succeeds");
    assert.deepEqual(runtime!.projection().delivery!.reviews.T1, frozen, "the correction review replays exactly across close/reopen");
    address = await server!.start(0);
    await manager!.resume(W2_RUN, "w2-reopen-resume");
    t.diagnostic(`W2 native SQLite/factory reopen retained review ${frozen.reviewId}`);
    const accepted = await stepUntil((p) => p.delivery?.taskAcceptances?.T1 !== undefined);
    assert.equal(accepted.tasks.T1!.attempt, 2, "first rejection plus one correction suffices");
    assert.ok(accepted.tasks.T1!.integrationRevision, "the actual repair integrates");
    assert.ok(accepted.delivery!.taskAcceptances.T1, "the correction is accepted");
    assert.equal(manager!.events(W2_RUN).filter((event) => event.type === "delivery.review_started").length, 2, "one review per attempt");
    assert.equal(manager!.events(W2_RUN).filter((event) => event.type === "delivery.review_reused").length, 0, "no reuse across distinct correction trees");
    const head = (await runGit({ cwd: project, args: ["rev-parse", "HEAD"] })).stdout.trim();
    assert.equal(head, baseline.revision, "the approved-source baseline is intact");
  } catch (error) {
    // Compact honest failure diagnostic BEFORE cleanup: the actual last
    // failing model tool call from the scripted transports, never an
    // invented runtime cause from the pause alone.
    t.diagnostic(`W2 journey failure: ${w2LastModelToolError([reviewer, workerA, architect])}`);
    throw error;
  } finally {
    await server?.close();
    supervisor.close();
    await manager?.close();
    await factory?.close();
    await executionHost.close();
    rmSync(root, { recursive: true, force: true });
  }
});
