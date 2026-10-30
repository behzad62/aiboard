// RUNNER_RAW_PROCESS_BOUNDARY: generated stdio MCP env launcher; it runs as an owned MCP transport command and its one child stays in that owned tree.
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Secrets for a managed stdio MCP server never travel through the process backend: it serializes the
 * child environment into its supervisor's command line, which any local process can list. Instead the
 * server is started through this small launcher. The Runner writes a short-lived, user-only file with
 * the approved values right before a launch; the launcher claims it atomically, deletes it, sets only
 * those variables and starts the real server with inherited stdio. Its argv names only the directory.
 */
const LAUNCHER_SOURCE = `import { spawn } from "node:child_process";
import { readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

const [directory, separator, executable, ...args] = process.argv.slice(2);
if (!directory || separator !== "--" || !executable) {
  process.stderr.write("AI Board MCP launcher: invalid arguments.\\n");
  process.exit(64);
}
let values;
for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".secret")).sort()) {
  const claimed = join(directory, name + ".claimed-" + process.pid);
  try { renameSync(join(directory, name), claimed); } catch { continue; }
  try {
    const parsed = JSON.parse(readFileSync(claimed, "utf8"));
    if (parsed && parsed.expiresAt > Date.now() && parsed.values && typeof parsed.values === "object") values = parsed.values;
  } catch {}
  rmSync(claimed, { force: true });
  if (values) break;
}
if (!values) {
  process.stderr.write("AI Board MCP launcher: the Runner did not provide this server's credentials.\\n");
  process.exit(78);
}
// Credentials cannot replace the Runner-owned ancestry marker.
for (const name of Object.keys(values)) if (name.toUpperCase() === "AIBOARD_MCP_DEPTH") delete values[name];
const child = spawn(executable, args, { stdio: "inherit", env: { ...process.env, ...values }, windowsHide: true });
values = undefined;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => { try { child.kill(signal); } catch {} });
child.on("error", (error) => { process.stderr.write("AI Board MCP launcher: " + error.message + "\\n"); process.exit(127); });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
`;

export const MCP_LAUNCHER_DIGEST = createHash("sha256").update(LAUNCHER_SOURCE).digest("hex");
const SECRET_TTL_MS = 60_000;

/** Writes (or repairs) the launcher in AI Board-owned storage and returns its verified path. */
export async function ensureMcpLauncher(directory: string): Promise<string> {
  const path = join(directory, `mcp-env-launcher-${MCP_LAUNCHER_DIGEST.slice(0, 16)}.mjs`);
  const current = await readFile(path, "utf8").catch(() => undefined);
  if (current !== undefined && createHash("sha256").update(current).digest("hex") === MCP_LAUNCHER_DIGEST) return path;
  await mkdir(directory, { recursive: true });
  const staging = `${path}.${randomUUID()}.tmp`;
  await writeFile(staging, LAUNCHER_SOURCE, { mode: 0o600 });
  await rename(staging, path);
  return path;
}

/** Re-verifies launcher bytes right before a launch that depends on it. */
export async function verifyMcpLauncher(path: string): Promise<void> {
  const bytes = await readFile(path, "utf8");
  if (createHash("sha256").update(bytes).digest("hex") !== MCP_LAUNCHER_DIGEST) throw new Error("The MCP credential launcher changed on disk; it is rewritten on the next start.");
}

/** One single-use secret file for one upcoming launch. Stale files are swept first. */
export async function provisionMcpSecrets(directory: string, values: Readonly<Record<string, string>>, now = Date.now()): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await sweepMcpSecrets(directory, now);
  const name = `${now.toString().padStart(15, "0")}-${randomUUID()}.secret`;
  const staging = join(directory, `${name}.tmp`);
  await writeFile(staging, JSON.stringify({ expiresAt: now + SECRET_TTL_MS, values }), { mode: 0o600 });
  await chmod(staging, 0o600).catch(() => undefined);
  await rename(staging, join(directory, name));
}

/** Removes expired or abandoned secret files (a launch that failed before the launcher ran). */
export async function sweepMcpSecrets(directory: string, now = Date.now()): Promise<void> {
  for (const name of await readdir(directory).catch(() => [] as string[])) {
    const path = join(directory, name);
    const info = await stat(path).catch(() => undefined);
    if (!info) continue;
    // Concurrent provisioning may be mid-write, so only aged entries are removed.
    if (now - info.mtimeMs > SECRET_TTL_MS) await rm(path, { force: true });
  }
}
