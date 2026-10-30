import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";

import { extractFiles, readTarGz, readZip, writeTarGz, writeZip, type ArchiveFile } from "../src/release-archive.js";

const longPath = `app/node_modules/${"deep/".repeat(22)}file.js`;
const files: ArchiveFile[] = [
  { path: "node/node", data: Buffer.from("#!binary"), mode: 0o755 },
  { path: "app/runner-v2/src/a.js", data: Buffer.from("export const a = 1;\n".repeat(50)), mode: 0o644 },
  { path: longPath, data: Buffer.from("long"), mode: 0o644 },
  { path: "release.json", data: Buffer.from("{}"), mode: 0o644 },
];

function centralHeaderOffset(zip: Buffer, name: string): number {
  for (let index = 0; index < zip.length - 4; index += 1) {
    if (zip.readUInt32LE(index) === 0x02014b50 && zip.subarray(index + 46, index + 46 + name.length).toString() === name) return index;
  }
  throw new Error(`no central header for ${name}`);
}

function retitle(zip: Buffer, from: string, to: string): Buffer {
  assert.equal(from.length, to.length);
  const copy = Buffer.from(zip);
  let index = copy.indexOf(from);
  while (index >= 0) { copy.write(to, index); index = copy.indexOf(from, index + 1); }
  return copy;
}

/** Rewrites the first tar header of a tar.gz (name/type) and fixes its checksum. */
function patchTar(archive: Buffer, patch: (header: Buffer) => void): Buffer {
  const tar = gunzipSync(archive);
  const header = tar.subarray(0, 512);
  patch(header);
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return gzipSync(tar);
}

test("zip and tar.gz writers are deterministic and round-trip paths, bytes and modes", () => {
  for (const [write, read] of [[writeZip, readZip], [writeTarGz, readTarGz]] as const) {
    const first = write(files);
    assert.deepEqual(first, write([...files].reverse()));
    const back = read(first);
    assert.deepEqual(back.map((file) => file.path), [...files.map((file) => file.path)].sort());
    for (const file of files) {
      const match = back.find((entry) => entry.path === file.path)!;
      assert.deepEqual(match.data, file.data);
      assert.equal(match.mode, file.mode);
    }
  }
  assert.equal(writeTarGz(files)[9], 0xff, "gzip OS byte is fixed");
});

test("writers refuse unsafe or colliding paths", () => {
  for (const path of ["../x", "/abs", "a/../b", "a//b", "C:/x", "a\\b", "a/con", "a/trailing."]) {
    assert.throws(() => writeZip([{ path, data: Buffer.from("x"), mode: 0o644 }]), /release_archive_rejected/, path);
  }
  assert.throws(() => writeTarGz([{ path: "A.txt", data: Buffer.from("1"), mode: 0o644 }, { path: "a.txt", data: Buffer.from("2"), mode: 0o644 }]), /duplicate/);
  assert.throws(() => writeZip([{ path: "a", data: Buffer.from("1"), mode: 0o644 }, { path: "a/b", data: Buffer.from("2"), mode: 0o644 }]), /nested under a file/);
});

test("zip reader refuses traversal, symlinks, corruption and oversize content", () => {
  const zip = writeZip([{ path: "aa/evil", data: Buffer.from("payload"), mode: 0o644 }, { path: "ok.txt", data: Buffer.from("fine"), mode: 0o644 }]);
  assert.throws(() => readZip(retitle(zip, "aa/evil", "../evil")), /unsafe segment/);
  assert.throws(() => readZip(retitle(zip, "aa/evil", "C:/evil")), /forbidden characters/);
  const link = Buffer.from(zip);
  link.writeUInt32LE((0o120777 << 16) >>> 0, centralHeaderOffset(link, "aa/evil") + 38);
  assert.throws(() => readZip(link), /symbolic link/);
  assert.equal(readZip(link, { skipLinks: true }).length, 1);
  const corrupt = Buffer.from(zip);
  corrupt[corrupt.indexOf("fine")]! ^= 0xff;
  assert.throws(() => readZip(corrupt), /integrity check/);
  assert.throws(() => readZip(zip, { limits: { maxEntries: 10, maxTotalBytes: 8, maxEntryBytes: 100 } }), /size limit/);
  assert.throws(() => readZip(Buffer.from("not a zip at all, no end record")), /end record/);
});

test("tar reader refuses links, traversal, absolute paths, devices and bad checksums", () => {
  const archive = writeTarGz([{ path: "aa/evil", data: Buffer.from("payload"), mode: 0o644 }]);
  assert.throws(() => readTarGz(patchTar(archive, (header) => header.write("2", 156, "ascii"))), /link entry/);
  assert.equal(readTarGz(patchTar(archive, (header) => header.write("2", 156, "ascii")), { skipLinks: true }).length, 0);
  assert.throws(() => readTarGz(patchTar(archive, (header) => header.write("1", 156, "ascii"))), /link entry/);
  assert.throws(() => readTarGz(patchTar(archive, (header) => header.write("3", 156, "ascii"))), /special tar entry/);
  assert.throws(() => readTarGz(patchTar(archive, (header) => header.write("../evil", 0, "utf8"))), /unsafe segment/);
  assert.throws(() => readTarGz(patchTar(archive, (header) => header.write("/a/evil", 0, "utf8"))), /absolute/);
  const tar = gunzipSync(archive);
  tar[0]! ^= 0x01;
  assert.throws(() => readTarGz(gzipSync(tar)), /checksum/);
  assert.throws(() => readTarGz(Buffer.from("plain text")), /gzip/);
  assert.throws(() => readTarGz(archive, { limits: { maxEntries: 10, maxTotalBytes: 3, maxEntryBytes: 100 } }), /size limit/);
});

test("extraction writes into a fresh directory only and keeps executable bits", async () => {
  const root = await mkdtemp(join(tmpdir(), "aiboard-archive-"));
  try {
    const destination = join(root, "staging");
    await extractFiles(readTarGz(writeTarGz(files)), destination);
    assert.equal(await readFile(join(destination, ...longPath.split("/")), "utf8"), "long");
    if (process.platform !== "win32") assert.equal((await stat(join(destination, "node", "node"))).mode & 0o777, 0o755);
    await assert.rejects(extractFiles(files, destination), /EEXIST/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
