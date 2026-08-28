import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { BoundedOutputSpool, type OutputSpillStorage } from "../src/bounded-output-spool.js";
import { createChildEnvironmentFactory } from "../src/child-environment.js";
import { createOpaqueOneCallExecutionGrant, type ExecutionInvocationIntent } from "../src/execution-safety-contracts.js";
import { InMemoryDurableProcessStore } from "../src/durable-process-store.js";
import { SubprocessRuntime, SubprocessRuntimeError } from "../src/subprocess-runtime.js";
import type { ProcessBackend, ProcessBackendBinding, ProcessObservation, ProcessReconciliation } from "../src/process-backend.js";

class FakeClock {
  private tick = 0;
  now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, this.tick++)).toISOString();
}

class FakeBackend implements ProcessBackend {
  readonly backendId = "fake";
  readonly calls: string[] = [];
  launchError?: Error;
  observation: ProcessObservation = { exitCode: 0, signal: undefined };
  launchIdentity = "opaque-1";
  launchBirth = "birth-1";
  verify = { empty: true, proofArtifactId: "empty-proof" } as const;
  reconcileResult: ProcessReconciliation = { state: "exited", exitCode: 0 };
  releaseError?: Error;
  disappearAt?: "observe" | "signal" | "verify" | "reconcile";
  probe = async () => ({ backendId: "fake", verified: true as const, platformLabel: "fixture", capabilities: { tree_termination: "enforced" as const, crash_cleanup: "enforced" as const, verified_emptiness: "enforced" as const, write_confinement: "enforced" as const } });
  launch = async () => { this.calls.push("launch"); if (this.launchError) throw this.launchError; return { backend: { backendId: "fake", opaqueIdentity: this.launchIdentity }, birthFingerprint: { observedAt: "2026-01-01T00:00:00.000Z", discriminator: this.launchBirth }, rootPid: 4242, startedAt: "2026-01-01T00:00:00.000Z" }; };
  observe = async (_binding: ProcessBackendBinding, sink: (stream: "stdout" | "stderr", bytes: Uint8Array) => Promise<void>) => { this.calls.push("observe"); if (this.disappearAt === "observe") throw new Error("backend gone"); await sink("stdout", Buffer.from("ok")); return this.observation; };
  signal = async (_binding: ProcessBackendBinding) => { this.calls.push("signal"); if (this.disappearAt === "signal") throw new Error("backend gone"); return { state: "exited" as const }; };
  verifyEmpty = async (_binding: ProcessBackendBinding) => { this.calls.push("verify"); if (this.disappearAt === "verify") throw new Error("backend gone"); return this.verify; };
  reconcile = async (_binding: ProcessBackendBinding) => { this.calls.push("reconcile"); if (this.disappearAt === "reconcile") throw new Error("backend gone"); return this.reconcileResult; };
  release = async () => { this.calls.push("release"); if (this.releaseError) throw this.releaseError; };
}

const intent: ExecutionInvocationIntent = { invocationId: "invoke-1", runId: "run-1", kind: "command", executable: "tool", arguments: ["--secret-value"], workingDirectory: "C:\\host\\project", requestedCapabilities: ["tree_termination", "verified_emptiness"] };
const grant = createOpaqueOneCallExecutionGrant({ grantId: "grant-1", invocationId: "invoke-1", issuedAt: "2026-01-01T00:00:00.000Z", access: [], state: "issued" });

async function fixture(t: test.TestContext, mutate?: (backend: FakeBackend) => void) {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-runtime-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const backend = new FakeBackend(); mutate?.(backend);
  const store = new InMemoryDurableProcessStore();
  const clock = new FakeClock();
  const environments = createChildEnvironmentFactory({ credentialResolver: { consume: () => { throw new Error("unused"); } }, now: () => new Date("2026-01-01T00:00:00.000Z") });
  const unavailableSpill: OutputSpillStorage = {
    attest: async () => ({ currentPrincipalPrivacy: false, identityStableDeletion: false, unlinkedEntries: false }),
    prepareRoot: async () => { throw new Error("must not prepare"); },
    openExclusive: async () => { throw new Error("must not open"); },
    remove: async () => undefined,
    removeIdentityStable: async () => undefined,
    list: async () => [],
  };
  const runtime = new SubprocessRuntime({ backends: [backend], store, clock, environments, createSpool: (id) => new BoundedOutputSpool({ spillRoot: join(root, id), projectRoot: process.cwd(), ownershipId: id, storage: unavailableSpill }) });
  return { backend, store, runtime };
}

test("durably orders intent and launch binding before reporting started", async (t) => {
  const { backend, store, runtime } = await fixture(t);
  const result = await runtime.invoke({ intent, grant, ambientEnvironment: { PATH: "safe", API_KEY: "secret-value" } });
  const record = store.readByInvocation("invoke-1")!;
  assert.deepEqual(record.history.slice(0, 3).map(({ state }) => state), ["prepared", "launching", "running"]);
  assert.ok(backend.calls.indexOf("launch") >= 0);
  assert.equal(result.outcome, "exited");
  assert.ok(record.output.some(({ lossyBytes }) => lossyBytes > 0));
  assert.deepEqual(record.history.slice(-3).map(({ state }) => state), ["exited", "verifying_empty", "cleaned"]);
  assert.deepEqual(backend.calls, ["launch", "observe", "verify", "release"]);
  assert.equal(JSON.stringify(record).includes("secret-value"), false);
  assert.equal(JSON.stringify(record).includes("C:\\host\\project"), false);
});

test("duplicate exact invocation is idempotent and never launches twice", async (t) => {
  const { backend, runtime } = await fixture(t);
  const first = await runtime.invoke({ intent, grant, ambientEnvironment: {} });
  const second = await runtime.invoke({ intent, grant, ambientEnvironment: {} });
  assert.deepEqual(second, first);
  assert.equal(backend.calls.filter((call) => call === "launch").length, 1);
});

test("start errors and launch crash points persist launch_not_proven", async (t) => {
  const { store, runtime } = await fixture(t, (backend) => { backend.launchError = new Error("start denied"); });
  await assert.rejects(runtime.invoke({ intent, grant, ambientEnvironment: {} }), (error: SubprocessRuntimeError) => error.code === "launch_not_proven");
  assert.equal(store.readByInvocation("invoke-1")?.state, "launch_not_proven");
});

test("timeout and cancellation outrank child exit while output loss never changes outcome", async (t) => {
  for (const stopReason of ["timed_out", "cancelled"] as const) {
    const { backend, runtime } = await fixture(t, (candidate) => { candidate.observation = { exitCode: 0, signal: undefined }; });
    const invocation = { ...intent, invocationId: `invoke-${stopReason}` };
    const matchingGrant = createOpaqueOneCallExecutionGrant({ grantId: `grant-${stopReason}`, invocationId: invocation.invocationId, issuedAt: "2026-01-01T00:00:00.000Z", access: [], state: "issued" });
    const result = await runtime.invoke({ intent: invocation, grant: matchingGrant, ambientEnvironment: {}, stopReason });
    assert.equal(result.outcome, stopReason);
    assert.equal(backend.calls.includes("signal"), true);
  }
});

test("missing identity and PID reuse never authorize signal", async (t) => {
  const { backend, store, runtime } = await fixture(t);
  store.createPrepared({ schemaVersion: 1, logicalProcessId: "p", invocationId: "lost", runId: "r", state: "prepared", history: [{ state: "prepared", at: "x" }], requiredCapabilities: [], environmentAudit: { inheritedNames: [], removedNames: [], explicitSafeNames: [], grantedNames: [] }, rootPid: 4242, output: [], cleanup: { state: "pending" } });
  store.transition("lost", "launching", "y");
  await assert.rejects(runtime.cancel("lost"), (error: SubprocessRuntimeError) => error.code === "identity_mismatch");
  assert.equal(backend.calls.includes("signal"), false);
  await runtime.invoke({ intent, grant, ambientEnvironment: {} });
  backend.launchBirth = "different-birth";
  await assert.rejects(runtime.cancel("invoke-1", { observedBirthDiscriminator: "different-birth" }), (error: SubprocessRuntimeError) => error.code === "identity_mismatch");
  assert.equal(backend.calls.filter((call) => call === "signal").length, 0);
});

test("backend disappearance and unknown observation persist typed recovery states", async (t) => {
  const { backend, store, runtime } = await fixture(t, (candidate) => { candidate.disappearAt = "observe"; });
  await assert.rejects(runtime.invoke({ intent, grant, ambientEnvironment: {} }), (error: SubprocessRuntimeError) => error.code === "backend_unavailable");
  assert.equal(store.readByInvocation("invoke-1")?.state, "backend_unavailable");
  backend.disappearAt = undefined;
  await runtime.reconcileStartup();
  assert.equal(store.readByInvocation("invoke-1")?.state, "cleaned");
});

test("bad launch identity fails closed before observation or signal", async (t) => {
  const { backend, store, runtime } = await fixture(t, (candidate) => { candidate.launchIdentity = ""; });
  await assert.rejects(runtime.invoke({ intent, grant, ambientEnvironment: {} }), (error: SubprocessRuntimeError) => error.code === "identity_mismatch");
  assert.equal(store.readByInvocation("invoke-1")?.state, "identity_mismatch");
  assert.deepEqual(backend.calls, ["launch"]);
});

test("verified-empty failure blocks cleanup and success cannot be persisted first", async (t) => {
  const { backend, store, runtime } = await fixture(t, (candidate) => { (candidate as { verify: unknown }).verify = { empty: false, detail: "descendant remains" }; });
  const result = await runtime.invoke({ intent, grant, ambientEnvironment: {} });
  assert.equal(result.outcome, "cleanup_failed");
  assert.equal(store.readByInvocation("invoke-1")?.state, "cleanup_blocked");
  assert.equal(store.readByInvocation("invoke-1")?.history.some(({ state }) => state === "cleaned"), false);
  assert.deepEqual(backend.calls, ["launch", "observe", "verify"]);
});

test("release failure remains a cleanup blocker and never records durable success", async (t) => {
  const { backend, store, runtime } = await fixture(t, (candidate) => { candidate.releaseError = new Error("release refused"); });
  const result = await runtime.invoke({ intent, grant, ambientEnvironment: {} });
  assert.equal(result.outcome, "cleanup_failed");
  assert.equal(store.readByInvocation("invoke-1")?.state, "cleanup_blocked");
  assert.equal(store.readByInvocation("invoke-1")?.history.some(({ state }) => state === "cleaned"), false);
  assert.deepEqual(backend.calls, ["launch", "observe", "verify", "release"]);
});

test("timeout and cancellation retain precedence over cleanup failure", async (t) => {
  for (const stopReason of ["timed_out", "cancelled"] as const) {
    const { runtime } = await fixture(t, (candidate) => { (candidate as { verify: unknown }).verify = { empty: false, detail: "still running" }; });
    const invocation = { ...intent, invocationId: `precedence-${stopReason}` };
    const matchingGrant = createOpaqueOneCallExecutionGrant({ grantId: `precedence-${stopReason}`, invocationId: invocation.invocationId, issuedAt: "2026-01-01T00:00:00.000Z", access: [], state: "issued" });
    assert.equal((await runtime.invoke({ intent: invocation, grant: matchingGrant, ambientEnvironment: {}, stopReason })).outcome, stopReason);
  }
});

test("restart reconciliation classifies each durable crash point and unknown outcome", async (t) => {
  const { backend, store, runtime } = await fixture(t, (candidate) => { candidate.reconcileResult = { state: "outcome_unknown" }; });
  const base = { schemaVersion: 1 as const, runId: "r", requiredCapabilities: [] as const, environmentAudit: { inheritedNames: [], removedNames: [], explicitSafeNames: [], grantedNames: [] }, output: [], cleanup: { state: "pending" as const } };
  store.createPrepared({ ...base, logicalProcessId: "before-launch", invocationId: "before-launch", state: "prepared", history: [{ state: "prepared", at: "a" }] });
  store.createPrepared({ ...base, logicalProcessId: "during-launch", invocationId: "during-launch", state: "prepared", history: [{ state: "prepared", at: "a" }] });
  store.transition("during-launch", "launching", "b");
  store.createPrepared({ ...base, logicalProcessId: "after-bind", invocationId: "after-bind", state: "prepared", history: [{ state: "prepared", at: "a" }] });
  store.transition("after-bind", "launching", "b");
  store.bindLaunch("after-bind", { backend: { backendId: "fake", opaqueIdentity: "opaque" }, birthFingerprint: { observedAt: "a", discriminator: "birth" } }, "c");
  await runtime.reconcileStartup();
  assert.equal(store.readByInvocation("before-launch")?.state, "launch_not_proven");
  assert.equal(store.readByInvocation("during-launch")?.state, "orphaned");
  assert.equal(store.readByInvocation("after-bind")?.state, "outcome_unknown");
  assert.equal(backend.calls.filter((call) => call === "launch").length, 0);
});

test("restart reconciliation is explicit, identity-bound, and historical reads do not reconcile", async (t) => {
  const { backend, store, runtime } = await fixture(t);
  store.createPrepared({ schemaVersion: 1, logicalProcessId: "p", invocationId: "resume", runId: "r", state: "prepared", history: [{ state: "prepared", at: "a" }], requiredCapabilities: ["verified_emptiness"], environmentAudit: { inheritedNames: [], removedNames: [], explicitSafeNames: [], grantedNames: [] }, output: [], cleanup: { state: "pending" } });
  store.transition("resume", "launching", "b");
  store.bindLaunch("resume", { backend: { backendId: "fake", opaqueIdentity: "opaque-r" }, birthFingerprint: { observedAt: "a", discriminator: "birth-r" }, rootPid: 7 }, "c");
  assert.equal(store.readByInvocation("resume")?.state, "running");
  assert.equal(backend.calls.length, 0);
  await runtime.reconcileStartup();
  assert.deepEqual(backend.calls, ["reconcile", "verify", "release"]);
  assert.equal(store.readByInvocation("resume")?.state, "cleaned");
});
