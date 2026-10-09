import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { AgentModel, AgentModelRequest, ModelTurn } from "../src/agent-contracts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost } from "../src/execution-host.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import {
  buildExecutionPlanRevision,
  T1A_SEEDED_HOST_PLANNING_CAPABILITIES,
  type CoverageReview,
  type ExecutionPlanPhase,
  type ExecutionTaskContract,
  type SourceRequirement,
} from "../src/planning-contracts.js";
import type { RunnerProviderConfig } from "../src/provider-config-store.js";
import {
  currentExplicitStartIdentity,
  rebuildSchedulerProjection,
  type NewSchedulerEvent,
  type SchedulerActorRole,
  type SchedulerProjection,
} from "../src/scheduler-store.js";
import { buildSourceManifest } from "../src/source-manifest.js";
import type { ValidationScope } from "../src/validation-scope.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { captureGitBaseline, NativeBuildFactory, runGit } from "./support/git-fixture.js";
import { qualificationArtifactRoot, writeQualificationDiagnostics } from "./support/qualification-harness.js";

/**
 * T8 G10c native-patch factory proof (CD-7 runtime behavior).
 *
 * Actual NativeBuildFactory -> BuildRuntime.step -> real SQLite/Git journey
 * invoking the reserved native openrouter.apply_patch adapter on a worker
 * task via the actual worker broker (unconditionally registered).
 * The scripted worker first attempts a refused traversal patch (truthful
 * refusal, no durable effect), then a refused generic protected patch
 * (host-correct PROTECTED.txt on Win32, exact protected.txt elsewhere),
 * then applies a normal V4A create patch (truthful durable creation),
 * runs evidence, and submits. Review, integration, and boundary checks
 * run for real; no fake ArtifactStore, synthetic grant, network, or model
 * is used. Accepted integration bytes are proven via Git show; owner HEAD
 * stays pinned and handoff never completes automatically.
 */

const RUN_ID = "run-openrouter-patch-factory";
const CLOCK = "2026-09-25T00:00:00.000Z";
const SOURCE_TEXT = "SECTION 1: MANDATORY. The value module must export the value 2.";
const VALUE_CONTENT = "export const value = 2;\n";
const VALUE_TEST = "import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../src/value.mjs'; test('value', () => assert.equal(value, 2));\n";
const PROTECTED_CONTENT = "keep\n";
const PROTECTED_PATH = "protected.txt";
const PROTECTED_ATTEMPT_PATH = process.platform === "win32" ? "PROTECTED.txt" : "protected.txt";

const PATCH_VALIDATION_SCOPE: ValidationScope = {
  changed: ["src/value.mjs"],
  verified: ["src/value.mjs exports value = 2"],
  testsRun: [{ command: "node --test", counts: { selected: 1, passed: 1, failed: 0, skipped: 0 } }],
  notRun: [],
};

function scenario() {
  const manifest = buildSourceManifest(Buffer.from(SOURCE_TEXT, "utf-8"), [{ id: "s1", startByte: 0, endByte: Buffer.byteLength(SOURCE_TEXT) }], {
    manifestId: "manifest_value",
    sourceId: "source_value",
    mediaType: "text/plain",
    encoding: "utf-8",
    authority: "owner",
    createdAt: "2026-09-24T00:00:00.000Z",
  });
  const requirements: SourceRequirement[] = [{
    id: "REQ-1",
    reference: { sourceId: manifest.sourceId, sectionIds: ["s1"] },
    purpose: "Export the value 2.",
    observableOutcome: "The value module exports 2.",
    obligationKind: "mandatory",
    applicability: { status: "applicable" },
    accountablePhaseId: "P1",
    contributingTaskIds: ["T1"],
    acceptanceConditions: [{ id: "REQ-1-ac1", description: "value is 2.", responsibleGateId: "P1-exit", requiredEvidenceKinds: ["command"] }],
  }];
  const phases: ExecutionPlanPhase[] = [{
    id: "P1",
    purpose: "Deliver the value module.",
    requirementIds: ["REQ-1"],
    scope: { includes: ["src/value.mjs"], excludes: ["docs/project/STATE.md"] },
    entryConditions: ["Plan ready."],
    contributingTaskIds: ["T1"],
    exitCriteria: ["The value module is accepted."],
    requiredCombinedValidation: ["tests"],
    exitUnlocks: ["final verification"],
  }];
  const tasks: ExecutionTaskContract[] = [{
    id: "T1",
    lineage: [],
    accountablePhaseId: "P1",
    requirementIds: ["REQ-1"],
    outcome: { user: "Create src/value.mjs exporting value = 2.", system: "The value module exports 2." },
    scope: { includes: ["src/value.mjs"], excludes: ["test/value.test.mjs"] },
    writableSurfaces: ["src/value.mjs"],
    forbiddenSurfaces: ["test/value.test.mjs"],
    dependencies: [],
    requiredBase: "accepted plan revision revision_value",
    inputs: ["accepted plan revision"],
    outputs: ["src/value.mjs"],
    steps: ["Write the module.", "Run the tests."],
    acceptance: { criteria: [{ id: "c1", text: "src/value.mjs exports value = 2 and the tests pass." }], definitionOfDone: "Tests pass." },
    validation: { targetedRationale: "The value test.", affectedScopeRationale: "The module only." },
    negativeProofApplicability: { applicable: false, rationale: "A new module has no prior-incorrect case." },
    reviewCriteria: ["Independent review confirms the value."],
    integrationChecks: ["Post-integration tests."],
    cleanup: { cleanup: "None.", recovery: "Retry.", rollback: "Revert." },
    requirementCriteriaMap: [{ taskLocalCriterionId: "c1", requirementId: "REQ-1" }],
  }];
  const revision = buildExecutionPlanRevision({
    revisionId: "revision_value",
    runId: RUN_ID,
    sourceManifestId: manifest.manifestId,
    sourceManifestDigest: manifest.artifactDigest,
    requirements,
    tasks,
    phases,
    workflowPolicyVersion: 1,
    planningDecisions: [],
    validationObligations: ["tests"],
    createdAt: "2026-09-24T00:00:00.000Z",
  });
  const coverageReview: CoverageReview = {
    id: "coverage_value",
    runId: RUN_ID,
    reviewerRuntimeId: "reviewer:distinct-model",
    independence: "distinct_model",
    sourceReadManifestId: manifest.manifestId,
    planRevisionId: revision.revisionId,
    planRevisionDigest: revision.digest,
    derivedObligations: [{ id: "obl-REQ-1", requirementId: "REQ-1", description: "Export 2.", recordedBeforePlanOrDiffProvided: true, recordedAt: "2026-09-24T00:05:00.000Z" }],
    obligationVerdicts: [{ obligationId: "obl-REQ-1", verdict: "covered", severity: "advisory", rationale: "T1 covers it.", evidenceRefs: ["ledger:REQ-1"] }],
    findings: [],
    recordedAt: "2026-09-24T00:10:00.000Z",
  };
  return { manifest, requirements, phases, revision, coverageReview };
}

function planningEvents(): NewSchedulerEvent[] {
  const { manifest, requirements, phases, revision, coverageReview } = scenario();
  const e = (type: string, key: string, role: SchedulerActorRole, id: string, payload: Record<string, unknown>): NewSchedulerEvent =>
    ({ runId: RUN_ID, type: type as NewSchedulerEvent["type"], occurredAt: CLOCK, actor: { role, id }, idempotencyKey: key, payload });
  return [
    e("project_docs.policy_configured", "project-docs-policy", "runner", "build-runtime", { version: 2 }),
    e("run.initialized", "run-initialized", "runner", "build-runtime", { testIntegrityPolicyVersion: 1, submissionScopePolicyVersion: 1, reviewIntegrityPolicyVersion: 1, encodingSafetyPolicyVersion: 1, reviewEvidencePolicyVersion: 1, validationScopePolicyVersion: 1, objective: "Deliver the value module." }),
    e("planning.policy_configured", "planning-policy", "runner", "build-runtime", { version: 1 }),
    e("planning.source_registered", "source", "user", "owner", { manifest }),
    e("request.triaged", "triage", "architect", "architect", { decision: "build", rationale: "Build the module." }),
    e("planning.ledger_persisted", "ledger", "architect", "architect", { id: "ledger", requirements, phases, nonNormativeSections: [] }),
    ...manifest.sections.map((section) => e("planning.source_section_read", `read:${section.id}`, "architect", "architect", { manifestId: manifest.manifestId, manifestDigest: manifest.artifactDigest, sectionId: section.id, sectionDigest: section.digest, readAt: CLOCK })),
    e("planning.plan_drafted", "plan", "architect", "architect", { revision, expectedRevisionId: null, expectedDigest: null }),
    e("planning.coverage_review_requested", "coverage-request", "architect", "architect", { reviewId: coverageReview.id, planRevisionId: revision.revisionId, planRevisionDigest: revision.digest, sourceManifestId: manifest.manifestId, requestedAt: CLOCK }),
    e("planning.coverage_obligations_recorded", "coverage-obligations", "verifier", "coverage-reviewer", { reviewId: coverageReview.id, sourceManifestId: manifest.manifestId, sourceManifestDigest: manifest.artifactDigest, obligations: coverageReview.derivedObligations, sectionCoverage: manifest.sections.map((section) => ({ sectionId: section.id, obligationIds: ["obl-REQ-1"] })), recordedAt: CLOCK }),
    e("planning.coverage_plan_delivered", "coverage-plan", "runner", "build-runtime", { reviewId: coverageReview.id, planRevisionId: revision.revisionId, planRevisionDigest: revision.digest, sourceManifestId: manifest.manifestId, deliveredAt: CLOCK }),
    e("planning.coverage_review_recorded", "coverage-review", "verifier", "coverage-reviewer", { review: coverageReview }),
    e("planning.plan_ready", "ready", "runner", "build-runtime", { hostCapabilities: T1A_SEEDED_HOST_PLANNING_CAPABILITIES }),
  ];
}

function call(name: string, args: unknown, id: string): ModelTurn {
  return {
    blocks: [{ type: "tool_call", callId: id, name, arguments: args }],
    stopReason: "tool_calls",
    usage: { inputTokens: 8, outputTokens: 4 },
  };
}

function lastToolValue(request: AgentModelRequest): Record<string, unknown> | undefined {
  const message = [...request.messages].reverse().find((candidate) => candidate.role === "tool");
  const content = (message?.content as { content?: Array<{ type: string; value?: unknown }> } | undefined)?.content;
  return content?.find((item) => item.type === "json")?.value as Record<string, unknown> | undefined;
}

function toolErrorAt(request: AgentModelRequest, index: number): boolean | undefined {
  const tools = request.messages.filter((message) => message.role === "tool");
  return (tools[index]?.content as { isError?: boolean } | undefined)?.isError;
}

function readShaAt(request: AgentModelRequest, index: number): string | undefined {
  const tools = request.messages.filter((message) => message.role === "tool");
  const content = tools[index]?.content as { content?: Array<{ type: string; value?: unknown }> } | undefined;
  const meta = content?.content?.find((item) => item.type === "json")?.value as { sha256?: string } | undefined;
  return meta?.sha256;
}

function patchFactoryReadText(request: AgentModelRequest, path: string): string | undefined {
  for (const message of request.messages) {
    if (message.role !== "tool") continue;
    const content = message.content as { toolName?: string; content?: Array<{ type: string; value?: unknown; text?: string }> };
    if (content.toolName !== "fs.read") continue;
    const meta = content.content?.find((item) => item.type === "json")?.value as { path?: string } | undefined;
    if (meta?.path !== path) continue;
    const textValue = content.content?.find((item) => item.type === "text")?.text;
    if (typeof textValue === "string") return textValue;
  }
  return undefined;
}

class PatchFactoryWorker implements AgentModel {
  constructor(
    private readonly observed: Array<{ callId?: string; toolName?: string; isError?: boolean; code?: string }> = [],
    private readonly protectedAttempts: string[] = [],
  ) {}
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    const tools = request.messages.filter((message) => message.role === "tool");
    const toolCount = tools.length;
    for (const message of tools.slice(this.observed.length)) {
      const content = message.content as { callId?: string; toolName?: string; isError?: boolean; error?: { code?: string } };
      this.observed.push({ callId: content.callId, toolName: content.toolName, isError: content.isError, code: content.error?.code });
    }
    if (toolCount === 0) {
      return call("openrouter.apply_patch", {
        status: "completed",
        operation: { type: "create_file", path: "../outside.txt", diff: "+nope\n" },
      }, "patch-refused-1");
    }
    if (toolCount === 1) {
      assert.equal(toolErrorAt(request, 0), true, `refused traversal patch must fail closed: ${JSON.stringify(this.observed)}`);
      assert.equal(this.observed[0]?.code, "path_outside_workspace", `traversal refusal keeps workspace containment: ${JSON.stringify(this.observed)}`);
      return call("fs.read", { path: PROTECTED_PATH }, "read-protected-1");
    }
    if (toolCount === 2) {
      assert.equal(toolErrorAt(request, 1), false, `protected baseline read must succeed for the actual SHA: ${JSON.stringify(this.observed)}`);
      const sha = readShaAt(request, 1);
      assert.ok(typeof sha === "string" && /^[a-f0-9]{64}$/.test(sha), `read supplies the actual protected SHA: ${sha}`);
      assert.equal(sha, createHash("sha256").update(PROTECTED_CONTENT, "utf8").digest("hex"), "protected baseline bytes are the known keep content");
      const attemptPath = PROTECTED_ATTEMPT_PATH;
      this.protectedAttempts.push(attemptPath);
      return call("fs.patch", { path: attemptPath, expectedSha256: sha, search: "keep", replace: "changed" }, "patch-protected-1");
    }
    if (toolCount === 3) {
      assert.equal(toolErrorAt(request, 2), true, `protected generic patch must fail closed: ${JSON.stringify(this.observed)}`);
      assert.equal(this.observed[2]?.code, "benchmark_protected_path", `generic protected refusal keeps the exact policy code: ${JSON.stringify(this.observed)}`);
      return call("openrouter.apply_patch", {
        status: "completed",
        operation: { type: "create_file", path: "src/value.mjs", diff: "+export const value = 2;\n" },
      }, "patch-normal-1");
    }
    if (toolCount === 4) {
      assert.equal(toolErrorAt(request, 3), false, `normal V4A patch must succeed via the native adapter: ${JSON.stringify(this.observed)}`);
      return call("run_evidence_command", { label: "tests", command: process.execPath, args: ["--test"] }, "evidence-1");
    }
    const record = lastToolValue(request)!;
    const fact = record.fact as { stdoutArtifactHash: string };
    return call("submit_task", {
      summary: "Added src/value.mjs exporting value = 2 via native patch; node --test passes.",
      readiness: "ready_for_architect_review",
      unresolvedConcerns: [],
      criterionEvidenceLinks: [{ criterionId: "c1", evidenceId: record.id, artifactHashes: [fact.stdoutArtifactHash] }],
      validationScope: PATCH_VALIDATION_SCOPE,
    }, "submit-1");
  }
}

class PatchFactoryReviewer implements AgentModel {
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    const system = request.messages.find((message) => message.role === "system");
    const pass = system?.id ?? "";
    const text = request.messages.filter((message) => typeof message.content === "string").map((message) => message.content as string).join("\n");
    const tools = request.messages.filter((message) => message.role === "tool").length;
    if (pass === "delivery-obligations-system") {
      return call("record_deliverable_obligations", { obligations: [{ id: "o1", description: "value must be 2." }] }, `obl-${tools}`);
    }
    if (pass === "delivery-findings-system") {
      if (tools === 0) return call("fs.read", { path: "src/value.mjs" }, "read-1");
      return call("record_deliverable_findings", { findings: [] }, `findings-${tools}`);
    }
    const inspected = patchFactoryReadText(request, "src/value.mjs");
    if (inspected === undefined) {
      return call("fs.read", { path: "src/value.mjs" }, `verdict-read-${tools}`);
    }
    assert.ok(inspected.split("\n")[0]!.includes("export const value = 2;"), "the cited line 1 actually exports value = 2");
    const survivors = [...new Set([...text.matchAll(/"id"\s*:\s*"(mutation-survivor:[^"]+)"/g)].map((match) => match[1]!))];
    assert.equal(survivors.length, 0, `unexpected mutation survivors on the value line are real gaps and cannot be blanket-released: ${survivors.join(", ")}`);
    const claimIds = [...new Set([...text.matchAll(/"id"\s*:\s*"(claim:[^"]+)"/g)].map((match) => match[1]!))];
    assert.ok(claimIds.length > 0, "the verdict context names claims");
    assert.ok(claimIds.includes("claim:c1"), "the verdict context names the criterion claim");
    assert.ok(claimIds.includes("claim:summary"), "the verdict context names the summary claim");
    return call("submit_deliverable_verdict", {
      summary: "The module exports 2 and the cited test run passed.",
      satisfied: true,
      claimVerdicts: claimIds.map((claimId) => ({ claimId, status: "verified", rationale: "Read src/value.mjs line 1 in this verdict session and confirmed it exports value = 2.", citations: [{ path: "src/value.mjs", line: 1 }] })),
    }, `verdict-${tools}`);
  }
}

class PatchFactoryArchitect implements AgentModel {
  constructor(private readonly projection: () => SchedulerProjection) {}
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    const projection = this.projection();
    const tools = request.messages.filter((message) => message.role === "tool").length;
    const task = projection.tasks.T1!;
    if (task.status === "submitted" || task.status === "architect_review") {
      const links = task.criterionEvidenceLinks ?? [];
      return call("review_task", {
        taskId: "T1",
        decision: "approved",
        summary: "The deliverable review is satisfied and the evidence passes.",
        evidenceArtifactHashes: [...new Set(links.flatMap((link) => link.artifactHashes))],
        criterionVerdicts: [{ criterionId: "c1", verdict: "satisfied", rationale: "Tests pass.", evidenceIds: links.map((link) => link.evidenceId), artifactHashes: [...new Set(links.flatMap((link) => link.artifactHashes))] }],
      }, `review-${request.messages.length}-${tools}`);
    }
    if (task.status === "approved") return call("request_integration", { taskId: "T1" }, `integrate-${request.messages.length}-${tools}`);
    throw new Error(`Unexpected Architect turn with T1 ${task.status}.`);
  }
}

function provider(runtimeId: string, priority: number): RunnerProviderConfig {
  const [providerId, modelId] = runtimeId.split(":");
  return { runtimeId, providerId: providerId!, modelId: modelId!, transport: "openai-compatible", baseUrl: "http://127.0.0.1:9", secret: "unused", capabilities: ["code"], priority };
}

function safeSegment(value: string): string {
  const readable = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "run";
  return `${readable}-${createHash("sha256").update(value).digest("hex").slice(0, 10)}`;
}

/**
 * Windows factory failure observer (diagnostic only, failure path only).
 *
 * Narrow bounded capture for an actual construction/cleanup failure. The
 * successful journey performs no observer I/O. Original error objects are
 * never mutated; summaries are passive data, never replacement errors. Only
 * name/message/code/stage/stack/cause/AggregateError.errors are read, with
 * explicit finite bounds. No live SQLite queries, no process/ownership
 * control, no env/credential inspection. Passive state copies via the
 * existing qualification harness are concurrent observations, not coherent
 * snapshots and not ownership, quiescence, or release proof.
 */
const FACTORY_DIAGNOSTIC_SCENARIO = "openrouter-apply-patch-factory";
const FACTORY_DIAGNOSTIC_ERROR_MAX_DEPTH = 8;
const FACTORY_DIAGNOSTIC_ERROR_MAX_NODES = 64;
const FACTORY_DIAGNOSTIC_ERROR_MAX_CHILDREN = 16;
const FACTORY_DIAGNOSTIC_ERROR_MAX_NAME_CHARS = 200;
const FACTORY_DIAGNOSTIC_ERROR_MAX_MESSAGE_CHARS = 4000;
const FACTORY_DIAGNOSTIC_ERROR_MAX_CODE_CHARS = 200;
const FACTORY_DIAGNOSTIC_ERROR_MAX_STAGE_CHARS = 200;
const FACTORY_DIAGNOSTIC_ERROR_MAX_STACK_CHARS = 8000;
const FACTORY_DIAGNOSTIC_ERROR_JSON_BYTE_BUDGET = 131072;
const FACTORY_DIAGNOSTIC_CAPTURE_NOTE =
  "Concurrent passive file copies; non-coherent across files; read failures/omissions are diagnostic observations only, not ownership, quiescence, or release proof. State copies only; no live SQLite queries.";

type FactoryDiagnosticTruncation = {
  kind: "truncated";
  reason: string;
  depth: number;
};

type FactoryDiagnosticErrorNode = {
  kind: "error" | "non-error";
  depth: number;
  name: string;
  message: string;
  code?: string;
  stage?: string;
  stack?: string;
  cause?: FactoryDiagnosticErrorNode | FactoryDiagnosticTruncation;
  errors?: Array<FactoryDiagnosticErrorNode | FactoryDiagnosticTruncation>;
  truncated: boolean;
  truncationReasons: string[];
  readFailures: string[];
};

type FactoryDiagnosticPayload = {
  scenario: string;
  phase: "primary" | "post-close";
  fixtureRoot: string;
  boundedPrimary: (FactoryDiagnosticErrorNode | FactoryDiagnosticTruncation) | null;
  boundedTeardown: Array<FactoryDiagnosticErrorNode | FactoryDiagnosticTruncation>;
  nodeCount: number;
  truncated: boolean;
  truncationReasons: string[];
  captureNote: string;
};

function boundFactoryDiagnosticText(value: unknown, maxChars: number): { text: string; truncated: boolean; omitted: boolean } {
  try {
    if (typeof value === "string") {
      if (value.length > maxChars) return { text: value.slice(0, maxChars), truncated: true, omitted: false };
      return { text: value, truncated: false, omitted: false };
    }
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
      const text = String(value);
      if (text.length > maxChars) return { text: text.slice(0, maxChars), truncated: true, omitted: false };
      return { text, truncated: false, omitted: false };
    }
    return { text: "", truncated: false, omitted: true };
  } catch {
    return { text: "", truncated: false, omitted: true };
  }
}

function isFactoryDiagnosticTruncated(node: FactoryDiagnosticErrorNode | FactoryDiagnosticTruncation): boolean {
  if (node.kind === "truncated") return true;
  return node.truncated;
}

function summarizeFactoryDiagnosticError(
  value: unknown,
  depth: number,
  state: { nodes: number; reasons: string[] },
  seen: Set<object>,
): FactoryDiagnosticErrorNode | FactoryDiagnosticTruncation {
  if (depth > FACTORY_DIAGNOSTIC_ERROR_MAX_DEPTH) {
    state.reasons.push(`depth-budget@${depth}`);
    return { kind: "truncated", reason: "depth-budget", depth };
  }
  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) {
      state.reasons.push(`cycle@${depth}`);
      return { kind: "truncated", reason: "cycle", depth };
    }
  }
  if (state.nodes >= FACTORY_DIAGNOSTIC_ERROR_MAX_NODES) {
    state.reasons.push(`node-budget@${depth}`);
    return { kind: "truncated", reason: "node-budget", depth };
  }
  state.nodes += 1;
  if (typeof value === "object" && value !== null) seen.add(value);
  if (!(value instanceof Error)) {
    let text = "";
    let truncated = false;
    let stringifyFailed = false;
    try {
      const raw = String(value);
      if (raw.length > FACTORY_DIAGNOSTIC_ERROR_MAX_MESSAGE_CHARS) {
        text = raw.slice(0, FACTORY_DIAGNOSTIC_ERROR_MAX_MESSAGE_CHARS);
        truncated = true;
      } else {
        text = raw;
      }
    } catch {
      stringifyFailed = true;
    }
    const truncationReasons: string[] = [];
    if (truncated) truncationReasons.push("message-budget");
    if (stringifyFailed) truncationReasons.push("stringify-failed");
    return {
      kind: "non-error",
      depth,
      name: "non-error",
      message: text,
      truncated: truncated || stringifyFailed,
      truncationReasons,
      readFailures: stringifyFailed ? ["non-error-stringify-failed"] : [],
    };
  }
  const truncationReasons: string[] = [];
  const readFailures: string[] = [];
  const readField = (field: string): { present: boolean; value: unknown; failed: boolean } => {
    try {
      const raw = (value as unknown as Record<string, unknown>)[field];
      if (raw === undefined || raw === null) return { present: false, value: raw, failed: false };
      return { present: true, value: raw, failed: false };
    } catch {
      return { present: false, value: undefined, failed: true };
    }
  };
  const nameField = readField("name");
  const messageField = readField("message");
  const codeField = readField("code");
  const stageField = readField("stage");
  const stackField = readField("stack");
  if (nameField.failed) readFailures.push("name-read-failed");
  if (messageField.failed) readFailures.push("message-read-failed");
  if (codeField.failed) readFailures.push("code-read-failed");
  if (stageField.failed) readFailures.push("stage-read-failed");
  if (stackField.failed) readFailures.push("stack-read-failed");
  let name = value instanceof AggregateError ? "AggregateError" : "Error";
  if (nameField.present) {
    const bound = boundFactoryDiagnosticText(nameField.value, FACTORY_DIAGNOSTIC_ERROR_MAX_NAME_CHARS);
    if (!bound.omitted) {
      name = bound.text;
      if (bound.truncated) truncationReasons.push("name-budget");
    } else {
      readFailures.push("name-omitted-non-scalar");
    }
  }
  let message = "";
  if (messageField.present) {
    const bound = boundFactoryDiagnosticText(messageField.value, FACTORY_DIAGNOSTIC_ERROR_MAX_MESSAGE_CHARS);
    if (!bound.omitted) {
      message = bound.text;
      if (bound.truncated) truncationReasons.push("message-budget");
    } else {
      readFailures.push("message-omitted-non-scalar");
    }
  }
  let code: string | undefined;
  if (codeField.present) {
    const bound = boundFactoryDiagnosticText(codeField.value, FACTORY_DIAGNOSTIC_ERROR_MAX_CODE_CHARS);
    if (!bound.omitted) {
      code = bound.text;
      if (bound.truncated) truncationReasons.push("code-budget");
    } else {
      readFailures.push("code-omitted-non-scalar");
    }
  }
  let stage: string | undefined;
  if (stageField.present) {
    const bound = boundFactoryDiagnosticText(stageField.value, FACTORY_DIAGNOSTIC_ERROR_MAX_STAGE_CHARS);
    if (!bound.omitted) {
      stage = bound.text;
      if (bound.truncated) truncationReasons.push("stage-budget");
    } else {
      readFailures.push("stage-omitted-non-scalar");
    }
  }
  let stack: string | undefined;
  if (stackField.present) {
    const bound = boundFactoryDiagnosticText(stackField.value, FACTORY_DIAGNOSTIC_ERROR_MAX_STACK_CHARS);
    if (!bound.omitted) {
      stack = bound.text;
      if (bound.truncated) truncationReasons.push("stack-budget");
    } else {
      readFailures.push("stack-omitted-non-scalar");
    }
  }
  let cause: (FactoryDiagnosticErrorNode | FactoryDiagnosticTruncation) | undefined;
  const causeField = readField("cause");
  if (causeField.failed) {
    readFailures.push("cause-read-failed");
  } else if (causeField.present) {
    cause = summarizeFactoryDiagnosticError(causeField.value, depth + 1, state, seen);
  }
  let errors: Array<FactoryDiagnosticErrorNode | FactoryDiagnosticTruncation> | undefined;
  if (value instanceof AggregateError) {
    const errorsField = readField("errors");
    if (errorsField.failed) {
      readFailures.push("errors-read-failed");
    } else if (errorsField.present) {
      const raw = errorsField.value;
      if (Array.isArray(raw)) {
        const kept = raw.slice(0, FACTORY_DIAGNOSTIC_ERROR_MAX_CHILDREN);
        if (raw.length > kept.length) truncationReasons.push(`children-budget:kept=${kept.length}/total=${raw.length}`);
        errors = kept.map((entry) => summarizeFactoryDiagnosticError(entry, depth + 1, state, seen));
      } else {
        readFailures.push("errors-omitted-non-array");
      }
    }
  }
  const childTruncated = (cause !== undefined && isFactoryDiagnosticTruncated(cause))
    || (errors !== undefined && errors.some((entry) => isFactoryDiagnosticTruncated(entry)));
  if (childTruncated) truncationReasons.push("child-truncated");
  const truncated = truncationReasons.length > 0 || readFailures.length > 0;
  const node: FactoryDiagnosticErrorNode = {
    kind: "error",
    depth,
    name,
    message,
    truncated,
    truncationReasons,
    readFailures,
  };
  if (code !== undefined) node.code = code;
  if (stage !== undefined) node.stage = stage;
  if (stack !== undefined) node.stack = stack;
  if (cause !== undefined) node.cause = cause;
  if (errors !== undefined) node.errors = errors;
  return node;
}

function buildFactoryDiagnosticPayload(input: {
  phase: "primary" | "post-close";
  fixtureRoot: string;
  primary: unknown;
  hasPrimary: boolean;
  teardownErrors: readonly unknown[];
}): FactoryDiagnosticPayload {
  const state = { nodes: 0, reasons: [] as string[] };
  const seen = new Set<object>();
  let boundedPrimary: (FactoryDiagnosticErrorNode | FactoryDiagnosticTruncation) | null = null;
  if (input.hasPrimary) {
    boundedPrimary = summarizeFactoryDiagnosticError(input.primary, 0, state, seen);
  }
  const keptTeardown = input.teardownErrors.slice(0, FACTORY_DIAGNOSTIC_ERROR_MAX_CHILDREN);
  if (input.teardownErrors.length > keptTeardown.length) {
    state.reasons.push(`teardown-budget:kept=${keptTeardown.length}/total=${input.teardownErrors.length}`);
  }
  const boundedTeardown = keptTeardown.map((entry) => summarizeFactoryDiagnosticError(entry, 0, state, seen));
  const primaryTruncated = boundedPrimary !== null && isFactoryDiagnosticTruncated(boundedPrimary);
  const teardownTruncated = boundedTeardown.some((entry) => isFactoryDiagnosticTruncated(entry));
  const truncated = state.reasons.length > 0 || primaryTruncated || teardownTruncated;
  return {
    scenario: FACTORY_DIAGNOSTIC_SCENARIO,
    phase: input.phase,
    fixtureRoot: input.fixtureRoot,
    boundedPrimary,
    boundedTeardown,
    nodeCount: state.nodes,
    truncated,
    truncationReasons: [...state.reasons],
    captureNote: FACTORY_DIAGNOSTIC_CAPTURE_NOTE,
  };
}

function stripFactoryDiagnosticStacks(payload: FactoryDiagnosticPayload): FactoryDiagnosticPayload {
  const stripNode = (
    node: FactoryDiagnosticErrorNode | FactoryDiagnosticTruncation,
  ): FactoryDiagnosticErrorNode | FactoryDiagnosticTruncation => {
    if (node.kind === "truncated") return node;
    const copy: FactoryDiagnosticErrorNode = {
      ...node,
      truncationReasons: [...node.truncationReasons],
      readFailures: [...node.readFailures],
    };
    if (copy.stack !== undefined) {
      copy.stack = undefined;
      copy.truncated = true;
      if (!copy.truncationReasons.includes("byte-budget-stack-omitted")) copy.truncationReasons.push("byte-budget-stack-omitted");
    }
    if (copy.cause !== undefined) copy.cause = stripNode(copy.cause);
    if (copy.errors !== undefined) copy.errors = copy.errors.map((entry) => stripNode(entry));
    return copy;
  };
  return {
    ...payload,
    truncationReasons: [...payload.truncationReasons],
    boundedPrimary: payload.boundedPrimary === null ? null : stripNode(payload.boundedPrimary),
    boundedTeardown: payload.boundedTeardown.map((entry) => stripNode(entry)),
  };
}

function toBoundedFactoryDiagnosticJson(payload: FactoryDiagnosticPayload): string {
  const first = JSON.stringify(payload);
  if (Buffer.byteLength(first, "utf8") <= FACTORY_DIAGNOSTIC_ERROR_JSON_BYTE_BUDGET) return first;
  const stripped = stripFactoryDiagnosticStacks(payload);
  stripped.truncated = true;
  if (!stripped.truncationReasons.includes("byte-budget-stacks-omitted")) {
    stripped.truncationReasons.push("byte-budget-stacks-omitted");
  }
  const second = JSON.stringify(stripped);
  if (Buffer.byteLength(second, "utf8") <= FACTORY_DIAGNOSTIC_ERROR_JSON_BYTE_BUDGET) return second;
  const minimal = {
    scenario: payload.scenario,
    phase: payload.phase,
    fixtureRoot: payload.fixtureRoot,
    nodeCount: payload.nodeCount,
    truncated: true,
    truncationReasons: [...payload.truncationReasons, "byte-budget-minimal"],
    captureNote: payload.captureNote,
  };
  const third = JSON.stringify(minimal);
  if (Buffer.byteLength(third, "utf8") <= FACTORY_DIAGNOSTIC_ERROR_JSON_BYTE_BUDGET) return third;
  return JSON.stringify({ scenario: payload.scenario, phase: payload.phase, truncated: true });
}

test("native patch factory applies refused then normal V4A patches through the worker broker", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "aiboard-openrouter-patch-factory-")));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(join(project, "test"), { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "openrouter-patch-factory-fixture", version: "1.0.0", type: "module", packageManager: "npm@11.0.0", scripts: { test: "node --test" } }, null, 2));
  writeFileSync(join(project, "test", "value.test.mjs"), VALUE_TEST);
  writeFileSync(join(project, "protected.txt"), PROTECTED_CONTENT);
  const npmCliCandidates = [
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const npmCli = npmCliCandidates.find((candidate) => existsSync(candidate));
  assert.ok(
    typeof npmCli === "string",
    `actual installed npm CLI entrypoint is required for genuine package-lock generation; tried ${JSON.stringify(npmCliCandidates)} from ${process.execPath}`
  );
  const lock = spawnSync(process.execPath, [npmCli!, "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: project, encoding: "utf8" });
  assert.equal(lock.status, 0, lock.stderr);
  const runRoot = join(state, "builds", safeSegment(RUN_ID));
  mkdirSync(runRoot, { recursive: true });
  const seed = new SqliteSchedulerStore(join(runRoot, "scheduler.sqlite"));
  for (const input of planningEvents()) seed.append(input);
  const startIdentity = currentExplicitStartIdentity(rebuildSchedulerProjection(seed.readRun(RUN_ID)));
  assert.ok(startIdentity, "the fixture plan is ready with a complete start identity");
  seed.append({
    runId: RUN_ID,
    type: "planning.execution_authorized",
    occurredAt: CLOCK,
    actor: { role: "user", id: "local-user" },
    idempotencyKey: "owner-start",
    payload: { authorization: { ...startIdentity, version: 1, ownerChoice: "execute" } },
  });
  seed.close();
  const workerTools: Array<{ callId?: string; toolName?: string; isError?: boolean; code?: string }> = [];
  const protectedAttempts: string[] = [];
  const worker = new PatchFactoryWorker(workerTools, protectedAttempts);
  const reviewer = new PatchFactoryReviewer();
  const executionHost = createExecutionHost({
    projectRoot: project,
    stateDirectory: state,
    artifacts: new ArtifactStore(join(state, "artifacts")),
    ambientEnvironment: snapshotNativeBuildAmbientEnvironment(),
  });
  const { manifest: sourceManifest } = scenario();
  const storedSource = await executionHost.artifacts.put(Buffer.from(SOURCE_TEXT, "utf-8"), "text/plain", "approved source");
  assert.equal(storedSource.hash, sourceManifest.artifactDigest, "the stored source bytes are the manifest authority");
  let factory: NativeBuildFactory | undefined;
  let handle: Awaited<ReturnType<NativeBuildFactory["create"]>> | undefined;
  let primary: unknown;
  let hasPrimary = false;
  let diagnosticEvidenceRoot: string | undefined;
  const diagnosticFailures: unknown[] = [];
  try {
    const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId: RUN_ID });
    const integritySeeder = new SqliteSchedulerStore(join(runRoot, "scheduler.sqlite"));
    try {
      integritySeeder.append({
        runId: RUN_ID,
        type: "delivery.test_integrity_initialized",
        occurredAt: CLOCK,
        actor: { role: "runner", id: "build-runtime" },
        idempotencyKey: "test-integrity-initial-revision",
        payload: { revision: baseline.revision, architectActorId: "architect_1" },
      });
    } finally {
      integritySeeder.close();
    }
    factory = new NativeBuildFactory({
      projectRoot: project,
      stateDirectory: state,
      providerConfigs: {
        load: () => [provider("arch:architect", 1), provider("work:worker", 2), provider("rev:reviewer", 3)],
        save: () => undefined,
        close: () => undefined,
      },
      executionHost,
      baselineFor: () => baseline.revision,
      providerModelFactory: (config) => config.runtimeId === "arch:architect"
        ? new PatchFactoryArchitect(() => handle!.runtime.projection())
        : config.runtimeId === "work:worker" ? worker : reviewer,
    });
    handle = await factory.create(await factory.prepareSpec({
      version: 2,
      runId: RUN_ID,
      projectId: "openrouter-patch-factory-fixture",
      objective: "Deliver the value module.",
      planningPolicy: { version: 1 },
      benchmark: {
        attemptId: "openrouter-patch-factory-protected",
        allowedCommands: [`${process.execPath} --test`],
        hiddenPaths: [],
        protectedPaths: ["protected.txt"],
      },
      architectRuntimeId: "arch:architect",
      workerRuntimeIds: ["work:worker"],
      verifierRuntimeIds: ["rev:reviewer"],
      alwaysRequireIndependentVerifier: false,
      maxConcurrency: 1,
      permissionProfile: "full",
      runPolicy: "finish",
      planCritique: "off",
      budgetLimits: {},
      createdAt: CLOCK,
      idempotencyKey: "openrouter-patch-factory",
    }));
    const actions: string[] = [];
    for (let step = 0; step < 40; step += 1) {
      const projection = handle.runtime.projection();
      if (Object.keys(projection.delivery?.phaseAcceptances ?? {}).length > 0) break;
      const result = await handle.runtime.step();
      actions.push(result.action ?? result.status);
      if (result.status === "paused") break;
    }
    const projection = handle.runtime.projection();
    const detail = `${actions.join(",")} :: pause=${JSON.stringify(projection.pauseReason)} :: task=${JSON.stringify(projection.tasks.T1?.status)} :: worker=${JSON.stringify(workerTools)}`;
    assert.equal(projection.status === "paused", false, detail);
    assert.ok(workerTools.length >= 5, `expected traversal+read+protected+normal+evidence tool results: ${JSON.stringify(workerTools)}`);
    assert.equal(workerTools[0]?.toolName, "openrouter.apply_patch");
    assert.equal(workerTools[0]?.isError, true);
    assert.equal(workerTools[0]?.code, "path_outside_workspace");
    assert.equal(workerTools[1]?.toolName, "fs.read");
    assert.equal(workerTools[1]?.isError, false);
    assert.equal(workerTools[2]?.toolName, "fs.patch");
    assert.equal(workerTools[2]?.isError, true);
    assert.equal(workerTools[2]?.code, "benchmark_protected_path");
    assert.equal(workerTools[3]?.toolName, "openrouter.apply_patch");
    assert.equal(workerTools[3]?.isError, false);
    assert.deepEqual(protectedAttempts, [PROTECTED_ATTEMPT_PATH], "the worker attempted the host-correct protected path");
    const taskWorkspace = projection.tasks.T1?.workspacePath;
    assert.ok(typeof taskWorkspace === "string" && taskWorkspace.length > 0, `task workspace persists in projection: ${JSON.stringify(projection.tasks.T1)}`);
    const outsidePath = join(dirname(taskWorkspace), "outside.txt");
    assert.equal(existsSync(outsidePath), false, `refused traversal must leave no outside file: ${outsidePath}`);
    const review = projection.delivery?.reviews.T1;
    assert.ok(review, detail);
    assert.equal(review.stage, "completed");
    assert.equal(review.independence, "distinct_model");
    assert.equal(review.reviewerRuntimeId, "rev:reviewer");
    assert.ok(review.depth!.inspectionToolCalls >= 1, "the reviewer really inspected the task checkout");
    const boundary = projection.delivery!.boundaries.T1!.at(-1)!;
    const testsCheck = boundary.checks.find((check) => check.checkId === "tests")!;
    assert.equal(testsCheck.report?.status, "passed", JSON.stringify(testsCheck));
    assert.ok((testsCheck.report?.counts?.passed ?? 0) >= 1, "real counts: at least one executed test");
    assert.equal(boundary.passed, true, JSON.stringify(boundary));
    assert.deepEqual(boundary.changedFiles, ["src/value.mjs"]);
    assert.ok(projection.delivery!.taskAcceptances.T1, actions.join(","));
    const phase = projection.delivery!.phaseAcceptances["revision_value:P1"];
    assert.ok(phase, actions.join(","));
    assert.ok(projection.tasks.T1?.validationScope, "validation scope is recorded");
    assert.deepEqual(projection.tasks.T1?.validationScope?.changed, ["src/value.mjs"], "scope claims only the performed module");
    const canonical = projection.integrationRevision;
    assert.ok(typeof canonical === "string" && /^[a-f0-9]{40}$/.test(canonical), `integration records a canonical revision: ${canonical}`);
    assert.equal(projection.tasks.T1?.integrationRevision, canonical, "task integration matches the canonical revision");
    const integrationEntries = readdirSync(join(state, "integration"));
    assert.equal(integrationEntries.length, 1, `single integration repo: ${JSON.stringify(integrationEntries)}`);
    const integrationRepo = join(state, "integration", integrationEntries[0]!);
    const integratedValue = (await runGit({ cwd: integrationRepo, args: ["show", `${canonical}:src/value.mjs`] })).stdout;
    assert.equal(integratedValue, VALUE_CONTENT, "accepted integration src/value.mjs bytes are exact");
    const integratedProtected = (await runGit({ cwd: integrationRepo, args: ["show", `${canonical}:protected.txt`] })).stdout;
    assert.equal(integratedProtected, PROTECTED_CONTENT, "accepted integration protected.txt bytes remain keep");
    const ownerHeadAfter = (await runGit({ cwd: project, args: ["rev-parse", "HEAD"] })).stdout.trim();
    assert.equal(ownerHeadAfter, baseline.revision, "owner HEAD stays at its baseline");
    assert.equal(existsSync(join(project, "src/value.mjs")), false, "owner tree gains no product file");
    assert.equal(readFileSync(join(project, "protected.txt"), "utf8"), PROTECTED_CONTENT, "owner protected bytes unchanged");
    assert.equal(projection.projectHandoff?.status ?? "none", "none", "owner handoff never automatically requested or completed");
  } catch (error) {
    primary = error;
    hasPrimary = true;
    try {
      if (diagnosticEvidenceRoot === undefined) {
        diagnosticEvidenceRoot = qualificationArtifactRoot();
      }
      const payload = buildFactoryDiagnosticPayload({
        phase: "primary",
        fixtureRoot: root,
        primary,
        hasPrimary: true,
        teardownErrors: [],
      });
      process.stderr.write(`${toBoundedFactoryDiagnosticJson(payload)}\n`);
      writeQualificationDiagnostics({
        evidenceRoot: diagnosticEvidenceRoot,
        scenario: FACTORY_DIAGNOSTIC_SCENARIO,
        fixtureRoots: [root],
        error,
        extra: {
          phase: "primary",
          boundedPrimary: payload.boundedPrimary,
          nodeCount: payload.nodeCount,
          truncated: payload.truncated,
          truncationReasons: payload.truncationReasons,
          captureNote: payload.captureNote,
        },
      });
    } catch (captureError) {
      diagnosticFailures.push(captureError);
      try {
        process.stderr.write("[factory-diagnostic] primary capture failed; primary preserved.\n");
      } catch {
        // stderr is best-effort; the original primary is still preserved below.
      }
    }
    throw error;
  } finally {
    const teardownErrors: unknown[] = [];
    try {
      await handle?.close();
    } catch (error) {
      teardownErrors.push(error);
    }
    try {
      await factory?.close();
    } catch (error) {
      teardownErrors.push(error);
    }
    try {
      await executionHost.close();
    } catch (error) {
      teardownErrors.push(error);
    }
    const resourceClosersSucceeded = teardownErrors.length === 0;
    if (resourceClosersSucceeded) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch (error) {
        teardownErrors.push(error);
      }
    }
    if (teardownErrors.length > 0) {
      try {
        if (diagnosticEvidenceRoot === undefined) {
          diagnosticEvidenceRoot = qualificationArtifactRoot();
        }
        const payload = buildFactoryDiagnosticPayload({
          phase: "post-close",
          fixtureRoot: root,
          primary,
          hasPrimary,
          teardownErrors,
        });
        process.stderr.write(`${toBoundedFactoryDiagnosticJson(payload)}\n`);
        writeQualificationDiagnostics({
          evidenceRoot: diagnosticEvidenceRoot,
          scenario: FACTORY_DIAGNOSTIC_SCENARIO,
          fixtureRoots: [root],
          error: hasPrimary ? primary : teardownErrors[0],
          extra: {
            phase: "post-close",
            boundedPrimary: payload.boundedPrimary,
            boundedTeardown: payload.boundedTeardown,
            nodeCount: payload.nodeCount,
            truncated: payload.truncated,
            truncationReasons: payload.truncationReasons,
            captureNote: payload.captureNote,
          },
        });
      } catch (captureError) {
        diagnosticFailures.push(captureError);
        try {
          process.stderr.write("[factory-diagnostic] post-close capture failed; primary/closure errors preserved.\n");
        } catch {
          // stderr is best-effort; original errors are still preserved below.
        }
      }
    }
    const diagnosticSuffix = diagnosticFailures.length > 0
      ? ` Diagnostic capture reported ${diagnosticFailures.length} failure(s); primary/closure errors preserved.`
      : "";
    if (teardownErrors.length > 0) {
      if (hasPrimary) {
        throw new AggregateError(
          [primary, ...teardownErrors, ...diagnosticFailures],
          resourceClosersSucceeded
            ? `Native patch factory journey failed and teardown also failed during owned root removal; primary error preserved. owned root removal failed; location may be partially removed: ${root}${diagnosticSuffix}`
            : `Native patch factory journey failed and teardown also failed during resource closure; owned root removal not attempted. Retained owned root for bounded read-only diagnosis: ${root}${diagnosticSuffix}`,
        );
      }
      throw new AggregateError(
        [...teardownErrors, ...diagnosticFailures],
        resourceClosersSucceeded
          ? `Native patch factory teardown failed during owned root removal. owned root removal failed; location may be partially removed: ${root}${diagnosticSuffix}`
          : `Native patch factory teardown failed during resource closure; owned root removal not attempted. Retained owned root for bounded read-only diagnosis: ${root}${diagnosticSuffix}`,
      );
    }
    if (diagnosticFailures.length > 0 && hasPrimary) {
      throw new AggregateError(
        [primary, ...diagnosticFailures],
        `Native patch factory journey failed; diagnostic capture also failed. Primary error preserved.${diagnosticSuffix} Fixture root: ${root}`,
      );
    }
    if (diagnosticFailures.length > 0) {
      throw new AggregateError(
        [...diagnosticFailures],
        `Native patch factory diagnostic capture failed without a primary/closure failure.${diagnosticSuffix} Fixture root: ${root}`,
      );
    }
  }
});
