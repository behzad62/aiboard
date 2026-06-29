/** Runner CLI version banner checks (run: npx tsx scripts/test-runner-cli-version.mts) */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

function stop(child: ChildProcessWithoutNullStreams | null): Promise<void> {
  return new Promise((resolve) => {
    if (!child || child.killed || child.exitCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
    child.kill();
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 1000).unref();
  });
}

async function waitFor(
  predicate: () => boolean,
  describe: () => unknown
): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for runner output: ${JSON.stringify(describe())}`);
}

async function sourceVersion(file: string): Promise<number> {
  const text = await readFile(file, "utf8");
  const version = Number((text.match(/const VERSION = (\d+);/) ?? [])[1]);
  if (!Number.isFinite(version) || version <= 0) {
    throw new Error(`could not read VERSION from ${file}`);
  }
  return version;
}

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "aiboard-runner-cli-version-"));
let localRunner: ChildProcessWithoutNullStreams | null = null;
let accountRunner: ChildProcessWithoutNullStreams | null = null;

try {
  const localVersion = await sourceVersion(path.join(repoRoot, "scripts", "runner.mjs"));
  const accountVersion = await sourceVersion(path.join(repoRoot, "lib", "account-provider-runner.mjs"));
  const localPort = 24_000 + Math.floor(Math.random() * 5_000);
  const accountPort = 29_000 + Math.floor(Math.random() * 5_000);
  let localStdout = "";
  let localStderr = "";
  let accountStdout = "";
  let accountStderr = "";

  localRunner = spawn(
    process.execPath,
    [
      path.join(repoRoot, "scripts", "runner.mjs"),
      tmpRoot,
      "--port",
      String(localPort),
      "--token",
      "test-local-runner-token",
      "--no-default-mcp",
    ],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] }
  );
  localRunner.stdout.on("data", (chunk) => {
    localStdout += String(chunk);
  });
  localRunner.stderr.on("data", (chunk) => {
    localStderr += String(chunk);
  });
  await waitFor(
    () => localStdout.includes(`Version        : v${localVersion}`),
    () => ({ stdout: localStdout, stderr: localStderr })
  );
  check("local runner startup banner shows version", true);

  accountRunner = spawn(
    process.execPath,
    [
      path.join(repoRoot, "lib", "account-provider-runner.mjs"),
      "--port",
      String(accountPort),
      "--token",
      "test-account-runner-token",
      "--auth-file",
      path.join(tmpRoot, "account-auth.json"),
    ],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] }
  );
  accountRunner.stdout.on("data", (chunk) => {
    accountStdout += String(chunk);
  });
  accountRunner.stderr.on("data", (chunk) => {
    accountStderr += String(chunk);
  });
  await waitFor(
    () => accountStdout.includes(`Version   : v${accountVersion}`),
    () => ({ stdout: accountStdout, stderr: accountStderr })
  );
  check("account-provider runner startup banner shows version", true);
} catch (error) {
  check("runner CLI version banners", false, error instanceof Error ? error.message : String(error));
} finally {
  await Promise.all([stop(localRunner), stop(accountRunner)]);
  await rm(tmpRoot, { recursive: true, force: true });
}

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
