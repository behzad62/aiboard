import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { ArtifactReachabilityGuard } from "../src/artifact-reachability.js";
import { SqliteAgentSessionStore } from "../src/sqlite-agent-session-store.js";

test("global artifact deletion is disabled outside quiescent startup", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-artifact-guard-live-"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  try {
    const artifact = await artifacts.put(Buffer.from("checkpoint"), "application/json");
    const guard = new ArtifactReachabilityGuard(root, artifacts);
    assert.equal(await guard.removeIfGloballyUnreachable(artifact.hash), false);
    await artifacts.verify(artifact.hash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quiescent global scan retains a shared artifact and deletes it after its final reference is gone", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-artifact-guard-shared-"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  try {
    const artifact = await artifacts.put(Buffer.from("checkpoint"), "application/json");
    const durable = join(root, "builds", "other-run", "evidence.json");
    mkdirSync(join(root, "builds", "other-run"), { recursive: true });
    writeFileSync(durable, JSON.stringify({ artifactHash: artifact.hash }));
    const guard = new ArtifactReachabilityGuard(root, artifacts);

    await guard.runQuiescent(async () => {
      await guard.prepareReachabilityIndex();
      assert.equal(await guard.removeIfGloballyUnreachable(artifact.hash), false);
      await artifacts.verify(artifact.hash);
      unlinkSync(durable);
      await guard.prepareReachabilityIndex();
      assert.equal(await guard.removeIfGloballyUnreachable(artifact.hash), true);
    });
    await assert.rejects(artifacts.verify(artifact.hash), /not found/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown durable state is retained conservatively and can be retried after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-artifact-guard-retry-"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  try {
    const artifact = await artifacts.put(Buffer.from("checkpoint"), "application/json");
    const unknown = join(root, "unknown-state");
    mkdirSync(unknown);
    writeFileSync(join(unknown, "legacy-record.bin"), Buffer.from(`legacy:${artifact.hash}`));
    const first = new ArtifactReachabilityGuard(root, artifacts);
    await first.runQuiescent(async () => {
      await first.prepareReachabilityIndex();
      assert.equal(await first.removeIfGloballyUnreachable(artifact.hash), false);
    });
    rmSync(unknown, { recursive: true, force: true });

    const restarted = new ArtifactReachabilityGuard(root, artifacts);
    await restarted.runQuiescent(async () => {
      await restarted.prepareReachabilityIndex();
      assert.equal(await restarted.removeIfGloballyUnreachable(artifact.hash), true);
    });
    await assert.rejects(artifacts.verify(artifact.hash), /not found/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one quiescent index serves a deletion batch and ignores cleanup self-references", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-artifact-guard-batch-"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const database = join(root, "builds", "run_1", "sessions.sqlite");
  mkdirSync(join(root, "builds", "run_1"), { recursive: true });
  const guard = new ArtifactReachabilityGuard(root, artifacts);
  const store = new SqliteAgentSessionStore(database, artifacts, {
    deleteArtifactIfGloballyUnreachable: (hash) =>
      guard.removeIfGloballyUnreachable(hash),
  });
  try {
    await store.create({
      sessionId: "worker:run_1:task:1",
      runId: "run_1",
      actor: { role: "worker", id: "worker_1" },
      occurredAt: "2026-07-14T00:00:00.000Z",
    });
    await store.checkpoint("worker:run_1:task:1", {
      messages: [{ id: "assistant_1", role: "assistant", content: [{ type: "text", text: "one" }] }],
      turns: 1,
      seenCallIds: [],
    }, "2026-07-14T00:00:01.000Z");
    const firstHash = store.events("worker:run_1:task:1")[1]!.artifactHash!;
    await store.checkpoint("worker:run_1:task:1", {
      messages: [{ id: "assistant_2", role: "assistant", content: [{ type: "text", text: "two" }] }],
      turns: 2,
      seenCallIds: [],
    }, "2026-07-14T00:00:02.000Z");

    await guard.runQuiescent(async () => {
      await store.compactRun("run_1");
      await artifacts.verify(firstHash);
      await guard.prepareReachabilityIndex();
      await store.compactRun("run_1");
      assert.equal(guard.scanCount, 1);
    });
    await assert.rejects(artifacts.verify(firstHash), /not found/i);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("nested references from a durable root artifact retain their target", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-artifact-guard-nested-"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  try {
    const target = await artifacts.put(Buffer.from("target"), "application/octet-stream");
    const rootArtifact = await artifacts.put(
      Buffer.from(JSON.stringify({ evidenceArtifactHashes: [target.hash] })),
      "application/json"
    );
    writeFileSync(join(root, "durable.json"), JSON.stringify({ changeSetArtifactHash: rootArtifact.hash }));
    const guard = new ArtifactReachabilityGuard(root, artifacts);
    await guard.runQuiescent(async () => {
      await guard.prepareReachabilityIndex();
      assert.equal(await guard.removeIfGloballyUnreachable(target.hash), false);
      assert.equal(guard.scanCount, 1);
    });
    await artifacts.verify(target.hash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a corrupt durable SQLite store reports the failed proof and deletes nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-artifact-guard-corrupt-"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  try {
    const artifact = await artifacts.put(Buffer.from("target"), "application/octet-stream");
    writeFileSync(
      join(root, "corrupt.sqlite"),
      Buffer.concat([Buffer.from("SQLite format 3\0", "binary"), Buffer.from("not-a-database")])
    );
    const guard = new ArtifactReachabilityGuard(root, artifacts);
    await guard.runQuiescent(async () => {
      await assert.rejects(guard.prepareReachabilityIndex(), /artifact reachability scan failed/i);
      assert.equal(await guard.removeIfGloballyUnreachable(artifact.hash), false);
    });
    await artifacts.verify(artifact.hash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an orphan SQLite companion file is scanned conservatively", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-artifact-guard-orphan-wal-"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  try {
    const artifact = await artifacts.put(Buffer.from("target"), "application/octet-stream");
    writeFileSync(join(root, "missing.sqlite-wal"), Buffer.from(`orphan:${artifact.hash}`));
    const guard = new ArtifactReachabilityGuard(root, artifacts);
    await guard.runQuiescent(async () => {
      await guard.prepareReachabilityIndex();
      assert.equal(await guard.removeIfGloballyUnreachable(artifact.hash), false);
    });
    await artifacts.verify(artifact.hash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
