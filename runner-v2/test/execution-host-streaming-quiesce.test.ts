import assert from "node:assert/strict";
import test from "node:test";

import { quiesceExactBackend } from "../src/execution-host-streaming.js";
import type { ProcessBackend, ProcessBackendBinding, ProcessEffectFence } from "../src/process-backend.js";
import type { HostLaunchRecord } from "../src/streaming-session-store.js";

const fence: ProcessEffectFence = { ownerId: "host:managed-native", fencingToken: 1 };
const binding = { opaqueIdentity: "owned-unsettled", backendId: "runner-posix-process-group-v1" } as ProcessBackendBinding;
const record = { backendBinding: binding } as HostLaunchRecord;

test("host quiesce treats POSIX force exited as workload settlement while output remains unsettled", async () => {
  let verifyEmptyCalls = 0;
  let reconcileState: "outcome_unknown" | "exited" = "outcome_unknown";
  const backend = {
    async reconcile() { return { state: reconcileState }; },
    async signal(_binding: ProcessBackendBinding, action: string) {
      if (action === "force_terminate") reconcileState = "exited";
      return { state: action === "force_terminate" ? "exited" : "running" };
    },
    async verifyEmpty() {
      verifyEmptyCalls += 1;
      return { empty: false, detail: "Owned output evidence is unsettled or unavailable." };
    },
  } as unknown as ProcessBackend;
  const outcome = await quiesceExactBackend(
    record,
    fence,
    Date.now() + 1_000,
    async () => ({ backend }),
  );
  assert.equal(outcome, "verified");
  assert.equal(verifyEmptyCalls, 0, "workload quiescence must not wait on verifyEmpty/output settlement");
});

test("host quiesce requires reconcile exited after terminate; signal-only exited still escalates to force", async () => {
  let forceCalls = 0;
  let reconcileState: "running" | "outcome_unknown" | "exited" = "running";
  const backend = {
    async reconcile() { return { state: reconcileState }; },
    async signal(_binding: ProcessBackendBinding, action: string) {
      if (action === "terminate") {
        // OS group empty, but durable supervisor status may still be outcome_unknown.
        reconcileState = "outcome_unknown";
        return { state: "exited" };
      }
      forceCalls += 1;
      reconcileState = "exited";
      return { state: "exited" };
    },
    async verifyEmpty() {
      return { empty: false, detail: "Owned process lacks durable terminal proof." };
    },
  } as unknown as ProcessBackend;
  const outcome = await quiesceExactBackend(
    record,
    fence,
    Date.now() + 1_000,
    async () => ({ backend }),
  );
  assert.equal(outcome, "verified");
  assert.equal(forceCalls, 1, "terminate signal exited without reconcile exited must escalate to force");
});

test("host quiesce accepts terminate when reconcile already proves exited", async () => {
  let forceCalls = 0;
  const backend = {
    async reconcile() { return { state: "exited" }; },
    async signal(_binding: ProcessBackendBinding, action: string) {
      if (action === "force_terminate") forceCalls += 1;
      return { state: "exited" };
    },
    async verifyEmpty() {
      return { empty: false, detail: "Owned process lacks durable terminal proof." };
    },
  } as unknown as ProcessBackend;
  const outcome = await quiesceExactBackend(
    record,
    fence,
    Date.now() + 1_000,
    async () => ({ backend }),
  );
  assert.equal(outcome, "verified");
  assert.equal(forceCalls, 0, "reconcile exited before signaling needs no force escalation");
});
