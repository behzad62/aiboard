import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  RUNNER_CAPABILITY_SCHEMA_VERSION,
  fetchRunnerCapabilityHandshake,
  runnerCapabilityEvidence,
  validateRunnerCapabilityHandshake,
} from "../lib/providers/runner-capabilities";

function pass(name: string) { console.log(`PASS ${name}`); }
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => address && typeof address === "object" ? resolve(address.port) : reject(new Error("no port")));
    });
  });
}

const chatgptPayload = {
  schemaVersion: 1,
  runnerVersion: 20,
  providerId: "chatgpt",
  transports: ["runner_proxy"],
  capabilities: [
    { id: "function_calling", support: "supported", execution: "runner", transports: ["runner_proxy"], supportSource: "runner" },
    { id: "web_search", support: "supported", execution: "provider", transports: ["runner_proxy"], supportSource: "runner" },
  ],
  execution: [{ id: "streaming", available: true, transports: ["runner_proxy"] }],
};
assert.equal(RUNNER_CAPABILITY_SCHEMA_VERSION, 1);
assert.equal(validateRunnerCapabilityHandshake(chatgptPayload).status, "valid");
assert.equal(validateRunnerCapabilityHandshake({ ...chatgptPayload, schemaVersion: 2 }).status, "unsupported_schema");
assert.equal(validateRunnerCapabilityHandshake(chatgptPayload, { minimumRunnerVersion: 21 }).status, "stale_runner");
pass("browser validation accepts schema v1 and fails closed for future/stale runners");

const nvidiaPayload = {
  schemaVersion: 1,
  runnerVersion: 20,
  providerId: "nvidia",
  transports: ["chat_completions", "runner_proxy"],
  capabilities: [
    { id: "function_calling", support: "conditional", execution: "client", transports: ["chat_completions", "runner_proxy"], supportSource: "runner" },
  ],
  models: [
    { modelId: "z-ai/glm-5.2", capabilities: [
      { id: "function_calling", support: "supported", execution: "client", transports: ["chat_completions", "runner_proxy"], supportSource: "runner" },
    ] },
  ],
};
const knownEvidence = runnerCapabilityEvidence(validateRunnerCapabilityHandshake(nvidiaPayload), "z-ai/glm-5.2");
const unknownEvidence = runnerCapabilityEvidence(validateRunnerCapabilityHandshake(nvidiaPayload), "unknown/model");
assert.equal(knownEvidence.find((item) => item.capabilityId === "function_calling")?.support, "supported");
assert.equal(unknownEvidence.find((item) => item.capabilityId === "function_calling")?.support, "conditional");
pass("model-specific runner evidence narrows conditional provider support");

let receivedToken = "";
let receivedBody: Record<string, unknown> | undefined;
const fakeServer = http.createServer(async (req, res) => {
  receivedToken = String(req.headers["x-runner-token"] ?? "");
  let raw = "";
  for await (const chunk of req) raw += String(chunk);
  receivedBody = raw ? JSON.parse(raw) as Record<string, unknown> : {};
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(nvidiaPayload));
});
await new Promise<void>((resolve) => fakeServer.listen(0, "127.0.0.1", resolve));
const fakeAddress = fakeServer.address();
assert.ok(fakeAddress && typeof fakeAddress === "object");
const fetched = await fetchRunnerCapabilityHandshake({
  baseURL: `http://127.0.0.1:${fakeAddress.port}`,
  runnerToken: "runner-secret",
  providerId: "nvidia",
  apiKey: "nvapi-test",
});
assert.equal(fetched.status, "valid");
assert.equal(receivedToken, "runner-secret");
assert.equal(receivedBody?.apiKey, "nvapi-test");
await new Promise<void>((resolve) => fakeServer.close(() => resolve()));
pass("browser fetch sends runner auth and provider probe credentials only to the local runner");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiboard-runner-capabilities-"));
const runnerPort = await freePort();
const token = "test-runner-token";
const authFile = path.join(tmp, "auth.json");
fs.writeFileSync(authFile, "{}");
const child = spawn(process.execPath, [
  "lib/account-provider-runner.mjs", "--host", "127.0.0.1", "--port", String(runnerPort),
  "--token", token, "--auth-file", authFile,
], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let childError = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { childError += String(chunk); });
const runnerUrl = `http://127.0.0.1:${runnerPort}`;
try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${runnerUrl}/health`)).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  for (const providerId of ["chatgpt", "github-copilot", "nvidia"] as const) {
    const response = await fetch(`${runnerUrl}/providers/${providerId}/capabilities`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-runner-token": token },
      body: "{}",
    });
    assert.equal(response.status, 200, childError);
    const parsed = validateRunnerCapabilityHandshake(await response.json());
    assert.equal(parsed.status, "valid");
    if (parsed.status === "valid") assert.equal(parsed.handshake.providerId, providerId);
  }
  pass("standalone runner exposes validated ChatGPT, Copilot, and NVIDIA capability handshakes");
} finally {
  child.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("PASS");
