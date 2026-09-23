import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises";
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
  code?: unknown;
  disposition?: unknown;
  rjs?: unknown;
  attemptId?: unknown;
  root?: unknown;
  files?: string[];
  content?: unknown;
  passed?: boolean;
  resultJson?: unknown;
  stdoutPreview?: unknown;
}

interface AttemptMetadata {
  hiddenFiles: Record<string, string>;
  rjsOracleLifecycle?: { state: string };
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

async function metaPathFor(attemptId: string): Promise<string> {
  const directory = join(runsRoot, ".attempt-meta");
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const value = JSON.parse(await readFile(path, "utf8"));
    if (value.attemptId === attemptId) return path;
  }
  throw new Error(`missing attempt metadata for ${attemptId}`);
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
    managedBuildSupported: process.platform === "win32",
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
  ) as { hiddenFiles: Record<string, string>; snapshot: Record<string, string> };
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

  const attemptRoot = String(prepared.data.root);
  await writeFile(join(attemptRoot, "unexpected.txt"), "outside the submitted allowlist", "utf8");
  const extraEntryFailure = await request("/bench/run-verifier", { attemptId });
  assert.deepEqual(
    {
      status: extraEntryFailure.status,
      code: extraEntryFailure.data.code,
      disposition: extraEntryFailure.data.disposition,
    },
    {
      status: 422,
      code: "rjs_submission_policy_violation",
      disposition: "candidate_tool_failure",
    },
    "an out-of-band extra entry is rejected before evaluator execution"
  );
  assert.equal(existsSync(join(attemptRoot, "verifier-result.json")), false);
  await rm(join(attemptRoot, "unexpected.txt"));

  await writeFile(join(attemptRoot, ".bench-run.json"), "candidate-created legacy metadata", "utf8");
  const legacyMetadataFailure = await request("/bench/run-verifier", { attemptId });
  assert.deepEqual(
    {
      status: legacyMetadataFailure.status,
      code: legacyMetadataFailure.data.code,
      disposition: legacyMetadataFailure.data.disposition,
    },
    {
      status: 422,
      code: "rjs_submission_policy_violation",
      disposition: "candidate_tool_failure",
    },
    "an out-of-band root .bench-run.json cannot bypass the final allowlist"
  );
  assert.equal(existsSync(join(attemptRoot, "verifier-result.json")), false);
  await rm(join(attemptRoot, ".bench-run.json"));

  await rename(join(attemptRoot, ".git"), join(attemptRoot, ".git-real"));
  await writeFile(join(attemptRoot, ".git"), "candidate-created fake repository metadata", "utf8");
  const fakeGitFailure = await request("/bench/run-verifier", { attemptId });
  assert.equal(fakeGitFailure.status, 422);
  assert.equal(fakeGitFailure.data.code, "rjs_submission_policy_violation");
  assert.equal(existsSync(join(attemptRoot, "verifier-result.json")), false);
  await rm(join(attemptRoot, ".git"));
  await rename(join(attemptRoot, ".git-real"), join(attemptRoot, ".git"));

  await writeFile(join(attemptRoot, "verify.mjs"), "tampered hidden verifier", "utf8");
  const restoredMutationFailure = await request("/bench/run-verifier", { attemptId });
  assert.deepEqual(
    {
      status: restoredMutationFailure.status,
      code: restoredMutationFailure.data.code,
      disposition: restoredMutationFailure.data.disposition,
    },
    {
      status: 422,
      code: "rjs_submission_policy_violation",
      disposition: "candidate_tool_failure",
    },
    "a protected file changed after restoration is rejected without silent repair"
  );
  assert.equal(await readFile(join(attemptRoot, "verify.mjs"), "utf8"), "tampered hidden verifier");
  assert.equal(existsSync(join(attemptRoot, "verifier-result.json")), false);

  await rm(join(attemptRoot, "verify.mjs"));
  const deletedHiddenFailure = await request("/bench/run-verifier", { attemptId });
  assert.equal(deletedHiddenFailure.data.code, "rjs_submission_policy_violation");
  assert.equal(existsSync(join(attemptRoot, "verify.mjs")), false, "restored deletion is not repaired");

  await writeFile(join(attemptRoot, "verify.mjs"), attemptMeta.hiddenFiles["verify.mjs"], "utf8");
  await mkdir(join(attemptRoot, "unexpected-directory"));
  const extraDirectoryFailure = await request("/bench/run-verifier", { attemptId });
  assert.equal(extraDirectoryFailure.data.code, "rjs_submission_policy_violation");
  await rmdir(join(attemptRoot, "unexpected-directory"));

  await rm(join(attemptRoot, "problem.md"));
  const deletedPublicFailure = await request("/bench/run-verifier", { attemptId });
  assert.equal(deletedPublicFailure.data.code, "rjs_submission_policy_violation");
  await writeFile(join(attemptRoot, "problem.md"), attemptMeta.snapshot["problem.md"], "utf8");

  const sentinel = join(scratch, "symlink-sentinel.txt");
  await writeFile(sentinel, "sentinel remains unchanged", "utf8");
  await rm(join(attemptRoot, "verify.mjs"));
  try {
    await symlink(sentinel, join(attemptRoot, "verify.mjs"), "file");
    const symlinkFailure = await request("/bench/run-verifier", { attemptId });
    assert.equal(symlinkFailure.data.code, "rjs_submission_policy_violation");
    assert.equal(await readFile(sentinel, "utf8"), "sentinel remains unchanged");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  } finally {
    await rm(join(attemptRoot, "verify.mjs"), { force: true });
    await writeFile(join(attemptRoot, "verify.mjs"), attemptMeta.hiddenFiles["verify.mjs"], "utf8");
  }

  for (const typed of [
    {
      attemptId: "rjs_snapshot_invalid",
      code: "rjs_submission_snapshot_invalid",
      disposition: "invalid_harness",
      mutate(meta: AttemptMetadata) { delete meta.hiddenFiles["verify.mjs"]; },
    },
    {
      attemptId: "rjs_restoration_incomplete",
      code: "rjs_submission_io_failed",
      disposition: "invalid_environment",
      mutate(meta: AttemptMetadata) { meta.rjsOracleLifecycle = { state: "restoring" }; },
    },
  ]) {
    const typedPrepared = await request("/bench/prepare", {
      attemptId: typed.attemptId,
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
    assert.equal(typedPrepared.status, 200);
    const metadataPath = await metaPathFor(typed.attemptId);
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    typed.mutate(metadata);
    await writeFile(metadataPath, JSON.stringify(metadata), "utf8");
    const failure = await request("/bench/run-verifier", { attemptId: typed.attemptId });
    assert.deepEqual(
      { status: failure.status, code: failure.data.code, disposition: failure.data.disposition },
      { status: 500, code: typed.code, disposition: typed.disposition }
    );
    assert.doesNotMatch(String(failure.data.error), /verify\.mjs|case-meta\.json|replay/i);
    await request("/bench/cleanup", { attemptId: typed.attemptId });
  }

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
        "await writeFile('started.txt', 'verifier running');",
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
  let verifierStarted = false;
  for (let poll = 0; poll < 100; poll++) {
    const started = await request("/bench/artifact", { attemptId: abortAttemptId, path: "started.txt" });
    if (started.status === 200) { verifierStarted = true; break; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  assert.equal(verifierStarted, true, "abort test must reach a running verifier");
  abortController.abort();
  await assert.rejects(abortedVerifier, /abort/i);
  await new Promise((resolveWait) => setTimeout(resolveWait, 1700));
  const lateCompletion = await request("/bench/artifact", {
    attemptId: abortAttemptId,
    path: "completed.txt",
  });
  assert.equal(lateCompletion.status, 500, "an aborted verifier child cannot complete later");
  await request("/bench/cleanup", { attemptId: abortAttemptId });

  const queuedAttemptId = "queued_abort_attempt";
  const queuedPrepared = await request("/bench/prepare", {
    attemptId: queuedAttemptId,
    caseId: "queued-abort-case",
    repoUrl: "fixture://inline",
    network: "dependency-only",
    verifierCommand: "node queued-verifier.mjs",
    verifierResultFile: "verifier-result.json",
    allowedCommands: ["node queued-verifier.mjs"],
    files: {
      "queued-verifier.mjs": [
        "import { readFile, writeFile } from 'node:fs/promises';",
        "const count = Number(await readFile('queue-count.txt', 'utf8').catch(() => '0')) + 1;",
        "await writeFile('queue-count.txt', String(count));",
        "await new Promise(resolve => setTimeout(resolve, 800));",
        "await writeFile('verifier-result.json', JSON.stringify({passed:true,score:1,assertions:[{passed:true}],count}));",
      ].join("\n"),
    },
  });
  assert.equal(queuedPrepared.status, 200);
  const verifierRequest = (signal?: AbortSignal) => fetch(`${baseUrl}/bench/run-verifier`, {
    method: "POST",
    headers: { "x-runner-token": token, "content-type": "application/json" },
    body: JSON.stringify({ attemptId: queuedAttemptId }),
    signal,
  });
  const firstQueued = verifierRequest();
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  const queuedAbortController = new AbortController();
  const cancelledQueued = verifierRequest(queuedAbortController.signal);
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  queuedAbortController.abort();
  await assert.rejects(cancelledQueued, /abort/i);
  const thirdController = new AbortController();
  const thirdTimeout = setTimeout(() => thirdController.abort(), 3_000);
  const thirdQueued = verifierRequest(thirdController.signal);
  assert.equal((await firstQueued).status, 200);
  const thirdResponse = await thirdQueued.finally(() => clearTimeout(thirdTimeout));
  assert.equal(thirdResponse.status, 200, "cancelling a queued verifier must release its queue slot");
  await request("/bench/cleanup", { attemptId: queuedAttemptId });

  const replayIdentity = [
    attemptId,
    workBenchCase.id,
    RECOVERABLE_JOB_SERVICE_INPUT_HASHES.contractHash,
    RECOVERABLE_JOB_SERVICE_INPUT_HASHES.suiteHash,
  ].join("\0");
  const attemptReplayFile = join(
    runsRoot,
    ".trusted-rjs-replay",
    `${createHash("sha256").update(replayIdentity).digest("hex")}.json`
  );
  await writeFile(attemptReplayFile, '{"cleanup":"sentinel"}', "utf8");
  const cleaned = await request("/bench/cleanup", { attemptId });
  assert.equal(cleaned.status, 200);
  assert.equal(existsSync(attemptReplayFile), false, "cleanup removes per-attempt trusted replay state");
  const statusAfterCleanup = await request("/bench/attempt-runner/status", { attemptId });
  assert.equal(statusAfterCleanup.status, 404, "cleanup removes the managed-runner map entry");
} finally {
  await stop(child);
  await rm(scratch, { recursive: true, force: true });
}

console.log("PASS");
