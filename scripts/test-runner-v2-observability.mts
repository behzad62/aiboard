import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  filterRunnerObservability,
  runnerBuildControlSummary,
  runnerEvidenceDiagnosticDetail,
  runnerNextCooldownExpiry,
  runnerObservabilitySummary,
  runnerUserFacingObservability,
  runnerVerificationTone,
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
  }, {
    sessionId: "worker:run_1:T0:1:subagent:research_1",
    actor: { role: "subagent", id: "worker_old:research_1" },
    status: "suspended",
    turns: 2,
    suspensionReason: "subagent_incomplete",
    lastSequence: 5,
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
  agents: 2,
  suspendedAgents: 1,
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

assert.equal(runnerVerificationTone([{ status: "failed" }, { status: "passed" }]), "error");
assert.equal(runnerVerificationTone([{ status: "passed" }, { status: "recorded" }]), "success");
assert.equal(runnerVerificationTone([{ status: "recorded" }]), "progress");
assert.equal(runnerVerificationTone([]), "progress");

const projectionWithoutHandoff = {
  ...projection,
  status: "running",
  projectHandoff: undefined,
};
const problemKeys = (
  snapshot: Parameters<typeof runnerUserFacingObservability>[0],
  projected: Parameters<typeof runnerUserFacingObservability>[1],
  now?: number
) => runnerUserFacingObservability(snapshot, projected, now).problems.map((problem) => problem.key);

assert.deepEqual(problemKeys(observability, {
  ...projectionWithoutHandoff,
  guidance: {
    guide_1: { ...projection.guidance.guide_1, status: "open", answer: undefined },
  },
}), ["guidance:guide_1"]);
assert.deepEqual(problemKeys(observability, projectionWithoutHandoff), []);
assert.deepEqual(problemKeys(observability, {
  ...projectionWithoutHandoff,
  tasks: { T1: { ...projection.tasks.T1, status: "failed" } },
}), ["task:T1"]);
assert.deepEqual(problemKeys(observability, {
  ...projectionWithoutHandoff,
  tasks: { T1: { ...projection.tasks.T1, status: "rejected" } },
}), ["task:T1"]);
assert.deepEqual(problemKeys(observability, {
  ...projectionWithoutHandoff,
  tasks: {
    T1: {
      ...projection.tasks.T1,
      status: "integration_resolution",
      conflictPaths: ["components/panel.tsx"],
    },
  },
}), ["conflict:T1"]);
assert.deepEqual(problemKeys(observability, {
  ...projectionWithoutHandoff,
  status: "paused",
}), ["run:paused"]);

const cooldownNow = 2_000;
assert.equal(runnerNextCooldownExpiry([{
  providerId: "chatgpt",
  status: "cooldown",
  consecutiveFailures: 1,
  cooldownUntil: cooldownNow + 500,
  updatedAt: cooldownNow - 100,
}, {
  providerId: "openai",
  status: "cooldown",
  consecutiveFailures: 2,
  cooldownUntil: cooldownNow + 100,
  updatedAt: cooldownNow - 50,
}, {
  providerId: "anthropic",
  status: "healthy",
  consecutiveFailures: 0,
  cooldownUntil: cooldownNow + 50,
  updatedAt: cooldownNow,
}], cooldownNow), cooldownNow + 100);
assert.equal(runnerNextCooldownExpiry([{
  providerId: "chatgpt",
  status: "cooldown",
  consecutiveFailures: 1,
  cooldownUntil: cooldownNow,
  updatedAt: cooldownNow - 100,
}, {
  providerId: "openai",
  status: "cooldown",
  consecutiveFailures: 1,
  updatedAt: cooldownNow - 50,
}], cooldownNow), null);
const activeCooldownObservability = {
  ...observability,
  providers: [{
    providerId: "chatgpt",
    status: "cooldown",
    consecutiveFailures: 1,
    cooldownUntil: cooldownNow + 1,
    updatedAt: cooldownNow - 100,
  }],
} as const;
const activeCooldownView = runnerUserFacingObservability(
  activeCooldownObservability,
  projectionWithoutHandoff,
  cooldownNow
);
assert.deepEqual(activeCooldownView.problems.map((problem) => problem.key), ["provider:chatgpt"]);
assert.equal(
  activeCooldownView.problems[0]?.detail,
  "Wait until the provider is available, then resume the build if it is paused."
);
assert.deepEqual(problemKeys({
  ...activeCooldownObservability,
  providers: [{
    ...activeCooldownObservability.providers[0],
    cooldownUntil: cooldownNow,
  }],
}, projectionWithoutHandoff, cooldownNow), []);

const currentWorkerView = runnerUserFacingObservability({
  ...observability,
  agents: [...observability.agents, {
    sessionId: "worker:run_1:T1:2",
    actor: { role: "worker", id: "worker_current" },
    status: "suspended",
    turns: 3,
    suspensionReason: "provider_error",
    lastSequence: 13,
  }],
}, {
  ...projection,
  tasks: {
    T1: {
      ...projection.tasks.T1,
      status: "running",
      attempt: 2,
      assignedWorkerId: "worker_current",
    },
  },
  projectHandoff: undefined,
});
assert.equal(currentWorkerView.problems.length, 1);
assert.equal(currentWorkerView.problems[0]?.key, "agent:worker:run_1:T1:2");
assert.equal(currentWorkerView.problems[0]?.title, "An active agent is paused");

const staleSubmittedWorkerView = runnerUserFacingObservability({
  ...observability,
  agents: [...observability.agents, {
    sessionId: "worker:run_1:T1:1:stale",
    actor: { role: "worker", id: "worker_submitted" },
    status: "suspended",
    turns: 2,
    suspensionReason: "model_ended_without_lifecycle",
    lastSequence: 9,
  }],
}, {
  ...projection,
  status: "running",
  tasks: {
    T1: {
      ...projection.tasks.T1,
      status: "submitted",
      assignedWorkerId: "worker_submitted",
    },
  },
  projectHandoff: undefined,
});
assert.deepEqual(staleSubmittedWorkerView.problems, []);

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
const detailsMatch = panelSource.match(/<details[^>]*>/);
assert.ok(detailsMatch?.index !== undefined, "expected an Advanced diagnostics disclosure");
assert.ok(!/\bopen\b/.test(detailsMatch[0]), "expected Advanced diagnostics to be collapsed by default");
const detailsOpenIndex = detailsMatch.index;
const detailsCloseIndex = panelSource.indexOf("</details>", detailsOpenIndex);
assert.ok(detailsCloseIndex > detailsOpenIndex, "expected the Advanced diagnostics closing tag");
const diagnosticsSource = panelSource.slice(detailsOpenIndex, detailsCloseIndex);
assert.ok(diagnosticsSource.includes("Advanced diagnostics"));
for (const diagnosticCopy of [
  "Diagnostic overview",
  "Model calls",
  "Tool calls",
  "Tokens",
  "Search durable runner records",
  "Download audit",
  "Agent sessions",
  "Recent tools",
  "Evidence",
  "Context resources",
  "Provider health",
  "Recent events",
  "Architect guidance",
  "Integration queue and Git",
  "Background processes",
]) {
  assert.ok(
    diagnosticsSource.includes(diagnosticCopy),
    `expected ${diagnosticCopy} inside the Advanced diagnostics disclosure`
  );
}
for (const rawDiagnosticCopy of [
  "Diagnostic overview",
  "Agent sessions",
  "Recent tools",
  "Context resources",
  "Provider health",
  "Recent events",
  "Architect guidance",
  "Integration queue and Git",
  "Background processes",
]) {
  assert.ok(
    !panelSource.slice(0, detailsOpenIndex).includes(rawDiagnosticCopy),
    `expected ${rawDiagnosticCopy} not to appear before Advanced diagnostics`
  );
}
assert.match(
  diagnosticsSource,
  /<input[\s\S]*?type="search"[\s\S]*?aria-label="Search durable runner records"/,
  "expected diagnostics search to have a stable accessible name"
);

const panelComponentIndex = panelSource.indexOf("export function RunnerV2ObservabilityPanel");
const panelComponentSource = panelSource.slice(panelComponentIndex);
const nullReturnIndex = panelComponentSource.indexOf("if (!snapshot) return null");
const cooldownEffectIndex = panelComponentSource.indexOf("useEffect(() =>");
assert.ok(cooldownEffectIndex >= 0 && cooldownEffectIndex < nullReturnIndex, "expected cooldown effect before null return");
assert.ok(
  panelComponentSource.includes("runnerNextCooldownExpiry(snapshot?.providers ?? [], clock)"),
  "expected the component clock to select the next provider cooldown expiry"
);
assert.ok(panelComponentSource.includes("setTimeout("), "expected a one-shot cooldown expiry timer");
assert.ok(panelComponentSource.includes("clearTimeout("), "expected cooldown timer cleanup");
assert.ok(!panelComponentSource.includes("setInterval("), "expected no cooldown polling interval");
assert.ok(
  panelComponentSource.includes("runnerUserFacingObservability(snapshot, projection ?? null, clock)"),
  "expected the component clock to drive the user-facing projection"
);

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
