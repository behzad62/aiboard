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
  body?: unknown
): Promise<{ status: number; data: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (token) headers["x-runner-token"] = token;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, data };
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

  const fixturePrepared = await request(baseUrl, "/bench/prepare", token, {
    attemptId: "fixture-resolution-attempt",
    caseId: "workbench-ts-cli-csv-0001",
    repoUrl: "fixture://workbench-ts-cli-csv-0001",
    baseCommit: "fixture-base",
    network: "dependency-only",
    timeoutSeconds: 30,
    setupCommand: "npm ci",
    allowedCommands: ["npm ci"],
  });
  check("prepare resolves checked-in fixture repositories", fixturePrepared.status === 200 && fixturePrepared.data.attemptId === "fixture-resolution-attempt", fixturePrepared);
  const fixtureTree = await request(baseUrl, "/bench/read-tree", token, { attemptId: "fixture-resolution-attempt" });
  check("fixture repository is copied into workspace", fixtureTree.status === 200 && Array.isArray(fixtureTree.data.files) && (fixtureTree.data.files as string[]).includes("package.json"), fixtureTree);
  await request(baseUrl, "/bench/cleanup", token, { attemptId: "fixture-resolution-attempt" });

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

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
