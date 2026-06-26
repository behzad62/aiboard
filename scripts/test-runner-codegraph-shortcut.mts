/** Runner CodeGraph MCP shortcut regression (run: npx tsx scripts/test-runner-codegraph-shortcut.mts) */
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

async function waitForCodeGraphMcp(port: number, token: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const res = await fetch(`http://127.0.0.1:${port}/mcp/servers`, {
      headers: { "x-runner-token": token },
    });
    const data = await res.json();
    const codegraph = data.servers?.find((server: { name: string }) => server.name === "codegraph");
    if (codegraph?.status === "ready") return { res, data, codegraph };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("codegraph MCP server did not become ready");
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

function writeFakeCodeGraph(fakeBin: string, recordPath: string) {
  fs.mkdirSync(fakeBin, { recursive: true });

  const fakeCodeGraphJs = path.join(fakeBin, "fake-codegraph.js");
  fs.writeFileSync(
    fakeCodeGraphJs,
    `
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CODEGRAPH_RECORD, JSON.stringify({ cwd: process.cwd(), args }) + "\\n");

if (args[0] === "--version") {
  console.log("codegraph 1.0.0");
  process.exit(0);
}

if (args[0] === "init") {
  fs.mkdirSync(path.join(process.cwd(), ".codegraph"), { recursive: true });
  console.log("initialized");
  process.exit(0);
}

if (args[0] === "serve" && args[1] === "--mcp") {
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
            serverInfo: { name: "fake-codegraph", version: "1.0.0" }
          }
        }) + "\\n");
      } else if (msg.method === "tools/list") {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            tools: [{
              name: "codegraph_explore",
              description: "Fake CodeGraph explore",
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"]
              }
            }]
          }
        }) + "\\n");
      }
    }
  });
} else {
  console.error("unexpected codegraph args", args.join(" "));
  process.exit(1);
}
`,
    "utf8"
  );

  const launcher = path.join(fakeBin, process.platform === "win32" ? "codegraph.cmd" : "codegraph");
  fs.writeFileSync(
    launcher,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "%~dp0fake-codegraph.js" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-codegraph.js" "$@"\n`,
    "utf8"
  );
  if (process.platform !== "win32") {
    fs.chmodSync(launcher, 0o755);
  }
}

async function testCliShortcut() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "adb-runner-codegraph-cli-"));
  const root = path.join(temp, "project");
  const fakeBin = path.join(temp, "bin");
  const recordPath = path.join(temp, "fake-codegraph-record.jsonl");
  fs.mkdirSync(root);
  writeFakeCodeGraph(fakeBin, recordPath);

  const port = 20_000 + Math.floor(Math.random() * 1_000);
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
        "--no-default-mcp",
        "--codegraph",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
          FAKE_CODEGRAPH_RECORD: recordPath,
        },
        windowsHide: true,
      }
    );

    await waitForRunner(port, token);
    const { res, data, codegraph } = await waitForCodeGraphMcp(port, token);
    check("mcp servers endpoint returns HTTP 200", res.status === 200, data);
    check("codegraph shortcut registers codegraph server", codegraph?.name === "codegraph", data);
    check("codegraph shortcut exposes explore tool", codegraph?.tools?.[0]?.name === "codegraph_explore", codegraph);
    check("codegraph shortcut initializes project index", fs.existsSync(path.join(root, ".codegraph")), root);

    const records = fs.readFileSync(recordPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    check("codegraph shortcut checks CLI version", records.some((r) => r.args[0] === "--version"), records);
    check("codegraph shortcut runs init", records.some((r) => r.args[0] === "init"), records);
    check(
      "codegraph shortcut starts MCP server",
      records.some((r) => r.args[0] === "serve" && r.args[1] === "--mcp"),
      records
    );
  } catch (err) {
    check("runner codegraph CLI shortcut integration", false, err instanceof Error ? err.message : String(err));
  } finally {
    await stopRunner(child);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function testPanelSetupEndpoint() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "adb-runner-codegraph-api-"));
  const root = path.join(temp, "project");
  const fakeBin = path.join(temp, "bin");
  const recordPath = path.join(temp, "fake-codegraph-record.jsonl");
  fs.mkdirSync(root);
  writeFakeCodeGraph(fakeBin, recordPath);

  const port = 21_000 + Math.floor(Math.random() * 1_000);
  const token = "test-token";
  let child: ChildProcessWithoutNullStreams | null = null;

  try {
    child = spawn(
      process.execPath,
      ["scripts/runner.mjs", root, "--port", String(port), "--token", token, "--no-default-mcp"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
          FAKE_CODEGRAPH_RECORD: recordPath,
        },
        windowsHide: true,
      }
    );

    await waitForRunner(port, token);
    const setupRes = await fetch(`http://127.0.0.1:${port}/api/codegraph/setup`, {
      method: "POST",
      headers: { "x-runner-token": token },
    });
    const setup = await setupRes.json();

    check("codegraph setup endpoint returns HTTP 200", setupRes.status === 200, setup);
    check("codegraph setup endpoint reports ok", setup.ok === true, setup);
    check("codegraph setup endpoint initializes project", setup.initialized === true, setup);
    check("codegraph setup endpoint records initialization", setup.initializedNow === true, setup);
    check("codegraph setup endpoint adds server", setup.server?.name === "codegraph", setup);

    const { codegraph } = await waitForCodeGraphMcp(port, token);
    check("codegraph setup endpoint starts MCP server", codegraph?.status === "ready", codegraph);
  } catch (err) {
    check("runner codegraph setup endpoint integration", false, err instanceof Error ? err.message : String(err));
  } finally {
    await stopRunner(child);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function testPanelSetupFindsStandardWindowsInstallWhenPathIsStale() {
  if (process.platform !== "win32") return;

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "adb-runner-codegraph-standard-"));
  const root = path.join(temp, "project");
  const localAppData = path.join(temp, "LocalAppData");
  const fakeBin = path.join(localAppData, "codegraph", "current", "bin");
  const recordPath = path.join(temp, "fake-codegraph-record.jsonl");
  fs.mkdirSync(root, { recursive: true });
  writeFakeCodeGraph(fakeBin, recordPath);

  const port = 22_000 + Math.floor(Math.random() * 1_000);
  const token = "test-token";
  let child: ChildProcessWithoutNullStreams | null = null;

  try {
    child = spawn(
      process.execPath,
      ["scripts/runner.mjs", root, "--port", String(port), "--token", token, "--no-default-mcp"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          LOCALAPPDATA: localAppData,
          PATH: process.env.SystemRoot ? `${process.env.SystemRoot}\\System32` : "",
          FAKE_CODEGRAPH_RECORD: recordPath,
        },
        windowsHide: true,
      }
    );

    await waitForRunner(port, token);
    const setupRes = await fetch(`http://127.0.0.1:${port}/api/codegraph/setup`, {
      method: "POST",
      headers: { "x-runner-token": token },
    });
    const setup = await setupRes.json();

    check("codegraph setup endpoint finds standard Windows install path", setupRes.status === 200, setup);
    check("standard Windows install setup reports ok", setup.ok === true, setup);
    check("standard Windows install setup adds server", setup.server?.name === "codegraph", setup);
  } catch (err) {
    check(
      "runner codegraph standard Windows install fallback",
      false,
      err instanceof Error ? err.message : String(err)
    );
  } finally {
    await stopRunner(child);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

await testCliShortcut();
await testPanelSetupEndpoint();
await testPanelSetupFindsStandardWindowsInstallWhenPathIsStale();

process.exit(failed === 0 ? 0 : 1);
