import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BuildUserMediaStore, USER_VISUAL_RETENTION_MS } from "../src/build-user-media.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

test("media retention preserves runs with unknown entries and their artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-owner-"));
  try {
    const store = new BuildUserMediaStore(root);
    const refs = await store.save("run-1", "message-1", [{ filename: "a.pdf", mimeType: "application/pdf", base64Data: Buffer.from("%PDF-example").toString("base64") }]);
    await store.getOrCreateInitialEvidence("run-1", "request", async () => "evidence");
    const folder = join(root, "manifests", digest("run-1"));
    await writeFile(join(folder, "other-file"), "untouched");
    const now = Date.now() + USER_VISUAL_RETENTION_MS + 10_000;
    assert.deepEqual(await store.cleanupExpired(() => true, now), { expiredRuns: 0, orphanArtifacts: 0 });
    assert.equal(await readFile(join(folder, "other-file"), "utf8"), "untouched");
    await access(join(folder, digest("message-1") + ".json"));
    await access(join(root, "objects", refs[0]!.hash.slice(0, 2), refs[0]!.hash));
    await rm(join(folder, "other-file"));
    assert.equal((await store.cleanupExpired(() => true, now)).expiredRuns, 1);
    await assert.rejects(access(folder));
    await assert.rejects(access(join(root, "prepared", digest("run-1") + ".json")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("media retention preserves legacy prepared leaves without a run identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-owner-"));
  try {
    const store = new BuildUserMediaStore(root);
    await store.save("run-1", "message-1", [{ filename: "a.pdf", mimeType: "application/pdf", base64Data: Buffer.from("%PDF-example").toString("base64") }]);
    await store.getOrCreateInitialEvidence("run-1", "request", async () => "evidence");
    const prepared = join(root, "prepared", digest("run-1") + ".json");
    const legacy = JSON.stringify({ fingerprint: "request", evidence: "legacy" });
    await writeFile(prepared, legacy);
    await store.cleanupExpired(() => true, Date.now() + USER_VISUAL_RETENTION_MS + 10_000);
    assert.equal(await readFile(prepared, "utf8"), legacy);
  } finally { await rm(root, { recursive: true, force: true }); }
});
