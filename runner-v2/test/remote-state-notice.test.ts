import assert from "node:assert/strict";
import test from "node:test";

import { createRemoteStateNotices } from "../src/remote-state-notice.js";

const run = (steps: ReadonlyArray<readonly [string, string]>) => {
  const notices = createRemoteStateNotices();
  return steps.map(([state, reason]) => notices(state, reason)).filter((line): line is string => line !== undefined);
};

test("a revoke while running prints one 'removed from your account' line and nothing after it", () => {
  const lines = run([["authenticating", "connecting"], ["connected-degraded", "reconciliation_pending"], ["tool-ready", "ready"],
    ["revoked", "device_key_revoked"], ["disconnected", "socket_lost"], ["revoked", "device_key_revoked"]]);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /removed from your AIBoard account, so remote access is off\. Press Ctrl\+C/u);
});

test("a dropped connection prints 'reconnecting' once, stays quiet through failed attempts, then prints 'reconnected'", () => {
  const lines = run([["tool-ready", "ready"],
    ["disconnected", "socket_lost"], ["authenticating", "reconnecting"], ["disconnected", "authentication_failed"],
    ["authenticating", "reconnecting"], ["disconnected", "socket_lost"], ["authenticating", "reconnecting"],
    ["connected-degraded", "reconciliation_pending"], ["tool-ready", "ready"]]);
  assert.deepEqual(lines, ["AIBoard Remote: lost the connection to the relay; reconnecting...\n", "AIBoard Remote: reconnected.\n"]);
});

test("a first connection that fails is final, because it is not retried", () => {
  const lines = run([["authenticating", "connecting"], ["disconnected", "authentication_failed"], ["authenticating", "connecting"]]);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /could not connect to the relay, so remote access is off/u);
});

test("running with an optional plugin tool missing counts as connected", () => {
  const lines = run([["connected-degraded", "optional_tool_unavailable"], ["disconnected", "socket_lost"], ["connected-degraded", "optional_tool_unavailable"]]);
  assert.deepEqual(lines, ["AIBoard Remote: lost the connection to the relay; reconnecting...\n", "AIBoard Remote: reconnected.\n"]);
});

test("suspension and unverified recovery say why remote access is off", () => {
  assert.match(run([["tool-ready", "ready"], ["suspended", "owner_lock_lost"]])[0]!, /another AIBoard Runner took over this device, so remote access is off/u);
  assert.match(run([["tool-ready", "ready"], ["suspended", "some_future_reason"]])[0]!, /stopped accepting remote calls/u);
  assert.match(run([["authenticating", "connecting"], ["connected-degraded", "recovery_unverified"]])[0]!, /could not be verified/u);
});

test("malformed IPC fields print nothing", () => {
  const notices = createRemoteStateNotices();
  for (const [state, reason] of [[undefined, "ready"], ["tool-ready", 7], ["exploded", "x"], [{}, "socket_lost"], ["revoked", null]] as const) {
    assert.equal(notices(state, reason), undefined);
  }
});
