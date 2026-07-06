/** Runner foreground command timeout regression (run: npx tsx scripts/test-runner-command-timeout.mts) */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiboard-runner-timeout-"));
const runnerPort = 20000 + Math.floor(Math.random() * 1000);
const childPort = 21000 + Math.floor(Math.random() * 1000);
const token = "test-token";
const runnerStdout: string[] = [];
const runnerStderr: string[] = [];
const runner = spawn(
  process.execPath,
  ["scripts/runner.mjs", tmp, "--port", String(runnerPort), "--token", token],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AIBOARD_RUNNER_COMMAND_TIMEOUT_MS: "1000",
      AIBOARD_RUNNER_KILL_GRACE_MS: "500",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }
);

runner.stdout.on("data", (chunk) => runnerStdout.push(String(chunk)));
runner.stderr.on("data", (chunk) => runnerStderr.push(String(chunk)));

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
    await new Promise((resolve) => setTimeout(resolve, 150));
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
    const res = await fetch(`http://127.0.0.1:${childPort}`, {
      signal: controller.signal,
    });
    return res.ok && (await res.text()) === "alive";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function postRunWithDeadline(command: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/run`, {
      method: "POST",
      headers,
      body: JSON.stringify({ command }),
      signal: controller.signal,
    });
    const data = await res.json();
    return { res, data };
  } finally {
    clearTimeout(timer);
  }
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

async function removeTempDir(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
      return;
    } catch (err) {
      if (
        i === 9 ||
        !(err && typeof err === "object" && "code" in err) ||
        (err as { code?: string }).code !== "EBUSY"
      ) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

try {
  await waitForRunner();

  const command = `${nodeCommand} -e "${serverScript.replace(/"/g, '\\"')}"`;
  const startedAt = Date.now();
  const runResult = postRunWithDeadline(command, 7_000);

  const markerReady = await waitFor(
    () => fs.existsSync(path.join(tmp, "server-ready.txt")),
    3_000
  );
  check("foreground server command started", markerReady, { runnerStdout, runnerStderr });
  check("foreground server was reachable before timeout", await childServerReachable());

  let res: Response | null = null;
  let data: Record<string, unknown> = {};
  try {
    ({ res, data } = await runResult);
  } catch (err) {
    check("foreground command returns after configured timeout", false, {
      error: err instanceof Error ? err.message : String(err),
      runnerStdout,
      runnerStderr,
    });
  }

  const elapsedMs = Date.now() - startedAt;
  check("foreground command returns HTTP 200", res?.ok === true, data);
  check("foreground command returns promptly after timeout", elapsedMs < 7_000, {
    elapsedMs,
    data,
  });
  check("foreground command reports timeout as failure", data.exitCode === -1, data);
  check(
    "foreground command explains timeout",
    String(data.stderr ?? "").includes("timed out"),
    data
  );
  check(
    "foreground command records configured timeout duration",
    typeof data.durationMs === "number" && data.durationMs >= 900 && data.durationMs < 5_000,
    data
  );

  const serverStopped = await waitFor(async () => !(await childServerReachable()), 5_000);
  check("foreground command timeout terminates the child server", serverStopped);
} catch (err) {
  check("runner foreground timeout integration", false, err instanceof Error ? err.message : String(err));
} finally {
  await stopRunner();
  await removeTempDir();
}

process.exit(failed === 0 ? 0 : 1);
