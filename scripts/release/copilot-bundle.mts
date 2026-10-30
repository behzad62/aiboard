// Include the exact lockfile-pinned Copilot platform package for each release target.
// npm only installs the build host's optional platform package, so the archive is
// obtained independently of the host and verified before any bytes are used.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readArchive, type ArchiveFile } from "../../runner-v2/src/release-archive.js";
import type { ReleaseTarget } from "../../runner-v2/src/release-manifest.js";

interface LockEntry {
  version?: string;
  resolved?: string;
  integrity?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  os?: string[];
  cpu?: string[];
}
export interface CopilotLock { packages: Record<string, LockEntry> }

function pinnedPackage(lock: CopilotLock, target: ReleaseTarget) {
  const [platform, arch] = target.split("-");
  const os = platform === "win" ? "win32" : platform;
  const name = `@github/copilot-${os}-${arch}`;
  const sdk = "node_modules/@github/copilot-sdk";
  if (!lock.packages[sdk]?.dependencies?.["@github/copilot"] ||
      lock.packages[`${sdk}/node_modules/@github/copilot`] || lock.packages[`${sdk}/node_modules/${name}`]) {
    throw new Error("The Copilot SDK uses an unsupported nested dependency layout; review the lockfile before building.");
  }
  const entry = lock.packages[`node_modules/${name}`];
  const declared = lock.packages["node_modules/@github/copilot"]?.optionalDependencies?.[name];
  if (!entry || !declared || entry.version !== declared || !entry.os?.includes(os!) || !entry.cpu?.includes(arch!)) {
    throw new Error(`The lockfile has no matching Copilot platform package for ${target}.`);
  }
  if (!entry.resolved || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity ?? "")) {
    throw new Error(`The lockfile does not pin a SHA-512 package archive for ${name}.`);
  }
  const url = new URL(entry.resolved);
  if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org" || url.port || url.username || url.password) {
    throw new Error(`The Copilot package ${name} does not use the approved npm registry.`);
  }
  return { name, version: entry.version!, url: url.href, integrity: entry.integrity! };
}

/** Verify archive identity, package metadata, and the SDK's actual CLI entry points. */
export function copilotPackageFiles(lock: CopilotLock, target: ReleaseTarget, archive: Buffer): ArchiveFile[] {
  const pin = pinnedPackage(lock, target);
  if (`sha512-${createHash("sha512").update(archive).digest("base64")}` !== pin.integrity) {
    throw new Error(`The downloaded ${pin.name} archive does not match package-lock.json.`);
  }
  const entries = readArchive(archive, "tar.gz");
  if (entries.some((entry) => !entry.path.startsWith("package/"))) throw new Error(`${pin.name} has an unexpected archive root.`);
  const manifest = entries.find((entry) => entry.path === "package/package.json");
  if (!manifest || !["package/index.js", "package/app.js", "package/sdk/index.js"].every((path) => entries.some((entry) => entry.path === path))) {
    throw new Error(`${pin.name} is missing a required SDK entry point.`);
  }
  const packageJson = JSON.parse(manifest.data.toString("utf8")) as { name?: string; version?: string };
  if (packageJson.name !== pin.name || packageJson.version !== pin.version) throw new Error(`${pin.name} metadata does not match the lockfile.`);
  return entries.map((entry) => ({ ...entry, path: `app/node_modules/${pin.name}/${entry.path.slice("package/".length)}` }));
}

async function download(url: string): Promise<Buffer> {
  const limit = 512 * 1024 * 1024;
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`Could not download the pinned Copilot archive (HTTP ${response.status}).`);
  if (Number(response.headers.get("content-length") ?? 0) > limit) throw new Error("The Copilot archive is too large.");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new Error("The Copilot archive is too large."); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export async function pinnedCopilotFiles(lock: CopilotLock, target: ReleaseTarget, cache: string): Promise<ArchiveFile[]> {
  const pin = pinnedPackage(lock, target);
  const cacheFile = join(cache, `${Buffer.from(pin.integrity.slice("sha512-".length), "base64").toString("hex")}.tgz`);
  if (existsSync(cacheFile)) {
    if (statSync(cacheFile).size > 512 * 1024 * 1024) throw new Error(`The cached Copilot archive ${cacheFile} is too large.`);
    return copilotPackageFiles(lock, target, readFileSync(cacheFile));
  }
  process.stderr.write(`Downloading pinned ${pin.name}@${pin.version}\n`);
  const bytes = await download(pin.url);
  const files = copilotPackageFiles(lock, target, bytes);
  mkdirSync(cache, { recursive: true });
  const temporary = `${cacheFile}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bytes, { flag: "wx" });
    renameSync(temporary, cacheFile);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return files;
}
