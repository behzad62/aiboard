import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { rebuildSchedulerProjection } from "../src/scheduler-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { seedEvent, v2PlanOnlySeed } from "./support/handoff-snapshot-harness.js";

const snapshotPayload = (stopSequence: number) => ({
  stopSequence,
  stopKind: "paused",
  revision: "revision_value",
  commit: "b".repeat(40),
  parent: "p".repeat(40),
  head: "b".repeat(40),
  bodyDigest: "d".repeat(64),
  paths: ["docs/project/STATE.md"],
  previousSnapshotEdited: false,
  agentsSectionCommitted: true,
  claudeLineCommitted: true,
});

// Tunnel run: an owner resume landed while the stop snapshot commit was in flight; the reducer
// refused the landed commit's record, and the unreceipted commit blocked every later checkout.
test("a stop snapshot that lands after an owner resume is still recorded for its stop", () => {
  const RUN = "run-snapshot-after-resume";
  const root = mkdtempSync(join(tmpdir(), "aiboard snapshot resume "));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    for (const input of v2PlanOnlySeed(RUN)) store.append(input);
    store.append(seedEvent(RUN, "run.paused", "pause:owner", "user", "local-user", { reason: "owner pause" }));
    const stop = store.readRun(RUN).at(-1)!;
    store.append(seedEvent(RUN, "run.resumed", "resume:owner", "user", "local-user", {}));
    assert.throws(
      () => store.append(seedEvent(RUN, "project_docs.handoff_snapshot_committed", "stop-snapshot:future", "runner", "build-runtime",
        snapshotPayload(stop.sequence + 100))),
      /Handoff snapshots require a requested project handoff\./,
      "a stop that has not happened is still refused",
    );
    store.append(seedEvent(RUN, "project_docs.handoff_snapshot_committed", `stop-snapshot:${stop.sequence}`, "runner", "build-runtime",
      snapshotPayload(stop.sequence)));
    const projection = rebuildSchedulerProjection(store.readRun(RUN));
    assert.equal(projection.status, "running");
    assert.deepEqual(projection.projectDocs?.snapshots?.map((record) => record.stopSequence), [stop.sequence]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
