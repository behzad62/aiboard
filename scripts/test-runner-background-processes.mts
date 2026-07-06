/** Runner background process lifecycle checks (run: npx tsx scripts/test-runner-background-processes.mts) */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiboard-runner-bg-"));
const runnerPort = 23000 + Math.floor(Math.random() * 1000);
const childPort = 24000 + Math.floor(Math.random() * 1000);
const token = "test-token";
const runner = spawn(
  process.execPath,
  ["scripts/runner.mjs", tmp, "--port", String(runnerPort), "--token", token],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AIBOARD_RUNNER_BACKGROUND_STARTUP_MS: "300",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }
);

const baseUrl = `http://127.0.0.1:${runnerPort}`;
const headers = {
  "content-type": "application/json",
  "x-runner-token": token,
};
const nodeCommand = `"${process.execPath.replace(/"/g, '\\"')}"`;
const serverScript = [
  "const fs=require('fs')",
  `require('http').createServer((req,res)=>res.end('alive')).listen(${childPort},'127.0.0.1',()=>fs.writeFileSync('server-ready.txt','ready'))`,
  "setInterval(()=>{},1000)",
].join(";");

async function waitForRunner(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`, { headers });
      if (res.ok) return;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("runner did not become ready");
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function childServerReachable(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 500);
  try {
    const res = await fetch(`http://127.0.0.1:${childPort}`, { signal: controller.signal });
    return res.ok && (await res.text()) === "alive";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function request(method: "GET" | "POST", endpoint: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  return { res, data };
}

async function stopRunner(): Promise<void> {
  if (runner.exitCode !== null) return;
  if (process.platform === "win32" && runner.pid) {
    spawnSync("taskkill", ["/pid", String(runner.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    runner.kill("SIGINT");
  }
  await Promise.race([
    new Promise<void>((resolve) => runner.once("close", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
  ]);
}

try {
  await waitForRunner();

  const command = `${nodeCommand} -e "${serverScript.replace(/"/g, '\\"')}" &`;
  const run = await request("POST", "/run", { command });
  check("background command starts successfully", run.res.ok && run.data.background === true, run.data);
  check(
    "background server became reachable",
    (await waitFor(() => fs.existsSync(path.join(tmp, "server-ready.txt")), 3_000)) &&
      (await childServerReachable()),
    run.data
  );

  const listed = await request("GET", "/background-processes");
  check(
    "background process endpoint lists started command",
    listed.res.ok &&
      Array.isArray(listed.data.processes) &&
      listed.data.processes.some((item: { command?: string }) => item.command?.includes(String(childPort))),
    listed.data
  );

  const stopped = await request("POST", "/background-processes/stop", {});
  check("background stop endpoint reports stopped process", stopped.res.ok && stopped.data.stopped >= 1, stopped.data);
  check(
    "background stop endpoint terminates child server",
    await waitFor(async () => !(await childServerReachable()), 5_000),
    stopped.data
  );
  const relisted = await request("GET", "/background-processes");
  check(
    "background process endpoint is empty after stop",
    relisted.res.ok && Array.isArray(relisted.data.processes) && relisted.data.processes.length === 0,
    relisted.data
  );
} catch (err) {
  check("runner background process lifecycle", false, err instanceof Error ? err.message : String(err));
} finally {
  await stopRunner();
  fs.rmSync(tmp, { recursive: true, force: true });
}

process.exit(failed === 0 ? 0 : 1);
