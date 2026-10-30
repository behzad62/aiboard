// RUNNER_RAW_PROCESS_BOUNDARY: The managed-install lifecycle runs the staged bundle's own Node for its smoke check,
// Git for `doctor`, and PowerShell to edit the per-user PATH on Windows; none of them receives a secret.
// Managed install lifecycle (L2, ADR-E): `aiboard update`, `aiboard update --rollback`, `aiboard uninstall`, `aiboard doctor`.
// Layout (shared with install.ps1 / install.sh):
//   <root>/install.json        marker written by the installer
//   <root>/current             active version (atomic pointer, read by the bin shims)
//   <root>/previous            last known-good version kept for rollback
//   <root>/sequence            highest signed channel sequence accepted on this machine
//   <root>/versions/<version>  verified, extracted bundles
//   <root>/bin/aiboard(.cmd)   PATH shims
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { extractFiles, readArchive } from "./release-archive.js";
import {
  isReleaseVersion, parseReleaseChannelConfig, RELEASE_PRODUCT, RELEASE_TARGETS, verifyReleaseManifest,
  type ReleaseChannelConfig, type ReleaseManifest, type ReleaseTarget,
} from "./release-manifest.js";

export interface InstallLayout {
  root: string;
  binDirectory: string;
  versionsDirectory: string;
  /** The version this process runs from. */
  runningVersion: string;
}

export interface ReleaseInfo {
  schemaVersion: 1;
  product: string;
  version: string;
  target: ReleaseTarget;
  nodeVersion: string;
  files: Record<string, string>;
}

export interface SelfUpdateRuntime {
  layout?: InstallLayout;
  config?: ReleaseChannelConfig;
  fetch?: typeof fetch;
  now?: () => Date;
  write?: (message: string) => void;
  interactive?: boolean;
  confirm?: (question: string) => Promise<boolean>;
  smoke?: (versionDirectory: string, version: string) => Promise<void>;
  editUserPath?: (binDirectory: string) => Promise<void>;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  home?: string;
  /** Windows: AIBOARD_ROOT of the shim that started this process, if any. */
  shimRoot?: string;
}

const MANIFEST_LIMIT = 64 * 1024;
const SIGNATURE_LIMIT = 4 * 1024;
const PROFILE_MARKER_START = "# >>> aiboard installer >>>";
const PROFILE_MARKER_END = "# <<< aiboard installer <<<";
export const POSIX_PROFILE_FILES = [".profile", ".bashrc", ".bash_profile", ".zshrc", ".zprofile"] as const;
export const UNINSTALL_PENDING_SCRIPT = "uninstall-pending.cmd";

/**
 * bin\aiboard.cmd, byte-identical to the copy install.ps1 writes. After Node exits it runs a pending
 * uninstall cleanup: `(goto) 2>nul` first leaves this batch file, so deleting bin\ and the version Node
 * ran from (Windows keeps both open while the command runs) cannot break the shim mid-read.
 */
export const WINDOWS_SHIM = [
  "@echo off",
  "setlocal",
  'set "AIBOARD_ROOT=%~dp0.."',
  'set "AIBOARD_VERSION="',
  'set /p AIBOARD_VERSION=<"%AIBOARD_ROOT%\\current"',
  "if not defined AIBOARD_VERSION (",
  "  echo aiboard: no active version; reinstall with: irm https://aiboard.me/install.ps1 ^| iex 1>&2",
  "  exit /b 1",
  ")",
  '"%AIBOARD_ROOT%\\versions\\%AIBOARD_VERSION%\\node\\node.exe" "%AIBOARD_ROOT%\\versions\\%AIBOARD_VERSION%\\app\\runner-v2\\bin\\aiboard.mjs" %*',
  `if exist "%AIBOARD_ROOT%\\${UNINSTALL_PENDING_SCRIPT}" ( (goto) 2>nul & "%AIBOARD_ROOT%\\${UNINSTALL_PENDING_SCRIPT}" )`,
  "exit /b %ERRORLEVEL%",
  "",
].join("\r\n");

/** bin/aiboard, byte-identical to the copy install.sh writes. */
export const POSIX_SHIM = [
  "#!/bin/sh",
  "# AI Board Runner command (managed by the installer; see aiboard uninstall).",
  'root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P) || exit 1',
  'version=$(cat "$root/current" 2>/dev/null) || version=""',
  'case "$version" in',
  "  ''|*[!0-9A-Za-z.-]*) echo \"aiboard: no active version; reinstall with: curl -fsSL https://aiboard.me/install.sh | sh\" >&2; exit 1 ;;",
  "esac",
  'exec "$root/versions/$version/node/node" "$root/versions/$version/app/runner-v2/bin/aiboard.mjs" "$@"',
  "",
].join("\n");

/** Rewrites the PATH shim so an update can also deliver shim fixes. */
async function writeShim(layout: InstallLayout, platform: NodeJS.Platform): Promise<void> {
  await mkdir(layout.binDirectory, { recursive: true });
  const path = join(layout.binDirectory, platform === "win32" ? "aiboard.cmd" : "aiboard");
  await writeAtomic(path, platform === "win32" ? WINDOWS_SHIM : POSIX_SHIM);
  if (platform !== "win32") await chmod(path, 0o755);
}

export function detectInstallLayout(moduleUrl: string = import.meta.url): InstallLayout | undefined {
  const source = dirname(fileURLToPath(moduleUrl));
  const runner = dirname(source);
  const app = dirname(runner);
  const versionDirectory = dirname(app);
  const versions = dirname(versionDirectory);
  const root = dirname(versions);
  if (basename(runner) !== "runner-v2" || basename(app) !== "app" || basename(versions) !== "versions") return undefined;
  if (!isReleaseVersion(basename(versionDirectory)) || !existsSync(join(root, "install.json"))) return undefined;
  return { root, binDirectory: join(root, "bin"), versionsDirectory: versions, runningVersion: basename(versionDirectory) };
}

function notManaged(): Error {
  return new Error("not_managed_install: This aiboard was not installed by the one-line installer (developer checkout or ZIP). Update it with git pull or reinstall from https://aiboard.me/runner-guide.");
}

async function loadBundledConfig(layout: InstallLayout): Promise<ReleaseChannelConfig> {
  const path = join(layout.versionsDirectory, layout.runningVersion, "app", "runner-v2", "release-channel.json");
  return parseReleaseChannelConfig(JSON.parse(await readFile(path, "utf8")));
}

async function readPointer(path: string): Promise<string | undefined> {
  try {
    const value = (await readFile(path, "utf8")).trim();
    return value || undefined;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function readVersionPointer(path: string): Promise<string | undefined> {
  const value = await readPointer(path);
  if (value !== undefined && !isReleaseVersion(value)) throw new Error(`install_state_invalid: ${basename(path)} does not name a release version; reinstall with the one-line installer.`);
  return value;
}

export interface InstallState { current?: string; previous?: string; sequence?: number }

export async function readInstallState(layout: InstallLayout): Promise<InstallState> {
  const sequenceText = await readPointer(join(layout.root, "sequence"));
  const sequence = sequenceText === undefined ? undefined : Number(sequenceText);
  if (sequence !== undefined && (!Number.isSafeInteger(sequence) || sequence < 1)) throw new Error("install_state_invalid: sequence is corrupt; reinstall with the one-line installer.");
  return {
    current: await readVersionPointer(join(layout.root, "current")),
    previous: await readVersionPointer(join(layout.root, "previous")),
    ...(sequence !== undefined ? { sequence } : {}),
  };
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, { flag: "wx", mode: 0o644 });
  try { await rename(temporary, path); }
  catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
}

/** A lock with unknown ownership is never reclaimed automatically. */
export async function acquireInstallLock(root: string): Promise<() => Promise<void>> {
  const lock = join(root, "install.lock");
  try { await mkdir(lock); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(`install_busy: The AIBoard install lock exists. After confirming no install, update, or uninstall is running, delete ${lock} and retry.`);
  }
  const marker = join(lock, `owner-${randomUUID()}`);
  // If recording ownership fails, retain the lock: an incomplete lock is busy.
  await writeFile(marker, String(process.pid), { flag: "wx" });
  let released = false;
  return async () => {
    if (released) return;
    try {
      if (await readFile(marker, "utf8") !== String(process.pid)) throw new Error("owner marker changed");
      await unlink(marker);
      await rmdir(lock); // Only removes an empty directory; never removes another owner's files.
      released = true;
    } catch (error) {
      throw new Error(`install_lock_unverified: Could not release ${lock}; confirm no install, update, or uninstall is running before removing it (${error instanceof Error ? error.message : String(error)}).`);
    }
  };
}

async function fetchLimited(fetchImpl: typeof fetch, url: string, limit: number): Promise<Buffer> {
  const initial = new URL(url);
  const loopbackOrigin = initial.protocol === "http:" && initial.hostname === "127.0.0.1" ? initial.origin : undefined;
  const allowed = (candidate: URL): boolean => !candidate.username && !candidate.password &&
    (candidate.protocol === "https:" || (loopbackOrigin !== undefined && candidate.protocol === "http:" && candidate.origin === loopbackOrigin));
  if (!allowed(initial)) throw new Error("update_redirect_rejected: The download URL does not use an approved secure transport.");
  const signal = AbortSignal.timeout(10 * 60_000);
  let current = initial;
  let response: Response | undefined;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    try { response = await fetchImpl(current.href, { redirect: "manual", signal }); }
    catch (error) {
      throw new Error(`update_offline: Could not reach ${current.origin} (${error instanceof Error ? error.message : String(error)}). Check your connection and retry; nothing was changed.`);
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    let next: URL;
    try { if (!location) throw new Error("missing location"); next = new URL(location, current); }
    catch { throw new Error("update_redirect_rejected: The download returned an invalid redirect."); }
    if (!allowed(next) || (current.protocol === "https:" && next.protocol !== "https:")) {
      throw new Error("update_redirect_rejected: The download redirected to an unapproved transport.");
    }
    if (redirects === 5) throw new Error("update_redirect_rejected: The download redirected too many times.");
    current = next;
  }
  if (!response) throw new Error("update_download_failed: No response was received; nothing was changed.");
  if (!response.ok || !response.body) throw new Error(`update_download_failed: ${url} answered HTTP ${response.status}; nothing was changed.`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > limit) throw new Error(`update_download_failed: ${url} is larger than expected; nothing was changed.`);
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) { await reader.cancel().catch(() => undefined); throw new Error(`update_download_failed: ${url} is larger than expected; nothing was changed.`); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function parseReleaseInfo(value: unknown): ReleaseInfo {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("bundle_invalid: release.json is not an object");
  const info = value as Record<string, unknown>;
  if (info.schemaVersion !== 1 || info.product !== RELEASE_PRODUCT || !isReleaseVersion(info.version) ||
    typeof info.target !== "string" || !(RELEASE_TARGETS as readonly string[]).includes(info.target) || typeof info.nodeVersion !== "string" ||
    typeof info.files !== "object" || info.files === null || Array.isArray(info.files)) throw new Error("bundle_invalid: release.json is malformed");
  for (const [path, hash] of Object.entries(info.files as Record<string, unknown>)) {
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash) || path === "release.json") throw new Error("bundle_invalid: release.json inventory is malformed");
  }
  return info as unknown as ReleaseInfo;
}

async function listFiles(directory: string, base = directory): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(path, base));
    else if (entry.isFile()) result.push(relative(base, path).split(sep).join("/"));
    else throw new Error(`bundle_invalid: unexpected non-file entry ${relative(base, path)}`);
  }
  return result;
}

/** Proves an extracted (or retained) version still matches the inventory it shipped with. */
export async function verifyVersionDirectory(directory: string, expected: { version: string; target?: string }): Promise<ReleaseInfo> {
  const info = parseReleaseInfo(JSON.parse(await readFile(join(directory, "release.json"), "utf8")));
  if (info.version !== expected.version || (expected.target && info.target !== expected.target)) {
    throw new Error(`bundle_invalid: ${directory} holds ${info.version}/${info.target}, expected ${expected.version}${expected.target ? `/${expected.target}` : ""}.`);
  }
  const actual = (await listFiles(directory)).filter((path) => path !== "release.json").sort();
  const listed = Object.keys(info.files).sort();
  if (actual.length !== listed.length || actual.some((path, index) => path !== listed[index])) {
    throw new Error(`bundle_invalid: ${directory} has files that differ from its release inventory.`);
  }
  for (const path of listed) {
    if (sha256(await readFile(join(directory, ...path.split("/")))) !== info.files[path]) {
      throw new Error(`bundle_invalid: ${path} in ${info.version} does not match its release inventory.`);
    }
  }
  return info;
}

export function bundleNodePath(versionDirectory: string, platform: NodeJS.Platform = process.platform): string {
  return join(versionDirectory, "node", platform === "win32" ? "node.exe" : "node");
}

export function bundleEntryPath(versionDirectory: string): string {
  return join(versionDirectory, "app", "runner-v2", "bin", "aiboard.mjs");
}

/** Bounded smoke check: the staged bundle's own Node must start and report the expected version. */
export function smokeCheckVersion(versionDirectory: string, version: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(bundleNodePath(versionDirectory), [bundleEntryPath(versionDirectory), "version"], { timeout: 60_000, windowsHide: true, maxBuffer: 64 * 1024 }, (error, stdout) => {
      const reported = String(stdout).trim();
      if (error || reported !== `AIBoard Runner V2 ${version}`) {
        reject(new Error(`update_smoke_failed: The new version did not start (${error ? error.message.split("\n")[0] : JSON.stringify(reported.slice(0, 120))}); the current version stays active.`));
      } else resolve();
    });
  });
}

async function cleanOldVersions(layout: InstallLayout, keep: ReadonlySet<string>): Promise<void> {
  let entries: string[];
  try { entries = await readdir(layout.versionsDirectory); } catch { return; }
  for (const entry of entries) {
    if (keep.has(entry)) continue;
    const path = join(layout.versionsDirectory, entry);
    if (entry.startsWith(".staging-")) {
      const age = Date.now() - (await stat(path).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs;
      if (age < 60 * 60_000) continue;
    } else if (!isReleaseVersion(entry)) continue;
    // A Runner still running an old version keeps its files on Windows; retried on the next update.
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
  }
}

interface UpdateArguments { check: boolean; rollback: boolean }

function parseUpdateArguments(raw: string[]): UpdateArguments {
  const result = { check: false, rollback: false };
  for (const flag of raw) {
    if (flag === "--check" && !result.check) result.check = true;
    else if (flag === "--rollback" && !result.rollback) result.rollback = true;
    else throw new Error("invalid_arguments: Usage: aiboard update [--check | --rollback]");
  }
  if (result.check && result.rollback) throw new Error("invalid_arguments: Usage: aiboard update [--check | --rollback]");
  return result;
}

export async function runUpdateCommand(raw: string[], runtime: SelfUpdateRuntime = {}): Promise<void> {
  const args = parseUpdateArguments(raw);
  const layout = runtime.layout ?? detectInstallLayout();
  if (!layout) throw notManaged();
  const write = runtime.write ?? ((message: string) => process.stdout.write(message));
  const release = await acquireInstallLock(layout.root);
  try {
    const state = await readInstallState(layout);
    if (!state.current) throw new Error("install_state_invalid: No active version is recorded; reinstall with the one-line installer.");
    const target = (await verifyVersionDirectory(join(layout.versionsDirectory, state.current), { version: state.current }).catch((error: unknown) => {
      throw new Error(`install_state_invalid: The active version failed its integrity check (${error instanceof Error ? error.message : String(error)}); reinstall with the one-line installer.`);
    })).target;
    if (args.rollback) {
      await rollback(layout, state, target, write);
      return;
    }
    const config = runtime.config ?? await loadBundledConfig(layout);
    const fetchImpl = runtime.fetch ?? fetch;
    const manifestBytes = await fetchLimited(fetchImpl, config.manifestUrl, MANIFEST_LIMIT);
    const signature = (await fetchLimited(fetchImpl, `${config.manifestUrl}.sig`, SIGNATURE_LIMIT)).toString("utf8");
    const manifest = verifyReleaseManifest(manifestBytes, signature, config, {
      now: (runtime.now ?? (() => new Date()))(),
      ...(state.sequence !== undefined ? { highWaterSequence: state.sequence } : {}),
    });
    if (manifest.version === state.current) {
      if (!args.check && manifest.sequence > (state.sequence ?? 0)) await writeAtomic(join(layout.root, "sequence"), String(manifest.sequence));
      write(`AIBoard Runner ${state.current} is up to date.\n`);
      return;
    }
    if (args.check) {
      write(`Update available: ${manifest.version} (installed ${state.current}). Run: aiboard update\n`);
      return;
    }
    await installVersion(layout, state, target, manifest, fetchImpl, runtime, write);
  } finally {
    await release();
  }
}

async function installVersion(layout: InstallLayout, state: InstallState, target: ReleaseTarget, manifest: ReleaseManifest,
  fetchImpl: typeof fetch, runtime: SelfUpdateRuntime, write: (message: string) => void): Promise<void> {
  const artifact = manifest.artifacts.find((entry) => entry.target === target);
  if (!artifact) throw new Error(`update_unavailable: Release ${manifest.version} has no bundle for ${target}.`);
  const destination = join(layout.versionsDirectory, manifest.version);
  const smoke = runtime.smoke ?? smokeCheckVersion;
  if (existsSync(destination)) {
    // Already extracted earlier (e.g. before a rollback): re-prove it rather than trusting the directory.
    await verifyVersionDirectory(destination, { version: manifest.version, target });
  } else {
    write(`Downloading AIBoard Runner ${manifest.version} for ${target}...\n`);
    const archive = await fetchLimited(fetchImpl, artifact.url, artifact.bytes);
    if (archive.length !== artifact.bytes || sha256(archive) !== artifact.sha256) {
      throw new Error("update_checksum_mismatch: The downloaded bundle does not match the signed release manifest; nothing was installed.");
    }
    const staging = join(layout.versionsDirectory, `.staging-${manifest.version}-${process.pid}-${Date.now()}`);
    try {
      await extractFiles(readArchive(archive, artifact.format), staging);
      await verifyVersionDirectory(staging, { version: manifest.version, target });
      await smoke(staging, manifest.version);
      await rename(staging, destination);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }
  await smoke(destination, manifest.version);
  await writeAtomic(join(layout.root, "sequence"), String(Math.max(manifest.sequence, state.sequence ?? 0)));
  await writeShim(layout, process.platform);
  await writeAtomic(join(layout.root, "previous"), state.current!);
  await writeAtomic(join(layout.root, "current"), manifest.version);
  await cleanOldVersions(layout, new Set([manifest.version, state.current!, layout.runningVersion]));
  write(`Updated AIBoard Runner ${state.current} -> ${manifest.version}${artifact.preview ? ` (${target} is a preview build)` : ""}.\n` +
    "Runners that are already running keep the old version until you restart them.\n" +
    `To go back: aiboard update --rollback\n`);
}

async function rollback(layout: InstallLayout, state: InstallState, target: ReleaseTarget, write: (message: string) => void): Promise<void> {
  if (!state.previous || state.previous === state.current) throw new Error("rollback_unavailable: No previous version is kept on this machine.");
  const previousDirectory = join(layout.versionsDirectory, state.previous);
  if (!existsSync(previousDirectory)) throw new Error(`rollback_unavailable: Version ${state.previous} is no longer on this machine.`);
  // Only an already verified local version is selected; the accepted sequence never goes down.
  await verifyVersionDirectory(previousDirectory, { version: state.previous, target });
  await writeAtomic(join(layout.root, "previous"), state.current!);
  await writeAtomic(join(layout.root, "current"), state.previous);
  write(`Rolled back AIBoard Runner ${state.current} -> ${state.previous}. Run aiboard update to return to the newest release.\n`);
}

// ---------------------------------------------------------------- uninstall

interface UninstallArguments { yes: boolean; removeState?: boolean }

function parseUninstallArguments(raw: string[]): UninstallArguments {
  const result: UninstallArguments = { yes: false };
  const seen = new Set<string>();
  for (const flag of raw) {
    if (seen.has(flag)) throw new Error(`invalid_arguments: Duplicate option ${flag}.`);
    seen.add(flag);
    if (flag === "--yes" || flag === "-y") result.yes = true;
    else if (flag === "--remove-state" && result.removeState === undefined) result.removeState = true;
    else if (flag === "--keep-state" && result.removeState === undefined) result.removeState = false;
    else throw new Error("invalid_arguments: Usage: aiboard uninstall [--yes] [--keep-state | --remove-state]");
  }
  return result;
}

/** AIBoard data that `--remove-state` deletes, never touched otherwise. Project folders are never included. */
export function userStatePaths(options: { platform: NodeJS.Platform; environment: NodeJS.ProcessEnv; home: string; root: string }): string[] {
  if (options.platform === "win32") return [join(options.root, "projects"), join(options.root, "remote")];
  const xdg = options.environment.XDG_DATA_HOME;
  const data = options.platform === "darwin"
    ? join(options.home, "Library", "Application Support", "AIBoard")
    : join(xdg && xdg.startsWith("/") ? xdg : join(options.home, ".local", "share"), "aiboard");
  return [data, join(options.home, ".aiboard", "runner-extensions")];
}

export function stripProfileBlock(content: string): string {
  const lines = content.split("\n");
  const kept: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (line.trim() === PROFILE_MARKER_START) { inside = true; continue; }
    if (inside && line.trim() === PROFILE_MARKER_END) { inside = false; continue; }
    if (!inside) kept.push(line);
  }
  return inside ? content : kept.join("\n");
}

async function removePosixPath(home: string): Promise<void> {
  for (const name of POSIX_PROFILE_FILES) {
    const path = join(home, name);
    let content: string;
    try { content = await readFile(path, "utf8"); } catch { continue; }
    const stripped = stripProfileBlock(content);
    if (stripped !== content) await writeAtomic(path, stripped);
  }
  await unlink(join(home, ".config", "fish", "conf.d", "aiboard.fish")).catch(() => undefined);
}

/** PowerShell body that removes one directory from the user PATH, keeping other entries unexpanded and the value kind unchanged. */
export function windowsRemovePathScript(binDirectory: string, pathWasAbsent = false): string {
  const literal = binDirectory.replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    `$bin = '${literal}'`,
    "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)",
    "$old = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
    "$norm = { param($p) ([Environment]::ExpandEnvironmentVariables($p)).TrimEnd('\\').ToLowerInvariant() }",
    "$target = & $norm $bin",
    "$kept = @($old -split ';' | Where-Object { (& $norm $_) -ne $target })",
    "$new = $kept -join ';'",
    "if ($new -ne $old) {",
    "  $kind = $key.GetValueKind('Path')",
    `  if (-not $new -and ${pathWasAbsent ? "$true" : "$false"}) { $key.DeleteValue('Path', $false) } else { $key.SetValue('Path', $new, $kind) }`,
    "  [Environment]::SetEnvironmentVariable('AIBOARD_PATH_REFRESH', '1', 'User')",
    "  [Environment]::SetEnvironmentVariable('AIBOARD_PATH_REFRESH', $null, 'User')",
    "}",
    "$key.Close()",
  ].join("\n");
}

function runPowerShell(script: string): Promise<void> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const shell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return new Promise((resolve, reject) => {
    execFile(shell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { windowsHide: true, timeout: 60_000 }, (error) => {
      if (error) reject(new Error(`uninstall_path_failed: Could not edit the user PATH (${error.message.split("\n")[0]}).`)); else resolve();
    });
  });
}

/** Batch file the shim runs after Node exits; its last line leaves the batch context before deleting itself (or the whole root). */
export function windowsCleanupScript(paths: readonly string[], removeRoot?: string): string {
  const quote = (path: string) => `"${path.replace(/%/g, "%%")}"`;
  return [
    "@echo off",
    ...paths.map((path) => `if exist ${quote(`${path}\\*`)} (rd /s /q ${quote(path)} 2>nul) else (if exist ${quote(path)} del /f /q ${quote(path)} 2>nul)`),
    removeRoot ? `(goto) 2>nul & rd /s /q ${quote(removeRoot)} 2>nul` : '(goto) 2>nul & del /f /q "%~f0"',
    "",
  ].join("\r\n");
}

async function askTerminal(question: string): Promise<boolean> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer: string = await new Promise((resolve) => terminal.question(question, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally { terminal.close(); }
}

export async function runUninstallCommand(raw: string[], runtime: SelfUpdateRuntime = {}): Promise<void> {
  const args = parseUninstallArguments(raw);
  const layout = runtime.layout ?? detectInstallLayout();
  if (!layout) throw notManaged();
  const write = runtime.write ?? ((message: string) => process.stdout.write(message));
  const platform = runtime.platform ?? process.platform;
  const environment = runtime.environment ?? process.env;
  const home = runtime.home ?? homedir();
  const interactive = runtime.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  const confirm = runtime.confirm ?? askTerminal;
  if (!args.yes) {
    if (!interactive) throw new Error("uninstall_confirmation_required: Rerun with --yes to uninstall without a prompt (add --remove-state to also delete AIBoard data).");
    if (!(await confirm(`Remove AIBoard Runner from ${layout.root}? Stop any running AIBoard Runner first. [y/N] `))) { write("Uninstall cancelled.\n"); return; }
  }
  let removeState = args.removeState;
  if (removeState === undefined) {
    removeState = interactive && !args.yes
      ? await confirm("Also delete your AIBoard data (project state, remote device key, extensions)? Your project folders are never touched. [y/N] ")
      : false;
  }
  const release = await acquireInstallLock(layout.root);
  const leftovers: string[] = [];
  try {
    if (platform === "win32") await (runtime.editUserPath ?? ((bin: string) => runPowerShell(windowsRemovePathScript(bin, existsSync(join(layout.root, "path-was-absent"))))))(layout.binDirectory);
    else await (runtime.editUserPath ?? (() => removePosixPath(home)))(layout.binDirectory);
    // Windows keeps the running node.exe and the cmd shim open until this process exits: remove them afterwards.
    const deferred = platform === "win32" ? [join(layout.versionsDirectory, layout.runningVersion), layout.versionsDirectory, layout.binDirectory] : [];
    const versions = platform === "win32"
      ? (await readdir(layout.versionsDirectory).catch(() => [] as string[])).filter((name) => name !== layout.runningVersion).map((name) => join(layout.versionsDirectory, name))
      : [layout.versionsDirectory, layout.binDirectory];
    const managed = [...versions, ...["current", "previous", "sequence", "install.json", "path-was-absent"].map((name) => join(layout.root, name))];
    const state = removeState ? userStatePaths({ platform, environment, home, root: layout.root }) : [];
    for (const path of [...managed, ...state]) {
      try { await rm(path, { recursive: true, force: true, maxRetries: 2 }); }
      catch { leftovers.push(path); }
    }
    leftovers.push(...deferred);
  } finally {
    await release();
  }
  if (platform === "win32") {
    // This process and the cmd shim that started it still hold the running version and bin\;
    // the shim runs this cleanup right after Node exits.
    await writeFile(join(layout.root, UNINSTALL_PENDING_SCRIPT), windowsCleanupScript(leftovers, removeState ? layout.root : undefined), "latin1");
    const shimRoot = runtime.shimRoot ?? (environment.AIBOARD_ROOT ? resolve(environment.AIBOARD_ROOT) : undefined);
    if (!shimRoot || shimRoot.toLowerCase() !== resolve(layout.root).toLowerCase()) {
      write(`Finish by running ${join(layout.root, UNINSTALL_PENDING_SCRIPT)} after this command exits.\n`);
    }
  } else {
    try { await rmdir(layout.root); } catch { /* keeps state or other files */ }
    if (leftovers.length > 0) write(`Could not remove: ${leftovers.join(", ")}\n`);
  }
  write(`AIBoard Runner was uninstalled.${removeState ? " AIBoard data was deleted." : " AIBoard data was kept; run the installer again to continue where you left off."}\n` +
    "Open a new terminal so the PATH change takes effect.\n");
}

// ---------------------------------------------------------------- doctor

export async function runDoctorCommand(version: string, runtime: SelfUpdateRuntime = {}): Promise<void> {
  const write = runtime.write ?? ((message: string) => process.stdout.write(message));
  const layout = runtime.layout ?? detectInstallLayout();
  const lines = [`AIBoard Runner V2 ${version}`];
  if (layout) {
    const state = await readInstallState(layout).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
    if ("error" in state) lines.push(`Install: ${layout.root} (${state.error})`);
    else {
      const info = await readFile(join(layout.versionsDirectory, layout.runningVersion, "release.json"), "utf8").then((text) => parseReleaseInfo(JSON.parse(text))).catch(() => undefined);
      lines.push(`Install: ${layout.root}`, `  active ${state.current ?? "none"}, rollback ${state.previous ?? "none"}, release sequence ${state.sequence ?? "none"}, target ${info?.target ?? "unknown"}`);
      if (state.current !== layout.runningVersion) lines.push(`  this process runs ${layout.runningVersion}; restart it to use ${state.current ?? "the active version"}`);
    }
  } else lines.push("Install: developer checkout or ZIP (not managed by the installer; `aiboard update` is unavailable)");
  lines.push(`Node: ${process.version} (${process.execPath})`, `Platform: ${process.platform} ${process.arch}`);
  const git = await new Promise<string>((resolve) => execFile("git", ["--version"], { timeout: 10_000, windowsHide: true }, (error, stdout) => resolve(error ? "not found (Build mode needs Git on PATH)" : String(stdout).trim())));
  lines.push(`Git: ${git}`);
  write(`${lines.join("\n")}\n`);
}
