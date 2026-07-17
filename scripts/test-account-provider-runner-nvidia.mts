/* Account-provider runner NVIDIA proxy regression (run: npx tsx scripts/test-account-provider-runner-nvidia.mts) */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { NativeToolDefinition } from "../lib/providers/base";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

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

function sseData(payload: unknown): string {
  return `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`;
}

function parseNormalizedSse(text: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    events.push(JSON.parse(data) as Record<string, unknown>);
  }
  return events;
}

const nativeTools: NativeToolDefinition[] = [
  {
    name: "echo_tool",
    description: "Echo a short message.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["message"],
      properties: { message: { type: "string" } },
    },
    strict: false,
  },
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiboard-nvidia-runner-"));
const token = "test-runner-token";
const runnerPort = await getFreePort();
const fakeBackendPort = await getFreePort();
const authFile = path.join(tmp, "auth.json");
let capturedPath = "";
let capturedHeaders: http.IncomingHttpHeaders | undefined;
let capturedBody: Record<string, unknown> | undefined;
const capturedRequests: Array<{
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}> = [];

fs.writeFileSync(authFile, "{}");

const fakeBackend = http.createServer(async (req, res) => {
  capturedPath = req.url ?? "";
  capturedHeaders = req.headers;
  const raw = await readRequestBody(req);
  capturedBody = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  capturedRequests.push({
    path: capturedPath,
    headers: capturedHeaders,
    body: capturedBody,
  });
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  res.write(sseData({ choices: [{ delta: { content: "hello " } }] }));
  res.write(
    sseData({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_nvidia",
                type: "function",
                function: {
                  name: "echo_tool",
                  arguments: "{\"message\":\"",
                },
              },
            ],
          },
        },
      ],
    })
  );
  res.write(
    sseData({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                function: {
                  arguments: "from-nvidia\"}",
                },
              },
            ],
          },
        },
      ],
    })
  );
  res.write(
    sseData({
      usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
      choices: [],
    })
  );
  res.write(sseData("[DONE]"));
  res.end();
});

await new Promise<void>((resolve) =>
  fakeBackend.listen(fakeBackendPort, "127.0.0.1", resolve)
);

const runner = spawn(
  process.execPath,
  [
    "lib/account-provider-runner.mjs",
    "--host",
    "127.0.0.1",
    "--port",
    String(runnerPort),
    "--token",
    token,
    "--auth-file",
    authFile,
    "--nvidia-api-base",
    `http://127.0.0.1:${fakeBackendPort}/v1`,
  ],
  {
    cwd: process.cwd(),
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

async function waitForRunner(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
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
    spawnSync("taskkill", ["/pid", String(runner.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    runner.kill("SIGINT");
  }
  await Promise.race([
    new Promise<void>((resolve) => runner.once("close", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
  ]);
}

try {
  await waitForRunner();

  const response = await fetch(`${baseUrl}/providers/nvidia/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-runner-token": token,
    },
    body: JSON.stringify({
      apiKey: "fake-nvidia-api-key",
      model: "z-ai/glm-5.2",
      maxTokens: 1234,
      temperature: 0.2,
      messages: [
        { role: "system", content: "You are validating NVIDIA NIM." },
        { role: "user", content: "Call echo_tool." },
      ],
      structuredOutput: {
        name: "nvidia_test",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["ok"],
          properties: { ok: { type: "boolean" } },
        },
      },
      nativeTools,
      attachments: [],
      stream: true,
    }),
  });
  const text = await response.text();
  const events = parseNormalizedSse(text);
  const tools = capturedBody?.tools as Array<Record<string, unknown>> | undefined;
  const responseFormat = capturedBody?.response_format as
    | { type?: string; json_schema?: { name?: string; strict?: boolean; schema?: unknown } }
    | undefined;

  check(
    "NVIDIA runner chat route streams normalized SSE",
    response.ok && response.headers.get("content-type")?.includes("text/event-stream") === true,
    { status: response.status, body: text, headers: Object.fromEntries(response.headers) }
  );
  check(
    "NVIDIA runner calls the OpenAI-compatible chat completions endpoint",
    capturedPath === "/v1/chat/completions",
    { capturedPath, capturedBody }
  );
  check(
    "NVIDIA runner forwards provider API key only to upstream Authorization",
    capturedHeaders?.authorization === "Bearer fake-nvidia-api-key" &&
      !Object.prototype.hasOwnProperty.call(capturedBody ?? {}, "apiKey"),
    { capturedHeaders, capturedBody }
  );
  check(
    "NVIDIA runner forwards model, max tokens, temperature, stream, schema, and tools",
    capturedBody?.model === "z-ai/glm-5.2" &&
      capturedBody.max_tokens === 1234 &&
      capturedBody.temperature === 0.2 &&
      capturedBody.stream === true &&
      responseFormat?.type === "json_schema" &&
      responseFormat.json_schema?.name === "nvidia_test" &&
      Array.isArray(tools) &&
      tools.some((tool) => {
        const fn = tool.function as { name?: string } | undefined;
        return tool.type === "function" && fn?.name === "echo_tool";
      }),
    capturedBody
  );
  check(
    "NVIDIA runner response_format follows the OpenAI chat-completions spec (schema/strict under json_schema, no inner type)",
    responseFormat?.json_schema?.strict === true &&
      JSON.stringify(responseFormat.json_schema.schema) ===
        JSON.stringify({
          type: "object",
          additionalProperties: false,
          required: ["ok"],
          properties: { ok: { type: "boolean" } },
        }) &&
      !Object.prototype.hasOwnProperty.call(responseFormat.json_schema, "type"),
    responseFormat
  );
  check(
    "NVIDIA runner emits token, tool-call, usage, and done events",
    events.some((event) => event.type === "token" && event.content === "hello ") &&
      events.some((event) => {
        const toolCall = event.toolCall as { name?: string; argumentsJson?: string } | undefined;
        return (
          event.type === "tool_call" &&
          toolCall?.name === "echo_tool" &&
          toolCall.argumentsJson === "{\"message\":\"from-nvidia\"}"
        );
      }) &&
      events.some((event) => {
        const usage = event.usage as { inputTokens?: number; outputTokens?: number } | undefined;
        return event.type === "usage" && usage?.inputTokens === 11 && usage.outputTokens === 3;
      }) &&
      events.at(-1)?.type === "done",
    events
  );

  const nemotronResponse = await fetch(`${baseUrl}/providers/nvidia/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-runner-token": token,
    },
    body: JSON.stringify({
      apiKey: "fake-nvidia-api-key",
      model: "nvidia/nemotron-3-ultra-550b-a55b",
      maxTokens: 1234,
      temperature: 0.2,
      messages: [{ role: "user", content: "Use echo_tool." }],
      structuredOutput: {
        name: "nvidia_test",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["ok"],
          properties: { ok: { type: "boolean" } },
        },
      },
      nativeTools,
      attachments: [],
      stream: true,
    }),
  });
  await nemotronResponse.text();
  const nemotronBody = capturedRequests.at(-1)?.body;
  const chatTemplateKwargs = nemotronBody?.chat_template_kwargs as
    | { enable_thinking?: boolean; force_nonempty_content?: boolean }
    | undefined;
  check(
    "NVIDIA runner adds Nemotron chat-template kwargs for structured tool parsing",
    nemotronResponse.ok &&
      chatTemplateKwargs?.enable_thinking === true &&
      chatTemplateKwargs.force_nonempty_content === true,
    nemotronBody
  );
} catch (err) {
  check(
    "account-provider runner NVIDIA proxy integration",
    false,
    err instanceof Error ? err.message : String(err)
  );
} finally {
  await stopRunner();
  await new Promise<void>((resolve) => fakeBackend.close(() => resolve()));
  fs.rmSync(tmp, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
