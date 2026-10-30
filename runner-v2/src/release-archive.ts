// Release bundle archives: deterministic writers and fail-closed readers for zip (Windows) and tar.gz (macOS/Linux).
// Readers refuse traversal, absolute/drive paths, links, devices, duplicates (case-insensitive) and oversize content.
import { crc32, deflateRawSync, gunzipSync, gzipSync, inflateRawSync } from "node:zlib";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

export interface ArchiveFile {
  /** Forward-slash relative path. */
  path: string;
  data: Buffer;
  /** POSIX permission bits (0o644 or 0o755). */
  mode: number;
}

export interface ArchiveLimits {
  maxEntries: number;
  maxTotalBytes: number;
  maxEntryBytes: number;
}

export const BUNDLE_ARCHIVE_LIMITS: ArchiveLimits = { maxEntries: 40_000, maxTotalBytes: 1536 * 1024 * 1024, maxEntryBytes: 512 * 1024 * 1024 };

export class ArchiveError extends Error {
  constructor(message: string) { super(`release_archive_rejected: ${message}`); this.name = "ArchiveError"; }
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;

/** Returns the canonical relative path or throws; never resolves outside the extraction root. */
export function safeArchivePath(name: string): string {
  if (name.length === 0 || name.length > 400) throw new ArchiveError("entry path length is out of range");
  if (/[\u0000-\u001f\u007f\\:*?"<>|]/.test(name)) throw new ArchiveError(`entry path has forbidden characters: ${JSON.stringify(name.slice(0, 80))}`);
  if (name.startsWith("/")) throw new ArchiveError("entry path is absolute");
  const segments = name.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") throw new ArchiveError(`entry path has an unsafe segment: ${JSON.stringify(name.slice(0, 80))}`);
    if (WINDOWS_RESERVED.test(segment) || /[. ]$/.test(segment)) throw new ArchiveError(`entry path has a Windows-reserved segment: ${JSON.stringify(name.slice(0, 80))}`);
  }
  return segments.join("/");
}

function checkInventory(files: readonly ArchiveFile[], limits: ArchiveLimits): void {
  if (files.length > limits.maxEntries) throw new ArchiveError("too many entries");
  const seen = new Set<string>();
  let total = 0;
  for (const file of files) {
    const folded = file.path.toLowerCase();
    if (seen.has(folded)) throw new ArchiveError(`duplicate entry ${file.path}`);
    seen.add(folded);
    total += file.data.length;
    if (file.data.length > limits.maxEntryBytes || total > limits.maxTotalBytes) throw new ArchiveError("archive content exceeds the size limit");
  }
  // A file may not also be a directory prefix of another entry.
  for (const file of files) {
    const parts = file.path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      if (seen.has(parts.slice(0, index).join("/").toLowerCase())) throw new ArchiveError(`entry ${file.path} is nested under a file`);
    }
  }
}

function sortFiles(files: readonly ArchiveFile[]): ArchiveFile[] {
  return [...files].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

// ---------------------------------------------------------------- zip

const DOS_DATE_1980 = 0x0021; // 1980-01-01, time 00:00:00

export function writeZip(files: readonly ArchiveFile[]): Buffer {
  const sorted = sortFiles(files.map((file) => ({ ...file, path: safeArchivePath(file.path) })));
  checkInventory(sorted, BUNDLE_ARCHIVE_LIMITS);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of sorted) {
    const name = Buffer.from(file.path, "utf8");
    const compressed = deflateRawSync(file.data, { level: 9 });
    const useDeflate = compressed.length < file.data.length;
    const body = useDeflate ? compressed : file.data;
    const checksum = crc32(file.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE_1980, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // made by: UNIX, spec 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE_1980, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(((0o100000 | (file.mode & 0o777)) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
    if (offset > 0xfffffff0) throw new ArchiveError("zip64 is not supported");
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export interface ReadArchiveOptions {
  limits?: ArchiveLimits;
  /** Upstream archives (Node.js) contain symlinks we do not need: skip them instead of failing. */
  skipLinks?: boolean;
  /** Only materialize entries whose path passes this filter (others are size-checked but not kept). */
  include?: (path: string) => boolean;
}

export function readZip(archive: Buffer, options: ReadArchiveOptions = {}): ArchiveFile[] {
  const limits = options.limits ?? BUNDLE_ARCHIVE_LIMITS;
  const searchStart = Math.max(0, archive.length - 22 - 0xffff);
  let endOffset = -1;
  for (let index = archive.length - 22; index >= searchStart; index -= 1) {
    if (archive.readUInt32LE(index) === 0x06054b50) { endOffset = index; break; }
  }
  if (endOffset < 0) throw new ArchiveError("zip end record not found");
  const count = archive.readUInt16LE(endOffset + 10);
  const directorySize = archive.readUInt32LE(endOffset + 12);
  const directoryOffset = archive.readUInt32LE(endOffset + 16);
  if (count === 0xffff || directoryOffset === 0xffffffff || directoryOffset + directorySize > endOffset) throw new ArchiveError("zip64 or malformed central directory");
  if (count > limits.maxEntries) throw new ArchiveError("too many entries");
  const files: ArchiveFile[] = [];
  let cursor = directoryOffset;
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50) throw new ArchiveError("bad central directory entry");
    const madeBy = archive.readUInt16LE(cursor + 4) >> 8;
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const checksum = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const size = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const external = archive.readUInt32LE(cursor + 38);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const rawName = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    cursor += 46 + nameLength + extraLength + commentLength;
    if (flags & 0x0001) throw new ArchiveError("encrypted zip entries are not supported");
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new ArchiveError("zip64 entries are not supported");
    const unixMode = madeBy === 3 ? external >>> 16 : 0;
    const fileType = unixMode & 0o170000;
    if (fileType === 0o120000) {
      if (options.skipLinks) continue;
      throw new ArchiveError(`symbolic link entry ${rawName}`);
    }
    if (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000) throw new ArchiveError(`special file entry ${rawName}`);
    if (rawName.endsWith("/") || fileType === 0o040000 || (external & 0x10) !== 0) {
      safeArchivePath(rawName.replace(/\/+$/, ""));
      continue;
    }
    const name = safeArchivePath(rawName);
    total += size;
    if (size > limits.maxEntryBytes || total > limits.maxTotalBytes) throw new ArchiveError("archive content exceeds the size limit");
    if (options.include && !options.include(name)) continue;
    if (archive.readUInt32LE(localOffset) !== 0x04034b50) throw new ArchiveError("bad local header");
    const dataOffset = localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
    const body = archive.subarray(dataOffset, dataOffset + compressedSize);
    if (body.length !== compressedSize) throw new ArchiveError("truncated entry");
    let data: Buffer;
    if (method === 0) data = Buffer.from(body);
    else if (method === 8) data = inflateRawSync(body, { maxOutputLength: Math.max(size, 1) });
    else throw new ArchiveError(`unsupported compression method ${method}`);
    if (data.length !== size || (crc32(data) >>> 0) !== checksum) throw new ArchiveError(`entry ${name} failed its integrity check`);
    files.push({ path: name, data, mode: unixMode & 0o111 ? 0o755 : 0o644 });
  }
  checkInventory(files, limits);
  return files;
}

// ---------------------------------------------------------------- tar.gz (ustar + pax path records)

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, "0") + "\0";
}

function tarHeader(name: string, size: number, mode: number, type: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(octal(mode, 8), 100, 8, "ascii");
  header.write(octal(0, 8), 108, 8, "ascii");
  header.write(octal(0, 8), 116, 8, "ascii");
  header.write(octal(size, 12), 124, 12, "ascii");
  header.write(octal(0, 12), 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(octal(sum, 7) + " ", 148, 8, "ascii");
  return header;
}

function padded(data: Buffer): Buffer[] {
  const remainder = data.length % 512;
  return remainder === 0 ? [data] : [data, Buffer.alloc(512 - remainder)];
}

function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) length = String(length).length + Buffer.byteLength(body);
  return Buffer.from(`${length}${body}`, "utf8");
}

export function writeTarGz(files: readonly ArchiveFile[]): Buffer {
  const sorted = sortFiles(files.map((file) => ({ ...file, path: safeArchivePath(file.path) })));
  checkInventory(sorted, BUNDLE_ARCHIVE_LIMITS);
  const parts: Buffer[] = [];
  for (const file of sorted) {
    const mode = file.mode & 0o111 ? 0o755 : 0o644;
    if (Buffer.byteLength(file.path) > 99) {
      const record = paxRecord("path", file.path);
      parts.push(tarHeader("PaxHeaders/entry", record.length, 0o644, "x"), ...padded(record));
      parts.push(tarHeader(file.path.slice(0, 99).replace(/[^\x20-\x7e]/g, "_"), file.data.length, mode, "0"));
    } else {
      parts.push(tarHeader(file.path, file.data.length, mode, "0"));
    }
    parts.push(...padded(file.data));
  }
  parts.push(Buffer.alloc(1024));
  const gz = gzipSync(Buffer.concat(parts), { level: 9 });
  gz[9] = 0xff; // OS = unknown: identical bytes regardless of the build host.
  return gz;
}

export function readTarGz(archive: Buffer, options: ReadArchiveOptions = {}): ArchiveFile[] {
  const limits = options.limits ?? BUNDLE_ARCHIVE_LIMITS;
  let tar: Buffer;
  try { tar = gunzipSync(archive, { maxOutputLength: limits.maxTotalBytes + 64 * 1024 * 1024 }); }
  catch { throw new ArchiveError("gzip stream is invalid or too large"); }
  const files: ArchiveFile[] = [];
  let offset = 0;
  let pendingPath: string | undefined;
  let total = 0;
  let entries = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    if (++entries > limits.maxEntries * 2) throw new ArchiveError("too many entries");
    let sum = 0;
    for (let index = 0; index < 512; index += 1) sum += index >= 148 && index < 156 ? 0x20 : header[index]!;
    const recorded = parseInt(header.subarray(148, 156).toString("ascii").replace(/\0.*$/s, "").trim(), 8);
    if (recorded !== sum) throw new ArchiveError("tar header checksum mismatch");
    const field = (start: number, length: number) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156]!) || "0";
    if (!Number.isSafeInteger(size) || size < 0) throw new ArchiveError("tar entry size is invalid");
    // POSIX ustar only: old GNU headers ("ustar  ") keep atime/ctime where ustar keeps the prefix.
    const prefix = header.subarray(257, 263).toString("latin1") === "ustar\0" ? field(345, 155) : "";
    const headerName = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const bodyStart = offset + 512;
    const body = tar.subarray(bodyStart, bodyStart + size);
    if (body.length !== size) throw new ArchiveError("truncated tar entry");
    offset = bodyStart + Math.ceil(size / 512) * 512;
    if (type === "x") {
      if (size > 64 * 1024) throw new ArchiveError("pax header too large");
      pendingPath = parsePaxPath(body) ?? pendingPath;
      continue;
    }
    if (type === "L") {
      if (size > 4096) throw new ArchiveError("long name too large");
      pendingPath = body.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    if (type === "g") continue;
    const rawName = (pendingPath ?? headerName).replace(/^\.\//, "");
    pendingPath = undefined;
    if (type === "5") { if (rawName.replace(/\/+$/, "")) safeArchivePath(rawName.replace(/\/+$/, "")); continue; }
    if (type === "1" || type === "2") {
      if (options.skipLinks) continue;
      throw new ArchiveError(`link entry ${rawName}`);
    }
    if (type !== "0" && type !== "\0" && type !== "7") throw new ArchiveError(`special tar entry ${rawName}`);
    const name = safeArchivePath(rawName);
    total += size;
    if (size > limits.maxEntryBytes || total > limits.maxTotalBytes) throw new ArchiveError("archive content exceeds the size limit");
    if (options.include && !options.include(name)) continue;
    const mode = parseInt(field(100, 8).trim() || "644", 8);
    files.push({ path: name, data: Buffer.from(body), mode: mode & 0o111 ? 0o755 : 0o644 });
  }
  checkInventory(files, limits);
  return files;
}

function parsePaxPath(body: Buffer): string | undefined {
  let cursor = 0;
  let path: string | undefined;
  while (cursor < body.length) {
    const space = body.indexOf(0x20, cursor);
    if (space < 0) throw new ArchiveError("malformed pax record");
    const length = Number(body.subarray(cursor, space).toString("ascii"));
    if (!Number.isSafeInteger(length) || length <= 0 || cursor + length > body.length) throw new ArchiveError("malformed pax record");
    const record = body.subarray(space + 1, cursor + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0 && record.slice(0, equals) === "path") path = record.slice(equals + 1);
    if (equals > 0 && record.slice(0, equals) === "linkpath") throw new ArchiveError("pax link records are not supported");
    cursor += length;
  }
  return path;
}

export function readArchive(archive: Buffer, format: "zip" | "tar.gz", options: ReadArchiveOptions = {}): ArchiveFile[] {
  return format === "zip" ? readZip(archive, options) : readTarGz(archive, options);
}

/** Writes files into a directory that must not exist yet (fresh staging). */
export async function extractFiles(files: readonly ArchiveFile[], destination: string): Promise<void> {
  const root = resolve(destination);
  await mkdir(root, { recursive: false });
  for (const file of files) {
    const target = resolve(root, ...safeArchivePath(file.path).split("/"));
    const rel = relative(root, target);
    if (!rel || rel.startsWith("..") || rel.includes(`..${sep}`)) throw new ArchiveError(`entry ${file.path} escapes the extraction root`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.data, { flag: "wx", mode: file.mode });
    if (process.platform !== "win32") await chmod(target, file.mode);
  }
}

export function joinArchivePath(root: string, path: string): string {
  return join(root, ...safeArchivePath(path).split("/"));
}
