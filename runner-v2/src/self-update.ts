// RUNNER_RAW_PROCESS_BOUNDARY: The managed-install lifecycle runs the staged bundle's own Node for its smoke check,
// Git for `doctor`, and PowerShell to edit the per-user PATH on Windows; none of them receives a secret.
// Managed install lifecycle (L2, ADR-E): `aiboard update`, `aiboard update --rollback`, `aiboard uninstall`, `aiboard doctor`.
// Layout (shared with install.ps1 / install.sh):
//   <root>/install.json        marker written by the installer
//   <root>/current             active version (atomic pointer, read by the bin shims)
//   <root>/previous            last known-good version kept for rollback
//   <root>/sequence            highest signed channel sequence accepted on this machine
//   <root>/versions/<version>  verified, extracted bundles
//   <root>/runtimes/copilot    Copilot CLI runtime, downloaded on first use (copilot-runtime.ts)
//   <root>/bin/aiboard(.cmd)   PATH shims
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, type Stats } from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile, realpath, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { extractFiles, readArchive } from "./release-archive.js";
import {
  isReleaseVersion, parseReleaseChannelConfig, releaseAnchorDigest, RELEASE_PRODUCT, RELEASE_TARGETS, verifyReleaseEpochOpening, verifyReleaseManifest,
  type ReleaseArtifact, type ReleaseChannelConfig, type ReleaseManifest, type ReleaseTarget,
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
  /** Moves a verified bundle out of staging into versions/<version>. */
  renameVersion?: (from: string, to: string) => Promise<void>;
  /** Waits between the Windows retries of renameVersion. */
  sleep?: (ms: number) => Promise<void>;
  editUserPath?: (binDirectory: string) => Promise<void>;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  home?: string;
  /** Windows: AIBOARD_ROOT of the shim that started this process, if any. */
  shimRoot?: string;
}

const MANIFEST_LIMIT = 64 * 1024;
const SIGNATURE_LIMIT = 4 * 1024;
/** GitHub's release metadata, read only to find a bundle's asset id (v0.3.6 is 15 KB). */
const GITHUB_RELEASE_LIMIT = 1024 * 1024;
const MAX_RECOVERY_EPOCHS = 16;
/**
 * Windows: an antivirus scan, or the smoke check's node.exe that has just exited, can hold a file of a new bundle
 * for a moment, so moving it into versions\ fails with EPERM. About 4.5 s of retries in all.
 */
const WINDOWS_RENAME_RETRY_DELAYS_MS: readonly number[] = [50, 100, 200, 400, 800, 1000, 1000, 1000];
const WINDOWS_RENAME_RETRY_CODES: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);
const PROFILE_MARKER_START = "# >>> aiboard installer >>>";
const PROFILE_MARKER_END = "# <<< aiboard installer <<<";
const PROFILE_BLOCK = [PROFILE_MARKER_START, 'case ":${PATH}:" in *":$HOME/.aiboard/bin:"*) ;; *) export PATH="$HOME/.aiboard/bin:$PATH" ;; esac', PROFILE_MARKER_END].join("\n");
const FISH_CONFIG = "contains -- $HOME/.aiboard/bin $PATH; or set -gx PATH $HOME/.aiboard/bin $PATH\n";
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

async function loadBundledConfig(layout: InstallLayout, version = layout.runningVersion): Promise<ReleaseChannelConfig> {
  const path = join(layout.versionsDirectory, version, "app", "runner-v2", "release-channel.json");
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

export interface InstallState { current?: string; previous?: string; epoch?: number; sequence?: number }

export async function readInstallState(layout: InstallLayout): Promise<InstallState> {
  const sequencePath = join(layout.root, "sequence");
  const sequenceText = await readPointer(sequencePath);
  if (sequenceText === undefined && existsSync(sequencePath)) throw new Error("install_state_invalid: sequence is corrupt; reinstall with the one-line installer.");
  const match = sequenceText === undefined ? undefined : /^(?:(0|[1-9][0-9]*):)?([1-9][0-9]*)$/.exec(sequenceText);
  const epoch = match ? Number(match[1] ?? 0) : undefined;
  const sequence = match ? Number(match[2]) : undefined;
  if (sequenceText !== undefined && (!match || !Number.isSafeInteger(sequence) || sequence! > 2 ** 40 || !Number.isSafeInteger(epoch) || epoch! > 2 ** 20)) throw new Error("install_state_invalid: sequence is corrupt; reinstall with the one-line installer.");
  return {
    current: await readVersionPointer(join(layout.root, "current")),
    previous: await readVersionPointer(join(layout.root, "previous")),
    ...(sequence !== undefined ? { epoch, sequence } : {}),
  };
}

async function writeAtomic(path: string, content: string, mode = 0o644): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, { flag: "wx", mode });
  try { await rename(temporary, path); }
  catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
}

async function effectiveConfig(layout: InstallLayout, bundled: ReleaseChannelConfig, state: InstallState): Promise<ReleaseChannelConfig> {
  bundled = parseReleaseChannelConfig(bundled);
  const localPath = join(layout.root, "trusted-channel.json");
  const local = await readPointer(localPath);
  if (local === undefined && existsSync(localPath)) throw new Error("install_state_invalid: the stored release trust anchor is empty.");
  const config = local === undefined ? bundled : parseReleaseChannelConfig(JSON.parse(local));
  if (config.channel !== bundled.channel || JSON.stringify(config.recoveryKeys ?? []) !== JSON.stringify(bundled.recoveryKeys ?? [])) {
    throw new Error("install_state_invalid: the stored trust anchor does not match this installation; reinstall with the one-line installer.");
  }
  const digestPath = join(layout.root, "sequence-anchor");
  const digest = await readPointer(digestPath);
  if (digest === undefined && existsSync(digestPath)) throw new Error("install_state_invalid: the stored release trust digest is empty.");
  if ((digest !== undefined && digest !== releaseAnchorDigest(config)) || (local !== undefined && digest === undefined) ||
      (state.epoch !== undefined && state.epoch !== (config.epoch ?? 0))) {
    throw new Error("install_state_invalid: the stored release trust anchor is inconsistent; reinstall with the one-line installer.");
  }
  return config;
}

function acceptedConfig(config: ReleaseChannelConfig, manifest: ReleaseManifest, bundledNext?: ReleaseChannelConfig): ReleaseChannelConfig {
  const epoch = manifest.epoch ?? 0;
  let next = epoch > (config.epoch ?? 0)
    ? parseReleaseChannelConfig({ ...config, epoch, keys: manifest.signingKeys, minSequence: 1 })
    : config;
  // A verified ordinary-release bundle may carry the next phase of planned same-epoch key rotation.
  if (bundledNext && epoch === (config.epoch ?? 0) && (bundledNext.epoch ?? 0) === epoch) {
    if (bundledNext.channel !== config.channel || bundledNext.manifestUrl !== config.manifestUrl || bundledNext.artifactPrefix !== config.artifactPrefix ||
        JSON.stringify(bundledNext.recoveryKeys ?? []) !== JSON.stringify(config.recoveryKeys ?? []) || !bundledNext.keys.length) {
      throw new Error("bundle_invalid: the bundled release trust anchor is inconsistent.");
    }
    next = bundledNext;
  }
  return next;
}

async function recordAcceptedRelease(layout: InstallLayout, config: ReleaseChannelConfig, manifest: ReleaseManifest, bundledNext?: ReleaseChannelConfig): Promise<void> {
  const epoch = manifest.epoch ?? 0;
  const next = acceptedConfig(config, manifest, bundledNext);
  // An interrupted transition leaves inconsistent records, which effectiveConfig refuses to use.
  await writeAtomic(join(layout.root, "trusted-channel.json"), JSON.stringify(next), 0o600);
  await writeAtomic(join(layout.root, "sequence"), `${epoch}:${manifest.sequence}`, 0o600);
  await writeAtomic(join(layout.root, "sequence-anchor"), releaseAnchorDigest(next), 0o600);
}

/** Releases the lock; `ownerName` is this owner's marker inside install.lock, so a deferred cleanup can prove it still owns the lock. */
export type InstallLockRelease = (() => Promise<void>) & { readonly ownerName: string };

/** A lock with unknown ownership is never reclaimed automatically. */
export async function acquireInstallLock(root: string): Promise<InstallLockRelease> {
  const lock = join(root, "install.lock");
  try { await mkdir(lock); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(`install_busy: The AIBoard install lock exists. After confirming no install, update, or uninstall is running, delete ${lock} and retry.`);
  }
  const ownerName = `owner-${randomUUID()}`;
  const marker = join(lock, ownerName);
  // If recording ownership fails, retain the lock: an incomplete lock is busy.
  await writeFile(marker, String(process.pid), { flag: "wx" });
  let released = false;
  return Object.assign(async () => {
    if (released) return;
    try {
      if (await readFile(marker, "utf8") !== String(process.pid)) throw new Error("owner marker changed");
      await unlink(marker);
      await rmdir(lock); // Only removes an empty directory; never removes another owner's files.
      released = true;
    } catch (error) {
      throw new Error(`install_lock_unverified: Could not release ${lock}; confirm no install, update, or uninstall is running before removing it (${error instanceof Error ? error.message : String(error)}).`);
    }
  }, { ownerName });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A download failure that another route may avoid: an HTTP 5xx answer, a timeout, or a network error. */
class TransientDownloadError extends Error {
  constructor(message: string, readonly reason: string) { super(message); this.name = "TransientDownloadError"; }
}

async function fetchLimited(fetchImpl: typeof fetch, url: string, limit: number, headers?: Record<string, string>): Promise<Buffer> {
  const initial = new URL(url);
  const loopbackOrigin = initial.protocol === "http:" && initial.hostname === "127.0.0.1" ? initial.origin : undefined;
  const allowed = (candidate: URL): boolean => !candidate.username && !candidate.password &&
    (candidate.protocol === "https:" || (loopbackOrigin !== undefined && candidate.protocol === "http:" && candidate.origin === loopbackOrigin));
  if (!allowed(initial)) throw new Error("update_redirect_rejected: The download URL does not use an approved secure transport.");
  const signal = AbortSignal.timeout(10 * 60_000);
  let current = initial;
  let response: Response | undefined;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    try { response = await fetchImpl(current.href, { redirect: "manual", signal, ...(headers ? { headers } : {}) }); }
    catch (error) {
      const reason = errorText(error);
      throw new TransientDownloadError(`update_offline: Could not reach ${current.origin} (${reason}). Check your connection and retry; nothing was changed.`, reason);
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
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    const message = `update_download_failed: ${url} answered HTTP ${response.status}; nothing was changed.`;
    throw response.status >= 500 ? new TransientDownloadError(message, `HTTP ${response.status}`) : new Error(message);
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > limit) throw new Error(`update_download_failed: ${url} is larger than expected; nothing was changed.`);
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try { chunk = await reader.read(); }
    catch (error) {
      // The ten-minute timeout or a dropped connection while the body streams.
      const reason = errorText(error);
      throw new TransientDownloadError(`update_offline: The download from ${current.origin} was interrupted (${reason}). Check your connection and retry; nothing was changed.`, reason);
    }
    const { done, value } = chunk;
    if (done) break;
    total += value.byteLength;
    if (total > limit) { await reader.cancel().catch(() => undefined); throw new Error(`update_download_failed: ${url} is larger than expected; nothing was changed.`); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

interface GithubReleaseAsset { owner: string; repository: string; tag: string; name: string }

/** Parses `https://github.com/<owner>/<repository>/releases/download/<tag>/<name>`, the link a GitHub release asset is published under. */
function githubReleaseAsset(url: string): GithubReleaseAsset | undefined {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return undefined; }
  if (parsed.protocol !== "https:" || parsed.host !== "github.com" || parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
  const match = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/releases\/download\/([^/]+)\/([^/]+)$/.exec(parsed.pathname);
  if (!match) return undefined;
  try {
    return { owner: match[1]!, repository: match[2]!, tag: decodeURIComponent(match[3]!), name: decodeURIComponent(match[4]!) };
  } catch { return undefined; }
}

/**
 * The same asset through GitHub's REST API, without a token: the release-by-tag answer gives the asset id, and
 * `releases/assets/<id>` with `Accept: application/octet-stream` redirects to the asset's download host. Only the
 * numeric id comes from GitHub's answer; the repository and the expected size come from the signed manifest.
 */
async function fetchGithubReleaseAsset(fetchImpl: typeof fetch, asset: GithubReleaseAsset, limit: number, userAgent: string): Promise<Buffer> {
  const repository = `https://api.github.com/repos/${asset.owner}/${asset.repository}`;
  const metadata = await fetchLimited(fetchImpl, `${repository}/releases/tags/${encodeURIComponent(asset.tag)}`, GITHUB_RELEASE_LIMIT,
    { accept: "application/vnd.github+json", "user-agent": userAgent });
  let id: unknown;
  try {
    const release = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metadata)) as { assets?: unknown };
    const matches = Array.isArray(release.assets)
      ? release.assets.filter((entry: unknown) => typeof entry === "object" && entry !== null && (entry as { name?: unknown }).name === asset.name)
      : [];
    if (matches.length === 1) id = (matches[0] as { id?: unknown }).id;
  } catch { /* Reported below. */ }
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
    throw new Error(`update_download_failed: GitHub's API did not list ${asset.name} in release ${asset.tag}; nothing was changed.`);
  }
  return fetchLimited(fetchImpl, `${repository}/releases/assets/${id}`, limit, { accept: "application/octet-stream", "user-agent": userAgent });
}

/**
 * Downloads a release bundle. GitHub's releases/download links have answered 504 for many minutes while the same
 * asset kept working through the REST API, so a transient failure of such a link is retried once through the API.
 * The caller verifies whatever arrives against the signed manifest, so the route cannot change what gets installed.
 * When both routes fail, the link's own error is thrown.
 */
async function downloadArtifact(fetchImpl: typeof fetch, artifact: ReleaseArtifact, userAgent: string, write: (message: string) => void): Promise<Buffer> {
  try { return await fetchLimited(fetchImpl, artifact.url, artifact.bytes); }
  catch (error) {
    const asset = githubReleaseAsset(artifact.url);
    if (!(error instanceof TransientDownloadError) || !asset) throw error;
    write(`The GitHub download link failed (${error.reason}); trying the GitHub API...\n`);
    try { return await fetchGithubReleaseAsset(fetchImpl, asset, artifact.bytes, userAgent); }
    catch (fallback) {
      write(`The GitHub API failed too (${fallback instanceof TransientDownloadError ? fallback.reason : errorText(fallback)}).\n`);
      throw error;
    }
  }
}

async function verifyCurrentRelease(bytes: Buffer, signature: string, initial: ReleaseChannelConfig, state: InstallState,
  fetchImpl: typeof fetch, now: Date): Promise<{ manifest: ReleaseManifest; config: ReleaseChannelConfig }> {
  const options = { now, ...(state.sequence !== undefined ? { highWaterSequence: state.sequence, highWaterEpoch: state.epoch } : {}) };
  try {
    const manifest = verifyReleaseManifest(bytes, signature, initial, options);
    if ((manifest.epoch ?? 0) - (initial.epoch ?? 0) > MAX_RECOVERY_EPOCHS) throw new Error("too many epochs");
    return { manifest, config: initial };
  } catch (error) {
    // This untrusted field is only a bounded hint for fixed sibling URLs; no keys or release data are trusted from it.
    let epoch: unknown;
    try {
      const hint = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as { schemaVersion?: unknown; epoch?: unknown };
      if (hint.schemaVersion === 2) epoch = hint.epoch;
    } catch { /* Preserve the original verification error. */ }
    if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch <= (initial.epoch ?? 0)) throw error;
    try {
      if (epoch > 2 ** 20) throw new Error("invalid epoch");
      if (epoch - (initial.epoch ?? 0) > MAX_RECOVERY_EPOCHS) throw new Error("too many epochs");
      let config = initial;
      let highWaterSequence = state.sequence;
      let highWaterEpoch = state.epoch;
      for (let next = (initial.epoch ?? 0) + 1; next <= epoch; next += 1) {
        const url = new URL(`epoch-${next}.json`, initial.manifestUrl).href;
        const openingBytes = await fetchLimited(fetchImpl, url, MANIFEST_LIMIT);
        const openingSignature = (await fetchLimited(fetchImpl, `${url}.sig`, SIGNATURE_LIMIT)).toString("utf8");
        const opening = verifyReleaseEpochOpening(openingBytes, openingSignature, config, now);
        config = acceptedConfig(config, opening);
        highWaterEpoch = opening.epoch;
        highWaterSequence = opening.sequence;
      }
      const manifest = verifyReleaseManifest(bytes, signature, config, { now, highWaterEpoch, highWaterSequence });
      return { manifest, config };
    } catch (cause) {
      throw new Error(`release_manifest_rejected: Could not verify the release recovery history (${cause instanceof Error ? cause.message : String(cause)}); reinstall with the one-line installer.`);
    }
  }
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
    // A staging name alone does not prove this run created it.
    if (!isReleaseVersion(entry)) continue;
    // A Runner still running an old version keeps its files on Windows; retried on the next update.
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
  }
}

function sameDirectory(before: Stats, after: Stats): boolean {
  return before.isDirectory() && after.isDirectory() && before.dev === after.dev && before.ino === after.ino;
}

/** Renames a verified bundle into place; on Windows a briefly held file is retried with backoff, re-checking staging first. */
async function renameVersionDirectory(from: string, to: string, options: {
  platform: NodeJS.Platform; rename: (from: string, to: string) => Promise<void>; sleep: (ms: number) => Promise<void>; beforeRetry: () => Promise<void>;
}): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try { await options.rename(from, to); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (options.platform !== "win32" || typeof code !== "string" || !WINDOWS_RENAME_RETRY_CODES.has(code)) throw error;
      const wait = WINDOWS_RENAME_RETRY_DELAYS_MS[attempt];
      if (wait === undefined) {
        throw new Error(`update_version_busy: Windows kept a file of the new version busy (${errorText(error)}); the current version stays active. Retry in a minute.`);
      }
      await options.sleep(wait);
      await options.beforeRetry();
    }
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
    const initial = await effectiveConfig(layout, runtime.config ?? await loadBundledConfig(layout), state);
    const fetchImpl = runtime.fetch ?? fetch;
    const manifestBytes = await fetchLimited(fetchImpl, initial.manifestUrl, MANIFEST_LIMIT);
    const signature = (await fetchLimited(fetchImpl, `${initial.manifestUrl}.sig`, SIGNATURE_LIMIT)).toString("utf8");
    const { manifest, config } = await verifyCurrentRelease(manifestBytes, signature, initial, state, fetchImpl, (runtime.now ?? (() => new Date()))());
    if (manifest.version === state.current) {
      if (!args.check) await recordAcceptedRelease(layout, config, manifest);
      write(`AIBoard Runner ${state.current} is up to date.\n`);
      return;
    }
    if (args.check) {
      write(`Update available: ${manifest.version} (installed ${state.current}). Run: aiboard update\n`);
      return;
    }
    await installVersion(layout, state, target, manifest, config, fetchImpl, runtime, write);
  } finally {
    await release();
  }
}

async function installVersion(layout: InstallLayout, state: InstallState, target: ReleaseTarget, manifest: ReleaseManifest, config: ReleaseChannelConfig,
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
    const archive = await downloadArtifact(fetchImpl, artifact, `AIBoard-Runner/${layout.runningVersion}`, write);
    if (archive.length !== artifact.bytes || sha256(archive) !== artifact.sha256) {
      throw new Error("update_checksum_mismatch: The downloaded bundle does not match the signed release manifest; nothing was installed.");
    }
    const staging = join(layout.versionsDirectory, `.staging-${manifest.version}-${process.pid}-${Date.now()}`);
    const extracted = join(staging, "bundle");
    let created: Stats | undefined;
    try {
      await mkdir(staging);
      created = await lstat(staging);
      if (!created.isDirectory()) throw new Error("update_staging_invalid: The staging directory changed during creation.");
      const owned = created;
      const stagingUnchanged = async () => {
        if (!sameDirectory(owned, await lstat(staging))) throw new Error("update_staging_invalid: The staging directory changed during extraction.");
      };
      await extractFiles(readArchive(archive, artifact.format), extracted);
      await verifyVersionDirectory(extracted, { version: manifest.version, target });
      await smoke(extracted, manifest.version);
      await stagingUnchanged();
      await renameVersionDirectory(extracted, destination, {
        platform: runtime.platform ?? process.platform, rename: runtime.renameVersion ?? rename, sleep: runtime.sleep ?? ((ms) => delay(ms)), beforeRetry: stagingUnchanged,
      });
      await stagingUnchanged();
      await rmdir(staging);
      created = undefined;
    } catch (error) {
      if (created?.isDirectory()) {
        const current = await lstat(staging).catch(() => undefined);
        if (current && sameDirectory(created, current)) {
          await rm(staging, { recursive: true, force: true }).catch(() => undefined);
        }
      }
      throw error;
    }
  }
  await smoke(destination, manifest.version);
  const bundledNext = await loadBundledConfig(layout, manifest.version).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  await recordAcceptedRelease(layout, config, manifest, bundledNext);
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
  if (options.platform === "win32") return [join(options.root, "projects"), join(options.root, "remote"), join(options.home, ".aiboard", "runner-extensions")];
  const xdg = options.environment.XDG_DATA_HOME;
  const data = options.platform === "darwin"
    ? join(options.home, "Library", "Application Support", "AIBoard")
    : join(xdg && xdg.startsWith("/") ? xdg : join(options.home, ".local", "share"), "aiboard");
  return [data, join(options.home, ".aiboard", "runner-extensions")];
}

export function stripProfileBlock(content: string): string {
  let offset = 0;
  for (;;) {
    const start = content.indexOf(PROFILE_BLOCK, offset);
    if (start < 0) return content;
    const end = start + PROFILE_BLOCK.length;
    if ((start === 0 || content[start - 1] === "\n") && (end === content.length || content[end] === "\n")) {
      content = content.slice(0, start) + content.slice(end + (content[end] === "\n" ? 1 : 0));
      offset = start;
    } else {
      offset = end;
    }
  }
}

function sameRegularFile(before: Stats, after: Stats): boolean {
  return before.isFile() && after.isFile() && before.dev === after.dev && before.ino === after.ino &&
    before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

async function removePosixPath(home: string, write: (message: string) => void): Promise<void> {
  let canonicalHome: string;
  try { canonicalHome = await realpath(home); } catch { return; }
  for (const name of POSIX_PROFILE_FILES) {
    const path = join(canonicalHome, name);
    try {
      const before = await lstat(path);
      if (!before.isFile()) continue;
      const bytes = await readFile(path);
      const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      const stripped = stripProfileBlock(content);
      if (stripped === content || !sameRegularFile(before, await lstat(path))) continue;
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, stripped, { flag: "wx", mode: before.mode & 0o7777 });
      let temporaryOwned = true;
      try {
        if (!sameRegularFile(before, await lstat(path)) || !(await readFile(path)).equals(bytes)) continue;
        await rename(temporary, path);
        temporaryOwned = false;
      } finally { if (temporaryOwned) await unlink(temporary).catch(() => undefined); }
    } catch { /* Leave unreadable or changed user files alone. */ }
  }

  const fishParent = join(canonicalHome, ".config", "fish", "conf.d");
  const fishName = join(fishParent, "aiboard.fish");
  const kept = () => write(`Kept ${fishName}: it is not the unchanged installer-owned fish configuration.\n`);
  try {
    const parent = await realpath(fishParent);
    const rel = relative(canonicalHome, parent);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) { kept(); return; }
    const path = join(parent, "aiboard.fish");
    const before = await lstat(path);
    if (!before.isFile() || await readFile(path, "utf8") !== FISH_CONFIG ||
        !sameRegularFile(before, await lstat(path)) || await readFile(path, "utf8") !== FISH_CONFIG) { kept(); return; }
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") kept();
  }
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

/**
 * Batch file the shim runs after Node exits. The uninstall hands its install lock to this script, so an
 * install cannot start until the cleanup has finished; every destructive line first checks that the
 * uninstall's owner marker is still in install.lock, so a replaced lock (a newer install) is never touched.
 * Paths are relative to the script's own folder (`%~dp0`, the install root) and the file is ASCII-only:
 * cmd expands `%~dp0` itself, so a Unicode or special-character root never passes through a code page or
 * the batch parser. Its last line leaves the batch context, then deletes itself and releases the lock (or
 * removes the whole root, lock included).
 */
export function windowsCleanupScript(options: { ownerName: string; relativePaths: readonly string[]; removeRoot: boolean }): string {
  const safe = /^[A-Za-z0-9._-]+(\\[A-Za-z0-9._-]+)*$/;
  for (const name of [options.ownerName, ...options.relativePaths]) {
    if (!safe.test(name) || name.split("\\").some((part) => part === "." || part === "..")) throw new Error(`uninstall_cleanup_invalid: ${JSON.stringify(name)} is not a plain relative path.`);
  }
  const at = (path: string) => `"%~dp0${path}"`;
  const owned = `if exist ${at(`install.lock\\${options.ownerName}`)}`;
  return [
    "@echo off",
    "setlocal DisableDelayedExpansion",
    ...options.relativePaths.map((path) => `${owned} (if exist ${at(`${path}\\*`)} (rd /s /q ${at(path)} 2>nul) else (if exist ${at(path)} del /f /q ${at(path)} 2>nul))`),
    options.removeRoot
      ? `(goto) 2>nul & ${owned} rd /s /q "%~dp0." 2>nul`
      : `(goto) 2>nul & ${owned} (del /f /q "%~f0" & del /f /q ${at(`install.lock\\${options.ownerName}`)} & rd ${at("install.lock")})`,
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
  let lockHandedOff = false;
  try {
    if (platform === "win32") await (runtime.editUserPath ?? ((bin: string) => runPowerShell(windowsRemovePathScript(bin, existsSync(join(layout.root, "path-was-absent"))))))(layout.binDirectory);
    else await (runtime.editUserPath ?? (() => removePosixPath(home, write)))(layout.binDirectory);
    // Windows keeps the running node.exe and the cmd shim open until this process exits: remove them afterwards.
    const deferred = platform === "win32" ? [join(layout.versionsDirectory, layout.runningVersion), layout.versionsDirectory, layout.binDirectory] : [];
    const versions = platform === "win32"
      ? (await readdir(layout.versionsDirectory).catch(() => [] as string[])).filter((name) => name !== layout.runningVersion).map((name) => join(layout.versionsDirectory, name))
      : [layout.versionsDirectory, layout.binDirectory];
    const managed = [...versions, ...["current", "previous", "sequence", "sequence-anchor", "trusted-channel.json", "install.json", "path-was-absent", "runtimes"].map((name) => join(layout.root, name))];
    const state = removeState ? userStatePaths({ platform, environment, home, root: layout.root }) : [];
    for (const path of [...managed, ...state]) {
      try { await rm(path, { recursive: true, force: true, maxRetries: 2 }); }
      catch { leftovers.push(path); }
    }
    if (platform === "win32") {
      // This process and the cmd shim that started it still hold the running version and bin\; the shim
      // runs this cleanup right after Node exits. The lock passes to the cleanup, which releases it last,
      // so an install cannot start (and have its files deleted) before the cleanup is done.
      const inRoot = (path: string) => relative(layout.root, path);
      const retry = [...leftovers, ...deferred].filter((path) => { const name = inRoot(path); return name !== "" && !name.startsWith("..") && !isAbsolute(name); });
      const script = windowsCleanupScript({ ownerName: release.ownerName, relativePaths: retry.map((path) => inRoot(path).split(/[\\/]/).join("\\")), removeRoot: removeState });
      await writeAtomic(join(layout.root, UNINSTALL_PENDING_SCRIPT), script);
      lockHandedOff = true;
      leftovers.splice(0, leftovers.length, ...leftovers.filter((path) => !retry.includes(path)));
    }
  } finally {
    if (!lockHandedOff) await release();
  }
  if (platform === "win32") {
    const shimRoot = runtime.shimRoot ?? (environment.AIBOARD_ROOT ? resolve(environment.AIBOARD_ROOT) : undefined);
    if (!shimRoot || shimRoot.toLowerCase() !== resolve(layout.root).toLowerCase()) {
      write(`Finish by running ${join(layout.root, UNINSTALL_PENDING_SCRIPT)} after this command exits; the install lock stays held until it has run.\n`);
    }
  } else {
    try { await rmdir(layout.root); } catch { /* keeps state or other files */ }
  }
  if (leftovers.length > 0) write(`Could not remove: ${leftovers.join(", ")}\n`);
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
