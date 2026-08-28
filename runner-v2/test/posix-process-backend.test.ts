import assert from "node:assert/strict";
import test from "node:test";

import { createPosixProcessBackend } from "../src/posix-process-backend.js";
import {
  parseProcessEmptyVerification,
  parseProcessLaunchResult,
  parseProcessReconciliation,
  type ProcessLaunchResult,
} from "../src/process-backend.js";

test("POSIX backend attests session ownership without claiming host-crash cleanup", async () => {
  const backend = createPosixProcessBackend();
  const probe = await backend.probe() as {
    backendId: string;
    platformLabel: string;
    capabilities: Record<string, string>;
  };
  assert.equal(probe.backendId, "runner-posix-process-group-v1");
  assert.equal(probe.platformLabel, "posix");
  assert.equal(probe.capabilities.tree_termination, "enforced");
  assert.equal(probe.capabilities.verified_emptiness, "enforced");
  assert.equal(probe.capabilities.crash_cleanup, "unavailable");
});

test("POSIX native session fixture owns descendants after launcher exit", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX session/process-group behavior requires a POSIX host.");
    return;
  }
  const backend = createPosixProcessBackend({ pollIntervalMs: 20 });
  const launch = parseProcessLaunchResult(await backend.launch(request([
    "-e",
    "const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setTimeout(()=>process.exit(0),30)",
  ])));
  const binding = bindingFor(launch);
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(parseProcessReconciliation(await backend.reconcile(binding, fence)), { state: "running" });
    await backend.signal(binding, "terminate", fence);
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!parseProcessEmptyVerification(await backend.verifyEmpty(binding, fence)).empty)
      await backend.signal(binding, "force_terminate", fence);
    assert.equal(parseProcessEmptyVerification(await backend.verifyEmpty(binding, fence)).empty, true);
  } finally {
    await backend.signal(binding, "force_terminate", fence).catch(() => undefined);
    await backend.release(binding, fence).catch(() => undefined);
  }
});

const fence = { ownerId: "test-owner", fencingToken: 1 } as const;
function request(args: string[]) {
  return {
    intent: {
      invocationId: "posix-native",
      runId: "run",
      kind: "command" as const,
      executable: process.execPath,
      arguments: args,
      workingDirectory: process.cwd(),
      requestedCapabilities: ["tree_termination", "verified_emptiness"] as const,
    },
    grant: {
      grantId: "grant",
      runId: "run",
      invocationId: "posix-native",
      issuedAt: new Date().toISOString(),
      access: [],
    },
    environment: { ...process.env } as Record<string, string>,
    outputOwnerId: "output",
    fence,
  };
}
function bindingFor(launch: ProcessLaunchResult) {
  return {
    registryId: "registry",
    backendId: "runner-posix-process-group-v1",
    implementationGeneration: "generation",
    implementationDigest: "1".repeat(64),
    attestationVersion: 1,
    attestationDigest: "2".repeat(64),
    ...launch,
  };
}
