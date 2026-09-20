import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLinkedTestOutputSpillStorage } from "./support/linked-output-spill-storage.js";

for (const mode of ["exact", "wrong-identity"] as const)
test(`linked spill fixture matches its advertised linked-entry contract ${mode}`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p683-linked-spill-"));
  t.diagnostic(`exact linked test-storage root acquired: ${root}`);
  const storage = createLinkedTestOutputSpillStorage();
  const path = join(root, "owned-spill");
  const file = await storage.openExclusive(path);
  let passed = false;
  try {
    assert.equal((await storage.attest()).unlinkedEntries, false);
    const entry = await lstat(path);
    assert.equal(`${entry.dev.toString()}:${entry.ino.toString()}`, file.identity);
    await assert.rejects(storage.openExclusive(path), (error: NodeJS.ErrnoException) => error.code === "EEXIST");
    const bytes = Buffer.from("exact Ω bytes");
    assert.equal(await file.write(bytes), bytes.length);
    assert.deepEqual(await file.sealAndRead(bytes.length, bytes.length), bytes);
    await assert.rejects(file.sealAndRead(bytes.length, bytes.length - 1), /bound/);
    if (mode === "wrong-identity") {
      await assert.rejects(storage.removeIdentityStable(path, "foreign:identity"), /identity changed/);
      assert.deepEqual(await readFile(path), bytes);
    }
    await file.close();
    assert.equal((await lstat(path)).isFile(), true, "linked fixtures retain their named entry until exact cleanup");
    await storage.removeIdentityStable(path, file.identity);
    await assert.rejects(lstat(path), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    passed = true;
  } finally {
    await file.close();
    if (passed) { await rm(root, { recursive: true }); t.diagnostic(`exact linked test-storage root removed: ${root}`); }
    else t.diagnostic(`linked test-storage failure retained: ${root}`);
  }
});
