import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  AgentModel,
  AgentModelRequest,
  ModelTurn,
  ToolExecutionContext,
} from "../src/agent-contracts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { NativePlanCriticRuntime } from "../src/native-plan-critic-runtime.js";
import { createSubmitPlanCritiqueTool } from "../src/plan-critique-tools.js";
import type {
  PlanCritiqueAuthority,
  RequestPlanCritiqueInput,
  SubmitPlanCritiqueInput,
} from "../src/plan-critique-authority.js";
import type { PlanCritiqueProjection } from "../src/plan-critique-contracts.js";
import { ProviderHealthRegistry } from "../src/provider-health.js";
import {
  RuntimeRouter,
  type AgentRuntimeCandidate,
} from "../src/runtime-router.js";
import { SqliteAgentSessionStore } from "../src/sqlite-agent-session-store.js";
import { SqliteBudgetLedger } from "../src/sqlite-budget-ledger.js";
import { SqliteContextManifestStore } from "../src/sqlite-context-manifest-store.js";
import type { BuildTask } from "../src/task-contracts.js";
import { fixtureGitContext } from "./support/git-fixture.js";

const BASELINE_REVISION = "a".repeat(40);

const candidates: AgentRuntimeCandidate[] = [
  {
    runtimeId: "openai:architect",
    providerId: "openai",
    modelId: "architect",
    capabilities: ["code"],
    priority: 0,
  },
  {
    runtimeId: "clone:architect",
    providerId: "clone",
    modelId: "openai/architect",
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

const DEFAULT_VERIFIER_RUNTIME_IDS = [
  "openai:architect",
  "clone:architect",
  "google:verifier",
  "fallback:verifier",
] as const;

test("critic receives the task graph at the baseline revision with read-only tools plus submit_plan_critique", async () => {
  const fixture = createFixture("context", [{
    blocks: [{ type: "text", text: "Inspection complete." }],
    stopReason: "end_turn",
  }]);
  try {
    const result = await fixture.runtime.critique(critiqueRequest("run_context"));
    assert.equal(result.status, "suspended");
    assert.equal(result.runtimeId, "google:verifier");
    assert.deepEqual(fixture.workspaceRequests, [BASELINE_REVISION]);

    const request = fixture.model.requests[0]!;
    assert.equal(request.tools.length > 0, true);
    assert.equal(
      request.tools
        .filter((definition) => definition.lifecycle !== true)
        .every((definition) => definition.readOnly && definition.effect === "none"),
      true,
    );
    const toolNames = request.tools.map((definition) => definition.name);
    assert.deepEqual([...toolNames].sort(), [
      "artifact.read",
      "fs.list",
      "fs.read",
      "fs.search",
      "fs.stat",
      "git.diff",
      "git.log",
      "git.show",
      "git.status",
      "submit_plan_critique",
    ]);
    assert.equal(toolNames.includes("submit_plan_critique"), true);
    for (const forbidden of [
      "fs.write",
      "plan_tasks",
      "review_task",
      "submit_verifier_verdict",
    ]) {
      assert.equal(toolNames.includes(forbidden), false, forbidden);
    }
    const submit = request.tools.find((tool) => tool.name === "submit_plan_critique");
    assert.ok(submit);
    assert.equal(submit.readOnly, true);
    assert.equal(submit.effect, "none");
    assert.equal(submit.lifecycle, true);

    const context = userContext(request);
    for (const required of [
      "task_ui",
      "The UI matches the request.",
      BASELINE_REVISION,
      "Implement the UI",
    ]) {
      assert.match(context, new RegExp(escapeRegExp(required)), required);
    }
    assert.doesNotMatch(context, /accepted-change-history/);
    assert.doesNotMatch(context, /final-verification/);
  } finally {
    fixture.close();
  }
});

test("critic submits typed findings once and the result is durable", async () => {
  const authority = new FakePlanCritiqueAuthority();
  const fixture = createFixture("submit", [submitTurn(BLOCKING_FINDING)], {
    authority,
  });
  try {
    const result = await fixture.runtime.critique(critiqueRequest("run_submit"));
    assert.equal(result.status, "submitted");
    assert.equal(result.runtimeId, "google:verifier");
    assert.equal(result.replayed, false);
    assert.equal(authority.submissions.length, 1);
    assert.equal(result.findings[0]?.findingId, "F-1");
    assert.equal(result.findings[0]?.severity, "blocking");
    assert.equal(authority.submissions[0]?.planRevision, 1);
    assert.equal(authority.submissions[0]?.findings[0]?.findingId, "F-1");
    const session = await fixture.sessions.load(result.sessionId);
    assert.equal(session.status, "completed");
    assert.match(result.sessionId, /^plan-critic:/);
  } finally {
    fixture.close();
  }
});

test("fresh-context plan critic request omits architect and worker session text", async () => {
  const sentinel = "R1_FRESH_CONTEXT_SENTINEL";
  const runId = "run_fresh_context_critic";
  const fixture = createFixture("fresh-sentinel", [{
    blocks: [{ type: "text", text: "Fresh inspection complete." }],
    stopReason: "end_turn",
  }], {
    verifierRuntimeIds: ["openai:architect"],
  });
  try {
    await seedForeignSession(fixture.sessions, `architect:${runId}`, runId, "architect", sentinel);
    await seedForeignSession(fixture.sessions, `worker:${runId}`, runId, "worker", sentinel);
    const result = await fixture.runtime.critique(critiqueRequest(runId));
    assert.equal(result.status, "suspended");
    if (result.status === "suspended") {
      assert.equal(result.runtimeId, "openai:architect");
      assert.notEqual(result.sessionId, `architect:${runId}`);
      assert.notEqual(result.sessionId, `worker:${runId}`);
    }
    const request = fixture.model.requests[0];
    assert.ok(request);
    assert.equal(JSON.stringify(request).includes(sentinel), false);
    assert.equal(request.sessionId.startsWith("plan-critic:"), true);
    assert.equal(fixture.authority.requests[0]?.independence, "fresh_context");
  } finally {
    fixture.close();
  }
});

test("critic falls back to a fresh context when every candidate shares the Architect model identity", async () => {
  const fixture = createFixture("fresh-identity", [{
    blocks: [{ type: "text", text: "Fresh inspection complete." }],
    stopReason: "end_turn",
  }], {
    verifierRuntimeIds: ["openai:architect", "clone:architect"],
  });
  try {
    const result = await fixture.runtime.critique(critiqueRequest("run_fresh_identity"));
    assert.equal(result.status, "suspended");
    if (result.status === "suspended") {
      assert.equal(result.runtimeId, "openai:architect");
    }
    assert.equal(fixture.authority.requests[0]?.independence, "fresh_context");
    assert.equal(fixture.model.requests.length, 1);
  } finally {
    fixture.close();
  }
});

test("a durably submitted critique replays without another model call", async () => {
  const authority = new FakePlanCritiqueAuthority();
  const fixture = createFixture("replay", [], { authority });
  try {
    authority.afterRequest = (critique) => ({
      ...critique,
      status: "submitted",
      findings: [BLOCKING_FINDING],
      blockingFindingIds: ["F-1"],
      submittedAt: "2026-09-02T00:00:00.000Z",
    });
    const result = await fixture.runtime.critique(critiqueRequest("run_replay"));
    assert.equal(result.status, "submitted");
    assert.equal(result.replayed, true);
    assert.equal(result.findings[0]?.findingId, "F-1");
    assert.equal(fixture.model.requests.length, 0);
    assert.equal(authority.requests.length, 1);
    assert.equal(authority.submissions.length, 0);
  } finally {
    fixture.close();
  }
});

test("critic model calls are attributed to the verifier budget role", async () => {
  const fixture = createFixture("budget", [{
    blocks: [{ type: "text", text: "Budgeted inspection." }],
    stopReason: "end_turn",
    usage: { inputTokens: 20, outputTokens: 4 },
  }], { withBudget: true });
  try {
    const result = await fixture.runtime.critique(critiqueRequest("run_budget"));
    assert.equal(result.status, "suspended");
    const budget = fixture.budgetLedger?.snapshot("run_budget");
    assert.ok(budget);
    const modelReservations = Object.values(budget.reservations).filter(
      (reservation) => reservation.kind === "model",
    );
    assert.equal(modelReservations.length, 1);
    assert.equal(
      modelReservations.every(
        (reservation) =>
          reservation.attribution?.role === "verifier" &&
          reservation.attribution.sessionId.startsWith("plan-critic:"),
      ),
      true,
    );
    if (result.status === "suspended") {
      assert.match(result.sessionId, /^plan-critic:/);
    }
  } finally {
    fixture.close();
  }
});

test("critic selects an independent runtime rather than the Architect", async () => {
  const fixture = createFixture("independent-selected", [submitTurn(BLOCKING_FINDING)]);
  try {
    const result = await fixture.runtime.critique(critiqueRequest("run_independent"));
    assert.equal(result.status, "submitted");
    assert.equal(result.runtimeId, "google:verifier");
    assert.notEqual(result.runtimeId, "openai:architect");
    assert.notEqual(result.runtimeId, "clone:architect");
  } finally {
    fixture.close();
  }
});

test("critic uses a fresh context when the only candidate is the Architect runtime", async () => {
  const fixture = createFixture("fresh-runtime-id", [{
    blocks: [{ type: "text", text: "Fresh inspection complete." }],
    stopReason: "end_turn",
  }], {
    verifierRuntimeIds: ["openai:architect"],
  });
  try {
    const result = await fixture.runtime.critique(critiqueRequest("run_fresh_runtime"));
    assert.equal(result.status, "suspended");
    if (result.status === "suspended") {
      assert.equal(result.runtimeId, "openai:architect");
    }
    assert.equal(fixture.authority.requests[0]?.independence, "fresh_context");
    assert.deepEqual(
      fixture.authority.requests[0]?.excludedModels.map((model) => model.modelIdentity),
      ["architect"],
    );
  } finally {
    fixture.close();
  }
});

test("critic uses a fresh context when the only candidate shares the Architect canonical model identity", async () => {
  const fixture = createFixture("fresh-canonical", [{
    blocks: [{ type: "text", text: "Fresh inspection complete." }],
    stopReason: "end_turn",
  }], {
    verifierRuntimeIds: ["clone:architect"],
  });
  try {
    const result = await fixture.runtime.critique(critiqueRequest("run_fresh_canonical"));
    assert.equal(result.status, "suspended");
    if (result.status === "suspended") {
      assert.equal(result.runtimeId, "clone:architect");
    }
    assert.equal(fixture.authority.requests[0]?.independence, "fresh_context");
  } finally {
    fixture.close();
  }
});

test("critic uses a fresh context when the only candidate has the Architect provider and model pair", async () => {
  const fixture = createFixture("fresh-provider-model", [{
    blocks: [{ type: "text", text: "Fresh inspection complete." }],
    stopReason: "end_turn",
  }], {
    candidates: [
      ...candidates,
      {
        runtimeId: "openai:shadow-architect",
        providerId: "openai",
        modelId: "architect",
        capabilities: ["code"],
        priority: 0.5,
      },
    ],
    verifierRuntimeIds: ["openai:shadow-architect"],
  });
  try {
    const result = await fixture.runtime.critique(critiqueRequest("run_fresh_pair"));
    assert.equal(result.status, "suspended");
    if (result.status === "suspended") {
      assert.equal(result.runtimeId, "openai:shadow-architect");
    }
    assert.equal(fixture.authority.requests[0]?.independence, "fresh_context");
  } finally {
    fixture.close();
  }
});

test("critic submits advisory findings without blocking the plan", async () => {
  const authority = new FakePlanCritiqueAuthority();
  const fixture = createFixture("advisory", [submitTurn(ADVISORY_FINDING)], {
    authority,
  });
  try {
    const result = await fixture.runtime.critique(critiqueRequest("run_advisory"));
    assert.equal(result.status, "submitted");
    assert.equal(result.findings[0]?.severity, "advisory");
    assert.equal(result.findings[0]?.findingId, "F-2");
    assert.deepEqual(authority.currentCritique("run_advisory")?.blockingFindingIds, []);
  } finally {
    fixture.close();
  }
});

test("critic may submit zero findings", async () => {
  const authority = new FakePlanCritiqueAuthority();
  const fixture = createFixture("zero-findings", [submitTurn()], { authority });
  try {
    const result = await fixture.runtime.critique(critiqueRequest("run_zero"));
    assert.equal(result.status, "submitted");
    assert.deepEqual(result.findings, []);
    assert.equal(authority.submissions.length, 1);
    assert.deepEqual(authority.submissions[0]?.findings, []);
  } finally {
    fixture.close();
  }
});

test("critic ending its turn without submit_plan_critique suspends the session", async () => {
  const fixture = createFixture("no-submit", [{
    blocks: [{ type: "text", text: "The plan looks fine." }],
    stopReason: "end_turn",
  }]);
  try {
    const result = await fixture.runtime.critique(critiqueRequest("run_no_submit"));
    assert.equal(result.status, "suspended");
    assert.equal(result.reason, "model_ended_without_lifecycle");
    assert.equal(fixture.authority.submissions.length, 0);
    const session = await fixture.sessions.load(result.sessionId);
    assert.equal(session.status, "suspended");
  } finally {
    fixture.close();
  }
});

test("critic model budget exhaustion suspends without a durable critique", async () => {
  const fixture = createFixture("budget-exhausted", [{
    blocks: [{ type: "text", text: "should not complete" }],
    stopReason: "end_turn",
  }], {
    withBudget: { maxModelCalls: 0, maxToolCalls: 10 },
  });
  try {
    const result = await fixture.runtime.critique(critiqueRequest("run_budget_exhausted"));
    assert.equal(result.status, "suspended");
    assert.equal(result.reason, "budget_exhausted");
    assert.equal(fixture.authority.submissions.length, 0);
  } finally {
    fixture.close();
  }
});

test("every plan critique records one context manifest bound to the baseline revision", async () => {
  const fixture = createFixture("manifest", [submitTurn(BLOCKING_FINDING)]);
  try {
    const result = await fixture.runtime.critique(critiqueRequest("run_manifest"));
    assert.equal(result.status, "submitted");
    const manifests = fixture.contextManifests.listRun("run_manifest");
    assert.equal(manifests.length, 1);
    const manifest = manifests[0]!;
    assert.equal(manifest.role, "verifier");
    assert.equal(manifest.purpose, "critic:plan_critique");
    assert.equal(manifest.sessionId, result.sessionId);
    assert.equal(manifest.repositoryRevision, BASELINE_REVISION);
    assert.equal(manifest.sections.some((section) => section.id === "task-graph"), true);
    assert.equal(manifest.sections.some((section) => section.id === "critic-authority"), true);
  } finally {
    fixture.close();
  }
});

test("plan critic refuses to complete when durable findings are missing", async () => {
  const authority = new FakePlanCritiqueAuthority();
  authority.afterSubmit = (critique) => {
    const next = { ...critique, status: "submitted" as const };
    delete next.findings;
    return next;
  };
  const fixture = createFixture("not-durable-findings", [submitTurn(BLOCKING_FINDING)], {
    authority,
  });
  try {
    await assert.rejects(
      () => fixture.runtime.critique(critiqueRequest("run_not_durable_findings")),
      /typed critique was durable/,
    );
  } finally {
    fixture.close();
  }
});

test("plan critic refuses to complete when durable status is not submitted", async () => {
  const authority = new FakePlanCritiqueAuthority();
  authority.afterSubmit = (critique) => ({
    ...critique,
    status: "requested",
  });
  const fixture = createFixture("not-durable-status", [submitTurn(BLOCKING_FINDING)], {
    authority,
  });
  try {
    await assert.rejects(
      () => fixture.runtime.critique(critiqueRequest("run_not_durable_status")),
      /typed critique was durable/,
    );
  } finally {
    fixture.close();
  }
});

test("plan critic request requires identity, objective, plan revision, and baseline revision", async () => {
  const fixture = createFixture("assert-request", [submitTurn(BLOCKING_FINDING)]);
  try {
    await assert.rejects(
      () => fixture.runtime.critique({ ...critiqueRequest("run_assert"), runId: "  " }),
      /identity and objective are required/,
    );
    await assert.rejects(
      () => fixture.runtime.critique({ ...critiqueRequest("run_assert"), objective: "  " }),
      /identity and objective are required/,
    );
    await assert.rejects(
      () => fixture.runtime.critique({ ...critiqueRequest("run_assert"), planRevision: 0 }),
      /plan revision is invalid/,
    );
    await assert.rejects(
      () => fixture.runtime.critique({ ...critiqueRequest("run_assert"), planRevision: 1.5 }),
      /plan revision is invalid/,
    );
    await assert.rejects(
      () => fixture.runtime.critique({ ...critiqueRequest("run_assert"), baselineRevision: "not-a-revision" }),
      /baseline revision is invalid/,
    );
  } finally {
    fixture.close();
  }
});

test("submit_plan_critique refuses a stale or foreign tool context", async () => {
  const authority = new FakePlanCritiqueAuthority();
  const tool = createSubmitPlanCritiqueTool({
    authority,
    runId: "run_bound",
    critiqueId: "critique-bound",
    planRevision: 1,
    runtimeId: "google:verifier",
    sessionId: "plan-critic:bound",
    tasks: { [TASK_UI.id]: TASK_UI },
  });
  const bound: ToolExecutionContext = {
    runId: "run_bound",
    sessionId: "plan-critic:bound",
    actor: { role: "verifier", id: "google:verifier" },
  };
  const input = { findings: [BLOCKING_FINDING] };
  await assert.rejects(
    () => tool.execute(input, { ...bound, runId: "run_other" }),
    /stale or foreign/,
  );
  await assert.rejects(
    () => tool.execute(input, { ...bound, sessionId: "session_other" }),
    /stale or foreign/,
  );
  await assert.rejects(
    () => tool.execute(input, { ...bound, actor: { role: "architect", id: "google:verifier" } }),
    /stale or foreign/,
  );
  await assert.rejects(
    () => tool.execute(input, { ...bound, actor: { role: "verifier", id: "openai:architect" } }),
    /stale or foreign/,
  );
  authority.requestCritique({
    runId: "run_bound",
    critiqueId: "critique-bound",
    planRevision: 1,
    runtime: {
      runtimeId: "google:verifier",
      providerId: "google",
      modelId: "verifier",
      modelIdentity: "verifier",
      sessionId: "plan-critic:bound",
    },
    excludedModels: [{
      source: "architect",
      runtimeId: "openai:architect",
      modelIdentity: "architect",
    }],
    occurredAt: "2026-09-02T00:00:00.000Z",
  });
  const ok = await tool.execute(input, bound);
  assert.equal(ok.isError, false);
  assert.equal(ok.lifecycle?.type, "plan_critique_submitted");
  assert.equal(ok.lifecycle && "blockingFindingCount" in ok.lifecycle ? ok.lifecycle.blockingFindingCount : -1, 1);
});

test("submit_plan_critique validate rejects non-objects, unknown fields, and invalid findings", async () => {
  const tool = createSubmitPlanCritiqueTool({
    authority: new FakePlanCritiqueAuthority(),
    runId: "run_validate",
    critiqueId: "critique-validate",
    planRevision: 1,
    runtimeId: "google:verifier",
    sessionId: "plan-critic:validate",
    tasks: { [TASK_UI.id]: TASK_UI },
  });
  const nullResult = tool.validate(null);
  assert.equal(nullResult.ok, false);
  if (!nullResult.ok) assert.match(nullResult.issues.join(" "), /must be an object/);
  const asArray = tool.validate(["findings"]);
  assert.equal(asArray.ok, false);
  if (!asArray.ok) assert.match(asArray.issues.join(" "), /must be an object/);
  const asString = tool.validate("findings");
  assert.equal(asString.ok, false);
  if (!asString.ok) assert.match(asString.issues.join(" "), /must be an object/);
  const asNumber = tool.validate(42);
  assert.equal(asNumber.ok, false);
  if (!asNumber.ok) assert.match(asNumber.issues.join(" "), /must be an object/);
  const unknown = tool.validate({ findings: [], extra: true });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.match(unknown.issues.join(" "), /unknown fields/);
  const invalid = tool.validate({
    findings: [{
      findingId: "F-bad",
      severity: "blocking",
      category: "untestable_criterion",
      taskIds: ["missing_task"],
      claim: "Missing task.",
      evidence: ["no such task"],
    }],
  });
  assert.equal(invalid.ok, false);
  const empty = tool.validate({ findings: [] });
  assert.equal(empty.ok, true);
});

test("durable request bind-check rejects a mismatched plan revision", async () => {
  const authority = new FakePlanCritiqueAuthority();
  authority.afterRequest = (critique) => ({ ...critique, planRevision: 99 });
  const fixture = createFixture("bind-revision", [submitTurn(BLOCKING_FINDING)], {
    authority,
  });
  try {
    await assert.rejects(
      () => fixture.runtime.critique(critiqueRequest("run_bind_revision")),
      /conflicts with its kernel-selected/,
    );
  } finally {
    fixture.close();
  }
});

test("durable request bind-check rejects a mismatched critic runtime identity", async () => {
  const authority = new FakePlanCritiqueAuthority();
  authority.afterRequest = (critique) => ({
    ...critique,
    runtime: { ...critique.runtime, runtimeId: "openai:architect" },
  });
  const fixture = createFixture("bind-runtime", [submitTurn(BLOCKING_FINDING)], {
    authority,
  });
  try {
    await assert.rejects(
      () => fixture.runtime.critique(critiqueRequest("run_bind_runtime")),
      /conflicts with its kernel-selected/,
    );
  } finally {
    fixture.close();
  }
});

test("durable request bind-check rejects a mismatched session identity", async () => {
  const authority = new FakePlanCritiqueAuthority();
  authority.afterRequest = (critique) => ({
    ...critique,
    runtime: { ...critique.runtime, sessionId: "plan-critic:foreign" },
  });
  const fixture = createFixture("bind-session", [submitTurn(BLOCKING_FINDING)], {
    authority,
  });
  try {
    await assert.rejects(
      () => fixture.runtime.critique(critiqueRequest("run_bind_session")),
      /conflicts with its kernel-selected/,
    );
  } finally {
    fixture.close();
  }
});

test("durable request bind-check rejects excluded-model drift", async () => {
  const authority = new FakePlanCritiqueAuthority();
  authority.afterRequest = (critique) => ({
    ...critique,
    excludedModels: [],
  });
  const fixture = createFixture("bind-excluded", [submitTurn(BLOCKING_FINDING)], {
    authority,
  });
  try {
    await assert.rejects(
      () => fixture.runtime.critique(critiqueRequest("run_bind_excluded")),
      /conflicts with its kernel-selected/,
    );
  } finally {
    fixture.close();
  }
});

test("durable lifecycle read-back rejects a mismatched critique id", async () => {
  const authority = new FakePlanCritiqueAuthority();
  authority.afterSubmit = (critique) => ({ ...critique, critiqueId: "critique-other" });
  const fixture = createFixture("durable-id", [submitTurn(BLOCKING_FINDING)], { authority });
  try {
    await assert.rejects(
      () => fixture.runtime.critique(critiqueRequest("run_durable_id")),
      /typed critique was durable/,
    );
  } finally {
    fixture.close();
  }
});

test("durable lifecycle read-back rejects a mismatched runtime id", async () => {
  const authority = new FakePlanCritiqueAuthority();
  authority.afterSubmit = (critique) => ({
    ...critique,
    runtime: { ...critique.runtime, runtimeId: "openai:architect" },
  });
  const fixture = createFixture("durable-runtime", [submitTurn(BLOCKING_FINDING)], { authority });
  try {
    await assert.rejects(
      () => fixture.runtime.critique(critiqueRequest("run_durable_runtime")),
      /typed critique was durable/,
    );
  } finally {
    fixture.close();
  }
});

test("durable lifecycle read-back rejects a mismatched session id", async () => {
  const authority = new FakePlanCritiqueAuthority();
  authority.afterSubmit = (critique) => ({
    ...critique,
    runtime: { ...critique.runtime, sessionId: "plan-critic:foreign" },
  });
  const fixture = createFixture("durable-session", [submitTurn(BLOCKING_FINDING)], { authority });
  try {
    await assert.rejects(
      () => fixture.runtime.critique(critiqueRequest("run_durable_session")),
      /typed critique was durable/,
    );
  } finally {
    fixture.close();
  }
});

test("durable lifecycle read-back rejects a mismatched plan revision", async () => {
  const authority = new FakePlanCritiqueAuthority();
  authority.afterSubmit = (critique) => ({ ...critique, planRevision: 99 });
  const fixture = createFixture("durable-revision", [submitTurn(BLOCKING_FINDING)], { authority });
  try {
    await assert.rejects(
      () => fixture.runtime.critique(critiqueRequest("run_durable_revision")),
      /typed critique was durable/,
    );
  } finally {
    fixture.close();
  }
});

test("durable request bind-check rejects a mismatched critic provider", async () => {
  const authority = new FakePlanCritiqueAuthority();
  authority.afterRequest = (critique) => ({
    ...critique,
    runtime: { ...critique.runtime, providerId: "other" },
  });
  const fixture = createFixture("bind-provider", [submitTurn(BLOCKING_FINDING)], {
    authority,
  });
  try {
    await assert.rejects(
      () => fixture.runtime.critique(critiqueRequest("run_bind_provider")),
      /conflicts with its kernel-selected/,
    );
  } finally {
    fixture.close();
  }
});

test("durable request bind-check rejects a mismatched critic model id", async () => {
  const authority = new FakePlanCritiqueAuthority();
  authority.afterRequest = (critique) => ({
    ...critique,
    runtime: { ...critique.runtime, modelId: "other-model" },
  });
  const fixture = createFixture("bind-model", [submitTurn(BLOCKING_FINDING)], {
    authority,
  });
  try {
    await assert.rejects(
      () => fixture.runtime.critique(critiqueRequest("run_bind_model")),
      /conflicts with its kernel-selected/,
    );
  } finally {
    fixture.close();
  }
});

test("durable request bind-check rejects a mismatched critic model identity", async () => {
  const authority = new FakePlanCritiqueAuthority();
  authority.afterRequest = (critique) => ({
    ...critique,
    runtime: { ...critique.runtime, modelIdentity: "other-identity" },
  });
  const fixture = createFixture("bind-identity", [submitTurn(BLOCKING_FINDING)], {
    authority,
  });
  try {
    await assert.rejects(
      () => fixture.runtime.critique(critiqueRequest("run_bind_identity")),
      /conflicts with its kernel-selected/,
    );
  } finally {
    fixture.close();
  }
});

const TASK_UI: BuildTask = {
  id: "task_ui",
  objective: "Implement the UI",
  dependencies: [],
  status: "planned",
  requiredCapabilities: ["code"],
  attempt: 0,
  acceptanceCriteria: [{
    id: "criterion_ui",
    text: "The UI matches the request.",
  }],
};

const BLOCKING_FINDING = {
  findingId: "F-1",
  severity: "blocking" as const,
  category: "untestable_criterion" as const,
  taskIds: ["task_ui"],
  criterionIds: [{ taskId: "task_ui", criterionId: "criterion_ui" }],
  claim: "The UI criterion is not objectively testable.",
  evidence: ["criterion_ui: The UI matches the request."],
};

const ADVISORY_FINDING = {
  findingId: "F-2",
  severity: "advisory" as const,
  category: "oversized_task" as const,
  taskIds: ["task_ui"],
  claim: "The task may be too large for one worker.",
  evidence: ["task_ui objective spans UI and persistence"],
};

function critiqueRequest(runId: string) {
  return {
    runId,
    objective: "Build the audited application.",
    planRevision: 1,
    baselineRevision: BASELINE_REVISION,
    architectRuntimeId: "openai:architect",
    tasks: [TASK_UI],
    riskReasons: [{
      code: "task_count" as const,
      evidence: ["tasks:5"],
    }],
    guidance: [{
      id: "guidance_1",
      kind: "user_guidance" as const,
      version: 1,
      text: "Keep the public API stable.",
    }],
  };
}

function submitTurn(finding?: typeof BLOCKING_FINDING | typeof ADVISORY_FINDING): ModelTurn {
  return {
    blocks: [{
      type: "tool_call",
      callId: "critique-1",
      name: "submit_plan_critique",
      arguments: { findings: finding ? [finding] : [] },
    }],
    stopReason: "tool_calls",
  };
}

async function seedForeignSession(
  sessions: SqliteAgentSessionStore,
  sessionId: string,
  runId: string,
  role: "architect" | "worker",
  sentinel: string,
): Promise<void> {
  await sessions.create({
    sessionId,
    runId,
    actor: { role, id: "openai:architect" },
    occurredAt: "2026-09-02T00:00:00.000Z",
  });
  await sessions.checkpoint(sessionId, {
    messages: [{ id: `${role}-sentinel`, role: "user", content: sentinel }],
    turns: 1,
    seenCallIds: [],
  }, "2026-09-02T00:00:00.000Z");
}

function createFixture(
  name: string,
  turns: ModelTurn[],
  options: {
    authority?: FakePlanCritiqueAuthority;
    withBudget?: boolean | { maxModelCalls: number; maxToolCalls: number };
    recordContextPackText?: boolean;
    verifierRuntimeIds?: readonly string[];
    candidates?: readonly AgentRuntimeCandidate[];
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), `aiboard-native-plan-critic-${name}-`));
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath);
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const sessions = new SqliteAgentSessionStore(join(root, "sessions.sqlite"), artifacts);
  const contextManifests = new SqliteContextManifestStore(join(root, "context-manifests.sqlite"));
  const budgetLimits = options.withBudget === true
    ? { maxModelCalls: 10, maxToolCalls: 10 }
    : options.withBudget || undefined;
  const budgetLedger = budgetLimits
    ? new SqliteBudgetLedger(join(root, "budget.sqlite"), {
        limitsFor: () => budgetLimits,
      })
    : undefined;
  const model = new ScriptedModel(turns);
  const workspaceRequests: string[] = [];
  const workspaceManager = {
    workspaceKind: "independent-verifier" as const,
    create: async (targetRevision: string) => {
      workspaceRequests.push(targetRevision);
      return {
        runId: "fixture",
        workspaceId: "critic-fixture",
        path: workspacePath,
        metadataPath: join(root, "workspace.metadata.json"),
        repositoryRoot: workspacePath,
        targetRevision,
        canonicalRevision: BASELINE_REVISION,
      };
    },
    createBaseline: async () => {
      throw new Error("Plan critic must not open the verifier baseline workspace.");
    },
    cleanupBaseline: async () => {
      throw new Error("Plan critic must not clean the verifier baseline workspace.");
    },
  };
  const activeCandidates = options.candidates ?? candidates;
  const router = new RuntimeRouter({
    candidates: activeCandidates,
    health: new ProviderHealthRegistry({ clock: () => 1_000 }),
  });
  const authority = options.authority ?? new FakePlanCritiqueAuthority();
  const verifierRuntimeIds = [...(options.verifierRuntimeIds ?? DEFAULT_VERIFIER_RUNTIME_IDS)];
  const models = new Map<string, AgentModel>(
    verifierRuntimeIds.map((runtimeId) => [runtimeId, model]),
  );
  return {
    root,
    workspacePath,
    sessions,
    model,
    budgetLedger,
    contextManifests,
    artifacts,
    workspaceRequests,
    authority,
    runtime: new NativePlanCriticRuntime({
      git: fixtureGitContext(),
      router,
      candidates: activeCandidates,
      models,
      verifierRuntimeIds,
      sessions,
      artifacts,
      workspaceManager,
      critiqueAuthority: authority,
      contextManifests,
      recordContextPackText: options.recordContextPackText,
      ...(budgetLedger ? { budgetLedger } : {}),
      clock: () => "2026-09-02T00:00:00.000Z",
    }),
    close: () => {
      budgetLedger?.close();
      contextManifests.close();
      sessions.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

class FakePlanCritiqueAuthority implements PlanCritiqueAuthority {
  readonly requests: RequestPlanCritiqueInput[] = [];
  readonly submissions: SubmitPlanCritiqueInput[] = [];
  afterRequest?: (critique: PlanCritiqueProjection) => PlanCritiqueProjection;
  afterSubmit?: (critique: PlanCritiqueProjection) => PlanCritiqueProjection;
  persistSubmissions = true;
  private current?: PlanCritiqueProjection;

  requestCritique(input: RequestPlanCritiqueInput): PlanCritiqueProjection {
    this.requests.push(structuredClone(input));
    const requested: PlanCritiqueProjection = {
      critiqueId: input.critiqueId,
      planRevision: input.planRevision,
      runtime: { ...input.runtime },
      excludedModels: input.excludedModels.map((model) => ({ ...model })),
      ...(input.independence ? { independence: input.independence } : {}),
      status: "requested",
      requestedAt: input.occurredAt,
    };
    this.current = this.afterRequest?.(requested) ?? requested;
    return structuredClone(this.current);
  }

  currentCritique(_runId?: string): PlanCritiqueProjection | undefined {
    return this.current ? structuredClone(this.current) : undefined;
  }

  submitFindings(input: SubmitPlanCritiqueInput): PlanCritiqueProjection {
    this.submissions.push(structuredClone(input));
    if (!this.current) throw new Error("No requested plan critique.");
    if (!this.persistSubmissions) return structuredClone(this.current);
    this.current = {
      ...this.current,
      status: "submitted",
      findings: input.findings.map((finding) => ({
        ...finding,
        taskIds: [...finding.taskIds],
        evidence: [...finding.evidence],
      })),
      blockingFindingIds: input.findings
        .filter((finding) => finding.severity === "blocking")
        .map((finding) => finding.findingId),
      submittedAt: input.occurredAt,
    };
    this.current = this.afterSubmit?.(this.current) ?? this.current;
    return structuredClone(this.current);
  }
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
    if (!turn) throw new Error("Unexpected plan critic model call.");
    return structuredClone(turn);
  }
}

function userContext(request: AgentModelRequest): string {
  return request.messages
    .filter((message) => message.role === "user")
    .map((message) => typeof message.content === "string" ? message.content : "")
    .join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
