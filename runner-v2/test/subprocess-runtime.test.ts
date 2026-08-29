import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { inspect } from "node:util";

import { createChildEnvironmentFactory } from "../src/child-environment.js";
import type { ExecutionInvocationIntent } from "../src/execution-safety-contracts.js";
import {
  createProcessBackendRegistration,
  createProcessBackendRegistry,
  type ProcessBackend,
  type ProcessBackendBinding,
  type ProcessLaunchRequest,
} from "../src/process-backend.js";
import {
  createSubprocessRuntimeKernel,
  SubprocessRuntimeError,
  type ProcessOutputFactory,
  type SubprocessRuntimeClock,
} from "../src/subprocess-runtime.js";

const capabilities = {
  tree_termination: "enforced",
  crash_cleanup: "enforced",
  verified_emptiness: "enforced",
  write_confinement: "enforced",
} as const;
const intent = (
  id = "invoke-1",
  command = "tool",
): ExecutionInvocationIntent => ({
  invocationId: id,
  runId: "run-1",
  kind: "command",
  executable: command,
  arguments: ["--secret-value"],
  workingDirectory: "C:\\host\\project",
  requestedCapabilities: ["tree_termination", "verified_emptiness"],
});

const grantValue = (
  invocationId = "invoke-1",
  overrides: Record<string, unknown> = {},
) => ({
  grantId: `grant-${invocationId}`,
  runId: "run-1",
  invocationId,
  issuedAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-01T01:00:00.000Z",
  access: [],
  ...overrides,
});

class Clock implements SubprocessRuntimeClock {
  current = new Date("2026-01-01T00:00:00.000Z");
  readonly sleeps: number[] = [];
  now = () => new Date(this.current);
  sleep = async (ms: number) => {
    this.sleeps.push(ms);
    this.current = new Date(this.current.getTime() + ms);
  };
}

class Outputs implements ProcessOutputFactory {
  readonly calls: string[] = [];
  readonly chunks: string[] = [];
  failFinalizeFor = new Set<string>();
  failReopenFor = new Set<string>();
  prepareGate?: Promise<void>;
  finalizeGate?: Promise<void>;
  failPrepare = false;
  failCleanupFor = new Set<string>();
  readonly fences: unknown[] = [];
  async prepare(ownerId: string, fence?: unknown) {
    this.calls.push(`prepare:${ownerId}`);
    this.fences.push(fence);
    await this.prepareGate;
    if (this.failPrepare) throw new Error("prepare failed");
    return this.session(ownerId);
  }
  async reopen(ownerId: string, fence?: unknown) {
    this.calls.push(`reopen:${ownerId}`);
    this.fences.push(fence);
    if (this.failReopenFor.has(ownerId)) throw new Error("reopen failed");
    return this.session(ownerId);
  }
  private session(ownerId: string) {
    return {
      ownerId,
      write: async (
        _stream: "stdout" | "stderr",
        bytes: Uint8Array,
        fence?: unknown,
      ) => {
        this.fences.push(fence);
        this.chunks.push(Buffer.from(bytes).toString());
      },
      finalize: async (fence?: unknown) => {
        this.calls.push(`finalize:${ownerId}`);
        this.fences.push(fence);
        await this.finalizeGate;
        if (this.failFinalizeFor.has(ownerId))
          throw new Error("finalize failed");
        return {
          streams: [
            {
              stream: "stdout" as const,
              tail: this.chunks.join(""),
              tailBytesBase64: Buffer.from(this.chunks.join("")).toString(
                "base64",
              ),
              tailByteLength: Buffer.byteLength(this.chunks.join("")),
              tailDisplayTruncated: false,
              totalBytes: Buffer.byteLength(this.chunks.join("")),
              truncated: false,
              spillBytes: 0,
              lossyBytes: 0,
              lossyOutput: false,
              lossReasons: [],
              spillState: "empty" as const,
            },
            {
              stream: "stderr" as const,
              tail: "",
              tailBytesBase64: "",
              tailByteLength: 0,
              tailDisplayTruncated: false,
              totalBytes: 0,
              truncated: false,
              spillBytes: 0,
              lossyBytes: 0,
              lossyOutput: false,
              lossReasons: [],
              spillState: "empty" as const,
            },
          ],
        };
      },
      cleanup: async (fence?: unknown) => {
        this.calls.push(`cleanup:${ownerId}`);
        this.fences.push(fence);
        if (this.failCleanupFor.has(ownerId)) throw new Error("cleanup failed");
      },
    };
  }
}

class Backend implements ProcessBackend {
  readonly calls: string[] = [];
  readonly fences: unknown[] = [];
  probeValue: unknown = {
    attestationVersion: 1,
    backendId: "fake",
    verified: true,
    platformLabel: "fixture",
    capabilities,
  };
  launchValue: unknown = {
    opaqueIdentity: "opaque-1",
    birthFingerprint: {
      observedAt: "2026-01-01T00:00:00.000Z",
      discriminator: "birth-1",
    },
    rootPid: 42,
    startedAt: "2026-01-01T00:00:00.000Z",
  };
  observeValue: unknown = { state: "exited", exitCode: 0 };
  verifyValue: unknown = { empty: true, proofArtifactId: "proof" };
  reconcileValue: unknown = { state: "exited", exitCode: 0 };
  releaseValue: unknown = { released: true };
  signalValues: unknown[] = [{ state: "exited" }];
  launchGate?: Promise<void>;
  launchError?: unknown;
  observeGate?: Promise<void>;
  verifyGate?: Promise<void>;
  onSignal?: (action: string) => void;
  onRelease?: () => void;
  probe = async (fence?: unknown) => {
    this.calls.push("probe");
    if (fence) this.fences.push(fence);
    return this.probeValue;
  };
  observe = async (
    _binding: ProcessBackendBinding,
    output: (stream: "stdout" | "stderr", bytes: Uint8Array) => Promise<void>,
    fence?: unknown,
  ) => {
    this.calls.push("observe");
    this.fences.push(fence);
    await output("stdout", Buffer.from("child"));
    await this.observeGate;
    return this.observeValue;
  };
  onLaunch?: (request: ProcessLaunchRequest) => void;
  launch = async (request: ProcessLaunchRequest) => {
    this.calls.push("launch");
    this.fences.push(request.fence);
    this.onLaunch?.(request);
    await this.launchGate;
    if (this.launchError) throw this.launchError;
    return this.launchValue;
  };
  signal = async (
    _binding: ProcessBackendBinding,
    action: string,
    fence?: unknown,
  ) => {
    this.calls.push(`signal:${action}`);
    this.fences.push(fence);
    this.onSignal?.(action);
    return this.signalValues.shift() ?? { state: "exited" };
  };
  verifyEmpty = async (_binding?: unknown, fence?: unknown) => {
    this.calls.push("verify");
    this.fences.push(fence);
    await this.verifyGate;
    return this.verifyValue;
  };
  reconcile = async (_binding?: unknown, fence?: unknown) => {
    this.calls.push("reconcile");
    this.fences.push(fence);
    return this.reconcileValue;
  };
  release = async (_binding?: unknown, fence?: unknown) => {
    this.calls.push("release");
    this.fences.push(fence);
    this.onRelease?.();
    return this.releaseValue;
  };
}
function backendRegistry(backend: Backend) {
  return createProcessBackendRegistry([
    createProcessBackendRegistration({
      stableAdapterId: "fake-adapter",
      backendId: "fake",
      codeDigest: "1".repeat(64),
      configDigest: "2".repeat(64),
      backend,
    }),
  ]);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(id = "invoke-1") {
  const stateKey = new Uint8Array(32).fill(9);
  const backend = new Backend();
  const clock = new Clock();
  const outputs = new Outputs();
  const registry = backendRegistry(backend);
  const environments = createChildEnvironmentFactory({
    credentialResolver: {
      consume: () => {
        throw new Error("unused");
      },
    },
    now: () => clock.now(),
  });
  const composed = createSubprocessRuntimeKernel({
    registry,
    state: { kind: "memory" },
    stateKey,
    clock,
    environments,
    outputs,
    createLogicalProcessId: (invocationId) => `proc-${invocationId}`,
    escalationGraceMs: [10, 20],
  });
  composed.grantsController.issue(grantValue(id));
  return {
    runtime: composed.runtime,
    store: composed.readOnlyStore,
    grants: composed.grantsController,
    kernel: undefined as never,
    stateKey,
    backend,
    clock,
    outputs,
    registry,
  };
}
function runtimeFor(
  state: { kind: "memory" } | { kind: "sqlite"; path: string },
  stateKey: Uint8Array,
  backend: Backend,
  clock: Clock,
  outputs: Outputs,
): ReturnType<typeof createSubprocessRuntimeKernel> {
  const environments = createChildEnvironmentFactory({
    credentialResolver: {
      consume: () => {
        throw new Error("unused");
      },
    },
    now: () => clock.now(),
  });
  const composed = createSubprocessRuntimeKernel({
    registry: backendRegistry(backend),
    state,
    stateKey,
    clock,
    environments,
    outputs,
    createLogicalProcessId: (invocationId) => `proc-${invocationId}`,
    escalationGraceMs: [10, 20],
  });
  composed.grantsController.issue(grantValue());
  return composed;
}

async function durableLaunchBlocker(
  t: { after(callback: () => Promise<void>): void },
  suffix = "blocked",
) {
  const root = await mkdtemp(join(tmpdir(), `runner-v2-${suffix}-`));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, "process.sqlite");
  const stateKey = new Uint8Array(32).fill(7);
  const backend = new Backend();
  const clock = new Clock();
  const outputs = new Outputs();
  const first = runtimeFor({ kind: "sqlite", path }, stateKey, backend, clock, outputs);
  const launchDetail = `owned descendant remains; evidence retained at ${root}`;
  backend.launchError = Object.assign(new Error(launchDetail), {
    code: "native_process_launch_cleanup_blocked",
    evidenceDirectory: root,
    launchResult: backend.launchValue,
  });
  backend.reconcileValue = { state: "running" };
  backend.verifyValue = { empty: false, detail: "owned descendant remains" };
  const result = await first.runtime.invoke({
    intent: intent(),
    grantId: "grant-invoke-1",
    ambientEnvironment: {},
  });
  assert.equal(result.outcome, "cleanup_failed");
  const blocked = first.readOnlyStore.readByInvocation("invoke-1");
  assert.ok(blocked);
  assert.equal(blocked.state, "cleanup_blocked");
  assert.equal(blocked.cleanup.state, "failed");
  const blockerDetail = blocked.cleanup.detail;
  backend.launchError = undefined;
  first.readOnlyStore.close();
  return { path, stateKey, backend, clock, outputs, blockerDetail };
}

async function seedRecoverable(
  f: ReturnType<typeof fixture>,
  state:
    | "prepared"
    | "launching"
    | "running"
    | "stopping"
    | "backend_unavailable"
    | "exited"
    | "verifying_empty",
) {
  const never = new Promise<void>(() => undefined);
  if (state === "prepared") f.outputs.prepareGate = never;
  if (state === "launching") f.backend.launchGate = never;
  if (state === "running" || state === "stopping")
    f.backend.observeGate = never;
  if (state === "exited") f.outputs.finalizeGate = never;
  if (state === "verifying_empty") f.backend.verifyGate = never;
  if (state === "backend_unavailable")
    f.backend.observeValue = new Proxy({}, {});
  void f.runtime
    .invoke({
      intent: intent(),
      grantId: "grant-invoke-1",
      ambientEnvironment: {},
    })
    .catch(() => undefined);
  const target = state;
  for (
    let attempt = 0;
    attempt < 100 && f.store.readByInvocation("invoke-1")?.state !== target;
    attempt += 1
  )
    await Promise.resolve();
  if (state === "stopping") {
    void f.runtime.cancel("invoke-1");
    for (
      let attempt = 0;
      attempt < 100 &&
      f.store.readByInvocation("invoke-1")?.state !== "stopping";
      attempt += 1
    )
      await Promise.resolve();
  }
  assert.equal(f.store.readByInvocation("invoke-1")?.state, target);
}

test("caller can provide only an opaque grant id and forged grant/result fields are rejected", async () => {
  const { runtime, backend, grants } = fixture();
  await assert.rejects(
    runtime.invoke({
      intent: intent(),
      grantId: "grant-invoke-1",
      ambientEnvironment: {},
      grant: grantValue(),
      stopReason: "cancelled",
    } as never),
    /unknown invocation field/i,
  );
  assert.equal(grants.revoke("grant-invoke-1"), true);
  assert.equal(backend.calls.includes("launch"), false);
});

test("runtime denies a semantic tree guarantee when the active adapter attests only partial ownership", async () => {
  const f = fixture();
  f.backend.probeValue = {
    attestationVersion: 1,
    backendId: "fake",
    verified: true,
    platformLabel: "portable-windows-baseline",
    capabilities: {
      tree_termination: "partial",
      crash_cleanup: "unavailable",
      verified_emptiness: "partial",
      write_confinement: "unavailable",
    },
  };
  await assert.rejects(
    f.runtime.invoke({
      intent: intent(),
      grantId: "grant-invoke-1",
      ambientEnvironment: {},
    }),
    (error: SubprocessRuntimeError) => error.code === "backend_unavailable",
  );
  assert.equal(f.backend.calls.includes("launch"), false);
  assert.equal(f.store.readByInvocation("invoke-1")?.state, "launch_not_proven");
});

test("runtime factory rejects malicious structural authority and launch sees a deep immutable intent snapshot", async () => {
  const f = fixture();
  assert.throws(
    () =>
      createSubprocessRuntimeKernel({
        registry: {} as never,
        state: { kind: "memory" },
        stateKey: f.stateKey,
        clock: f.clock,
        environments: createChildEnvironmentFactory({
          credentialResolver: {
            consume: () => {
              throw new Error("unused");
            },
          },
        }),
        outputs: f.outputs,
      }),
    /registry authority/i,
  );
  const mutable = intent() as unknown as ExecutionInvocationIntent & {
    arguments: string[];
    requestedCapabilities: string[];
  };
  f.backend.onLaunch = (request) => {
    assert.deepEqual(request.intent.arguments, ["--secret-value"]);
    assert.equal(Object.isFrozen(request.intent), true);
    assert.equal(Object.isFrozen(request.intent.arguments), true);
    assert.equal(Object.isFrozen(request), true);
  };
  const operation = f.runtime.invoke({
    intent: mutable,
    grantId: "grant-invoke-1",
    ambientEnvironment: {},
  });
  mutable.arguments[0] = "--mutated";
  mutable.requestedCapabilities.length = 0;
  await operation;
});

test("runtime is a closure facade exposing only intended invocation methods", () => {
  const { runtime } = fixture();
  assert.deepEqual(Reflect.ownKeys(runtime).sort(), [
    "cancel",
    "invoke",
    "reconcileStartup",
  ]);
  assert.equal(Object.getOwnPropertySymbols(runtime).length, 0);
  assert.equal(Object.getPrototypeOf(runtime), null);
  const exposed = inspect(runtime, { showHidden: true, depth: 8 });
  assert.doesNotMatch(
    exposed,
    /writer|vault|stateKey|registry|options|grantBindingDigest|integrityKey/i,
  );
  assert.equal(JSON.stringify(runtime), "{}");
});

test("every output and backend effect receives the durable owner fencing token", async () => {
  const f = fixture();
  f.backend.onLaunch = (request) => {
    assert.deepEqual((request as { fence?: unknown }).fence, {
      ownerId: f.store.readByInvocation("invoke-1")?.ownerId,
      fencingToken: 1,
    });
  };
  await f.runtime.invoke({
    intent: intent(),
    grantId: "grant-invoke-1",
    ambientEnvironment: {},
  });
  assert.ok(f.outputs.fences.length >= 3);
  assert.ok(
    f.outputs.fences.every(
      (value) =>
        (value as { fencingToken?: number } | undefined)?.fencingToken === 1,
    ),
  );
  assert.ok(f.backend.fences.length >= 6);
  assert.ok(
    f.backend.fences.every(
      (value) =>
        (value as { fencingToken?: number } | undefined)?.fencingToken === 1,
    ),
  );
});

test("durable claim and output owner exist before first await so immediate cancel is queued", async () => {
  const f = fixture();
  const gate = deferred();
  f.outputs.prepareGate = gate.promise;
  const operation = f.runtime.invoke({
    intent: intent(),
    grantId: "grant-invoke-1",
    ambientEnvironment: {},
  });
  assert.equal(f.store.readByInvocation("invoke-1")?.state, "prepared");
  assert.equal(
    f.store.readByInvocation("invoke-1")?.outputOwnerId,
    "output-proc-invoke-1",
  );
  assert.equal(await f.runtime.cancel("invoke-1"), true);
  assert.equal(
    f.store.readByInvocation("invoke-1")?.stopIntent?.reason,
    "cancelled",
  );
  gate.resolve();
  const result = await operation;
  assert.equal(result.outcome, "cancelled");
});

test("crash-safe output intent precedes idempotent prepare and prepare failure is durable", async () => {
  const f = fixture();
  f.outputs.failPrepare = true;
  const operation = f.runtime.invoke({
    intent: intent(),
    grantId: "grant-invoke-1",
    ambientEnvironment: {},
  });
  assert.equal(f.store.readByInvocation("invoke-1")?.outputPrepared, false);
  await assert.rejects(
    operation,
    (error: SubprocessRuntimeError) => error.code === "launch_not_proven",
  );
  assert.equal(f.store.readByInvocation("invoke-1")?.state, "prepared");
  assert.equal(
    f.store.readByInvocation("invoke-1")?.outputPrepareFailure?.detail,
    "Recoverable output ownership could not be prepared.",
  );
  assert.equal(f.grants.revoke("grant-invoke-1"), true);
  f.outputs.failPrepare = false;
  await f.runtime.reconcileStartup();
  assert.equal(
    f.store.readByInvocation("invoke-1")?.state,
    "launch_not_proven",
  );
  assert.ok(f.outputs.calls.includes("cleanup:output-proc-invoke-1"));
});

test("failed prelaunch output cleanup remains recoverable until owner cleanup succeeds", async () => {
  const f = fixture();
  f.outputs.failPrepare = true;
  await assert.rejects(
    f.runtime.invoke({
      intent: intent(),
      grantId: "grant-invoke-1",
      ambientEnvironment: {},
    }),
  );
  f.outputs.failPrepare = false;
  f.outputs.failCleanupFor.add("output-proc-invoke-1");
  await f.runtime.reconcileStartup();
  const blocked = f.store.readByInvocation("invoke-1");
  assert.equal(blocked?.state, "cleanup_blocked");
  assert.equal(blocked?.cleanup.state, "failed");
  assert.equal(blocked?.result?.outcome, "launch_failed");
  f.outputs.failCleanupFor.clear();
  await f.runtime.reconcileStartup();
  assert.equal(
    f.store.readByInvocation("invoke-1")?.state,
    "launch_not_proven",
  );
});

test("recoverable launch cleanup blocker binds identity and persists without prelaunch cleanup or relaunch", async () => {
  const f = fixture();
  const blockerDetail = "owned descendant remains; evidence retained at C:\\runner-state\\owned-1";
  f.backend.launchError = Object.assign(new Error(blockerDetail), {
    code: "native_process_launch_cleanup_blocked",
    evidenceDirectory: "C:\\runner-state\\owned-1",
    launchResult: f.backend.launchValue,
  });
  f.backend.reconcileValue = { state: "running" };
  f.backend.verifyValue = { empty: false, detail: "owned descendant remains" };

  const result = await f.runtime.invoke({
    intent: intent(),
    grantId: "grant-invoke-1",
    ambientEnvironment: {},
  });

  const record = f.store.readByInvocation("invoke-1");
  assert.ok(record);
  assert.equal(result.outcome, "cleanup_failed");
  assert.equal(record.state, "cleanup_blocked");
  assert.equal(record.backendBinding?.opaqueIdentity, "opaque-1");
  assert.equal(record.cleanup.state, "failed");
  assert.equal(record.cleanup.detail, `${blockerDetail} Backend verification: owned descendant remains`);
  assert.deepEqual(f.backend.calls.filter((call) => ["reconcile", "verify"].includes(call)), ["reconcile", "verify"]);
  assert.equal(f.backend.calls.includes("observe"), false);
  assert.equal(f.backend.calls.includes("release"), false);
  assert.equal(f.outputs.calls.some((call) => call.startsWith("cleanup:")), false);

  const retry = await f.runtime.invoke({
    intent: intent(),
    grantId: "grant-invoke-1",
    ambientEnvironment: {},
  });
  assert.equal(retry.outcome, "cleanup_failed");
  assert.equal(f.backend.calls.filter((call) => call === "launch").length, 1);
});

test("restart reattests a live launch blocker and retry never relaunches", async (t) => {
  const f = await durableLaunchBlocker(t);
  f.clock.current = new Date(f.clock.current.getTime() + 301_000);
  f.backend.reconcileValue = { state: "running" };
  const recovery = runtimeFor({ kind: "sqlite", path: f.path }, f.stateKey, f.backend, f.clock, f.outputs);

  assert.deepEqual(await recovery.runtime.reconcileStartup(), [
    { invocationId: "invoke-1", state: "cleanup_blocked" },
  ]);
  const blocked = recovery.readOnlyStore.readByInvocation("invoke-1");
  assert.equal(blocked?.cleanup.state, "failed");
  assert.ok(blocked?.mutations.some((mutation) => mutation.kind === "adopt_backend"));
  assert.equal(f.backend.calls.filter((call) => call === "reconcile").length, 2);
  f.backend.reconcileValue = { state: "exited", exitCode: 0 };
  f.backend.verifyValue = { empty: true, proofArtifactId: "retry-proof" };
  const retry = await recovery.runtime.invoke({
    intent: intent(),
    grantId: "grant-invoke-1",
    ambientEnvironment: {},
  });
  assert.equal(retry.outcome, "exited");
  assert.equal(recovery.readOnlyStore.readByInvocation("invoke-1")?.state, "cleaned");
  assert.equal(f.backend.calls.filter((call) => call === "launch").length, 1);
  recovery.readOnlyStore.close();
});

test("restart closes a launch blocker only after natural exit and verified release", async (t) => {
  const f = await durableLaunchBlocker(t);
  f.clock.current = new Date(f.clock.current.getTime() + 301_000);
  f.backend.reconcileValue = { state: "exited", exitCode: 0 };
  f.backend.verifyValue = { empty: false, detail: "descendant still draining" };
  const recovery = runtimeFor({ kind: "sqlite", path: f.path }, f.stateKey, f.backend, f.clock, f.outputs);

  assert.deepEqual(await recovery.runtime.reconcileStartup(), [
    { invocationId: "invoke-1", state: "cleanup_blocked" },
  ]);
  assert.ok(recovery.readOnlyStore.readByInvocation("invoke-1")?.output);
  f.backend.verifyValue = { empty: true, proofArtifactId: "blocked-proof" };
  assert.deepEqual(await recovery.runtime.reconcileStartup(), [
    { invocationId: "invoke-1", state: "cleaned" },
  ]);
  const record = recovery.readOnlyStore.readByInvocation("invoke-1");
  assert.equal(record?.cleanup.state, "verified_empty");
  assert.equal(record?.result?.outcome, "exited");
  assert.ok(record?.mutations.some((mutation) => mutation.kind === "resume_blocked_exit"));
  assert.ok(f.outputs.calls.some((call) => call.startsWith("reopen:")));
  assert.ok(f.outputs.calls.some((call) => call.startsWith("finalize:")));
  assert.ok(f.backend.calls.includes("verify"));
  assert.ok(f.backend.calls.includes("release"));
  assert.equal(f.backend.calls.filter((call) => call === "launch").length, 1);
  recovery.readOnlyStore.close();
});

test("restart cancellation stops only the authenticated blocked identity and completes cleanup", async (t) => {
  const f = await durableLaunchBlocker(t);
  f.clock.current = new Date(f.clock.current.getTime() + 301_000);
  f.backend.signalValues = [{ state: "exited" }];
  f.backend.reconcileValue = { state: "running" };
  f.backend.verifyValue = { empty: true, proofArtifactId: "cancelled-blocker-proof" };
  f.backend.onSignal = () => {
    f.backend.reconcileValue = { state: "exited", signal: "SIGINT" };
  };
  const recovery = runtimeFor({ kind: "sqlite", path: f.path }, f.stateKey, f.backend, f.clock, f.outputs);

  const accepted = await recovery.runtime.cancel("invoke-1");
  assert.equal(accepted, true, inspect({ calls: f.backend.calls, record: recovery.readOnlyStore.readByInvocation("invoke-1") }));
  const record = recovery.readOnlyStore.readByInvocation("invoke-1");
  assert.equal(record?.state, "cleaned", inspect({ calls: f.backend.calls, record }));
  assert.equal(record?.result?.outcome, "cancelled");
  assert.deepEqual(f.backend.calls.filter((call) => call.startsWith("signal:")), ["signal:interrupt"]);
  assert.ok(f.backend.calls.includes("release"));
  assert.equal(f.backend.calls.filter((call) => call === "launch").length, 1);
  recovery.readOnlyStore.close();
});

test("restart cancellation preserves blocker evidence when authenticated escalation cannot enforce exit", async (t) => {
  const f = await durableLaunchBlocker(t, "unenforced-cancel");
  f.clock.current = new Date(f.clock.current.getTime() + 301_000);
  f.backend.reconcileValue = { state: "running" };
  f.backend.signalValues = [
    { state: "running" },
    { state: "running" },
    { state: "running" },
  ];
  const recovery = runtimeFor({ kind: "sqlite", path: f.path }, f.stateKey, f.backend, f.clock, f.outputs);

  assert.equal(await recovery.runtime.cancel("invoke-1"), true);
  const record = recovery.readOnlyStore.readByInvocation("invoke-1");
  assert.equal(record?.state, "cleanup_blocked");
  assert.equal(record?.cleanup.state, "failed");
  if (record?.cleanup.state === "failed") assert.equal(record.cleanup.detail, f.blockerDetail);
  assert.deepEqual(f.backend.calls.filter((call) => call.startsWith("signal:")), [
    "signal:interrupt",
    "signal:terminate",
    "signal:force_terminate",
  ]);
  assert.equal(f.backend.calls.filter((call) => call === "launch").length, 1);
  recovery.readOnlyStore.close();
});

test("restart preserves typed launch blockers for unavailable, unknown, and mismatched backends", async (t) => {
  for (const mode of ["unavailable", "outcome_unknown", "identity_mismatch"] as const) {
    const f = await durableLaunchBlocker(t, mode);
    f.clock.current = new Date(f.clock.current.getTime() + 301_000);
    if (mode === "unavailable") f.backend.probeValue = new Proxy({}, {});
    else f.backend.reconcileValue = { state: mode };
    const recovery = runtimeFor({ kind: "sqlite", path: f.path }, f.stateKey, f.backend, f.clock, f.outputs);

    assert.deepEqual(await recovery.runtime.reconcileStartup(), [
      { invocationId: "invoke-1", state: "cleanup_blocked" },
    ]);
    const record = recovery.readOnlyStore.readByInvocation("invoke-1");
    assert.equal(record?.state, "cleanup_blocked", mode);
    assert.equal(record?.cleanup.state, "failed", mode);
    if (record?.cleanup.state === "failed") {
      assert.equal(record.cleanup.code, "launch_cleanup_blocked", mode);
      assert.equal(record.cleanup.detail, f.blockerDetail, mode);
    }
    assert.equal(f.backend.calls.filter((call) => call === "launch").length, 1, mode);
    recovery.readOnlyStore.close();
  }
});

test("stale restart owner cannot recover or cancel a leased launch blocker", async (t) => {
  const f = await durableLaunchBlocker(t);
  const stale = runtimeFor({ kind: "sqlite", path: f.path }, f.stateKey, f.backend, f.clock, f.outputs);

  assert.deepEqual(await stale.runtime.reconcileStartup(), [
    { invocationId: "invoke-1", state: "leased" },
  ]);
  assert.equal(await stale.runtime.cancel("invoke-1"), false);
  const retry = await stale.runtime.invoke({
    intent: intent(),
    grantId: "grant-invoke-1",
    ambientEnvironment: {},
  });
  assert.equal(retry.outcome, "cleanup_failed");
  assert.equal(f.backend.calls.filter((call) => call === "reconcile").length, 1);
  assert.equal(f.backend.calls.filter((call) => call === "launch").length, 1);
  stale.readOnlyStore.close();
});

test("Runner-private grant is atomically consumed, strictly snapshotted, run-bound, and expiry checked", async () => {
  const expired = fixture();
  expired.grants.revoke("grant-invoke-1");
  expired.grants.issue(
    grantValue("invoke-1", { expiresAt: "2025-01-01T00:00:00.000Z" }),
  );
  await assert.rejects(
    expired.runtime.invoke({
      intent: intent(),
      grantId: "grant-invoke-1",
      ambientEnvironment: {},
    }),
    /execution grant/i,
  );
  assert.equal(expired.backend.calls.includes("launch"), false);
  assert.equal(
    expired.store.readByInvocation("invoke-1")?.state,
    "launch_not_proven",
  );
  assert.ok(expired.outputs.calls.includes("cleanup:output-proc-invoke-1"));
  const forged = fixture();
  forged.grants.revoke("grant-invoke-1");
  assert.throws(
    () =>
      forged.grants.issue(
        Object.defineProperty(grantValue(), "runId", {
          enumerable: true,
          get: () => "run-1",
        }),
      ),
    /execution grant|invalid/i,
  );
  const future = fixture();
  future.grants.revoke("grant-invoke-1");
  future.grants.issue(
    grantValue("invoke-1", { issuedAt: "2027-01-01T00:00:00.000Z" }),
  );
  await assert.rejects(
    future.runtime.invoke({
      intent: intent(),
      grantId: "grant-invoke-1",
      ambientEnvironment: {},
    }),
    /execution grant/i,
  );
});

test("concurrent exact invocations share one operation while divergent retries conflict", async () => {
  const { runtime, backend } = fixture();
  const [left, right] = await Promise.all([
    runtime.invoke({
      intent: intent(),
      grantId: "grant-invoke-1",
      ambientEnvironment: { PATH: "safe" },
    }),
    runtime.invoke({
      intent: intent(),
      grantId: "grant-invoke-1",
      ambientEnvironment: { PATH: "safe" },
    }),
  ]);
  assert.deepEqual(right, left);
  assert.equal(backend.calls.filter((call) => call === "launch").length, 1);
  await assert.rejects(
    runtime.invoke({
      intent: intent("invoke-1", "different"),
      grantId: "grant-invoke-1",
      ambientEnvironment: { PATH: "safe" },
    }),
    /idempotency conflict/i,
  );
  await assert.rejects(
    runtime.invoke({
      intent: intent(),
      grantId: "grant-invoke-1",
      ambientEnvironment: { PATH: "other-value" },
    }),
    /idempotency conflict/i,
  );
});

test("separate SQLite runtime contenders durably elect one winner before grant or output effects", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-runtime-sqlite-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, "process.sqlite");
  const stateKey = new Uint8Array(32).fill(4);
  const backend = new Backend();
  const clock = new Clock();
  const outputs = new Outputs();
  const first = runtimeFor(
    { kind: "sqlite", path },
    stateKey,
    backend,
    clock,
    outputs,
  );
  const second = runtimeFor(
    { kind: "sqlite", path },
    stateKey,
    backend,
    clock,
    outputs,
  );
  const request = {
    intent: intent(),
    grantId: "grant-invoke-1",
    ambientEnvironment: { API_KEY: "secret-value", PATH: "one" },
  };
  const [left, right] = await Promise.all([
    first.runtime.invoke(request),
    second.runtime.invoke(request),
  ]);
  assert.deepEqual(right, left);
  assert.equal(backend.calls.filter((call) => call === "launch").length, 1);
  assert.equal(
    outputs.calls.filter((call) => call.startsWith("prepare:")).length,
    1,
  );
  await assert.rejects(
    second.runtime.invoke({
      ...request,
      ambientEnvironment: { API_KEY: "different-secret", PATH: "one" },
    }),
    /idempotency conflict/i,
  );
  assert.equal(
    Number(first.grantsController.revoke("grant-invoke-1")) +
      Number(second.grantsController.revoke("grant-invoke-1")),
    1,
  );
  first.readOnlyStore.close();
  second.readOnlyStore.close();
  const bytes = await readFile(path);
  for (const forbidden of [
    "secret-value",
    "different-secret",
    "--secret-value",
    "C:\\host\\project",
    "nativeHandle",
    "spill.tmp",
  ])
    assert.equal(bytes.includes(Buffer.from(forbidden)), false, forbidden);
});

test("separate OS processes contend through SQLite with one pre-effect owner", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-process-contention-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const fixturePath = join(
    process.cwd(),
    "runner-v2",
    "test",
    "fixtures",
    "sqlite-runtime-contender.mts",
  );
  const cli = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const run = (name: string) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, fixturePath, root, name], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(stderr || `exit ${code}`)),
      );
    });
  await Promise.all([run("a"), run("b")]);
  const rows = await Promise.all(
    ["a", "b"].map(
      async (name) =>
        JSON.parse(await readFile(join(root, `${name}.json`), "utf8")) as {
          prepares: number;
          grantRemained: boolean;
          outcome: string;
        },
    ),
  );
  assert.equal(
    rows.reduce((sum, row) => sum + row.prepares, 0),
    1,
  );
  assert.equal(rows.filter((row) => row.grantRemained).length, 1);
  assert.ok(rows.every((row) => row.outcome === "exited"));
});

test("separate OS processes retry writable SQLite initialization across a transient schema lock", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-init-lock-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, "state.sqlite");
  const lock = new DatabaseSync(path);
  lock.exec("CREATE TABLE lock_holder (value INTEGER); BEGIN EXCLUSIVE");
  const fixturePath = join(
    process.cwd(),
    "runner-v2",
    "test",
    "fixtures",
    "sqlite-runtime-contender.mts",
  );
  const cli = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const run = (name: string) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, fixturePath, root, name], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(stderr || `exit ${code}`)),
      );
    });
  const contenders = Promise.all([run("a"), run("b")]);
  await new Promise((resolve) => setTimeout(resolve, 5_250));
  lock.exec("COMMIT");
  lock.close();
  await contenders;
  const rows = await Promise.all(
    ["a", "b"].map(async (name) =>
      JSON.parse(await readFile(join(root, `${name}.json`), "utf8")),
    ),
  );
  assert.equal(
    rows.reduce((sum, row: { prepares: number }) => sum + row.prepares, 0),
    1,
  );
});

test("live owner heartbeat prevents lease stealing throughout a blocked output effect", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-lease-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, "state.sqlite");
  const stateKey = new Uint8Array(32).fill(6);
  const backend = new Backend();
  const clock = new Clock();
  const firstOutputs = new Outputs();
  const prepareGate = deferred();
  firstOutputs.prepareGate = prepareGate.promise;
  const registry = backendRegistry(backend);
  const environments = createChildEnvironmentFactory({
    credentialResolver: {
      consume: () => {
        throw new Error("unused");
      },
    },
    now: () => clock.now(),
  });
  const first = createSubprocessRuntimeKernel({
    registry,
    state: { kind: "sqlite", path },
    stateKey,
    clock,
    environments,
    outputs: firstOutputs,
    createLogicalProcessId: (id) => `proc-${id}`,
    leaseHeartbeatMs: 10,
  });
  first.grantsController.issue(grantValue());
  void first.runtime.invoke({
    intent: intent(),
    grantId: "grant-invoke-1",
    ambientEnvironment: {},
  });
  assert.equal(
    first.readOnlyStore.readByInvocation("invoke-1")?.state,
    "prepared",
  );
  const secondOutputs = new Outputs();
  const second = createSubprocessRuntimeKernel({
    registry,
    state: { kind: "sqlite", path },
    stateKey,
    clock,
    environments,
    outputs: secondOutputs,
    createLogicalProcessId: (id) => `proc-${id}`,
  });
  assert.deepEqual(await second.runtime.reconcileStartup(), [
    { invocationId: "invoke-1", state: "leased" },
  ]);
  assert.equal(secondOutputs.calls.length, 0);
  clock.current = new Date(clock.current.getTime() + 301_000);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(await second.runtime.reconcileStartup(), [
    { invocationId: "invoke-1", state: "leased" },
  ]);
  assert.equal(secondOutputs.calls.length, 0);
  prepareGate.resolve();
  for (
    let attempt = 0;
    attempt < 100 &&
    first.readOnlyStore.readByInvocation("invoke-1")?.state !== "cleaned";
    attempt += 1
  )
    await new Promise((resolve) => setTimeout(resolve, 1));
  first.readOnlyStore.close();
  second.readOnlyStore.close();
});

test("stale owner completing an uncertain effect is rejected after safe expiry takeover", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-stale-fence-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, "state.sqlite");
  const stateKey = new Uint8Array(32).fill(3);
  const backend = new Backend();
  const clock = new Clock();
  const firstOutputs = new Outputs();
  const gate = deferred();
  firstOutputs.prepareGate = gate.promise;
  const first = runtimeFor(
    { kind: "sqlite", path },
    stateKey,
    backend,
    clock,
    firstOutputs,
  );
  const stale = first.runtime.invoke({
    intent: intent(),
    grantId: "grant-invoke-1",
    ambientEnvironment: {},
  });
  const prepared = first.readOnlyStore.readByInvocation("invoke-1")!;
  clock.current = new Date(clock.current.getTime() + 301_000);
  const secondOutputs = new Outputs();
  const second = runtimeFor(
    { kind: "sqlite", path },
    stateKey,
    backend,
    clock,
    secondOutputs,
  );
  await second.runtime.reconcileStartup();
  const recovered = second.readOnlyStore.readByInvocation("invoke-1")!;
  assert.equal(recovered.state, "launch_not_proven");
  assert.notEqual(recovered.ownerId, prepared.ownerId);
  assert.equal(recovered.fencingToken, prepared.fencingToken + 1);
  assert.deepEqual(secondOutputs.calls, [
    "prepare:output-proc-invoke-1",
    "cleanup:output-proc-invoke-1",
  ]);
  gate.resolve();
  await assert.rejects(stale, /owner|fenc|stale/i);
  assert.equal(backend.calls.filter((call) => call === "launch").length, 0);
  first.readOnlyStore.close();
  second.readOnlyStore.close();
});

test("expired unbound launch is atomically orphaned without takeover cleanup or relaunch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-launch-orphan-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, "state.sqlite");
  const stateKey = new Uint8Array(32).fill(4);
  const backend = new Backend();
  const clock = new Clock();
  const firstOutputs = new Outputs();
  const launchGate = deferred();
  backend.launchGate = launchGate.promise;
  const first = runtimeFor(
    { kind: "sqlite", path },
    stateKey,
    backend,
    clock,
    firstOutputs,
  );
  const stale = first.runtime.invoke({
    intent: intent(),
    grantId: "grant-invoke-1",
    ambientEnvironment: {},
  });
  for (
    let attempt = 0;
    attempt < 100 &&
    backend.calls.filter((call) => call === "launch").length !== 1;
    attempt += 1
  )
    await Promise.resolve();
  const launching = first.readOnlyStore.readByInvocation("invoke-1")!;
  assert.equal(launching.state, "launching");
  assert.equal(launching.backendBinding, undefined);
  assert.equal(backend.calls.filter((call) => call === "launch").length, 1);

  clock.current = new Date(clock.current.getTime() + 301_000);
  const secondOutputs = new Outputs();
  const second = runtimeFor(
    { kind: "sqlite", path },
    stateKey,
    backend,
    clock,
    secondOutputs,
  );
  assert.deepEqual(await second.runtime.reconcileStartup(), [
    { invocationId: "invoke-1", state: "orphaned" },
  ]);
  const orphaned = second.readOnlyStore.readByInvocation("invoke-1")!;
  assert.equal(orphaned.state, "orphaned");
  assert.equal(orphaned.backendBinding, undefined);
  assert.equal(orphaned.ownerId, launching.ownerId);
  assert.equal(orphaned.fencingToken, launching.fencingToken + 1);
  assert.deepEqual(secondOutputs.calls, []);
  assert.equal(backend.calls.filter((call) => call === "launch").length, 1);

  await assert.rejects(
    second.runtime.invoke({
      intent: intent(),
      grantId: "grant-invoke-1",
      ambientEnvironment: {},
    }),
    /orphaned|outcome_unknown/i,
  );
  assert.equal(backend.calls.filter((call) => call === "launch").length, 1);
  launchGate.resolve();
  await assert.rejects(stale, /owner|fenc|stale/i);
  const afterStaleReturn = second.readOnlyStore.readByInvocation("invoke-1")!;
  assert.equal(afterStaleReturn.state, "orphaned");
  assert.equal(afterStaleReturn.backendBinding, undefined);
  assert.equal(backend.calls.filter((call) => call === "launch").length, 1);
  assert.equal(backend.calls.filter((call) => call === "observe").length, 0);
  assert.equal(
    [...firstOutputs.calls, ...secondOutputs.calls].some((call) =>
      call.startsWith("cleanup:"),
    ),
    false,
  );
  first.readOnlyStore.close();
  second.readOnlyStore.close();
});

test("expired bound active recovery retains takeover reconciliation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-bound-recovery-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, "state.sqlite");
  const stateKey = new Uint8Array(32).fill(8);
  const backend = new Backend();
  const clock = new Clock();
  const firstOutputs = new Outputs();
  const observeGate = deferred();
  backend.observeGate = observeGate.promise;
  const first = runtimeFor(
    { kind: "sqlite", path },
    stateKey,
    backend,
    clock,
    firstOutputs,
  );
  const stale = first.runtime.invoke({
    intent: intent(),
    grantId: "grant-invoke-1",
    ambientEnvironment: {},
  });
  for (
    let attempt = 0;
    attempt < 100 &&
    first.readOnlyStore.readByInvocation("invoke-1")?.state !== "running";
    attempt += 1
  )
    await Promise.resolve();
  const running = first.readOnlyStore.readByInvocation("invoke-1")!;
  assert.ok(running.backendBinding);

  clock.current = new Date(clock.current.getTime() + 301_000);
  backend.observeGate = undefined;
  const secondOutputs = new Outputs();
  const second = runtimeFor(
    { kind: "sqlite", path },
    stateKey,
    backend,
    clock,
    secondOutputs,
  );
  assert.deepEqual(await second.runtime.reconcileStartup(), [
    { invocationId: "invoke-1", state: "cleaned" },
  ]);
  const cleaned = second.readOnlyStore.readByInvocation("invoke-1")!;
  assert.equal(cleaned.ownerId === running.ownerId, false);
  assert.equal(cleaned.fencingToken, running.fencingToken + 1);
  assert.equal(backend.calls.filter((call) => call === "launch").length, 1);
  assert.equal(backend.calls.filter((call) => call === "reconcile").length, 1);

  observeGate.resolve();
  await assert.rejects(stale, /owner|fenc|stale|unavailable/i);
  assert.equal(
    second.readOnlyStore.readByInvocation("invoke-1")?.state,
    "cleaned",
  );
  first.readOnlyStore.close();
  second.readOnlyStore.close();
});

test("deadline is runtime-owned and persists interrupt terminate force escalation before effects", async () => {
  const { runtime, store, backend } = fixture();
  backend.signalValues = [
    { state: "running" },
    { state: "running" },
    { state: "exited" },
  ];
  backend.onSignal = () =>
    assert.equal(
      store.readByInvocation("invoke-1")?.escalation.at(-1)?.outcome,
      "requested",
    );
  const result = await runtime.invoke({
    intent: intent(),
    grantId: "grant-invoke-1",
    ambientEnvironment: {},
    deadline: new Date("2026-01-01T00:00:01.000Z"),
  });
  assert.equal(result.outcome, "timed_out");
  assert.deepEqual(
    backend.calls.filter((call) => call.startsWith("signal:")),
    ["signal:interrupt", "signal:terminate", "signal:force_terminate"],
  );
  assert.deepEqual(
    store.readByInvocation("invoke-1")?.escalation.map(({ action }) => action),
    ["interrupt", "terminate", "force_terminate"],
  );
});

test("cancellation during launch queues durable stop and signals only after identity bind", async () => {
  const { runtime, store, backend } = fixture();
  const gate = deferred();
  backend.launchGate = gate.promise;
  const running = runtime.invoke({
    intent: intent(),
    grantId: "grant-invoke-1",
    ambientEnvironment: {},
  });
  await Promise.resolve();
  await Promise.resolve();
  const cancellation = runtime.cancel("invoke-1");
  assert.equal(
    backend.calls.some((call) => call.startsWith("signal:")),
    false,
  );
  assert.equal(
    store.readByInvocation("invoke-1")?.stopIntent?.reason,
    "cancelled",
  );
  gate.resolve();
  await Promise.all([running, cancellation]);
  assert.equal(
    backend.calls.some((call) => call.startsWith("signal:")),
    true,
  );
});

test("terminal cancel is a read-only no-op and never signals a cleaned process", async () => {
  const { runtime, store, backend } = fixture();
  await runtime.invoke({
    intent: intent(),
    grantId: "grant-invoke-1",
    ambientEnvironment: {},
  });
  const before = store.readByInvocation("invoke-1");
  assert.equal(await runtime.cancel("invoke-1"), false);
  assert.deepEqual(store.readByInvocation("invoke-1"), before);
  assert.equal(
    backend.calls.filter((call) => call.startsWith("signal:")).length,
    0,
  );
});

test("fresh attestation mismatch blocks cancellation authority before signal", async () => {
  const { runtime, backend, store } = fixture();
  const gate = deferred();
  backend.observeGate = gate.promise;
  const operation = runtime.invoke({
    intent: intent(),
    grantId: "grant-invoke-1",
    ambientEnvironment: {},
  });
  for (
    let i = 0;
    i < 20 && store.readByInvocation("invoke-1")?.state !== "running";
    i += 1
  )
    await Promise.resolve();
  backend.probeValue = {
    attestationVersion: 1,
    backendId: "fake",
    verified: true,
    platformLabel: "replacement",
    capabilities,
  };
  assert.equal(await runtime.cancel("invoke-1"), false);
  assert.equal(
    backend.calls.filter((call) => call.startsWith("signal:")).length,
    0,
  );
  assert.equal(store.readByInvocation("invoke-1")?.state, "identity_mismatch");
  gate.resolve();
  await assert.rejects(operation);
});

test("restart preserves durable timeout precedence after observation loss", async () => {
  const f = fixture();
  f.backend.observeValue = new Proxy({}, {});
  await assert.rejects(
    f.runtime.invoke({
      intent: intent(),
      grantId: "grant-invoke-1",
      ambientEnvironment: {},
      deadline: new Date("2026-01-01T00:00:01.000Z"),
    }),
  );
  assert.equal(
    f.store.readByInvocation("invoke-1")?.stopIntent?.reason,
    "timed_out",
  );
  f.backend.observeValue = { state: "exited", exitCode: 0 };
  await f.runtime.reconcileStartup();
  assert.equal(
    f.store.readByInvocation("invoke-1")?.result?.outcome,
    "timed_out",
  );
});

test("backend-unavailable with durable stop re-enters stopping and escalates when backend returns", async () => {
  const f = fixture();
  f.backend.observeValue = new Proxy({}, {});
  f.backend.signalValues = [{ state: "exited" }];
  await assert.rejects(
    f.runtime.invoke({
      intent: intent(),
      grantId: "grant-invoke-1",
      ambientEnvironment: {},
      deadline: new Date("2026-01-01T00:00:01.000Z"),
    }),
  );
  assert.equal(
    f.store.readByInvocation("invoke-1")?.state,
    "backend_unavailable",
  );
  f.backend.calls.length = 0;
  f.backend.reconcileValue = { state: "running" };
  f.backend.observeValue = { state: "exited", exitCode: 0 };
  f.backend.signalValues = [{ state: "exited" }];
  await f.runtime.reconcileStartup();
  assert.equal(f.store.readByInvocation("invoke-1")?.state, "cleaned");
  assert.equal(
    f.store.readByInvocation("invoke-1")?.result?.outcome,
    "timed_out",
  );
});

test("grant controller authority is scoped to exactly one kernel", async () => {
  const left = fixture("left");
  const right = fixture("right");
  left.grants.issue(grantValue("cross"));
  await assert.rejects(
    right.runtime.invoke({
      intent: intent("cross"),
      grantId: "grant-cross",
      ambientEnvironment: {},
    }),
    /execution grant/i,
  );
  assert.equal(left.grants.revoke("grant-cross"), true);
});

test("durable timeout and cancellation outrank later cleanup failure", async () => {
  const f = fixture();
  f.backend.verifyValue = { empty: false, detail: "descendant remains" };
  const result = await f.runtime.invoke({
    intent: intent(),
    grantId: "grant-invoke-1",
    ambientEnvironment: {},
    deadline: new Date("2026-01-01T00:00:01.000Z"),
  });
  assert.equal(result.outcome, "timed_out");
  assert.equal(f.store.readByInvocation("invoke-1")?.state, "cleanup_blocked");
});

test("malformed backend results are classified and never become verified success", async () => {
  const launch = fixture();
  launch.backend.launchValue = {
    opaqueIdentity: "opaque",
    birthFingerprint: { observedAt: "x", discriminator: "d" },
    startedAt: "x",
    extra: true,
  };
  await assert.rejects(
    launch.runtime.invoke({
      intent: intent(),
      grantId: "grant-invoke-1",
      ambientEnvironment: {},
    }),
    (error: SubprocessRuntimeError) => error.code === "launch_not_proven",
  );
  const verify = fixture();
  verify.backend.verifyValue = { empty: "false", detail: "descendant" };
  const result = await verify.runtime.invoke({
    intent: intent(),
    grantId: "grant-invoke-1",
    ambientEnvironment: {},
  });
  assert.equal(result.outcome, "cleanup_failed");
  assert.equal(
    verify.store.readByInvocation("invoke-1")?.state,
    "cleanup_blocked",
  );
});

test("output ownership is prepared before launch and finalized before verified cleanup", async () => {
  const { runtime, backend, outputs } = fixture();
  backend.onLaunch = () =>
    assert.deepEqual(outputs.calls, ["prepare:output-proc-invoke-1"]);
  backend.onRelease = () =>
    assert.ok(backend.calls.filter((call) => call === "probe").length >= 3);
  await runtime.invoke({
    intent: intent(),
    grantId: "grant-invoke-1",
    ambientEnvironment: {},
  });
  assert.deepEqual(outputs.calls, [
    "prepare:output-proc-invoke-1",
    "finalize:output-proc-invoke-1",
  ]);
});

test("restart reopens output, preserves stop precedence, and isolates one record failure from later recovery", async () => {
  const first = fixture("first");
  const secondIntent = intent("second");
  // Build two recoverable rows through real runtime/store commands by crashing observation.
  first.backend.observeValue = new Proxy({}, {});
  first.grants.issue(grantValue("second"));
  await assert.rejects(
    first.runtime.invoke({
      intent: intent("first"),
      grantId: "grant-first",
      ambientEnvironment: {},
    }),
  );
  await assert.rejects(
    first.runtime.invoke({
      intent: secondIntent,
      grantId: "grant-second",
      ambientEnvironment: {},
    }),
  );
  const firstRecord = first.store.readByInvocation("first")!;
  first.outputs.failReopenFor.add(firstRecord.outputOwnerId);
  first.backend.observeValue = { state: "exited", exitCode: 0 };
  const outcomes = await first.runtime.reconcileStartup();
  assert.equal(outcomes.length, 2);
  assert.equal(outcomes[0]?.state, "outcome_unknown");
  assert.equal(first.store.readByInvocation("second")?.state, "cleaned");
  assert.ok(
    first.outputs.calls.includes(
      `reopen:${first.store.readByInvocation("second")?.outputOwnerId}`,
    ),
  );
});

test("recovery reports a corrupt first SQLite row and still reconciles the later valid row", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-runtime-corrupt-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, "process.sqlite");
  const stateKey = new Uint8Array(32).fill(5);
  const backend = new Backend();
  const clock = new Clock();
  const outputs = new Outputs();
  outputs.prepareGate = new Promise(() => undefined);
  const registry = backendRegistry(backend);
  const environments = createChildEnvironmentFactory({
    credentialResolver: {
      consume: () => {
        throw new Error("unused");
      },
    },
    now: () => clock.now(),
  });
  const composed = createSubprocessRuntimeKernel({
    registry,
    state: { kind: "sqlite", path },
    stateKey,
    clock,
    environments,
    outputs,
    createLogicalProcessId: (id) => `proc-${id}`,
  });
  composed.grantsController.issue(grantValue("first"));
  composed.grantsController.issue(grantValue("second"));
  void composed.runtime.invoke({
    intent: intent("first"),
    grantId: "grant-first",
    ambientEnvironment: {},
  });
  void composed.runtime.invoke({
    intent: intent("second"),
    grantId: "grant-second",
    ambientEnvironment: {},
  });
  assert.deepEqual(composed.readOnlyStore.listRowIds(), ["first", "second"]);
  composed.readOnlyStore.close();
  const raw = new DatabaseSync(path);
  raw
    .prepare(
      "UPDATE durable_processes SET record_json = ? WHERE invocation_id = ?",
    )
    .run("{}", "first");
  raw.close();
  outputs.calls.length = 0;
  outputs.prepareGate = undefined;
  clock.current = new Date(clock.current.getTime() + 301_000);
  const recovery = createSubprocessRuntimeKernel({
    registry,
    state: { kind: "sqlite", path },
    stateKey,
    clock,
    environments,
    outputs,
    createLogicalProcessId: (id) => `proc-${id}`,
  });
  const outcomes = await recovery.runtime.reconcileStartup();
  assert.deepEqual(outcomes, [
    { invocationId: "first", state: "corrupt" },
    { invocationId: "second", state: "launch_not_proven" },
  ]);
  assert.ok(outputs.calls.includes("prepare:output-proc-second"));
  recovery.readOnlyStore.close();
});

test("exhaustive durable-state by reconcile-outcome matrix is fail-closed", async () => {
  for (const [state, want] of [
    ["prepared", "launch_not_proven"],
    ["launching", "orphaned"],
    ["exited", "cleaned"],
    ["verifying_empty", "cleaned"],
  ] as const) {
    const f = fixture();
    await seedRecoverable(f, state);
    f.outputs.prepareGate = undefined;
    f.outputs.finalizeGate = undefined;
    f.backend.launchGate = undefined;
    f.backend.observeGate = undefined;
    f.backend.verifyGate = undefined;
    if (state === "launching")
      f.clock.current = new Date(f.clock.current.getTime() + 301_000);
    await f.runtime.reconcileStartup();
    assert.equal(f.store.readByInvocation("invoke-1")?.state, want, `${state}`);
  }
  const outcomes = [
    { value: { state: "running" }, want: "cleaned" },
    { value: { state: "exited", exitCode: 0 }, want: "cleaned" },
    { value: { state: "identity_mismatch" }, want: "identity_mismatch" },
    { value: { state: "outcome_unknown" }, want: "outcome_unknown" },
    { value: new Proxy({}, {}), want: "outcome_unknown" },
  ] as const;
  for (const state of ["running", "stopping", "backend_unavailable"] as const) {
    for (const outcome of outcomes) {
      const f = fixture();
      await seedRecoverable(f, state);
      f.outputs.prepareGate = undefined;
      f.outputs.finalizeGate = undefined;
      f.backend.launchGate = undefined;
      f.backend.observeGate = undefined;
      f.backend.verifyGate = undefined;
      f.backend.reconcileValue = outcome.value;
      f.backend.observeValue = { state: "exited", exitCode: 0 };
      f.backend.signalValues = [{ state: "exited" }];
      await f.runtime.reconcileStartup();
      assert.equal(
        f.store.readByInvocation("invoke-1")?.state,
        outcome.want,
        `${state}/${outcome.want}`,
      );
    }
  }
});
