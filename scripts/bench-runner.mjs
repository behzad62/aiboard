#!/usr/bin/env node
import { exec } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile, readdir, cp } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = 1;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
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
const appOrigins = parseAppOrigins(optionValues(options["app-origin"]));

if (!isLoopbackHost(host)) {
  console.error("bench-runner refuses to bind non-loopback hosts.");
  process.exit(1);
}
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error("bench-runner --port must be a valid TCP port.");
  process.exit(1);
}

await mkdir(root, { recursive: true });

const server = createServer(async (req, res) => {
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
    const data = await route(url.pathname, body);
    sendJson(req, res, 200, data);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : String(error);
    sendJson(req, res, status, { error: message });
  }
});

server.listen(port, host, () => {
  console.log(
    JSON.stringify({
      ok: true,
      service: "aiboard-bench-runner",
      version: VERSION,
      url: `http://${host}:${port}`,
      root,
      token,
    })
  );
  console.error(
    "bench-runner v0.1 isolation: commands run with FULL host privileges. " +
      "'network: dependency-only' is a label, not a boundary; " +
      "'memoryMb' requests are rejected. Run only trusted cases."
  );
});

async function route(pathname, body) {
  const compat = parseCompatRoute(pathname);
  if (compat) return routeCompat(compat.attemptId, compat.endpoint, body);

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
      };
    case "/bench/prepare":
      return prepare(body);
    case "/bench/read-tree":
      return withAttempt(body, async ({ attemptRoot }) => ({
        files: await listWorkspaceFiles(attemptRoot),
      }));
    case "/bench/read-file":
      return withAttempt(body, async ({ attemptRoot }) => {
        const file = resolveSafePath(attemptRoot, requiredString(body, "path"));
        const content = await readFile(file, "utf8");
        return { content, bytes: Buffer.byteLength(content) };
      });
    case "/bench/write-file":
      return withAttempt(body, async ({ attemptRoot }) => {
        const relPath = requiredString(body, "path");
        assertWritableWorkspacePath(relPath);
        const file = resolveSafePath(attemptRoot, relPath);
        const content = requiredString(body, "content");
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, content, "utf8");
        return { bytes: Buffer.byteLength(content) };
      });
    case "/bench/patch-file":
      return withAttempt(body, async ({ attemptRoot }) => patchFile(attemptRoot, body));
    case "/bench/run-command":
      return withAttempt(body, async ({ attemptRoot, meta }) => {
        const command = requiredString(body, "command");
        assertAllowedCommand(meta, command);
        return runCommand(command, attemptRoot, optionalTimeout(body));
      });
    case "/bench/run-verifier":
      return withAttempt(body, async ({ attemptRoot, meta }) => runVerifier(attemptRoot, meta, body));
    case "/bench/diff":
      return withAttempt(body, async ({ attemptRoot, meta }) => ({
        diff: await createDiff(attemptRoot, meta.snapshot ?? {}),
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
    default:
      throw new HttpError(404, "Unknown bench endpoint.");
  }
}

async function routeCompat(attemptId, endpoint, body) {
  const attemptRoot = resolveSafeChild(root, attemptId);
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
      return { files: await listWorkspaceFiles(attemptRoot) };
    case "/read": {
      const file = resolveSafePath(attemptRoot, requiredString(body, "path"));
      const content = await readFile(file, "utf8");
      return { content, bytes: Buffer.byteLength(content) };
    }
    case "/read-range":
      return readFileRange(attemptRoot, body);
    case "/write": {
      const relPath = requiredString(body, "path");
      assertWritableWorkspacePath(relPath);
      const file = resolveSafePath(attemptRoot, relPath);
      const content = requiredString(body, "content");
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content, "utf8");
      return { bytes: Buffer.byteLength(content) };
    }
    case "/patch":
      return patchFile(attemptRoot, body);
    case "/append":
      return appendFile(attemptRoot, body);
    case "/search":
      return searchFiles(attemptRoot, body);
    case "/run": {
      const command = requiredString(body, "command");
      assertAllowedCommand(meta, command);
      return runCommand(command, attemptRoot, optionalTimeout(body));
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

  const requestedAttemptId = optionalString(body, "attemptId");
  const attemptId = requestedAttemptId
    ? validateAttemptId(requestedAttemptId)
    : `${sanitizeId(caseId)}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const attemptRoot = resolveSafeChild(root, attemptId);
  if (existsSync(attemptRoot)) {
    throw new HttpError(409, "Bench attempt workspace already exists.");
  }
  await mkdir(attemptRoot, { recursive: true });

  const files = isRecord(body.files) ? body.files : null;
  const repoUrl = optionalString(body, "repoUrl");
  if (files) {
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
  await saveMeta(attemptRoot, meta);
  return { attemptId, caseId, root: attemptRoot };
}

async function patchFile(attemptRoot, body) {
  const relPath = requiredString(body, "path");
  assertWritableWorkspacePath(relPath);
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

async function appendFile(attemptRoot, body) {
  const relPath = requiredString(body, "path");
  assertWritableWorkspacePath(relPath);
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

async function readFileRange(attemptRoot, body) {
  const file = resolveSafePath(attemptRoot, requiredString(body, "path"));
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

async function searchFiles(attemptRoot, body) {
  const query = requiredString(body, "query").toLowerCase();
  const matches = [];
  await walk(attemptRoot, async (file) => {
    if (matches.length >= 100) return;
    let content = "";
    try {
      content = await readFile(file, "utf8");
    } catch {
      return;
    }
    const relPath = toWorkspacePath(attemptRoot, file);
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

async function runVerifier(attemptRoot, meta, body) {
  const command = optionalString(body, "command") ?? meta.verifierCommand;
  if (!command) throw new HttpError(400, "No verifier command configured.");
  assertAllowedCommand(meta, command);
  await assertHarnessFilesUntampered(attemptRoot, meta);
  const result = await runCommand(command, attemptRoot, optionalTimeout(body) ?? meta.timeoutSeconds);
  const resultFile = optionalString(body, "resultFile") ?? meta.verifierResultFile;
  let resultJson = "";
  const artifactIds = [];

  if (resultFile) {
    const file = resolveSafePath(attemptRoot, resultFile);
    try {
      resultJson = await readFile(file, "utf8");
      artifactIds.push(resultFile.replace(/\\/g, "/"));
    } catch {
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

async function cleanup(body) {
  const attemptId = requiredString(body, "attemptId");
  const attemptRoot = resolveSafeChild(root, attemptId);
  await rm(attemptRoot, { recursive: true, force: true });
  return { removed: true };
}

async function withAttempt(body, action) {
  const attemptId = requiredString(body, "attemptId");
  const attemptRoot = resolveSafeChild(root, attemptId);
  const meta = await readMeta(attemptRoot);
  return action({ attemptRoot, meta });
}

async function readMeta(attemptRoot) {
  try {
    const content = await readFile(join(attemptRoot, META_FILE), "utf8");
    const parsed = JSON.parse(content);
    if (!isRecord(parsed)) throw new Error("metadata must be an object");
    return parsed;
  } catch {
    throw new HttpError(404, "Unknown bench attempt.");
  }
}

async function saveMeta(attemptRoot, meta) {
  await writeFile(join(attemptRoot, META_FILE), JSON.stringify(meta, null, 2), "utf8");
}

function runCommand(command, cwd, timeoutSeconds) {
  const started = Date.now();
  return new Promise((resolveCommand) => {
    exec(
      command,
      {
        cwd,
        timeout: Math.max(1, timeoutSeconds ?? 30) * 1000,
        windowsHide: true,
        maxBuffer: MAX_OUTPUT_BYTES * 4,
      },
      (error, stdout, stderr) => {
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
  });
}

async function listWorkspaceFiles(attemptRoot) {
  const files = [];
  await walk(attemptRoot, async (file) => {
    files.push(toWorkspacePath(attemptRoot, file));
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

async function createDiff(attemptRoot, before) {
  const after = await snapshotFiles(attemptRoot);
  const paths = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort();
  const chunks = [];

  for (const path of paths) {
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
    if (entry.name === META_FILE) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, onFile);
    } else if (entry.isFile()) {
      await onFile(fullPath);
    }
  }
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

function isProtectedWorkspaceFile(relPath) {
  if (typeof relPath !== "string") return false;
  const normalized = normalizeWorkspacePath(relPath);
  const base = normalized.split("/").pop() ?? normalized;
  return (
    PROTECTED_WORKSPACE_FILES.has(normalized) ||
    PROTECTED_WORKSPACE_FILES.has(base)
  );
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

function assertWritableWorkspacePath(relPath) {
  if (isProtectedWorkspaceFile(relPath)) {
    throw new HttpError(403, `Refusing to write protected harness file: ${relPath}`);
  }
}

// Verify-time backstop: confirm the verifier's own files still match what
// prepare wrote. Catches tampering through any vector the write guard does not
// cover (e.g. an allowlisted shell command that overwrites case-meta.json).
async function assertHarnessFilesUntampered(attemptRoot, meta) {
  const snapshot = meta?.snapshot ?? {};
  for (const relPath of Object.keys(snapshot)) {
    if (!isProtectedWorkspaceFile(relPath)) continue;
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
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
