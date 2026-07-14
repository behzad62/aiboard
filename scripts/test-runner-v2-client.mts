import assert from "node:assert/strict";

import {
  configureNativeProviders,
  createNativeBuild,
  getNativeBuildAudit,
  getNativeBuildFiles,
  getNativeBuildTranscript,
  getNativeBuildUsage,
  getNativeBuildObservability,
  resolveNativeBuildRunId,
  getNativeRunnerHealth,
  selectNativeProjectHandoff,
  type NativeRunnerConnection,
} from "../lib/client/runner-v2";
import {
  nativeBuildProvisioningRunId,
  nativePricingMicros,
  resolveNativeProviderTransport,
  nativeProviderProtocol,
  selectNativeBuildRuntimes,
} from "../lib/client/native-build-engine";

assert.equal(
  nativeBuildProvisioningRunId("native-reserved-by-browser"),
  "native-reserved-by-browser",
  "native provisioning uses the exact browser-reserved run identity"
);

assert.deepEqual(nativePricingMicros({
  inputUsdPer1M: 2.5,
  cachedInputUsdPer1M: 0.25,
  outputUsdPer1M: 15,
  sourceLabel: "test",
  sourceUrl: "",
  verifiedAt: "2026-07-12",
}), {
  inputCostMicrosPerMillion: 2_500_000,
  cachedInputCostMicrosPerMillion: 250_000,
  cacheWriteInputCostMicrosPerMillion: 2_500_000,
  outputCostMicrosPerMillion: 15_000_000,
});

assert.deepEqual(
  selectNativeBuildRuntimes(
    ["chatgpt:gpt-5.5", "chatgpt:gpt-5.4"],
    "chatgpt:gpt-5.5"
  ),
  {
    configuredRuntimeIds: ["chatgpt:gpt-5.5", "chatgpt:gpt-5.4"],
    workerRuntimeIds: ["chatgpt:gpt-5.4"],
  }
);
assert.deepEqual(resolveNativeProviderTransport("openai"), {
  transport: "openai-compatible",
  baseUrl: "https://api.openai.com/v1",
});
assert.equal(nativeProviderProtocol("openai", "gpt-5.3-codex"), "responses");
assert.equal(nativeProviderProtocol("openai", "gpt-5.6"), "chat-completions");
assert.equal(nativeProviderProtocol("openrouter", "openai/gpt-5.3-codex"), "chat-completions");
assert.deepEqual(resolveNativeProviderTransport("anthropic"), {
  transport: "anthropic",
});
assert.deepEqual(resolveNativeProviderTransport("foundry", "https://azure.example/anthropic"), {
  transport: "anthropic",
  baseUrl: "https://azure.example/anthropic",
});
assert.deepEqual(resolveNativeProviderTransport("google"), {
  transport: "google",
});
assert.deepEqual(resolveNativeProviderTransport(
  "nvidia",
  "http://127.0.0.1:1455",
  "runner-token"
), {
  transport: "account-runner",
  baseUrl: "http://127.0.0.1:1455",
});
assert.deepEqual(
  selectNativeBuildRuntimes(["chatgpt:gpt-5.5"], "chatgpt:gpt-5.5"),
  {
    configuredRuntimeIds: ["chatgpt:gpt-5.5"],
    workerRuntimeIds: ["chatgpt:gpt-5.5"],
  }
);

const connection: NativeRunnerConnection = {
  url: "http://127.0.0.1:8787/",
  token: "runner-control-token",
};
const calls: Array<{ url: string; init: RequestInit }> = [];
const fetchImpl: typeof fetch = async (input, init = {}) => {
  calls.push({ url: String(input), init });
  if (String(input).endsWith("/v2/health")) {
    return Response.json({
      ok: true,
      protocolVersion: 2,
      projectPath: "C:/project",
      nodeVersion: "24.18.0",
    });
  }
  if (String(input).endsWith("/build/usage")) {
    return Response.json({
      scopeId: "run_1",
      reservations: {},
      activeSegments: {},
      effective: {
        modelCalls: 9,
        toolCalls: 27,
        inputTokens: 12_000,
        outputTokens: 3_000,
        estimatedCostMicros: 125_000,
        activeMs: 45_000,
        artifactBytes: 1_024,
      },
      lastSequence: 42,
    });
  }
  if (String(input).endsWith("/build/observability")) {
    return Response.json({
      runId: "run_1",
      toolCallCount: 1,
      budget: { effective: { modelCalls: 9, toolCalls: 27 } },
      agents: [{ sessionId: "worker:run_1:T1:1", status: "submitted" }],
      tools: [{ callId: "read_1", toolName: "fs.read", status: "completed" }],
      evidence: [],
      memories: [],
      skills: [],
      processes: [],
      providers: [],
      events: [],
      git: { integrationBranch: "aiboard/run/integration", integrationRevision: "abc123", commits: [] },
    });
  }
  if (String(input).endsWith("/build/audit")) {
    return Response.json({
      protocolVersion: 2,
      run: { runId: "run_1" },
      build: { runId: "run_1" },
      usage: { effective: { modelCalls: 9 } },
      observability: { runId: "run_1", toolCallCount: 1 },
      runEvents: [{ sequence: 1 }],
      buildEvents: [{ sequence: 1 }],
    });
  }
  return Response.json({ runId: "run_1", state: "created" }, { status: 201 });
};

const health = await getNativeRunnerHealth(connection, fetchImpl);
assert.equal(health.projectPath, "C:/project");
await configureNativeProviders(connection, [{
  runtimeId: "chatgpt:gpt-5.5",
  providerId: "chatgpt",
  modelId: "gpt-5.5",
  transport: "account-runner",
  baseUrl: "http://127.0.0.1:1455",
  secret: "provider-secret",
  capabilities: ["code"],
  priority: 1,
  inputCostMicrosPerMillion: 2_500_000,
  cachedInputCostMicrosPerMillion: 250_000,
  outputCostMicrosPerMillion: 15_000_000,
}], fetchImpl);
await createNativeBuild(connection, {
  runId: "run_1",
  projectPath: health.projectPath,
  permissionProfile: "full",
  idempotencyKey: "create:run_1",
  build: {
    projectId: "discussion_1",
    objective: "Build the requested feature.",
    architectRuntimeId: "chatgpt:gpt-5.5",
    workerRuntimeIds: ["chatgpt:gpt-5.5"],
    maxConcurrency: 2,
    runPolicy: "budgeted",
    budgetLimits: {
      maxEstimatedCostMicros: 1_000_000,
      maxActiveMs: 1_800_000,
    },
  },
}, fetchImpl);
await selectNativeProjectHandoff(
  connection,
  "run_1",
  "keep_integration_branch",
  "handoff:keep",
  fetchImpl
);
const usage = await getNativeBuildUsage(connection, "run_1", fetchImpl);
assert.equal(usage.effective.modelCalls, 9);
assert.equal(usage.effective.inputTokens, 12_000);
const observed = await getNativeBuildObservability(connection, "run_1", fetchImpl);
assert.equal(observed.agents.length, 1);
assert.equal(observed.toolCallCount, 1);
assert.equal(observed.tools[0].toolName, "fs.read");
const audit = await getNativeBuildAudit(connection, "run_1", fetchImpl);
assert.equal(audit.protocolVersion, 2);
assert.equal(audit.runEvents.length, 1);

const attachmentCalls: string[] = [];
const attachmentFetch: typeof fetch = async (input) => {
  const url = String(input);
  attachmentCalls.push(url);
  if (url.endsWith("/build/transcript?after=17")) {
    return Response.json({
      turns: [{
        id: "turn_18",
        sessionId: "architect:run_1",
        actor: { role: "architect", id: "architect" },
        sequence: 18,
        ordinal: 4,
        occurredAt: "2026-07-14T00:00:00.000Z",
        text: "Native model response",
      }],
      cursor: 18,
    });
  }
  if (url.endsWith("/build/files")) {
    return Response.json({
      source: "project",
      revision: "1234567890abcdef1234567890abcdef12345678",
      appliedToProject: true,
      omittedFileCount: 2,
      files: [{ path: "src/index.ts", content: "export {};" }],
    });
  }
  return Response.json({ error: "Unexpected request" }, { status: 500 });
};
const transcript = await getNativeBuildTranscript(
  connection,
  "run_1",
  17,
  attachmentFetch
);
assert.equal(transcript.turns[0].id, "turn_18");
assert.equal(transcript.turns[0].ordinal, 4);
assert.equal(transcript.cursor, 18);
const fileSnapshot = await getNativeBuildFiles(connection, "run_1", attachmentFetch);
assert.equal(fileSnapshot.source, "project");
assert.equal(fileSnapshot.omittedFileCount, 2);
assert.deepEqual(attachmentCalls, [
  "http://127.0.0.1:8787/v2/runs/run_1/build/transcript?after=17",
  "http://127.0.0.1:8787/v2/runs/run_1/build/files",
]);

assert.equal(calls.every((call) => new Headers(call.init.headers).get("authorization") === "Bearer runner-control-token"), true);
assert.equal(calls[0].url, "http://127.0.0.1:8787/v2/health");
assert.equal(JSON.parse(String(calls[1].init.body)).configs[0].secret, "provider-secret");
assert.equal(JSON.parse(String(calls[2].init.body)).build.maxConcurrency, 2);
assert.equal(JSON.parse(String(calls[2].init.body)).build.runPolicy, "budgeted");
assert.deepEqual(JSON.parse(String(calls[2].init.body)).build.budgetLimits, {
  maxEstimatedCostMicros: 1_000_000,
  maxActiveMs: 1_800_000,
});
assert.equal(calls[3].url, "http://127.0.0.1:8787/v2/runs/run_1/build/project-handoff");
assert.equal(JSON.parse(String(calls[3].init.body)).choice, "keep_integration_branch");
assert.equal(calls[4].url, "http://127.0.0.1:8787/v2/runs/run_1/build/usage");
assert.equal(calls[5].url, "http://127.0.0.1:8787/v2/runs/run_1/build/observability");
assert.equal(calls[6].url, "http://127.0.0.1:8787/v2/runs/run_1/build/audit");

const recoveryFetch: typeof fetch = async (input) => {
  const url = String(input);
  if (url.endsWith("/v2/runs/missing/build")) {
    return Response.json({ error: "Unknown build runtime missing." }, { status: 404 });
  }
  if (url.endsWith("/v2/builds?projectId=discussion_1")) {
    return Response.json({
      builds: [
        {
          runId: "run_paused",
          projectId: "discussion_1",
          state: "paused",
          createdAt: "2026-07-12T00:00:00.000Z",
          updatedAt: "2026-07-12T01:00:00.000Z",
        },
        {
          runId: "run_handoff",
          projectId: "discussion_1",
          state: "paused",
          createdAt: "2026-07-12T02:00:00.000Z",
          updatedAt: "2026-07-12T03:00:00.000Z",
        },
      ],
    });
  }
  if (url.endsWith("/v2/runs/run_paused/build")) {
    return Response.json({
      runId: "run_paused",
      status: "paused",
      planRevision: 1,
      tasks: {}, guidance: {}, reviews: {},
      runtime: { providerHealth: {}, workerAssignments: {}, architect: {} },
      lastSequence: 1,
    });
  }
  if (url.endsWith("/v2/runs/run_handoff/build")) {
    return Response.json({
      runId: "run_handoff",
      status: "paused",
      planRevision: 1,
      tasks: {}, guidance: {}, reviews: {},
      runtime: { providerHealth: {}, workerAssignments: {}, architect: {} },
      projectHandoff: {
        status: "requested",
        summary: "Ready",
        options: ["keep_integration_branch", "apply_to_project"],
      },
      lastSequence: 2,
    });
  }
  return Response.json({ error: "Unexpected request" }, { status: 500 });
};
assert.equal(
  await resolveNativeBuildRunId(
    connection,
    "missing",
    "discussion_1",
    recoveryFetch
  ),
  "run_handoff"
);

const missingFollowUpFetch: typeof fetch = async (input) => {
  const url = String(input);
  if (url.endsWith("/v2/runs/new_follow_up/build")) {
    return Response.json(
      { error: "Unknown build runtime new_follow_up." },
      { status: 404 }
    );
  }
  if (url.endsWith("/v2/builds?projectId=discussion_1")) {
    return Response.json({ builds: [] });
  }
  return Response.json({ error: "Unexpected request" }, { status: 500 });
};
assert.equal(
  await resolveNativeBuildRunId(
    connection,
    "new_follow_up",
    "discussion_1",
    missingFollowUpFetch,
    { allowMissing: true }
  ),
  undefined,
  "a deliberately new follow-up may proceed to native provisioning"
);

const freshPassRequestedAt = "2026-07-14T05:00:00.000Z";
const oldPassReferenceFetch: typeof fetch = async (input) => {
  const url = String(input);
  if (url.endsWith("/v2/runs/native-reserved-fresh-pass/build")) {
    return Response.json(
      { error: "Unknown build runtime native-reserved-fresh-pass." },
      { status: 404 }
    );
  }
  if (url.endsWith("/v2/builds?projectId=discussion_fresh_pass")) {
    return Response.json({ builds: [{
      runId: "run_completed_previous_pass",
      projectId: "discussion_fresh_pass",
      state: "completed",
      createdAt: "2026-07-14T04:00:00.000Z",
      updatedAt: "2026-07-14T04:30:00.000Z",
    }] });
  }
  return Response.json({ error: "Unexpected request" }, { status: 500 });
};
assert.equal(
  await resolveNativeBuildRunId(
    connection,
    "native-reserved-fresh-pass",
    "discussion_fresh_pass",
    oldPassReferenceFetch,
    { allowMissing: true, requestedAt: freshPassRequestedAt }
  ),
  undefined,
  "an older completed pass cannot suppress provisioning an intentionally reserved fresh run"
);

const matchingReservedRunFetch: typeof fetch = async (input) => {
  const url = String(input);
  if (url.endsWith("/v2/runs/native-reserved-after-crash/build")) {
    return Response.json({
      runId: "native-reserved-after-crash",
      status: "running",
    });
  }
  if (url.endsWith("/v2/builds?projectId=discussion_matching_reserved")) {
    return Response.json({ builds: [{
      runId: "run_completed_previous_pass",
      projectId: "discussion_matching_reserved",
      state: "completed",
      createdAt: "2026-07-14T04:00:00.000Z",
      updatedAt: "2026-07-14T04:30:00.000Z",
    }] });
  }
  return Response.json({ error: "Unexpected request" }, { status: 500 });
};
assert.equal(
  await resolveNativeBuildRunId(
    connection,
    "native-reserved-after-crash",
    "discussion_matching_reserved",
    matchingReservedRunFetch,
    { allowMissing: true, requestedAt: freshPassRequestedAt }
  ),
  "native-reserved-after-crash",
  "a crash-created matching reserved run reattaches instead of duplicating provisioning"
);

const newerCrashReferenceFetch: typeof fetch = async (input) => {
  const url = String(input);
  if (url.endsWith("/v2/runs/native-reserved-in-other-tab/build")) {
    return Response.json({
      runId: "native-reserved-in-other-tab",
      status: "created",
    });
  }
  if (url.endsWith("/v2/builds?projectId=discussion_newer_crash_reference")) {
    return Response.json({ builds: [
      {
        runId: "run_completed_previous_pass",
        projectId: "discussion_newer_crash_reference",
        state: "completed",
        createdAt: "2026-07-14T04:00:00.000Z",
        updatedAt: "2026-07-14T04:30:00.000Z",
      },
      {
        runId: "run_created_after_request",
        projectId: "discussion_newer_crash_reference",
        state: "running",
        createdAt: "2026-07-14T05:00:00.000Z",
        updatedAt: "2026-07-14T05:01:00.000Z",
      },
    ] });
  }
  return Response.json({ error: "Unexpected request" }, { status: 500 });
};
assert.equal(
  await resolveNativeBuildRunId(
    connection,
    "native-reserved-in-other-tab",
    "discussion_newer_crash_reference",
    newerCrashReferenceFetch,
    { allowMissing: true, requestedAt: freshPassRequestedAt }
  ),
  "run_created_after_request",
  "a newer eligible two-tab reference wins even when the reserved run also exists"
);

const crashedProvisioningFetch: typeof fetch = async (input) => {
  const url = String(input);
  if (url.endsWith("/v2/runs/stale-provisional-id/build")) {
    return Response.json(
      { error: "Unknown build runtime stale-provisional-id." },
      { status: 404 }
    );
  }
  if (url.endsWith("/v2/builds?projectId=discussion_crash_recovery")) {
    return Response.json({ builds: [{
      runId: "run_recovered_after_crash",
      projectId: "discussion_crash_recovery",
      state: "running",
      createdAt: "2026-07-14T04:00:00.000Z",
      updatedAt: "2026-07-14T04:05:00.000Z",
    }] });
  }
  return Response.json({ error: "Unexpected request" }, { status: 500 });
};
assert.equal(
  await resolveNativeBuildRunId(
    connection,
    "stale-provisional-id",
    "discussion_crash_recovery",
    crashedProvisioningFetch,
    { allowMissing: true }
  ),
  "run_recovered_after_crash",
  "a stale provisional id after a browser crash reattaches the authoritative run instead of provisioning a duplicate"
);

const newestReferenceCalls: string[] = [];
const newestReferenceFetch: typeof fetch = async (input) => {
  const url = String(input);
  newestReferenceCalls.push(url);
  if (url.endsWith("/v2/runs/run_saved/build")) {
    return Response.json({ runId: "run_saved", status: "completed" });
  }
  if (url.endsWith("/v2/builds?projectId=discussion_newest")) {
    return Response.json({ builds: [
      {
        runId: "run_saved",
        projectId: "discussion_newest",
        state: "completed",
        createdAt: "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T01:00:00.000Z",
      },
      {
        runId: "run_running",
        projectId: "discussion_newest",
        state: "running",
        createdAt: "2026-07-14T00:00:00.000Z",
        updatedAt: "2026-07-14T01:00:00.000Z",
      },
    ] });
  }
  return Response.json({ error: "Unexpected request" }, { status: 500 });
};
assert.equal(
  await resolveNativeBuildRunId(
    connection,
    "run_saved",
    "discussion_newest",
    newestReferenceFetch
  ),
  "run_running",
  "the newest project reference replaces an older saved completed run"
);
assert.ok(
  newestReferenceCalls.some((url) => url.endsWith("/v2/builds?projectId=discussion_newest")),
  "project references are queried even when the saved run still exists"
);

const emptyReferenceFetch: typeof fetch = async (input) => {
  const url = String(input);
  if (url.endsWith("/v2/runs/run_orphaned_reference/build")) {
    return Response.json({ runId: "run_orphaned_reference", status: "paused" });
  }
  if (url.endsWith("/v2/builds?projectId=discussion_empty")) {
    return Response.json({ builds: [] });
  }
  return Response.json({ error: "Unexpected request" }, { status: 500 });
};
assert.equal(
  await resolveNativeBuildRunId(
    connection,
    "run_orphaned_reference",
    "discussion_empty",
    emptyReferenceFetch
  ),
  "run_orphaned_reference",
  "an existing saved run remains authoritative when the reference list is empty"
);

const tiedReferenceFetch: typeof fetch = async (input) => {
  const url = String(input);
  if (url.endsWith("/v2/runs/run_Z/build")) {
    return Response.json({ runId: "run_Z", status: "completed" });
  }
  if (url.endsWith("/v2/builds?projectId=discussion_tied")) {
    return Response.json({ builds: [
      {
        runId: "run_Z",
        projectId: "discussion_tied",
        state: "completed",
        createdAt: "2026-07-14T00:00:00.000Z",
        updatedAt: "2026-07-14T01:00:00.000Z",
      },
      {
        runId: "run_a",
        projectId: "discussion_tied",
        state: "paused",
        createdAt: "2026-07-14T00:00:00.000Z",
        updatedAt: "2026-07-14T02:00:00.000Z",
      },
    ] });
  }
  return Response.json({ error: "Unexpected request" }, { status: 500 });
};
assert.equal(
  await resolveNativeBuildRunId(
    connection,
    "run_Z",
    "discussion_tied",
    tiedReferenceFetch
  ),
  "run_a",
  "equal creation times resolve to the code-unit lexicographically greatest run id"
);
console.log("PASS runner-v2 client");
