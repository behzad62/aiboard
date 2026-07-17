/**
 * Account-provider runner GitHub Copilot structured-output contract
 * (run: npx tsx scripts/test-account-provider-runner-copilot-structured.mts)
 *
 * Guards two things the certified GameIQ benchmark depends on:
 *  1. Request shape — chat-completions gets the OpenAI spec nesting
 *     response_format: { type: "json_schema", json_schema: { name, schema, strict } }
 *     (NO inner "type" — the pre-v16 runner leaked the Responses-API shape in
 *     as json_schema, which Copilot silently ignored); the /responses path
 *     keeps the flat text.format = { type, name, schema, strict } shape.
 *  2. Response normalization — when structuredOutput was requested and the
 *     upstream model still wraps the whole reply in a markdown code fence
 *     (observed live: Copilot-served gemini models), the runner strips the
 *     fence so strict JSON.parse consumers (certified scorer) don't score the
 *     response as failed_tool_use. Responses WITHOUT structuredOutput are
 *     never touched.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("failed to allocate port"));
      });
    });
  });
}

async function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

interface CapturedRequest {
  url: string | undefined;
  body: Record<string, unknown>;
}

const structuredOutput = {
  name: "copilot_structured_test",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["answer"],
    properties: { answer: { type: "number" } },
  },
};

const FENCED_JSON = '```json\n{"answer":42}\n```';
const BARE_FENCED_JSON = '```\n{"answer":7}\n```';
const CLEAN_JSON = '{"answer":1}';

/** The fake backend picks its reply from a marker in the last user message. */
function backendReplyFor(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const input = Array.isArray(body.input) ? body.input : [];
  const text = JSON.stringify([...messages, ...input]);
  if (text.includes("REPLY_BARE_FENCE")) return BARE_FENCED_JSON;
  if (text.includes("REPLY_CLEAN")) return CLEAN_JSON;
  return FENCED_JSON;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiboard-copilot-structured-"));
const token = "test-token";
const runnerPort = await getFreePort();
const fakeBackendPort = await getFreePort();
const authFile = path.join(tmp, "auth.json");
const capturedRequests: CapturedRequest[] = [];

fs.writeFileSync(
  authFile,
  JSON.stringify({
    githubCopilot: {
      type: "oauth",
      access: "fake-copilot-token",
      refresh: "fake-copilot-token",
      expires: 0,
      updatedAt: new Date().toISOString(),
    },
  })
);

const fakeBackend = http.createServer(async (req, res) => {
  const raw = await readRequestBody(req);
  const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  capturedRequests.push({ url: req.url, body });
  const reply = backendReplyFor(body);
  res.writeHead(200, { "content-type": "application/json" });
  if (String(req.url).includes("responses")) {
    res.end(JSON.stringify({ output: [{ content: [{ type: "output_text", text: reply }] }] }));
  } else {
    res.end(JSON.stringify({ choices: [{ message: { content: reply }, finish_reason: "stop" }] }));
  }
});

await new Promise<void>((resolve) => fakeBackend.listen(fakeBackendPort, "127.0.0.1", resolve));

const runner = spawn(
  process.execPath,
  ["lib/account-provider-runner.mjs", "--port", String(runnerPort), "--token", token, "--auth-file", authFile],
  {
    cwd: process.cwd(),
    env: { ...process.env, AIBOARD_GITHUB_COPILOT_API_BASE: `http://127.0.0.1:${fakeBackendPort}` },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }
);

let runnerOutput = "";
runner.stdout.setEncoding("utf8");
runner.stderr.setEncoding("utf8");
runner.stdout.on("data", (chunk) => {
  runnerOutput += chunk;
});
runner.stderr.on("data", (chunk) => {
  runnerOutput += chunk;
});

const baseUrl = `http://127.0.0.1:${runnerPort}`;
const headers = { "content-type": "application/json", "x-runner-token": token };

async function waitForRunner(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`account-provider runner did not become ready: ${runnerOutput}`);
}

async function stopRunner(): Promise<void> {
  if (runner.exitCode !== null) return;
  if (process.platform === "win32" && runner.pid) {
    spawnSync("taskkill", ["/pid", String(runner.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
  } else {
    runner.kill("SIGINT");
  }
  await Promise.race([
    new Promise<void>((resolve) => runner.once("close", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
  ]);
}

async function copilotChat(body: Record<string, unknown>): Promise<{ status: number; data: { content?: string; error?: string } }> {
  const response = await fetch(`${baseUrl}/providers/github-copilot/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as { content?: string; error?: string } };
}

try {
  await waitForRunner();

  const health = (await (await fetch(`${baseUrl}/health`)).json()) as { version?: number };
  check("runner health reports v16+ (structured-output contract)", (health.version ?? 0) >= 16, health);

  // ── 1. chat-completions request shape (non-GPT-5 model) ──────────────────
  const chatResult = await copilotChat({
    runtimeMode: "discussion",
    stream: true,
    model: "gemini-3.5-flash",
    messages: [{ role: "user", content: "Answer with the structured JSON." }],
    structuredOutput,
  });
  const chatCaptured = capturedRequests.at(-1);
  const chatFormat = chatCaptured?.body.response_format as
    | { type?: string; json_schema?: Record<string, unknown> }
    | undefined;

  check("structured chat request routes to chat/completions", String(chatCaptured?.url).includes("chat/completions"), chatCaptured);
  check("chat response_format top-level type is json_schema", chatFormat?.type === "json_schema", chatFormat);
  check(
    "chat response_format nests name/schema/strict under json_schema",
    chatFormat?.json_schema?.name === "copilot_structured_test" &&
      chatFormat.json_schema.strict === true &&
      JSON.stringify(chatFormat.json_schema.schema) === JSON.stringify(structuredOutput.schema),
    chatFormat
  );
  check(
    "chat response_format json_schema carries NO inner type field",
    !!chatFormat?.json_schema && !Object.prototype.hasOwnProperty.call(chatFormat.json_schema, "type"),
    chatFormat
  );
  check(
    "chat response_format has exactly the spec keys",
    !!chatFormat && Object.keys(chatFormat).sort().join(",") === "json_schema,type",
    chatFormat
  );

  // ── 2. fence stripping on the chat-completions response ──────────────────
  check("fenced ```json reply is stripped to bare JSON", chatResult.data.content === '{"answer":42}', chatResult);

  const bareFenceResult = await copilotChat({
    runtimeMode: "discussion",
    stream: true,
    model: "gemini-3.5-flash",
    messages: [{ role: "user", content: "REPLY_BARE_FENCE" }],
    structuredOutput,
  });
  check("bare ``` fenced reply is stripped to bare JSON", bareFenceResult.data.content === '{"answer":7}', bareFenceResult);

  const cleanResult = await copilotChat({
    runtimeMode: "discussion",
    stream: true,
    model: "gemini-3.5-flash",
    messages: [{ role: "user", content: "REPLY_CLEAN" }],
    structuredOutput,
  });
  check("clean JSON reply passes through unchanged", cleanResult.data.content === CLEAN_JSON, cleanResult);

  // ── 3. no structuredOutput -> no stripping (fences are legitimate prose) ──
  const unstructuredResult = await copilotChat({
    runtimeMode: "build",
    model: "gemini-3.5-flash",
    messages: [{ role: "user", content: "Show me a fenced code block." }],
  });
  const unstructuredCaptured = capturedRequests.at(-1);
  check(
    "request without structuredOutput sends no response_format",
    !Object.prototype.hasOwnProperty.call(unstructuredCaptured?.body ?? {}, "response_format"),
    unstructuredCaptured
  );
  check("fenced reply without structuredOutput is NOT stripped", unstructuredResult.data.content === FENCED_JSON, unstructuredResult);

  // ── 4. /responses path (GPT-5-class model) keeps flat text.format ────────
  const responsesResult = await copilotChat({
    runtimeMode: "discussion",
    stream: true,
    model: "gpt-5.4",
    messages: [{ role: "user", content: "Answer with the structured JSON." }],
    structuredOutput,
  });
  const responsesCaptured = capturedRequests.at(-1);
  const textFormat = (responsesCaptured?.body.text as { format?: Record<string, unknown> } | undefined)?.format;

  check("structured GPT-5 request routes to /responses", String(responsesCaptured?.url).includes("responses"), responsesCaptured);
  check(
    "responses text.format keeps the flat Responses-API shape",
    textFormat?.type === "json_schema" &&
      textFormat.name === "copilot_structured_test" &&
      textFormat.strict === true &&
      JSON.stringify(textFormat.schema) === JSON.stringify(structuredOutput.schema) &&
      !Object.prototype.hasOwnProperty.call(textFormat, "json_schema"),
    textFormat
  );
  check("responses-path fenced reply is stripped to bare JSON", responsesResult.data.content === '{"answer":42}', responsesResult);
} catch (err) {
  check("account-provider runner Copilot structured-output contract", false, err instanceof Error ? err.message : String(err));
} finally {
  await stopRunner();
  await new Promise<void>((resolve) => fakeBackend.close(() => resolve()));
  fs.rmSync(tmp, { recursive: true, force: true });
}

process.exit(failed === 0 ? 0 : 1);
