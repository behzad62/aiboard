/** Runner SearXNG MCP shortcut regression (run: npx tsx scripts/test-runner-searxng-shortcut.mts) */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

async function waitForRunner(port: number, token: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { "x-runner-token": token },
      });
      if (res.ok) return;
    } catch {
      // runner is still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("runner did not start");
}

async function waitForSearchMcp(port: number, token: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const res = await fetch(`http://127.0.0.1:${port}/mcp/servers`, {
      headers: { "x-runner-token": token },
    });
    const data = await res.json();
    const search = data.servers?.find((server: { name: string }) => server.name === "search");
    if (search?.status === "ready") return { res, data, search };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("search MCP server did not become ready");
}

async function stopRunner(child: ChildProcessWithoutNullStreams | null) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    child.kill("SIGINT");
  }
  await Promise.race([
    new Promise<void>((resolve) => child.once("close", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
  ]);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "adb-runner-searxng-"));
const fakeBin = path.join(root, "bin");
const recordPath = path.join(root, "fake-mcp-record.json");
fs.mkdirSync(fakeBin);

const fakeMcpJs = path.join(fakeBin, "fake-mcp.js");
fs.writeFileSync(
  fakeMcpJs,
  `
const fs = require("node:fs");
fs.writeFileSync(process.env.FAKE_MCP_RECORD, JSON.stringify({
  argv: process.argv.slice(2),
  searxngUrl: process.env.SEARXNG_URL || null
}), "utf8");

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  for (;;) {
    const nl = buffer.indexOf("\\n");
    if (nl < 0) break;
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id == null) continue;
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-searxng", version: "1.0.0" }
        }
      }) + "\\n");
    } else if (msg.method === "tools/list") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          tools: [{
            name: "searxng_web_search",
            description: "Fake SearXNG search",
            inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
          }]
        }
      }) + "\\n");
    }
  }
});
`,
  "utf8"
);

fs.writeFileSync(
  path.join(fakeBin, process.platform === "win32" ? "npx.cmd" : "npx"),
  process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "%~dp0fake-mcp.js" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-mcp.js" "$@"\n`,
  "utf8"
);
if (process.platform !== "win32") {
  fs.chmodSync(path.join(fakeBin, "npx"), 0o755);
}

const port = 19_000 + Math.floor(Math.random() * 1_000);
const token = "test-token";
let child: ChildProcessWithoutNullStreams | null = null;

try {
  child = spawn(
    process.execPath,
    [
      "scripts/runner.mjs",
      root,
      "--port",
      String(port),
      "--token",
      token,
      "--searxng",
      "--searxng-url",
      "https://searxng.example",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
        FAKE_MCP_RECORD: recordPath,
        SEARXNG_URL: "",
      },
      windowsHide: true,
    }
  );

  await waitForRunner(port, token);
  const { res, data, search } = await waitForSearchMcp(port, token);
  check("mcp servers endpoint returns HTTP 200", res.status === 200, data);
  check("searxng shortcut registers search server", search?.name === "search", data);
  check("searxng shortcut exposes search tool", search?.tools?.[0]?.name === "searxng_web_search", search);

  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  check("searxng shortcut invokes mcp-searxng package", record.argv.includes("mcp-searxng"), record);
  check("searxng-url flag is passed as SEARXNG_URL", record.searxngUrl === "https://searxng.example", record);
} catch (err) {
  check("runner searxng shortcut integration", false, err instanceof Error ? err.message : String(err));
} finally {
  await stopRunner(child);
  fs.rmSync(root, { recursive: true, force: true });
}

process.exit(failed === 0 ? 0 : 1);
