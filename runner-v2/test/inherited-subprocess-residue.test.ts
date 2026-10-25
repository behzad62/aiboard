import assert from "node:assert/strict";
import test from "node:test";

import type { DurableProcessStore } from "../src/durable-process-store.js";
import { assertSubprocessCleanupSettled, inheritedSubprocessResidue } from "../src/inspection-cleanup.js";

type Row = { state: string; revision: number; pendingEffects: unknown[]; cleanup: { state: string }; backendBinding?: unknown };

function store(rows: Record<string, Row>): DurableProcessStore {
  return {
    listRowIds: () => Object.keys(rows),
    readByInvocation: (id: string) => rows[id],
  } as unknown as DurableProcessStore;
}

const cleaned = (): Row => ({ state: "cleaned", revision: 4, pendingEffects: [], cleanup: { state: "verified_empty" } });

test("a hard stop's unsettleable leftovers do not block a later binding's teardown", () => {
  // The tunnel run's shape: git launches orphaned before durable identity, and effects whose outcome died with the runner.
  const rows: Record<string, Row> = {
    done: cleaned(),
    orphan: { state: "orphaned", revision: 5, pendingEffects: [], cleanup: { state: "pending" } },
    unresolved: { state: "running", revision: 6, pendingEffects: [{ kind: "backend_observe" }], cleanup: { state: "pending" } },
  };
  const residue = inheritedSubprocessResidue(store(rows));
  assert.deepEqual([...residue.entries()].sort(), [["orphan", 5], ["unresolved", 6]]);
  assert.throws(() => assertSubprocessCleanupSettled(store(rows)), /orphan cleanup remains unverified/, "without the inherited set the strict rule holds");
  assertSubprocessCleanupSettled(store(rows), residue);
});

test("teardown still refuses this binding's own unsettled work and any inherited record that changed", () => {
  const rows: Record<string, Row> = {
    orphan: { state: "orphaned", revision: 5, pendingEffects: [], cleanup: { state: "pending" } },
    reattached: { state: "running", revision: 3, pendingEffects: [], cleanup: { state: "pending" }, backendBinding: {} },
  };
  const residue = inheritedSubprocessResidue(store(rows));
  assert.equal(residue.has("reattached"), false, "a live process reconciliation can act on is never residue");
  assert.throws(() => assertSubprocessCleanupSettled(store(rows), residue), /reattached cleanup remains unverified in running/);

  delete rows.reattached;
  rows.orphan = { ...rows.orphan!, state: "outcome_unknown", revision: 7 };
  assert.throws(() => assertSubprocessCleanupSettled(store(rows), residue), /orphan cleanup remains unverified in outcome_unknown/);
  rows.orphan = cleaned();
  assertSubprocessCleanupSettled(store(rows), residue);
});
