import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createExecutionGrantAuthority } from "../src/execution-grants.js";
import { createRuntimeBackedOneShotCommandExecutor } from "../src/one-shot-command-executor.js";
import { createChildEnvironmentFactory } from "../src/child-environment.js";

for (const mode of ["complete", "overflow", "incomplete-observation", "disabled", "invalid-bound"] as const) {
  test(`bounded command capture ${mode} never turns storage loss into partial protocol success`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "p6-command-capture-"));
    t.diagnostic(`exact synthetic capture fixture acquired: ${root}`);
    const authority = createExecutionGrantAuthority();
    const identity = { runId: "run-capture", sessionId: "capture-call", actor: { role: "worker" as const, id: "worker-capture" }, toolName: "git.read", callId: mode, permissionProfile: "full" as const };
    const grant = await authority.issue({ ...identity, workspacePath: root, access: [{ path: root, mode: "read" }], externalApproved: false, destructiveApproved: false, networkApproved: false });
    const expected = Buffer.from([255, 0, 128, 65, 66, 13, 10]);
    const counters = { invoked: 0, acquired: 0, released: 0 };
    const executor = createRuntimeBackedOneShotCommandExecutor({
      permissionProfile: "full", executionGrants: authority, ambientEnvironment: {},
      environments: createChildEnvironmentFactory({ credentialResolver: { consume: () => { throw new Error("no credential is granted"); } } }),
      runtimeGrants: { issue: () => undefined, revoke: () => true },
      isolation: {
        acquire: async () => { counters.acquired++; return { enforcement: "unconfined_explicit_full", disclosure: "unconfined_explicit_full" }; },
        prepareExecution: async (_selection, intent) => intent,
        release: async () => { counters.released++; }, activeLeases: () => [], recoverOwnedLeases: async () => [],
        enforcementState: async () => ({ version: 1, boundary: "provider_specific_not_universal_security_boundary", records: [] }),
      },
      runtime: {
        invoke: async (request) => {
          counters.invoked++;
          if (mode === "disabled") assert.equal(request.onOutput, undefined);
          else {
            const first = Buffer.from(expected.subarray(0, 3));
            request.onOutput?.("stdout", first); first.fill(0); // caller must own its bytes, not this backend buffer
            request.onOutput?.("stdout", expected.subarray(3)); request.onOutput?.("stderr", Buffer.from("err"));
          }
          return { logicalProcessId: "exact-capture", outcome: "exited", exitCode: 0, finishedAt: new Date().toISOString(),
            cleanup: { state: "verified_empty", verifiedAt: new Date().toISOString() },
            output: [{ stream: "stdout", tail: "loss marker is not protocol", totalBytes: expected.length + (mode === "incomplete-observation" ? 1 : 0), truncated: true, spillBytes: 0, lossyBytes: expected.length },
              { stream: "stderr", tail: "err", totalBytes: 3, truncated: false, spillBytes: 0, lossyBytes: 3 }] };
        }, cancel: async () => false, reconcileStartup: async () => [],
      recoverExceptional: async () => { throw new Error("Fake one-shot runtime never performs exceptional recovery."); },
      },
    });
    let passed = false;
    try {
      const request = { executable: "git", arguments: ["show"], workingDirectory: root, timeoutMs: 1000,
        context: { ...identity, executionGrant: grant }, ...(mode === "disabled" ? {} : { captureOutputBytes: mode === "invalid-bound" ? 0 : mode === "overflow" ? 5 : 32 }) };
      if (mode === "invalid-bound") {
        await assert.rejects(executor.execute(request), /capture.*bound|bound.*capture/i);
        assert.deepEqual(counters, { invoked: 0, acquired: 0, released: 0 });
        assert.equal(authority.activeSnapshots()[0]!.state, "issued");
      } else {
        const result = await executor.execute(request);
        assert.equal(result.process.output[0]!.lossyBytes, expected.length, "diagnostic storage loss must remain truthful");
        if (mode === "disabled") assert.equal(result.capturedOutput, undefined);
        else {
          assert.equal(result.capturedOutput?.complete, mode === "complete");
          assert.ok(result.capturedOutput);
          if (mode === "complete") { assert.deepEqual(Buffer.from(result.capturedOutput.stdout), expected); assert.equal(Buffer.from(result.capturedOutput.stderr).toString(), "err"); }
          if (mode === "overflow") assert.ok(result.capturedOutput.stdout.length + result.capturedOutput.stderr.length <= 5);
        }
        assert.deepEqual(counters, { invoked: 1, acquired: 1, released: 1 });
      }
      passed = true;
    } finally { await authority.revokeAll("cleanup"); if (passed) { await rm(root, { recursive: true }); t.diagnostic(`exact capture fixture removed: ${root}`); } }
  });
}
