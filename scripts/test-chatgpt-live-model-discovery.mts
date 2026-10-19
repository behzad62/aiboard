import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("missing port"));
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

const backendPort = await freePort();
let observedAuth = "";
let observedAccountId = "";
let observedUrl = "";
const backend = http.createServer((req, res) => {
  observedAuth = String(req.headers.authorization ?? "");
  observedAccountId = String(req.headers["chatgpt-account-id"] ?? "");
  observedUrl = req.url ?? "";
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    models: [
      {
        slug: "gpt-live-a",
        display_name: "GPT Live A",
        description: "Live account model",
        visibility: "list",
        supported_in_api: true,
        input_modalities: ["text", "image"],
        supported_reasoning_levels: [{ effort: "medium", description: "balanced" }],
        context_window: 262144,
        max_output_tokens: 32768,
      },
      { slug: "gpt-hidden", display_name: "Hidden", visibility: "hide", supported_in_api: true },
      {
        slug: "gpt-account-only",
        display_name: "Account Only",
        visibility: "list",
        supported_in_api: false,
        input_modalities: ["text"],
      },
      { slug: "gpt-no-api-flag", visibility: "list" },
      { slug: "", visibility: "list" },
      { slug: "   ", visibility: "list" },
      { display_name: "Missing ID", visibility: "list" },
    ],
  }));
});
await new Promise<void>((resolve) => backend.listen(backendPort, "127.0.0.1", resolve));

const runnerPort = await freePort();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiboard-chatgpt-models-"));
const authFile = path.join(tmp, "auth.json");
fs.writeFileSync(authFile, JSON.stringify({
  chatgpt: {
    type: "oauth",
    flow: "chatgpt-plan",
    issuer: "https://auth.openai.com",
    clientId: "oaiapp_test",
    subject: "account-test",
    scopes: ["chatgpt.tokens.use.direct"],
    refresh: "refresh-token",
    access: "access-token",
    expires: Date.now() + 60 * 60 * 1000,
    accountId: "acct-test",
    updatedAt: new Date().toISOString(),
  },
}));
const token = "runner-secret";
const child = spawn(process.execPath, [
  "lib/account-provider-runner.mjs", "--host", "127.0.0.1", "--port", String(runnerPort),
  "--token", token, "--auth-file", authFile,
], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    AIBOARD_CHATGPT_API_BASE: `http://127.0.0.1:${backendPort}/v1`,
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let childError = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { childError += String(chunk); });
const runnerUrl = `http://127.0.0.1:${runnerPort}`;
try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${runnerUrl}/health`)).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const response = await fetch(`${runnerUrl}/providers/chatgpt/models`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-runner-token": token },
    body: "{}",
  });
  const raw = await response.text();
  assert.equal(response.status, 200, childError || raw);
  const payload = JSON.parse(raw) as { data?: Array<Record<string, unknown>> };
  assert.deepEqual(payload.data?.map(({ id, name, description, capabilities }) => ({ id, name, ...(description ? { description } : {}), capabilities })), [{
    id: "gpt-live-a",
    name: "GPT Live A",
    description: "Live account model",
    capabilities: { supports: { vision: true, reasoningEffort: true } },
  }, {
    id: "gpt-account-only",
    name: "Account Only",
    capabilities: { supports: { vision: false } },
  }, {
    id: "gpt-no-api-flag",
    name: "gpt-no-api-flag",
    capabilities: { supports: {} },
  }], "include account-listed models regardless of API eligibility, while excluding hidden or invalid entries");
  assert.equal(payload.data?.[0].context_window, 262144, "runner must preserve provider limits for the browser");
  assert.equal(payload.data?.[0].max_output_tokens, 32768);
  assert.equal(observedAuth, "Bearer access-token");
  assert.equal(observedAccountId, "", "public API does not use the Codex account header");
  assert.equal(observedUrl, "/v1/models");
  console.log("PASS ChatGPT subscription runner fetches the public API catalog using its own OAuth token without an API key");
} finally {
  child.kill();
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
  });
  await new Promise<void>((resolve) => backend.close(() => resolve()));
  fs.rmSync(tmp, { recursive: true, force: true });
}
