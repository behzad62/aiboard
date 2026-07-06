/** Runner target-folder cwd regression (run: npx tsx scripts/test-runner-target-cwd.mts) */
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
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { "x-runner-token": token },
      });
      if (res.ok) return;
    } catch {
      // runner is still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("runner did not start");
}

async function get(port: number, token: string, endpoint: string) {
  const res = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    headers: { "x-runner-token": token },
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

async function post(port: number, token: string, endpoint: string, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-runner-token": token },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

async function stopRunner(child: ChildProcessWithoutNullStreams | null): Promise<void> {
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

async function removeTempDir(dir: string): Promise<void> {
  let lastBusyError: unknown = null;
  for (let i = 0; i < 10; i += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (
        i === 9 ||
        !(err && typeof err === "object" && "code" in err) ||
        (err as { code?: string }).code !== "EBUSY"
      ) {
        throw err;
      }
      lastBusyError = err;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  console.warn(
    `WARN - temp cleanup skipped; Windows still has a handle open: ${
      lastBusyError instanceof Error ? lastBusyError.message : String(lastBusyError)
    }`
  );
}

const parent = fs.mkdtempSync(path.join(os.tmpdir(), "aiboard-runner-parent-"));
const target = path.join(parent, "project");
fs.mkdirSync(target);
fs.writeFileSync(path.join(parent, "Parent.csproj"), "<Project />\n", "utf8");
fs.writeFileSync(path.join(target, "index.html"), "<!doctype html>\n", "utf8");

const port = 20_500 + Math.floor(Math.random() * 1_000);
const token = "test-token";
const runnerScript = path.resolve("scripts/runner.mjs");
let child: ChildProcessWithoutNullStreams | null = null;
let log = "";

try {
  child = spawn(
    process.execPath,
    [runnerScript, "project", "--port", String(port), "--token", token],
    { cwd: parent, windowsHide: true }
  );
  child.stdout.on("data", (chunk) => {
    log += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    log += String(chunk);
  });
  await waitForRunner(port, token);

  const listed = await get(port, token, "/ls");
  check("ls returns target files", listed.res.status === 200, listed.data);
  check("ls includes target file", listed.data.files?.includes("index.html"), listed.data);
  check("ls excludes parent manifest", !listed.data.files?.includes("Parent.csproj"), listed.data);

  const nodeCommand = `"${process.execPath.replace(/"/g, '\\"')}"`;
  const inline = [
    "const fs=require('fs')",
    "console.log(process.cwd())",
    "console.log(fs.existsSync('index.html')?'target=yes':'target=no')",
    "console.log(fs.existsSync('Parent.csproj')?'parent-leaked=yes':'parent-leaked=no')",
  ].join(";");
  const ran = await post(port, token, "/run", {
    command: `${nodeCommand} -e "${inline.replace(/"/g, '\\"')}"`,
  });
  check("run returns HTTP 200", ran.res.status === 200, ran.data);
  check("run executes inside target folder", String(ran.data.stdout ?? "").includes(target), ran.data);
  check("run sees target file", String(ran.data.stdout ?? "").includes("target=yes"), ran.data);
  check("run does not treat parent as cwd", String(ran.data.stdout ?? "").includes("parent-leaked=no"), ran.data);
} finally {
  await stopRunner(child);
  await removeTempDir(parent);
}

check("runner logged target project folder", log.includes(`Project folder : ${target}`), log);

process.exit(failed === 0 ? 0 : 1);
