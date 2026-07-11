import assert from "node:assert/strict";

import {
  configureNativeProviders,
  createNativeBuild,
  getNativeRunnerHealth,
  type NativeRunnerConnection,
} from "../lib/client/runner-v2";
import { selectNativeBuildRuntimes } from "../lib/client/native-build-engine";

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

assert.equal(calls.every((call) => new Headers(call.init.headers).get("authorization") === "Bearer runner-control-token"), true);
assert.equal(calls[0].url, "http://127.0.0.1:8787/v2/health");
assert.equal(JSON.parse(String(calls[1].init.body)).configs[0].secret, "provider-secret");
assert.equal(JSON.parse(String(calls[2].init.body)).build.maxConcurrency, 2);
console.log("PASS runner-v2 client");
