/** Account-provider runner ChatGPT chat regression (run: npx tsx scripts/test-account-provider-runner-chat.mts) */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

async function waitForCondition(
  condition: () => boolean,
  timeoutMs = 2_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return condition();
}

interface CapturedRequest {
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiboard-account-runner-chat-"));
const token = "test-token";
const runnerPort = await getFreePort();
const fakeBackendPort = await getFreePort();
const authFile = path.join(tmp, "auth.json");
const capturedRequests: CapturedRequest[] = [];
let disconnectBackendReceived = false;
let disconnectBackendClosed = false;
let nonStreamingDisconnectBackendReceived = false;
let nonStreamingDisconnectBackendClosed = false;
const refreshRequests: Array<{ closed: boolean }> = [];
const longSessionId = `worker:${"native-run-".repeat(7)}task:1`;
const expectedSessionId = `aiboard-${createHash("sha256")
  .update(longSessionId)
  .digest("hex")
  .slice(0, 56)}`;

fs.writeFileSync(
  authFile,
  JSON.stringify(
    {
      chatgpt: {
        type: "oauth",
        refresh: "fake-refresh-token",
        access: "fake-access-token",
        expires: Date.now() + 60 * 60 * 1000,
        accountId: "fake-account-id",
        updatedAt: new Date().toISOString(),
      },
    },
    null,
    2
  )
);

const fakeBackend = http.createServer(async (req, res) => {
  const raw = await readRequestBody(req);
  if (req.url === "/oauth/token") {
    const state = { closed: false };
    refreshRequests.push(state);
    const observeClose = () => {
      state.closed = true;
    };
    req.once("aborted", observeClose);
    req.socket.once("close", observeClose);
    return;
  }
  const body = raw ? JSON.parse(raw) : {};
  capturedRequests.push({
    headers: req.headers,
    body,
  });
  if (String(req.headers["session-id"] ?? "").length > 64) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message: "Invalid 'prompt_cache_key': string too long.",
        },
      })
    );
    return;
  }
  if (Object.prototype.hasOwnProperty.call(body, "max_output_tokens")) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message: "Unsupported parameter: max_output_tokens",
        },
      })
    );
    return;
  }
  if (body.store !== false) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: "Store must be set to false" }));
    return;
  }
  if (body.stream !== true) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: "Stream must be set to true" }));
    return;
  }
  if (body.model === "gpt-5.5-disconnect-test") {
    disconnectBackendReceived = true;
    const observeClose = () => {
      disconnectBackendClosed = true;
    };
    req.once("aborted", observeClose);
    req.socket.once("close", observeClose);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(
      'event: response.created\ndata: {"type":"response.created","sequence_number":0}\n\n'
    );
    return;
  }
  if (body.model === "gpt-5.5-disconnect-nonstream-test") {
    nonStreamingDisconnectBackendReceived = true;
    const observeClose = () => {
      nonStreamingDisconnectBackendClosed = true;
    };
    req.once("aborted", observeClose);
    req.socket.once("close", observeClose);
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    [
      "event: response.created",
      'data: {"type":"response.created","sequence_number":0}',
      "",
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"ok","sequence_number":1}',
      "",
      "event: response.completed",
      'data: {"type":"response.completed","sequence_number":2}',
      "",
    ].join("\n")
  );
});

await new Promise<void>((resolve) => fakeBackend.listen(fakeBackendPort, "127.0.0.1", resolve));

const runner = spawn(
  process.execPath,
  ["lib/account-provider-runner.mjs", "--port", String(runnerPort), "--token", token, "--auth-file", authFile],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AIBOARD_CHATGPT_CODEX_ENDPOINT: `http://127.0.0.1:${fakeBackendPort}/codex/responses`,
    },
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
const headers = {
  "content-type": "application/json",
  "x-runner-token": token,
};

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
  await stopChild(runner);
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    child.kill("SIGINT");
  }
  await Promise.race([
    new Promise<void>((resolve) => child.once("close", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
  ]);
}

async function waitForRunnerAt(url: string, output: () => string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`account-provider runner did not become ready: ${output()}`);
}

async function runRefreshDisconnectCase(
  stream: boolean,
  expires: number,
  label: string
): Promise<void> {
  const refreshRunnerPort = await getFreePort();
  const refreshAuthFile = path.join(tmp, `refresh-${label}.json`);
  const preloadFile = path.join(tmp, `redirect-refresh-${label}.cjs`);
  const initialAuth = `${JSON.stringify(
    {
      chatgpt: {
        type: "oauth",
        refresh: `fake-refresh-${label}`,
        access: `stale-access-${label}`,
        expires,
        accountId: `account-${label}`,
        updatedAt: "2026-07-28T00:00:00.000Z",
      },
    },
    null,
    2
  )}\n`;
  fs.writeFileSync(refreshAuthFile, initialAuth);
  fs.writeFileSync(
    preloadFile,
    [
      "const realFetch = global.fetch;",
      "global.fetch = (input, init) => {",
      "  const requestUrl = typeof input === 'string' ? input : input?.url ?? input?.href;",
      "  if (requestUrl === 'https://auth.openai.com/oauth/token') {",
      `    return realFetch('http://127.0.0.1:${fakeBackendPort}/oauth/token', init);`,
      "  }",
      "  return realFetch(input, init);",
      "};",
      "",
    ].join("\n")
  );
  const refreshRunner = spawn(
    process.execPath,
    [
      "lib/account-provider-runner.mjs",
      "--port",
      String(refreshRunnerPort),
      "--token",
      token,
      "--auth-file",
      refreshAuthFile,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preloadFile}`]
          .filter(Boolean)
          .join(" "),
        AIBOARD_CHATGPT_CODEX_ENDPOINT: `http://127.0.0.1:${fakeBackendPort}/codex/responses`,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );
  let refreshRunnerOutput = "";
  refreshRunner.stdout.setEncoding("utf8");
  refreshRunner.stderr.setEncoding("utf8");
  refreshRunner.stdout.on("data", (chunk) => {
    refreshRunnerOutput += chunk;
  });
  refreshRunner.stderr.on("data", (chunk) => {
    refreshRunnerOutput += chunk;
  });
  try {
    const refreshBaseUrl = `http://127.0.0.1:${refreshRunnerPort}`;
    await waitForRunnerAt(refreshBaseUrl, () => refreshRunnerOutput);
    const previousRefreshCount = refreshRequests.length;
    const controller = new AbortController();
    const request = fetch(`${refreshBaseUrl}/providers/chatgpt/chat`, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: `gpt-5.5-refresh-${label}`,
        stream,
        messages: [{ role: "user", content: "Keep refresh open." }],
      }),
    })
      .then((response) => response.text())
      .catch(() => undefined);
    const refreshReceived = await waitForCondition(
      () => refreshRequests.length > previousRefreshCount
    );
    check(
      `fake OAuth server receives the ${label} ChatGPT refresh`,
      refreshReceived
    );
    controller.abort();
    await request;
    const refreshState = refreshRequests[previousRefreshCount];
    const refreshClosed = await waitForCondition(
      () => refreshState?.closed === true
    );
    check(
      `disconnecting the ${label} ChatGPT request closes its OAuth refresh socket`,
      refreshClosed
    );
    check(
      `disconnecting the ${label} ChatGPT request does not persist credentials`,
      fs.readFileSync(refreshAuthFile, "utf8") === initialAuth
    );
  } finally {
    await stopChild(refreshRunner);
  }
}

try {
  await waitForRunner();

  const healthResponse = await fetch(`${baseUrl}/health`);
  const health = await healthResponse.json();
  check(
    "GPT-5.6-capable account-provider runner reports version 19",
    healthResponse.ok && health.version === 19,
    health
  );

  const response = await fetch(`${baseUrl}/providers/chatgpt/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "gpt-5.5",
      sessionId: longSessionId,
      maxTokens: 1234,
      reasoningEffort: "high",
      messages: [
        { role: "system", content: "You are validating a model connection." },
        { role: "user", content: "Reply with exactly: ok" },
      ],
      attachments: [
        {
          id: "img-1",
          filename: "red.png",
          mimeType: "image/png",
          category: "image",
          base64Data: "AAECAw==",
        },
        {
          id: "doc-1",
          filename: "note.txt",
          mimeType: "text/plain",
          category: "document",
          textContent: "AIBOARD_DOCUMENT_SECRET=blue-river",
        },
      ],
    }),
  });
  const data = await response.json();
  const captured = capturedRequests[0];

  check("ChatGPT chat returns HTTP 200 from fake backend", response.ok, data);
  check("ChatGPT chat returns response text", data.content === "ok", data);
  check("runner sends one ChatGPT backend request", capturedRequests.length === 1, capturedRequests);
  check("runner sends store false to Codex backend", captured?.body.store === false, captured?.body);
  check("runner requests the Codex backend stream", captured?.body.stream === true, captured?.body);
  check("runner sends selected model", captured?.body.model === "gpt-5.5", captured?.body);
  check(
    "runner omits ChatGPT max output tokens unsupported by Codex backend",
    !Object.prototype.hasOwnProperty.call(captured?.body ?? {}, "max_output_tokens"),
    captured?.body
  );
  check(
    "runner forwards ChatGPT reasoning effort",
    JSON.stringify(captured?.body.reasoning) === JSON.stringify({ effort: "high" }),
    captured?.body
  );
  const userInput = Array.isArray(captured?.body.input) ? captured?.body.input.find((item) => item.role === "user") : undefined;
  const userContent = Array.isArray(userInput?.content) ? userInput.content : [];
  check(
    "runner sends ChatGPT text attachments as input_text",
    userContent.some((part) => part?.type === "input_text" && String(part.text).includes("AIBOARD_DOCUMENT_SECRET=blue-river")),
    userContent
  );
  check(
    "runner sends ChatGPT images as input_image data URLs",
    userContent.some((part) => part?.type === "input_image" && part.image_url === "data:image/png;base64,AAECAw=="),
    userContent
  );
  check("runner sends account id header", captured?.headers["chatgpt-account-id"] === "fake-account-id", captured?.headers);
  check("runner sends bearer token header", captured?.headers.authorization === "Bearer fake-access-token", captured?.headers);
  check(
    "runner bounds long ChatGPT session ids deterministically",
    captured?.headers["session-id"] === expectedSessionId,
    captured?.headers["session-id"]
  );

  const reasoningCases = [
    { model: "gpt-5.5", input: "default", expected: undefined },
    { model: "gpt-5.5", input: "none", expected: "none" },
    { model: "gpt-5.5", input: "low", expected: "low" },
    { model: "gpt-5.5", input: "medium", expected: "medium" },
    { model: "gpt-5.5", input: "high", expected: "high" },
    { model: "gpt-5.5", input: "max", expected: "xhigh" },
    { model: "gpt-5.6-sol", input: "max", expected: "max" },
  ];
  for (const reasoningCase of reasoningCases) {
    const effortResponse = await fetch(`${baseUrl}/providers/chatgpt/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: reasoningCase.model,
        reasoningEffort: reasoningCase.input,
        messages: [{ role: "user", content: "Reply with exactly: ok" }],
      }),
    });
    const effortData = await effortResponse.json();
    const effortCaptured = capturedRequests.at(-1);
    check(
      `ChatGPT ${reasoningCase.model} ${reasoningCase.input} reasoning request returns HTTP 200`,
      effortResponse.ok,
      effortData
    );
    check(
      reasoningCase.expected
        ? `runner forwards ChatGPT ${reasoningCase.model} ${reasoningCase.input} reasoning effort`
        : "runner omits ChatGPT default reasoning effort",
      reasoningCase.expected
        ? JSON.stringify(effortCaptured?.body.reasoning) ===
            JSON.stringify({ effort: reasoningCase.expected })
        : !Object.prototype.hasOwnProperty.call(
            effortCaptured?.body ?? {},
            "reasoning"
          ),
      effortCaptured?.body
    );
  }

  const downstreamController = new AbortController();
  const downstreamRequest = fetch(
    `${baseUrl}/providers/chatgpt/chat`,
    {
      method: "POST",
      headers,
      signal: downstreamController.signal,
      body: JSON.stringify({
        model: "gpt-5.5-disconnect-test",
        stream: true,
        messages: [{ role: "user", content: "Keep this stream open." }],
      }),
    }
  )
    .then(async (streamingResponse) => {
      await streamingResponse.text();
    })
    .catch(() => {});

  const backendReceivedDisconnectRequest = await waitForCondition(
    () => disconnectBackendReceived
  );
  check(
    "fake ChatGPT backend receives the downstream cancellation test request",
    backendReceivedDisconnectRequest
  );
  downstreamController.abort();
  await downstreamRequest;
  const backendObservedDisconnect = await waitForCondition(
    () => disconnectBackendClosed
  );
  check(
    "disconnecting the runner client closes the upstream ChatGPT connection",
    backendObservedDisconnect
  );

  const nonStreamingController = new AbortController();
  const nonStreamingRequest = fetch(
    `${baseUrl}/providers/chatgpt/chat`,
    {
      method: "POST",
      headers,
      signal: nonStreamingController.signal,
      body: JSON.stringify({
        model: "gpt-5.5-disconnect-nonstream-test",
        stream: false,
        messages: [{ role: "user", content: "Keep this request open." }],
      }),
    }
  ).catch(() => undefined);
  const nonStreamingReceived = await waitForCondition(
    () => nonStreamingDisconnectBackendReceived
  );
  check(
    "fake ChatGPT backend receives the non-streaming cancellation test request",
    nonStreamingReceived
  );
  nonStreamingController.abort();
  await nonStreamingRequest;
  const nonStreamingClosed = await waitForCondition(
    () => nonStreamingDisconnectBackendClosed
  );
  check(
    "disconnecting the non-streaming runner client closes the upstream ChatGPT connection",
    nonStreamingClosed
  );

  await runRefreshDisconnectCase(true, Date.now() - 1_000, "expired-stream");
  await runRefreshDisconnectCase(
    false,
    Date.now() + 30_000,
    "near-expiry-nonstream"
  );
} catch (err) {
  check("account-provider runner ChatGPT chat integration", false, err instanceof Error ? err.message : String(err));
} finally {
  await stopRunner();
  await new Promise<void>((resolve) => fakeBackend.close(() => resolve()));
  fs.rmSync(tmp, { recursive: true, force: true });
}

process.exit(failed === 0 ? 0 : 1);
