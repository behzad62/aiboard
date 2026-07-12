import assert from "node:assert/strict";

import {
  configureNativeProviders,
  createNativeBuild,
  getNativeBuildUsage,
  getNativeBuildObservability,
  getNativeRunnerHealth,
  selectNativeProjectHandoff,
  type NativeRunnerConnection,
} from "../lib/client/runner-v2";
import {
  resolveNativeProviderTransport,
  nativeProviderProtocol,
  selectNativeBuildRuntimes,
} from "../lib/client/native-build-engine";

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
    budgetLimits: { maxModelCalls: 50, maxToolCalls: 500 },
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

assert.equal(calls.every((call) => new Headers(call.init.headers).get("authorization") === "Bearer runner-control-token"), true);
assert.equal(calls[0].url, "http://127.0.0.1:8787/v2/health");
assert.equal(JSON.parse(String(calls[1].init.body)).configs[0].secret, "provider-secret");
assert.equal(JSON.parse(String(calls[2].init.body)).build.maxConcurrency, 2);
assert.equal(calls[3].url, "http://127.0.0.1:8787/v2/runs/run_1/build/project-handoff");
assert.equal(JSON.parse(String(calls[3].init.body)).choice, "keep_integration_branch");
assert.equal(calls[4].url, "http://127.0.0.1:8787/v2/runs/run_1/build/usage");
assert.equal(calls[5].url, "http://127.0.0.1:8787/v2/runs/run_1/build/observability");
console.log("PASS runner-v2 client");
