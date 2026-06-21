#!/usr/bin/env node
/**
 * AI Board — local command runner.
 *
 * Lets the Build-mode Architect run commands (tests, builds, installs) in YOUR
 * project folder, and fetch public http(s) URLs (runner v3+; local/private
 * addresses are refused). You start it, you can stop it any time (Ctrl+C), and
 * every command/fetch is printed here before it runs. The web app additionally
 * asks for your approval per command unless you chose "Full access".
 *
 * Requires Node.js 18+ (https://nodejs.org). Download this file from the app
 * (Build mode → Local runner → "Download runner.mjs") or use it straight from
 * the repo's scripts/ folder.
 *
 * Usage:
 *   node runner.mjs <project-folder> [--port 8787] [--token <secret>]
 *                   [--mcp "<name>=<command>"]... [--context7 [--context7-key <key>]]
 *                   [--searxng [--searxng-url <url>]]
 *
 * MCP bridge: each --mcp flag spawns a stdio MCP server and exposes its tools
 * to the Architect (with the same per-call approval as commands), e.g.:
 *   --mcp "playwright=npx @playwright/mcp@latest"
 *
 * Context7 shortcut: --context7 bridges the Context7 documentation MCP server
 * (up-to-date library/framework docs) without typing the npx command yourself.
 * An optional API key (higher rate limits) comes from --context7-key <key> or
 * the CONTEXT7_API_KEY environment variable:
 *   node runner.mjs ./my-app --context7
 *   node runner.mjs ./my-app --context7 --context7-key ctx7sk-...
 *
 * SearXNG shortcut: --searxng bridges the mcp-searxng search server as "search".
 * Provide your SearXNG instance with --searxng-url <url> or SEARXNG_URL:
 *   node runner.mjs ./my-app --searxng --searxng-url https://searxng.example
 *
 * Then paste the printed URL + token into the app (Build mode → Local runner).
 *
 * Zero dependencies; binds to 127.0.0.1 only.
 */

import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import {
  tokensMatch,
  isAllowedHost,
  isAllowedOrigin,
  defaultAppOrigins,
  confine,
  listDirs,
  driveRoots,
} from "./runner-lib.mjs";

const VERSION = 8;
const MAX_OUTPUT_BYTES = 200 * 1024;
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const BACKGROUND_STARTUP_MS = 2_000;
const MAX_READ_BYTES = 512 * 1024;
const MAX_PATCH_BYTES = 8 * 1024 * 1024;
const MAX_RANGE_LINES = 400;
const MAX_LIST_ENTRIES = 600;
const FETCH_TIMEOUT_MS = 30 * 1000;
const MAX_FETCH_BYTES = 200 * 1024;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "out",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  ".idea",
  ".vs",
]);

const backgroundProcesses = new Map();

// ── Args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const rootArg = path.resolve(positional[0] ?? process.cwd());
const port = Number(flag("port") ?? 8787);
const token = flag("token") ?? randomBytes(16).toString("hex");
const host = flag("host"); // undefined → loopback-only default

if (!fs.existsSync(rootArg) || !fs.statSync(rootArg).isDirectory()) {
  console.error(`Not a folder: ${rootArg}`);
  process.exit(1);
}
// Canonical folder-browser boundary; `projectDir` is the active working folder
// (mutable at runtime via the panel, always re-confined within `root`).
const root = fs.realpathSync(rootArg);
let projectDir = root;

const extraAppOrigins = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--app-origin" && args[i + 1]) extraAppOrigins.push(args[i + 1]);
}
const appOrigins = defaultAppOrigins(extraAppOrigins);
const allowedOrigins = new Set([
  ...appOrigins,
  `http://127.0.0.1:${port}`,
  `http://localhost:${port}`,
  ...(host ? [`http://${host}:${port}`] : []),
]);

// "<name>=<command>" specs from repeated --mcp flags.
const mcpSpecs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--mcp" && args[i + 1]) {
    const spec = args[i + 1];
    const eq = spec.indexOf("=");
    if (eq > 0) {
      mcpSpecs.push({ name: spec.slice(0, eq).trim(), command: spec.slice(eq + 1).trim() });
    } else {
      console.error(`Ignoring malformed --mcp spec (want name=command): ${spec}`);
    }
  }
}

// Convenience: --context7 bridges the Context7 docs MCP server so the Architect
// can pull current library/framework documentation, without the user having to
// remember the npx command. The optional API key (higher rate limits) comes
// from --context7-key <key> or the CONTEXT7_API_KEY env var. Equivalent to
//   --mcp "context7=npx -y @upstash/context7-mcp [--api-key <key>]"
if (args.includes("--context7")) {
  const apiKey = flag("context7-key") ?? process.env.CONTEXT7_API_KEY;
  const command = `npx -y @upstash/context7-mcp${apiKey ? ` --api-key ${apiKey}` : ""}`;
  if (mcpSpecs.some((s) => s.name === "context7")) {
    console.error('--context7 ignored: an --mcp "context7=..." spec is already set');
  } else {
    mcpSpecs.push({ name: "context7", command });
    console.log(
      `Context7 MCP enabled${apiKey ? " (with API key)" : " (no API key — free-tier rate limits)"}. First start may pause while npx fetches @upstash/context7-mcp.`
    );
  }
}

// Convenience: --searxng bridges the free/privacy-focused mcp-searxng server
// as "search", so the Architect can use web search without remembering the npx
// command. The SearXNG instance URL comes from --searxng-url <url> or the
// SEARXNG_URL env var. Equivalent to:
//   SEARXNG_URL=<url> --mcp "search=npx -y mcp-searxng"
if (args.includes("--searxng")) {
  const searxngUrl = (flag("searxng-url") ?? process.env.SEARXNG_URL ?? "").trim();
  if (!searxngUrl) {
    console.error("--searxng ignored: provide --searxng-url <url> or set SEARXNG_URL");
  } else if (mcpSpecs.some((s) => s.name === "search")) {
    console.error('--searxng ignored: an --mcp "search=..." spec is already set');
  } else {
    process.env.SEARXNG_URL = searxngUrl;
    mcpSpecs.push({ name: "search", command: "npx -y mcp-searxng" });
    console.log(
      `SearXNG MCP enabled as "search" using ${searxngUrl}. First start may pause while npx fetches mcp-searxng.`
    );
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
// Access-Control-Allow-Origin is set per-request (reflected from the allowlist)
// in the request handler, not here — so the static set carries everything else.
const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "content-type,x-runner-token",
  "Access-Control-Max-Age": "600",
};

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", ...CORS_HEADERS });
  res.end(JSON.stringify(body));
}

function authorized(req) {
  const provided = req.headers["x-runner-token"];
  return typeof provided === "string" && tokensMatch(provided, token);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 16 * 1024 * 1024) reject(new Error("Body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** Resolve a relative path strictly inside the project folder (no .. / absolute). */
function safeResolve(relPath) {
  if (typeof relPath !== "string" || !relPath.trim()) return null;
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "").trim();
  if (/^([A-Za-z]:|\/)/.test(normalized)) return null; // absolute
  try {
    // Confine to the active project folder, with realpath hardening against
    // symlink/junction escapes. confine() throws on any escape → null.
    return confine(projectDir, normalized);
  } catch {
    return null;
  }
}

function writeFileInProject(relPath, content) {
  const target = safeResolve(relPath);
  if (!target) throw new Error(`Refusing path outside the project folder: ${relPath}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content ?? "", "utf8");
  return Buffer.byteLength(content ?? "", "utf8");
}

/** Relative paths of all project files (skipping dependency/VCS dirs), capped. */
function listProjectFiles() {
  const files = [];
  const walk = (dir, rel) => {
    if (files.length >= MAX_LIST_ENTRIES) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_LIST_ENTRIES) return;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          walk(path.join(dir, entry.name), relPath);
        }
      } else if (entry.isFile()) {
        files.push(relPath);
      }
    }
  };
  walk(projectDir, "");
  return files.sort();
}

/** Case-insensitive substring search across project files. */
function searchProjectFiles(query) {
  const MAX_RESULTS = 200;
  const results = [];
  const q = String(query).toLowerCase();
  if (!q) return results;
  for (const rel of listProjectFiles()) {
    if (results.length >= MAX_RESULTS) break;
    try {
      const buf = fs.readFileSync(path.join(projectDir, rel));
      if (buf.includes(0) || buf.length > 1_000_000) continue; // binary/huge
      const lines = buf.toString("utf8").split("\n");
      for (let i = 0; i < lines.length && results.length < MAX_RESULTS; i++) {
        if (lines[i].toLowerCase().includes(q)) {
          results.push({ path: rel, line: i + 1, text: lines[i].slice(0, 300) });
        }
      }
    } catch {
      // unreadable file — skip
    }
  }
  return results;
}

/**
 * True for hostnames that point at this machine or the local network — the
 * web-fetch endpoint refuses them so a model can't use it to probe localhost
 * services or the router (basic SSRF guard; literal-IP/name check only).
 */
function isPrivateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h === "::1" || h === "0.0.0.0" || h === "::") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
  }
  if (/^(fe80|fc|fd)/i.test(h)) return true; // IPv6 link-local / ULA
  return false;
}

/** Fetch a public HTTP(S) URL; returns capped text + metadata. */
async function fetchUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Not a valid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http and https URLs are allowed");
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new Error("Refusing to fetch local/private addresses");
  }
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(parsed.href, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "user-agent": "ai-discussion-board-runner/" + VERSION },
    });
  } finally {
    clearTimeout(timer);
  }
  const contentType = response.headers.get("content-type") ?? "";
  let text = "";
  let truncated = false;
  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > MAX_FETCH_BYTES) {
        truncated = true;
        const keep = value.length - (bytes - MAX_FETCH_BYTES);
        text += decoder.decode(value.subarray(0, keep), { stream: true });
        await reader.cancel().catch(() => {});
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
  }
  return {
    status: response.status,
    statusText: response.statusText,
    finalUrl: response.url,
    contentType,
    text,
    durationMs: Date.now() - startedAt,
    truncated,
  };
}

function readFileInProject(relPath) {
  const target = safeResolve(relPath);
  if (!target) throw new Error(`Refusing path outside the project folder: ${relPath}`);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return null;
  const buf = fs.readFileSync(target);
  if (buf.includes(0)) return null; // binary
  return buf.toString("utf8").slice(0, MAX_READ_BYTES);
}

function readFullTextFileInProject(relPath, maxBytes = MAX_PATCH_BYTES) {
  const target = safeResolve(relPath);
  if (!target) throw new Error(`Refusing path outside the project folder: ${relPath}`);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return null;
  const stat = fs.statSync(target);
  if (stat.size > maxBytes) {
    throw new Error(`File is too large for this operation (${stat.size} bytes; cap is ${maxBytes})`);
  }
  const buf = fs.readFileSync(target);
  if (buf.includes(0)) return null;
  return buf.toString("utf8");
}

function readFileRangeInProject(relPath, startLine, lineCount) {
  const content = readFullTextFileInProject(relPath, MAX_PATCH_BYTES);
  if (content == null) return null;
  const lines = content.split("\n");
  const requested = Math.max(1, Math.round(Number(lineCount) || 80));
  const start = Math.max(1, Math.round(Number(startLine) || 1));
  const count = Math.min(MAX_RANGE_LINES, requested);
  const startIdx = Math.min(start - 1, lines.length);
  const selected = lines.slice(startIdx, startIdx + count);
  const endLine = selected.length > 0 ? startIdx + selected.length : startIdx;
  return {
    content: selected.join("\n"),
    startLine: startIdx + 1,
    endLine,
    totalLines: lines.length,
    truncated: requested > count,
    hasMoreBefore: startIdx > 0,
    hasMoreAfter: endLine < lines.length,
  };
}

function fuzzyFindLines(haystack, needle) {
  const hLines = haystack.split("\n");
  const nLines = String(needle).split("\n").map((l) => l.trim());
  if (nLines.length === 0) return null;
  for (let i = 0; i + nLines.length <= hLines.length; i++) {
    let ok = true;
    for (let k = 0; k < nLines.length; k++) {
      if (hLines[i + k].trim() !== nLines[k]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const start = i === 0 ? 0 : hLines.slice(0, i).join("\n").length + 1;
    const end = start + hLines.slice(i, i + nLines.length).join("\n").length;
    return { start, end };
  }
  return null;
}

function applyPatchOps(content, ops) {
  let result = content;
  let applied = 0;
  let failed = 0;
  const failedOps = [];
  for (const [index, op] of ops.entries()) {
    const search = String(op.search ?? "");
    const replace = String(op.replace ?? "");
    const idx = result.indexOf(search);
    if (idx >= 0) {
      result = result.slice(0, idx) + replace + result.slice(idx + search.length);
      applied += 1;
      continue;
    }
    const fuzzy = fuzzyFindLines(result, search);
    if (fuzzy) {
      result = result.slice(0, fuzzy.start) + replace + result.slice(fuzzy.end);
      applied += 1;
    } else {
      failed += 1;
      failedOps.push({
        index: index + 1,
        searchPreview: search.trim().slice(0, 180),
      });
    }
  }
  return { content: result, applied, failed, failedOps };
}

function patchFileInProject(relPath, ops) {
  if (!Array.isArray(ops)) throw new Error("Missing patch ops");
  const validOps = ops.filter(
    (op) =>
      op &&
      typeof op.search === "string" &&
      op.search.length > 0 &&
      typeof op.replace === "string"
  );
  if (validOps.length === 0) throw new Error("No valid patch ops");
  const current = readFullTextFileInProject(relPath, MAX_PATCH_BYTES);
  if (current == null) {
    return { content: null, applied: 0, failed: validOps.length, bytes: 0 };
  }
  const patched = applyPatchOps(current, validOps);
  if (patched.applied > 0) {
    const bytes = writeFileInProject(relPath, patched.content);
    return { ...patched, bytes };
  }
  return { ...patched, bytes: Buffer.byteLength(current, "utf8") };
}

function appendFileInProject(relPath, content, reset) {
  const target = safeResolve(relPath);
  if (!target) throw new Error(`Refusing path outside the project folder: ${relPath}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (reset) {
    fs.writeFileSync(target, content ?? "", "utf8");
  } else {
    fs.appendFileSync(target, content ?? "", "utf8");
  }
  const final = readFullTextFileInProject(relPath, MAX_PATCH_BYTES);
  return {
    content: final,
    bytes: Buffer.byteLength(content ?? "", "utf8"),
    totalBytes: final == null ? 0 : Buffer.byteLength(final, "utf8"),
  };
}

// Strip ANSI escape sequences (color codes etc.) so callers get plain text.
function stripAnsi(text) {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI
    .replace(/\x1b[@-Z\\-_]/g, "") // two-char escapes
    .replace(/\x1b/g, ""); // bare ESC
}

function parseBackgroundCommand(command) {
  const trimmed = command.trim();
  if (!trimmed.endsWith("&") || trimmed.endsWith("&&")) {
    return { background: false, command: trimmed };
  }
  const withoutAmp = trimmed.slice(0, -1).trim();
  return {
    background: withoutAmp.length > 0,
    command: withoutAmp,
  };
}

function startBackgroundCommand(command) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, {
      shell: true,
      cwd: projectDir,
      env: process.env,
      windowsHide: true,
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;
    const cap = (current, chunk) => {
      if (current.length >= MAX_OUTPUT_BYTES) {
        truncated = true;
        return current;
      }
      return current + chunk.toString();
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ...result,
        stdout: stripAnsi(result.stdout.slice(0, MAX_OUTPUT_BYTES)),
        stderr: stripAnsi(result.stderr.slice(0, MAX_OUTPUT_BYTES)),
        durationMs: Date.now() - startedAt,
        truncated,
        background: true,
      });
    };

    child.stdout.on("data", (c) => (stdout = cap(stdout, c)));
    child.stderr.on("data", (c) => (stderr = cap(stderr, c)));
    child.on("close", (code) => {
      backgroundProcesses.delete(child.pid);
      finish({
        exitCode: code ?? -1,
        stdout,
        stderr,
      });
    });
    child.on("error", (err) => {
      backgroundProcesses.delete(child.pid);
      finish({
        exitCode: -1,
        stdout: "",
        stderr: String(err),
      });
    });

    if (child.pid) {
      backgroundProcesses.set(child.pid, { child, command });
    }
    child.unref();

    const timer = setTimeout(() => {
      const pid = child.pid ?? "unknown";
      finish({
        exitCode: 0,
        stdout: [
          `Started background command (pid ${pid}).`,
          "The runner will keep it alive until the runner exits.",
          stdout.trim() ? `Startup stdout:\n${stdout.trim()}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        stderr: stderr.trim() ? `Startup stderr:\n${stderr.trim()}` : "",
      });
    }, BACKGROUND_STARTUP_MS);
  });
}

function runCommand(command) {
  return new Promise((resolve) => {
    const parsed = parseBackgroundCommand(command);
    if (parsed.background) {
      resolve(startBackgroundCommand(parsed.command));
      return;
    }
    const startedAt = Date.now();
    const child = spawn(parsed.command, {
      shell: true,
      cwd: projectDir,
      env: process.env,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    const cap = (current, chunk) => {
      if (current.length >= MAX_OUTPUT_BYTES) {
        truncated = true;
        return current;
      }
      return current + chunk.toString();
    };
    child.stdout.on("data", (c) => (stdout = cap(stdout, c)));
    child.stderr.on("data", (c) => (stderr = cap(stderr, c)));

    const timer = setTimeout(() => {
      truncated = true;
      child.kill("SIGKILL");
    }, COMMAND_TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? -1,
        stdout: stripAnsi(stdout.slice(0, MAX_OUTPUT_BYTES)),
        stderr: stripAnsi(stderr.slice(0, MAX_OUTPUT_BYTES)),
        durationMs: Date.now() - startedAt,
        truncated,
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: -1,
        stdout: "",
        stderr: String(err),
        durationMs: Date.now() - startedAt,
        truncated: false,
      });
    });
  });
}

// ── Git inspection (read-only) ───────────────────────────────────────────────
/** Run git with explicit argv (never a shell string) inside the project folder. */
function runGit(args, opts = {}) {
  const result = spawnSync("git", args, {
    cwd: projectDir,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 30_000,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  return {
    exitCode: typeof result.status === "number" ? result.status : -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// ── GitHub CLI (gh) — explicit argv, NEVER a shell string ────────────────────
/**
 * Resolve the argv prefix used to invoke `gh`. Production returns `["gh"]`
 * (unchanged, shell-free explicit argv). A test-only env override
 * `AIBOARD_GH_CMD` (a JSON array, e.g. `["<node>","<fake-gh.js>"]`) lets the
 * test suite inject a fake `gh` by running the REAL `node` binary against a
 * canned script — the only cross-platform-reliable way to fake `gh` on Windows
 * without `shell:true` (a fake `gh.cmd` on PATH can't be spawned by bare name).
 */
function ghCommand() {
  const override = process.env.AIBOARD_GH_CMD;
  if (override) {
    try {
      const arr = JSON.parse(override);
      if (Array.isArray(arr) && arr.length && arr.every((s) => typeof s === "string")) {
        return arr;
      }
    } catch {
      // fall through to the real gh
    }
  }
  return ["gh"];
}

/**
 * Run `gh` with explicit argv (never a shell string) inside the project folder.
 * A spawn failure (e.g. gh not installed → ENOENT) surfaces as exitCode -1 so
 * callers can degrade gracefully instead of throwing.
 */
function runGh(args, opts = {}) {
  const cmd = ghCommand();
  const result = spawnSync(cmd[0], [...cmd.slice(1), ...args], {
    cwd: projectDir,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 30_000,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  return {
    exitCode: typeof result.status === "number" ? result.status : -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    spawnError: result.error ? String(result.error) : null,
  };
}

/**
 * Caching for GitHub CLI detection. /repo/status is polled many times per build
 * (initial capture, after each wave, around branch-create/commit, the branch-
 * safety gate), and each detection spawns `gh` up to twice — `gh auth status`
 * can even hit the network. So we cache at the runner-process level (reset only
 * on restart):
 *   - `gh --version` availability is INVARIANT for the process lifetime (gh
 *     won't be installed/removed mid-session) → detected once and reused.
 *   - The full githubCli result is TTL-cached (~60s) so auth state stays
 *     reasonably fresh while the steady-state double-spawn drops off every poll.
 */
const GH_CLI_CACHE_TTL_MS = 60 * 1000;
let ghAvailabilityCache = null; // { available, error? } — invariant once known.
let ghCliResultCache = null; // { value, expiresAt } — TTL-cached full result.

/** Detect (and cache) whether `gh` is installed. Invariant for the process. */
function detectGhAvailability() {
  if (ghAvailabilityCache) return ghAvailabilityCache;
  const version = runGh(["--version"]);
  if (version.exitCode !== 0) {
    // Not installed / not on PATH (or fake reporting unavailable).
    const error = version.spawnError || (version.stderr.trim() ? version.stderr.trim() : undefined);
    ghAvailabilityCache = error ? { available: false, error } : { available: false };
  } else {
    ghAvailabilityCache = { available: true };
  }
  return ghAvailabilityCache;
}

/**
 * Detect GitHub CLI availability/auth state. NEVER throws and NEVER lets a
 * missing `gh` fail /repo/status — a spawn ENOENT just reports
 * { available:false, authenticated:false, user:null }. Result is TTL-cached
 * (see GH_CLI_CACHE_TTL_MS); availability is cached for the process lifetime.
 * - `gh --version` → availability.
 * - `gh auth status` → authentication (exit 0 == logged in); parse the
 *   "Logged in to github.com account <user>" / "as <user>" line when present.
 */
function detectGithubCli() {
  if (ghCliResultCache && Date.now() < ghCliResultCache.expiresAt) {
    return ghCliResultCache.value;
  }
  const result = { available: false, authenticated: false, user: null };
  try {
    const availability = detectGhAvailability();
    if (!availability.available) {
      if (availability.error) result.error = availability.error;
      ghCliResultCache = { value: result, expiresAt: Date.now() + GH_CLI_CACHE_TTL_MS };
      return result;
    }
    result.available = true;

    const auth = runGh(["auth", "status"]);
    if (auth.exitCode === 0) {
      result.authenticated = true;
      // gh prints auth info on stderr in some versions and stdout in others.
      const text = `${auth.stdout}\n${auth.stderr}`;
      const m =
        /Logged in to [^\s]+ account ([A-Za-z0-9-]+)/.exec(text) ||
        /Logged in to [^\s]+ as ([A-Za-z0-9-]+)/.exec(text) ||
        /account ([A-Za-z0-9-]+) \(/.exec(text);
      if (m) result.user = m[1];
    }
    ghCliResultCache = { value: result, expiresAt: Date.now() + GH_CLI_CACHE_TTL_MS };
    return result;
  } catch (err) {
    // Defensive: never let detection throw out of /repo/status. Don't cache an
    // unexpected error so the next poll retries.
    result.error = err instanceof Error ? err.message : String(err);
    return result;
  }
}

/** Resolve the repository's default branch (origin/HEAD → main → master → null). */
function detectDefaultBranch() {
  const head = runGit(["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (head.exitCode === 0) {
    const ref = head.stdout.trim(); // refs/remotes/origin/main
    const name = ref.replace(/^refs\/remotes\/origin\//, "");
    if (name) return name;
  }
  for (const candidate of ["main", "master"]) {
    const verify = runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (verify.exitCode === 0) return candidate;
  }
  return null;
}

/** Parse `git remote -v` into a deduped [{ name, url }] list (fetch URLs). */
function parseRemotes() {
  const out = runGit(["remote", "-v"]);
  if (out.exitCode !== 0) return [];
  const seen = new Map();
  for (const line of out.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(trimmed);
    if (!match) continue;
    const [, name, url, kind] = match;
    if (kind === "fetch" || !seen.has(name)) seen.set(name, url);
  }
  return [...seen.entries()].map(([name, url]) => ({ name, url }));
}

/**
 * Parse `git status --porcelain=v1 --branch` into branch + file groupings.
 * The first line is the branch header:
 *   ## main...origin/main [ahead 1, behind 2]
 * Subsequent lines are XY-coded entries; conflicted entries use the
 * unmerged codes (DD, AU, UD, UA, DU, AA, UU).
 */
function parsePorcelainStatus(text) {
  const staged = [];
  const unstaged = [];
  const untracked = [];
  const conflicted = [];
  let upstream = null;
  let ahead = 0;
  let behind = 0;

  const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

  for (const rawLine of text.split("\n")) {
    if (!rawLine) continue;
    if (rawLine.startsWith("## ")) {
      const header = rawLine.slice(3);
      const aheadMatch = /\[.*?ahead (\d+).*?\]/.exec(header);
      const behindMatch = /\[.*?behind (\d+).*?\]/.exec(header);
      if (aheadMatch) ahead = Number(aheadMatch[1]);
      if (behindMatch) behind = Number(behindMatch[1]);
      // "branch...upstream [ahead/behind]" — pull the upstream ref if present.
      const branches = header.split(" ")[0];
      const dots = branches.indexOf("...");
      if (dots >= 0) upstream = branches.slice(dots + 3) || null;
      continue;
    }
    const x = rawLine[0];
    const y = rawLine[1];
    const xy = `${x}${y}`;
    // Porcelain v1 path field starts at column 3; rename arrow "orig -> new".
    let file = rawLine.slice(3);
    const arrow = file.indexOf(" -> ");
    if (arrow >= 0) file = file.slice(arrow + 4);
    if (xy === "??") {
      untracked.push(file);
      continue;
    }
    if (CONFLICT_CODES.has(xy)) {
      conflicted.push(file);
      continue;
    }
    if (x !== " " && x !== "?") staged.push(file);
    if (y !== " " && y !== "?") unstaged.push(file);
  }

  return { staged, unstaged, untracked, conflicted, upstream, ahead, behind };
}

/** Derive an "owner/repo" GitHub slug from the repo's remotes (origin first). */
function originSlugFromRemotes(remotes) {
  const list = Array.isArray(remotes) ? remotes : [];
  const origin = list.find((r) => r && r.name === "origin") || list[0];
  if (!origin || typeof origin.url !== "string") return null;
  const m = origin.url.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

// Existing label names for a repo, TTL-cached (~60s) so adding it to the
// frequently-polled status payload does not spam the GitHub API.
let labelsCache = { slug: "", at: 0, labels: [] };
function listLabelNames(slug) {
  const result = runGh(["api", "-X", "GET", `repos/${slug}/labels?per_page=100`]);
  if (result.exitCode !== 0) return null;
  const parsed = parseGhJson(result.stdout, `labels from ${slug}`);
  return Array.isArray(parsed)
    ? parsed.map((l) => (typeof l?.name === "string" ? l.name : "")).filter(Boolean)
    : [];
}
function getRepoLabels(slug) {
  const now = Date.now();
  if (labelsCache.slug === slug && now - labelsCache.at < 60_000) return labelsCache.labels;
  const labels = listLabelNames(slug) ?? [];
  labelsCache = { slug, at: now, labels };
  return labels;
}

/** Ensure each requested label exists in the repo, creating any that are
 *  missing — so a model can attach a sensible new label without `gh` rejecting
 *  the whole issue. Best-effort: label-create failures (incl. races) are
 *  ignored and the caller's own fallback still applies. */
function ensureLabelsExist(slug, wanted) {
  if (!wanted.length) return;
  const existing = new Set((listLabelNames(slug) ?? []).map((n) => n.toLowerCase()));
  for (const label of wanted) {
    if (existing.has(label.toLowerCase())) continue;
    runGh(["label", "create", label, "--repo", slug, "--color", "ededed"]);
    existing.add(label.toLowerCase());
  }
  labelsCache = { slug: "", at: 0, labels: [] }; // invalidate the status cache
}

/** Build the RunnerRepoStatus payload for the project folder. */
function getRepoStatus() {
  const base = {
    isRepo: false,
    root: null,
    currentBranch: null,
    defaultBranch: null,
    remotes: [],
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    clean: true,
    recentCommits: [],
    gitAvailable: true,
    githubCli: { available: false, authenticated: false, user: null },
    labels: [],
  };

  // GitHub CLI capability detection is independent of the git repo state and
  // must NEVER make /repo/status fail (e.g. when gh is not installed).
  base.githubCli = detectGithubCli();

  const topLevel = runGit(["rev-parse", "--show-toplevel"]);
  if (topLevel.exitCode === -1) {
    // git is not installed / not on PATH.
    return { ...base, gitAvailable: false, clean: false };
  }
  if (topLevel.exitCode !== 0) {
    // git ran but this folder is not inside a repo — not an error.
    return base;
  }

  base.isRepo = true;
  base.root = topLevel.stdout.trim() || null;

  const branch = runGit(["branch", "--show-current"]);
  base.currentBranch = branch.exitCode === 0 && branch.stdout.trim() ? branch.stdout.trim() : null;

  base.defaultBranch = detectDefaultBranch();
  base.remotes = parseRemotes();

  const status = runGit(["status", "--porcelain=v1", "--branch"]);
  if (status.exitCode === 0) {
    const parsed = parsePorcelainStatus(status.stdout);
    base.staged = parsed.staged;
    base.unstaged = parsed.unstaged;
    base.untracked = parsed.untracked;
    base.conflicted = parsed.conflicted;
    base.ahead = parsed.ahead;
    base.behind = parsed.behind;
    base.upstream = parsed.upstream;
  }

  // Prefer the explicit upstream ref when available (more reliable than parsing).
  const upstream = runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (upstream.exitCode === 0 && upstream.stdout.trim()) {
    base.upstream = upstream.stdout.trim();
  }

  base.clean =
    base.staged.length === 0 &&
    base.unstaged.length === 0 &&
    base.untracked.length === 0 &&
    base.conflicted.length === 0;

  const log = runGit(["log", "-5", "--pretty=format:%h%x00%s"]);
  if (log.exitCode === 0 && log.stdout.trim()) {
    base.recentCommits = log.stdout
      .split("\n")
      .map((line) => {
        // git emits "<hash>\x00<subject>" per the %h%x00%s format
        const nul = line.indexOf("\x00");
        if (nul < 0) return null;
        return { hash: line.slice(0, nul), subject: line.slice(nul + 1) };
      })
      .filter(Boolean);
  }

  // Existing GitHub labels, so the Architect can prefer them over inventing new
  // ones. Only when gh is authenticated and the origin is a GitHub repo.
  if (base.githubCli.available && base.githubCli.authenticated) {
    const slug = originSlugFromRemotes(base.remotes);
    if (slug) base.labels = getRepoLabels(slug);
  }

  return base;
}

/** Build a git diff for the project folder, capped at MAX_OUTPUT_BYTES. */
function getRepoDiff({ paths, staged, stat }) {
  const args = ["diff"];
  if (staged) args.push("--cached");
  if (stat) args.push("--stat");

  if (Array.isArray(paths) && paths.length > 0) {
    const resolved = [];
    for (const rel of paths) {
      const target = safeResolve(rel);
      if (!target) {
        throw new Error(`Refusing path outside the project folder: ${rel}`);
      }
      // Pass the sanitized relative form so git scopes to the project folder.
      resolved.push(path.relative(projectDir, target).replace(/\\/g, "/"));
    }
    args.push("--", ...resolved);
  }

  const result = runGit(args);
  if (result.exitCode !== 0 && result.stderr.trim()) {
    throw new Error(result.stderr.trim());
  }
  const full = result.stdout ?? "";
  const bytes = Buffer.byteLength(full, "utf8");
  let diff = full;
  let truncated = false;
  if (bytes > MAX_OUTPUT_BYTES) {
    diff = Buffer.from(full, "utf8").subarray(0, MAX_OUTPUT_BYTES).toString("utf8");
    truncated = true;
  }
  return { diff, truncated, bytes };
}

/**
 * Validate a Git ref name (branch / base) for the typed branch-create endpoint.
 * Mirrors the client-side check in lib/orchestrator/build.ts (isValidGitRefName).
 */
function isValidGitRefName(name) {
  if (typeof name !== "string") return false;
  const value = name.trim();
  if (!value) return false;
  if (value.startsWith("-")) return false;
  if (value.endsWith("/")) return false;
  if (value.includes("..")) return false;
  if (value.includes("//")) return false;
  if (value.includes("@{")) return false;
  if (value.includes("\\")) return false;
  if (/\s/.test(value)) return false;
  return /^[A-Za-z0-9._/-]+$/.test(value);
}

/**
 * Create (and optionally check out) a Git branch via explicit argv. Throws on a
 * validation failure (caller maps to HTTP 400). Returns
 * { branch, previousBranch, checkedOut }.
 */
function createRepoBranch({ name, base, checkout }) {
  if (!isValidGitRefName(name)) {
    throw new Error(
      `Invalid branch name "${name}": use only letters, digits, ".", "_", "/", "-"; no leading "-", no "..", "//", "@{", backslash, whitespace, or trailing "/".`
    );
  }
  if (base !== undefined && base !== null && !isValidGitRefName(base)) {
    throw new Error(`Invalid base ref "${base}".`);
  }

  const topLevel = runGit(["rev-parse", "--show-toplevel"]);
  if (topLevel.exitCode === -1) throw new Error("git is not installed or not on PATH.");
  if (topLevel.exitCode !== 0) throw new Error("The runner folder is not a Git repository.");

  // Refuse when the working tree has unmerged (conflicted) paths.
  const conflicts = runGit(["diff", "--name-only", "--diff-filter=U"]);
  if (conflicts.exitCode === 0 && conflicts.stdout.trim()) {
    throw new Error(
      "The working tree has unmerged paths (conflicts); resolve them before creating a branch."
    );
  }

  // Current branch — null on detached HEAD.
  const current = runGit(["branch", "--show-current"]);
  const previousBranch =
    current.exitCode === 0 && current.stdout.trim() ? current.stdout.trim() : null;

  const shouldCheckout = checkout === undefined ? true : !!checkout;
  if (shouldCheckout) {
    const args = ["switch", "-c", name];
    if (base) args.push(base);
    const created = runGit(args);
    if (created.exitCode !== 0) {
      throw new Error(created.stderr.trim() || created.stdout.trim() || "git switch -c failed.");
    }
  } else {
    const args = ["branch", name];
    if (base) args.push(base);
    const created = runGit(args);
    if (created.exitCode !== 0) {
      throw new Error(created.stderr.trim() || created.stdout.trim() || "git branch failed.");
    }
  }

  return { branch: name, previousBranch, checkedOut: shouldCheckout };
}

/**
 * Stage and commit changes via explicit argv (never a shell string). Throws on a
 * validation / empty-commit failure (caller maps to HTTP 400). Returns
 * { hash, subject, committedFiles }.
 *
 * - `message` must be 1–200 chars after trimming.
 * - When `paths` is provided, each is validated with the same relative-path rules
 *   as the file tools (safeResolve; absolute / ".." rejected) and only those are
 *   staged (`git add -- <paths…>`); otherwise everything is staged (`git add -A`).
 * - Refuses an empty commit (nothing staged after `git add`).
 */
function commitRepo({ message, paths }) {
  const trimmed = typeof message === "string" ? message.trim() : "";
  if (!trimmed) throw new Error("A commit message is required.");
  if (trimmed.length > 200) {
    throw new Error(`Commit message too long (${trimmed.length} chars); keep it to 200 or fewer.`);
  }

  const topLevel = runGit(["rev-parse", "--show-toplevel"]);
  if (topLevel.exitCode === -1) throw new Error("git is not installed or not on PATH.");
  if (topLevel.exitCode !== 0) throw new Error("The runner folder is not a Git repository.");

  // Stage the requested paths (or everything). Validate paths up front so an
  // unsafe path is rejected before any staging happens.
  if (Array.isArray(paths) && paths.length > 0) {
    const resolved = [];
    for (const rel of paths) {
      const target = safeResolve(rel);
      if (!target) {
        throw new Error(`Refusing path outside the project folder: ${rel}`);
      }
      resolved.push(path.relative(projectDir, target).replace(/\\/g, "/"));
    }
    const allowed = new Set(resolved.map((p) => p.toLowerCase()));
    const stagedBefore = runGit(["diff", "--cached", "--name-only"]);
    if (stagedBefore.exitCode !== 0) {
      throw new Error(
        stagedBefore.stderr.trim() ||
          stagedBefore.stdout.trim() ||
          "git diff --cached failed."
      );
    }
    const unrelatedStaged = stagedBefore.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((file) => !allowed.has(file.replace(/\\/g, "/").toLowerCase()));
    if (unrelatedStaged.length > 0) {
      throw new Error(
        `Refusing scoped commit because unrelated files are already staged: ${unrelatedStaged
          .slice(0, 8)
          .join(", ")}${unrelatedStaged.length > 8 ? ", ..." : ""}. Commit or unstage them first.`
      );
    }
    const add = runGit(["add", "--", ...resolved]);
    if (add.exitCode !== 0) {
      throw new Error(add.stderr.trim() || add.stdout.trim() || "git add failed.");
    }
  } else {
    const add = runGit(["add", "-A"]);
    if (add.exitCode !== 0) {
      throw new Error(add.stderr.trim() || add.stdout.trim() || "git add -A failed.");
    }
  }

  // Refuse an empty commit: --quiet exits 0 when there's nothing staged.
  const staged = runGit(["diff", "--cached", "--quiet"]);
  if (staged.exitCode === 0) {
    throw new Error("No staged changes to commit (empty commit). Make changes before committing.");
  }

  const commit = runGit(["commit", "-m", trimmed]);
  if (commit.exitCode !== 0) {
    throw new Error(commit.stderr.trim() || commit.stdout.trim() || "git commit failed.");
  }

  const hashOut = runGit(["rev-parse", "--short", "HEAD"]);
  const hash = hashOut.exitCode === 0 ? hashOut.stdout.trim() : "";
  const subjectOut = runGit(["log", "-1", "--pretty=format:%s"]);
  const subject = subjectOut.exitCode === 0 ? subjectOut.stdout.trim() : trimmed;
  // `--root` is required so the FIRST (parentless) commit reports its files;
  // without it diff-tree prints nothing for a root commit.
  const filesOut = runGit(["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", "HEAD"]);
  const committedFiles =
    filesOut.exitCode === 0
      ? filesOut.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
      : [];

  return { hash, subject, committedFiles };
}

// ── GitHub workflow (issue import / push / draft PR) ─────────────────────────
/**
 * Marker for client-side validation failures (bad input) so endpoint handlers
 * can return HTTP 400, distinct from gh/git execution failures (HTTP 502/400).
 */
class ValidationError extends Error {}

// Mirrors `isValidRepoSlug` in lib/orchestrator/build.ts (the client validates
// the same rule before dispatch; the runner can't import it) — keep in lockstep.
const REPO_SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REMOTE_NAME_RE = /^[A-Za-z0-9._/-]+$/;
const MAX_PR_BODY_BYTES = 20 * 1024; // 20 KB cap on issue/PR body text.
// Matches build.ts's REPO_COMMIT_MESSAGE_MAX (the runner can't import it).
const MAX_PR_TITLE_CHARS = 200;
const MAX_ISSUE_TITLE_CHARS = 200;
const MAX_MILESTONE_TITLE_CHARS = 200;

/** Validate an `owner/repo` slug for the gh-backed endpoints. */
function isValidRepoSlug(repo) {
  return typeof repo === "string" && REPO_SLUG_RE.test(repo.trim());
}

function cleanLabels(labels) {
  if (!Array.isArray(labels)) return [];
  return labels
    .filter((label) => typeof label === "string")
    .map((label) => label.trim())
    .filter((label) => label.length > 0 && label.length <= 80)
    .slice(0, 10);
}

function validateRepoSlug(repo) {
  if (!isValidRepoSlug(repo)) {
    throw new ValidationError(`Invalid repo "${repo}": expected "owner/name" (letters, digits, ".", "_", "-").`);
  }
  return repo.trim();
}

function parseGhJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`Could not parse GitHub CLI JSON for ${label}.`);
  }
}

function parseIssueUrl(url) {
  const match = /\/issues\/(\d+)(?:\D|$)/.exec(String(url));
  return match ? Number(match[1]) : 0;
}

/** Validate a remote name for `git push` (simple safe token, no leading dash). */
function isValidRemoteName(remote) {
  if (typeof remote !== "string") return false;
  const value = remote.trim();
  if (!value || value.startsWith("-")) return false;
  return REMOTE_NAME_RE.test(value);
}

/**
 * Read a GitHub issue via `gh issue view` (explicit argv). Throws on validation
 * failure (caller maps to HTTP 400) or when gh fails / is unavailable (caller
 * maps to HTTP 502). Returns { repo, issue, title, body, url, comments }.
 */
function readIssue({ repo, issue }) {
  const slug = validateRepoSlug(repo);
  if (!Number.isInteger(issue) || issue <= 0) {
    throw new ValidationError(`Invalid issue number "${issue}": expected a positive integer.`);
  }

  const result = runGh([
    "issue",
    "view",
    String(issue),
    "--repo",
    slug,
    "--json",
    "title,body,url,comments",
  ]);
  if (result.exitCode !== 0) {
    const detail = result.spawnError || result.stderr.trim() || result.stdout.trim() || "gh issue view failed.";
    throw new Error(`GitHub CLI failed to read issue #${issue} from ${slug}: ${detail}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Could not parse gh issue JSON for #${issue} from ${slug}.`);
  }

  const comments = Array.isArray(parsed?.comments)
    ? parsed.comments.map((c) => ({
        author: typeof c?.author?.login === "string" ? c.author.login : "",
        body: typeof c?.body === "string" ? c.body : "",
        createdAt: typeof c?.createdAt === "string" ? c.createdAt : "",
      }))
    : [];

  return {
    repo: slug,
    issue,
    title: typeof parsed?.title === "string" ? parsed.title : "",
    body: typeof parsed?.body === "string" ? parsed.body : "",
    url: typeof parsed?.url === "string" ? parsed.url : "",
    comments,
  };
}

function listIssues({ repo, labels, limit }) {
  const slug = validateRepoSlug(repo);
  const issueLimit = Number.isInteger(limit) ? Math.max(1, Math.min(50, limit)) : 20;
  const args = [
    "issue",
    "list",
    "--repo",
    slug,
    "--state",
    "open",
    "--limit",
    String(issueLimit),
    "--json",
    "number,title,body,url,labels,updatedAt",
  ];
  for (const label of cleanLabels(labels)) {
    args.push("--label", label);
  }
  const result = runGh(args);
  if (result.exitCode !== 0) {
    const detail = result.spawnError || result.stderr.trim() || result.stdout.trim() || "gh issue list failed.";
    throw new Error(`GitHub CLI failed to list issues from ${slug}: ${detail}`);
  }
  const parsed = parseGhJson(result.stdout, `issues from ${slug}`);
  const issues = Array.isArray(parsed)
    ? parsed.map((item) => ({
        number: typeof item?.number === "number" ? item.number : 0,
        title: typeof item?.title === "string" ? item.title : "",
        body: typeof item?.body === "string" ? item.body : "",
        url: typeof item?.url === "string" ? item.url : "",
        updatedAt: typeof item?.updatedAt === "string" ? item.updatedAt : "",
        labels: Array.isArray(item?.labels)
          ? item.labels
              .map((label) => (typeof label?.name === "string" ? label.name : ""))
              .filter(Boolean)
          : [],
      }))
    : [];
  return { repo: slug, issues };
}

function listMilestones(slug) {
  // GET with the query string in the path. Using `-f`/`--field` here would make
  // `gh api` switch to POST (hitting the create endpoint → 422), so pass the
  // parameters in the URL and force the method to GET explicitly.
  const result = runGh([
    "api",
    "-X",
    "GET",
    `repos/${slug}/milestones?state=all&per_page=100`,
  ]);
  if (result.exitCode !== 0) {
    const detail = result.spawnError || result.stderr.trim() || result.stdout.trim() || "gh api milestones failed.";
    throw new Error(`GitHub CLI failed to list milestones from ${slug}: ${detail}`);
  }
  const parsed = parseGhJson(result.stdout, `milestones from ${slug}`);
  return Array.isArray(parsed) ? parsed : [];
}

function createMilestone({ repo, title, description }) {
  const slug = validateRepoSlug(repo);
  const trimmedTitle = typeof title === "string" ? title.trim() : "";
  if (!trimmedTitle) throw new ValidationError("A milestone title is required.");
  if (trimmedTitle.length > MAX_MILESTONE_TITLE_CHARS) {
    throw new ValidationError(
      `Milestone title too long (${trimmedTitle.length} chars); keep it to ${MAX_MILESTONE_TITLE_CHARS} or fewer.`
    );
  }
  const existing = listMilestones(slug).find(
    (m) => typeof m?.title === "string" && m.title.toLowerCase() === trimmedTitle.toLowerCase()
  );
  if (existing) {
    return {
      repo: slug,
      title: existing.title,
      number: typeof existing.number === "number" ? existing.number : 0,
      url: typeof existing.html_url === "string" ? existing.html_url : "",
      created: false,
    };
  }
  const body = typeof description === "string" ? description : "";
  const result = runGh([
    "api",
    `repos/${slug}/milestones`,
    "-X",
    "POST",
    "-f",
    `title=${trimmedTitle}`,
    "-f",
    `description=${body}`,
  ]);
  if (result.exitCode !== 0) {
    const detail = result.spawnError || result.stderr.trim() || result.stdout.trim() || "gh api milestone create failed.";
    throw new Error(`GitHub CLI failed to create milestone "${trimmedTitle}" in ${slug}: ${detail}`);
  }
  const parsed = parseGhJson(result.stdout, `created milestone ${trimmedTitle}`);
  return {
    repo: slug,
    title: typeof parsed?.title === "string" ? parsed.title : trimmedTitle,
    number: typeof parsed?.number === "number" ? parsed.number : 0,
    url: typeof parsed?.html_url === "string" ? parsed.html_url : "",
    created: true,
  };
}

function createIssue({ repo, title, body, milestone, labels }) {
  const slug = validateRepoSlug(repo);
  const trimmedTitle = typeof title === "string" ? title.trim() : "";
  if (!trimmedTitle) throw new ValidationError("An issue title is required.");
  if (trimmedTitle.length > MAX_ISSUE_TITLE_CHARS) {
    throw new ValidationError(
      `Issue title too long (${trimmedTitle.length} chars); keep it to ${MAX_ISSUE_TITLE_CHARS} or fewer.`
    );
  }
  const issueBody = typeof body === "string" ? body : "";
  if (Buffer.byteLength(issueBody, "utf8") > MAX_PR_BODY_BYTES) {
    throw new ValidationError(`Issue body too large (> ${MAX_PR_BODY_BYTES} bytes); shorten it.`);
  }
  const args = ["issue", "create", "--repo", slug, "--title", trimmedTitle, "--body", issueBody];
  const milestoneTitle = typeof milestone === "string" ? milestone.trim() : "";
  if (milestoneTitle) args.push("--milestone", milestoneTitle);
  // Auto-create any requested labels that don't exist yet, so a model can attach
  // a sensible new label without `gh` rejecting the whole issue. The model is
  // told the existing labels (via repo status) and asked to prefer them.
  const wanted = cleanLabels(labels);
  if (wanted.length > 0) ensureLabelsExist(slug, wanted);
  const labelArgs = [];
  for (const label of wanted) {
    labelArgs.push("--label", label);
  }
  let result = runGh([...args, ...labelArgs]);
  // Safety net: if a label still can't be applied (e.g. creation raced/failed),
  // don't lose the whole issue — retry once without any labels so the issue
  // (and its milestone link) still lands.
  if (
    result.exitCode !== 0 &&
    labelArgs.length > 0 &&
    /label/i.test(result.stderr || result.stdout || "")
  ) {
    result = runGh(args);
  }
  if (result.exitCode !== 0) {
    const detail = result.spawnError || result.stderr.trim() || result.stdout.trim() || "gh issue create failed.";
    throw new Error(`GitHub CLI failed to create issue "${trimmedTitle}" in ${slug}: ${detail}`);
  }
  const url = result.stdout.trim().split(/\s+/).find((part) => /^https?:\/\//.test(part)) ?? result.stdout.trim();
  return {
    repo: slug,
    issue: parseIssueUrl(url),
    title: trimmedTitle,
    url,
  };
}

/**
 * Push a branch via explicit git argv (this is GIT, not gh — no network mocking
 * needed beyond a local bare remote). Throws on validation failure (HTTP 400) or
 * a git push failure (HTTP 400). Returns { remote, branch, setUpstream, output }.
 */
function pushRepo({ remote, branch, setUpstream }) {
  // Validate, then use the TRIMMED value in argv (mirrors trimmedTitle / commitRepo).
  const remoteRaw = remote === undefined || remote === null || remote === "" ? "origin" : remote;
  if (!isValidRemoteName(remoteRaw)) {
    throw new ValidationError(`Invalid remote "${remoteRaw}": use only letters, digits, ".", "_", "/", "-"; no leading "-".`);
  }
  if (!isValidGitRefName(branch)) {
    throw new ValidationError(`Invalid branch name "${branch}": not a valid git ref.`);
  }
  const remoteName = remoteRaw.trim();
  const branchName = branch.trim();

  const topLevel = runGit(["rev-parse", "--show-toplevel"]);
  if (topLevel.exitCode === -1) throw new Error("git is not installed or not on PATH.");
  if (topLevel.exitCode !== 0) throw new Error("The runner folder is not a Git repository.");

  const args = ["push"];
  if (setUpstream) args.push("-u");
  args.push(remoteName, branchName);

  const result = runGit(args);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "git push failed.");
  }
  // git push reports progress on stderr; echo a trimmed combined output.
  const output = `${result.stdout}\n${result.stderr}`.trim();
  return { remote: remoteName, branch: branchName, setUpstream: !!setUpstream, output };
}

/**
 * Create a (draft) pull request via `gh pr create` (explicit argv). Throws on
 * validation failure (HTTP 400) or a gh failure / unavailability (HTTP 502).
 * Returns { url, title, base, head, draft }.
 */
function createPr({ repo, title, body, base, head, draft }) {
  const trimmedTitle = typeof title === "string" ? title.trim() : "";
  if (!trimmedTitle) throw new ValidationError("A PR title is required.");
  if (trimmedTitle.length > MAX_PR_TITLE_CHARS) {
    throw new ValidationError(
      `PR title too long (${trimmedTitle.length} chars); keep it to ${MAX_PR_TITLE_CHARS} or fewer.`
    );
  }
  const prBody = typeof body === "string" ? body : "";
  if (Buffer.byteLength(prBody, "utf8") > MAX_PR_BODY_BYTES) {
    // Reject (don't silently truncate) so the caller knows the body was too big.
    throw new ValidationError(`PR body too large (> ${MAX_PR_BODY_BYTES} bytes); shorten it.`);
  }
  if (repo !== undefined && repo !== null && !isValidRepoSlug(repo)) {
    throw new ValidationError(`Invalid repo "${repo}": expected "owner/name".`);
  }
  if (base !== undefined && base !== null && !isValidGitRefName(base)) {
    throw new ValidationError(`Invalid base ref "${base}".`);
  }
  if (head !== undefined && head !== null && !isValidGitRefName(head)) {
    throw new ValidationError(`Invalid head ref "${head}".`);
  }
  // Use TRIMMED values in argv (mirrors trimmedTitle); validators already
  // accept space-padded input, so normalise before handing to gh.
  const repoSlug = repo ? repo.trim() : null;
  const baseRef = base ? base.trim() : null;
  const headRef = head ? head.trim() : null;

  const args = ["pr", "create", "--title", trimmedTitle, "--body", prBody];
  if (repoSlug) args.push("--repo", repoSlug);
  if (baseRef) args.push("--base", baseRef);
  if (headRef) args.push("--head", headRef);
  if (draft) args.push("--draft");

  const result = runGh(args);
  if (result.exitCode !== 0) {
    const detail = result.spawnError || result.stderr.trim() || result.stdout.trim() || "gh pr create failed.";
    throw new Error(`GitHub CLI failed to create the PR: ${detail}`);
  }
  // gh prints the created PR URL on stdout (possibly amid other lines).
  const urlMatch = /(https?:\/\/\S*\/pull\/\d+|https?:\/\/\S+)/.exec(result.stdout.trim());
  const url = urlMatch ? urlMatch[1] : result.stdout.trim();
  return { url, title: trimmedTitle, base: baseRef, head: headRef, draft: !!draft };
}

// ── MCP bridge: stdio MCP servers exposed over this runner's HTTP ────────────
const MCP_CALL_TIMEOUT_MS = 120 * 1000;
const MCP_INIT_TIMEOUT_MS = 60 * 1000;

class McpServer {
  constructor(name, command) {
    this.name = name;
    this.command = command;
    this.status = "starting"; // starting | ready | error
    this.error = null;
    this.tools = [];
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = "";

    this.child = spawn(command, {
      shell: true,
      cwd: projectDir,
      env: process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.stderr.on("data", (chunk) => {
      const line = chunk.toString().trim();
      if (line) console.log(`[mcp:${name}] ${line.slice(0, 300)}`);
    });
    this.child.on("close", (code) => {
      this.status = "error";
      this.error = `MCP server exited (code ${code})`;
      for (const [, p] of this.pending) p.reject(new Error(this.error));
      this.pending.clear();
    });
    this.child.on("error", (err) => {
      this.status = "error";
      this.error = String(err);
    });
  }

  onData(chunk) {
    this.buffer += chunk.toString();
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl < 0) break;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // non-JSON noise on stdout
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? "MCP error"));
        else p.resolve(msg.result);
      }
      // Server-initiated requests/notifications are ignored by this bridge.
    }
  }

  send(msg) {
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  request(method, params, timeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async init() {
    try {
      await this.request(
        "initialize",
        {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "ai-discussion-board-runner", version: String(VERSION) },
        },
        MCP_INIT_TIMEOUT_MS
      );
      this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const listed = await this.request("tools/list", {}, MCP_INIT_TIMEOUT_MS);
      this.tools = Array.isArray(listed?.tools) ? listed.tools : [];
      this.status = "ready";
      console.log(`[mcp:${this.name}] ready — ${this.tools.length} tool(s)`);
    } catch (err) {
      this.status = "error";
      this.error = err instanceof Error ? err.message : String(err);
      console.error(`[mcp:${this.name}] failed to start: ${this.error}`);
    }
  }

  async callTool(toolName, toolArgs) {
    const result = await this.request(
      "tools/call",
      { name: toolName, arguments: toolArgs ?? {} },
      MCP_CALL_TIMEOUT_MS
    );
    const content = Array.isArray(result?.content) ? result.content : [];
    const text = content
      .map((c) => (c?.type === "text" ? c.text : `[${c?.type ?? "unknown"} content]`))
      .join("\n");
    return { text: text.slice(0, 50_000), isError: !!result?.isError };
  }

  kill() {
    try {
      this.child.kill();
    } catch {
      // already gone
    }
  }
}

const mcpServers = new Map();
for (const spec of mcpSpecs) {
  const proc = new McpServer(spec.name, spec.command);
  mcpServers.set(spec.name, proc);
  void proc.init();
}

function killBackgroundProcesses() {
  for (const [pid, proc] of backgroundProcesses) {
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } else {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          proc.child.kill();
        }
      }
    } catch {
      // already gone
    }
    backgroundProcesses.delete(pid);
  }
}

process.on("SIGINT", () => {
  killBackgroundProcesses();
  for (const [, s] of mcpServers) s.kill();
  process.exit(0);
});

process.on("SIGTERM", () => {
  killBackgroundProcesses();
  for (const [, s] of mcpServers) s.kill();
  process.exit(0);
});

// ── Server ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const originAllowed = isAllowedOrigin(origin, allowedOrigins);
  if (origin && originAllowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // Request guard (runs before auth): the Host allowlist defeats DNS-rebinding
  // (a page that rebinds a name to our address sends a foreign Host); the Origin
  // allowlist blocks cross-site (CSRF) drive-by use of a leaked token.
  if (!isAllowedHost(req.headers.host, { port, host }) || !originAllowed) {
    json(res, 403, { error: "Forbidden host or origin" });
    return;
  }

  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

  if (!authorized(req)) {
    json(res, 401, { error: "Invalid or missing token" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    json(res, 200, {
      ok: true,
      version: VERSION,
      dir: path.basename(projectDir),
      platform: process.platform,
      canWrite: true,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/ls") {
    try {
      json(res, 200, { ok: true, files: listProjectFiles() });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : "List failed" });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/mcp/servers") {
    json(res, 200, {
      ok: true,
      servers: [...mcpServers.values()].map((s) => ({
        name: s.name,
        status: s.status,
        error: s.error,
        tools: s.tools.map((t) => ({
          name: t.name,
          description: t.description ?? "",
          inputSchema: t.inputSchema ?? null,
        })),
      })),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/mcp/call") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { error: "Invalid JSON body" });
      return;
    }
    const serverProc = mcpServers.get(String(body?.server ?? ""));
    if (!serverProc) {
      json(res, 404, { error: `Unknown MCP server: ${body?.server}` });
      return;
    }
    if (serverProc.status !== "ready") {
      json(res, 503, { error: serverProc.error ?? "MCP server is not ready" });
      return;
    }
    if (typeof body?.tool !== "string" || !body.tool.trim()) {
      json(res, 400, { error: "Missing tool name" });
      return;
    }
    let argsPreview = "{}";
    try {
      argsPreview = JSON.stringify(body.args ?? {});
      if (argsPreview.length > 200) argsPreview = `${argsPreview.slice(0, 200)}…`;
    } catch {
      argsPreview = "{…unserializable…}";
    }
    const mcpStartedAt = Date.now();
    console.log(
      `[mcp:${serverProc.name}] ${new Date().toLocaleTimeString()}  call ${body.tool} ${argsPreview}`
    );
    try {
      const result = await serverProc.callTool(body.tool, body.args);
      console.log(
        `      ${result.isError ? "tool ERROR" : "ok"} — ${result.text.length} chars in ${((Date.now() - mcpStartedAt) / 1000).toFixed(1)}s`
      );
      json(res, 200, { ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "MCP call failed";
      console.log(`      FAILED in ${((Date.now() - mcpStartedAt) / 1000).toFixed(1)}s: ${message}`);
      json(res, 500, { error: message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/search") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { error: "Invalid JSON body" });
      return;
    }
    if (typeof body?.query !== "string" || !body.query.trim()) {
      json(res, 400, { error: "Missing query" });
      return;
    }
    const results = searchProjectFiles(body.query.trim());
    console.log(
      `[search] ${new Date().toLocaleTimeString()}  "${body.query.trim().slice(0, 120)}" (${results.length} match${results.length === 1 ? "" : "es"})`
    );
    json(res, 200, { ok: true, results });
    return;
  }

  if (req.method === "POST" && url.pathname === "/read") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { error: "Invalid JSON body" });
      return;
    }
    try {
      const content = readFileInProject(body?.path);
      const detail =
        typeof content === "string"
          ? `${Buffer.byteLength(content, "utf8")} B`
          : "missing/binary";
      console.log(`[read] ${new Date().toLocaleTimeString()}  ${body?.path} (${detail})`);
      json(res, 200, { ok: true, content }); // content null = missing/binary
    } catch (err) {
      const message = err instanceof Error ? err.message : "Read failed";
      console.log(`[read:error] ${new Date().toLocaleTimeString()}  ${body?.path}: ${message}`);
      json(res, 400, { error: message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/read-range") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { error: "Invalid JSON body" });
      return;
    }
    try {
      const result = readFileRangeInProject(body?.path, body?.startLine, body?.lineCount);
      const detail =
        typeof result.content === "string"
          ? `lines ${result.startLine}-${result.endLine} of ${result.totalLines}${result.truncated ? ", capped" : result.hasMoreBefore || result.hasMoreAfter ? ", partial" : ""}`
          : "missing/binary";
      console.log(`[read-range] ${new Date().toLocaleTimeString()}  ${body?.path} (${detail})`);
      json(res, 200, { ok: true, ...result }); // null fields mean missing/binary
    } catch (err) {
      const message = err instanceof Error ? err.message : "Read range failed";
      console.log(`[read-range:error] ${new Date().toLocaleTimeString()}  ${body?.path}: ${message}`);
      json(res, 400, { error: message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/write") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { error: "Invalid JSON body" });
      return;
    }
    try {
      const bytes = writeFileInProject(body?.path, body?.content);
      console.log(`[write] ${new Date().toLocaleTimeString()}  ${body.path} (${bytes} B)`);
      json(res, 200, { ok: true, bytes });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Write failed";
      console.log(`[write:error] ${new Date().toLocaleTimeString()}  ${body?.path}: ${message}`);
      json(res, 400, { error: message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/patch") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { error: "Invalid JSON body" });
      return;
    }
    try {
      const result = patchFileInProject(body?.path, body?.ops);
      console.log(
        `[patch] ${new Date().toLocaleTimeString()}  ${body.path} (${result.applied} applied, ${result.failed} failed)`
      );
      json(res, 200, { ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Patch failed";
      console.log(`[patch:error] ${new Date().toLocaleTimeString()}  ${body?.path}: ${message}`);
      json(res, 400, { error: message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/append") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { error: "Invalid JSON body" });
      return;
    }
    try {
      const result = appendFileInProject(body?.path, body?.content, !!body?.reset);
      console.log(
        `[append] ${new Date().toLocaleTimeString()}  ${body.path} (+${result.bytes} B${body?.reset ? ", reset" : ""})`
      );
      json(res, 200, { ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Append failed";
      console.log(`[append:error] ${new Date().toLocaleTimeString()}  ${body?.path}: ${message}`);
      json(res, 400, { error: message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/fetch") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { error: "Invalid JSON body" });
      return;
    }
    if (typeof body?.url !== "string" || !body.url.trim()) {
      json(res, 400, { error: "Missing url" });
      return;
    }
    console.log(`[fetch] ${new Date().toLocaleTimeString()}  ${body.url.trim()}`);
    try {
      const result = await fetchUrl(body.url.trim());
      console.log(
        `      HTTP ${result.status} ${result.statusText} — ${result.text.length} chars in ${(result.durationMs / 1000).toFixed(1)}s${result.truncated ? " (truncated)" : ""}`
      );
      json(res, 200, { ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Fetch failed";
      console.log(`      FAILED: ${message}`);
      json(res, 400, { error: message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/run") {
    let command;
    try {
      command = JSON.parse(await readBody(req))?.command;
    } catch {
      json(res, 400, { error: "Invalid JSON body" });
      return;
    }
    if (typeof command !== "string" || !command.trim()) {
      json(res, 400, { error: "Missing command" });
      return;
    }
    console.log(`[run] ${new Date().toLocaleTimeString()}  ${command}`);
    const result = await runCommand(command.trim());
    console.log(
      `      exit ${result.exitCode} in ${(result.durationMs / 1000).toFixed(1)}s${result.truncated ? " (output truncated)" : ""}`
    );
    json(res, 200, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/repo/status") {
    try {
      const status = getRepoStatus();
      console.log(
        `[repo/status] ${new Date().toLocaleTimeString()}  isRepo=${status.isRepo} branch=${status.currentBranch ?? "-"} clean=${status.clean}`
      );
      json(res, 200, { ok: true, ...status });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Repo status failed";
      console.log(`[repo/status:error] ${new Date().toLocaleTimeString()}  ${message}`);
      json(res, 500, { error: message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/repo/diff") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { error: "Invalid JSON body" });
      return;
    }
    try {
      const result = getRepoDiff({
        paths: body?.paths,
        staged: !!body?.staged,
        stat: !!body?.stat,
      });
      console.log(
        `[repo/diff] ${new Date().toLocaleTimeString()}  ${body?.staged ? "staged" : "unstaged"}${body?.stat ? " stat" : ""} (${result.bytes} B${result.truncated ? ", truncated" : ""})`
      );
      json(res, 200, { ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Repo diff failed";
      console.log(`[repo/diff:error] ${new Date().toLocaleTimeString()}  ${message}`);
      json(res, 400, { error: message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/repo/branch-create") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { error: "Invalid JSON body" });
      return;
    }
    try {
      const result = createRepoBranch({
        name: body?.name,
        base: body?.base,
        checkout: body?.checkout,
      });
      console.log(
        `[repo/branch-create] ${new Date().toLocaleTimeString()}  ${result.branch} (from ${result.previousBranch ?? "detached HEAD"})${result.checkedOut ? " [checked out]" : ""}`
      );
      json(res, 200, { ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Branch create failed";
      console.log(`[repo/branch-create:error] ${new Date().toLocaleTimeString()}  ${message}`);
      json(res, 400, { error: message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/repo/commit") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { error: "Invalid JSON body" });
      return;
    }
    try {
      const result = commitRepo({ message: body?.message, paths: body?.paths });
      console.log(
        `[repo/commit] ${new Date().toLocaleTimeString()}  ${result.hash} ${result.subject} (${result.committedFiles.length} file(s))`
      );
      json(res, 200, { ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Commit failed";
      console.log(`[repo/commit:error] ${new Date().toLocaleTimeString()}  ${message}`);
      json(res, 400, { error: message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/repo/issue-list") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { error: "Invalid JSON body" });
      return;
    }
    try {
      const result = listIssues({
        repo: body?.repo,
        labels: body?.labels,
        limit: body?.limit,
      });
      console.log(
        `[repo/issue-list] ${new Date().toLocaleTimeString()}  ${result.repo} (${result.issues.length} issue(s))`
      );
      json(res, 200, { ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Issue list failed";
      const status = err instanceof ValidationError ? 400 : 502;
      console.log(`[repo/issue-list:error] ${new Date().toLocaleTimeString()}  (${status}) ${message}`);
      json(res, status, { error: message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/repo/milestone-create") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { error: "Invalid JSON body" });
      return;
    }
    try {
      const result = createMilestone({
        repo: body?.repo,
        title: body?.title,
        description: body?.description,
      });
      console.log(
        `[repo/milestone-create] ${new Date().toLocaleTimeString()}  ${result.repo} "${result.title}"${result.created ? "" : " [existing]"}`
      );
      json(res, 200, { ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Milestone create failed";
      const status = err instanceof ValidationError ? 400 : 502;
      console.log(`[repo/milestone-create:error] ${new Date().toLocaleTimeString()}  (${status}) ${message}`);
      json(res, status, { error: message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/repo/issue-create") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { error: "Invalid JSON body" });
      return;
    }
    try {
      const result = createIssue({
        repo: body?.repo,
        title: body?.title,
        body: body?.body,
        milestone: body?.milestone,
        labels: body?.labels,
      });
      console.log(
        `[repo/issue-create] ${new Date().toLocaleTimeString()}  ${result.repo}#${result.issue || "?"} "${result.title}"`
      );
      json(res, 200, { ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Issue create failed";
      const status = err instanceof ValidationError ? 400 : 502;
      console.log(`[repo/issue-create:error] ${new Date().toLocaleTimeString()}  (${status}) ${message}`);
      json(res, status, { error: message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/repo/issue-read") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { error: "Invalid JSON body" });
      return;
    }
    try {
      const result = readIssue({ repo: body?.repo, issue: body?.issue });
      console.log(
        `[repo/issue-read] ${new Date().toLocaleTimeString()}  ${result.repo}#${result.issue} "${result.title}" (${result.comments.length} comment(s))`
      );
      json(res, 200, { ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Issue read failed";
      // Bad input → 400; gh/network failure → 502 (upstream error).
      const status = err instanceof ValidationError ? 400 : 502;
      console.log(`[repo/issue-read:error] ${new Date().toLocaleTimeString()}  (${status}) ${message}`);
      json(res, status, { error: message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/repo/push") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { error: "Invalid JSON body" });
      return;
    }
    try {
      const result = pushRepo({
        remote: body?.remote,
        branch: body?.branch,
        setUpstream: !!body?.setUpstream,
      });
      console.log(
        `[repo/push] ${new Date().toLocaleTimeString()}  ${result.remote} ${result.branch}${result.setUpstream ? " -u" : ""}`
      );
      json(res, 200, { ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Push failed";
      console.log(`[repo/push:error] ${new Date().toLocaleTimeString()}  ${message}`);
      json(res, 400, { error: message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/repo/pr-create") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { error: "Invalid JSON body" });
      return;
    }
    try {
      const result = createPr({
        repo: body?.repo,
        title: body?.title,
        body: body?.body,
        base: body?.base,
        head: body?.head,
        draft: !!body?.draft,
      });
      console.log(
        `[repo/pr-create] ${new Date().toLocaleTimeString()}  ${result.draft ? "draft " : ""}PR "${result.title}" → ${result.url}`
      );
      json(res, 200, { ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "PR create failed";
      const status = err instanceof ValidationError ? 400 : 502;
      console.log(`[repo/pr-create:error] ${new Date().toLocaleTimeString()}  (${status}) ${message}`);
      json(res, status, { error: message });
    }
    return;
  }

  json(res, 404, { error: "Not found" });
});

server.listen(port, "127.0.0.1", () => {
  console.log("AI Board — local runner");
  console.log("──────────────────────────────────");
  console.log(`Project folder : ${projectDir}`);
  console.log(`URL            : http://127.0.0.1:${port}`);
  console.log(`Token          : ${token}`);
  console.log("");
  if (mcpServers.size > 0) {
    console.log(`MCP servers    : ${[...mcpServers.keys()].join(", ")} (starting…)`);
  } else {
    console.log('MCP bridge     : none (try --context7 for live docs, or --mcp "playwright=npx @playwright/mcp@latest")');
  }
  console.log("");
  console.log("Paste the URL and token into the app (Build mode → Local runner).");
  console.log("Every command and file/tool request is logged here. Ctrl+C to stop.");
});
