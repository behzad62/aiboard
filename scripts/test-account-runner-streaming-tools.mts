/* Account-provider runner streaming/tool forwarding (run: npx tsx scripts/test-account-runner-streaming-tools.mts) */
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { createAccountRunnerProvider } from "../lib/providers/account-runner";
import type { ChatParams, NativeToolDefinition, StreamChunk } from "../lib/providers/base";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const nativeTools: NativeToolDefinition[] = [
  {
    name: "echo_tool",
    description: "Echo a message.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["message"],
      properties: { message: { type: "string" } },
    },
    strict: false,
  },
];

function sseEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  await once(req, "end");
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

async function withServer(
  handler: http.RequestListener
): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}` };
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

async function collectProviderChunks(params: ChatParams): Promise<{
  chunks: StreamChunk[];
  requestBody?: Record<string, unknown>;
}> {
  let requestBody: Record<string, unknown> | undefined;
  const { server, url } = await withServer(async (req, res) => {
    requestBody = await readJsonBody(req);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    res.write(sseEvent({ type: "token", content: "hello " }));
    res.write(
      sseEvent({
        type: "tool_call",
        toolCall: {
          id: "call_1",
          name: "echo_tool",
          argumentsJson: "{\"message\":\"from-provider\"}",
        },
      })
    );
    res.write(sseEvent({ type: "done" }));
    res.end();
  });

  try {
    const provider = createAccountRunnerProvider({
      id: "chatgpt",
      name: "ChatGPT Plus/Pro",
      runnerPath: "chatgpt",
      models: [],
    });
    const chunks: StreamChunk[] = [];
    for await (const chunk of provider.streamChat({
      ...params,
      baseURL: url,
    })) {
      chunks.push(chunk);
    }
    return { chunks, requestBody };
  } finally {
    server.close();
    await once(server, "close");
  }
}

async function testBrowserProviderStreaming(): Promise<void> {
  const { chunks, requestBody } = await collectProviderChunks({
    apiKey: "runner-token",
    model: "gpt-5.4-mini",
    messages: [{ role: "user", content: "Use the tool." }],
    nativeTools,
    hostedBuildTools: true,
    webSearch: true,
    attachments: [],
  });
  check(
    "account provider forwards native tools without deprecated hosted shell flag",
    Array.isArray(requestBody?.nativeTools) &&
      requestBody?.hostedBuildTools === undefined &&
      requestBody?.webSearch === true &&
      requestBody?.stream === true,
    requestBody
  );
  check(
    "account provider yields streaming token chunks",
    chunks.some((chunk) => chunk.type === "token" && chunk.content === "hello "),
    chunks
  );
  check(
    "account provider yields streaming native tool-call chunks",
    chunks.some(
      (chunk) =>
        chunk.type === "tool_call" &&
        chunk.toolCall?.name === "echo_tool" &&
        chunk.toolCall.argumentsJson === "{\"message\":\"from-provider\"}"
    ),
    chunks
  );
}

async function waitForRunnerReady(
  child: ChildProcessWithoutNullStreams,
  url: string,
  token: string
): Promise<void> {
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  for (let i = 0; i < 80; i++) {
    if (child.exitCode != null) {
      throw new Error(`runner exited early: ${stderr}`);
    }
    try {
      const response = await fetch(`${url}/health`, {
        headers: { "x-runner-token": token },
      });
      if (response.ok) return;
    } catch {
      // still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`runner did not become ready: ${stderr}`);
}

async function testLocalRunnerForwardsNativeTools(): Promise<void> {
  let upstreamBody: Record<string, unknown> | undefined;
  const { server: upstream, url: upstreamUrl } = await withServer(async (req, res) => {
    upstreamBody = await readJsonBody(req);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    res.write(sseEvent({ type: "response.output_text.delta", delta: "hi " }));
    res.write(
      sseEvent({
        type: "response.output_item.added",
        item: {
          type: "function_call",
          call_id: "call_runner",
          name: "echo_tool",
        },
      })
    );
    res.write(
      sseEvent({
        type: "response.function_call_arguments.delta",
        item_id: "call_runner",
        delta: "{\"message\":\"",
      })
    );
    res.write(
      sseEvent({
        type: "response.function_call_arguments.done",
        item_id: "call_runner",
        arguments: "{\"message\":\"from-runner\"}",
      })
    );
    res.write(
      sseEvent({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          call_id: "call_runner",
          name: "echo_tool",
          arguments: "{\"message\":\"from-runner\"}",
        },
      })
    );
    res.write(sseEvent({ type: "response.completed" }));
    res.end();
  });

  const tmp = await mkdtemp(path.join(os.tmpdir(), "aiboard-account-runner-test-"));
  const authFile = path.join(tmp, "auth.json");
  const token = "test-token";
  const runnerPort = 18000 + Math.floor(Math.random() * 10000);
  const runnerUrl = `http://127.0.0.1:${runnerPort}`;
  let child: ChildProcessWithoutNullStreams | null = null;

  try {
    await writeFile(
      authFile,
      JSON.stringify({
        chatgpt: {
          type: "oauth",
          refresh: "unused",
          access: "fake-access",
          expires: Date.now() + 3_600_000,
          accountId: "acct-test",
          updatedAt: new Date().toISOString(),
        },
      })
    );
    child = spawn(
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
        "--chatgpt-codex-endpoint",
        upstreamUrl,
      ],
      { cwd: process.cwd() }
    );
    await waitForRunnerReady(child, runnerUrl, token);

    const response = await fetch(`${runnerUrl}/providers/chatgpt/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-runner-token": token,
      },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        messages: [{ role: "user", content: "Call echo_tool." }],
        nativeTools,
        hostedBuildTools: true,
        webSearch: true,
        attachments: [],
        stream: true,
      }),
    });
    const text = await response.text();
    const events = parseNormalizedSse(text);
    const upstreamTools = upstreamBody?.tools as unknown[] | undefined;

    check(
      "local account runner omits unsupported local_shell while forwarding tools upstream",
      response.headers.get("content-type")?.includes("text/event-stream") === true &&
        Array.isArray(upstreamTools) &&
        upstreamTools.some(
          (tool) =>
            typeof tool === "object" &&
            tool !== null &&
            (tool as { name?: string }).name === "echo_tool"
        ) &&
        upstreamTools.some(
          (tool) =>
            typeof tool === "object" &&
            tool !== null &&
            (tool as { type?: string }).type === "web_search"
        ) &&
        !upstreamTools.some(
          (tool) =>
            typeof tool === "object" &&
            tool !== null &&
            ((tool as { type?: string }).type === "local_shell" ||
              (tool as { type?: string }).type === "web_search_preview")
        ) &&
        upstreamBody?.tool_choice === "auto" &&
        upstreamBody?.parallel_tool_calls === true,
      { upstreamBody, contentType: response.headers.get("content-type") }
    );
    check(
      "local account runner streams normalized token events",
      events.some((event) => event.type === "token" && event.content === "hi "),
      events
    );
    check(
      "local account runner streams normalized native tool-call events",
      events.some((event) => {
        const toolCall = event.toolCall as { name?: string; argumentsJson?: string } | undefined;
        return (
          event.type === "tool_call" &&
          toolCall?.name === "echo_tool" &&
          toolCall.argumentsJson === "{\"message\":\"from-runner\"}"
        );
      }),
      events
    );
  } finally {
    child?.kill();
    upstream.close();
    await Promise.allSettled([
      once(upstream, "close"),
      child ? once(child, "exit") : Promise.resolve(),
    ]);
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testLocalRunnerStreamsCompletedOutputText(): Promise<void> {
  let upstreamBody: Record<string, unknown> | undefined;
  const completedJson = "{\"action\":{\"action\":\"play\",\"cardIndex\":0}}";
  const { server: upstream, url: upstreamUrl } = await withServer(async (req, res) => {
    upstreamBody = await readJsonBody(req);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    res.write(
      sseEvent({
        type: "response.output_text.done",
        text: completedJson,
      })
    );
    res.write(sseEvent({ type: "response.completed" }));
    res.end();
  });

  const tmp = await mkdtemp(path.join(os.tmpdir(), "aiboard-account-runner-test-"));
  const authFile = path.join(tmp, "auth.json");
  const token = "test-token";
  const runnerPort = 18000 + Math.floor(Math.random() * 10000);
  const runnerUrl = `http://127.0.0.1:${runnerPort}`;
  let child: ChildProcessWithoutNullStreams | null = null;

  try {
    await writeFile(
      authFile,
      JSON.stringify({
        chatgpt: {
          type: "oauth",
          refresh: "unused",
          access: "fake-access",
          expires: Date.now() + 3_600_000,
          accountId: "acct-test",
          updatedAt: new Date().toISOString(),
        },
      })
    );
    child = spawn(
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
        "--chatgpt-codex-endpoint",
        upstreamUrl,
      ],
      { cwd: process.cwd() }
    );
    await waitForRunnerReady(child, runnerUrl, token);

    const response = await fetch(`${runnerUrl}/providers/chatgpt/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-runner-token": token,
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "Return a Fireworks action." }],
        structuredOutput: {
          name: "gameiq_action",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["action"],
            properties: {
              action: {
                type: "object",
                additionalProperties: false,
                required: ["action", "cardIndex"],
                properties: {
                  action: { type: "string", enum: ["play"] },
                  cardIndex: { type: "integer" },
                },
              },
            },
          },
        },
        attachments: [],
        stream: true,
      }),
    });
    const text = await response.text();
    const events = parseNormalizedSse(text);
    const requestFormat = (upstreamBody?.text as { format?: unknown } | undefined)
      ?.format as { name?: string } | undefined;

    check(
      "local account runner forwards structured output format upstream",
      requestFormat?.name === "gameiq_action",
      upstreamBody
    );
    check(
      "local account runner streams completed output text as token content",
      events.some((event) => event.type === "token" && event.content === completedJson),
      events
    );
  } finally {
    child?.kill();
    upstream.close();
    await Promise.allSettled([
      once(upstream, "close"),
      child ? once(child, "exit") : Promise.resolve(),
    ]);
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testLocalRunnerStreamsMessageOutputItemText(): Promise<void> {
  const completedText = "Final answer from message item.";
  const { server: upstream, url: upstreamUrl } = await withServer(async (req, res) => {
    await readJsonBody(req);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    res.write(
      sseEvent({
        type: "response.output_item.done",
        item: {
          id: "msg_1",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: completedText,
              annotations: [],
            },
          ],
        },
      })
    );
    res.write(sseEvent({ type: "response.completed" }));
    res.end();
  });

  const tmp = await mkdtemp(path.join(os.tmpdir(), "aiboard-account-runner-message-item-"));
  const authFile = path.join(tmp, "auth.json");
  const token = "test-token";
  const runnerPort = 18000 + Math.floor(Math.random() * 10000);
  const runnerUrl = `http://127.0.0.1:${runnerPort}`;
  let child: ChildProcessWithoutNullStreams | null = null;

  try {
    await writeFile(
      authFile,
      JSON.stringify({
        chatgpt: {
          type: "oauth",
          refresh: "unused",
          access: "fake-access",
          expires: Date.now() + 3_600_000,
          accountId: "acct-test",
          updatedAt: new Date().toISOString(),
        },
      })
    );
    child = spawn(
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
        "--chatgpt-codex-endpoint",
        upstreamUrl,
      ],
      { cwd: process.cwd() }
    );
    await waitForRunnerReady(child, runnerUrl, token);

    const response = await fetch(`${runnerUrl}/providers/chatgpt/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-runner-token": token,
      },
      body: JSON.stringify({
        model: "gpt-5.3-codex-spark",
        messages: [{ role: "user", content: "Return text." }],
        attachments: [],
        stream: true,
      }),
    });
    const text = await response.text();
    const events = parseNormalizedSse(text);

    check(
      "local account runner streams message output item text as token content",
      events.some((event) => event.type === "token" && event.content === completedText),
      events
    );
  } finally {
    child?.kill();
    upstream.close();
    await Promise.allSettled([
      once(upstream, "close"),
      child ? once(child, "exit") : Promise.resolve(),
    ]);
    await rm(tmp, { recursive: true, force: true });
  }
}

async function testLocalRunnerSurvivesUpstreamStreamError(): Promise<void> {
  const { server: upstream, url: upstreamUrl } = await withServer(async (req, res) => {
    await readJsonBody(req);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    res.write(sseEvent({ type: "response.output_text.delta", delta: "partial " }));
    setTimeout(() => {
      res.destroy(new Error("simulated upstream stream failure"));
    }, 20);
  });

  const tmp = await mkdtemp(path.join(os.tmpdir(), "aiboard-account-runner-stream-error-"));
  const authFile = path.join(tmp, "auth.json");
  const token = "test-token";
  const runnerPort = 18000 + Math.floor(Math.random() * 10000);
  const runnerUrl = `http://127.0.0.1:${runnerPort}`;
  let child: ChildProcessWithoutNullStreams | null = null;
  let runnerOutput = "";

  try {
    await writeFile(
      authFile,
      JSON.stringify({
        chatgpt: {
          type: "oauth",
          refresh: "unused",
          access: "fake-access",
          expires: Date.now() + 3_600_000,
          accountId: "acct-test",
          updatedAt: new Date().toISOString(),
        },
      })
    );
    child = spawn(
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
        "--chatgpt-codex-endpoint",
        upstreamUrl,
      ],
      { cwd: process.cwd() }
    );
    child.stdout.on("data", (chunk) => {
      runnerOutput += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      runnerOutput += String(chunk);
    });
    await waitForRunnerReady(child, runnerUrl, token);

    let text = "";
    let fetchError: string | null = null;
    try {
      const response = await fetch(`${runnerUrl}/providers/chatgpt/chat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-runner-token": token,
        },
        body: JSON.stringify({
          model: "gpt-5.4-mini",
          messages: [{ role: "user", content: "Stream until upstream fails." }],
          attachments: [],
          stream: true,
        }),
      });
      text = await response.text();
    } catch (err) {
      fetchError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    const events = fetchError ? [] : parseNormalizedSse(text);

    check(
      "local account runner reports mid-stream upstream failures as SSE errors",
      !fetchError &&
        events.some((event) => event.type === "token" && event.content === "partial ") &&
        events.some((event) => event.type === "error"),
      { fetchError, text, events }
    );
    check(
      "local account runner stays alive after mid-stream upstream failure",
      child.exitCode === null && !/ERR_HTTP_HEADERS_SENT/.test(runnerOutput),
      { exitCode: child.exitCode, runnerOutput }
    );
  } finally {
    child?.kill();
    upstream.close();
    await Promise.allSettled([
      once(upstream, "close"),
      child ? once(child, "exit") : Promise.resolve(),
    ]);
    await rm(tmp, { recursive: true, force: true });
  }
}

await testBrowserProviderStreaming();
await testLocalRunnerForwardsNativeTools();
await testLocalRunnerStreamsCompletedOutputText();
await testLocalRunnerStreamsMessageOutputItemText();
await testLocalRunnerSurvivesUpstreamStreamError();

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
