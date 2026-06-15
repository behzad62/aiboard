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
 *                   [--mcp "<name>=<command>"]...
 *
 * MCP bridge: each --mcp flag spawns a stdio MCP server and exposes its tools
 * to the Architect (with the same per-call approval as commands), e.g.:
 *   --mcp "playwright=npx @playwright/mcp@latest"
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

const VERSION = 6;
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

const projectDir = path.resolve(positional[0] ?? ".");
const port = Number(flag("port") ?? 8787);
const token = flag("token") ?? randomBytes(12).toString("hex");

if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
  console.error(`Not a folder: ${projectDir}`);
  process.exit(1);
}

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

// ── Helpers ──────────────────────────────────────────────────────────────────
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "content-type,x-runner-token",
  "Access-Control-Max-Age": "86400",
};

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", ...CORS_HEADERS });
  res.end(JSON.stringify(body));
}

function authorized(req) {
  return req.headers["x-runner-token"] === token;
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
  const target = path.resolve(projectDir, normalized);
  const rel = path.relative(projectDir, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null; // escaped
  return target;
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
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
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
    console.log(`[mcp:${serverProc.name}] ${new Date().toLocaleTimeString()}  call ${body.tool}`);
    try {
      const result = await serverProc.callTool(body.tool, body.args);
      json(res, 200, { ok: true, ...result });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : "MCP call failed" });
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
      json(res, 400, { error: err instanceof Error ? err.message : "Read failed" });
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
      json(res, 400, { error: err instanceof Error ? err.message : "Read range failed" });
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
      json(res, 400, { error: err instanceof Error ? err.message : "Write failed" });
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
      json(res, 400, { error: err instanceof Error ? err.message : "Patch failed" });
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
      json(res, 400, { error: err instanceof Error ? err.message : "Append failed" });
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
      json(res, 200, { ok: true, ...result });
    } catch (err) {
      json(res, 400, {
        error: err instanceof Error ? err.message : "Fetch failed",
      });
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
    console.log('MCP bridge     : none (add e.g. --mcp "playwright=npx @playwright/mcp@latest")');
  }
  console.log("");
  console.log("Paste the URL and token into the app (Build mode → Local runner).");
  console.log("Every command and file/tool request is logged here. Ctrl+C to stop.");
});
