/** Account-provider runner GitHub Copilot chat attachment regression (run: npx tsx scripts/test-account-provider-runner-copilot-chat.mts) */
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
  url: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiboard-account-runner-copilot-chat-"));
const token = "test-token";
const runnerPort = await getFreePort();
const fakeBackendPort = await getFreePort();
const authFile = path.join(tmp, "auth.json");
const capturedRequests: CapturedRequest[] = [];
let disconnectFallbackReceived = false;
let disconnectFallbackClosed = false;
let chatFallbackReceived = false;
let chatFallbackClosed = false;

fs.writeFileSync(
  authFile,
  JSON.stringify(
    {
      githubCopilot: {
        type: "oauth",
        access: "fake-copilot-token",
        refresh: "fake-copilot-token",
        expires: 0,
        updatedAt: new Date().toISOString(),
      },
    },
    null,
    2
  )
);

const fakeBackend = http.createServer(async (req, res) => {
  const raw = await readRequestBody(req);
  const body = raw ? JSON.parse(raw) : {};
  capturedRequests.push({ url: req.url, headers: req.headers, body });
  if (body.model === "gpt-5.4-disconnect-test") {
    if (req.url === "/responses") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Use fallback" } }));
      return;
    }
    disconnectFallbackReceived = true;
    const observeClose = () => {
      disconnectFallbackClosed = true;
    };
    req.once("aborted", observeClose);
    req.socket.once("close", observeClose);
    return;
  }
  if (body.model === "claude-disconnect-test") {
    if (req.url === "/chat/completions") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Use fallback" } }));
      return;
    }
    chatFallbackReceived = true;
    const observeClose = () => {
      chatFallbackClosed = true;
    };
    req.once("aborted", observeClose);
    req.socket.once("close", observeClose);
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
});

await new Promise<void>((resolve) => fakeBackend.listen(fakeBackendPort, "127.0.0.1", resolve));

const runner = spawn(
  process.execPath,
  ["lib/account-provider-runner.mjs", "--port", String(runnerPort), "--token", token, "--auth-file", authFile],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AIBOARD_GITHUB_COPILOT_API_BASE: `http://127.0.0.1:${fakeBackendPort}`,
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

async function checkRunnerSdkCancellation(): Promise<void> {
  const sdkRunnerPort = await getFreePort();
  const copiedRunner = path.join(tmp, "sdk-boundary-runner.mjs");
  const fakeSdk = path.join(tmp, "account-provider-copilot-sdk.mjs");
  const admittedMarker = path.join(tmp, "sdk-admitted");
  const abortedMarker = path.join(tmp, "sdk-aborted");
  fs.copyFileSync("lib/account-provider-runner.mjs", copiedRunner);
  fs.writeFileSync(
    fakeSdk,
    [
      'import fs from "node:fs";',
      "export async function runCopilotSdkChat(body, token, baseDirectory, onToken, { signal } = {}) {",
      `  fs.writeFileSync(${JSON.stringify(admittedMarker)}, "admitted");`,
      "  return new Promise((resolve, reject) => {",
      "    const abort = () => {",
      `      fs.writeFileSync(${JSON.stringify(abortedMarker)}, "aborted");`,
      '      reject(new Error("fake SDK aborted"));',
      "    };",
      "    if (signal?.aborted) abort();",
      '    else signal?.addEventListener("abort", abort, { once: true });',
      "  });",
      "}",
      "",
    ].join("\n")
  );
  const sdkRunner = spawn(
    process.execPath,
    [
      copiedRunner,
      "--port",
      String(sdkRunnerPort),
      "--token",
      token,
      "--auth-file",
      authFile,
    ],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );
  let sdkRunnerOutput = "";
  sdkRunner.stdout.setEncoding("utf8");
  sdkRunner.stderr.setEncoding("utf8");
  sdkRunner.stdout.on("data", (chunk) => {
    sdkRunnerOutput += chunk;
  });
  sdkRunner.stderr.on("data", (chunk) => {
    sdkRunnerOutput += chunk;
  });
  try {
    const sdkBaseUrl = `http://127.0.0.1:${sdkRunnerPort}`;
    await waitForRunnerAt(sdkBaseUrl, () => sdkRunnerOutput);
    const controller = new AbortController();
    const request = fetch(`${sdkBaseUrl}/providers/github-copilot/chat`, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        runtimeMode: "discussion",
        model: "gpt-5.4",
        stream: true,
        messages: [{ role: "user", content: "Keep the SDK open." }],
      }),
    })
      .then((response) => response.text())
      .catch(() => undefined);
    const admitted = await waitForCondition(() => fs.existsSync(admittedMarker));
    check("runner-boundary fake Copilot SDK receives the chat request", admitted);
    controller.abort();
    await request;
    const aborted = await waitForCondition(() => fs.existsSync(abortedMarker));
    check(
      "runner request cancellation reaches and aborts the Copilot SDK adapter",
      aborted
    );
  } finally {
    await stopChild(sdkRunner);
  }
}

try {
  await waitForRunner();

  const response = await fetch(`${baseUrl}/providers/github-copilot/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      runtimeMode: "build",
      model: "claude-sonnet-4.5",
      maxTokens: 321,
      reasoningEffort: "high",
      messages: [{ role: "user", content: "Read the attachments." }],
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
  const userMessage = Array.isArray(captured?.body.messages)
    ? captured?.body.messages.find((message) => message.role === "user")
    : undefined;
  const userContent = Array.isArray(userMessage?.content) ? userMessage.content : [];

  check("GitHub Copilot chat returns HTTP 200 from fake backend", response.ok, data);
  check("GitHub Copilot chat returns response text", data.content === "ok", data);
  check("runner sends one GitHub Copilot backend request", capturedRequests.length === 1, capturedRequests);
  check("runner uses configured GitHub Copilot API base for non-GPT-5 chat models", captured?.url === "/chat/completions", captured);
  check("runner forwards Copilot chat max tokens", captured?.body.max_tokens === 321, captured?.body);
  check(
    "runner omits reasoning for Copilot Claude chat-completions models",
    !Object.prototype.hasOwnProperty.call(captured?.body ?? {}, "reasoning") &&
      !Object.prototype.hasOwnProperty.call(captured?.body ?? {}, "reasoning_effort"),
    captured?.body
  );
  check(
    "runner sends Copilot text attachments in text part",
    userContent.some((part) => part?.type === "text" && String(part.text).includes("AIBOARD_DOCUMENT_SECRET=blue-river")),
    userContent
  );
  check(
    "runner sends Copilot images as image_url data URLs",
    userContent.some((part) => part?.type === "image_url" && part.image_url?.url === "data:image/png;base64,AAECAw=="),
    userContent
  );

  const responsesResponse = await fetch(`${baseUrl}/providers/github-copilot/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      runtimeMode: "build",
      model: "gpt-5.4-mini",
      maxTokens: 654,
      reasoningEffort: "max",
      messages: [{ role: "user", content: "Read the attachments." }],
      attachments: [
        {
          id: "img-2",
          filename: "red.png",
          mimeType: "image/png",
          category: "image",
          base64Data: "AAECAw==",
        },
        {
          id: "doc-2",
          filename: "note.txt",
          mimeType: "text/plain",
          category: "document",
          textContent: "AIBOARD_DOCUMENT_SECRET=blue-river",
        },
      ],
    }),
  });
  const responsesData = await responsesResponse.json();
  const responsesCaptured = capturedRequests[1];
  const responsesUserInput = Array.isArray(responsesCaptured?.body.input)
    ? responsesCaptured?.body.input.find((item) => item.role === "user")
    : undefined;
  const responsesContent = Array.isArray(responsesUserInput?.content) ? responsesUserInput.content : [];

  check("GitHub Copilot responses route returns HTTP 200 from fake backend", responsesResponse.ok, responsesData);
  check("runner uses Copilot responses path for GPT-5-class models including mini", responsesCaptured?.url === "/responses", responsesCaptured);
  check("runner forwards Copilot responses max output tokens", responsesCaptured?.body.max_output_tokens === 654, responsesCaptured?.body);
  check(
    "runner forwards Copilot responses reasoning effort",
    JSON.stringify(responsesCaptured?.body.reasoning) === JSON.stringify({ effort: "xhigh" }),
    responsesCaptured?.body
  );
  check(
    "runner sends Copilot responses text attachments as input_text",
    responsesContent.some((part) => part?.type === "input_text" && String(part.text).includes("AIBOARD_DOCUMENT_SECRET=blue-river")),
    responsesContent
  );
  check(
    "runner sends Copilot responses images as input_image data URLs",
    responsesContent.some((part) => part?.type === "input_image" && part.image_url === "data:image/png;base64,AAECAw=="),
    responsesContent
  );

  const reasoningCases = [
    { input: "default", expected: undefined },
    { input: "none", expected: "none" },
    { input: "low", expected: "low" },
    { input: "medium", expected: "medium" },
    { input: "high", expected: "high" },
    { input: "max", expected: "xhigh" },
  ];
  for (const reasoningCase of reasoningCases) {
    const effortResponse = await fetch(`${baseUrl}/providers/github-copilot/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        runtimeMode: "build",
        model: "gpt-5.4-mini",
        reasoningEffort: reasoningCase.input,
        messages: [{ role: "user", content: "Reply with exactly: ok" }],
      }),
    });
    const effortData = await effortResponse.json();
    const effortCaptured = capturedRequests.at(-1);
    check(
      `GitHub Copilot GPT ${reasoningCase.input} reasoning request returns HTTP 200`,
      effortResponse.ok,
      effortData
    );
    check(
      reasoningCase.expected
        ? `runner forwards Copilot GPT ${reasoningCase.input} reasoning effort`
        : "runner omits Copilot GPT default reasoning effort",
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
    `${baseUrl}/providers/github-copilot/chat`,
    {
      method: "POST",
      headers,
      signal: downstreamController.signal,
      body: JSON.stringify({
        runtimeMode: "build",
        model: "gpt-5.4-disconnect-test",
        structuredOutput: {
          name: "disconnect_test",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["ok"],
            properties: { ok: { type: "boolean" } },
          },
        },
        messages: [{ role: "user", content: "Keep this request open." }],
      }),
    }
  ).catch(() => undefined);
  const fallbackReceived = await waitForCondition(
    () => disconnectFallbackReceived
  );
  check(
    "fake Copilot responses fallback receives the disconnect test request",
    fallbackReceived
  );
  downstreamController.abort();
  await downstreamRequest;
  const fallbackClosed = await waitForCondition(
    () => disconnectFallbackClosed
  );
  check(
    "disconnecting the runner client closes the Copilot responses fallback request",
    fallbackClosed
  );

  const chatController = new AbortController();
  const chatRequest = fetch(
    `${baseUrl}/providers/github-copilot/chat`,
    {
      method: "POST",
      headers,
      signal: chatController.signal,
      body: JSON.stringify({
        runtimeMode: "build",
        model: "claude-disconnect-test",
        messages: [{ role: "user", content: "Keep fallback open." }],
      }),
    }
  ).catch(() => undefined);
  const chatReceived = await waitForCondition(() => chatFallbackReceived);
  check(
    "fake Copilot chat-completions fallback receives the disconnect test request",
    chatReceived
  );
  chatController.abort();
  await chatRequest;
  const chatClosed = await waitForCondition(() => chatFallbackClosed);
  check(
    "disconnecting the runner client closes the Copilot chat-completions fallback request",
    chatClosed
  );

  await checkRunnerSdkCancellation();
} catch (err) {
  check("account-provider runner GitHub Copilot chat integration", false, err instanceof Error ? err.message : String(err));
} finally {
  await stopRunner();
  await new Promise<void>((resolve) => fakeBackend.close(() => resolve()));
  fs.rmSync(tmp, { recursive: true, force: true });
}

process.exit(failed === 0 ? 0 : 1);
