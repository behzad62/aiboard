import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import JSZip from "jszip";
import { createRecoverableJobServiceCase } from "../lib/benchmark/workbench/recoverable-job-service/case-pack";
import {
  PINNED_RJS_RUNNER_COMMIT,
  verifyPinnedRjsRunnerSource,
} from "./pinned-rjs-runner-source.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const scratch = await mkdtemp(join(tmpdir(), "aiboard-rjs-bundle-"));
const outputA = join(scratch, "first");
const outputB = join(scratch, "second");
const archiveName = "aiboard-rjs-workbench-runner.zip";
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

interface TestJson {
  ok?: boolean;
  runnerV2?: { ready?: boolean };
  rjs?: { ready?: boolean; nodeVersion?: string; quickjsVersion?: string };
  nodeVersion?: string;
  root?: string;
  url?: string;
  token?: string;
  passed?: boolean;
  score?: number;
  exitCode?: number;
  resultJson?: string;
}

function runPublisher(output: string) {
  execFileSync(process.execPath, [
    "scripts/publish-downloads.mjs", "--only", "rjs-workbench", "--output-dir", output,
  ], { cwd: root, stdio: "pipe" });
}

function runNpm(args: string[], cwd: string) {
  if (process.platform === "win32") {
    execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `npm ${args.join(" ")}`], { cwd, stdio: "pipe" });
  } else {
    execFileSync("npm", args, { cwd, stdio: "pipe" });
  }
}

function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (process.platform === "win32" && child.pid && child.exitCode === null) {
    return new Promise((resolveStop, rejectStop) => {
      const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"],
        { windowsHide: true, stdio: "ignore" });
      killer.once("error", rejectStop);
      killer.once("close", () => resolveStop());
    });
  }
  return new Promise((resolveStop) => {
    if (child.exitCode !== null) return resolveStop();
    child.once("exit", () => resolveStop());
    child.kill();
    setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 2_000).unref();
  });
}

async function request(baseUrl: string, token: string, pathname: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-runner-token": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() as TestJson };
}

try {
  const existingDownloads = ["aiboard-runner-v2.zip", "aiboard-workbench-runner.zip"];
  const before = new Map<string, string | null>();
  for (const name of existingDownloads) {
    const bytes = await readFile(join(root, "public", name)).catch(() => null);
    before.set(name, bytes ? sha256(bytes) : null);
  }
  runPublisher(outputA);
  runPublisher(outputB);
  const bytesA = await readFile(join(outputA, archiveName));
  const bytesB = await readFile(join(outputB, archiveName));
  assert.equal(sha256(bytesA), sha256(bytesB), "dedicated publication is deterministic");
  for (const name of existingDownloads) {
    const bytes = await readFile(join(root, "public", name)).catch(() => null);
    assert.equal(bytes ? sha256(bytes) : null, before.get(name), `${name} remains unchanged`);
  }

  const zip = await JSZip.loadAsync(bytesA);
  const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir).sort();
  const manifest = JSON.parse(await zip.file("bundle-manifest.json")!.async("string"));
  assert.deepEqual(names, [...manifest.archiveAllowlist, "bundle-manifest.json"].sort());
  assert.equal(manifest.acceptedRunnerCommit, PINNED_RJS_RUNNER_COMMIT);

  const runnerRecords = verifyPinnedRjsRunnerSource(root);
  assert.deepEqual(manifest.runner, runnerRecords.map((record) => ({
    archivePath: record.path,
    objectId: record.objectId,
    mode: record.mode,
  })));
  for (const record of runnerRecords) {
    const archived = await zip.file(record.path)!.async("nodebuffer");
    const pinned = execFileSync("git", ["-C", root, "cat-file", "blob", record.objectId]);
    assert.deepEqual(archived, pinned, record.path);
  }

  const identity = await import(pathToFileURL(join(root, "benchmarks", "recoverable-job-service", "private", "identity.mjs")).href);
  const hashes = await identity.scoreInputHashes();
  assert.equal(manifest.recoverableJobService.contractHash, hashes.contractHash);
  assert.equal(manifest.recoverableJobService.suiteHash, hashes.suiteHash);
  assert.deepEqual(manifest.recoverableJobService.contractPaths, identity.contractPaths);
  assert.deepEqual(manifest.recoverableJobService.suitePaths, identity.suitePaths);
  for (const relativePath of [...identity.contractPaths, ...identity.suitePaths]) {
    const archivePath = `benchmarks/recoverable-job-service/${relativePath}`;
    assert.deepEqual(
      await zip.file(archivePath)!.async("nodebuffer"),
      await readFile(join(root, "benchmarks", "recoverable-job-service", relativePath)),
      archivePath
    );
  }

  const packageJson = JSON.parse(await zip.file("package.json")!.async("string"));
  assert.deepEqual(packageJson.engines, { node: "24.18.0" });
  assert.deepEqual(packageJson.dependencies, {
    playwright: "1.61.1",
    "quickjs-emscripten": "0.32.0",
    tsx: "4.22.5",
    typescript: "6.0.3",
  });
  const lockBytes = await zip.file("package-lock.json")!.async("nodebuffer");
  assert.equal(manifest.packageLockHash, sha256(lockBytes));
  const lock = JSON.parse(lockBytes.toString("utf8"));
  const provenance = JSON.parse(await readFile(join(root, "benchmarks", "recoverable-job-service", "private", "dependency-provenance.json"), "utf8"));
  for (const [packagePath, expected] of Object.entries(
    provenance.packages as Record<string, { version: string; integrity: string }>
  )) {
    assert.equal(lock.packages[packagePath]?.version, expected.version, packagePath);
    assert.equal(lock.packages[packagePath]?.integrity, expected.integrity, packagePath);
  }

  if (process.version === "v24.18.0") {
    const extraction = join(scratch, "extracted package ü with spaces");
    for (const [archivePath, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      const destination = join(extraction, ...archivePath.split("/"));
      await mkdir(resolve(destination, ".."), { recursive: true });
      await writeFile(destination, await entry.async("nodebuffer"));
    }
    const extractedLock = join(extraction, "package-lock.json");
    const extractedLockBefore = sha256(await readFile(extractedLock));
    runNpm(["ci"], extraction);
    assert.equal(sha256(await readFile(extractedLock)), extractedLockBefore, "npm ci leaves the dedicated lock unchanged");
    runNpm(["run", "setup:browser"], extraction);

    const port = 24_000 + Math.floor(Math.random() * 4_000);
    const token = `rjs-extracted-${Date.now()}`;
    const baseUrl = `http://127.0.0.1:${port}`;
    const bench = spawn(process.execPath, [
      "scripts/bench-runner.mjs", "--port", String(port), "--token", token,
      "--root", join(extraction, "test-runs"),
    ], { cwd: extraction, stdio: ["ignore", "pipe", "pipe"] });
    try {
      let health: TestJson | null = null;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        const response = await request(baseUrl, token, "/bench/health");
        if (response.status === 200) { health = response.data; break; }
      } catch {}
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    assert.equal(health?.ok, true);
    assert.equal(health?.runnerV2?.ready, true);
    assert.equal(health?.rjs?.ready, true);
    assert.equal(health?.rjs?.nodeVersion, "24.18.0");
    assert.equal(health?.rjs?.quickjsVersion, "0.32.0");

    const benchmarkCase = createRecoverableJobServiceCase();
    const prepared = await request(baseUrl, token, "/bench/prepare", {
      attemptId: "extracted_rjs_health",
      caseId: benchmarkCase.id,
      repoUrl: benchmarkCase.repo.url,
      baseCommit: benchmarkCase.repo.baseCommit,
      network: benchmarkCase.environment.network,
      timeoutSeconds: benchmarkCase.environment.timeoutSeconds,
      verifierCommand: benchmarkCase.verifier.command,
      verifierResultFile: benchmarkCase.verifier.resultFile,
      allowedCommands: benchmarkCase.allowedCommands,
      files: benchmarkCase.fixtureFiles,
      trustedPolicy: benchmarkCase.trustedPolicy,
    });
    assert.equal(prepared.status, 200, JSON.stringify(prepared.data));
    const started = await request(baseUrl, token, "/bench/attempt-runner/start", { attemptId: "extracted_rjs_health" });
    if (process.platform === "win32") {
      assert.equal(started.status, 200, JSON.stringify(started.data));
      assert.equal(started.data.nodeVersion, "24.18.0");
      const childHealthResponse = await fetch(`${started.data.url}/v2/health`, {
        headers: { authorization: `Bearer ${started.data.token}` },
      });
      const childHealth = await childHealthResponse.json() as TestJson & {
        protocolVersion?: number;
        projectPath?: string;
      };
      assert.equal(childHealthResponse.status, 200);
      assert.equal(childHealth.ok, true);
      assert.equal(childHealth.protocolVersion, 2);
      assert.equal(childHealth.projectPath, prepared.data.root);
      assert.equal(childHealth.nodeVersion, "24.18.0");
      assert.equal((await request(baseUrl, token, "/bench/attempt-runner/stop", { attemptId: "extracted_rjs_health" })).status, 200);
    } else {
      assert.equal(started.status, 503, JSON.stringify(started.data));
      assert.match(String(started.data.error), /requires Windows/);
      assert.equal((health?.rjs as TestJson)?.managedBuildSupported, false);
    }
    const evaluated = await request(baseUrl, token, "/bench/run-verifier", {
      attemptId: "extracted_rjs_health",
    });
    assert.equal(evaluated.status, 200, JSON.stringify(evaluated.data));
    assert.equal(evaluated.data.passed, false, "the provided incomplete candidate is scored as a model failure");
    assert.equal(evaluated.data.score, 0);
    assert.equal(evaluated.data.exitCode, 1);
    const evaluatorResult = JSON.parse(evaluated.data.resultJson);
    assert.equal(evaluatorResult.passed, false);
    assert.equal(evaluatorResult.score, 0);
    assert.equal(evaluatorResult.recoverableJobService.status, "valid");
    assert.equal(evaluatorResult.recoverableJobService.resolved, false);
    assert.equal(evaluatorResult.recoverableJobService.families.length, 69);
    assert.equal(evaluatorResult.recoverableJobService.provenance.variantIds.length, 302);
    assert.equal(evaluatorResult.recoverableJobService.contractHash, hashes.contractHash);
    assert.equal(evaluatorResult.recoverableJobService.suiteHash, hashes.suiteHash);
    assert.equal((await request(baseUrl, token, "/bench/cleanup", { attemptId: "extracted_rjs_health" })).status, 200);
    } catch (error) {
      console.error("Extracted package execution failed:", error);
      throw error;
    } finally {
      await request(baseUrl, token, "/bench/attempt-runner/stop", { attemptId: "extracted_rjs_health" }).catch(() => {});
      await stop(bench);
    }
  } else {
    console.log(`SKIP exact-runtime extracted execution under ${process.version}; CI proves it on Node 24.18.0`);
  }

  for (const forbidden of ["reference.js", "qualification-results.json", "/private/controls.mjs", "node_modules/"]) {
    assert.equal(names.some((name) => name.includes(forbidden)), false, forbidden);
  }
  assert.equal(names.some((name) => name.startsWith("runner-v2/bin/")), false);

  const fixtureSource = join(scratch, "fixture-source");
  const fixtureOrigin = join(scratch, "fixture-origin.git");
  const shallowClone = join(scratch, "fixture-shallow");
  execFileSync("git", ["clone", "--depth=1", "--no-tags", pathToFileURL(root).href, fixtureSource], { stdio: "pipe" });
  // A CI checkout stores the pin outside branch history. Seed the fixture origin
  // explicitly instead of relying on a developer clone's incidental full history.
  execFileSync("git", ["-C", fixtureSource, "fetch", "--depth=1", "origin",
    `${PINNED_RJS_RUNNER_COMMIT}:refs/heads/fixture-pinned-runner`], { stdio: "pipe" });
  execFileSync("git", ["-C", fixtureSource, "checkout", "-b", "fixture-head"], { stdio: "pipe" });
  for (const relativePath of [
    "scripts/publish-downloads.mjs",
    "scripts/pinned-rjs-runner-source.mjs",
    "scripts/bench-runner.mjs",
    "benchmarks/recoverable-job-service/bundle/package.json",
    "benchmarks/recoverable-job-service/bundle/package-lock.json",
  ]) {
    const destination = join(fixtureSource, relativePath);
    await mkdir(resolve(destination, ".."), { recursive: true });
    await copyFile(join(root, relativePath), destination);
  }
  execFileSync("git", ["-C", fixtureSource, "add", "--all"], { stdio: "pipe" });
  // The fixture needs a descendant commit even when the source checkout is clean.
  execFileSync("git", ["-C", fixtureSource, "-c", "user.name=RJS Test", "-c", "user.email=rjs@test.invalid", "commit", "--allow-empty", "-m", "fixture descendant"], { stdio: "pipe" });
  execFileSync("git", ["clone", "--bare", fixtureSource, fixtureOrigin], { stdio: "pipe" });
  const originUrl = pathToFileURL(fixtureOrigin).href;
  execFileSync("git", ["clone", "--depth=1", "--branch", "fixture-head", originUrl, shallowClone], { stdio: "pipe" });
  assert.notEqual(
    spawnSync("git", ["-C", shallowClone, "cat-file", "-e", `${PINNED_RJS_RUNNER_COMMIT}^{commit}`]).status,
    0,
    "the accepted commit starts absent from the depth-one clone"
  );
  await symlink(join(root, "node_modules"), join(shallowClone, "node_modules"), "junction");
  const isolatedOutput = join(scratch, "shallow-output");
  const publisherBeforeAcquire = spawnSync(process.execPath, [
    "scripts/publish-downloads.mjs", "--only", "rjs-workbench", "--output-dir", isolatedOutput,
  ], { cwd: shallowClone, encoding: "utf8" });
  assert.notEqual(publisherBeforeAcquire.status, 0, "publisher never fetches a missing pin");

  const helperArgs = [
    "scripts/pinned-rjs-runner-source.mjs", "--acquire", "--remote", "origin",
    "--allow-local-origin", "--expected-origin", originUrl,
  ];
  const refsBefore = execFileSync("git", ["-C", shallowClone, "for-each-ref", "--format=%(refname):%(objectname)"], { encoding: "utf8" });
  for (const ciEnvironment of [{ CI: "true", GITHUB_ACTIONS: "" }, { CI: "", GITHUB_ACTIONS: "1" }]) {
    const refused = spawnSync(process.execPath, helperArgs, {
      cwd: shallowClone,
      encoding: "utf8",
      env: { ...process.env, ...ciEnvironment },
    });
    assert.notEqual(refused.status, 0, "local-origin flags are refused in CI");
    assert.equal(
      execFileSync("git", ["-C", shallowClone, "for-each-ref", "--format=%(refname):%(objectname)"], { encoding: "utf8" }),
      refsBefore,
      "CI refusal does not mutate refs"
    );
  }
  const localEnvironment = { ...process.env };
  delete localEnvironment.CI;
  delete localEnvironment.GITHUB_ACTIONS;
  execFileSync(process.execPath, helperArgs, { cwd: shallowClone, env: localEnvironment, stdio: "pipe" });
  assert.equal(
    execFileSync("git", ["-C", shallowClone, "rev-parse", `${PINNED_RJS_RUNNER_COMMIT}^{commit}`], { encoding: "utf8" }).trim(),
    PINNED_RJS_RUNNER_COMMIT
  );
  const mismatch = spawnSync(process.execPath, [
    ...helperArgs.slice(0, -1), pathToFileURL(join(scratch, "different-origin.git")).href,
  ], { cwd: shallowClone, env: localEnvironment, encoding: "utf8" });
  assert.notEqual(mismatch.status, 0, "origin mismatch is rejected even when the pin is present");
  execFileSync(process.execPath, [
    "scripts/publish-downloads.mjs", "--only", "rjs-workbench", "--output-dir", isolatedOutput,
  ], { cwd: shallowClone, stdio: "pipe" });
  const shallowArchive = await JSZip.loadAsync(await readFile(join(isolatedOutput, archiveName)));
  for (const record of manifest.runner) {
    assert.deepEqual(
      await shallowArchive.file(record.archivePath)!.async("nodebuffer"),
      execFileSync("git", ["-C", shallowClone, "cat-file", "blob", record.objectId]),
      `shallow acquisition ${record.archivePath}`
    );
  }

  const invalidSelector = spawnSync(process.execPath, [
    "scripts/publish-downloads.mjs", "--only", "unknown", "--output-dir", join(scratch, "invalid"),
  ], { cwd: root, encoding: "utf8" });
  assert.notEqual(invalidSelector.status, 0);
  const missingOutput = spawnSync(process.execPath, [
    "scripts/publish-downloads.mjs", "--only", "rjs-workbench",
  ], { cwd: root, encoding: "utf8" });
  assert.notEqual(missingOutput.status, 0);
  const duplicateSelector = spawnSync(process.execPath, [
    "scripts/publish-downloads.mjs", "--only", "rjs-workbench", "--only", "rjs-workbench", "--output-dir", join(scratch, "duplicate"),
  ], { cwd: root, encoding: "utf8" });
  assert.notEqual(duplicateSelector.status, 0);
} catch (error) {
  console.error("Bundle qualification failed:", error);
  throw error;
} finally {
  await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

console.log("PASS");
