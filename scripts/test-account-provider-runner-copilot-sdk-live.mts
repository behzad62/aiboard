/** Optional live Copilot SDK/account-runner check. Skips when no local Copilot login exists. */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
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

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aiboard-copilot-sdk-live-"));
const tempAuthPath = path.join(tempRoot, "auth.json");
fs.writeFileSync(tempAuthPath, JSON.stringify({ githubCopilot: { access: githubToken } }));
let sdkClient: { start(): Promise<void>; stop(): Promise<unknown>; listModels(): Promise<Array<{ id?: string; capabilities?: unknown }>> } | undefined;
let runner: ReturnType<typeof spawn> | undefined;

try {
  const { CopilotClient } = await import("@github/copilot-sdk");
  sdkClient = new CopilotClient({
    mode: "empty",
    baseDirectory: path.join(tempRoot, "sdk-state"),
    workingDirectory: tempRoot,
    gitHubToken: githubToken,
    useLoggedInUser: false,
    logLevel: "error",
  });
  await sdkClient.start();
  const models = await sdkClient.listModels();
  const gemini = models.find((model) => model.id === "gemini-3.5-flash");
  check("live Copilot SDK lists Gemini 3.5 Flash", Boolean(gemini), models.map((model) => model.id));
  check(
    "live Copilot SDK reports Gemini reasoning capability",
    Boolean((gemini?.capabilities as { supports?: { reasoningEffort?: boolean } } | undefined)?.supports?.reasoningEffort),
    gemini?.capabilities
  );
} catch (error) {
  check("live Copilot SDK starts and lists models", false, error instanceof Error ? error.message : String(error));
} finally {
  try { await sdkClient?.stop(); } catch {}
}

try {
  const runnerPort = await freePort();
  const localToken = "live-test-runner-token";
  runner = spawn(
    process.execPath,
    ["lib/account-provider-runner.mjs", "--port", String(runnerPort), "--token", localToken, "--auth-file", tempAuthPath],
    { cwd: process.cwd(), stdio: ["ignore", "ignore", "ignore"], windowsHide: true }
  );
  const baseUrl = `http://127.0.0.1:${runnerPort}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const health = await fetch(`${baseUrl}/health`);
      if (health.ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const response = await fetch(`${baseUrl}/providers/github-copilot/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-runner-token": localToken },
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({
      runtimeMode: "discussion",
      model: "gemini-3.5-flash",
      reasoningEffort: "medium",
      maxTokens: 256,
      webSearch: true,
      messages: [{
        role: "user",
        content: "Use the web_search built-in tool to look up the official GitHub Copilot SDK repository. Reply with exactly its hostname and no other text.",
      }],
      stream: true,
    }),
  });
  const body = await response.text();
  const events = body
    .split(/\r?\n\r?\n/)
    .map((block) => block.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim())
    .filter(Boolean)
    .map((data) => {
      try { return JSON.parse(data!); } catch { return { type: "invalid" }; }
    });
  const content = events.filter((event) => event.type === "token").map((event) => event.content ?? "").join("");
  check("account runner live SDK request returns HTTP 200", response.ok, { status: response.status, events: events.map((event) => event.type) });
  check("account runner live SDK request streams a non-empty answer", content.trim().length > 0, content);
  check("account runner live SDK request completes without an SDK error", !events.some((event) => event.type === "error"), events);
} catch (error) {
  check("account runner live SDK request", false, error instanceof Error ? error.message : String(error));
} finally {
  if (runner) await stop(runner);
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

process.exit(failed === 0 ? 0 : 1);
