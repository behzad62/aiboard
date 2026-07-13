import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  filterRunnerObservability,
  runnerBuildControlSummary,
  runnerEvidenceDiagnosticDetail,
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
    runId: "run_1",
    taskId: "T1",
    actor: { role: "worker", id: "worker_1" },
    status: "observed",
    fact: {
      kind: "command",
      label: "Runner tests",
      command: "npm",
      args: ["test"],
      cwd: "C:\\project",
      startedAt: "2026-07-12T00:00:00.000Z",
      finishedAt: "2026-07-12T00:00:01.000Z",
      exitCode: 1,
      signal: null,
      timedOut: false,
      cancelled: false,
      outputTruncated: false,
      stdoutArtifactHash: "a".repeat(64),
      stderrArtifactHash: "b".repeat(64),
    },
    createdAt: "2026-07-12T00:00:01.000Z",
    idempotencyKey: "tests:failed",
  }, {
    id: "evidence_tests_passed",
    runId: "run_1",
    taskId: "T1",
    actor: { role: "worker", id: "worker_1" },
    status: "observed",
    fact: {
      kind: "command",
      label: "Runner tests",
      command: "npm",
      args: ["test"],
      cwd: "C:\\project",
      startedAt: "2026-07-12T00:00:01.000Z",
      finishedAt: "2026-07-12T00:00:02.000Z",
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      outputTruncated: false,
      stdoutArtifactHash: "c".repeat(64),
      stderrArtifactHash: "d".repeat(64),
    },
    createdAt: "2026-07-12T00:00:02.000Z",
    idempotencyKey: "tests:passed",
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

const browserScreenshotFact = {
  kind: "browser_screenshot",
  label: "internal screenshot evidence label",
  capturedAt: "2026-07-12T00:00:03.000Z",
  screenshotArtifactHash: "e".repeat(64),
  mediaType: "image/png",
  byteLength: 2_048,
} as const;
const browserEventsFact = {
  kind: "browser_events",
  label: "internal events evidence label",
  capturedAt: "2026-07-12T00:00:04.000Z",
  eventsArtifactHash: "f".repeat(64),
  consoleEventCount: 7,
  consoleErrorCount: 2,
  networkEventCount: 11,
  networkFailureCount: 1,
} as const;
const browserSnapshotFact = {
  kind: "browser_snapshot",
  label: "internal snapshot evidence label",
  url: "http://127.0.0.1:3000/discussion?id=demo",
  title: "AI Board",
  capturedAt: "2026-07-12T00:00:05.000Z",
  htmlArtifactHash: "0".repeat(64),
  htmlBytes: 4_096,
  truncated: false,
} as const;
const browserView = runnerUserFacingObservability({
  ...observability,
  evidence: [{
    id: "evidence_browser_screenshot",
    runId: "run_1",
    taskId: "T_BROWSER_SCREENSHOT",
    actor: { role: "worker", id: "worker_1" },
    status: "observed",
    fact: browserScreenshotFact,
    createdAt: "2026-07-12T00:00:03.000Z",
    idempotencyKey: "browser:screenshot",
  }, {
    id: "evidence_browser_events",
    runId: "run_1",
    taskId: "T_BROWSER_EVENTS",
    actor: { role: "worker", id: "worker_1" },
    status: "observed",
    fact: browserEventsFact,
    createdAt: "2026-07-12T00:00:04.000Z",
    idempotencyKey: "browser:events",
  }, {
    id: "evidence_browser_snapshot",
    runId: "run_1",
    taskId: "T_BROWSER_SNAPSHOT",
    actor: { role: "worker", id: "worker_1" },
    status: "observed",
    fact: browserSnapshotFact,
    createdAt: "2026-07-12T00:00:05.000Z",
    idempotencyKey: "browser:snapshot",
  }],
}, null);
assert.equal(browserView.verification.length, 3);
for (const item of browserView.verification) {
  assert.equal(item.status, "recorded");
  assert.equal(item.category, "Browser checks");
  assert.equal(item.detail, "Browser evidence recorded.");
  assert.ok(!item.detail.includes("internal"));
}
assert.equal(view.verification.find((item) => item.category === "Tests")?.detail, "Latest test result passed.");
assert.equal(
  runnerEvidenceDiagnosticDetail(browserScreenshotFact),
  "browser screenshot recorded · 2,048 bytes"
);
assert.equal(
  runnerEvidenceDiagnosticDetail(browserEventsFact),
  "browser events recorded · 2 console errors · 1 network failure"
);
assert.equal(
  runnerEvidenceDiagnosticDetail(browserSnapshotFact),
  "browser snapshot recorded · AI Board · http://127.0.0.1:3000/discussion?id=demo"
);

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
