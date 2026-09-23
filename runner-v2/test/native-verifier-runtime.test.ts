import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  AgentModel,
  AgentModelRequest,
  ModelTurn,
} from "../src/agent-contracts.js";
import type { AgentLoopCheckpoint } from "../src/agent-loop.js";
import {
  buildVerifierExpectationsContext,
  VERIFIER_ADVERSARIAL_STANCE,
} from "../src/agent-prompts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { NativeVerifierRuntime } from "./support/git-fixture.js";
import { ProviderHealthRegistry } from "../src/provider-health.js";
import {
  RuntimeRouter,
  type AgentRuntimeCandidate,
} from "../src/runtime-router.js";
import { SqliteAgentSessionStore } from "../src/sqlite-agent-session-store.js";
import { SqliteBudgetLedger } from "../src/sqlite-budget-ledger.js";
import { SqliteContextManifestStore } from "../src/sqlite-context-manifest-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import type {
  VerifierReviewProjection,
  VerifierVerdictProjection,
} from "../src/verifier-contracts.js";
import type {
  RecordVerifierExpectationsInput,
  RequestVerifierReviewInput,
  SubmitVerifierVerdictInput,
  VerifierVerdictAuthority,
} from "../src/verifier-verdict-authority.js";

const TARGET_REVISION = "a".repeat(40);
const OTHER_REVISION = "b".repeat(40);
const BASELINE_REVISION = "e".repeat(40);
const HASH = "c".repeat(64);
const PASS_1_TOOLS = [
  "artifact.read",
  "fs.list",
  "fs.read",
  "fs.search",
  "fs.stat",
  "git.status",
  "inspect_evidence",
  "record_verification_expectations",
];
const PASS_2_TOOLS = [
  "artifact.read",
  "fs.list",
  "fs.read",
  "fs.search",
  "fs.stat",
  "git.diff",
  "git.log",
  "git.show",
  "git.status",
  "inspect_evidence",
  "run_evidence_command",
  "submit_verifier_verdict",
];

const candidates: AgentRuntimeCandidate[] = [
  {
    runtimeId: "openai:architect",
    providerId: "openai",
    modelId: "architect",
    capabilities: ["code"],
    priority: 0,
  },
  {
    runtimeId: "anthropic:author",
    providerId: "anthropic",
    modelId: "author",
    capabilities: ["code"],
    priority: 1,
  },
  {
    runtimeId: "google:verifier",
    providerId: "google",
    modelId: "verifier",
    capabilities: ["code"],
    priority: 2,
  },
  {
    runtimeId: "fallback:verifier",
    providerId: "fallback",
    modelId: "fallback-verifier",
    capabilities: ["code"],
    priority: 3,
  },
];

test("typed user selection constrains verifier routing to the preferred candidate", async () => {
  const fixture = createFixture("preferred", [{
    blocks: [{ type: "text", text: "Selected inspection complete." }],
    stopReason: "end_turn",
  }]);
  try {
    const result = await fixture.runtime.inspect({
      ...verifierRequest("run_preferred"),
      preferredRuntimeId: "fallback:verifier",
    });
    assert.equal(result.status, "inspected");
    assert.equal(result.runtimeId, "fallback:verifier");
  } finally {
    fixture.close();
  }
});

test("restart excludes a provider-failed pending verifier session and selects fallback", async () => {
  const authority = new FakeVerifierVerdictAuthority();
  const fixture = createFixture("provider-fallback", [{
    blocks: [{ type: "text", text: "Fallback inspection complete." }],
    stopReason: "end_turn",
  }], TARGET_REVISION, authority);
  const sessionId = "verifier:provider-failed-session";
  try {
    authority.requestReview({
      runId: "run_provider_fallback",
      reviewId: "review-provider-failed",
      targetRevision: TARGET_REVISION,
      finalVerificationGenerationId: "final_generation_1",
      runtime: {
        runtimeId: "google:verifier",
        providerId: "google",
        modelId: "verifier",
        modelIdentity: "verifier",
        sessionId,
      },
      excludedModels: [{
        source: "architect",
        runtimeId: "openai:architect",
        modelIdentity: "architect",
      }],
      criteria: [{ taskId: "task_ui", criterionId: "criterion_ui" }],
      occurredAt: "2026-08-27T00:00:00.000Z",
    });
    await fixture.sessions.create({
      sessionId,
      runId: "run_provider_fallback",
      actor: { role: "verifier", id: "google:verifier" },
      occurredAt: "2026-08-27T00:00:00.000Z",
    });
    fixture.sessions.suspend(
      sessionId,
      "provider_error",
      "provider unavailable",
      "2026-08-27T00:00:01.000Z",
    );

    const result = await fixture.runtime.inspect(
      verifierRequest("run_provider_fallback"),
    );
    assert.equal(result.status, "suspended");
    assert.equal(result.runtimeId, "fallback:verifier");
    assert.notEqual(result.runtimeId, "google:verifier");
  } finally {
    fixture.close();
  }
});

test("verifier receives complete revision-bound context in a separate read-only session", async () => {
  const fixture = createFixture("context", [{
    blocks: [{ type: "text", text: "Inspection complete." }],
    stopReason: "end_turn",
  }]);
  try {
    const result = await fixture.runtime.inspect(verifierRequest("run_context"));

    assert.equal(result.status, "inspected");
    assert.equal(result.runtimeId, "google:verifier");
    assert.equal(result.targetRevision, TARGET_REVISION);
    assert.match(result.sessionId, /^verifier:run_context:/);
    assert.notEqual(result.sessionId, "architect:run_context");
    assert.equal(fixture.workspaceRequests.length, 1);
    assert.deepEqual(fixture.workspaceRequests, [TARGET_REVISION]);

    const request = fixture.model.requests[0]!;
    assert.equal(request.sessionId, result.sessionId);
    assert.equal(request.tools.length > 0, true);
    const command = request.tools.find((definition) => definition.name === "run_evidence_command");
    assert.equal(command?.readOnly, false);
    assert.equal(command?.effect, "external");
    assert.equal(
      request.tools.every(
        (definition) =>
          definition.name === "run_evidence_command" ||
          (definition.readOnly &&
            definition.effect === "none" &&
            definition.lifecycle !== true)
      ),
      true
    );
    const toolNames = request.tools.map((definition) => definition.name);
    for (const required of ["artifact.read", "fs.read", "git.show", "inspect_evidence"]) {
      assert.equal(toolNames.includes(required), true, required);
    }
    for (const forbidden of [
      "fs.write",
      "git.commit",
      "git.push",
      "plan_build",
      "review_task",
      "integrate_task",
      "complete_run",
    ]) {
      assert.equal(toolNames.includes(forbidden), false, forbidden);
    }

    const context = request.messages
      .filter((message) => message.role === "user")
      .map((message) => message.content)
      .join("\n");
    for (const required of [
      "Build the audited application.",
      "criterion_ui",
      "The UI matches the request.",
      "review approved with evidence",
      "Keep the public API stable.",
      "change_set_1",
      "src/app.ts",
      "final build passed",
      "final build command fact",
      "security_auth_crypto_path",
      HASH,
      TARGET_REVISION,
    ]) {
      assert.match(context, new RegExp(escapeRegExp(required)), required);
    }

    const session = await fixture.sessions.load(result.sessionId);
    assert.equal(session.actor.role, "verifier");
    assert.equal(session.actor.id, "google:verifier");
    assert.equal(session.status, "completed");
  } finally {
    fixture.close();
  }
});

test("verifier model calls and evidence inspections consume the governed run budget", async () => {
  const fixture = createFixture("budget-attribution", [
    {
      blocks: [{
        type: "tool_call",
        callId: "inspect-evidence-1",
        name: "inspect_evidence",
        arguments: { taskId: "task_ui" },
      }],
      stopReason: "tool_calls",
      usage: { inputTokens: 40, outputTokens: 8 },
    },
    {
      blocks: [{ type: "text", text: "Evidence inspection complete." }],
      stopReason: "end_turn",
      usage: { inputTokens: 20, outputTokens: 4 },
    },
  ], TARGET_REVISION, undefined, false, true);
  try {
    const result = await fixture.runtime.inspect(
      verifierRequest("run_budget_attribution"),
    );
    assert.equal(result.status, "inspected", JSON.stringify(result));
    const budget = fixture.budgetLedger?.snapshot("run_budget_attribution");
    assert.ok(budget);
    assert.equal(budget.effective.modelCalls, 2);
    assert.equal(budget.effective.toolCalls, 1);
    const modelReservations = Object.values(budget.reservations).filter(
      (reservation) => reservation.kind === "model",
    );
    assert.equal(modelReservations.length, 2);
    assert.equal(
      modelReservations.every(
        (reservation) =>
          reservation.attribution?.role === "verifier" &&
          reservation.attribution.runtimeId === "google:verifier" &&
          reservation.attribution.sessionId === result.sessionId,
      ),
      true,
    );
    assert.equal(
      Object.values(budget.reservations).some(
        (reservation) =>
          reservation.kind === "tool" &&
          reservation.reservationId.endsWith(":inspect-evidence-1"),
      ),
      true,
    );
  } finally {
    fixture.close();
  }
});

test("verifier cannot invoke write, commit, lifecycle, or completion tools", async () => {
  const fixture = createFixture("authority", [
    {
      blocks: [
        {
          type: "tool_call",
          callId: "write-1",
          name: "fs.write",
          arguments: { path: "app.txt", content: "tampered" },
        },
        {
          type: "tool_call",
          callId: "commit-1",
          name: "git.commit",
          arguments: { message: "bypass" },
        },
        {
          type: "tool_call",
          callId: "complete-1",
          name: "complete_run",
          arguments: {},
        },
      ],
      stopReason: "tool_calls",
    },
    {
      blocks: [{ type: "text", text: "No mutation authority is available." }],
      stopReason: "end_turn",
    },
  ]);
  const file = join(fixture.workspacePath, "app.txt");
  writeFileSync(file, "original", "utf8");
  try {
    const result = await fixture.runtime.inspect(verifierRequest("run_authority"));
    assert.equal(result.status, "inspected");
    assert.equal(readFileSync(file, "utf8"), "original");
    const replay = fixture.model.requests[1]!;
    const serialized = JSON.stringify(replay.messages);
    assert.match(serialized, /Tool fs\.write is not registered/);
    assert.match(serialized, /Tool git\.commit is not registered/);
    assert.match(serialized, /Tool complete_run is not registered/);
  } finally {
    fixture.close();
  }
});

test("verifier refuses a workspace whose revision differs from the requested integration snapshot", async () => {
  const fixture = createFixture("stale", [{
    blocks: [{ type: "text", text: "must not run" }],
    stopReason: "end_turn",
  }], OTHER_REVISION);
  try {
    await assert.rejects(
      fixture.runtime.inspect(verifierRequest("run_stale")),
      /workspace target revision.*requested integration revision/i
    );
    assert.equal(fixture.model.requests.length, 0);
    assert.deepEqual(fixture.workspaceRequests, [TARGET_REVISION]);
  } finally {
    fixture.close();
  }
});

test("verifier submits one typed criterion-complete lifecycle verdict with kernel-bound identity", async () => {
  const authority = new FakeVerifierVerdictAuthority();
  const fixture = createFixture("verdict", [{
    blocks: [{
      type: "tool_call",
      callId: "verdict-1",
      name: "submit_verifier_verdict",
      arguments: {
        criterionVerdicts: [{
          taskId: "task_ui",
          criterionId: "criterion_ui",
          verdict: "satisfied",
          rationale: "The exact revision satisfies the UI criterion.",
          evidenceIds: ["evidence_ui"],
        }],
      },
    }],
    stopReason: "tool_calls",
  }], TARGET_REVISION, authority);
  try {
    const result = await fixture.runtime.inspect(verifierRequest("run_verdict"));
    assert.equal(result.status, "verdict_submitted");
    assert.equal(result.verdict.satisfied, true);
    assert.equal(result.replayed, false);
    assert.equal(authority.requests.length, 1);
    assert.equal(authority.submissions.length, 1);
    assert.equal(authority.requests[0]?.runtime.runtimeId, "google:verifier");
    assert.deepEqual(
      authority.requests[0]?.excludedModels.map((model) => model.modelIdentity),
      ["architect", "author"],
    );
    assert.equal(authority.submissions[0]?.actor.id, "google:verifier");
    assert.equal(authority.submissions[0]?.sessionId, result.sessionId);
    assert.equal(authority.submissions[0]?.targetRevision, TARGET_REVISION);

    const definition = fixture.model.requests[0]?.tools.find(
      (tool) => tool.name === "submit_verifier_verdict",
    );
    assert.ok(definition);
    assert.equal(definition.lifecycle, true);
    assert.equal(definition.readOnly, true);
    assert.equal(definition.effect, "none");
    const schema = JSON.stringify(definition.inputSchema);
    assert.doesNotMatch(schema, /runtimeId|providerId|modelId|modelIdentity|sessionId|targetRevision/);
  } finally {
    fixture.close();
  }
});

test("persisted verifier verdict resumes without a duplicate model call", async () => {
  const authority = new FakeVerifierVerdictAuthority();
  const fixture = createFixture("verdict-replay", [], TARGET_REVISION, authority);
  try {
    authority.afterRequest = (review) => ({
      ...review,
      status: "submitted",
      verdict: {
        reviewId: review.reviewId,
        targetRevision: review.targetRevision,
        sessionId: review.runtime.sessionId,
        satisfied: true,
        criterionVerdicts: [{
          taskId: "task_ui",
          criterionId: "criterion_ui",
          verdict: "satisfied",
          rationale: "Already durably submitted before the interruption.",
          evidenceIds: ["evidence_ui"],
        }],
        submittedAt: "2026-08-27T00:00:00.000Z",
      },
    });

    const result = await fixture.runtime.inspect(verifierRequest("run_verdict_replay"));
    assert.equal(result.status, "verdict_submitted");
    assert.equal(result.replayed, true);
    assert.equal(result.verdict.satisfied, true);
    assert.equal(fixture.model.requests.length, 0);
    assert.equal(authority.requests.length, 1);
    assert.equal(authority.submissions.length, 0);
  } finally {
    fixture.close();
  }
});

test("restart after a durable model response executes its pending verdict without another model call", async () => {
  const authority = new FakeVerifierVerdictAuthority();
  const fixture = createFixture("verdict-pending", [{
    blocks: [{
      type: "tool_call",
      callId: "verdict-pending-1",
      name: "submit_verifier_verdict",
      arguments: {
        criterionVerdicts: [{
          taskId: "task_ui",
          criterionId: "criterion_ui",
          verdict: "satisfied",
          rationale: "The pending response contains the complete current verdict.",
          evidenceIds: ["evidence_ui"],
        }],
      },
    }],
    stopReason: "tool_calls",
  }], TARGET_REVISION, authority, true);
  try {
    const interrupted = await fixture.runtime.inspect(
      verifierRequest("run_verdict_pending"),
    );
    assert.equal(interrupted.status, "suspended");
    assert.equal(interrupted.reason, "checkpoint_error");
    assert.equal(authority.submissions.length, 0);
    assert.equal(fixture.model.requests.length, 1);

    const resumed = await fixture.runtime.inspect(
      verifierRequest("run_verdict_pending"),
    );
    assert.equal(resumed.status, "verdict_submitted");
    assert.equal(resumed.verdict.satisfied, true);
    assert.equal(authority.submissions.length, 1);
    assert.equal(fixture.model.requests.length, 1);
  } finally {
    fixture.close();
  }
});

test("every verifier inspection records one context manifest bound to the exact revision", async () => {
  const fixture = createFixture("manifest", [{
    blocks: [{ type: "text", text: "Inspection complete." }],
    stopReason: "end_turn",
  }]);
  try {
    const result = await fixture.runtime.inspect(verifierRequest("run_manifest"));
    assert.equal(result.status, "inspected");
    const manifests = fixture.contextManifests.listRun("run_manifest");
    assert.equal(manifests.length, 1);
    const manifest = manifests[0]!;
    assert.equal(manifest.role, "verifier");
    assert.equal(manifest.purpose, "verifier:inspection");
    assert.equal(manifest.sessionId, result.sessionId);
    assert.equal(manifest.repositoryRevision, TARGET_REVISION);
    assert.equal(manifest.sections.some((section) => section.id === "build-criteria"), true);
    assert.equal(manifest.packArtifactHash, undefined);
  } finally {
    fixture.close();
  }
});

test("every verifier verdict records one context manifest with verdict purpose", async () => {
  const authority = new FakeVerifierVerdictAuthority();
  const fixture = createFixture("manifest-verdict", [{
    blocks: [{
      type: "tool_call",
      callId: "verdict-1",
      name: "submit_verifier_verdict",
      arguments: {
        criterionVerdicts: [{
          taskId: "task_ui",
          criterionId: "criterion_ui",
          verdict: "satisfied",
          rationale: "The exact revision satisfies the UI criterion.",
          evidenceIds: ["evidence_ui"],
        }],
      },
    }],
    stopReason: "tool_calls",
  }], TARGET_REVISION, authority);
  try {
    const result = await fixture.runtime.inspect(verifierRequest("run_manifest_verdict"));
    assert.equal(result.status, "verdict_submitted");
    const manifests = fixture.contextManifests.listRun("run_manifest_verdict");
    assert.equal(manifests.length, 1);
    assert.equal(manifests[0]?.role, "verifier");
    assert.equal(manifests[0]?.purpose, "verifier:verdict");
    assert.equal(manifests[0]?.sessionId, result.sessionId);
    assert.equal(manifests[0]?.repositoryRevision, TARGET_REVISION);
  } finally {
    fixture.close();
  }
});

test("full context recording stores pack text as a content-addressed artifact", async () => {
  const fixture = createFixture("manifest-full", [{
    blocks: [{ type: "text", text: "Inspection complete." }],
    stopReason: "end_turn",
  }], TARGET_REVISION, undefined, false, false, true);
  try {
    const result = await fixture.runtime.inspect(verifierRequest("run_manifest_full"));
    assert.equal(result.status, "inspected");
    const manifests = fixture.contextManifests.listRun("run_manifest_full");
    assert.equal(manifests.length, 1);
    const hash = manifests[0]?.packArtifactHash;
    assert.match(hash ?? "", /^[a-f0-9]{64}$/);
    const bytes = await fixture.artifacts.get(hash!);
    const sent = fixture.model.requests[0]!.messages
      .filter((message) => message.role === "user")
      .map((message) => typeof message.content === "string" ? message.content : "")
      .join("");
    assert.equal(bytes.toString("utf8"), sent);
  } finally {
    fixture.close();
  }
});

test("buildVerifierExpectationsContext names the baseline and omits implementation evidence", () => {
  const pack = buildVerifierExpectationsContext({
    limits: { maxBytes: 512 * 1024, maxEstimatedTokens: 128 * 1024 },
    objective: "Build the audited application.",
    baselineRevision: BASELINE_REVISION,
    targetRevision: TARGET_REVISION,
    criteria: [],
    guidance: [],
    riskReasons: [],
  });
  assert.match(pack.text, /baseline-revision/);
  assert.match(pack.text, new RegExp(BASELINE_REVISION));
  assert.doesNotMatch(pack.text, /integration-revision/);
  assert.doesNotMatch(pack.text, new RegExp(TARGET_REVISION));
  assert.doesNotMatch(pack.text, /accepted-change-history/);
  assert.doesNotMatch(pack.text, /accepted-reviews/);
  assert.doesNotMatch(pack.text, /FINAL-VERIFICATION/);
  assert.doesNotMatch(pack.text, /final build passed/);
  assert.doesNotMatch(pack.text, /Assume the integrated change contains at least one defect/);
  assert.match(VERIFIER_ADVERSARIAL_STANCE, /Assume the integrated change contains at least one defect/);
});

test("two-pass verification records expectations on the baseline before it can see the implementation", async () => {
  const authority = new FakeVerifierVerdictAuthority();
  const fixture = createFixture("two-pass", [
    { blocks: [{ type: "tool_call", callId: "exp-1", name: "record_verification_expectations", arguments: {
      expectations: [{ taskId: "task_ui", criterionId: "criterion_ui",
        expectedBehaviors: ["UI matches the request"], edgeCases: ["empty state"],
        regressionSurfaces: ["src/app.ts"], requiredTests: ["renders empty state"] }] } }],
      stopReason: "tool_calls" },
    { blocks: [{ type: "tool_call", callId: "verdict-1", name: "submit_verifier_verdict", arguments: {
      criterionVerdicts: [{ taskId: "task_ui", criterionId: "criterion_ui", verdict: "satisfied",
        rationale: "Checked both expected behaviors against the revision.", evidenceIds: ["evidence_ui"] }] } }],
      stopReason: "tool_calls" },
  ], TARGET_REVISION, authority, false, false, { twoPass: true });
  try {
    const result = await fixture.runtime.inspect(verifierRequest("run_two_pass", { twoPass: true }));
    assert.equal(result.status, "verdict_submitted");
    assert.deepEqual(fixture.baselineRequests, [BASELINE_REVISION]);
    assert.deepEqual(fixture.workspaceRequests, [TARGET_REVISION]);
    const passOne = JSON.stringify(fixture.model.requests[0]!.messages);
    for (const forbidden of ["accepted-change-history", "accepted-reviews", HASH, "FINAL-VERIFICATION"]) {
      assert.doesNotMatch(passOne, new RegExp(escapeRegExp(forbidden)), forbidden);
    }
    assert.doesNotMatch(passOne, /final build passed/);
    assert.match(passOne, /baseline-revision/);
    assert.doesNotMatch(passOne, /integration-revision/);
    assert.doesNotMatch(passOne, new RegExp(escapeRegExp(TARGET_REVISION)));
    assert.deepEqual(sortedToolNames(fixture.model.requests[0]!), PASS_1_TOOLS);
    assert.equal(fixture.model.requests[0]!.tools.some((tool) => tool.name === "record_verification_expectations"), true);
    assert.equal(fixture.model.requests[0]!.tools.some((tool) => tool.name === "submit_verifier_verdict"), false);
    const passTwo = JSON.stringify(fixture.model.requests[1]!.messages);
    assert.match(passTwo, /recorded-expectations/);
    assert.match(passTwo, /integration-revision/);
    assert.match(passTwo, new RegExp(escapeRegExp(TARGET_REVISION)));
    assert.match(passTwo, /Assume the integrated change contains at least one defect/);
    assert.match(passTwo, new RegExp(escapeRegExp(HASH)));
    assert.deepEqual(sortedToolNames(fixture.model.requests[1]!), PASS_2_TOOLS);
    assert.equal(authority.expectations.length, 1);
    assert.equal(fixture.baselineCleanupCalls, 1);
    assert.notEqual(authority.expectations[0]?.sessionId, result.sessionId, "pass 1 uses its own session");
  } finally {
    fixture.close();
  }
});

test("pass 1 refuses a git.show of the integration revision and still records expectations", async () => {
  const authority = new FakeVerifierVerdictAuthority();
  const fixture = createFixture("pass1-blind-show", [
    { blocks: [{ type: "tool_call", callId: "show-integration", name: "git.show", arguments: {
      revision: TARGET_REVISION } }], stopReason: "tool_calls" },
    { blocks: [{ type: "tool_call", callId: "exp-after-show", name: "record_verification_expectations", arguments: {
      expectations: [{ taskId: "task_ui", criterionId: "criterion_ui",
        expectedBehaviors: ["UI matches the request"], edgeCases: ["empty state"],
        regressionSurfaces: ["src/app.ts"], requiredTests: ["renders empty state"] }] } }],
      stopReason: "tool_calls" },
    { blocks: [{ type: "tool_call", callId: "verdict-after-show", name: "submit_verifier_verdict", arguments: {
      criterionVerdicts: [{ taskId: "task_ui", criterionId: "criterion_ui", verdict: "satisfied",
        rationale: "Checked both expected behaviors against the revision.", evidenceIds: ["evidence_ui"] }] } }],
      stopReason: "tool_calls" },
  ], TARGET_REVISION, authority, false, false, { twoPass: true });
  try {
    const result = await fixture.runtime.inspect(verifierRequest("run_pass1_blind_show", { twoPass: true }));
    assert.equal(result.status, "verdict_submitted");
    assert.deepEqual(sortedToolNames(fixture.model.requests[0]!), PASS_1_TOOLS);
    const passOnePrompt = JSON.stringify(fixture.model.requests[0]!.messages);
    assert.doesNotMatch(passOnePrompt, new RegExp(escapeRegExp(TARGET_REVISION)));
    const refused = JSON.stringify(fixture.model.requests[1]!.messages);
    assert.match(refused, /Tool git\.show is not registered/);
    assert.match(refused, /unknown_tool/);
    assert.equal(
      fixture.model.requests[1]!.tools.some((tool) => tool.name === "record_verification_expectations"),
      true,
    );
    assert.deepEqual(sortedToolNames(fixture.model.requests[2]!), PASS_2_TOOLS);
    assert.match(
      JSON.stringify(fixture.model.requests[2]!.messages),
      new RegExp(escapeRegExp(TARGET_REVISION)),
    );
    assert.equal(authority.expectations.length, 1);
    assert.equal(authority.expectations[0]?.expectations[0]?.expectedBehaviors[0], "UI matches the request");
  } finally {
    fixture.close();
  }
});

test("restart after durable expectations resumes at pass 2 without repeating pass 1", async () => {
  const authority = new FakeVerifierVerdictAuthority();
  authority.afterRequest = (review) => ({
    ...review,
    expectations: [{
      taskId: "task_ui",
      criterionId: "criterion_ui",
      expectedBehaviors: ["UI matches the request"],
      edgeCases: ["empty state"],
      regressionSurfaces: ["src/app.ts"],
      requiredTests: ["renders empty state"],
    }],
    expectationsSessionId: "verifier:already-recorded",
  });
  const fixture = createFixture("two-pass-resume", [
    { blocks: [{ type: "tool_call", callId: "verdict-1", name: "submit_verifier_verdict", arguments: {
      criterionVerdicts: [{ taskId: "task_ui", criterionId: "criterion_ui", verdict: "satisfied",
        rationale: "Checked the recorded expectations against the revision.", evidenceIds: ["evidence_ui"] }] } }],
      stopReason: "tool_calls" },
  ], TARGET_REVISION, authority, false, false, { twoPass: true });
  try {
    const result = await fixture.runtime.inspect(verifierRequest("run_two_pass_resume", { twoPass: true }));
    assert.equal(result.status, "verdict_submitted");
    assert.equal(fixture.model.requests.length, 1);
    assert.deepEqual(fixture.baselineRequests, []);
    assert.equal(authority.expectations.length, 0);
  } finally {
    fixture.close();
  }
});

test("restart during pass 1 resumes the expectations session without a blank prompt", async () => {
  const authority = new FakeVerifierVerdictAuthority();
  const fixture = createFixture("two-pass-pass1-restart", [
    { blocks: [{ type: "tool_call", callId: "exp-restart", name: "record_verification_expectations", arguments: {
      expectations: [{ taskId: "task_ui", criterionId: "criterion_ui",
        expectedBehaviors: ["UI matches the request"], edgeCases: ["empty state"],
        regressionSurfaces: ["src/app.ts"], requiredTests: ["renders empty state"] }] } }],
      stopReason: "tool_calls" },
    { blocks: [{ type: "tool_call", callId: "verdict-restart", name: "submit_verifier_verdict", arguments: {
      criterionVerdicts: [{ taskId: "task_ui", criterionId: "criterion_ui", verdict: "satisfied",
        rationale: "Checked the expectations recorded before the restart.", evidenceIds: ["evidence_ui"] }] } }],
      stopReason: "tool_calls" },
  ], TARGET_REVISION, authority, true, false, { twoPass: true });
  try {
    const interrupted = await fixture.runtime.inspect(
      verifierRequest("run_two_pass_pass1", { twoPass: true }),
    );
    assert.equal(interrupted.status, "suspended");
    assert.equal(interrupted.reason, "checkpoint_error");
    assert.equal(authority.expectations.length, 0);
    assert.equal(fixture.baselineCleanupCalls, 0);
    assert.equal(fixture.model.requests.length, 1);
    assert.equal(
      fixture.model.requests[0]!.tools.some((tool) => tool.name === "record_verification_expectations"),
      true,
    );

    const resumed = await fixture.runtime.inspect(
      verifierRequest("run_two_pass_pass1", { twoPass: true }),
    );
    assert.equal(resumed.status, "verdict_submitted");
    assert.equal(authority.expectations.length, 1);
    assert.equal(authority.expectations[0]?.sessionId !== resumed.sessionId, true);
    assert.equal(fixture.model.requests.length, 2);
    assert.equal(
      fixture.model.requests.filter((request) =>
        request.tools.some((tool) => tool.name === "record_verification_expectations"),
      ).length,
      1,
    );
    assert.equal(
      fixture.model.requests[1]!.tools.some((tool) => tool.name === "submit_verifier_verdict"),
      true,
    );
    assert.equal(fixture.baselineCleanupCalls, 1);
    assert.deepEqual(fixture.baselineRequests, [BASELINE_REVISION, BASELINE_REVISION]);
  } finally {
    fixture.close();
  }
});

test("a two-pass verdict without expectations is refused by the authority", async () => {
  const authority = new FakeVerifierVerdictAuthority();
  const fixture = createFixture("two-pass-missing", [
    { blocks: [{ type: "tool_call", callId: "verdict-1", name: "submit_verifier_verdict", arguments: {
      criterionVerdicts: [{ taskId: "task_ui", criterionId: "criterion_ui", verdict: "satisfied",
        rationale: "Skipped expectations.", evidenceIds: ["evidence_ui"] }] } }],
      stopReason: "tool_calls" },
  ], TARGET_REVISION, authority, false, false, { twoPass: true });
  try {
    const result = await fixture.runtime.inspect(verifierRequest("run_two_pass_missing", { twoPass: true }));
    assert.equal(result.status, "suspended");
    assert.equal(authority.submissions.length, 0);
    assert.match(
      JSON.stringify(result),
      /submit_verifier_verdict is not registered|Two-pass verifier verdict requires recorded expectations/,
    );
  } finally {
    fixture.close();
  }
});

function createFixture(
  name: string,
  turns: ModelTurn[],
  returnedRevision = TARGET_REVISION,
  verdictAuthority?: VerifierVerdictAuthority,
  interruptAfterAssistantCheckpoint = false,
  withBudget = false,
  recordContextPackTextOrOptions: boolean | { twoPass?: boolean; recordContextPackText?: boolean } = false,
) {
  const recordContextPackText = typeof recordContextPackTextOrOptions === "boolean"
    ? recordContextPackTextOrOptions
    : recordContextPackTextOrOptions.recordContextPackText === true;
  const root = mkdtempSync(join(tmpdir(), `aiboard-native-verifier-${name}-`));
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath);
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const sessions = interruptAfterAssistantCheckpoint
    ? new InterruptingSessionStore(join(root, "sessions.sqlite"), artifacts)
    : new SqliteAgentSessionStore(join(root, "sessions.sqlite"), artifacts);
  const evidenceStore = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const contextManifests = new SqliteContextManifestStore(join(root, "context-manifests.sqlite"));
  const budgetLedger = withBudget
    ? new SqliteBudgetLedger(join(root, "budget.sqlite"), {
        limitsFor: () => ({ maxModelCalls: 10, maxToolCalls: 10 }),
      })
    : undefined;
  const model = new ScriptedModel(turns);
  const workspaceRequests: string[] = [];
  const baselineRequests: string[] = [];
  const baselinePath = join(root, "baseline");
  mkdirSync(baselinePath);
  let baselineCleanupCalls = 0;
  const workspaceManager = {
    workspaceKind: "independent-verifier" as const,
    create: async (targetRevision: string) => {
      workspaceRequests.push(targetRevision);
      return {
        runId: "fixture",
        workspaceId: "verifier-fixture",
        path: workspacePath,
        metadataPath: join(root, "workspace.metadata.json"),
        repositoryRoot: workspacePath,
        targetRevision: returnedRevision,
        canonicalRevision: TARGET_REVISION,
      };
    },
    createBaseline: async (revision: string) => {
      baselineRequests.push(revision);
      return {
        runId: "fixture",
        workspaceId: "verifier-baseline",
        path: baselinePath,
        metadataPath: join(root, "baseline.metadata.json"),
        repositoryRoot: workspacePath,
        targetRevision: revision,
        canonicalRevision: revision,
      };
    },
    cleanupBaseline: async () => {
      baselineCleanupCalls += 1;
    },
  };
  const router = new RuntimeRouter({
    candidates,
    health: new ProviderHealthRegistry({ clock: () => 1_000 }),
  });
  return {
    root,
    workspacePath,
    sessions,
    model,
    budgetLedger,
    contextManifests,
    artifacts,
    workspaceRequests,
    baselineRequests,
    get baselineCleanupCalls() { return baselineCleanupCalls; },
    runtime: new NativeVerifierRuntime({
      router,
      candidates,
      models: new Map([
        ["google:verifier", model],
        ["fallback:verifier", model],
      ]),
      verifierRuntimeIds: ["google:verifier", "fallback:verifier"],
      sessions,
      artifacts,
      evidenceStore,
      workspaceManager,
      contextManifests,
      recordContextPackText,
      ...(budgetLedger ? { budgetLedger } : {}),
      ...(verdictAuthority ? { verdictAuthority } : {}),
      clock: () => "2026-08-27T00:00:00.000Z",
    }),
    close: () => {
      budgetLedger?.close();
      contextManifests.close();
      sessions.close();
      evidenceStore.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

class InterruptingSessionStore extends SqliteAgentSessionStore {
  private interrupt = true;

  override async checkpoint(
    sessionId: string,
    checkpoint: AgentLoopCheckpoint,
    occurredAt: string,
  ): Promise<void> {
    await super.checkpoint(sessionId, checkpoint, occurredAt);
    const hasPendingVerdict = checkpoint.messages.some(
      (message) =>
        message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some(
          (block) =>
            block.type === "tool_call" &&
            block.name === "submit_verifier_verdict",
        ),
    ) && !checkpoint.messages.some(
      (message) =>
        message.role === "tool" &&
        !Array.isArray(message.content) &&
        typeof message.content === "object" &&
        message.content.toolName === "submit_verifier_verdict",
    );
    const hasPendingExpectations = checkpoint.messages.some(
      (message) =>
        message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some(
          (block) =>
            block.type === "tool_call" &&
            block.name === "record_verification_expectations",
        ),
    ) && !checkpoint.messages.some(
      (message) =>
        message.role === "tool" &&
        !Array.isArray(message.content) &&
        typeof message.content === "object" &&
        message.content.toolName === "record_verification_expectations",
    );
    if (this.interrupt && (hasPendingVerdict || hasPendingExpectations)) {
      this.interrupt = false;
      throw new Error("Injected interruption after durable verifier response.");
    }
  }
}

class FakeVerifierVerdictAuthority implements VerifierVerdictAuthority {
  readonly requests: RequestVerifierReviewInput[] = [];
  readonly expectations: RecordVerifierExpectationsInput[] = [];
  readonly submissions: SubmitVerifierVerdictInput[] = [];
  afterRequest?: (review: VerifierReviewProjection) => VerifierReviewProjection;
  private current?: VerifierReviewProjection;

  requestReview(input: RequestVerifierReviewInput): VerifierReviewProjection {
    this.requests.push(structuredClone(input));
    const requested: VerifierReviewProjection = {
      reviewId: input.reviewId,
      targetRevision: input.targetRevision,
      finalVerificationGenerationId: input.finalVerificationGenerationId,
      runtime: { ...input.runtime },
      excludedModels: input.excludedModels.map((model) => ({ ...model })),
      criteria: input.criteria.map((criterion) => ({ ...criterion })),
      status: "requested",
      state: "current",
      requestedAt: input.occurredAt,
      ...(input.twoPass === true ? { twoPass: true } : {}),
      ...(input.baselineRevision ? { baselineRevision: input.baselineRevision } : {}),
    };
    this.current = this.afterRequest?.(requested) ?? requested;
    return structuredClone(this.current);
  }

  currentReview(): VerifierReviewProjection | undefined {
    return this.current ? structuredClone(this.current) : undefined;
  }

  recordExpectations(input: RecordVerifierExpectationsInput): VerifierReviewProjection {
    this.expectations.push(structuredClone(input));
    if (!this.current || this.current.status !== "requested") {
      throw new Error("Verifier expectations require a current requested review.");
    }
    if (this.current.twoPass !== true) {
      throw new Error("Verifier expectations require a two-pass review.");
    }
    if (
      input.reviewId !== this.current.reviewId ||
      input.targetRevision !== this.current.targetRevision ||
      input.baselineRevision !== this.current.baselineRevision
    ) {
      throw new Error("Verifier expectations are stale or foreign to the current review.");
    }
    if (this.current.expectations) {
      if (this.current.expectationsSessionId !== input.sessionId) {
        throw new Error("Verifier expectations conflict with the recorded expectations.");
      }
      return structuredClone(this.current);
    }
    this.current = {
      ...this.current,
      expectations: input.expectations.map((expectation) => ({
        ...expectation,
        expectedBehaviors: [...expectation.expectedBehaviors],
        edgeCases: [...expectation.edgeCases],
        regressionSurfaces: [...expectation.regressionSurfaces],
        requiredTests: [...expectation.requiredTests],
      })),
      expectationsSessionId: input.sessionId,
    };
    return structuredClone(this.current);
  }

  submitVerdict(input: SubmitVerifierVerdictInput): VerifierVerdictProjection {
    this.submissions.push(structuredClone(input));
    if (!this.current) throw new Error("No requested verifier review.");
    if (this.current.twoPass === true && !this.current.expectations) {
      throw new Error("Two-pass verifier verdict requires recorded expectations.");
    }
    const verdict: VerifierVerdictProjection = {
      reviewId: input.reviewId,
      targetRevision: input.targetRevision,
      sessionId: input.sessionId,
      satisfied: input.criterionVerdicts.every(
        (criterion) => criterion.verdict === "satisfied",
      ),
      criterionVerdicts: input.criterionVerdicts.map((criterion) => ({
        ...criterion,
        evidenceIds: [...criterion.evidenceIds],
      })),
      submittedAt: input.occurredAt,
    };
    this.current = { ...this.current, status: "submitted", verdict };
    return structuredClone(verdict);
  }
}

function verifierRequest(
  runId: string,
  overrides: { twoPass?: boolean } = {},
) {
  return {
    runId,
    objective: "Build the audited application.",
    targetRevision: TARGET_REVISION,
    architectRuntimeId: "openai:architect",
    criteria: [{
      taskId: "task_ui",
      taskTitle: "Implement the UI",
      criterion: {
        id: "criterion_ui",
        text: "The UI matches the request.",
      },
    }],
    reviews: [{
      taskId: "task_ui",
      attempt: 1,
      status: "approved" as const,
      summary: "review approved with evidence",
      evidenceArtifactHashes: [HASH],
      criterionVerdicts: [{
        criterionId: "criterion_ui",
        verdict: "satisfied" as const,
        rationale: "Evidence is current.",
        evidenceIds: ["evidence_ui"],
      }],
    }],
    guidance: [{
      id: "guidance_1",
      kind: "user_guidance" as const,
      version: 1,
      text: "Keep the public API stable.",
    }],
    changes: [{
      taskId: "task_ui",
      attempt: 1,
      changeSetId: "change_set_1",
      authorRuntimeId: "anthropic:author",
      baselineRevision: OTHER_REVISION,
      taskRevision: TARGET_REVISION,
      changedPaths: ["src/app.ts"],
      diffArtifactHash: HASH,
    }],
    finalVerification: {
      generationId: "final_generation_1",
      targetRevision: TARGET_REVISION,
      green: true,
      checks: [{
        category: "build" as const,
        status: "required" as const,
        green: true,
        rationale: "final build passed",
        evidenceIds: ["final_build_evidence"],
        facts: [{
          kind: "command" as const,
          label: "final build command fact",
          command: "npm",
          args: ["run", "build"],
          cwd: ".",
          startedAt: "2026-08-27T00:00:00.000Z",
          finishedAt: "2026-08-27T00:00:01.000Z",
          exitCode: 0,
          signal: null,
          timedOut: false,
          cancelled: false,
          outputTruncated: false,
          stdoutArtifactHash: HASH,
          stderrArtifactHash: HASH,
          repositoryRevision: TARGET_REVISION,
          category: "build" as const,
          executable: "npm",
          targetRevision: TARGET_REVISION,
          startState: { revision: TARGET_REVISION, status: "" },
          endState: { revision: TARGET_REVISION, status: "" },
        }],
        issues: [],
      }],
    },
    riskReasons: [{
      code: "security_auth_crypto_path" as const,
      evidence: ["src/auth/session.ts"],
    }],
    ...(overrides.twoPass
      ? { twoPass: true as const, baselineRevision: BASELINE_REVISION }
      : {}),
  };
}

class ScriptedModel implements AgentModel {
  readonly requests: AgentModelRequest[] = [];

  constructor(private readonly turns: ModelTurn[]) {}

  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push({
      ...request,
      messages: structuredClone(request.messages),
      tools: structuredClone(request.tools),
    });
    const turn = this.turns.shift();
    if (!turn) throw new Error("Unexpected verifier model call.");
    return structuredClone(turn);
  }
}

function sortedToolNames(request: AgentModelRequest): string[] {
  return request.tools.map((tool) => tool.name).sort();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
