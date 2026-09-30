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
      },
      { slug: "gpt-hidden", display_name: "Hidden", visibility: "hide", supported_in_api: true },
      { slug: "gpt-not-api", display_name: "Not API", visibility: "list", supported_in_api: false },
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
    AIBOARD_CHATGPT_CODEX_MODELS_ENDPOINT: `http://127.0.0.1:${backendPort}/backend-api/codex/models`,
    AIBOARD_CHATGPT_MODEL_CLIENT_VERSION: "0.153.4-test",
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
  assert.deepEqual(payload.data, [{
    id: "gpt-live-a",
    name: "GPT Live A",
    description: "Live account model",
    capabilities: { supports: { vision: true, reasoningEffort: true } },
  }]);
  assert.equal(observedAuth, "Bearer access-token");
  assert.equal(observedAccountId, "acct-test");
  assert.match(observedUrl, /client_version=0\.153\.4-test/);
  console.log("PASS ChatGPT subscription runner fetches the live authenticated Codex model catalog");
} finally {
  child.kill();
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
  });
  await new Promise<void>((resolve) => backend.close(() => resolve()));
  fs.rmSync(tmp, { recursive: true, force: true });
}
