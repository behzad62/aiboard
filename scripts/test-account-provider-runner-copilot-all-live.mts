/** Live Copilot feature matrix. Skips when no local account-runner login exists. */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("could not allocate a local port"));
      });
    });
  });
}

function stop(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    if (process.platform === "win32" && child.pid) {
      spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      child.kill("SIGINT");
    }
    const timer = setTimeout(resolve, 5_000);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function parseSse(text: string): Array<Record<string, unknown>> {
  return text
    .split(/\r?\n\r?\n/)
    .map((block) => block.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim())
    .filter(Boolean)
    .map((data) => {
      try { return JSON.parse(data!); } catch { return { type: "invalid" }; }
    });
}

function responseContent(responseText: string, contentType: string): {
  content: string;
  events: Array<Record<string, unknown>>;
  json: Record<string, unknown>;
} {
  if (contentType.includes("text/event-stream")) {
    const events = parseSse(responseText);
    return {
      events,
      content: events
        .filter((event) => event.type === "token")
        .map((event) => (typeof event.content === "string" ? event.content : ""))
        .join(""),
      json: {},
    };
  }
  try {
    const json = JSON.parse(responseText) as Record<string, unknown>;
    return { events: [], content: typeof json.content === "string" ? json.content : "", json };
  } catch {
    return { events: [], content: responseText, json: {} };
  }
}

const authPath = path.join(os.homedir(), ".aiboard-account-provider-runner.json");
if (!fs.existsSync(authPath)) {
  console.log("SKIP - no local account-runner auth file");
  process.exit(0);
}
const auth = JSON.parse(fs.readFileSync(authPath, "utf8")) as {
  githubCopilot?: { access?: string };
};
const githubToken = auth.githubCopilot?.access;
if (!githubToken) {
  console.log("SKIP - account-runner auth file has no GitHub Copilot token");
  process.exit(0);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aiboard-copilot-all-live-"));
const tempAuthPath = path.join(tempRoot, "auth.json");
fs.writeFileSync(tempAuthPath, JSON.stringify({ githubCopilot: { access: githubToken } }));
let runner: ReturnType<typeof spawn> | undefined;

try {
  const { CopilotClient } = await import("@github/copilot-sdk");
  const modelClient = new CopilotClient({
    mode: "empty",
    baseDirectory: path.join(tempRoot, "model-state"),
    workingDirectory: tempRoot,
    gitHubToken: githubToken,
    useLoggedInUser: false,
    logLevel: "error",
  });
  let models: Array<{
    id?: string;
    capabilities?: { supports?: { reasoningEffort?: boolean } };
  }> = [];
  try {
    await modelClient.start();
    models = await modelClient.listModels();
  } finally {
    try { await modelClient.stop(); } catch {}
  }

  const modelIds = models.map((model) => model.id).filter(Boolean) as string[];
  const geminiModel = models.find((model) => model.id === "gemini-3.5-flash");
  const gptModel = models.find((model) => model.id === "gpt-5.4-mini") ??
    models.find((model) => /^gpt-5\.4$/i.test(model.id ?? ""));
  check("live model list includes Gemini 3.5 Flash", Boolean(geminiModel), modelIds);
  check("live Gemini model advertises reasoning", Boolean(geminiModel?.capabilities?.supports?.reasoningEffort), geminiModel?.capabilities);
  check("live model list includes a GPT-5.4 raw-route model", Boolean(gptModel), modelIds);

  const runnerPort = await freePort();
  const localToken = "live-all-feature-test-token";
  runner = spawn(
    process.execPath,
    ["lib/account-provider-runner.mjs", "--port", String(runnerPort), "--token", localToken, "--auth-file", tempAuthPath],
    { cwd: process.cwd(), stdio: ["ignore", "ignore", "ignore"], windowsHide: true }
  );
  const baseUrl = `http://127.0.0.1:${runnerPort}`;
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try {
      const health = await fetch(`${baseUrl}/health`);
      if (health.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  check("account runner starts for the live feature matrix", ready);
  if (!ready) throw new Error("account runner did not become ready");

  async function request(body: Record<string, unknown>) {
    const response = await fetch(`${baseUrl}/providers/github-copilot/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-runner-token": localToken },
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { response, ...responseContent(text, response.headers.get("content-type") ?? "") };
  }

  const sdkText = await request({
    runtimeMode: "discussion",
    model: "gemini-3.5-flash",
    reasoningEffort: "medium",
    maxTokens: 128,
    messages: [{ role: "user", content: "Reply with exactly LIVE_SDK_REASONING_OK." }],
    stream: true,
  });
  check("SDK discussion with reasoning returns HTTP 200", sdkText.response.ok, sdkText.json);
  check("SDK discussion with reasoning streams the expected marker", sdkText.content.includes("LIVE_SDK_REASONING_OK"), sdkText.content);
  check("SDK discussion with reasoning has no error event", !sdkText.events.some((event) => event.type === "error"), sdkText.events);

  const sdkWebSearch = await request({
    runtimeMode: "discussion",
    model: "gemini-3.5-flash",
    reasoningEffort: "low",
    maxTokens: 256,
    webSearch: true,
    messages: [{ role: "user", content: "Use the web_search built-in tool to look up the official GitHub Copilot SDK repository. Reply with exactly github.com." }],
    stream: true,
  });
  check("SDK web-search discussion returns HTTP 200", sdkWebSearch.response.ok, sdkWebSearch.json);
  check("SDK web-search discussion returns the expected domain", sdkWebSearch.content.toLowerCase().includes("github.com"), sdkWebSearch.content);
  check("SDK web-search discussion has no error event", !sdkWebSearch.events.some((event) => event.type === "error"), sdkWebSearch.events);

  const structured = await request({
    runtimeMode: "discussion",
    model: gptModel?.id ?? "gpt-5.4-mini",
    reasoningEffort: "high",
    maxTokens: 256,
    structuredOutput: {
      name: "live_result",
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          marker: { type: "string" },
        },
        required: ["ok", "marker"],
        additionalProperties: false,
      },
      strict: true,
    },
    messages: [{ role: "user", content: "Return ok=true and marker=LIVE_STRUCTURED_OK." }],
    stream: true,
  });
  check("raw structured-output route returns HTTP 200", structured.response.ok, structured.json);
  check("raw structured-output route returns the requested marker", structured.content.includes("LIVE_STRUCTURED_OK"), structured.content);

  const attachment = await request({
    runtimeMode: "discussion",
    model: gptModel?.id ?? "gpt-5.4-mini",
    maxTokens: 128,
    messages: [{ role: "user", content: "Read the attached note and reply with exactly ATTACHMENT_LIVE_OK." }],
    attachments: [
      {
        id: "live-document",
        filename: "live-note.txt",
        mimeType: "text/plain",
        category: "document",
        textContent: "ATTACHMENT_LIVE_OK",
      },
      {
        id: "live-image",
        filename: "live-pixel.png",
        mimeType: "image/png",
        category: "image",
        base64Data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      },
    ],
    stream: true,
  });
  check("raw attachment route returns HTTP 200", attachment.response.ok, attachment.json);
  check("raw attachment route returns the document marker", attachment.content.includes("ATTACHMENT_LIVE_OK"), attachment.content);

  const buildRaw = await request({
    runtimeMode: "build",
    model: gptModel?.id ?? "gpt-5.4-mini",
    reasoningEffort: "medium",
    maxTokens: 128,
    webSearch: true,
    messages: [{ role: "user", content: "Reply with exactly BUILD_RAW_LIVE_OK." }],
    nativeTools: [],
    stream: true,
  });
  check("explicit Build-mode raw route returns HTTP 200", buildRaw.response.ok, buildRaw.json);
  check("explicit Build-mode raw route returns the expected marker", buildRaw.content.includes("BUILD_RAW_LIVE_OK"), buildRaw.content);
  check("explicit Build-mode raw route is not an SDK SSE response", buildRaw.events.length === 0, buildRaw.events);
} catch (error) {
  check("live Copilot feature matrix", false, error instanceof Error ? error.message : String(error));
} finally {
  if (runner) await stop(runner);
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
