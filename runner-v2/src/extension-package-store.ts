import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";

import { EXTENSION_LIMITS, ExtensionManagementError } from "./extension-management-contracts.js";

/** One file of a bounded, link-free package snapshot. Paths are "/"-separated and contained. */
export interface PackageFile {
  readonly path: string;
  readonly bytes: Buffer;
  readonly executable: boolean;
}

export interface PackageTree {
  readonly files: readonly PackageFile[];
  readonly digest: string;
  readonly totalBytes: number;
}

export type PackageLimits = Pick<typeof EXTENSION_LIMITS, "maxPackageFiles" | "maxPackageBytes" | "maxFileBytes" | "maxPathDepth" | "maxPathLength">;

/**
 * Content-addressed store for managed extension packages. A committed package directory is named by
 * its tree digest and never modified afterwards; uninstall removes only these store-owned copies,
 * never the user-supplied source.
 */
export class ExtensionPackageStore {
  readonly root: string;

  constructor(home: string) {
    this.root = resolve(home);
  }

  packageDirectory(digest: string): string {
    assertDigest(digest);
    return join(this.root, "packages", digest);
  }

  /** Writes the tree to a staging directory then renames it into place; an existing copy is verified, not replaced. */
  async commit(tree: PackageTree): Promise<string> {
    const target = this.packageDirectory(tree.digest);
    if (await exists(target)) {
      const existing = await snapshotDirectory(target);
      if (existing.digest !== tree.digest) throw new ExtensionManagementError("package_store_corrupt", `Stored package ${tree.digest} does not match its digest.`, 500);
      return target;
    }
    const staging = join(this.root, "staging", `${tree.digest.slice(0, 16)}-${randomUUID()}`);
    try {
      for (const file of tree.files) {
        const path = join(staging, ...file.path.split("/"));
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, file.bytes, { mode: file.executable ? 0o555 : 0o444 });
      }
      await mkdir(join(this.root, "packages"), { recursive: true });
      try {
        await rename(staging, target);
      } catch (error) {
        // A concurrent commit of identical content wins; ours is discarded.
        if (!(await exists(target))) throw error;
      }
      return target;
    } finally {
      await removeTree(staging);
    }
  }

  async read(digest: string, path: string, maxBytes: number): Promise<Buffer> {
    const relative = normalizePackagePath(path);
    const absolute = join(this.packageDirectory(digest), ...relative.split("/"));
    const details = await lstat(absolute).catch(() => undefined);
    if (!details?.isFile()) throw new ExtensionManagementError("resource_not_found", `${relative} is not a file in this package.`, 404);
    if (details.size > maxBytes) throw new ExtensionManagementError("resource_too_large", `${relative} exceeds ${maxBytes} bytes.`, 413);
    return await readFile(absolute);
  }

  async list(digest: string): Promise<string[]> {
    const tree = await snapshotDirectory(this.packageDirectory(digest));
    return tree.files.map((file) => file.path);
  }

  /** Removes store copies not referenced by any retained version; never touches anything outside packages/. */
  async collect(retained: ReadonlySet<string>): Promise<string[]> {
    const directory = join(this.root, "packages");
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const removed: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name) || retained.has(entry.name)) continue;
      await removeTree(join(directory, entry.name));
      removed.push(entry.name);
    }
    return removed;
  }
}

/**
 * Bounded snapshot of a directory. Symbolic links and junctions are refused rather than followed,
 * so a package can never reference content outside itself.
 */
export async function snapshotDirectory(root: string, limits: PackageLimits = EXTENSION_LIMITS, skip: (path: string) => boolean = () => false): Promise<PackageTree> {
  const base = resolve(root);
  const top = await lstat(base).catch(() => undefined);
  if (!top) throw new ExtensionManagementError("source_not_found", "The source folder does not exist.", 404);
  if (top.isSymbolicLink()) throw new ExtensionManagementError("source_link_refused", "The source folder is a link; choose the real folder.");
  if (!top.isDirectory()) throw new ExtensionManagementError("source_not_directory", "The source is not a folder.");
  const files: PackageFile[] = [];
  let totalBytes = 0;
  const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > limits.maxPathDepth) throw new ExtensionManagementError("package_too_deep", `Package nesting exceeds ${limits.maxPathDepth} levels.`);
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (skip(path)) continue;
      const absolute = join(directory, entry.name);
      const details = await lstat(absolute);
      if (details.isSymbolicLink()) throw new ExtensionManagementError("package_link_refused", `${path} is a link; managed packages cannot contain links.`);
      if (details.isDirectory()) {
        await walk(absolute, path, depth + 1);
        continue;
      }
      if (!details.isFile()) throw new ExtensionManagementError("package_special_file", `${path} is not a regular file.`);
      normalizePackagePath(path, limits);
      if (files.length + 1 > limits.maxPackageFiles) throw new ExtensionManagementError("package_too_many_files", `Package exceeds ${limits.maxPackageFiles} files.`);
      if (details.size > limits.maxFileBytes) throw new ExtensionManagementError("package_file_too_large", `${path} exceeds ${limits.maxFileBytes} bytes.`);
      totalBytes += details.size;
      if (totalBytes > limits.maxPackageBytes) throw new ExtensionManagementError("package_too_large", `Package exceeds ${limits.maxPackageBytes} bytes.`);
      files.push({ path, bytes: await readFile(absolute), executable: process.platform !== "win32" && (details.mode & 0o111) !== 0 });
    }
  };
  await walk(base, "", 0);
  return buildTree(files, limits);
}

/** Validates paths, collisions and bounds, then computes the deterministic tree digest. */
export function buildTree(files: readonly PackageFile[], limits: PackageLimits = EXTENSION_LIMITS): PackageTree {
  if (files.length === 0) throw new ExtensionManagementError("package_empty", "The package has no files.");
  if (files.length > limits.maxPackageFiles) throw new ExtensionManagementError("package_too_many_files", `Package exceeds ${limits.maxPackageFiles} files.`);
  const seen = new Map<string, string>();
  let totalBytes = 0;
  const normalized = files.map((file) => {
    const path = normalizePackagePath(file.path, limits);
    // Case-insensitive collisions would silently overwrite each other on Windows/macOS.
    const folded = path.toLowerCase();
    const prior = seen.get(folded);
    if (prior !== undefined) throw new ExtensionManagementError("package_path_collision", `${path} collides with ${prior}.`);
    seen.set(folded, path);
    if (file.bytes.byteLength > limits.maxFileBytes) throw new ExtensionManagementError("package_file_too_large", `${path} exceeds ${limits.maxFileBytes} bytes.`);
    totalBytes += file.bytes.byteLength;
    return { path, bytes: file.bytes, executable: file.executable };
  });
  for (const path of seen.keys()) {
    // A file whose path is also used as a directory prefix cannot be materialized.
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join("/");
      if (seen.has(parent)) throw new ExtensionManagementError("package_path_collision", `${seen.get(parent)} is both a file and a folder.`);
    }
  }
  if (totalBytes > limits.maxPackageBytes) throw new ExtensionManagementError("package_too_large", `Package exceeds ${limits.maxPackageBytes} bytes.`);
  normalized.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const hash = createHash("sha256");
  for (const file of normalized) hash.update(`${file.path}\0${file.executable ? "x" : "-"}\0${sha256(file.bytes)}\n`);
  return { files: normalized, digest: hash.digest("hex"), totalBytes };
}

/** Selects a contained subtree, re-rooting paths. */
export function subtree(tree: PackageTree, directory: string, limits: PackageLimits = EXTENSION_LIMITS): PackageTree {
  if (directory === "" || directory === ".") return tree;
  const prefix = `${normalizePackagePath(directory, limits)}/`;
  const files = tree.files.filter((file) => file.path.startsWith(prefix)).map((file) => ({ ...file, path: file.path.slice(prefix.length) }));
  if (files.length === 0) throw new ExtensionManagementError("source_subdirectory_missing", `${directory} has no files in this source.`, 404);
  return buildTree(files, limits);
}

export function normalizePackagePath(path: string, limits: Pick<PackageLimits, "maxPathDepth" | "maxPathLength"> = EXTENSION_LIMITS): string {
  if (typeof path !== "string" || path.length === 0) throw new ExtensionManagementError("package_path_invalid", "Package paths must be non-empty.");
  const unified = path.replaceAll("\\", "/");
  if (unified.startsWith("/") || /^[A-Za-z]:/.test(unified) || unified.includes("\0")) throw new ExtensionManagementError("package_path_traversal", `${path} is not a relative package path.`);
  const parts = unified.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0) throw new ExtensionManagementError("package_path_invalid", `${path} is not a file path.`);
  for (const part of parts) {
    if (part === "..") throw new ExtensionManagementError("package_path_traversal", `${path} escapes the package.`);
    // Reserved device names and trailing dots/spaces are rewritten by Windows and can alias other files.
    if (/[<>:"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(part))
      throw new ExtensionManagementError("package_path_invalid", `${path} contains a name that is not portable.`);
  }
  const normalized = parts.join("/");
  if (parts.length > limits.maxPathDepth + 1) throw new ExtensionManagementError("package_too_deep", `${path} is nested too deeply.`);
  if (normalized.length > limits.maxPathLength) throw new ExtensionManagementError("package_path_invalid", `${path} is too long.`);
  return normalized;
}

/**
 * Minimal, bounded ZIP reader (stored and deflate entries). Refuses encryption, ZIP64, links,
 * traversal, duplicate names, and entries whose declared or actual expansion exceeds the limits.
 */
export function readZipArchive(archive: Buffer, limits: PackageLimits & Pick<typeof EXTENSION_LIMITS, "maxArchiveBytes" | "maxCompressionRatio"> = EXTENSION_LIMITS): PackageTree {
  if (archive.byteLength > limits.maxArchiveBytes) throw new ExtensionManagementError("archive_too_large", `Archive exceeds ${limits.maxArchiveBytes} bytes.`, 413);
  const end = findEndOfCentralDirectory(archive);
  const entries = archive.readUInt16LE(end + 10);
  const directorySize = archive.readUInt32LE(end + 12);
  const directoryOffset = archive.readUInt32LE(end + 16);
  if (entries === 0xffff || directoryOffset === 0xffffffff || directorySize === 0xffffffff) throw new ExtensionManagementError("archive_unsupported", "ZIP64 archives are not supported.");
  if (directoryOffset + directorySize > end) throw new ExtensionManagementError("archive_corrupt", "The archive directory is out of range.");
  if (entries > limits.maxPackageFiles * 2) throw new ExtensionManagementError("package_too_many_files", `Archive has more than ${limits.maxPackageFiles} files.`);
  const files: PackageFile[] = [];
  let offset = directoryOffset;
  let declared = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > archive.byteLength || archive.readUInt32LE(offset) !== 0x02014b50) throw new ExtensionManagementError("archive_corrupt", "Malformed archive directory.");
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const size = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const madeBy = archive.readUInt16LE(offset + 4) >> 8;
    const externalAttributes = archive.readUInt32LE(offset + 38);
    const localOffset = archive.readUInt32LE(offset + 42);
    const rawName = archive.subarray(offset + 46, offset + 46 + nameLength).toString((flags & 0x800) ? "utf8" : "latin1");
    offset += 46 + nameLength + extraLength + commentLength;
    if (flags & 0x1) throw new ExtensionManagementError("archive_unsupported", "Encrypted archives are not supported.");
    if (rawName.endsWith("/") || rawName.endsWith("\\")) continue;
    const unixMode = madeBy === 3 ? externalAttributes >>> 16 : 0;
    if ((unixMode & 0o170000) === 0o120000) throw new ExtensionManagementError("package_link_refused", `${rawName} is a link; managed packages cannot contain links.`);
    if (unixMode !== 0 && (unixMode & 0o170000) !== 0o100000 && (unixMode & 0o170000) !== 0) throw new ExtensionManagementError("package_special_file", `${rawName} is not a regular file.`);
    const path = normalizePackagePath(rawName, limits);
    if (size > limits.maxFileBytes) throw new ExtensionManagementError("package_file_too_large", `${path} exceeds ${limits.maxFileBytes} bytes.`);
    declared += size;
    if (declared > limits.maxPackageBytes) throw new ExtensionManagementError("package_too_large", `Archive expands beyond ${limits.maxPackageBytes} bytes.`);
    if (compressedSize > 0 && size / compressedSize > limits.maxCompressionRatio) throw new ExtensionManagementError("archive_bomb", `${path} has an implausible compression ratio.`);
    if (localOffset + 30 > archive.byteLength || archive.readUInt32LE(localOffset) !== 0x04034b50) throw new ExtensionManagementError("archive_corrupt", `Malformed entry ${path}.`);
    const dataStart = localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
    if (dataStart + compressedSize > archive.byteLength) throw new ExtensionManagementError("archive_corrupt", `Entry ${path} is truncated.`);
    const data = archive.subarray(dataStart, dataStart + compressedSize);
    let bytes: Buffer;
    if (method === 0) {
      if (compressedSize !== size) throw new ExtensionManagementError("archive_corrupt", `Stored entry ${path} has inconsistent sizes.`);
      bytes = Buffer.from(data);
    } else if (method === 8) {
      try {
        // maxOutputLength caps the real expansion independently of the (attacker-controlled) declared size.
        bytes = inflateRawSync(data, { maxOutputLength: Math.max(size, 1) });
      } catch {
        throw new ExtensionManagementError("archive_bomb", `${path} expands beyond its declared size or is corrupt.`);
      }
      if (bytes.byteLength !== size) throw new ExtensionManagementError("archive_corrupt", `${path} does not match its declared size.`);
    } else {
      throw new ExtensionManagementError("archive_unsupported", `${path} uses unsupported compression method ${method}.`);
    }
    files.push({ path, bytes, executable: (unixMode & 0o111) !== 0 });
  }
  return stripSingleTopDirectory(buildTree(files, limits), limits);
}

/** GitHub and most tools wrap archive contents in one top folder; skills are addressed below it. */
function stripSingleTopDirectory(tree: PackageTree, limits: PackageLimits): PackageTree {
  const tops = new Set(tree.files.map((file) => file.path.split("/")[0]));
  if (tops.size !== 1 || tree.files.some((file) => !file.path.includes("/"))) return tree;
  return subtree(tree, [...tops][0], limits);
}

function findEndOfCentralDirectory(archive: Buffer): number {
  const minimum = Math.max(0, archive.byteLength - 22 - 0xffff);
  for (let offset = archive.byteLength - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new ExtensionManagementError("archive_corrupt", "Not a ZIP archive.");
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertDigest(digest: string): void {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new ExtensionManagementError("invalid_digest", "Package digests are sha256 hex.");
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined)) !== undefined;
}

/** Store-owned trees are written read-only; restore write permission so removal works on every platform. */
async function removeTree(path: string): Promise<void> {
  const details = await lstat(path).catch(() => undefined);
  if (!details) return;
  if (details.isDirectory() && !details.isSymbolicLink()) {
    for (const entry of await readdir(path)) {
      const child = join(path, entry);
      const childDetails = await lstat(child);
      if (!childDetails.isDirectory() && !childDetails.isSymbolicLink()) await chmod(child, 0o644).catch(() => undefined);
      await removeTree(child);
    }
  } else if (!details.isSymbolicLink()) {
    await chmod(path, 0o644).catch(() => undefined);
  }
  await rm(path, { recursive: true, force: true });
}

export { removeTree as removeOwnedTree };
