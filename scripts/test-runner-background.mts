/** Runner background command regression (run: npx tsx scripts/test-runner-background.mts) */
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
const project = path.join(tmp, "AIPaintball");
fs.mkdirSync(project);
const port = 19000 + Math.floor(Math.random() * 1000);
const token = "test-token";
const runner = spawn(
  process.execPath,
  ["scripts/runner.mjs", tmp, "--port", String(port), "--token", token],
  {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }
);

const baseUrl = `http://127.0.0.1:${port}`;
const headers = {
  "content-type": "application/json",
  "x-runner-token": token,
};
const nodeCommand = `"${process.execPath.replace(/"/g, '\\"')}"`;

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

  const rootResponse = await fetch(`${baseUrl}/api/fs/root`, {
    method: "POST",
    headers,
    body: JSON.stringify({ path: "AIPaintball" }),
  });
  const rootData = await rootResponse.json();
  check("runner accepts active child project folder", rootResponse.ok, rootData);
  check("runner reports active project folder", rootData.activeDir === project, rootData);

  const startedAt = Date.now();
  const res = await fetch(`${baseUrl}/run`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      command: `${nodeCommand} -e "setInterval(() => {}, 1000)" &`,
    }),
  });
  const elapsedMs = Date.now() - startedAt;
  const data = await res.json();
  check("background run returns HTTP 200", res.ok, data);
  check("background run returns promptly", elapsedMs < 6_000, { elapsedMs, data });
  check("background run is marked background", data.background === true, data);
  check("background run reports success", data.exitCode === 0, data);
  check("background run reports active cwd", data.cwd === project, data);

  const finite = await fetch(`${baseUrl}/run`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      command: `${nodeCommand} -e "console.log(process.cwd())"`,
    }),
  });
  const finiteData = await finite.json();
  check("finite run remains foreground", finiteData.background !== true, finiteData);
  check("finite run captures active cwd stdout", String(finiteData.stdout).trim() === project, finiteData);
  check("finite run reports active cwd", finiteData.cwd === project, finiteData);
} catch (err) {
  check("runner background integration", false, err instanceof Error ? err.message : String(err));
} finally {
  await stopRunner();
  await removeTempDir();
}

process.exit(failed === 0 ? 0 : 1);
