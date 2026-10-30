import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type { ToolResult } from "../src/agent-contracts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost, type ExecutionHost, type ExecutionHostRunBinding } from "../src/execution-host.js";
import { createManagedProcessTools } from "../src/managed-process-tools.js";
import { readHistoricalManagedProcessObservations } from "../src/managed-process.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { SqlitePermissionStore } from "../src/permission-store.js";
import { DEFAULT_REMOTE_DEVICE_POLICY, RemotePrincipalStore } from "../src/remote-principal.js";
import { RemoteToolRuntime } from "../src/remote-tool-runtime.js";
import { roleAllowList } from "../src/role-capabilities.js";
import { createRunnerCapabilityContract } from "../src/runner-capability-contract.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import { SqliteToolLedger } from "../src/sqlite-tool-ledger.js";
import { ToolBroker } from "../src/tool-broker.js";
import { finalizeCertifiedFixture } from "./support/certified-fixture-cleanup.js";

const alice = { accountId: "account", clientId: "client-a", deviceId: "device" };
const bob = { ...alice, clientId: "client-b" };

test("durable principals, revocation and device policy stay locally controlled", async () => {
  const root = await mkdtemp(join(process.cwd(), "runner-v2", "test", ".remote-principal-"));
  const path = join(root, "principals.sqlite");
  try {
    let store = new RemotePrincipalStore(path);
    const first = store.getOrCreate(alice);
    const other = store.getOrCreate(bob);
    assert.notEqual(first.principalId, other.principalId);
    assert.notEqual(first.runId, other.runId);
    assert.notEqual(first.sessionId, other.sessionId);
    assert.deepEqual(store.policy(alice), DEFAULT_REMOTE_DEVICE_POLICY);
    const narrowed = store.updatePolicy(alice, { shell: false, approvals: true, readOnly: true, onlyHere: true }, "remote");
    assert.deepEqual(narrowed, { shell: false, approvals: true, readOnly: true, onlyHere: true, audit: true });
    assert.deepEqual(store.policy(bob), { shell: false, approvals: true, readOnly: true, onlyHere: true, audit: true });
    for (const patch of [{ shell: true }, { approvals: false }, { readOnly: false }, { onlyHere: false }, { audit: false }]) {
      assert.throws(() => store.updatePolicy(alice, patch, "remote"), /local user/);
      assert.deepEqual(store.policy(alice), narrowed);
    }
    store.updatePolicy(alice, { shell: true, approvals: false, readOnly: false, onlyHere: false }, "local");
    assert.throws(() => store.revoke(alice, "remote"), /local user/);
    store.close();
    store = new RemotePrincipalStore(path);
    assert.deepEqual(store.getOrCreate(alice), first);
    store.revoke(alice, "local");
    assert.equal(store.getOrCreate(alice).revoked, true);
    assert.equal(store.getOrCreate(alice).principalId, first.principalId);
    assert.equal(store.getOrCreate(bob).revoked, false);
    store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("remote capability surface excludes Build authority and hash-based artifact reads", () => {
  const names = roleAllowList("remote", "remote");
  for (const name of ["fs.read", "fs.write", "process.start", "process.poll", "process.signal", "git.status", "image.inspect"]) assert.ok(names.includes(name));
  for (const name of ["artifact.read", "git.commit", "complete_run", "plan_tasks", "request_integration", "submit_task", "extensions.apply_change"]) assert.ok(!names.includes(name));
});

test("existing worker records and new remote permission records remain readable", async () => {
  const root = await mkdtemp(join(process.cwd(), "runner-v2", "test", ".remote-codecs-"));
  try {
    const state = join(root, "managed");
    await mkdir(join(state, "process_old"), { recursive: true });
    const stdoutPath = join(state, "process_old", "stdout.log"), stderrPath = join(state, "process_old", "stderr.log");
    await writeFile(stdoutPath, "old output"); await writeFile(stderrPath, "");
    await writeFile(join(state, "process_old.json"), JSON.stringify({ processId: "process_old", pid: 123,
      runId: "old-run", sessionId: "old-session", actor: { role: "worker", id: "worker" }, command: "node", args: [], cwd: root,
      environmentKeys: [], startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:01.000Z",
      status: "stopped", exitCode: 0, signal: null, stdoutPath, stderrPath }));
    assert.equal(readHistoricalManagedProcessObservations(state, "old-run")[0]?.actor.role, "worker");
    const permissionsPath = join(root, "permissions.sqlite");
    let permissions = new SqlitePermissionStore(permissionsPath);
    for (const [id, role] of [["old", "worker"], ["new", "remote"]] as const) {
      const pending = permissions.request({ requestId: id, runId: "run", sessionId: id, callId: id,
        toolName: "process.start", actor: { role, id }, permissionProfile: "full", access: { capability: "process.start" },
        outsideWorkspace: false, occurredAt: "2026-01-01T00:00:00.000Z" });
      permissions.decide({ requestId: id, decision: "denied", idempotencyKey: id, occurredAt: "2026-01-01T00:00:01.000Z" });
      assert.equal(await pending, false);
    }
    permissions.close(); permissions = new SqlitePermissionStore(permissionsPath);
    assert.deepEqual(permissions.list().map((entry) => entry.actor.role), ["worker", "remote"]);
    permissions.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a principal cannot rebind while failed binding cleanup is unverified", async () => {
  const root = await mkdtemp(join(process.cwd(), "runner-v2", "test", ".remote-cleanup-"));
  const project = join(root, "project"), state = join(root, "state");
  await mkdir(project); await mkdir(state);
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts, ambientEnvironment: snapshotNativeBuildAmbientEnvironment() });
  let bindAttempts = 0, cleanupAttempts = 0, allowCleanup = false;
  const faultHost: ExecutionHost = { ...host, bindRun: async (input) => {
    bindAttempts += 1;
    const binding = await host.bindRun(input);
    if (bindAttempts !== 1) return binding;
    return { ...binding, recover: async () => { throw new Error("injected recovery failure"); }, close: async () => {
      cleanupAttempts += 1;
      await binding.close();
      if (!allowCleanup) throw new Error("injected unverified cleanup");
    } };
  } };
  const principals = new RemotePrincipalStore(join(state, "principals.sqlite"));
  const runtime = new RemoteToolRuntime({ host: faultHost, principals, workspacePath: project,
    permissionProfile: "full", capabilitiesConfig: emptyRunnerCapabilitiesConfig() });
  let failed = false, primary: unknown;
  try {
    await assert.rejects(runtime.invoke(alice, "fs.read", { path: "fixture.txt" }), /cleanup remains unverified/);
    assert.deepEqual(host.activeRunIds(), []);
    await assert.rejects(runtime.invoke(alice, "fs.read", { path: "fixture.txt" }), /cleanup remains unverified/);
    assert.equal(bindAttempts, 1);
    assert.equal(cleanupAttempts, 1);
    allowCleanup = true;
    await runtime.close();
    assert.equal(cleanupAttempts, 2);
  } catch (error) { failed = true; primary = error; }
  finally {
    allowCleanup = true;
    await finalizeCertifiedFixture({ fixtureName: "remote binding cleanup", root, hasPrimaryFailure: failed, primaryFailure: primary,
      cleanup: async () => { const errors: unknown[] = []; for (const close of [() => runtime.close(), () => host.close()]) {
        try { await close(); } catch (error) { errors.push(error); }
      } principals.close(); if (errors.length) throw new AggregateError(errors, "Remote binding cleanup failed."); },
      certify: async () => { assert.deepEqual(host.activeRunIds(), []); },
      removeRoot: async () => { await rm(root, { recursive: true }); } });
  }
});

test("real broker binds remote grants and preserves exact managed-process owners", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(process.cwd(), "runner-v2", "test", ".remote-binding-"));
  const project = join(root, "project"), state = join(root, "state");
  await mkdir(project); await mkdir(state); await writeFile(join(project, "fixture.txt"), "isolated remote fixture\n");
  const forgedRoot = join(root, "forged-root");
  await mkdir(forgedRoot); await writeFile(join(forgedRoot, "fixture.txt"), "forged root fixture\n");
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts, ambientEnvironment: snapshotNativeBuildAmbientEnvironment() });
  const bindings = new Map<string, ExecutionHostRunBinding>();
  const runtimeHost: ExecutionHost = { ...host, bindRun: async (input) => {
    const binding = await host.bindRun(input); bindings.set(input.runId, binding); return binding;
  } };
  const principals = new RemotePrincipalStore(join(state, "principals.sqlite"));
  const config = emptyRunnerCapabilitiesConfig();
  const noAdmission = new RemoteToolRuntime({ host, principals, workspacePath: project, permissionProfile: "full", capabilitiesConfig: config });
  let admissions = 0;
  let holdAdmission: (() => Promise<void>) | undefined;
  const runtime = new RemoteToolRuntime({ host: runtimeHost, principals, workspacePath: project, permissionProfile: "full", capabilitiesConfig: config,
    admitEffect: async (_request, dispatch) => { admissions += 1; if (holdAdmission) await holdAdmission(); return await dispatch(); } });
  let worker: ExecutionHostRunBinding | undefined;
  let failed = false, primary: unknown;
  try {
    assert.equal((await noAdmission.invoke(alice, "process.start", { command: process.execPath })).error?.code, "effect_admission_required");
    for (const role of ["worker", "architect", "runner_internal"]) {
      for (const authority of [{ actor: { role, id: "forged" } }, { role }]) {
        assert.equal((await runtime.invoke(alice, "fs.read", { path: "fixture.txt", ...authority })).error?.code, "invalid_arguments", role);
      }
    }
    for (const key of ["runId", "sessionId", "workspace", "workspacePath", "scope", "scopeRef", "grant", "executionGrant", "externalApproved", "permissionProfile", "callId", "toolName"]) {
      assert.equal((await runtime.invoke(alice, "fs.read", { path: "fixture.txt", [key]: "forged" })).error?.code, "invalid_arguments", key);
    }
    const catalog = JSON.parse(await readFile(join(process.cwd(), "docs", "remote", "r0", "runner-tool-catalog.json"), "utf8")) as {
      tools: { id: string; remote: { proposal: string } }[];
    };
    const deniedTools = catalog.tools.filter((tool) => tool.remote.proposal === "deny").map((tool) => tool.id);
    for (const name of ["complete_run", "plan_tasks", "submit_task", "submit_verifier_verdict"]) assert.ok(deniedTools.includes(name), name);
    for (const name of [...deniedTools, "browser.open", "unknown"]) {
      assert.equal((await runtime.invoke(alice, name, {})).error?.code, "tool_unavailable", name);
    }
    assert.equal((await runtime.invoke(alice, "git.commit", { message: "must not commit" })).error?.code, "tool_unavailable");
    const artifact = await artifacts.put(Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=", "base64",
    ), "image/png", "private fixture");
    assert.equal((await runtime.invoke(alice, "artifact.read", { hash: artifact.hash })).error?.code, "tool_unavailable");
    assert.equal((await runtime.invoke(alice, "image.inspect", { artifactHash: artifact.hash })).error?.code, "tool_unavailable");
    assert.deepEqual(host.activeRunIds(), []);
    assert.equal(admissions, 0);
    const rootRead = await runtime.invoke(alice, "fs.read", { path: "fixture.txt", root: forgedRoot });
    if (rootRead.isError) assert.equal(rootRead.error?.code, "invalid_arguments");
    else {
      assert.match(JSON.stringify(rootRead.content), /isolated remote fixture/);
      assert.doesNotMatch(JSON.stringify(rootRead.content), /forged root fixture/);
    }
    const read = await runtime.invoke(alice, "fs.read", { path: "fixture.txt" });
    assert.equal(read.isError, false, JSON.stringify(read));
    assert.match(JSON.stringify(read.content), /isolated remote fixture/);
    const owner = principals.find(alice)!;
    const started = json(await runtime.invoke(alice, "process.start", {
      command: process.execPath, args: ["-e", "process.stdout.write('ready\\n'); process.stdin.on('data', data => process.stdout.write(data)); setInterval(() => {}, 1000)"], interactive: true,
    }));
    const processId = started.processId as string;
    assert.equal(typeof processId, "string");
    // A new connector connection reconstructs its verified claims while the Runner-owned runtime stays alive.
    const reopened = new RemotePrincipalStore(join(state, "principals.sqlite"));
    const reconnected = reopened.getOrCreate({ ...alice });
    assert.deepEqual(reconnected, owner); reopened.close();
    assert.equal(json(await runtime.invoke(reconnected.identity, "process.poll", { processId })).processId, processId);
    const output = json(await runtime.invoke(reconnected.identity, "process.read_output", { processId, stream: "stdout", waitMs: 10_000 }));
    assert.match(JSON.stringify(output), /ready/);
    assert.equal(json(await runtime.invoke(reconnected.identity, "process.write_stdin", { processId, writeId: "own", data: "hello\n" })).status, "acknowledged");
    assert.equal((json(await runtime.invoke(reconnected.identity, "process.list", {})).processes as unknown[]).length, 1);
    const streaming = bindings.get(owner.runId)!.streamingState;
    const session = streaming.readSession(streaming.listSessionIds()[0]!)!;
    assert.deepEqual(session.actor, { role: "remote", id: owner.principalId });
    assert.equal(session.agentSessionId, owner.sessionId);
    const other = principals.getOrCreate(bob);
    assert.equal(other.identity.accountId, owner.identity.accountId);
    assert.equal(other.identity.deviceId, owner.identity.deviceId);
    assert.notEqual(other.principalId, owner.principalId);
    for (const [name, input] of [
      ["process.poll", { processId }], ["process.read_output", { processId }],
      ["process.write_stdin", { processId, writeId: "foreign", data: "bad" }],
      ["process.signal", { processId, signal: "SIGTERM" }],
    ] as const) assert.equal((await runtime.invoke(bob, name, input)).error?.code, "process_not_owned", name);

    worker = await host.bindRun({ runId: "build-worker-test", permissionProfile: "full",
      capabilityContract: await createRunnerCapabilityContract(config), capabilitiesConfig: config });
    const workerBroker = new ToolBroker({ permissionProfile: "full", workspacePath: project, executionGrants: worker.executionGrants, artifacts });
    for (const tool of createManagedProcessTools(worker.managedProcesses)) workerBroker.register(tool);
    const workerStart = json(await workerBroker.invoke({ type: "tool_call", callId: "worker-start", name: "process.start",
      arguments: { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], interactive: true } },
    { runId: worker.runId, sessionId: "worker-session", actor: { role: "worker", id: "worker" }, workspacePath: project }));
    const workerId = workerStart.processId as string;
    for (const [name, input] of [["process.poll", { processId: workerId }], ["process.read_output", { processId: workerId }],
      ["process.write_stdin", { processId: workerId, writeId: "foreign-worker", data: "bad" }],
      ["process.signal", { processId: workerId, signal: "SIGTERM" }]] as const) {
      assert.equal((await runtime.invoke(alice, name, input)).error?.code, "process_not_owned", name);
    }
    const runRoot = join(state, "builds");
    const remoteBinding = host.activeRunIds().find((id) => id === owner.runId);
    assert.equal(remoteBinding, owner.runId);
    // The successful managed launch requires the host's streaming session and broker grant.
    const { runnerRunStateSegment } = await import("../src/run-state-identity.js");
    const ledger = new SqliteToolLedger(join(runRoot, runnerRunStateSegment(owner.runId), "remote-tool-ledger.sqlite"), { readOnly: true });
    const starts = ledger.listRun(owner.runId).filter((event) => event.type === "tool.started");
    assert.ok(starts.some((event) => event.toolName === "process.start" && event.actor?.role === "remote" && event.actor.id === owner.principalId));
    assert.ok(starts.some((event) => event.toolName === "fs.read" && event.sessionId === owner.sessionId));
    if (!rootRead.isError) {
      assert.ok(starts.some((event) => event.callId === rootRead.callId && event.actor?.role === "remote" && event.actor.id === owner.principalId));
    }
    ledger.close();
    const ledgerPath = join(runRoot, runnerRunStateSegment(owner.runId), "remote-tool-ledger.sqlite");

    principals.updatePolicy(alice, { readOnly: true }, "remote");
    const beforeReadOnly = ledgerCount(ledgerPath, owner.runId), admissionsBeforeReadOnly = admissions;
    for (const [name, input] of [
      ["fs.write", { path: "fixture.txt", content: "changed" }],
      ["fs.patch", { path: "fixture.txt", search: "isolated", replace: "changed" }],
      ["fs.move", { source: "fixture.txt", destination: "moved.txt" }],
      ["fs.delete", { path: "fixture.txt" }],
      ["fs.search", { path: ".", pattern: "fixture", cursor: "invalid", cancel: true }],
      ["process.start", { command: process.execPath }],
      ["process.run", { command: process.execPath }],
      ["process.write_stdin", { processId, writeId: "read-only", data: "bad" }],
      ["process.signal", { processId, signal: "SIGTERM" }],
    ] as const) {
      assert.equal((await runtime.invoke(alice, name, input)).error?.code, "permission_denied", name);
    }
    assert.equal(ledgerCount(ledgerPath, owner.runId), beforeReadOnly);
    assert.equal(admissions, admissionsBeforeReadOnly);
    assert.equal(await readFile(join(project, "fixture.txt"), "utf8"), "isolated remote fixture\n");
    assert.equal((await runtime.invoke(alice, "fs.read", { path: "fixture.txt" })).isError, false);
    principals.updatePolicy(alice, { readOnly: false, shell: false }, "local");
    const shellCalls = [
      ["process.start", { command: process.execPath }],
      ["process.run", { command: process.execPath }],
      ["process.write_stdin", { processId, writeId: "shell-off", data: "bad" }],
    ] as const;
    const beforeShellOff = ledgerCount(ledgerPath, owner.runId), admissionsBeforeShellOff = admissions;
    for (const [name, input] of shellCalls) assert.equal((await runtime.invoke(alice, name, input)).error?.code, "permission_denied", name);
    assert.equal(ledgerCount(ledgerPath, owner.runId), beforeShellOff);
    assert.equal(admissions, admissionsBeforeShellOff);
    assert.equal(json(await runtime.invoke(alice, "process.poll", { processId })).processId, processId);
    principals.updatePolicy(alice, { shell: true, approvals: true }, "local");
    const beforeApproval = ledgerCount(ledgerPath, owner.runId), admissionsBeforeApproval = admissions;
    for (const [name, input] of shellCalls) {
      assert.equal((await runtime.invoke(alice, name, { ...input, externalApproved: true })).error?.code, "invalid_arguments", name);
      assert.equal((await runtime.invoke(alice, name, input)).error?.code, "approval_required", name);
    }
    assert.equal(ledgerCount(ledgerPath, owner.runId), beforeApproval);
    assert.equal(admissions, admissionsBeforeApproval);
    principals.updatePolicy(alice, { approvals: false, onlyHere: true }, "local");
    assert.equal((await runtime.invoke(alice, "fs.read", { path: "fixture.txt" })).isError, false);
    principals.updatePolicy(alice, { onlyHere: false }, "local");
    assert.equal(json(await runtime.invoke(reconnected.identity, "process.signal", { processId, signal: "SIGTERM" })).status, "stopped");
    let admissionEntered!: () => void, releaseAdmission!: () => void;
    const entered = new Promise<void>((resolve) => { admissionEntered = resolve; });
    const released = new Promise<void>((resolve) => { releaseAdmission = resolve; });
    holdAdmission = async () => { admissionEntered(); await released; };
    const beforeRevocation = ledgerCount(ledgerPath, owner.runId);
    const pendingWrite = runtime.invoke(alice, "fs.write", { path: "fixture.txt", content: "must not be written" });
    try { await entered; principals.revoke(alice, "local"); }
    finally { releaseAdmission(); }
    assert.equal((await pendingWrite).error?.code, "principal_revoked");
    assert.equal(await readFile(join(project, "fixture.txt"), "utf8"), "isolated remote fixture\n");
    const before = admissions;
    assert.equal((await runtime.invoke(alice, "fs.read", { path: "fixture.txt" })).error?.code, "principal_revoked");
    assert.equal((await runtime.invoke(alice, "process.start", { command: process.execPath })).error?.code, "principal_revoked");
    assert.equal(admissions, before);
    assert.equal(ledgerCount(ledgerPath, owner.runId), beforeRevocation);
  } catch (error) { failed = true; primary = error; }
  finally {
    await finalizeCertifiedFixture({ fixtureName: "remote binding", root, hasPrimaryFailure: failed, primaryFailure: primary,
      cleanup: async () => { const errors: unknown[] = []; for (const close of [() => noAdmission.close(), () => runtime.close(), () => worker?.close(), () => host.close()]) {
        try { await close(); } catch (error) { errors.push(error); }
      } principals.close(); if (errors.length) throw new AggregateError(errors, "Remote binding cleanup failed."); },
      certify: async () => { assert.deepEqual(host.activeRunIds(), []); },
      removeRoot: async () => { await rm(root, { recursive: true }); } });
  }
});

function json(result: ToolResult): Record<string, unknown> {
  assert.equal(result.isError, false, JSON.stringify(result));
  const block = result.content.find((item) => item.type === "json");
  assert.ok(block?.type === "json");
  return block.value as Record<string, unknown>;
}

function ledgerCount(path: string, runId: string): number {
  const ledger = new SqliteToolLedger(path, { readOnly: true });
  try { return ledger.listRun(runId).length; }
  finally { ledger.close(); }
}
