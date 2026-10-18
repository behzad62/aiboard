import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, utimes, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BuildUserMediaStore, USER_VISUAL_RETENTION_MS } from "../runner-v2/src/build-user-media";

const root = await mkdtemp(join(tmpdir(), "aiboard-media-retention-"));
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
const input = { filename: "shared.png", mimeType: "image/png", base64Data: png.toString("base64") };
const store = new BuildUserMediaStore(root);
const now = Date.now();
const expired = new Date(now - USER_VISUAL_RETENTION_MS - 48 * 60 * 60 * 1000);
function manifest(run: string, message: string): string {
  return join(root, "manifests", digest(run), digest(message) + ".json");
}
try {
  const oldRefs = await store.save("old-run", "old-message", [input]);
  const currentRefs = await store.save("current-run", "current-message", [input]);
  assert.equal(oldRefs[0]!.hash, currentRefs[0]!.hash, "Artifact is deduplicated");
  const object = join(root, "objects", oldRefs[0]!.hash.slice(0, 2), oldRefs[0]!.hash);
  await utimes(manifest("old-run", "old-message"), expired, expired);
  await utimes(object, expired, expired);

  let interpretations = 0;
  assert.equal(await store.getOrCreateInitialEvidence("old-run", "first-request", async () => {
    interpretations++;
    return "The screenshot shows an error.";
  }), "The screenshot shows an error.");
  assert.equal(await store.getOrCreateInitialEvidence("old-run", "first-request", async () => {
    interpretations++;
    return "Different generated wording";
  }), "The screenshot shows an error.");
  assert.equal(interpretations, 1, "Retry does not invoke model again");
  await assert.rejects(store.getOrCreateInitialEvidence("old-run", "different-request", async () => "new"), /conflicts/);
  const prepCache = join(root, "prepared", digest("old-run") + ".json");
  assert.match(await readFile(prepCache, "utf8"), /screenshot shows an error/);

  let removed = await store.cleanupExpired((runId) => runId === "old-run", now);
  assert.equal(removed.expiredRuns, 1);
  assert.equal(removed.orphanArtifacts, 0, "Shared object referenced by current run must remain");
  await assert.rejects(store.load("old-run", "old-message", oldRefs));
  assert.deepEqual(await store.load("current-run", "current-message", currentRefs), [input]);
  await assert.rejects(stat(prepCache), /ENOENT/);

  await utimes(manifest("current-run", "current-message"), expired, expired);
  removed = await store.cleanupExpired(() => false, now);
  assert.equal(removed.expiredRuns, 0, "An active run survives even when its media is old");
  assert.equal(removed.orphanArtifacts, 0);
  removed = await store.cleanupExpired((runId) => runId === "current-run", now);
  assert.equal(removed.expiredRuns, 1);
  assert.equal(removed.orphanArtifacts, 1, "Unreferenced content-addressed payload must be removed");
  await assert.rejects(stat(object), /ENOENT/);
  removed = await store.cleanupExpired(() => true, now);
  assert.deepEqual(removed, { expiredRuns: 0, orphanArtifacts: 0 }, "Cleanup is idempotent");
  console.log("PASS retention: retry cache, conflicts, 30-day terminal policy, active-run safety, shared artifacts, orphan GC");
} finally {
  await rm(root, { recursive: true, force: true });
}
