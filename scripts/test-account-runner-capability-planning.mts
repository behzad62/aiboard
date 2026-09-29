import assert from "node:assert/strict";
import http from "node:http";
import {
  clearAccountRunnerCapabilityCache,
  getCachedAccountRunnerCapabilities,
} from "../lib/providers/account-runner";
import { resolveProviderCallPlan } from "../lib/providers/call-planner";
import { runnerCapabilityEvidence } from "../lib/providers/runner-capabilities";
import { getRunnerCapabilityPlanningContext } from "../lib/client/providers";

function descriptor(id: "web_search" | "function_calling", support: "supported" | "unsupported", execution: "provider" | "runner" | "client", transports: Array<"responses" | "chat_completions" | "runner_proxy">) {
  return { id, support, execution, transports, supportSource: "runner" as const };
}

const responses: unknown[] = [
  {
    schemaVersion: 1, runnerVersion: 20, providerId: "chatgpt",
    transports: ["runner_proxy"],
    capabilities: [descriptor("web_search", "supported", "provider", ["runner_proxy"])],
  },
  {
    schemaVersion: 1, runnerVersion: 21, providerId: "chatgpt",
    transports: ["runner_proxy"],
    capabilities: [descriptor("web_search", "unsupported", "provider", ["runner_proxy"])],
  },
  {
    schemaVersion: 2, runnerVersion: 22, providerId: "chatgpt",
    transports: ["runner_proxy"], capabilities: [],
  },
];
let version = 20;
let capabilityIndex = 0;
let capabilityRequests = 0;
const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, version }));
    return;
  }
  capabilityRequests++;
  for await (const _ of req) { /* drain */ }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(responses[capabilityIndex]));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
const baseURL = `http://127.0.0.1:${address.port}`;

try {
  clearAccountRunnerCapabilityCache();
  const first = await getCachedAccountRunnerCapabilities({
    baseURL, runnerToken: "runner-token", providerId: "chatgpt", minimumRunnerVersion: 20,
  });
  const cached = await getCachedAccountRunnerCapabilities({
    baseURL, runnerToken: "runner-token", providerId: "chatgpt", minimumRunnerVersion: 20,
  });
  assert.equal(first.status, "valid");
  assert.equal(cached.status, "valid");
  assert.equal(capabilityRequests, 1, "same runner version should reuse cached handshake");
  console.log("PASS runner handshake cache reuses validated truth for the same runner version");

  version = 21;
  capabilityIndex = 1;
  const changed = await getCachedAccountRunnerCapabilities({
    baseURL, runnerToken: "runner-token", providerId: "chatgpt", minimumRunnerVersion: 20,
  });
  assert.equal(changed.status, "valid");
  assert.equal(capabilityRequests, 2, "runner version change must invalidate cached handshake");
  console.log("PASS runner version change invalidates cached capability truth");

  const enabledPlan = resolveProviderCallPlan({
    context: {
      providerId: "chatgpt", modelId: "gpt-5.6-sol",
      evidence: runnerCapabilityEvidence(first, "gpt-5.6-sol"),
      allowedTransports: first.status === "valid" ? first.handshake.transports : undefined,
      features: { mode: "discussion" },
    },
    requestedTools: [{ id: "web_search", requirement: "optional" }],
  });
  const disabledPlan = resolveProviderCallPlan({
    context: {
      providerId: "chatgpt", modelId: "gpt-5.6-sol",
      evidence: runnerCapabilityEvidence(changed, "gpt-5.6-sol"),
      allowedTransports: changed.status === "valid" ? changed.handshake.transports : undefined,
      features: { mode: "discussion" },
    },
    requestedTools: [{ id: "web_search", requirement: "optional" }],
  });
  assert.deepEqual(enabledPlan.enabledTools.map((tool) => tool.intent.id), ["web_search"]);
  assert.equal(disabledPlan.omittedOptionalTools[0]?.code, "unsupported");
  console.log("PASS same browser build enables or omits ChatGPT tools from current runner truth");

  clearAccountRunnerCapabilityCache();
  version = 20;
  capabilityIndex = 0;
  const browserContext = await getRunnerCapabilityPlanningContext(
    "chatgpt",
    "gpt-5.6-sol",
    undefined,
    { baseURL, runnerToken: "runner-token" },
  );
  assert.deepEqual(browserContext.allowedTransports, ["runner_proxy"]);
  assert.equal(
    browserContext.evidence?.find((item) => item.capabilityId === "web_search")?.support,
    "supported",
  );
  console.log("PASS browser provider registry converts runner handshake into planner context");
  const beforeFutureSchemaRequest = capabilityRequests;
  version = 22;
  capabilityIndex = 2;
  const future = await getCachedAccountRunnerCapabilities({
    baseURL, runnerToken: "runner-token", providerId: "chatgpt", minimumRunnerVersion: 20,
  });
  assert.equal(future.status, "unsupported_schema");
  assert.equal(capabilityRequests, beforeFutureSchemaRequest + 1);
  console.log("PASS future runner schema invalidates old cached truth and fails closed");
} finally {
  clearAccountRunnerCapabilityCache();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const nvidiaResponses = {
  status: "valid" as const,
  handshake: {
    schemaVersion: 1 as const, runnerVersion: 20, providerId: "nvidia" as const,
    transports: ["responses" as const, "runner_proxy" as const],
    capabilities: [descriptor("function_calling", "supported", "client", ["responses", "runner_proxy"])],
  },
};
const nvidiaChat = {
  status: "valid" as const,
  handshake: {
    schemaVersion: 1 as const, runnerVersion: 20, providerId: "nvidia" as const,
    transports: ["chat_completions" as const, "runner_proxy" as const],
    capabilities: [descriptor("function_calling", "supported", "client", ["chat_completions", "runner_proxy"])],
  },
};
function nvidiaPlan(result: typeof nvidiaResponses | typeof nvidiaChat) {
  return resolveProviderCallPlan({
    context: {
      providerId: "nvidia", modelId: "deployment/model",
      evidence: runnerCapabilityEvidence(result, "deployment/model"),
      allowedTransports: result.handshake.transports,
      features: { mode: "discussion" },
    },
    requestedTools: [{ id: "function_calling", requirement: "required" }],
  });
}
assert.equal(nvidiaPlan(nvidiaResponses).transport, "responses");
assert.equal(nvidiaPlan(nvidiaChat).transport, "chat_completions");
console.log("PASS NVIDIA transport selection is narrowed by current runner handshake");

console.log("PASS");
