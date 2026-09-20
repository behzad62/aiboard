import assert from "node:assert/strict";
import fs from "node:fs";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { openSqliteDurableProcessKernel, type DurableProcessRuntimeWriter } from "../src/durable-process-store.js";
import { createProcessBackendRegistration, createProcessBackendRegistry, selectProcessBackend } from "../src/process-backend.js";
import { createSubprocessRuntimeKernel, exceptionalRecoveryCallId, durableBackendIdentityFingerprint, durableBirthFingerprint, type ExceptionalRecoveryRequest } from "../src/subprocess-runtime.js";
import { createChildEnvironmentFactory } from "../src/child-environment.js";
import { createExecutionGrantAuthority } from "../src/execution-grants.js";

async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>, options: { readonly legacyScope?: boolean } = {}) {
  const f = await setup(options); let passed = false;
  try { await run(f); passed = true; }
  finally { await f.authority.revokeAll("cleanup"); f.kernel.readOnlyStore.close();
    if (passed) fs.rmSync(f.root, { recursive: true, force: true }); else console.error(`Task11 kernel RED root retained: ${f.root}`); }
}
async function setup(options: { readonly legacyScope?: boolean } = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), "aiboard-task11-kernel-")), path = join(root, "state.sqlite"), key = new Uint8Array(32).fill(13);
  let now = new Date("2026-09-15T00:00:00.000Z"), running = true;
  const calls: string[] = []; let beforeProbe: (() => Promise<void>) | undefined; let beforeReconcile: (() => Promise<void>) | undefined;
  let empty = true;
  const capabilities = { tree_termination: "enforced", crash_cleanup: "enforced", verified_emptiness: "enforced", write_confinement: "unverified" } as const;
  const backend = {
    probe: async () => { calls.push("probe"); await beforeProbe?.(); return { attestationVersion: 2, backendId: "fixture", verified: true, platformLabel: "portable fixture", lifecycle: { scope: "process_group", termination: "enforced", emptiness: "enforced" }, capabilities }; },
    launch: async () => { throw new Error("Recovery must not launch"); }, observe: async () => ({ state: "exited", exitCode: 0 }),
    reconcile: async () => { calls.push("reconcile"); await beforeReconcile?.(); return running ? { state: "running" } : { state: "exited", exitCode: 7 }; },
    signal: async () => { calls.push("signal"); running = false; return { state: "exited" }; },
    verifyEmpty: async () => { calls.push("verify"); return empty ? { empty: true } : { empty: false, detail: "Still owned" }; },
    release: async () => { calls.push("release"); return { released: true }; },
  };
  const registry = createProcessBackendRegistry([createProcessBackendRegistration({ stableAdapterId: "fixture", backendId: "fixture", codeDigest: "a".repeat(64), configDigest: "b".repeat(64), backend })]);
  const selected = await selectProcessBackend(registry, [], "process_group");
  const store = openSqliteDurableProcessKernel(path, key);
  const writer = Object.getOwnPropertySymbols(store).map(symbol => Object.getOwnPropertyDescriptor(store, symbol)?.value)
    .find(value => value?.claim && value?.apply) as DurableProcessRuntimeWriter;
  assert.ok(writer);
  writer.claim({ schemaVersion: 2, revision: 0, logicalProcessId: "logical", invocationId: "invocation", runId: "run", taskId: "task", sessionId: "session",
    requestFingerprint: "c".repeat(64), retryKey: "c".repeat(64), ownerId: "prior-owner", leaseExpiresAt: new Date(now.getTime() + 10).toISOString(),
    outputOwnerId: "output-logical", outputPrepared: false, state: "prepared", history: [{ state: "prepared", at: now.toISOString() }],
    requiredLifecycleScope: "process_group", requiredCapabilities: [], environmentAudit: { inheritedNames: [], removedNames: [], explicitSafeNames: [], grantedNames: [] }, escalation: [], cleanup: { state: "pending" } });
  const apply = (command: Record<string, unknown>) => {
    const current = store.store.readByInvocation("invocation")!;
    return writer.apply({ ...command, invocationId: "invocation", expectedRevision: current.revision, ownerId: current.ownerId, fencingToken: current.fencingToken, at: now.toISOString() } as never);
  };
  apply({ type: "mark_output_prepared" });
  apply({ type: "record_environment", environmentAudit: { inheritedNames: [], removedNames: [], explicitSafeNames: [], grantedNames: [] } });
  apply({ type: "mark_launching" });
  apply({ type: "bind_launch", binding: { registryId: selected.registryId, backendId: "fixture", implementationGeneration: selected.implementationGeneration,
    implementationDigest: selected.implementationDigest, attestationVersion: selected.attestation.attestationVersion, attestationDigest: selected.attestationDigest,
    lifecycle: selected.attestation.lifecycle, opaqueIdentity: "opaque", birthFingerprint: { observedAt: now.toISOString(), discriminator: "birth" }, rootPid: 123, startedAt: now.toISOString() } });
  apply({ type: "fail", state: "outcome_unknown", detail: "Interrupted prior observation" });
  store.store.close();
  if (options.legacyScope) {
    const db = new DatabaseSync(path);
    try {
      const row = db.prepare("SELECT revision, record_json FROM durable_processes WHERE invocation_id = ?").get("invocation") as { revision: number; record_json: string };
      const legacy = JSON.parse(row.record_json) as Record<string, any>;
      delete legacy.requiredLifecycleScope;
      legacy.requiredCapabilities = ["tree_termination", "verified_emptiness"];
      const preparedMutation = legacy.mutations.find((mutation: any) => mutation.kind === "prepared");
      delete preparedMutation.data.requiredLifecycleScope;
      preparedMutation.data.requiredCapabilities = ["tree_termination", "verified_emptiness"];
      legacy.backendBinding.attestationVersion = 1;
      delete legacy.backendBinding.lifecycle;
      const bindMutation = legacy.mutations.find((mutation: any) => mutation.kind === "bind_launch");
      bindMutation.data.binding.attestationVersion = 1;
      delete bindMutation.data.binding.lifecycle;
      const json = JSON.stringify(legacy);
      const integrity = createHmac("sha256", key).update(`invocation\0${row.revision}\0${json}`).digest("hex");
      db.prepare("UPDATE durable_processes SET record_json = ?, integrity = ? WHERE invocation_id = ?").run(json, integrity, "invocation");
    } finally { db.close(); }
  }
  now = new Date(now.getTime() + 100);
  const output = { ownerId: "output-logical", write: async () => {}, cleanup: async () => { calls.push("output-cleanup"); },
    finalize: async () => { calls.push("output-finalize"); return { streams: ["stdout", "stderr"].map(stream => ({ stream, tail: "", tailBytesBase64: "", tailByteLength: 0, tailDisplayTruncated: false,
      totalBytes: 0, truncated: false, spillBytes: 0, lossyBytes: 0, lossyOutput: false, lossReasons: [], spillState: "empty" })) } as never; } };
  const kernel = createSubprocessRuntimeKernel({ registry, state: { kind: "sqlite", path }, stateKey: key,
    clock: { now: () => now, sleep: async ms => { now = new Date(now.getTime() + ms); } },
    environments: createChildEnvironmentFactory({ credentialResolver: { consume: () => { throw Error("No credentials"); } }, now: () => now }),
    outputs: { prepare: async () => output, reopen: async () => { calls.push("output-reopen"); return output; } } });
  const authority = createExecutionGrantAuthority({ clock: () => now });
  const request = async (action: "inspect" | "terminate" = "inspect") => {
    const record = kernel.readOnlyStore.readByInvocation("invocation")!, binding = record.backendBinding!;
    const scope = { invocationId: record.invocationId, runId: record.runId, logicalProcessId: record.logicalProcessId, taskId: record.taskId, sessionId: record.sessionId,
      expectedRevision: record.revision, ownerId: record.ownerId, fencingToken: record.fencingToken,
      backendIdentityFingerprint: durableBackendIdentityFingerprint(binding), birthFingerprint: durableBirthFingerprint(binding), action,
      expiresAt: new Date(now.getTime() + 60_000).toISOString() };
    const grantBinding = { runId: "run", sessionId: "session", actor: { role: "runner_internal" as const, id: "process-recovery" },
      toolName: "process.recovery", callId: exceptionalRecoveryCallId(scope), permissionProfile: "full" as const };
    const grant = await authority.issue({ ...grantBinding, workspacePath: root, access: [], externalApproved: false, destructiveApproved: action === "terminate", networkApproved: false });
    return { invocationId: record.invocationId, runId: record.runId, logicalProcessId: record.logicalProcessId, taskId: record.taskId, sessionId: record.sessionId,
      expectedRevision: record.revision, ownerId: record.ownerId, fencingToken: record.fencingToken,
      backendIdentityFingerprint: durableBackendIdentityFingerprint(binding), birthFingerprint: durableBirthFingerprint(binding), action, userApproved: action === "terminate",
      assertGrant: () => {}, authorization: { authority, grant, binding: grantBinding }, expiresAt: new Date(now.getTime() + 60_000).toISOString() };
  };
  calls.length = 0;
  return { root, kernel, calls, request, authority, backend, setEmpty: (value: boolean) => { empty = value; },
    setProbe: (value: () => Promise<void>) => { beforeProbe = value; }, setReconcile: (value: () => Promise<void>) => { beforeReconcile = value; } };
}

test("legacy scope-less recovery stays inspectable but cannot acquire destructive authority", () => fixture(async f => {
  const legacy = f.kernel.readOnlyStore.readByInvocation("invocation")!;
  assert.equal(legacy.requiredLifecycleScope, undefined);
  assert.equal(legacy.backendBinding?.attestationVersion, 1);
  const error = await f.kernel.runtime.recoverExceptional(await f.request("terminate")).then(() => undefined, (value: unknown) => value);
  assert.ok(error instanceof Error);
  assert.deepEqual(f.calls, [], "scope-ambiguous legacy ownership must not probe, reconcile, signal, verify, release, or relaunch");
  assert.equal(f.kernel.readOnlyStore.readByInvocation("invocation")?.state, "outcome_unknown");
}, { legacyScope: true }));

test("exceptional kernel requires an actual original-authority grant, not an approval boolean", () => fixture(async f => {
  const r = await f.request("terminate");
  await assert.rejects(() => f.kernel.runtime.recoverExceptional({ ...r, authorization: undefined } as unknown as ExceptionalRecoveryRequest));
  assert.deepEqual(f.calls, []);
}));
test("exceptional kernel snapshots inspect action before yielding", () => fixture(async f => {
  const r = await f.request(); f.setReconcile(async () => { r.action = "terminate"; });
  await f.kernel.runtime.recoverExceptional(r);
  assert.equal(f.calls.includes("signal"), false);
}));
test("exceptional kernel revocation while reattesting blocks later native effects", () => fixture(async f => {
  const r = await f.request("terminate"); f.setProbe(async () => { await f.authority.revoke(r.authorization.grant, "cancelled"); });
  await assert.rejects(() => f.kernel.runtime.recoverExceptional(r));
  assert.equal(f.calls.includes("reconcile"), false); assert.equal(f.calls.includes("signal"), false);
}));
test("exceptional kernel cleanup uses the ordinary output-finalize and backend-release path", () => fixture(async f => {
  const result = await f.kernel.runtime.recoverExceptional(await f.request("terminate"));
  assert.equal(result.cleanup.state, "verified_empty");
  assert.equal(f.calls.includes("output-finalize"), true); assert.equal(f.calls.includes("release"), true);
  assert.equal(f.kernel.readOnlyStore.readByInvocation("invocation")?.state, "cleaned");
  assert.deepEqual(f.kernel.readOnlyStore.readByInvocation("invocation")?.pendingEffects, []);
}));
test("exceptional kernel false emptiness is non-green and has no unconsumed verification effect", () => fixture(async f => {
  f.setEmpty(false);
  const result = await f.kernel.runtime.recoverExceptional(await f.request("terminate"));
  assert.notEqual(result.cleanup.state, "verified_empty"); assert.equal(f.calls.includes("release"), false);
  assert.deepEqual(f.kernel.readOnlyStore.readByInvocation("invocation")?.pendingEffects, []);
}));
test("exceptional kernel binds its grant to the original action and complete target", () => fixture(async f => {
  const r = await f.request("terminate");
  await assert.rejects(() => f.kernel.runtime.recoverExceptional({ ...r, action: "inspect" }));
  assert.deepEqual(f.calls, []);
}));
test("exceptional kernel refuses an expired native proposal before any probe", () => fixture(async f => {
  const r = await f.request();
  await assert.rejects(() => f.kernel.runtime.recoverExceptional({ ...r, expiresAt: "2020-01-01T00:00:00Z" }));
  assert.deepEqual(f.calls, []);
}));
test("exceptional kernel revocation after reconciliation prevents signal escalation", () => fixture(async f => {
  const r = await f.request("terminate");
  f.setReconcile(async () => { await f.authority.revoke(r.authorization.grant, "cancelled"); });
  await assert.rejects(() => f.kernel.runtime.recoverExceptional(r));
  assert.equal(f.calls.includes("signal"), false);
}));


test("durable backend recovery identity survives safe restart adoption generations", async () => {
  const { durableRecoveryIdentity } = await import("../src/durable-process-store.js");
  const stable = {
    backendId: "fixture", implementationDigest: "a".repeat(64), attestationVersion: 1,
    attestationDigest: "b".repeat(64), opaqueIdentity: "opaque",
    birthFingerprint: { observedAt: "2026-09-15T00:00:00.000Z", discriminator: "birth" },
    rootPid: 123, startedAt: "2026-09-15T00:00:00.000Z",
  };
  const before = { registryId: "registry-one", implementationGeneration: "generation-one", ...stable,
    capabilities: { tree_termination: "enforced", crash_cleanup: "enforced", verified_emptiness: "enforced", write_confinement: "unverified" } as const };
  const after = { registryId: "registry-two", implementationGeneration: "generation-two", ...stable,
    capabilities: { tree_termination: "enforced", crash_cleanup: "enforced", verified_emptiness: "enforced", write_confinement: "enforced" } as const };
  assert.equal(durableRecoveryIdentity(before), durableRecoveryIdentity(after));
});
