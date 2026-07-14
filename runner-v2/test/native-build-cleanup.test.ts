import assert from "node:assert/strict";
import test from "node:test";

import { cleanupSettledNativeBuild } from "../src/native-build-factory.js";

test("settled Build cleanup never touches durable state before process stop succeeds", async () => {
  const calls: string[] = [];
  await assert.rejects(
    cleanupSettledNativeBuild(
      async () => {
        calls.push("stop");
        throw new Error("ownership could not be proven");
      },
      [
        async () => { calls.push("sessions"); },
        async () => { calls.push("workspaces"); },
      ]
    ),
    /ownership could not be proven/
  );
  assert.deepEqual(calls, ["stop"]);
});

test("settled Build cleanup runs remaining operations only after process stop", async () => {
  const calls: string[] = [];
  await cleanupSettledNativeBuild(
    async () => { calls.push("stop"); },
    [
      async () => { calls.push("sessions"); },
      async () => { calls.push("workspaces"); },
    ]
  );
  assert.deepEqual(calls, ["stop", "sessions", "workspaces"]);
});
