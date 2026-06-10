#!/usr/bin/env node
/**
 * AI Discussion Board — local command runner.
 *
 * Lets the Build-mode Architect run commands (tests, builds, installs) in YOUR
 * project folder. You start it, you can stop it any time (Ctrl+C), and every
 * command is printed here before it runs. The web app additionally asks for
 * your approval per command unless you chose "Full access".
 *
 * Usage:
 *   node scripts/runner.mjs <project-folder> [--port 8787] [--token <secret>]
 *
 * Then paste the printed URL + token into the app (Build mode → Local runner).
 *
 * Zero dependencies; binds to 127.0.0.1 only.
 */

import http from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import fs from "node:fs";

const VERSION = 1;
const MAX_OUTPUT_BYTES = 200 * 1024;
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

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

function runCommand(command) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, {
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
        stdout: stdout.slice(0, MAX_OUTPUT_BYTES),
        stderr: stderr.slice(0, MAX_OUTPUT_BYTES),
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
      canWrite: true,
    });
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
  console.log("AI Discussion Board — local runner");
  console.log("──────────────────────────────────");
  console.log(`Project folder : ${projectDir}`);
  console.log(`URL            : http://127.0.0.1:${port}`);
  console.log(`Token          : ${token}`);
  console.log("");
  console.log("Paste the URL and token into the app (Build mode → Local runner).");
  console.log("Every command the Architect runs is logged here. Ctrl+C to stop.");
});
