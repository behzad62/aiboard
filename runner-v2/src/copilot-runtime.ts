// On-demand GitHub Copilot CLI runtime for installed Runner bundles.
// The Copilot SDK drives the platform package @github/copilot-<os>-<arch> (~270 MB unpacked). Release bundles do
// not carry it; they carry its lockfile pin (copilot-runtime.json, covered by the signed release inventory). The
// first time the Copilot provider needs it, the exact npm tarball is downloaded, checked against the pinned
// SHA-512 integrity and unpacked unmodified into a per-user runtime folder. Nothing is pruned or patched.
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BUNDLE_ARCHIVE_LIMITS, extractFiles, readArchive, type ArchiveFile } from "./release-archive.js";
import { detectInstallLayout } from "./self-update.js";

export interface CopilotRuntimePin {
  schemaVersion: 1;
  /** npm package name, e.g. @github/copilot-win32-x64. */
  name: string;
  version: string;
  /** https://registry.npmjs.org/... tarball, exactly as package-lock.json resolved it. */
  url: string;
  /** package-lock.json integrity: sha512-<base64>. */
  integrity: string;
}

/** Shipped beside this module's folder in release bundles (app/runner-v2/copilot-runtime.json). */
export const BUNDLED_COPILOT_PIN_PATH = fileURLToPath(new URL("../copilot-runtime.json", import.meta.url));
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const REQUIRED_ENTRIES = ["package/package.json", "package/index.js", "package/app.js", "package/sdk/index.js"];

export class CopilotRuntimeError extends Error {
  constructor(message: string) { super(`copilot_runtime_unavailable: ${message}`); this.name = "CopilotRuntimeError"; }
}

/** The platform package name the Copilot SDK looks for on this machine (glibc Linux; musl is not a release target). */
export function copilotPlatformPackage(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  return `@github/copilot-${platform}-${arch}`;
}

export function parseCopilotRuntimePin(value: unknown): CopilotRuntimePin {
  const pin = value as Partial<CopilotRuntimePin> | null;
  if (typeof pin !== "object" || pin === null || pin.schemaVersion !== 1 ||
      typeof pin.name !== "string" || !/^@github\/copilot-[a-z0-9]+-[a-z0-9]+$/.test(pin.name) ||
      typeof pin.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pin.version) ||
      typeof pin.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(pin.integrity) || typeof pin.url !== "string") {
    throw new CopilotRuntimeError("The bundled Copilot runtime pin is invalid; reinstall AI Board.");
  }
  let url: URL;
  try { url = new URL(pin.url); } catch { throw new CopilotRuntimeError("The bundled Copilot runtime pin has an invalid URL."); }
  if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org" || url.port || url.username || url.password) {
    throw new CopilotRuntimeError("The bundled Copilot runtime pin does not use the npm registry.");
  }
  return { schemaVersion: 1, name: pin.name, version: pin.version, url: url.href, integrity: pin.integrity };
}

/** The bundle's pin, or undefined outside a release bundle (a developer checkout resolves the installed package). */
export async function readBundledCopilotPin(path: string = BUNDLED_COPILOT_PIN_PATH): Promise<CopilotRuntimePin | undefined> {
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  return parseCopilotRuntimePin(JSON.parse(raw));
}

/** Installed: <install root>/runtimes/copilot (removed by `aiboard uninstall`); otherwise ~/.aiboard/runtimes/copilot. */
export function copilotRuntimeRoot(environment: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  if (environment.AIBOARD_COPILOT_RUNTIME_DIR) return environment.AIBOARD_COPILOT_RUNTIME_DIR;
  const layout = detectInstallLayout(import.meta.url);
  return layout ? join(layout.root, "runtimes", "copilot") : join(home, ".aiboard", "runtimes", "copilot");
}

function runtimeFolderName(pin: CopilotRuntimePin): string {
  const digest = Buffer.from(pin.integrity.slice("sha512-".length), "base64").toString("hex").slice(0, 16);
  return `${pin.name.slice("@github/".length)}-${pin.version}-${digest}`;
}

/** Checks the archive bytes against the pin and returns the package files, paths relative to the package root. */
export function verifyCopilotArchive(pin: CopilotRuntimePin, archive: Buffer): ArchiveFile[] {
  if (`sha512-${createHash("sha512").update(archive).digest("base64")}` !== pin.integrity) {
    throw new CopilotRuntimeError(`The downloaded ${pin.name}@${pin.version} does not match its pinned SHA-512 integrity; nothing was installed.`);
  }
  const entries = readArchive(archive, "tar.gz", { limits: BUNDLE_ARCHIVE_LIMITS });
  if (entries.some((entry) => !entry.path.startsWith("package/"))) throw new CopilotRuntimeError(`${pin.name} has an unexpected archive root.`);
  if (!REQUIRED_ENTRIES.every((path) => entries.some((entry) => entry.path === path))) {
    throw new CopilotRuntimeError(`${pin.name} is missing a Copilot SDK entry point.`);
  }
  const metadata = JSON.parse(entries.find((entry) => entry.path === "package/package.json")!.data.toString("utf8")) as { name?: string; version?: string };
  if (metadata.name !== pin.name || metadata.version !== pin.version) throw new CopilotRuntimeError(`${pin.name} metadata does not match its pin.`);
  return entries.map((entry) => ({ ...entry, path: entry.path.slice("package/".length) }));
}

async function download(url: string, fetchImpl: typeof fetch): Promise<Buffer> {
  let response: Response;
  try { response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) }); }
  catch (error) { throw new CopilotRuntimeError(`Could not download the Copilot runtime from ${new URL(url).origin} (${error instanceof Error ? error.message : String(error)}). Check your connection and try again.`); }
  if (!response.ok || !response.body) throw new CopilotRuntimeError(`Could not download the Copilot runtime (HTTP ${response.status}).`);
  if (Number(response.headers.get("content-length") ?? 0) > MAX_ARCHIVE_BYTES) throw new CopilotRuntimeError("The Copilot runtime archive is too large.");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ARCHIVE_BYTES) { await reader.cancel(); throw new CopilotRuntimeError("The Copilot runtime archive is too large."); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export interface EnsureCopilotRuntimeOptions {
  pin: CopilotRuntimePin;
  root: string;
  fetchImpl?: typeof fetch;
  /** Progress lines (download start / done). */
  log?: (message: string) => void;
  platform?: NodeJS.Platform;
  arch?: string;
}

/**
 * Returns the CLI entry point (<runtime>/index.js) the Copilot SDK should start, installing the pinned package
 * first if needed. A folder only appears under its final name once every file is written (atomic rename).
 */
export async function ensureCopilotRuntime(options: EnsureCopilotRuntimeOptions): Promise<string> {
  const { pin, root } = options;
  const expected = copilotPlatformPackage(options.platform, options.arch);
  if (pin.name !== expected) throw new CopilotRuntimeError(`This AI Board bundle pins ${pin.name}, but this machine needs ${expected}; install the bundle for this platform.`);
  const destination = join(root, runtimeFolderName(pin));
  const entry = join(destination, "index.js");
  if (existsSync(entry) && existsSync(join(destination, "package.json"))) return entry;
  options.log?.(`Downloading the GitHub Copilot runtime ${pin.name}@${pin.version} (first use only)...`);
  const files = verifyCopilotArchive(pin, await download(pin.url, options.fetchImpl ?? fetch));
  const staging = join(root, `.staging-${randomUUID()}`);
  try {
    await mkdir(root, { recursive: true });
    await extractFiles(files, staging);
    try { await rename(staging, destination); }
    catch (error) {
      // Another process finished the same pinned install first; its copy is identical.
      if (!existsSync(entry)) throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
  options.log?.(`GitHub Copilot runtime ${pin.version} is ready.`);
  return entry;
}
