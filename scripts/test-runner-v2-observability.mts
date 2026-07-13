import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  filterRunnerObservability,
  runnerBuildControlSummary,
  runnerObservabilitySummary,
  runnerUserFacingObservability,
} from "../components/RunnerV2ObservabilityPanel";
import { nativeBuildActivityEntries } from "../lib/client/native-build-activity";

const activity = nativeBuildActivityEntries("run_1", [
  {
    sequence: 1,
    type: "task.transitioned",
    occurredAt: "2026-07-12T00:00:00.000Z",
    actor: { role: "runner", id: "scheduler" },
    payload: { taskId: "T1", status: "running" },
  },
  {
    sequence: 2,
    type: "guidance.requested",
    occurredAt: "2026-07-12T00:00:01.000Z",
    actor: { role: "worker", id: "worker_1" },
    payload: { taskId: "T1" },
  },
], 1, (value) => value.slice(11, 19));
assert.deepEqual(activity, [{
  id: "native:run_1:2",
  at: "00:00:01",
  phase: "model_streaming",
  message: "worker worker_1: guidance.requested — T1",
}]);

const projection = {
  runId: "run_1",
  status: "paused",
  planRevision: 2,
  tasks: {
    T1: {
      id: "T1",
      objective: "Implement feature",
      dependencies: [],
      status: "integrated",
      requiredCapabilities: ["code"],
      attempt: 1,
      changeSetId: "change_1",
      integrationRevision: "abc123",
    },
  },
  guidance: {
    guide_1: {
      requestId: "guide_1",
      taskId: "T1",
      blocking: true,
      question: "Which API shape?",
      evidenceSequence: 4,
      version: 1,
      status: "answered",
      answer: "Preserve the public interface.",
    },
  },
  reviews: {},
  runtime: { providerHealth: {}, workerAssignments: {}, architect: {} },
  projectHandoff: {
    status: "requested",
    summary: "Ready",
    options: ["keep_integration_branch", "apply_to_project"],
    integrationRevision: "abc123",
    integrationBranch: "aiboard/run/integration",
  },
  lastSequence: 12,
} as const;
const control = runnerBuildControlSummary(projection);
assert.equal(control.guidance[0].question, "Which API shape?");
assert.equal(control.integration[0].revision, "abc123");
assert.equal(control.branch, "aiboard/run/integration");

const observability = {
  runId: "run_1",
  toolCallCount: 1,
  budget: {
    scopeId: "run_1",
    reservations: {},
    activeSegments: {},
    effective: {
      modelCalls: 9,
      toolCalls: 27,
      inputTokens: 12_000,
      cachedInputTokens: 8_000,
      cacheWriteInputTokens: 2_000,
      outputTokens: 3_000,
      estimatedCostMicros: 125_000,
      activeMs: 45_000,
      artifactBytes: 1_024,
    },
    lastSequence: 42,
  },
  agents: [{
    sessionId: "worker:run_1:T1:1",
    actor: { role: "worker", id: "worker_1" },
    status: "submitted",
    turns: 4,
    lastSequence: 8,
  }],
  tools: [{
    sequence: 1,
    sessionId: "worker:run_1:T1:1",
    callId: "read_1",
    toolName: "fs.read",
    status: "completed",
    occurredAt: "2026-07-12T00:00:00.000Z",
    isError: false,
  }],
  evidence: [{
    id: "evidence_tests_failed",
    taskId: "T1",
    actor: { role: "worker", id: "worker_1" },
    status: "observed",
    fact: { kind: "command", label: "Runner tests", command: "npm test", exitCode: 1 },
    createdAt: "2026-07-12T00:00:01.000Z",
  }, {
    id: "evidence_tests_passed",
    taskId: "T1",
    actor: { role: "worker", id: "worker_1" },
    status: "observed",
    fact: { kind: "command", label: "Runner tests", command: "npm test", exitCode: 0 },
    createdAt: "2026-07-12T00:00:02.000Z",
  }],
  memories: [],
  skills: [{
    id: "built-in:verification",
    name: "verification",
    description: "Gather fresh evidence",
    source: "built-in",
    digest: "a".repeat(64),
  }],
  processes: [],
  providers: [{
    providerId: "chatgpt",
    status: "healthy",
    consecutiveFailures: 0,
    updatedAt: 1,
  }],
  events: [{
    sequence: 1,
    type: "task.transitioned",
    occurredAt: "2026-07-12T00:00:00.000Z",
    actor: { role: "runner", id: "scheduler" },
    payload: { taskId: "T1", to: "running" },
  }],
  git: {
    integrationBranch: "aiboard/run/integration",
    integrationRevision: "abc123",
    commits: [{ revision: "abc123", parents: [], subject: "Integrate T1" }],
  },
} as const;
const summary = runnerObservabilitySummary(observability);

assert.deepEqual(summary, {
  modelCalls: 9,
  toolCalls: 1,
  totalTokens: 15_000,
  cachedInputTokens: 8_000,
  cacheWriteInputTokens: 2_000,
  agents: 1,
  suspendedAgents: 0,
  toolErrors: 0,
  evidence: 2,
  memories: 0,
  skills: 1,
  runningProcesses: 0,
  providers: 1,
  events: 1,
});

const view = runnerUserFacingObservability(observability, projection);
assert.equal(view.lifecycle, "Ready for your decision");
assert.equal(view.progress.completed, 1);
assert.equal(view.progress.total, 1);
assert.equal(view.progress.items[0]?.title, "Implement feature");
assert.equal(view.progress.items[0]?.detail, "Complete");
assert.equal(view.verification.length, 1);
assert.equal(view.verification.find((item) => item.category === "Tests")?.status, "passed");
assert.deepEqual(view.problems, []);

const panelSource = readFileSync(
  new URL("../components/RunnerV2ObservabilityPanel.tsx", import.meta.url),
  "utf8"
);
for (const copy of [
  "Build activity",
  "Progress",
  "Verification",
  "Problems requiring attention",
  "<details",
]) {
  assert.ok(panelSource.includes(copy), `expected panel source to contain ${copy}`);
}
const diagnosticsIndex = panelSource.indexOf("Advanced diagnostics");
assert.ok(diagnosticsIndex >= 0, "expected an Advanced diagnostics disclosure");
for (const diagnosticCopy of [
  "Search durable runner records",
  "Agent sessions",
  "Recent tools",
]) {
  assert.ok(
    panelSource.indexOf(diagnosticCopy) > diagnosticsIndex,
    `expected ${diagnosticCopy} after the Advanced diagnostics disclosure`
  );
}

const filtered = filterRunnerObservability({
  agents: [],
  tools: [{
    sequence: 1,
    sessionId: "worker:run_1:T1:1",
    callId: "read_1",
    toolName: "fs.read",
    status: "completed",
    occurredAt: "2026-07-12T00:00:00.000Z",
  }],
  evidence: [],
  memories: [],
  skills: [],
  processes: [],
  providers: [],
  events: [{
    sequence: 1,
    type: "task.transitioned",
    occurredAt: "2026-07-12T00:00:00.000Z",
    actor: { role: "runner", id: "scheduler" },
    payload: { taskId: "T1" },
  }],
}, "fs.read");
assert.equal(filtered.tools.length, 1);
assert.equal(filtered.events.length, 0);

console.log("PASS Runner V2 observability panel");
