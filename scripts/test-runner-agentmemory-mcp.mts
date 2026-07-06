/** Runner default AgentMemory MCP regression (run: npx tsx scripts/test-runner-agentmemory-mcp.mts) */
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

async function waitForMcpServers(port: number, token: string, names: string[]) {
  const deadline = Date.now() + 5_000;
  let last: unknown = null;
  while (Date.now() < deadline) {
    const res = await fetch(`http://127.0.0.1:${port}/mcp/servers`, {
      headers: { "x-runner-token": token },
    });
    const data = await res.json();
    last = data;
    const servers = Array.isArray(data.servers) ? data.servers : [];
    const byName = new Map(servers.map((server: { name: string }) => [server.name, server]));
    if (names.every((name) => byName.get(name)?.status === "ready")) {
      return { res, data, servers, byName };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`MCP servers did not become ready: ${JSON.stringify(last)}`);
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

function writeFakeNpx(fakeBin: string) {
  fs.mkdirSync(fakeBin, { recursive: true });

  const fakeNpxJs = path.join(fakeBin, "fake-npx.js");
  fs.writeFileSync(
    fakeNpxJs,
    `
const fs = require("node:fs");

const args = process.argv.slice(2);
const pkg = args.find((arg) => !arg.startsWith("-")) || "unknown";
const toolName = pkg.replace(/^@/, "").replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 40) + "_tool";
fs.appendFileSync(process.env.FAKE_NPX_RECORD, JSON.stringify({ cwd: process.cwd(), args, pkg }) + "\\n");

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
          serverInfo: { name: "fake-" + pkg, version: "1.0.0" }
        }
      }) + "\\n");
    } else if (msg.method === "tools/list") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          tools: [{
            name: toolName,
            description: "Fake tool for " + pkg,
            inputSchema: { type: "object", properties: {}, additionalProperties: false }
          }]
        }
      }) + "\\n");
    }
  }
});
`,
    "utf8"
  );

  const launcher = path.join(fakeBin, process.platform === "win32" ? "npx.cmd" : "npx");
  fs.writeFileSync(
    launcher,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "%~dp0fake-npx.js" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-npx.js" "$@"\n`,
    "utf8"
  );
  if (process.platform !== "win32") {
    fs.chmodSync(launcher, 0o755);
  }
}

async function testAgentMemoryDefaultMcpServer() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "adb-runner-agentmemory-mcp-"));
  const root = path.join(temp, "project");
  const fakeBin = path.join(temp, "bin");
  const recordPath = path.join(temp, "fake-npx-record.jsonl");
  fs.mkdirSync(root);
  writeFakeNpx(fakeBin);

  const port = 23_000 + Math.floor(Math.random() * 1_000);
  const token = "test-token";
  let child: ChildProcessWithoutNullStreams | null = null;

  try {
    child = spawn(process.execPath, ["scripts/runner.mjs", root, "--port", String(port), "--token", token], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
        FAKE_NPX_RECORD: recordPath,
      },
      windowsHide: true,
    });

    await waitForRunner(port, token);
    const expected = ["playwright", "context7", "sequential-thinking", "agentmemory"];
    const { res, data, byName } = await waitForMcpServers(port, token, expected);
    const agentmemory = byName.get("agentmemory") as
      | { name: string; command: string; status: string; tools?: { name: string }[] }
      | undefined;

    check("mcp servers endpoint returns HTTP 200", res.status === 200, data);
    check("agentmemory is registered as a default MCP server", agentmemory?.name === "agentmemory", data);
    check(
      "agentmemory default uses the package shim",
      agentmemory?.command === "npx -y @agentmemory/mcp",
      agentmemory
    );
    check("agentmemory default MCP server starts", agentmemory?.status === "ready", agentmemory);
    check("agentmemory exposes tools through the runner bridge", !!agentmemory?.tools?.length, agentmemory);

    const records = fs.readFileSync(recordPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    check("runner launched the agentmemory MCP package", records.some((r) => r.pkg === "@agentmemory/mcp"), records);
  } catch (err) {
    check("runner AgentMemory default MCP integration", false, err instanceof Error ? err.message : String(err));
  } finally {
    await stopRunner(child);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

await testAgentMemoryDefaultMcpServer();

process.exit(failed === 0 ? 0 : 1);
