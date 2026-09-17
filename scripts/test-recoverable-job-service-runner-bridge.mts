import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRecoverableJobServiceCase } from "../lib/benchmark/workbench/recoverable-job-service/case-pack";
import {
  RECOVERABLE_JOB_SERVICE_INPUT_HASHES,
  RECOVERABLE_JOB_SERVICE_METADATA,
} from "../lib/benchmark/workbench/recoverable-job-service/fixture";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const scratch = await mkdtemp(join(tmpdir(), "aiboard-rjs-bridge-"));
const runsRoot = join(scratch, "runs");
const port = 21_000 + Math.floor(Math.random() * 8_000);
const token = `rjs-bridge-${Date.now()}`;
const baseUrl = `http://127.0.0.1:${port}`;

interface BridgeResponseData {
  error?: unknown;
  rjs?: unknown;
  attemptId?: unknown;
  files?: string[];
  content?: unknown;
  passed?: boolean;
  resultJson?: unknown;
  stdoutPreview?: unknown;
}

async function request(path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "x-runner-token": token,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    data: (await response.json().catch(() => ({}))) as BridgeResponseData,
  };
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await request("/bench/health");
      if (response.status === 200) return response.data;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("Bench Runner did not become ready");
}

function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolveStop) => {
    if (child.exitCode !== null) return resolveStop();
    child.once("exit", () => resolveStop());
    child.kill();
    setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 1_000).unref();
  });
}

const child = spawn(process.execPath, [
  join(repoRoot, "scripts", "bench-runner.mjs"),
  "--port", String(port),
  "--token", token,
  "--root", runsRoot,
], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });

try {
  const health = await waitForHealth();
  assert.deepEqual(health.rjs, {
    ready: true,
    nodeVersion: "24.18.0",
    quickjsVersion: "0.32.0",
    contractHash: RECOVERABLE_JOB_SERVICE_INPUT_HASHES.contractHash,
    suiteHash: RECOVERABLE_JOB_SERVICE_INPUT_HASHES.suiteHash,
    profile: RECOVERABLE_JOB_SERVICE_METADATA.profile,
  });

  const workBenchCase = createRecoverableJobServiceCase();
  const mismatchedMetadata = JSON.stringify({
    ...JSON.parse(String(workBenchCase.fixtureFiles?.["case-meta.json"])),
    profile: "wrong-profile",
  });
  const profileMismatch = await request("/bench/prepare", {
    attemptId: "rjs_profile_mismatch",
    caseId: workBenchCase.id,
    repoUrl: workBenchCase.repo.url,
    network: workBenchCase.environment.network,
    verifierCommand: workBenchCase.verifier.command,
    verifierResultFile: workBenchCase.verifier.resultFile,
    allowedCommands: workBenchCase.allowedCommands,
    files: { ...workBenchCase.fixtureFiles, "case-meta.json": mismatchedMetadata },
    trustedPolicy: workBenchCase.trustedPolicy,
  });
  assert.equal(profileMismatch.status, 409);
  assert.match(String(profileMismatch.data.error), /profile/i);

  const prepared = await request("/bench/prepare", {
    attemptId: "rjs_bridge_attempt",
    caseId: workBenchCase.id,
    repoUrl: workBenchCase.repo.url,
    baseCommit: workBenchCase.repo.baseCommit,
    network: workBenchCase.environment.network,
    timeoutSeconds: workBenchCase.environment.timeoutSeconds,
    verifierCommand: workBenchCase.verifier.command,
    verifierResultFile: workBenchCase.verifier.resultFile,
    allowedCommands: workBenchCase.allowedCommands,
    files: workBenchCase.fixtureFiles,
    trustedPolicy: workBenchCase.trustedPolicy,
  });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.data));
  const attemptId = String(prepared.data.attemptId);

  const tree = await request("/bench/read-tree", { attemptId });
  assert.equal(tree.status, 200);
  assert.deepEqual(
    [...tree.data.files].sort(),
    [
      "acceptance-contract.md",
      "contract.d.ts",
      "examples.mjs",
      "families.json",
      "problem.md",
      "public-test.mjs",
      "runtime-contract.md",
      "service.js",
      "source-bootstrap.md",
      "source-examples.mjs",
      "source-variants.json",
    ].sort(),
    "only the eleven canonical model files are readable"
  );

  const publicWrapper = await request("/bench/read-file", { attemptId, path: "public-test.mjs" });
  assert.equal(publicWrapper.status, 200);
  assert.doesNotMatch(String(publicWrapper.data.content), /__RJS_TRUSTED_RUNTIME_URL__/);
  assert.match(String(publicWrapper.data.content), /from\s+["']file:/);

  const hiddenVerifier = await request("/bench/read-file", { attemptId, path: "verify.mjs" });
  assert.equal(hiddenVerifier.status, 404);
  const verifierArtifact = await request("/bench/artifact", { attemptId, path: "verify.mjs" });
  assert.equal(verifierArtifact.status, 500, "hidden verifier is not exposed as an artifact");
  const metaFiles = await readdir(join(runsRoot, ".attempt-meta"));
  assert.equal(metaFiles.length, 1);
  const attemptMeta = JSON.parse(
    await readFile(join(runsRoot, ".attempt-meta", metaFiles[0]), "utf8")
  ) as { hiddenFiles: Record<string, string> };
  assert.doesNotMatch(attemptMeta.hiddenFiles["verify.mjs"], /__RJS_TRUSTED_RUNTIME_URL__/);
  assert.match(attemptMeta.hiddenFiles["verify.mjs"], /workbench-rjs-verifier-adapter\.mjs/);

  const writeService = await request("/bench/write-file", {
    attemptId,
    path: "service.js",
    content: String(workBenchCase.fixtureFiles?.["service.js"]),
  });
  assert.equal(writeService.status, 200);
  const writeExtra = await request("/bench/write-file", {
    attemptId,
    path: "notes.txt",
    content: "candidate-created file",
  });
  assert.equal(writeExtra.status, 403);

  const supportPath = join(repoRoot, "scripts", "workbench-rjs-support.mjs");
  const adapterPath = join(repoRoot, "scripts", "workbench-rjs-verifier-adapter.mjs");
  assert.equal(existsSync(supportPath), true);
  assert.equal(existsSync(adapterPath), true);
  const support = await import(pathToFileURL(supportPath).href);
  const tricky = "file:///D:/Bench%20O'Brien/%E8%A9%95%E4%BE%A1/runtime.mjs";
  const specialized = support.specializeTrustedModule(
    "import x from '__RJS_TRUSTED_RUNTIME_URL__';",
    tricky
  );
  assert.equal(specialized, `import x from ${JSON.stringify(tricky)};`);

  const adapter = await import(pathToFileURL(adapterPath).href);
  const replayFile = join(runsRoot, ".trusted-rjs-replay", "direct-test.json");
  await adapter.prepareReplayState(replayFile, {
    contractHash: RECOVERABLE_JOB_SERVICE_INPUT_HASHES.contractHash,
    suiteHash: RECOVERABLE_JOB_SERVICE_INPUT_HASHES.suiteHash,
  });
  const initialBytes = await readFile(replayFile, "utf8");
  await adapter.prepareReplayState(replayFile, {
    contractHash: RECOVERABLE_JOB_SERVICE_INPUT_HASHES.contractHash,
    suiteHash: RECOVERABLE_JOB_SERVICE_INPUT_HASHES.suiteHash,
  });
  assert.equal(await readFile(replayFile, "utf8"), initialBytes, "fresh processes reuse the input");
  assert.doesNotMatch(initialBytes, /executedInputs/);

  await writeFile(replayFile, '{"schemaVersion":0}', "utf8");
  assert.throws(
    () => adapter.prepareReplayState(replayFile, {
      contractHash: RECOVERABLE_JOB_SERVICE_INPUT_HASHES.contractHash,
      suiteHash: RECOVERABLE_JOB_SERVICE_INPUT_HASHES.suiteHash,
    }),
    /identity is invalid or mismatched/i,
    "corrupt private state is rejected rather than silently replaced"
  );
  assert.equal(
    await readFile(replayFile, "utf8"),
    '{"schemaVersion":0}',
    "a rejected private state remains available for diagnosis"
  );

  const privateFiles = await readdir(join(runsRoot, ".trusted-rjs-replay"));
  assert.equal(privateFiles.includes("direct-test.json"), true);
  assert.equal(tree.data.files.some((name: string) => name.includes("replay")), false);

  const largeAttemptId = "large_result_attempt";
  const largePrepared = await request("/bench/prepare", {
    attemptId: largeAttemptId,
    caseId: "large-result-case",
    repoUrl: "fixture://inline",
    network: "dependency-only",
    verifierCommand: "node large-verifier.mjs",
    verifierResultFile: "verifier-result.json",
    allowedCommands: ["node large-verifier.mjs"],
    files: {
      "large-verifier.mjs": [
        "import { writeFile } from 'node:fs/promises';",
        "const result = {passed:true,score:1,assertions:[{passed:true}],payload:'x'.repeat(3*1024*1024)};",
        "await writeFile('verifier-result.json', JSON.stringify(result));",
        "console.log('complete result written');",
      ].join("\n"),
    },
  });
  assert.equal(largePrepared.status, 200);
  const largeResult = await request("/bench/run-verifier", { attemptId: largeAttemptId });
  assert.equal(largeResult.status, 200, JSON.stringify(largeResult.data));
  assert.equal(largeResult.data.passed, true);
  assert.ok(
    String(largeResult.data.resultJson).length > 3 * 1024 * 1024,
    "the dedicated result channel carries payloads larger than stdout preview capacity"
  );
  assert.match(String(largeResult.data.stdoutPreview), /complete result written/);
  await request("/bench/cleanup", { attemptId: largeAttemptId });

  const abortAttemptId = "abort_join_attempt";
  const abortPrepared = await request("/bench/prepare", {
    attemptId: abortAttemptId,
    caseId: "abort-join-case",
    repoUrl: "fixture://inline",
    network: "dependency-only",
    verifierCommand: "node slow-verifier.mjs",
    verifierResultFile: "verifier-result.json",
    allowedCommands: ["node slow-verifier.mjs"],
    files: {
      "slow-verifier.mjs": [
        "import { writeFile } from 'node:fs/promises';",
        "await new Promise(resolve => setTimeout(resolve, 1500));",
        "await writeFile('completed.txt', 'late verifier completion');",
        "await writeFile('verifier-result.json', JSON.stringify({passed:true,score:1,assertions:[{passed:true}]}));",
      ].join("\n"),
    },
  });
  assert.equal(abortPrepared.status, 200);
  const abortController = new AbortController();
  const abortedVerifier = fetch(`${baseUrl}/bench/run-verifier`, {
    method: "POST",
    headers: {
      "x-runner-token": token,
      "content-type": "application/json",
    },
    body: JSON.stringify({ attemptId: abortAttemptId }),
    signal: abortController.signal,
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  abortController.abort();
  await assert.rejects(abortedVerifier, /abort/i);
  await new Promise((resolveWait) => setTimeout(resolveWait, 1700));
  const lateCompletion = await request("/bench/artifact", {
    attemptId: abortAttemptId,
    path: "completed.txt",
  });
  assert.equal(lateCompletion.status, 500, "an aborted verifier child cannot complete later");
  await request("/bench/cleanup", { attemptId: abortAttemptId });

  await request("/bench/cleanup", { attemptId });
} finally {
  await stop(child);
  await rm(scratch, { recursive: true, force: true });
}

console.log("PASS");
