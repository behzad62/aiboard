/* Bench runner oracle-hiding checks (run: npx tsx scripts/test-workbench-runner-hiding.mts)
 *
 * Guards the WorkBench answer-leak finding: case-meta.json (the grading spec),
 * negative-control.json, reference-solution.md, and .bench-run.json must not be
 * readable through any model-facing runner endpoint (ls/read/read-range/search
 * and their /bench twins), while `node verifier.mjs` must still be able to read
 * case-meta.json from disk and the app must still fetch verifier-result.json.
 */
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
  token: string,
  body?: unknown
): Promise<{ status: number; data: Record<string, unknown> }> {
  const headers: Record<string, string> = { "x-runner-token": token };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, data };
}

async function waitForHealth(baseUrl: string, token: string): Promise<void> {
  let lastError = "";
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const result = await request(baseUrl, "/bench/health", token);
      if (result.status === 200) return;
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
const root = await mkdtemp(join(tmpdir(), "aiboard-bench-hiding-"));
const runsRoot = join(root, ".aiboard-bench", "runs");
const port = 19_000 + Math.floor(Math.random() * 10_000);
const token = `test-token-${Date.now()}`;
const baseUrl = `http://127.0.0.1:${port}`;

// A minimal verifier that proves case-meta.json is still readable FROM DISK
// (only the HTTP read surface is filtered).
const VERIFIER = [
  'import { readFileSync, writeFileSync } from "node:fs";',
  'const meta = JSON.parse(readFileSync("case-meta.json", "utf8"));',
  "const result = {",
  '  passed: meta.secretOracleMarker === ["SECRET", "ORACLE", "MARKER"].join("_"),',
  "  score: 1,",
  '  summary: "meta readable from disk",',
  '  assertions: [{ id: "meta", label: "meta readable", passed: true, weight: 1 }],',
  "};",
  'writeFileSync("verifier-result.json", JSON.stringify(result));',
  "console.log(JSON.stringify(result));",
  "process.exit(result.passed ? 0 : 1);",
].join("\n");

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

try {
  await waitForHealth(baseUrl, token);

  const prepare = await request(baseUrl, "/bench/prepare", token, {
    caseId: "workbench-hiding-test",
    repoUrl: "fixture://inline",
    baseCommit: "fixture-base",
    network: "dependency-only",
    timeoutSeconds: 30,
    verifierCommand: "node verifier.mjs",
    verifierResultFile: "verifier-result.json",
    allowedCommands: ["node verifier.mjs"],
    files: {
      "case-meta.json": JSON.stringify({ secretOracleMarker: "SECRET_ORACLE_MARKER" }),
      "negative-control.json": JSON.stringify({ wrong: "SECRET_ORACLE_MARKER" }),
      "reference-solution.md": "SECRET_ORACLE_MARKER",
      "verifier.mjs": VERIFIER,
      "verifier-result.json": "{}",
      "src/app.mjs": "export const answer = 42;\n",
    },
  });
  check("prepare succeeds", prepare.status === 200, prepare);
  const attemptId = String(prepare.data.attemptId ?? "");

  const tree = await request(baseUrl, "/bench/read-tree", token, { attemptId });
  const treeFiles = Array.isArray(tree.data.files) ? (tree.data.files as string[]) : [];
  check(
    "read-tree hides oracle files but lists fixture and verifier files",
    tree.status === 200 &&
      !treeFiles.includes("case-meta.json") &&
      !treeFiles.includes("negative-control.json") &&
      !treeFiles.includes("reference-solution.md") &&
      !treeFiles.includes(".bench-run.json") &&
      treeFiles.includes("src/app.mjs") &&
      treeFiles.includes("verifier.mjs") &&
      treeFiles.includes("verifier-result.json"),
    treeFiles
  );

  const compatLs = await request(baseUrl, `/bench/compat/${attemptId}/ls`, token, {});
  const compatFiles = Array.isArray(compatLs.data.files) ? (compatLs.data.files as string[]) : [];
  check(
    "compat /ls hides oracle files",
    compatLs.status === 200 &&
      !compatFiles.includes("case-meta.json") &&
      !compatFiles.includes("negative-control.json") &&
      !compatFiles.includes("reference-solution.md") &&
      compatFiles.includes("src/app.mjs"),
    compatFiles
  );

  for (const hidden of ["case-meta.json", "negative-control.json", "reference-solution.md", ".bench-run.json"]) {
    const benchRead = await request(baseUrl, "/bench/read-file", token, { attemptId, path: hidden });
    check(`/bench/read-file refuses ${hidden}`, benchRead.status === 404, benchRead);
    const compatRead = await request(baseUrl, `/bench/compat/${attemptId}/read`, token, { path: hidden });
    check(`compat /read refuses ${hidden}`, compatRead.status === 404, compatRead);
    const compatRange = await request(baseUrl, `/bench/compat/${attemptId}/read-range`, token, {
      path: hidden,
      startLine: 1,
      lineCount: 5,
    });
    check(`compat /read-range refuses ${hidden}`, compatRange.status === 404, compatRange);
  }

  const openRead = await request(baseUrl, "/bench/read-file", token, { attemptId, path: "src/app.mjs" });
  check(
    "fixture files stay readable",
    openRead.status === 200 && String(openRead.data.content).includes("answer"),
    openRead
  );

  const search = await request(baseUrl, `/bench/compat/${attemptId}/search`, token, {
    query: "SECRET_ORACLE_MARKER",
  });
  const searchResults = Array.isArray(search.data.results) ? search.data.results : [];
  check(
    "search cannot surface oracle file contents",
    search.status === 200 && searchResults.length === 0,
    searchResults
  );

  const write = await request(baseUrl, `/bench/compat/${attemptId}/write`, token, {
    path: "case-meta.json",
    content: "{}",
  });
  check("oracle files remain write-protected", write.status === 403, write);

  const verifier = await request(baseUrl, "/bench/run-verifier", token, { attemptId });
  check(
    "verifier still reads case-meta.json from disk",
    verifier.status === 200 && verifier.data.passed === true,
    verifier.data
  );

  const artifact = await request(baseUrl, "/bench/artifact", token, {
    attemptId,
    path: "verifier-result.json",
  });
  check(
    "app-facing artifact endpoint still serves the verifier result",
    artifact.status === 200 && String(artifact.data.content).includes("meta readable from disk"),
    artifact
  );

  await request(baseUrl, "/bench/cleanup", token, { attemptId });
} finally {
  await stop(child);
  await rm(root, { recursive: true, force: true }).catch(() => {});
}

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
