#!/usr/bin/env node
import { exec, spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, lstat, open, writeFile, readdir, cp } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { specializeTrustedModule } from "./workbench-rjs-support.mjs";

const VERSION = 1;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_VERIFIER_RESULT_BYTES = 64 * 1024 * 1024;
const META_FILE = ".bench-run.json";
const DEFAULT_APP_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3001",
  "https://aiboard.me",
];

const options = parseArgs(process.argv.slice(2));
const host = optionValue(options.host) ?? "127.0.0.1";
const port = Number(optionValue(options.port) ?? 8797);
const token = optionValue(options.token) ?? process.env.AIBOARD_BENCH_TOKEN ?? randomBytes(18).toString("hex");
const root = resolve(optionValue(options.root) ?? join(process.cwd(), ".aiboard-bench", "runs"));
const fixtureRootOption = optionValue(options["fixture-root"]);
const fixtureRoot = fixtureRootOption ? resolve(fixtureRootOption) : null;
const runnerV2DirectoryOption = optionValue(options["runner-v2-dir"]);
const appOrigins = parseAppOrigins(optionValues(options["app-origin"]));
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const rjsAdapterPath = join(scriptDirectory, "workbench-rjs-verifier-adapter.mjs");
const rjsRuntimeRoot = resolve(scriptDirectory, "..", "benchmarks", "recoverable-job-service");
const rjsRuntimePath = join(rjsRuntimeRoot, "private", "runtime.mjs");
const rjsIdentityPath = join(rjsRuntimeRoot, "private", "identity.mjs");
const rjsEvaluatorPath = join(rjsRuntimeRoot, "private", "evaluator.mjs");
const rjsQuickJsPackagePath = resolve(
  scriptDirectory,
  "..",
  "node_modules",
  "quickjs-emscripten",
  "package.json"
);
const attemptMetaRoot = join(root, ".attempt-meta");
const runnerStateRoot = join(root, ".runner-v2-state");
const rjsReplayStateRoot = join(root, ".trusted-rjs-replay");
const managedAttemptRunners = new Map();
const activeVerifierRuns = new Map();
const runnerV2Discovery = discoverRunnerV2(runnerV2DirectoryOption);
const runnerV2Launcher = runnerV2Discovery?.ready ? runnerV2Discovery : null;

if (!isLoopbackHost(host)) {
  console.error("bench-runner refuses to bind non-loopback hosts.");
  process.exit(1);
}
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error("bench-runner --port must be a valid TCP port.");
  process.exit(1);
}

await mkdir(root, { recursive: true });
await mkdir(attemptMetaRoot, { recursive: true });
await mkdir(runnerStateRoot, { recursive: true });
await mkdir(rjsReplayStateRoot, { recursive: true });

const server = createServer(async (req, res) => {
  const requestAbort = new AbortController();
  const abortRequest = () => requestAbort.abort();
  req.once("aborted", abortRequest);
  res.once("close", () => {
    if (!res.writableEnded) abortRequest();
  });
  try {
    if (!req.url) throw new HttpError(400, "Missing request URL.");
    const url = new URL(req.url, `http://${host}:${port}`);
    if (!url.pathname.startsWith("/bench/")) {
      throw new HttpError(404, "Unknown bench endpoint.");
    }
    if (req.method === "OPTIONS") {
      sendNoContent(req, res, 204);
      return;
    }
    if (req.headers["x-runner-token"] !== token) {
      throw new HttpError(401, "Bench runner token required.");
    }
    if (req.method !== "GET" && req.method !== "POST") {
      throw new HttpError(405, "Bench runner only accepts GET, POST, and OPTIONS.");
    }

    const body = req.method === "GET" ? {} : await readJsonBody(req);
    const data = await route(url.pathname, body, requestAbort.signal);
    sendJson(req, res, 200, data);
  } catch (error) {
    if (requestAbort.signal.aborted && res.destroyed) return;
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : String(error);
    sendJson(req, res, status, {
      error: message,
      ...(error instanceof HttpError && error.code ? { code: error.code } : {}),
      ...(error instanceof HttpError && error.disposition ? { disposition: error.disposition } : {}),
    });
  }
});

server.listen(port, host, () => {
  console.log("AI Board - bench runner");
  console.log("-----------------------");
  console.log(`Version : v${VERSION}`);
  console.log(`URL     : http://${host}:${port}`);
  console.log(`Root    : ${root}`);
  console.log(`Token   : ${token}`);
  if (runnerV2Launcher) {
    console.log(`Managed Runner V2: ready (${runnerV2Launcher.source})`);
  } else {
    console.log("Managed Runner V2: unavailable");
    if (runnerV2Discovery?.error) {
      console.log(runnerV2Discovery.error);
    } else {
      console.log("Place aiboard-runner-v2 beside bench-runner.mjs, or provide its directory explicitly.");
      console.log("Setup command: node bench-runner.mjs --runner-v2-dir C:\\path\\to\\aiboard-runner-v2");
    }
  }
  console.log("");
  console.log("Paste the URL and token into Benchmark -> WorkBench.");
  console.log("Temporary attempt workspaces are created under Root and cleaned up after runs.");
  console.error(
    "bench-runner v0.1 isolation: commands run with FULL host privileges. " +
      "'network: dependency-only' is a label, not a boundary; " +
      "'memoryMb' requests are rejected. Run only trusted cases."
  );
});

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void Promise.all(
      [...managedAttemptRunners.values()].map((managed) => terminateChild(managed.child))
    ).finally(() => server.close(() => {
      process.exitCode = signal === "SIGINT" ? 130 : 0;
    }));
  });
}

async function route(pathname, body, signal) {
  const compat = parseCompatRoute(pathname);
  if (compat) return routeCompat(compat.attemptId, compat.endpoint, body, signal);

  switch (pathname) {
    case "/bench/health":
      return {
        ok: true,
        service: "aiboard-bench-runner",
        version: VERSION,
        host,
        port,
        root,
        mcp: false,
        rjs: await inspectRjsRuntime(),
        runnerV2: runnerV2Launcher
          ? { ready: true, source: runnerV2Launcher.source }
          : {
              ready: false,
              ...(runnerV2Discovery?.source ? { source: runnerV2Discovery.source } : {}),
              error: runnerV2Discovery?.error ??
                "Runner V2 was not found. Pass --runner-v2-dir or place aiboard-runner-v2 beside bench-runner.mjs.",
            },
      };
    case "/bench/prepare":
      return prepare(body);
    case "/bench/read-tree":
      return withAttempt(body, async ({ attemptRoot, meta }) => ({
        files: await listWorkspaceFiles(attemptRoot, meta),
      }));
    case "/bench/read-file":
      return withAttempt(body, async ({ attemptRoot, meta }) => {
        const relPath = requiredString(body, "path");
        assertModelReadableWorkspacePath(relPath, meta);
        const file = resolveSafePath(attemptRoot, relPath);
        const content = await readFile(file, "utf8");
        return { content, bytes: Buffer.byteLength(content) };
      });
    case "/bench/write-file":
      return withAttempt(body, async ({ attemptRoot, meta }) => {
        const relPath = requiredString(body, "path");
        assertWritableWorkspacePath(relPath, meta);
        const file = resolveSafePath(attemptRoot, relPath);
        const content = requiredString(body, "content");
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, content, "utf8");
        return { bytes: Buffer.byteLength(content) };
      });
    case "/bench/patch-file":
      return withAttempt(body, async ({ attemptRoot, meta }) => patchFile(attemptRoot, body, meta));
    case "/bench/run-command":
      return withAttempt(body, async ({ attemptRoot, meta }) => {
        const command = requiredString(body, "command");
        assertAllowedCommand(meta, command);
        return runCommand(command, attemptRoot, optionalTimeout(body), undefined, signal);
      });
    case "/bench/run-verifier":
      return withAttempt(body, async ({ attemptRoot, meta }) => runVerifier(attemptRoot, meta, body, signal));
    case "/bench/diff":
      return withAttempt(body, async ({ attemptRoot, meta }) => ({
        diff: await createDiff(attemptRoot, meta.snapshot ?? {}, meta),
      }));
    case "/bench/artifact":
      return withAttempt(body, async ({ attemptRoot }) => {
        const relPath = requiredString(body, "path");
        const file = resolveSafePath(attemptRoot, relPath);
        const content = await readFile(file, "utf8");
        return {
          path: relPath.replace(/\\/g, "/"),
          content,
          mimeType: mimeTypeForPath(relPath),
          bytes: Buffer.byteLength(content),
        };
      });
    case "/bench/cleanup":
      return cleanup(body);
    case "/bench/attempt-runner/start":
      return startAttemptRunner(body);
    case "/bench/attempt-runner/status":
      return statusAttemptRunner(body);
    case "/bench/attempt-runner/restore-oracle":
      return withAttempt(body, async ({ attemptRoot, meta }) => {
        const liveRunner = managedAttemptRunners.get(meta.attemptId);
        if (!liveRunner || liveRunner.child.exitCode !== null) {
          throw new HttpError(409, "Runner V2 must be running before oracle restoration.");
        }
        if (meta.trustedPolicy?.kind === "recoverable-job-service") {
          await inspectAndRestoreRjsOracle(attemptRoot, meta);
        } else {
          await restoreOracleFiles(attemptRoot, meta);
        }
        return { attemptId: meta.attemptId, restored: true };
      });
    case "/bench/attempt-runner/stop":
      return stopAttemptRunner(body);
    default:
      throw new HttpError(404, "Unknown bench endpoint.");
  }
}

async function routeCompat(attemptId, endpoint, body, signal) {
  const attemptRoot = attemptWorkspacePath(attemptId);
  const meta = await readMeta(attemptRoot);
  switch (endpoint) {
    case "/health":
      return {
        ok: true,
        service: "aiboard-bench-runner-compat",
        version: VERSION,
        dir: attemptRoot,
        platform: process.platform,
      };
    case "/ls":
      return { files: await listWorkspaceFiles(attemptRoot, meta) };
    case "/read": {
      const relPath = requiredString(body, "path");
      assertModelReadableWorkspacePath(relPath, meta);
      const file = resolveSafePath(attemptRoot, relPath);
      const content = await readFile(file, "utf8");
      return { content, bytes: Buffer.byteLength(content) };
    }
    case "/read-range":
      return readFileRange(attemptRoot, body, meta);
    case "/write": {
      const relPath = requiredString(body, "path");
      assertWritableWorkspacePath(relPath, meta);
      const file = resolveSafePath(attemptRoot, relPath);
      const content = requiredString(body, "content");
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content, "utf8");
      return { bytes: Buffer.byteLength(content) };
    }
    case "/patch":
      return patchFile(attemptRoot, body, meta);
    case "/append":
      return appendFile(attemptRoot, body, meta);
    case "/search":
      return searchFiles(attemptRoot, body, meta);
    case "/run": {
      const command = requiredString(body, "command");
      assertAllowedCommand(meta, command);
      return runCommand(command, attemptRoot, optionalTimeout(body), undefined, signal);
    }
    default:
      throw new HttpError(404, "Unknown bench compatibility endpoint.");
  }
}

async function prepare(body) {
  if (!isRecord(body)) throw new HttpError(400, "Prepare body must be an object.");
  const caseId = requiredString(body, "caseId");
  const network = optionalString(body, "network") ?? "none";
  if (network !== "none" && network !== "dependency-only") {
    throw new HttpError(400, "Bench runner v0.1 only allows network none or dependency-only.");
  }
  if (body.memoryMb !== undefined && body.memoryMb !== null) {
    throw new HttpError(
      400,
      "Bench runner v0.1 cannot enforce memoryMb; omit memoryMb instead of implying a memory boundary."
    );
  }
  const setupCommand = optionalString(body, "setupCommand");
  const verifierCommand = optionalString(body, "verifierCommand");
  const verifierResultFile = optionalString(body, "verifierResultFile");
  const allowedCommands = uniqueStrings([
    setupCommand,
    verifierCommand,
    ...stringArray(body.allowedCommands, "allowedCommands", true),
  ]);
  if (network === "none" && allowedCommands.length > 0) {
    throw new HttpError(
      400,
      "Bench runner v0.1 cannot enforce network none while executing commands; use dependency-only or omit commands."
    );
  }
  const trustedPolicy = parseTrustedPolicy(body.trustedPolicy);
  const files = isRecord(body.files) ? { ...body.files } : null;
  const rjsHealth = trustedPolicy
    ? await requireMatchingRjsRuntime(trustedPolicy, files)
    : null;

  const requestedAttemptId = optionalString(body, "attemptId");
  const attemptId = requestedAttemptId
    ? validateAttemptId(requestedAttemptId)
    : `${sanitizeId(caseId)}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const attemptRoot = attemptWorkspacePath(attemptId);
  if (existsSync(attemptRoot)) {
    throw new HttpError(409, "Bench attempt workspace already exists.");
  }
  await mkdir(attemptRoot, { recursive: true });

  const repoUrl = optionalString(body, "repoUrl");
  if (files) {
    if (trustedPolicy) specializeRjsFixture(files);
    for (const [path, content] of Object.entries(files)) {
      if (typeof content !== "string") {
        throw new HttpError(400, `Fixture file ${path} content must be a string.`);
      }
      const file = resolveSafePath(attemptRoot, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content, "utf8");
    }
  } else if (repoUrl?.startsWith("file://")) {
    const source = fileURLToPath(repoUrl);
    await copyFixtureTree(source, attemptRoot);
  } else if (repoUrl?.startsWith("fixture://") && repoUrl !== "fixture://inline") {
    await copyFixtureTree(resolveFixtureRepo(repoUrl), attemptRoot);
  } else if (repoUrl && existsSync(repoUrl)) {
    await copyFixtureTree(repoUrl, attemptRoot);
  } else if (repoUrl && !repoUrl.startsWith("fixture://")) {
    throw new HttpError(400, "Remote repository cloning is not supported by bench-runner v0.1; use a fixture repo.");
  }

  if (verifierResultFile) resolveSafePath(attemptRoot, verifierResultFile);

  const meta = {
    attemptId,
    caseId,
    createdAt: new Date().toISOString(),
    baseCommit: optionalString(body, "baseCommit"),
    network,
    timeoutSeconds: optionalNumber(body, "timeoutSeconds"),
    setupCommand,
    verifierCommand,
    verifierResultFile,
    allowedCommands,
    ...(trustedPolicy ? { trustedPolicy } : {}),
    ...(rjsHealth ? { trustedRuntime: rjsHealth } : {}),
    snapshot: {},
  };

  if (setupCommand) {
    assertAllowedCommand(meta, setupCommand);
    const setup = await runCommand(setupCommand, attemptRoot, meta.timeoutSeconds);
    if (setup.exitCode !== 0) {
      throw new HttpError(422, `Setup command failed with exit ${setup.exitCode}.`);
    }
  }

  meta.snapshot = await snapshotFiles(attemptRoot);
  meta.hiddenFiles = await hideOracleFiles(attemptRoot, meta.snapshot, meta);
  if (trustedPolicy) {
    validateRjsSnapshotMetadata(meta);
    await assertPreparedHiddenFilesAbsent(attemptRoot, meta);
    meta.rjsOracleLifecycle = { state: "prepared_hidden" };
  }
  await initializeAttemptRepository(attemptRoot);
  await saveMeta(attemptRoot, meta);
  return { attemptId, caseId, root: attemptRoot };
}

async function inspectRjsRuntime() {
  try {
    if (process.versions.node !== "24.18.0") {
      throw new Error(`Requires exactly Node.js 24.18.0; found ${process.versions.node}.`);
    }
    for (const path of [rjsRuntimePath, rjsIdentityPath, rjsEvaluatorPath, rjsAdapterPath]) {
      if (!existsSync(path)) throw new Error(`Trusted runtime file is missing: ${basename(path)}`);
    }
    const [identity, evaluator, quickjsPackage] = await Promise.all([
      import(pathToFileURL(rjsIdentityPath).href),
      import(pathToFileURL(rjsEvaluatorPath).href),
      readFile(rjsQuickJsPackagePath, "utf8").then(JSON.parse),
    ]);
    const hashes = await identity.scoreInputHashes();
    if (quickjsPackage.version !== "0.32.0") {
      throw new Error(`Requires quickjs-emscripten 0.32.0; found ${quickjsPackage.version ?? "unknown"}.`);
    }
    return {
      ready: true,
      nodeVersion: process.versions.node,
      quickjsVersion: quickjsPackage.version,
      contractHash: hashes.contractHash,
      suiteHash: hashes.suiteHash,
      profile: evaluator.PROFILE,
    };
  } catch (error) {
    return {
      ready: false,
      nodeVersion: process.versions.node,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseTrustedPolicy(value) {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || value.kind !== "recoverable-job-service") {
    throw new HttpError(400, "Unsupported trusted WorkBench policy.");
  }
  const policy = {
    kind: value.kind,
    runtimeModule: requiredString(value, "runtimeModule"),
    requiredNodeVersion: requiredString(value, "requiredNodeVersion"),
    requiredQuickJsVersion: requiredString(value, "requiredQuickJsVersion"),
    contractHash: requiredString(value, "contractHash"),
    suiteHash: requiredString(value, "suiteHash"),
    hiddenPaths: normalizedPolicyPaths(value.hiddenPaths, "hiddenPaths"),
    protectedPaths: normalizedPolicyPaths(value.protectedPaths, "protectedPaths"),
    editablePaths: normalizedPolicyPaths(value.editablePaths, "editablePaths"),
  };
  if (policy.runtimeModule !== "benchmarks/recoverable-job-service/private/runtime.mjs") {
    throw new HttpError(400, "Unexpected trusted RJS runtime module.");
  }
  if (policy.requiredNodeVersion !== "24.18.0" || policy.requiredQuickJsVersion !== "0.32.0") {
    throw new HttpError(400, "Unexpected trusted RJS runtime versions.");
  }
  if (policy.editablePaths.length !== 1 || policy.editablePaths[0] !== "service.js") {
    throw new HttpError(400, "RJS permits only service.js as editable source.");
  }
  return policy;
}

function normalizedPolicyPaths(value, label) {
  const values = stringArray(value, `trustedPolicy.${label}`);
  const normalized = values.map((path) => {
    resolveSafePath(root, path);
    return normalizeWorkspacePath(path);
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new HttpError(400, `trustedPolicy.${label} contains duplicate paths.`);
  }
  return normalized;
}

async function requireMatchingRjsRuntime(policy, files, recordedProfile) {
  const health = await inspectRjsRuntime();
  if (!health.ready) throw new HttpError(503, `RJS trusted runtime unavailable: ${health.error}`);
  if (
    health.nodeVersion !== policy.requiredNodeVersion ||
    health.quickjsVersion !== policy.requiredQuickJsVersion ||
    health.contractHash !== policy.contractHash ||
    health.suiteHash !== policy.suiteHash
  ) {
    throw new HttpError(409, "RJS trusted runtime identity does not match the selected case.");
  }
  let caseMetadata = null;
  if (files && typeof files["case-meta.json"] === "string") {
    try {
      caseMetadata = JSON.parse(files["case-meta.json"]);
    } catch {
      throw new HttpError(400, "RJS fixture case metadata is malformed.");
    }
  } else if (typeof recordedProfile === "string") {
    caseMetadata = {
      contractHash: policy.contractHash,
      suiteHash: policy.suiteHash,
      profile: recordedProfile,
    };
  } else {
    throw new HttpError(400, "RJS fixture case metadata is required.");
  }
  if (
    !isRecord(caseMetadata) ||
    caseMetadata.contractHash !== policy.contractHash ||
    caseMetadata.suiteHash !== policy.suiteHash ||
    caseMetadata.profile !== health.profile
  ) {
    throw new HttpError(409, "RJS fixture profile or score identity does not match the trusted runtime.");
  }
  return health;
}

function specializeRjsFixture(files) {
  for (const [path, modulePath] of [
    ["public-test.mjs", rjsRuntimePath],
    ["verify.mjs", rjsAdapterPath],
  ]) {
    if (typeof files[path] !== "string") {
      throw new HttpError(400, `RJS fixture is missing ${path}.`);
    }
    try {
      files[path] = specializeTrustedModule(files[path], pathToFileURL(modulePath).href);
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : String(error));
    }
  }
}

function initializeAttemptRepository(attemptRoot) {
  return new Promise((resolveInit, rejectInit) => {
    const child = spawn("git", ["init", "-b", "main"], {
      cwd: attemptRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-16 * 1024);
    });
    child.once("error", (error) =>
      rejectInit(new HttpError(500, `Could not initialize attempt Git repository: ${error.message}`))
    );
    child.once("exit", (code) => {
      if (code === 0) resolveInit();
      else rejectInit(new HttpError(500, `Could not initialize attempt Git repository: ${stderr.trim()}`));
    });
  });
}

async function patchFile(attemptRoot, body, meta) {
  const relPath = requiredString(body, "path");
  assertWritableWorkspacePath(relPath, meta);
  const file = resolveSafePath(attemptRoot, relPath);
  const original = await readFile(file, "utf8");
  const ops = Array.isArray(body.ops)
    ? body.ops
    : [{ search: body.search, replace: body.replace }];
  let content = original;
  let applied = 0;

  for (const op of ops) {
    if (!isRecord(op)) throw new HttpError(400, "Patch operations must be objects.");
    const search = requiredString(op, "search");
    const replace = requiredString(op, "replace");
    const index = content.indexOf(search);
    if (index === -1) continue;
    content = `${content.slice(0, index)}${replace}${content.slice(index + search.length)}`;
    applied++;
  }

  await writeFile(file, content, "utf8");
  return {
    applied,
    bytes: Buffer.byteLength(content),
    content,
  };
}

async function appendFile(attemptRoot, body, meta) {
  const relPath = requiredString(body, "path");
  assertWritableWorkspacePath(relPath, meta);
  const file = resolveSafePath(attemptRoot, relPath);
  const content = requiredString(body, "content");
  const reset = body.reset === true;
  let next = content;
  if (!reset) {
    try {
      next = `${await readFile(file, "utf8")}${content}`;
    } catch {
      next = content;
    }
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, next, "utf8");
  return {
    content: next,
    bytes: Buffer.byteLength(content),
    totalBytes: Buffer.byteLength(next),
  };
}

async function readFileRange(attemptRoot, body, meta) {
  const rangePath = requiredString(body, "path");
  assertModelReadableWorkspacePath(rangePath, meta);
  const file = resolveSafePath(attemptRoot, rangePath);
  const content = await readFile(file, "utf8");
  const lines = content.split(/\r?\n/);
  const startLine = Math.max(1, Math.floor(optionalNumber(body, "startLine") ?? 1));
  const lineCount = Math.max(1, Math.floor(optionalNumber(body, "lineCount") ?? 80));
  const startIndex = Math.min(lines.length, startLine - 1);
  const selected = lines.slice(startIndex, startIndex + lineCount);
  const endLine = selected.length > 0 ? startIndex + selected.length : startLine - 1;
  return {
    content: selected.join("\n"),
    startLine,
    endLine,
    totalLines: lines.length,
    truncated: startIndex + lineCount < lines.length,
    hasMoreBefore: startIndex > 0,
    hasMoreAfter: startIndex + lineCount < lines.length,
  };
}

async function searchFiles(attemptRoot, body, meta) {
  const query = requiredString(body, "query").toLowerCase();
  const matches = [];
  await walk(attemptRoot, async (file) => {
    if (matches.length >= 100) return;
    const relPath = toWorkspacePath(attemptRoot, file);
    if (isModelHiddenWorkspaceFile(relPath, meta)) return;
    let content = "";
    try {
      content = await readFile(file, "utf8");
    } catch {
      return;
    }
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length && matches.length < 100; index++) {
      if (lines[index].toLowerCase().includes(query)) {
        matches.push({
          path: relPath,
          line: index + 1,
          text: lines[index].slice(0, 500),
        });
      }
    }
  });
  return { results: matches };
}

async function runVerifier(attemptRoot, meta, body, signal) {
  const previous = activeVerifierRuns.get(meta.attemptId) ?? Promise.resolve();
  let release;
  const current = new Promise((resolveRun) => { release = resolveRun; });
  activeVerifierRuns.set(meta.attemptId, current);
  let acquired = false;
  const finish = () => {
    release();
    if (activeVerifierRuns.get(meta.attemptId) === current) activeVerifierRuns.delete(meta.attemptId);
  };
  try {
    await waitForVerifierTurn(previous, signal);
    acquired = true;
    return await runVerifierExclusive(attemptRoot, meta, body, signal);
  } finally {
    if (acquired) finish();
    else void previous.catch(() => undefined).then(finish);
  }
}

async function runVerifierExclusive(attemptRoot, meta, body, signal) {
  const liveRunner = managedAttemptRunners.get(meta.attemptId);
  if (liveRunner?.child.exitCode === null) {
    throw new HttpError(409, "Runner V2 must stop before verifier execution.");
  }
  const command = optionalString(body, "command") ?? meta.verifierCommand;
  if (!command) throw new HttpError(400, "No verifier command configured.");
  assertAllowedCommand(meta, command);
  const resultFile = optionalString(body, "resultFile") ?? meta.verifierResultFile;
  let childEnvironment;
  if (meta.trustedPolicy?.kind === "recoverable-job-service") {
    await inspectAndRestoreRjsOracle(attemptRoot, meta);
    if (resultFile) await removeRegularStaleVerifierResult(attemptRoot, resultFile);
    await assertFinalRjsSubmission(attemptRoot, meta);
    await assertHarnessFilesUntampered(attemptRoot, meta);
    await requireMatchingRjsRuntime(
      meta.trustedPolicy,
      null,
      meta.trustedRuntime?.profile
    );
    const replayStateFile = rjsReplayStatePath(meta);
    const adapter = await import(pathToFileURL(rjsAdapterPath).href);
    adapter.prepareReplayState(replayStateFile, {
      contractHash: meta.trustedPolicy.contractHash,
      suiteHash: meta.trustedPolicy.suiteHash,
    });
    childEnvironment = { ...process.env, AIBOARD_RJS_REPLAY_STATE_FILE: replayStateFile };
  } else {
    await restoreOracleFiles(attemptRoot, meta);
    await assertHarnessFilesUntampered(attemptRoot, meta);
  }
  const result = await runCommand(
    command,
    attemptRoot,
    optionalTimeout(body) ?? meta.timeoutSeconds,
    childEnvironment,
    signal
  );
  let resultJson = "";
  const artifactIds = [];

  if (resultFile) {
    const file = resolveSafePath(attemptRoot, resultFile);
    try {
      const resultStat = await stat(file);
      if (!resultStat.isFile()) throw new Error("Verifier result is not a regular file.");
      if (resultStat.size > MAX_VERIFIER_RESULT_BYTES) {
        throw new HttpError(422, "invalid_harness: complete verifier result exceeded trusted transport capacity.");
      }
      resultJson = await readFile(file, "utf8");
      artifactIds.push(resultFile.replace(/\\/g, "/"));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      resultJson = "";
    }
  }
  if (!resultJson) {
    resultJson = extractJsonObject(result.stdout) ?? "";
  }
  const parsed = resultJson ? parseVerifierJson(resultJson) : null;
  return {
    passed: parsed?.passed === true && result.exitCode === 0,
    score: typeof parsed?.score === "number" ? clamp01(parsed.score) : 0,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    stdoutPreview: preview(result.stdout),
    stderrPreview: preview(result.stderr),
    resultJson: resultJson.trim(),
    artifactIds,
  };
}

function rjsReplayStatePath(meta) {
  const identity = [
    meta.attemptId,
    meta.caseId,
    meta.trustedPolicy.contractHash,
    meta.trustedPolicy.suiteHash,
  ].join("\0");
  const digest = createHash("sha256").update(identity).digest("hex");
  return resolveSafeChild(rjsReplayStateRoot, `${digest}.json`);
}

async function cleanup(body) {
  const attemptId = requiredString(body, "attemptId");
  const attemptRoot = attemptWorkspacePath(attemptId);
  const meta = await readMeta(attemptRoot).catch(() => null);
  await stopAttemptRunner({ attemptId });
  managedAttemptRunners.delete(attemptId);
  const statePath = runnerStatePath(attemptId);
  await rm(attemptRoot, { recursive: true, force: true });
  await rm(statePath, { recursive: true, force: true });
  if (meta?.trustedPolicy?.kind === "recoverable-job-service") {
    await rm(rjsReplayStatePath(meta), { force: true });
  }
  await rm(metaPath(basename(attemptRoot)), { force: true });
  return { removed: true };
}

async function startAttemptRunner(body) {
  const attemptId = validateAttemptId(requiredString(body, "attemptId"));
  const attemptRoot = attemptWorkspacePath(attemptId);
  const meta = await readMeta(attemptRoot);
  if (!runnerV2Launcher) {
    throw new HttpError(
      503,
      runnerV2Discovery?.error ??
        "Managed Runner V2 is unavailable; configure --runner-v2-dir."
    );
  }
  const existing = managedAttemptRunners.get(attemptId);
  if (existing?.child.exitCode === null) return managedRunnerResult(existing, true);

  const statePath = runnerStatePath(attemptId);
  await rm(statePath, { recursive: true, force: true });
  await mkdir(statePath, { recursive: true });
  const token = randomBytes(32).toString("hex");
  const invocation = runnerV2Invocation(runnerV2Launcher, attemptRoot, statePath, token);
  const child = spawn(invocation.command, invocation.args, {
    cwd: runnerV2Launcher.directory,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const startupDeadline = Date.now() + 45_000;
  const started = await waitForRunnerV2Startup(child, 45_000).catch(async (error) => {
    await terminateChild(child);
    throw error;
  });
  const health = await readManagedRunnerHealth(
    started.url,
    token,
    attemptRoot,
    Math.max(1, startupDeadline - Date.now())
  ).catch(async (error) => {
    await terminateChild(child);
    throw error;
  });
  if (
    meta.trustedPolicy?.kind === "recoverable-job-service" &&
    health.nodeVersion !== meta.trustedPolicy.requiredNodeVersion
  ) {
    await terminateChild(child);
    throw new HttpError(
      409,
      `Recoverable Job Service requires managed Runner Node ${meta.trustedPolicy.requiredNodeVersion}.`
    );
  }
  const managed = {
    attemptId,
    child,
    url: started.url,
    token,
    projectPath: attemptRoot,
    statePath,
    nodeVersion: health.nodeVersion,
  };
  managedAttemptRunners.set(attemptId, managed);
  child.once("exit", () => {
    if (managedAttemptRunners.get(attemptId) === managed) managed.exited = true;
  });
  return managedRunnerResult(managed, true);
}

async function statusAttemptRunner(body) {
  const attemptId = validateAttemptId(requiredString(body, "attemptId"));
  const managed = managedAttemptRunners.get(attemptId);
  if (!managed) {
    const attemptRoot = attemptWorkspacePath(attemptId);
    await readMeta(attemptRoot);
    return {
      attemptId,
      running: false,
      projectPath: attemptRoot,
      statePath: runnerStatePath(attemptId),
    };
  }
  return managedRunnerResult(managed, managed.child.exitCode === null && !managed.exited);
}

async function stopAttemptRunner(body) {
  const attemptId = validateAttemptId(requiredString(body, "attemptId"));
  const managed = managedAttemptRunners.get(attemptId);
  if (managed) await terminateChild(managed.child);
  return managed
    ? managedRunnerResult(managed, false)
    : {
        attemptId,
        running: false,
        projectPath: attemptWorkspacePath(attemptId),
        statePath: runnerStatePath(attemptId),
      };
}

function runnerStatePath(attemptId) {
  const digest = createHash("sha256").update(validateAttemptId(attemptId)).digest("hex").slice(0, 24);
  return resolveSafeChild(runnerStateRoot, digest);
}

function attemptWorkspacePath(attemptId) {
  const digest = createHash("sha256").update(validateAttemptId(attemptId)).digest("hex").slice(0, 24);
  return resolveSafeChild(root, digest);
}

function managedRunnerResult(managed, running) {
  return {
    attemptId: managed.attemptId,
    running,
    ...(running ? { url: managed.url, token: managed.token } : {}),
    projectPath: managed.projectPath,
    statePath: managed.statePath,
    pid: managed.child.pid ?? null,
    ...(managed.nodeVersion ? { nodeVersion: managed.nodeVersion } : {}),
  };
}

async function withAttempt(body, action) {
  const attemptId = requiredString(body, "attemptId");
  const attemptRoot = attemptWorkspacePath(attemptId);
  const meta = await readMeta(attemptRoot);
  return action({ attemptRoot, meta });
}

async function readMeta(attemptRoot) {
  try {
    const content = await readFile(metaPath(basename(attemptRoot)), "utf8");
    const parsed = JSON.parse(content);
    if (!isRecord(parsed)) throw new Error("metadata must be an object");
    return parsed;
  } catch {
    throw new HttpError(404, "Unknown bench attempt.");
  }
}

async function saveMeta(attemptRoot, meta) {
  await writeFile(metaPath(basename(attemptRoot)), JSON.stringify(meta, null, 2), "utf8");
}

function metaPath(attemptId) {
  return resolveSafeChild(attemptMetaRoot, `${validateAttemptId(attemptId)}.json`);
}

function runCommand(command, cwd, timeoutSeconds, environment, signal) {
  const started = Date.now();
  return new Promise((resolveCommand, rejectCommand) => {
    let settled = false;
    let aborted = false;
    const child = exec(
      command,
      {
        cwd,
        timeout: Math.max(1, timeoutSeconds ?? 30) * 1000,
        windowsHide: true,
        maxBuffer: MAX_OUTPUT_BYTES * 4,
        ...(environment ? { env: environment } : {}),
      },
      (error, stdout, stderr) => {
        if (aborted) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        const exitCode =
          error && typeof error.code === "number"
            ? error.code
            : error
              ? 1
              : 0;
        const cappedStdout = capOutput(String(stdout ?? ""));
        const cappedStderr = capOutput(String(stderr ?? ""));
        resolveCommand({
          exitCode,
          stdout: cappedStdout.text,
          stderr: cappedStderr.text,
          durationMs: Date.now() - started,
          truncated: cappedStdout.truncated || cappedStderr.truncated,
        });
      }
    );
    const onAbort = () => {
      if (settled || aborted) return;
      aborted = true;
      void terminateChild(child).finally(() => {
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        rejectCommand(Object.assign(new Error("Bench command cancelled."), { name: "AbortError" }));
      });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function readManagedRunnerHealth(url, runnerToken, expectedProjectPath, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetch(`${String(url).replace(/\/$/, "")}/v2/health`, {
      headers: { authorization: `Bearer ${runnerToken}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new HttpError(502, `Managed Runner V2 health returned HTTP ${response.status}.`);
    }
    const health = await response.json();
    if (
      !isRecord(health) ||
      health.ok !== true ||
      health.protocolVersion !== 2 ||
      health.projectPath !== expectedProjectPath ||
      typeof health.nodeVersion !== "string"
    ) {
      throw new HttpError(502, "Managed Runner V2 health identity did not match the prepared attempt.");
    }
    return health;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error?.name === "AbortError") {
      throw new HttpError(504, "Managed Runner V2 health timed out.");
    }
    throw new HttpError(
      502,
      `Managed Runner V2 health failed: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    clearTimeout(timeout);
  }
}

function waitForVerifierTurn(previous, signal) {
  if (!signal) return previous.catch(() => undefined);
  if (signal.aborted) {
    return Promise.reject(Object.assign(new Error("Bench verifier cancelled."), { name: "AbortError" }));
  }
  return new Promise((resolveWait, rejectWait) => {
    const onAbort = () => {
      rejectWait(Object.assign(new Error("Bench verifier cancelled."), { name: "AbortError" }));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    previous.catch(() => undefined).then(() => {
      signal.removeEventListener("abort", onAbort);
      resolveWait();
    });
  });
}

async function listWorkspaceFiles(attemptRoot, meta) {
  const files = [];
  await walk(attemptRoot, async (file) => {
    const relPath = toWorkspacePath(attemptRoot, file);
    if (isModelHiddenWorkspaceFile(relPath, meta)) return;
    files.push(relPath);
  });
  return files.sort();
}

async function snapshotFiles(attemptRoot) {
  const snapshot = {};
  await walk(attemptRoot, async (file) => {
    const relPath = toWorkspacePath(attemptRoot, file);
    snapshot[relPath] = await readFile(file, "utf8");
  });
  return snapshot;
}

async function hideOracleFiles(attemptRoot, snapshot, meta) {
  const hiddenFiles = {};
  for (const [relPath, content] of Object.entries(snapshot)) {
    if (!isModelHiddenWorkspaceFile(relPath, meta)) continue;
    hiddenFiles[relPath] = content;
    await rm(resolveSafePath(attemptRoot, relPath), { force: true });
  }
  return hiddenFiles;
}

function rjsSubmissionError(kind, message) {
  if (kind === "policy") {
    return new HttpError(422, message, "rjs_submission_policy_violation", "candidate_tool_failure");
  }
  if (kind === "snapshot") {
    return new HttpError(500, message, "rjs_submission_snapshot_invalid", "invalid_harness");
  }
  return new HttpError(500, message, "rjs_submission_io_failed", "invalid_environment");
}

function validateRjsSnapshotMetadata(meta, requireLifecycle = false) {
  if (!isRecord(meta?.snapshot) || !isRecord(meta?.hiddenFiles)) {
    throw rjsSubmissionError("snapshot", "Trusted RJS submission snapshot is invalid.");
  }
  const expected = [...policyPaths(meta, "hiddenPaths")].sort();
  const hidden = Object.keys(meta.hiddenFiles).map(normalizeWorkspacePath).sort();
  if (
    expected.length === 0 ||
    expected.length !== hidden.length ||
    expected.some((path, index) => path !== hidden[index]) ||
    expected.some((path) => typeof meta.snapshot[path] !== "string" || meta.hiddenFiles[path] !== meta.snapshot[path])
  ) {
    throw rjsSubmissionError("snapshot", "Trusted RJS submission snapshot is invalid.");
  }
  if (requireLifecycle) {
    const lifecycle = meta.rjsOracleLifecycle;
    if (!isRecord(lifecycle) || !["prepared_hidden", "restoring", "restored"].includes(lifecycle.state)) {
      throw rjsSubmissionError("snapshot", "Trusted RJS restoration state is invalid.");
    }
  }
}

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function inspectRealParents(attemptRoot, relPath, createMissing = false) {
  const parts = normalizeWorkspacePath(relPath).split("/").slice(0, -1);
  let current = attemptRoot;
  for (const part of parts) {
    current = join(current, part);
    let info = await lstatOrNull(current);
    if (!info && createMissing) {
      await mkdir(current);
      info = await lstat(current);
    }
    if (!info?.isDirectory() || info.isSymbolicLink()) {
      throw rjsSubmissionError("policy", "RJS submission contains a disallowed workspace entry.");
    }
  }
}

async function assertPreparedHiddenFilesAbsent(attemptRoot, meta) {
  try {
    for (const relPath of policyPaths(meta, "hiddenPaths")) {
      await inspectRealParents(attemptRoot, relPath);
      if (await lstatOrNull(resolveSafePath(attemptRoot, relPath))) {
        throw rjsSubmissionError("snapshot", "Trusted RJS hidden-file preparation is inconsistent.");
      }
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw rjsSubmissionError("io", "Could not inspect the trusted RJS submission workspace.");
  }
}

async function compareRestoredHiddenFiles(attemptRoot, meta) {
  try {
    for (const relPath of policyPaths(meta, "hiddenPaths")) {
      await inspectRealParents(attemptRoot, relPath);
      const path = resolveSafePath(attemptRoot, relPath);
      const info = await lstatOrNull(path);
      if (!info?.isFile() || info.isSymbolicLink()) {
        throw rjsSubmissionError("policy", "RJS submission changed a protected workspace entry.");
      }
      const handle = await open(path, "r");
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || (await handle.readFile("utf8")) !== meta.hiddenFiles[relPath]) {
          throw rjsSubmissionError("policy", "RJS submission changed a protected workspace entry.");
        }
      } finally {
        await handle.close();
      }
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw rjsSubmissionError("io", "Could not inspect the trusted RJS submission workspace.");
  }
}

async function inspectAndRestoreRjsOracle(attemptRoot, meta) {
  validateRjsSnapshotMetadata(meta, true);
  const state = meta.rjsOracleLifecycle.state;
  if (state === "restoring") {
    throw rjsSubmissionError("io", "Trusted RJS restoration did not complete.");
  }
  if (state === "restored") {
    await compareRestoredHiddenFiles(attemptRoot, meta);
    return;
  }
  await assertPreparedHiddenFilesAbsent(attemptRoot, meta);
  meta.rjsOracleLifecycle = { state: "restoring" };
  try {
    await saveMeta(attemptRoot, meta);
    for (const [relPath, content] of Object.entries(meta.hiddenFiles)) {
      await inspectRealParents(attemptRoot, relPath, true);
      const handle = await open(resolveSafePath(attemptRoot, relPath), "wx", 0o600);
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    await compareRestoredHiddenFiles(attemptRoot, meta);
    meta.rjsOracleLifecycle = { state: "restored", restoredAt: new Date().toISOString() };
    await saveMeta(attemptRoot, meta);
  } catch (error) {
    if (error instanceof HttpError && error.code === "rjs_submission_snapshot_invalid") throw error;
    throw rjsSubmissionError("io", "Trusted RJS restoration could not be completed.");
  }
}

async function removeRegularStaleVerifierResult(attemptRoot, resultFile) {
  try {
    const path = resolveSafePath(attemptRoot, resultFile);
    const info = await lstatOrNull(path);
    if (!info) return;
    if (!info.isFile() || info.isSymbolicLink()) {
      throw rjsSubmissionError("policy", "RJS submission contains a disallowed verifier output entry.");
    }
    await rm(path);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw rjsSubmissionError("io", "Could not inspect the RJS verifier output.");
  }
}

async function assertFinalRjsSubmission(attemptRoot, meta) {
  try {
    validateRjsSnapshotMetadata(meta, true);
    const editable = [...policyPaths(meta, "editablePaths")];
    if (editable.length !== 1 || editable[0] !== "service.js") {
      throw rjsSubmissionError("snapshot", "Trusted RJS editable-file policy is invalid.");
    }
    const expectedFiles = new Set(Object.keys(meta.snapshot).map(normalizeWorkspacePath));
    const expectedDirectories = new Set();
    for (const path of expectedFiles) {
      const parts = path.split("/");
      for (let index = 1; index < parts.length; index++) {
        expectedDirectories.add(parts.slice(0, index).join("/"));
      }
    }
    const seenFiles = new Set();
    const seenDirectories = new Set();
    const visit = async (directory, prefix = "") => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        const fullPath = join(directory, entry.name);
        const info = await lstat(fullPath);
        if (!prefix && entry.name === ".git") {
          if (info.isSymbolicLink() || !info.isDirectory()) {
            throw rjsSubmissionError("policy", "RJS submission contains an invalid repository metadata entry.");
          }
          continue;
        }
        if (info.isSymbolicLink()) {
          throw rjsSubmissionError("policy", "RJS submission contains a disallowed workspace entry.");
        }
        if (info.isDirectory()) {
          seenDirectories.add(relPath);
          if (!expectedDirectories.has(relPath)) {
            throw rjsSubmissionError("policy", "RJS submission contains a disallowed workspace entry.");
          }
          await visit(fullPath, relPath);
        } else if (info.isFile()) {
          seenFiles.add(relPath);
          if (!expectedFiles.has(relPath)) {
            throw rjsSubmissionError("policy", "RJS submission contains a disallowed workspace entry.");
          }
        } else {
          throw rjsSubmissionError("policy", "RJS submission contains a disallowed workspace entry.");
        }
      }
    };
    await visit(attemptRoot);
    if (
      !seenFiles.has("service.js") ||
      [...expectedFiles].some((path) => !seenFiles.has(path)) ||
      [...expectedDirectories].some((path) => !seenDirectories.has(path))
    ) {
      throw rjsSubmissionError("policy", "RJS submission is missing a required workspace entry.");
    }
    for (const relPath of expectedFiles) {
      if (relPath === "service.js") continue;
      if ((await readFile(resolveSafePath(attemptRoot, relPath), "utf8")) !== meta.snapshot[relPath]) {
        throw rjsSubmissionError("policy", "RJS submission changed a protected workspace entry.");
      }
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw rjsSubmissionError("io", "Could not compare the RJS submission workspace.");
  }
}

async function restoreOracleFiles(attemptRoot, meta) {
  const hiddenFiles = isRecord(meta.hiddenFiles) ? meta.hiddenFiles : {};
  for (const [relPath, content] of Object.entries(hiddenFiles)) {
    if (typeof content !== "string") continue;
    const file = resolveSafePath(attemptRoot, relPath);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
  }
}

async function createDiff(attemptRoot, before, meta) {
  const after = await snapshotFiles(attemptRoot);
  const paths = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort();
  const chunks = [];

  for (const path of paths) {
    if (isModelHiddenWorkspaceFile(path, meta)) continue;
    if (before[path] === after[path]) continue;
    if (before[path] === undefined) {
      chunks.push(`--- /dev/null\n+++ b/${path}\n${prefixLines(after[path] ?? "", "+")}`);
    } else if (after[path] === undefined) {
      chunks.push(`--- a/${path}\n+++ /dev/null\n${prefixLines(before[path] ?? "", "-")}`);
    } else {
      chunks.push(
        `--- a/${path}\n+++ b/${path}\n${prefixLines(before[path] ?? "", "-")}${prefixLines(after[path] ?? "", "+")}`
      );
    }
  }

  return capOutput(chunks.join("\n")).text;
}

function prefixLines(content, prefix) {
  if (!content) return "";
  return content
    .split(/\r?\n/)
    .map((line) => (line ? `${prefix}${line}\n` : `${prefix}\n`))
    .join("");
}

async function walk(dir, onFile) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === META_FILE || entry.name === ".git") continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, onFile);
    } else if (entry.isFile()) {
      await onFile(fullPath);
    }
  }
}

function discoverRunnerV2(explicitDirectory) {
  const candidates = [
    ...(explicitDirectory ? [{ directory: resolve(explicitDirectory), source: "explicit" }] : []),
    { directory: join(scriptDirectory, "aiboard-runner-v2"), source: "sibling" },
    { directory: resolve(scriptDirectory, ".."), source: "repository" },
  ];
  for (const candidate of candidates) {
    const repositoryCli = join(candidate.directory, "runner-v2", "src", "cli.ts");
    const distributionCli = join(candidate.directory, "src", "cli.ts");
    if (existsSync(repositoryCli)) {
      return runnerV2Candidate(candidate, "runner-v2/src/cli.ts");
    }
    if (existsSync(distributionCli)) {
      return runnerV2Candidate(candidate, "src/cli.ts");
    }
  }
  return null;
}

function runnerV2Candidate(candidate, cli) {
  const tsxCli = join(candidate.directory, "node_modules", "tsx", "dist", "cli.mjs");
  if (existsSync(tsxCli)) {
    return { ...candidate, cli, ready: true };
  }
  return {
    ...candidate,
    cli,
    ready: false,
    error:
      `Runner V2 source was found at ${candidate.directory}, but launcher dependencies are missing. ` +
      `Run "npm install" in ${candidate.directory}.`,
  };
}

function runnerV2Invocation(launcher, projectPath, statePath, runnerToken) {
  return {
    command: process.execPath,
    args: [
      join(launcher.directory, "node_modules", "tsx", "dist", "cli.mjs"),
      launcher.cli,
      "--project",
      projectPath,
      "--state-dir",
      statePath,
      "--port",
      "0",
      "--token",
      runnerToken,
    ],
  };
}

function waitForRunnerV2Startup(child, timeoutMs) {
  return new Promise((resolveStartup, rejectStartup) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
      if (error) rejectStartup(error);
      else resolveStartup(value);
    };
    const onStdout = (chunk) => {
      stdout += String(chunk);
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (isRecord(parsed) && typeof parsed.url === "string") {
            finish(null, parsed);
            return;
          }
        } catch {
          // Runner V2's startup contract is one JSON line; ignore unrelated npx output.
        }
      }
    };
    const onStderr = (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-16 * 1024);
    };
    const onExit = (code) =>
      finish(new HttpError(502, `Runner V2 exited during startup (${code}): ${stderr.trim()}`));
    const timeout = setTimeout(
      () => finish(new HttpError(504, `Runner V2 startup timed out: ${stderr.trim()}`)),
      timeoutMs
    );
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
  });
}

function terminateChild(child) {
  if (process.platform === "win32" && child.pid && child.exitCode === null) {
    return new Promise((resolveStop) => {
      const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("error", () => resolveStop());
      killer.once("exit", () => resolveStop());
    });
  }
  return new Promise((resolveStop) => {
    if (child.exitCode !== null || child.killed) {
      resolveStop();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(force);
      resolveStop();
    };
    child.once("exit", finish);
    child.kill("SIGTERM");
    const force = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      finish();
    }, 5_000);
    force.unref();
  });
}

async function copyFixtureTree(source, target) {
  const sourceStat = await stat(source);
  if (!sourceStat.isDirectory()) {
    throw new HttpError(400, "Fixture repository path must be a directory.");
  }
  await cp(source, target, {
    recursive: true,
    force: true,
    errorOnExist: false,
    filter: (sourcePath) => basename(sourcePath) !== ".git",
  });
}

// Files that hold the verifier's own criteria or result. The model under test
// reaches the workspace through the write/patch endpoints; it must never be
// able to overwrite these to fake a pass. The configured verifier result file is
// still blocked from direct model writes, but it is mutable output for verifier
// commands and is not treated as immutable harness input at official scoring.
const PROTECTED_WORKSPACE_FILES = new Set([
  "case-meta.json",
  "verifier.mjs",
  "verifier-result.json",
  "negative-control.json",
  "reference-solution.md",
  META_FILE,
]);

function isProtectedWorkspaceFile(relPath, meta) {
  if (typeof relPath !== "string") return false;
  const normalized = normalizeWorkspacePath(relPath);
  const base = normalized.split("/").pop() ?? normalized;
  return (
    policyPaths(meta, "protectedPaths").has(normalized) ||
    PROTECTED_WORKSPACE_FILES.has(normalized) ||
    PROTECTED_WORKSPACE_FILES.has(base)
  );
}

// Files that carry the verifier's grading spec or other oracle material. They
// must stay on disk (node verifier.mjs reads case-meta.json from the
// workspace) but the model under test must not be able to READ them through
// the runner's list/read/search endpoints - otherwise every snippet-checked
// case degrades into copy-the-answer. verifier.mjs itself stays readable: it
// contains only generic scoring logic, and verifier-result.json stays readable
// so models can iterate on verifier feedback.
const MODEL_HIDDEN_WORKSPACE_FILES = new Set([
  "case-meta.json",
  "negative-control.json",
  "reference-solution.md",
  META_FILE,
]);

function isModelHiddenWorkspaceFile(relPath, meta) {
  if (typeof relPath !== "string") return false;
  const normalized = normalizeWorkspacePath(relPath);
  const base = normalized.split("/").pop() ?? normalized;
  return (
    policyPaths(meta, "hiddenPaths").has(normalized) ||
    MODEL_HIDDEN_WORKSPACE_FILES.has(normalized) ||
    MODEL_HIDDEN_WORKSPACE_FILES.has(base)
  );
}

function assertModelReadableWorkspacePath(relPath, meta) {
  if (isModelHiddenWorkspaceFile(relPath, meta)) {
    throw new HttpError(404, `File not found: ${relPath}`);
  }
}

function isConfiguredVerifierResultFile(relPath, meta) {
  if (typeof relPath !== "string" || typeof meta?.verifierResultFile !== "string") {
    return false;
  }
  return normalizeWorkspacePath(relPath) === normalizeWorkspacePath(meta.verifierResultFile);
}

function normalizeWorkspacePath(relPath) {
  return relPath.replace(/\\/g, "/").replace(/^\.?\//, "");
}

function assertWritableWorkspacePath(relPath, meta) {
  const normalized = normalizeWorkspacePath(relPath);
  const editable = policyPaths(meta, "editablePaths");
  if (editable.size > 0 && !editable.has(normalized)) {
    throw new HttpError(403, `RJS permits edits only to service.js: ${relPath}`);
  }
  if (isProtectedWorkspaceFile(relPath, meta)) {
    throw new HttpError(403, `Refusing to write protected harness file: ${relPath}`);
  }
}

// Verify-time backstop: confirm the verifier's own files still match what
// prepare wrote. Catches tampering through any vector the write guard does not
// cover (e.g. an allowlisted shell command that overwrites case-meta.json).
async function assertHarnessFilesUntampered(attemptRoot, meta) {
  const snapshot = meta?.snapshot ?? {};
  for (const relPath of Object.keys(snapshot)) {
    if (!isProtectedWorkspaceFile(relPath, meta)) continue;
    if (isConfiguredVerifierResultFile(relPath, meta)) continue;
    let current;
    try {
      current = await readFile(resolveSafePath(attemptRoot, relPath), "utf8");
    } catch {
      throw new HttpError(
        409,
        `Protected harness file missing at verify time: ${relPath}`
      );
    }
    if (current !== snapshot[relPath]) {
      throw new HttpError(
        409,
        `Protected harness file modified after prepare: ${relPath}`
      );
    }
  }
}

function policyPaths(meta, key) {
  const values = meta?.trustedPolicy?.[key];
  return new Set(Array.isArray(values) ? values.map(normalizeWorkspacePath) : []);
}

function resolveSafePath(attemptRoot, relPath) {
  if (typeof relPath !== "string" || !relPath.trim()) {
    throw new HttpError(400, "Path must be a non-empty string.");
  }
  const normalized = relPath.replace(/\\/g, "/");
  if (
    normalized.startsWith("/") ||
    isAbsolute(relPath) ||
    /^[a-zA-Z]:/.test(relPath) ||
    normalized.split("/").some((part) => part === "..")
  ) {
    throw new HttpError(400, "Path must stay inside the attempt workspace.");
  }
  return resolveSafeChild(attemptRoot, normalized);
}

function resolveSafeChild(parent, child) {
  const resolvedParent = resolve(parent);
  const resolvedChild = resolve(resolvedParent, child);
  if (
    resolvedChild !== resolvedParent &&
    !resolvedChild.startsWith(`${resolvedParent}${sep}`)
  ) {
    throw new HttpError(400, "Resolved path escapes the bench workspace.");
  }
  return resolvedChild;
}

function toWorkspacePath(attemptRoot, file) {
  return relative(attemptRoot, file).replace(/\\/g, "/");
}

function assertAllowedCommand(meta, command) {
  const allowed = Array.isArray(meta.allowedCommands) ? meta.allowedCommands : [];
  if (!allowed.includes(command)) {
    throw new HttpError(403, "Command is not allowlisted for this bench attempt.");
  }
}

function parseVerifierJson(json) {
  try {
    const parsed = JSON.parse(json);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractJsonObject(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  for (let start = trimmed.indexOf("{"); start >= 0; start = trimmed.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < trimmed.length; index++) {
      const char = trimmed[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === "\"") inString = false;
        continue;
      }
      if (char === "\"") inString = true;
      else if (char === "{") depth++;
      else if (char === "}") {
        depth--;
        if (depth === 0) return trimmed.slice(start, index + 1);
      }
    }
  }
  return null;
}

async function readJsonBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large.");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) throw new HttpError(400, "Request body must be a JSON object.");
    return parsed;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Malformed JSON request body.");
  }
}

function sendJson(req, res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...corsHeaders(req),
  });
  res.end(body);
}

function sendNoContent(req, res, status) {
  res.writeHead(status, corsHeaders(req));
  res.end();
}

function corsHeaders(req) {
  const headers = {
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-runner-token",
    "access-control-max-age": "600",
    vary: "Origin",
  };
  const origin = allowedOriginForRequest(req);
  if (origin) headers["access-control-allow-origin"] = origin;
  return headers;
}

function allowedOriginForRequest(req) {
  const origin = req.headers.origin;
  if (typeof origin !== "string") return null;
  try {
    const normalized = new URL(origin).origin;
    return appOrigins.has(normalized) ? normalized : null;
  } catch {
    return null;
  }
}

function parseCompatRoute(pathname) {
  const prefix = "/bench/compat/";
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  const slashIndex = rest.indexOf("/");
  if (slashIndex <= 0) {
    throw new HttpError(404, "Unknown bench compatibility endpoint.");
  }
  const attemptId = validateAttemptId(decodeURIComponent(rest.slice(0, slashIndex)));
  const endpoint = rest.slice(slashIndex) || "/";
  return { attemptId, endpoint };
}

function requiredString(record, key) {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, `${key} must be a non-empty string.`);
  }
  return value;
}

function optionalString(record, key) {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new HttpError(400, `${key} must be a string.`);
  return value || undefined;
}

function optionalNumber(record, key) {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new HttpError(400, `${key} must be a positive number.`);
  }
  return value;
}

function optionalTimeout(record) {
  return optionalNumber(record, "timeoutSeconds");
}

function stringArray(value, label, optional = false) {
  if (value === undefined || value === null) {
    if (optional) return [];
    throw new HttpError(400, `${label} must be an array.`);
  }
  if (!Array.isArray(value)) throw new HttpError(400, `${label} must be an array.`);
  return value.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new HttpError(400, `${label}[${index}] must be a non-empty string.`);
    }
    return item;
  });
}

function uniqueStrings(values) {
  return Array.from(new Set(values.filter((value) => typeof value === "string" && value.trim())));
}

function sanitizeId(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) || "attempt";
}

function validateAttemptId(value) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 120 || !/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
    throw new HttpError(400, "attemptId must contain only letters, numbers, dot, underscore, or dash.");
  }
  return trimmed;
}

function resolveFixtureRepo(repoUrl) {
  if (!fixtureRoot) {
    throw new HttpError(
      400,
      "Named fixture repositories are not bundled. Use fixture://inline or pass --fixture-root."
    );
  }
  const id = repoUrl.slice("fixture://".length);
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
    throw new HttpError(400, "Fixture id must contain only letters, numbers, dot, underscore, or dash.");
  }
  const fixture = resolveSafeChild(fixtureRoot, id);
  if (!existsSync(fixture)) {
    throw new HttpError(404, `Unknown WorkBench fixture: ${id}.`);
  }
  return fixture;
}

function preview(value) {
  return capOutput(value, 16 * 1024).text;
}

function capOutput(value, maxBytes = MAX_OUTPUT_BYTES) {
  const text = String(value ?? "");
  const bytes = Buffer.byteLength(text);
  if (bytes <= maxBytes) return { text, truncated: false };
  return {
    text: `${text.slice(0, maxBytes)}\n[truncated ${bytes - maxBytes} bytes]`,
    truncated: true,
  };
}

function clamp01(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function mimeTypeForPath(path) {
  switch (extname(path).toLowerCase()) {
    case ".json":
      return "application/json";
    case ".md":
      return "text/markdown";
    case ".patch":
    case ".diff":
      return "text/x-patch";
    default:
      return "text/plain";
  }
}

function isLoopbackHost(value) {
  return value === "127.0.0.1" || value === "localhost" || value === "::1";
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = args[index + 1];
    const value = !next || next.startsWith("--") ? "true" : next;
    if (parsed[key] === undefined) {
      parsed[key] = value;
    } else if (Array.isArray(parsed[key])) {
      parsed[key].push(value);
    } else {
      parsed[key] = [parsed[key], value];
    }
    if (value === next) {
      index++;
    }
  }
  return parsed;
}

function optionValue(value) {
  if (Array.isArray(value)) return value[value.length - 1];
  return value;
}

function optionValues(value) {
  if (Array.isArray(value)) return value;
  return value === undefined ? [] : [value];
}

function parseAppOrigins(extraOrigins) {
  const origins = new Set(DEFAULT_APP_ORIGINS);
  for (const extraOrigin of extraOrigins) {
    if (typeof extraOrigin !== "string" || !extraOrigin.trim()) continue;
    try {
      const url = new URL(extraOrigin);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("invalid protocol");
      }
      origins.add(url.origin);
    } catch {
      console.error(`Ignoring invalid --app-origin value: ${extraOrigin}`);
    }
  }
  return origins;
}

class HttpError extends Error {
  constructor(status, message, code, disposition) {
    super(message);
    this.status = status;
    if (code) this.code = code;
    if (disposition) this.disposition = disposition;
  }
}
