/* Certified bench runner contract checks (run: npx tsx scripts/test-bench-runner-contract.mts) */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

async function request(
  baseUrl: string,
  path: string,
  token: string | null,
  body?: unknown,
  options: { method?: string; origin?: string } = {}
): Promise<{ status: number; data: Record<string, unknown>; headers: Headers }> {
  const headers: Record<string, string> = {};
  if (token) headers["x-runner-token"] = token;
  if (options.origin) headers.origin = options.origin;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, data, headers: response.headers };
}

async function waitForHealth(baseUrl: string, token: string): Promise<Record<string, unknown>> {
  let lastError = "";
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const result = await request(baseUrl, "/bench/health", token);
      if (result.status === 200) return result.data;
      lastError = JSON.stringify(result.data);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`bench runner did not become healthy: ${lastError}`);
}

function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolveStop) => {
    if (child.killed || child.exitCode !== null) {
      resolveStop();
      return;
    }
    child.once("exit", () => resolveStop());
    child.kill();
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 1000).unref();
  });
}

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = await mkdtemp(join(tmpdir(), "aiboard-bench-runner-"));
const runsRoot = join(root, ".aiboard-bench", "runs");
const port = 19_000 + Math.floor(Math.random() * 10_000);
const token = `test-token-${Date.now()}`;
const baseUrl = `http://127.0.0.1:${port}`;
const command = `node -e "require('fs').writeFileSync('cmd.txt','ran')"`;

const child = spawn(process.execPath, [
  join(repoRoot, "scripts", "bench-runner.mjs"),
  "--port",
  String(port),
  "--token",
  token,
  "--root",
  runsRoot,
  "--app-origin",
  "http://app.example.test",
], {
  cwd: repoRoot,
  stdio: ["ignore", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += String(chunk);
});

try {
  const health = await waitForHealth(baseUrl, token);
  check("runner binds as bench service", health.ok === true && health.host === "127.0.0.1" && health.mcp === false, health);
  check("runner reports isolated runs root", String(health.root).endsWith(".aiboard-bench\\runs") || String(health.root).endsWith(".aiboard-bench/runs"), health);

  const unauthorized = await request(baseUrl, "/bench/health", null);
  check("runner requires token for health", unauthorized.status === 401, unauthorized);
  check("unauthorized CORS still allows browser to read failure", unauthorized.headers.get("access-control-allow-methods") === "GET,POST,OPTIONS", Object.fromEntries(unauthorized.headers));

  const corsHealth = await request(baseUrl, "/bench/health", token, undefined, { origin: "http://localhost:3000" });
  check("runner echoes allowed app origin", corsHealth.status === 200 && corsHealth.headers.get("access-control-allow-origin") === "http://localhost:3000", Object.fromEntries(corsHealth.headers));
  const extraOriginHealth = await request(baseUrl, "/bench/health", token, undefined, { origin: "http://app.example.test" });
  check("runner allows extra --app-origin", extraOriginHealth.status === 200 && extraOriginHealth.headers.get("access-control-allow-origin") === "http://app.example.test", Object.fromEntries(extraOriginHealth.headers));
  const disallowedOriginHealth = await request(baseUrl, "/bench/health", token, undefined, { origin: "https://evil.example.test" });
  check("runner does not echo disallowed origins", disallowedOriginHealth.status === 200 && disallowedOriginHealth.headers.get("access-control-allow-origin") !== "https://evil.example.test", Object.fromEntries(disallowedOriginHealth.headers));
  const optionsPreflight = await request(baseUrl, "/bench/health", token, undefined, {
    method: "OPTIONS",
    origin: "http://localhost:3001",
  });
  check(
    "runner handles OPTIONS preflight for allowed origins",
    optionsPreflight.status === 204 &&
      optionsPreflight.headers.get("access-control-allow-origin") === "http://localhost:3001" &&
      optionsPreflight.headers.get("access-control-allow-headers")?.includes("x-runner-token") === true,
    { status: optionsPreflight.status, headers: Object.fromEntries(optionsPreflight.headers) }
  );

  const rejectedNetworkNone = await request(baseUrl, "/bench/prepare", token, {
    caseId: "workbench-contract-network-none",
    repoUrl: "fixture://inline",
    baseCommit: "fixture-base",
    network: "none",
    timeoutSeconds: 30,
    verifierCommand: "node verifier.js",
    allowedCommands: ["node verifier.js"],
    files: {
      "verifier.js": "console.log('ok')",
    },
  });
  check("prepare rejects command execution with network none", rejectedNetworkNone.status === 400, rejectedNetworkNone);

  const namedFixtureRejected = await request(baseUrl, "/bench/prepare", token, {
    attemptId: "fixture-resolution-attempt",
    caseId: "workbench-ts-cli-csv-0001",
    repoUrl: "fixture://workbench-ts-cli-csv-0001",
    baseCommit: "fixture-base",
    network: "dependency-only",
    timeoutSeconds: 30,
    setupCommand: "npm ci",
    allowedCommands: ["npm ci"],
  });
  check("prepare rejects legacy bundled fixture repositories", namedFixtureRejected.status === 400, namedFixtureRejected);

  const prepared = await request(baseUrl, "/bench/prepare", token, {
    caseId: "workbench-contract-0001",
    repoUrl: "fixture://inline",
    baseCommit: "fixture-base",
    network: "dependency-only",
    timeoutSeconds: 30,
    verifierCommand: "node verifier.js",
    verifierResultFile: "verifier-result.json",
    allowedCommands: [command, "node verifier.js"],
    files: {
      "input.txt": "hello\n",
      "verifier.js": "const fs=require('fs'); fs.writeFileSync('verifier-result.json', JSON.stringify({passed:true, score:1, summary:'ok', assertions:[{id:'file', label:'file exists', passed:fs.existsSync('input.txt'), weight:1}]})); console.log('verifier complete');",
    },
  });
  const attemptId = String(prepared.data.attemptId ?? "");
  check("prepare creates an attempt workspace", prepared.status === 200 && attemptId.length > 0, prepared);

  const tree = await request(baseUrl, "/bench/read-tree", token, { attemptId });
  check("read-tree lists fixture files", tree.status === 200 && Array.isArray(tree.data.files) && (tree.data.files as string[]).includes("input.txt"), tree);

  const inputFile = await request(baseUrl, "/bench/read-file", token, { attemptId, path: "input.txt" });
  check("read-file returns text content", inputFile.status === 200 && inputFile.data.content === "hello\n", inputFile);

  const write = await request(baseUrl, "/bench/write-file", token, { attemptId, path: "notes/out.txt", content: "created" });
  check("write-file writes inside workspace", write.status === 200 && write.data.bytes === 7, write);

  const patch = await request(baseUrl, "/bench/patch-file", token, { attemptId, path: "input.txt", search: "hello", replace: "hello world" });
  check("patch-file applies search replace", patch.status === 200 && patch.data.applied === 1, patch);

  const commandResult = await request(baseUrl, "/bench/run-command", token, { attemptId, command, timeoutSeconds: 10 });
  check("run-command executes allowlisted commands", commandResult.status === 200 && commandResult.data.exitCode === 0, commandResult);

  const denied = await request(baseUrl, "/bench/run-command", token, { attemptId, command: "git push", timeoutSeconds: 10 });
  check("run-command rejects commands outside allowlist", denied.status === 403, denied);

  const compatBase = `/bench/compat/${attemptId}`;
  const compatHealth = await request(baseUrl, `${compatBase}/health`, token);
  check("compat health exposes prepared attempt as runner", compatHealth.status === 200 && compatHealth.data.ok === true && String(compatHealth.data.dir).includes(attemptId), compatHealth);
  const compatLs = await request(baseUrl, `${compatBase}/ls`, token);
  check("compat ls lists prepared attempt files", compatLs.status === 200 && Array.isArray(compatLs.data.files) && (compatLs.data.files as string[]).includes("input.txt"), compatLs);
  const compatRead = await request(baseUrl, `${compatBase}/read`, token, { path: "input.txt" });
  check("compat read returns prepared attempt file", compatRead.status === 200 && compatRead.data.content === "hello world\n", compatRead);
  const compatWrite = await request(baseUrl, `${compatBase}/write`, token, { path: "build-output.txt", content: "compat" });
  check("compat write updates prepared attempt workspace", compatWrite.status === 200 && compatWrite.data.bytes === 6, compatWrite);
  const compatPatch = await request(baseUrl, `${compatBase}/patch`, token, {
    path: "build-output.txt",
    ops: [{ search: "compat", replace: "compat patched" }],
  });
  check("compat patch applies Build engine edit ops", compatPatch.status === 200 && compatPatch.data.applied === 1, compatPatch);
  const compatRun = await request(baseUrl, `${compatBase}/run`, token, { command, timeoutSeconds: 10 });
  check("compat run executes allowlisted Build command", compatRun.status === 200 && compatRun.data.exitCode === 0, compatRun);
  const compatRunDenied = await request(baseUrl, `${compatBase}/run`, token, { command: "git push", timeoutSeconds: 10 });
  check("compat run rejects commands outside allowlist", compatRunDenied.status === 403, compatRunDenied);

  const verifier = await request(baseUrl, "/bench/run-verifier", token, { attemptId });
  check("run-verifier executes configured verifier", verifier.status === 200 && verifier.data.passed === true && verifier.data.score === 1, verifier);
  check("run-verifier returns verifier result JSON", typeof verifier.data.resultJson === "string" && verifier.data.resultJson.includes("\"passed\":true"), verifier);

  const diff = await request(baseUrl, "/bench/diff", token, { attemptId });
  check("diff includes workspace modifications", diff.status === 200 && typeof diff.data.diff === "string" && diff.data.diff.includes("hello world"), diff);

  const artifact = await request(baseUrl, "/bench/artifact", token, { attemptId, path: "verifier-result.json" });
  check("artifact returns file content", artifact.status === 200 && typeof artifact.data.content === "string" && artifact.data.content.includes("\"score\":1"), artifact);

  const cleanup = await request(baseUrl, "/bench/cleanup", token, { attemptId });
  check("cleanup removes the attempt workspace", cleanup.status === 200 && cleanup.data.removed === true, cleanup);

  const afterCleanup = await request(baseUrl, "/bench/read-file", token, { attemptId, path: "input.txt" });
  check("read-file fails after cleanup", afterCleanup.status === 404, afterCleanup);
} catch (error) {
  check("bench runner contract did not throw", false, {
    error: error instanceof Error ? error.message : String(error),
    stderr,
  });
} finally {
  await stop(child);
  await rm(root, { recursive: true, force: true });
}

const badHost = spawn(process.execPath, [
  join(repoRoot, "scripts", "bench-runner.mjs"),
  "--host",
  "0.0.0.0",
  "--port",
  String(port + 1),
  "--token",
  token,
  "--root",
  join(root, "bad-host"),
], {
  cwd: repoRoot,
  stdio: ["ignore", "pipe", "pipe"],
});
let badHostStderr = "";
badHost.stderr.on("data", (chunk) => {
  badHostStderr += String(chunk);
});
const badHostExit = await new Promise<number | null>((resolveExit) => {
  badHost.once("exit", (code) => resolveExit(code));
  setTimeout(() => resolveExit(null), 2000).unref();
});
check("runner refuses non-loopback bind with CORS enabled", badHostExit !== 0 && badHostStderr.includes("refuses to bind non-loopback"), { badHostExit, badHostStderr });
await stop(badHost);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
