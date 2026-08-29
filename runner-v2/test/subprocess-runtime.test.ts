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
  reopenGate?: Promise<void>;
  writeGate?: Promise<void>;
  finalizeGate?: Promise<void>;
  finalizeValue?: unknown;
  onReopen?: () => void;
  onWrite?: () => void;
  onFinalize?: () => void;
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
    this.onReopen?.();
    await this.reopenGate;
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
        this.onWrite?.();
        await this.writeGate;
        this.chunks.push(Buffer.from(bytes).toString());
      },
      finalize: async (fence?: unknown) => {
        this.calls.push(`finalize:${ownerId}`);
        this.fences.push(fence);
        this.onFinalize?.();
        await this.finalizeGate;
        if (this.failFinalizeFor.has(ownerId))
          throw new Error("finalize failed");
        if (this.finalizeValue !== undefined) return this.finalizeValue as never;
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
  reconcileGate?: Promise<void>;
  signalGate?: Promise<void>;
  releaseGate?: Promise<void>;
  onSignal?: (action: string) => void;
  onObserve?: () => void;
  onVerify?: () => void;
  onReconcile?: () => void;
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
    this.onObserve?.();
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
    await this.signalGate;
    return this.signalValues.shift() ?? { state: "exited" };
  };
  verifyEmpty = async (_binding?: unknown, fence?: unknown) => {
    this.calls.push("verify");
    this.fences.push(fence);
    this.onVerify?.();
    await this.verifyGate;
    return this.verifyValue;
  };
  reconcile = async (_binding?: unknown, fence?: unknown) => {
    this.calls.push("reconcile");
    this.fences.push(fence);
    this.onReconcile?.();
    await this.reconcileGate;
    return this.reconcileValue;
  };
  release = async (_binding?: unknown, fence?: unknown) => {
    this.calls.push("release");
    this.fences.push(fence);
    this.onRelease?.();
    await this.releaseGate;
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
function pendingEffectOf(record: unknown):
  | { family: string; phase: string; fencingToken: number }
  | undefined {
  const value = record as {
    pendingEffect?: { family: string; phase: string; fencingToken: number };
    pendingEffects?: readonly {
      family: string;
      phase: string;
      fencingToken: number;
    }[];
  };
  return value.pendingEffects?.[0] ?? value.pendingEffect;
}
function pendingEffectsOf(record: unknown): readonly {
  family: string;
  phase: string;
  fencingToken: number;
}[] {
  const value = record as {
    pendingEffects?: readonly {
      family: string;
      phase: string;
      fencingToken: number;
    }[];
    pendingEffect?: {
      family: string;
      phase: string;
      fencingToken: number;
    };
  };
  return value.pendingEffects ?? (value.pendingEffect ? [value.pendingEffect] : []);
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
  leaseOptions: {
    readonly leaseDurationMs?: number;
    readonly leaseHeartbeatMs?: number;
  } = {},
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
    ...leaseOptions,
  });
  composed.grantsController.issue(grantValue());
  return composed;
}

async function durableLaunchBlocker(
  t: { after(callback: () => Promise<void>): void },
  suffix = "blocked",
  leaseOptions: {
    readonly leaseDurationMs?: number;
    readonly leaseHeartbeatMs?: number;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), `runner-v2-${suffix}-`));
  const path = join(root, "process.sqlite");
  const stateKey = new Uint8Array(32).fill(7);
  const backend = new Backend();
  const clock = new Clock();
  const outputs = new Outputs();
  const first = runtimeFor(
    { kind: "sqlite", path },
    stateKey,
    backend,
    clock,
    outputs,
    leaseOptions,
  );
  t.after(async () => {
    try {
      first.readOnlyStore.close();
    } catch {}
    await rm(root, { recursive: true, force: true });
  });
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
  return { path, stateKey, backend, clock, outputs, blockerDetail, first };
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
  const liveFence = record.fencingToken;
  const liveTakeovers = record.mutations.filter(
    (mutation) => mutation.kind === "takeover_lease",
  ).length;
  f.clock.current = new Date(f.clock.current.getTime() + 1_000);

  const retry = await f.runtime.invoke({
    intent: intent(),
    grantId: "grant-invoke-1",
    ambientEnvironment: {},
  });
  assert.equal(retry.outcome, "cleanup_failed");
  const afterLiveRetry = f.store.readByInvocation("invoke-1")!;
  assert.equal(afterLiveRetry.fencingToken, liveFence);
  assert.ok(
    Date.parse(afterLiveRetry.leaseExpiresAt) > Date.parse(record.leaseExpiresAt),
  );
  assert.ok(
    afterLiveRetry.mutations
      .slice(record.mutations.length)
      .some((mutation) => mutation.kind === "renew_lease"),
  );
  assert.equal(
    afterLiveRetry.mutations.filter(
      (mutation) => mutation.kind === "takeover_lease",
    ).length,
    liveTakeovers,
  );
  assert.equal(f.backend.calls.filter((call) => call === "launch").length, 1);
});

test("restart reattests a live launch blocker and retry never relaunches", async (t) => {
  const f = await durableLaunchBlocker(t);
  const expired = f.first.readOnlyStore.readByInvocation("invoke-1")!;
  f.clock.current = new Date(f.clock.current.getTime() + 301_000);
  f.backend.reconcileValue = { state: "running" };
  const recovery = runtimeFor({ kind: "sqlite", path: f.path }, f.stateKey, f.backend, f.clock, f.outputs);

  assert.deepEqual(await recovery.runtime.reconcileStartup(), [
    { invocationId: "invoke-1", state: "cleanup_blocked" },
  ]);
  const blocked = recovery.readOnlyStore.readByInvocation("invoke-1");
  assert.equal(blocked?.cleanup.state, "failed");
  assert.notEqual(blocked?.ownerId, expired.ownerId);
  assert.equal(blocked?.fencingToken, expired.fencingToken + 1);
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

test("expired same-owner retry advances its durable fence before effects and heartbeats across takeover attempts", async (t) => {
  const f = await durableLaunchBlocker(t, "same-owner-retry", {
    leaseDurationMs: 40,
    leaseHeartbeatMs: 10,
  });
  const expired = f.first.readOnlyStore.readByInvocation("invoke-1")!;
  f.clock.current = new Date(f.clock.current.getTime() + 41);
  f.backend.reconcileValue = { state: "exited", exitCode: 0 };
  f.backend.verifyValue = { empty: true, proofArtifactId: "same-owner-retry" };
  const gate = deferred();
  const started = deferred();
  const outputFenceStart = f.outputs.fences.length;
  const backendFenceStart = f.backend.fences.length;
  f.backend.reconcileGate = gate.promise;
  f.backend.onReconcile = started.resolve;
  const retry = f.first.runtime.invoke({
    intent: intent(),
    grantId: "grant-invoke-1",
    ambientEnvironment: {},
  });
  let contender: ReturnType<typeof createSubprocessRuntimeKernel> | undefined;
  try {
    await started.promise;
    const active = f.first.readOnlyStore.readByInvocation("invoke-1")!;
    assert.equal(active.ownerId, expired.ownerId);
    assert.equal(active.fencingToken, expired.fencingToken + 1);
    assert.ok(Date.parse(active.leaseExpiresAt) > f.clock.now().getTime());
    assert.equal(
      active.mutations.find(
        (mutation) => mutation.fencingToken === active.fencingToken,
      )?.kind,
      "takeover_lease",
    );
    assert.ok(f.outputs.fences.length > outputFenceStart);
    assert.ok(f.backend.fences.length > backendFenceStart);
    assert.ok(
      [...f.outputs.fences.slice(outputFenceStart), ...f.backend.fences.slice(backendFenceStart)].every(
        (fence) =>
          (fence as { fencingToken?: number } | undefined)?.fencingToken ===
          active.fencingToken,
      ),
    );

    f.clock.current = new Date(f.clock.current.getTime() + 50);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const heartbeated = f.first.readOnlyStore.readByInvocation("invoke-1")!;
    assert.equal(heartbeated.fencingToken, active.fencingToken);
    assert.ok(Date.parse(heartbeated.leaseExpiresAt) > f.clock.now().getTime());

    const contenderBackend = new Backend();
    const contenderOutputs = new Outputs();
    contender = runtimeFor(
      { kind: "sqlite", path: f.path },
      f.stateKey,
      contenderBackend,
      f.clock,
      contenderOutputs,
      { leaseDurationMs: 40, leaseHeartbeatMs: 10 },
    );
    assert.deepEqual(await contender.runtime.reconcileStartup(), [
      { invocationId: "invoke-1", state: "effect_outcome_unresolved" },
    ]);
    assert.deepEqual(contenderBackend.calls, []);
    assert.deepEqual(contenderOutputs.calls, []);
  } finally {
    gate.resolve();
  }
  assert.equal((await retry).outcome, "exited");
  assert.equal(
    f.backend.calls.filter((call) => call === "release").length,
    1,
  );
  assert.equal(
    f.outputs.calls.filter((call) => call.startsWith("finalize:")).length,
    1,
  );
  assert.equal(
    f.outputs.calls.filter((call) => call.startsWith("cleanup:")).length,
    0,
  );
  contender?.readOnlyStore.close();
});

test("expired same-owner cancellation advances its durable fence before a blocked signal and prevents takeover", async (t) => {
  const f = await durableLaunchBlocker(t, "same-owner-cancel", {
    leaseDurationMs: 40,
    leaseHeartbeatMs: 10,
  });
  const expired = f.first.readOnlyStore.readByInvocation("invoke-1")!;
  f.clock.current = new Date(f.clock.current.getTime() + 41);
  f.backend.reconcileValue = { state: "running" };
  f.backend.verifyValue = { empty: true, proofArtifactId: "same-owner-cancel" };
  f.backend.signalValues = [{ state: "exited" }];
  const gate = deferred();
  const started = deferred();
  const outputFenceStart = f.outputs.fences.length;
  const backendFenceStart = f.backend.fences.length;
  f.backend.signalGate = gate.promise;
  f.backend.onSignal = () => {
    f.backend.reconcileValue = { state: "exited", signal: "SIGINT" };
    started.resolve();
  };
  const cancellation = f.first.runtime.cancel("invoke-1");
  let contender: ReturnType<typeof createSubprocessRuntimeKernel> | undefined;
  try {
    await started.promise;
    const active = f.first.readOnlyStore.readByInvocation("invoke-1")!;
    assert.equal(active.ownerId, expired.ownerId);
    assert.equal(active.fencingToken, expired.fencingToken + 1);
    assert.ok(Date.parse(active.leaseExpiresAt) > f.clock.now().getTime());
    assert.equal(
      active.mutations.find(
        (mutation) => mutation.fencingToken === active.fencingToken,
      )?.kind,
      "takeover_lease",
    );
    assert.ok(f.outputs.fences.length > outputFenceStart);
    assert.ok(f.backend.fences.length > backendFenceStart);
    assert.ok(
      [...f.outputs.fences.slice(outputFenceStart), ...f.backend.fences.slice(backendFenceStart)].every(
        (fence) =>
          (fence as { fencingToken?: number } | undefined)?.fencingToken ===
          active.fencingToken,
      ),
    );

    f.clock.current = new Date(f.clock.current.getTime() + 50);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const heartbeated = f.first.readOnlyStore.readByInvocation("invoke-1")!;
    assert.ok(Date.parse(heartbeated.leaseExpiresAt) > f.clock.now().getTime());

    const contenderBackend = new Backend();
    const contenderOutputs = new Outputs();
    contender = runtimeFor(
      { kind: "sqlite", path: f.path },
      f.stateKey,
      contenderBackend,
      f.clock,
      contenderOutputs,
      { leaseDurationMs: 40, leaseHeartbeatMs: 10 },
    );
    assert.deepEqual(await contender.runtime.reconcileStartup(), [
      { invocationId: "invoke-1", state: "effect_outcome_unresolved" },
    ]);
    assert.deepEqual(contenderBackend.calls, []);
    assert.deepEqual(contenderOutputs.calls, []);
  } finally {
    gate.resolve();
  }
  assert.equal(await cancellation, true);
  assert.deepEqual(
    f.backend.calls.filter((call) => call.startsWith("signal:")),
    ["signal:interrupt"],
  );
  assert.equal(
    f.backend.calls.filter((call) => call === "release").length,
    1,
  );
  assert.equal(
    f.outputs.calls.filter((call) => call.startsWith("finalize:")).length,
    1,
  );
  assert.equal(
    f.outputs.calls.filter((call) => call.startsWith("cleanup:")).length,
    0,
  );
  contender?.readOnlyStore.close();
});

test("durable in-flight reconciliation blocks takeover effects after heartbeat authority loss", async (t) => {
  const f = await durableLaunchBlocker(t, "same-owner-fence-loss", {
    leaseDurationMs: 40,
    leaseHeartbeatMs: 10,
  });
  const expired = f.first.readOnlyStore.readByInvocation("invoke-1")!;
  f.clock.current = new Date(f.clock.current.getTime() + 41);
  f.backend.reconcileValue = { state: "exited", exitCode: 0 };
  const gate = deferred();
  const started = deferred();
  f.backend.reconcileGate = gate.promise;
  f.backend.onReconcile = started.resolve;
  const stale = f.first.runtime.invoke({
    intent: intent(),
    grantId: "grant-invoke-1",
    ambientEnvironment: {},
  });
  await started.promise;
  const active = f.first.readOnlyStore.readByInvocation("invoke-1")!;
  assert.equal(active.fencingToken, expired.fencingToken + 1);
  f.first.readOnlyStore.close();
  f.clock.current = new Date(f.clock.current.getTime() + 50);
  await new Promise((resolve) => setTimeout(resolve, 40));

  const takeoverBackend = new Backend();
  takeoverBackend.reconcileValue = { state: "exited", exitCode: 0 };
  takeoverBackend.verifyValue = {
    empty: true,
    proofArtifactId: "heartbeat-failure-takeover",
  };
  const takeoverOutputs = new Outputs();
  const takeover = runtimeFor(
    { kind: "sqlite", path: f.path },
    f.stateKey,
    takeoverBackend,
    f.clock,
    takeoverOutputs,
    { leaseDurationMs: 40, leaseHeartbeatMs: 10 },
  );
  assert.deepEqual(await takeover.runtime.reconcileStartup(), [
    { invocationId: "invoke-1", state: "effect_outcome_unresolved" },
  ]);
  const blocked = takeover.readOnlyStore.readByInvocation("invoke-1")!;
  assert.equal(blocked.fencingToken, active.fencingToken);
  assert.equal(blocked.ownerId, active.ownerId);
  const pendingEffect = pendingEffectOf(blocked);
  assert.equal(pendingEffect?.family, "backend_reconcile");
  assert.equal(pendingEffect?.phase, "started");
  assert.equal(pendingEffect?.fencingToken, active.fencingToken);
  assert.deepEqual(takeoverBackend.calls, []);
  assert.deepEqual(takeoverOutputs.calls, []);
  assert.equal(await takeover.runtime.cancel("invoke-1"), false);
  assert.equal(
    (
      await takeover.runtime.invoke({
        intent: intent(),
        grantId: "grant-invoke-1",
        ambientEnvironment: {},
      })
    ).outcome,
    "cleanup_failed",
  );
  assert.deepEqual(await takeover.runtime.reconcileStartup(), [
    { invocationId: "invoke-1", state: "effect_outcome_unresolved" },
  ]);
  assert.deepEqual(takeoverBackend.calls, []);
  assert.deepEqual(takeoverOutputs.calls, []);
  const committedRevision = blocked.revision;

  gate.resolve();
  await assert.rejects(stale, /owner|fenc|stale|database|closed/i);
  const afterStale = takeover.readOnlyStore.readByInvocation("invoke-1")!;
  assert.equal(afterStale.revision, committedRevision);
  assert.equal(afterStale.state, "cleanup_blocked");
  assert.equal(f.backend.calls.filter((call) => call === "release").length, 0);
  assert.equal(
    f.outputs.calls.filter((call) => call.startsWith("finalize:")).length,
    0,
  );
  assert.deepEqual(takeoverBackend.calls, []);
  assert.deepEqual(takeoverOutputs.calls, []);
  assert.equal(
    [...f.outputs.calls, ...takeoverOutputs.calls].filter((call) =>
      call.startsWith("cleanup:"),
    ).length,
    0,
  );
  takeover.readOnlyStore.close();
});

test("durable in-flight signal blocks takeover effects after heartbeat authority loss", async (t) => {
  const f = await durableLaunchBlocker(t, "signal-fence-loss", {
    leaseDurationMs: 40,
    leaseHeartbeatMs: 10,
  });
  f.clock.current = new Date(f.clock.current.getTime() + 41);
  f.backend.reconcileValue = { state: "running" };
  f.backend.signalValues = [{ state: "exited" }];
  const gate = deferred();
  const started = deferred();
  f.backend.signalGate = gate.promise;
  f.backend.onSignal = () => started.resolve();
  const cancellation = f.first.runtime.cancel("invoke-1");
  await started.promise;
  const active = f.first.readOnlyStore.readByInvocation("invoke-1")!;
  f.first.readOnlyStore.close();
  f.clock.current = new Date(f.clock.current.getTime() + 50);
  await new Promise((resolve) => setTimeout(resolve, 40));

  const backend = new Backend();
  const outputs = new Outputs();
  const contender = runtimeFor(
    { kind: "sqlite", path: f.path },
    f.stateKey,
    backend,
    f.clock,
    outputs,
    { leaseDurationMs: 40, leaseHeartbeatMs: 10 },
  );
  try {
    assert.deepEqual(await contender.runtime.reconcileStartup(), [
      { invocationId: "invoke-1", state: "effect_outcome_unresolved" },
    ]);
    const blocked = contender.readOnlyStore.readByInvocation("invoke-1")!;
    assert.equal(blocked.ownerId, active.ownerId);
    assert.equal(blocked.fencingToken, active.fencingToken);
    assert.equal(pendingEffectOf(blocked)?.family, "backend_signal");
    assert.equal(pendingEffectOf(blocked)?.phase, "started");
    assert.deepEqual(backend.calls, []);
    assert.deepEqual(outputs.calls, []);
  } finally {
    gate.resolve();
  }
  assert.equal(await cancellation, false);
  const after = contender.readOnlyStore.readByInvocation("invoke-1")!;
  assert.equal(after.revision, active.revision);
  assert.equal(pendingEffectOf(after)?.phase, "started");
  assert.deepEqual(backend.calls, []);
  assert.deepEqual(outputs.calls, []);
  contender.readOnlyStore.close();
});

test("durable in-flight output finalization blocks takeover and duplicate release", async (t) => {
  const f = await durableLaunchBlocker(t, "finalize-fence-loss", {
    leaseDurationMs: 40,
    leaseHeartbeatMs: 10,
  });
  f.clock.current = new Date(f.clock.current.getTime() + 41);
  f.backend.reconcileValue = { state: "exited", exitCode: 0 };
  f.backend.verifyValue = { empty: true, proofArtifactId: "finalize-proof" };
  const gate = deferred();
  const started = deferred();
  f.outputs.finalizeGate = gate.promise;
  f.outputs.onFinalize = started.resolve;
  const retry = f.first.runtime.invoke({
    intent: intent(),
    grantId: "grant-invoke-1",
    ambientEnvironment: {},
  });
  const retryOutcome = retry.then(
    () => undefined,
    (error: unknown) => error,
  );
  await started.promise;
  f.first.readOnlyStore.close();
  f.clock.current = new Date(f.clock.current.getTime() + 50);
  await new Promise((resolve) => setTimeout(resolve, 40));

  const backend = new Backend();
  backend.reconcileValue = { state: "exited", exitCode: 0 };
  const outputs = new Outputs();
  const contender = runtimeFor(
    { kind: "sqlite", path: f.path },
    f.stateKey,
    backend,
    f.clock,
    outputs,
    { leaseDurationMs: 40, leaseHeartbeatMs: 10 },
  );
  try {
    assert.deepEqual(await contender.runtime.reconcileStartup(), [
      { invocationId: "invoke-1", state: "effect_outcome_unresolved" },
    ]);
    const blocked = contender.readOnlyStore.readByInvocation("invoke-1")!;
    assert.equal(pendingEffectOf(blocked)?.family, "output_finalize");
    assert.equal(pendingEffectOf(blocked)?.phase, "started");
    assert.deepEqual(backend.calls, []);
    assert.deepEqual(outputs.calls, []);
  } finally {
    gate.resolve();
    contender.readOnlyStore.close();
  }
  assert.match(String(await retryOutcome), /owner|fenc|stale|database|closed/i);
  assert.equal(f.outputs.calls.filter((call) => call.startsWith("finalize:")).length, 1);
  assert.equal(f.backend.calls.filter((call) => call === "release").length, 0);
  assert.deepEqual(backend.calls, []);
  assert.deepEqual(outputs.calls, []);
});

test("durable in-flight backend release blocks takeover and duplicate release", async (t) => {
  const f = await durableLaunchBlocker(t, "release-fence-loss", {
    leaseDurationMs: 40,
    leaseHeartbeatMs: 10,
  });
  f.clock.current = new Date(f.clock.current.getTime() + 41);
  f.backend.reconcileValue = { state: "exited", exitCode: 0 };
  f.backend.verifyValue = { empty: true, proofArtifactId: "release-proof" };
  const gate = deferred();
  const started = deferred();
  f.backend.releaseGate = gate.promise;
  f.backend.onRelease = started.resolve;
  const retry = f.first.runtime.invoke({
    intent: intent(),
    grantId: "grant-invoke-1",
    ambientEnvironment: {},
  });
  const retryOutcome = retry.then(
    () => undefined,
    (error: unknown) => error,
  );
  await started.promise;
  f.first.readOnlyStore.close();
  f.clock.current = new Date(f.clock.current.getTime() + 50);
  await new Promise((resolve) => setTimeout(resolve, 40));

  const backend = new Backend();
  backend.reconcileValue = { state: "exited", exitCode: 0 };
  const outputs = new Outputs();
  const contender = runtimeFor(
    { kind: "sqlite", path: f.path },
    f.stateKey,
    backend,
    f.clock,
    outputs,
    { leaseDurationMs: 40, leaseHeartbeatMs: 10 },
  );
  try {
    assert.deepEqual(await contender.runtime.reconcileStartup(), [
      { invocationId: "invoke-1", state: "effect_outcome_unresolved" },
    ]);
    const blocked = contender.readOnlyStore.readByInvocation("invoke-1")!;
    assert.equal(pendingEffectOf(blocked)?.family, "backend_release");
    assert.equal(pendingEffectOf(blocked)?.phase, "started");
    assert.deepEqual(backend.calls, []);
    assert.deepEqual(outputs.calls, []);
  } finally {
    gate.resolve();
    contender.readOnlyStore.close();
  }
  assert.match(String(await retryOutcome), /owner|fenc|stale|database|closed/i);
  assert.equal(f.backend.calls.filter((call) => call === "release").length, 1);
  assert.deepEqual(backend.calls, []);
  assert.deepEqual(outputs.calls, []);
});

test("durable recovery output reopen blocks takeover before any contender effect", async (t) => {
  const f = await durableLaunchBlocker(t, "reopen-fence-loss", {
    leaseDurationMs: 40,
    leaseHeartbeatMs: 10,
  });
  f.clock.current = new Date(f.clock.current.getTime() + 41);
  const gate = deferred();
  const started = deferred();
  f.outputs.reopenGate = gate.promise;
  f.outputs.onReopen = started.resolve;
  const retry = f.first.runtime.invoke({
    intent: intent(),
    grantId: "grant-invoke-1",
    ambientEnvironment: {},
  });
  const retryOutcome = retry.then(
    () => undefined,
    (error: unknown) => error,
  );
  await started.promise;
  const active = f.first.readOnlyStore.readByInvocation("invoke-1")!;
  f.first.readOnlyStore.close();
  f.clock.current = new Date(f.clock.current.getTime() + 50);
  await new Promise((resolve) => setTimeout(resolve, 40));

  const backend = new Backend();
  const outputs = new Outputs();
  const contender = runtimeFor(
    { kind: "sqlite", path: f.path },
    f.stateKey,
    backend,
    f.clock,
    outputs,
    { leaseDurationMs: 40, leaseHeartbeatMs: 10 },
  );
  try {
    assert.deepEqual(await contender.runtime.reconcileStartup(), [
      { invocationId: "invoke-1", state: "effect_outcome_unresolved" },
    ]);
    const blocked = contender.readOnlyStore.readByInvocation("invoke-1")!;
    assert.deepEqual(
      pendingEffectsOf(blocked).map(({ family, phase }) => ({ family, phase })),
      [{ family: "output_reopen", phase: "started" }],
    );
    assert.equal(blocked.ownerId, active.ownerId);
    assert.deepEqual(backend.calls, []);
    assert.deepEqual(outputs.calls, []);
  } finally {
    gate.resolve();
    contender.readOnlyStore.close();
  }
  assert.match(String(await retryOutcome), /owner|fenc|stale|database|closed/i);
  assert.deepEqual(backend.calls, []);
  assert.deepEqual(outputs.calls, []);
});

test("durable recovery observation covers blocked output writes and blocks takeover", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-observe-write-fence-loss-"));
  const path = join(root, "process.sqlite");
  const stateKey = new Uint8Array(32).fill(7);
  const backendA = new Backend();
  const clock = new Clock();
  const outputsA = new Outputs();
  const runtimeA = runtimeFor({ kind: "sqlite", path }, stateKey, backendA, clock, outputsA, {
    leaseDurationMs: 40,
    leaseHeartbeatMs: 10,
  });
  t.after(async () => {
    try {
      runtimeA.readOnlyStore.close();
    } catch {}
    await rm(root, { recursive: true, force: true });
  });
  const gate = deferred();
  const started = deferred();
  let effectsDuringWrite: readonly { family: string; phase: string }[] = [];
  backendA.observeGate = gate.promise;
  outputsA.onWrite = () => {
    effectsDuringWrite = pendingEffectsOf(
      runtimeA.readOnlyStore.readByInvocation("invoke-1"),
    ).map(({ family, phase }) => ({ family, phase }));
    started.resolve();
  };
  const retry = runtimeA.runtime.invoke({
    intent: intent(),
    grantId: "grant-invoke-1",
    ambientEnvironment: {},
  });
  const retryOutcome = retry.then(
    () => undefined,
    (error: unknown) => error,
  );
  await started.promise;
  assert.deepEqual(effectsDuringWrite, [
    { family: "backend_observe", phase: "started" },
  ]);
  runtimeA.readOnlyStore.close();
  clock.current = new Date(clock.current.getTime() + 50);
  await new Promise((resolve) => setTimeout(resolve, 40));

  const backend = new Backend();
  const outputs = new Outputs();
  const contender = runtimeFor(
    { kind: "sqlite", path },
    stateKey,
    backend,
    clock,
    outputs,
    { leaseDurationMs: 40, leaseHeartbeatMs: 10 },
  );
  try {
    assert.deepEqual(await contender.runtime.reconcileStartup(), [
      { invocationId: "invoke-1", state: "effect_outcome_unresolved" },
    ]);
    const blocked = contender.readOnlyStore.readByInvocation("invoke-1")!;
    assert.deepEqual(
      pendingEffectsOf(blocked).map(({ family, phase }) => ({ family, phase })),
      [{ family: "backend_observe", phase: "started" }],
    );
    assert.deepEqual(backend.calls, []);
    assert.deepEqual(outputs.calls, []);
  } finally {
    gate.resolve();
    contender.readOnlyStore.close();
  }
  assert.match(String(await retryOutcome), /owner|fenc|stale|database|closed/i);
  assert.deepEqual(backend.calls, []);
  assert.deepEqual(outputs.calls, []);
});

test("durable verified-empty inspection blocks takeover and duplicate cleanup effects", async (t) => {
  const f = await durableLaunchBlocker(t, "verify-empty-fence-loss", {
    leaseDurationMs: 40,
    leaseHeartbeatMs: 10,
  });
  f.clock.current = new Date(f.clock.current.getTime() + 41);
  f.backend.reconcileValue = { state: "exited", exitCode: 0 };
  const gate = deferred();
  const started = deferred();
  f.backend.verifyGate = gate.promise;
  f.backend.onVerify = started.resolve;
  const retry = f.first.runtime.invoke({
    intent: intent(),
    grantId: "grant-invoke-1",
    ambientEnvironment: {},
  });
  const retryOutcome = retry.then(
    () => undefined,
    (error: unknown) => error,
  );
  await started.promise;
  f.first.readOnlyStore.close();
  f.clock.current = new Date(f.clock.current.getTime() + 50);
  await new Promise((resolve) => setTimeout(resolve, 40));

  const backend = new Backend();
  const outputs = new Outputs();
  const contender = runtimeFor(
    { kind: "sqlite", path: f.path },
    f.stateKey,
    backend,
    f.clock,
    outputs,
    { leaseDurationMs: 40, leaseHeartbeatMs: 10 },
  );
  try {
    assert.deepEqual(await contender.runtime.reconcileStartup(), [
      { invocationId: "invoke-1", state: "effect_outcome_unresolved" },
    ]);
    const blocked = contender.readOnlyStore.readByInvocation("invoke-1")!;
    assert.deepEqual(
      pendingEffectsOf(blocked).map(({ family, phase }) => ({ family, phase })),
      [{ family: "backend_verify_empty", phase: "started" }],
    );
    assert.deepEqual(backend.calls, []);
    assert.deepEqual(outputs.calls, []);
  } finally {
    gate.resolve();
    contender.readOnlyStore.close();
  }
  assert.match(String(await retryOutcome), /owner|fenc|stale|database|closed/i);
  assert.equal(f.backend.calls.filter((call) => call === "release").length, 0);
  assert.deepEqual(backend.calls, []);
  assert.deepEqual(outputs.calls, []);
});

test("same owner consumes signal before observe without losing either journal marker", async () => {
  const f = fixture();
  const observeGate = deferred();
  const observeStarted = deferred();
  const signalGate = deferred();
  const signalStarted = deferred();
  f.backend.observeGate = observeGate.promise;
  f.backend.onObserve = observeStarted.resolve;
  f.backend.signalGate = signalGate.promise;
  f.backend.onSignal = () => signalStarted.resolve();
  const invocation = f.runtime.invoke({
    intent: intent(),
    grantId: "grant-invoke-1",
    ambientEnvironment: {},
  });
  await observeStarted.promise;
  const cancellation = f.runtime.cancel("invoke-1");
  await signalStarted.promise;
  const duplicateCancellation = f.runtime.cancel("invoke-1");
  try {
    assert.deepEqual(
      pendingEffectsOf(f.store.readByInvocation("invoke-1")).map(
        ({ family, phase }) => ({ family, phase }),
      ),
      [
        { family: "backend_observe", phase: "started" },
        { family: "backend_signal", phase: "started" },
      ],
    );
    assert.equal(
      f.backend.calls.filter((call) => call.startsWith("signal:")).length,
      1,
    );
  } finally {
    signalGate.resolve();
    await cancellation;
    observeGate.resolve();
  }
  const [cancelled, duplicateCancelled, result] = await Promise.all([
    cancellation,
    duplicateCancellation,
    invocation,
  ]);
  assert.equal(cancelled, true);
  assert.equal(duplicateCancelled, false);
  assert.equal(result.outcome, "cancelled");
  assert.deepEqual(pendingEffectsOf(f.store.readByInvocation("invoke-1")), []);
});

test("same owner consumes observe before signal without stranding the exact signal marker", async () => {
  const f = fixture();
  const observeGate = deferred();
  const observeStarted = deferred();
  const signalGate = deferred();
  const signalStarted = deferred();
  const finalizeGate = deferred();
  const finalizeStarted = deferred();
  f.backend.observeGate = observeGate.promise;
  f.backend.onObserve = observeStarted.resolve;
  f.backend.signalGate = signalGate.promise;
  f.backend.onSignal = () => signalStarted.resolve();
  f.outputs.finalizeGate = finalizeGate.promise;
  f.outputs.onFinalize = finalizeStarted.resolve;
  const invocation = f.runtime.invoke({
    intent: intent(),
    grantId: "grant-invoke-1",
    ambientEnvironment: {},
  });
  await observeStarted.promise;
  const cancellation = f.runtime.cancel("invoke-1");
  await signalStarted.promise;
  observeGate.resolve();
  await finalizeStarted.promise;
  try {
    const exited = f.store.readByInvocation("invoke-1")!;
    assert.equal(exited.state, "exited");
    assert.deepEqual(
      pendingEffectsOf(exited).map(({ family, phase }) => ({ family, phase })),
      [
        { family: "backend_signal", phase: "started" },
        { family: "output_finalize", phase: "started" },
      ],
    );
    signalGate.resolve();
    assert.equal(await cancellation, true);
    assert.deepEqual(
      pendingEffectsOf(f.store.readByInvocation("invoke-1")).map(
        ({ family, phase }) => ({ family, phase }),
      ),
      [{ family: "output_finalize", phase: "started" }],
    );
  } finally {
    signalGate.resolve();
    finalizeGate.resolve();
  }
  const result = await invocation;
  assert.equal(result.outcome, "cancelled");
  assert.deepEqual(pendingEffectsOf(f.store.readByInvocation("invoke-1")), []);
});

test("cancel denies every live same-owner family except one active observation", async (t) => {
  await t.test("output_reopen", async (t) => {
    const f = await durableLaunchBlocker(t, "cancel-deny-reopen");
    const gate = deferred();
    const started = deferred();
    f.outputs.reopenGate = gate.promise;
    f.outputs.onReopen = started.resolve;
    const retry = f.first.runtime.invoke({
      intent: intent(),
      grantId: "grant-invoke-1",
      ambientEnvironment: {},
    });
    await started.promise;
    const cancellation = f.first.runtime.cancel("invoke-1");
    try {
      await Promise.resolve();
      await Promise.resolve();
      assert.deepEqual(
        pendingEffectsOf(f.first.readOnlyStore.readByInvocation("invoke-1")).map(
          ({ family, phase }) => ({ family, phase }),
        ),
        [{ family: "output_reopen", phase: "started" }],
      );
      assert.equal(
        f.outputs.calls.filter((call) => call.startsWith("reopen:")).length,
        1,
      );
    } finally {
      gate.resolve();
    }
    const [, cancelled] = await Promise.allSettled([retry, cancellation]);
    assert.deepEqual(cancelled, { status: "fulfilled", value: false });
  });

  await t.test("backend_reconcile", async (t) => {
    const f = await durableLaunchBlocker(t, "cancel-deny-reconcile");
    const gate = deferred();
    const started = deferred();
    f.backend.reconcileGate = gate.promise;
    f.backend.onReconcile = started.resolve;
    const retry = f.first.runtime.invoke({
      intent: intent(),
      grantId: "grant-invoke-1",
      ambientEnvironment: {},
    });
    await started.promise;
    const cancellation = f.first.runtime.cancel("invoke-1");
    try {
      await Promise.resolve();
      await Promise.resolve();
      assert.deepEqual(
        pendingEffectsOf(f.first.readOnlyStore.readByInvocation("invoke-1")).map(
          ({ family, phase }) => ({ family, phase }),
        ),
        [{ family: "backend_reconcile", phase: "started" }],
      );
      assert.equal(
        f.backend.calls.filter((call) => call === "reconcile").length,
        2,
      );
    } finally {
      gate.resolve();
    }
    const [, cancelled] = await Promise.allSettled([retry, cancellation]);
    assert.deepEqual(cancelled, { status: "fulfilled", value: false });
  });

  await t.test("backend_verify_empty", async () => {
    const f = fixture();
    const gate = deferred();
    const started = deferred();
    const signalGate = deferred();
    f.backend.launchError = Object.assign(new Error("owned child remains"), {
      code: "native_process_launch_cleanup_blocked",
      launchResult: f.backend.launchValue,
    });
    f.backend.reconcileValue = { state: "running" };
    f.backend.verifyGate = gate.promise;
    f.backend.onVerify = started.resolve;
    f.backend.signalGate = signalGate.promise;
    const invocation = f.runtime.invoke({
      intent: intent(),
      grantId: "grant-invoke-1",
      ambientEnvironment: {},
    });
    await started.promise;
    const cancellation = f.runtime.cancel("invoke-1");
    try {
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(
        f.backend.calls.filter((call) => call.startsWith("signal:")).length,
        0,
      );
    } finally {
      signalGate.resolve();
      gate.resolve();
    }
    const [, cancelled] = await Promise.allSettled([invocation, cancellation]);
    assert.deepEqual(cancelled, { status: "fulfilled", value: false });
  });
});

test("cancel table rejects active finalize verify and release effects", async (t) => {
  for (const family of [
    "output_finalize",
    "backend_verify_empty",
    "backend_release",
  ] as const) {
    await t.test(family, async () => {
      const f = fixture();
      const gate = deferred();
      const started = deferred();
      if (family === "output_finalize") {
        f.outputs.finalizeGate = gate.promise;
        f.outputs.onFinalize = started.resolve;
      } else if (family === "backend_verify_empty") {
        f.backend.verifyGate = gate.promise;
        f.backend.onVerify = started.resolve;
      } else {
        f.backend.releaseGate = gate.promise;
        f.backend.onRelease = started.resolve;
      }
      const invocation = f.runtime.invoke({
        intent: intent(),
        grantId: "grant-invoke-1",
        ambientEnvironment: {},
      });
      await started.promise;
      try {
        assert.equal(await f.runtime.cancel("invoke-1"), false);
        assert.deepEqual(
          pendingEffectsOf(f.store.readByInvocation("invoke-1")).map(
            ({ family: activeFamily, phase }) => ({
              family: activeFamily,
              phase,
            }),
          ),
          [{ family, phase: "started" }],
        );
        assert.equal(
          f.backend.calls.filter((call) => call.startsWith("signal:")).length,
          0,
        );
      } finally {
        gate.resolve();
      }
      await invocation;
    });
  }
});

test("malformed successful journaled calls remain completed and cannot repeat on retry cancel or restart", async (t) => {
  const cases = [
    {
      name: "backend_observe",
      configure: (backend: Backend, _outputs: Outputs) => {
        backend.observeValue = { state: "not-an-observation" };
      },
      calls: (backend: Backend, _outputs: Outputs) =>
        backend.calls.filter((call) => call === "observe").length,
    },
    {
      name: "output_finalize",
      configure: (_backend: Backend, outputs: Outputs) => {
        outputs.finalizeValue = { streams: "not-output" };
      },
      calls: (_backend: Backend, outputs: Outputs) =>
        outputs.calls.filter((call) => call.startsWith("finalize:")).length,
    },
    {
      name: "backend_verify_empty",
      configure: (backend: Backend, _outputs: Outputs) => {
        backend.verifyValue = { empty: "not-boolean" };
      },
      calls: (backend: Backend, _outputs: Outputs) =>
        backend.calls.filter((call) => call === "verify").length,
    },
    {
      name: "backend_release",
      configure: (backend: Backend, _outputs: Outputs) => {
        backend.releaseValue = { released: "not-boolean" };
      },
      calls: (backend: Backend, _outputs: Outputs) =>
        backend.calls.filter((call) => call === "release").length,
    },
  ] as const;

  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const root = await mkdtemp(
        join(tmpdir(), `runner-v2-malformed-${scenario.name}-`),
      );
      const path = join(root, "process.sqlite");
      const stateKey = new Uint8Array(32).fill(11);
      const backend = new Backend();
      const outputs = new Outputs();
      const clock = new Clock();
      const first = runtimeFor(
        { kind: "sqlite", path },
        stateKey,
        backend,
        clock,
        outputs,
      );
      t.after(async () => {
        try {
          first.readOnlyStore.close();
        } catch {}
        await rm(root, { recursive: true, force: true });
      });
      scenario.configure(backend, outputs);
      await first.runtime
        .invoke({
          intent: intent(),
          grantId: "grant-invoke-1",
          ambientEnvironment: {},
        })
        .catch(() => undefined);
      const blocked = first.readOnlyStore.readByInvocation("invoke-1")!;
      assert.deepEqual(
        pendingEffectsOf(blocked).map(({ family, phase }) => ({ family, phase })),
        [{ family: scenario.name, phase: "completed" }],
      );
      const callCount = scenario.calls(backend, outputs);
      assert.equal(callCount, 1);
      assert.equal(await first.runtime.cancel("invoke-1"), false);
      first.grantsController.issue(grantValue());
      await first.runtime
        .invoke({
          intent: intent(),
          grantId: "grant-invoke-1",
          ambientEnvironment: {},
        })
        .catch(() => undefined);
      assert.equal(scenario.calls(backend, outputs), callCount);
      first.readOnlyStore.close();

      const restartedBackend = new Backend();
      const restartedOutputs = new Outputs();
      const restarted = runtimeFor(
        { kind: "sqlite", path },
        stateKey,
        restartedBackend,
        clock,
        restartedOutputs,
      );
      try {
        assert.deepEqual(await restarted.runtime.reconcileStartup(), [
          { invocationId: "invoke-1", state: "effect_outcome_unresolved" },
        ]);
        assert.equal(scenario.calls(restartedBackend, restartedOutputs), 0);
      } finally {
        restarted.readOnlyStore.close();
      }
    });
  }
});

test("raw journaled rejection remains started and blocks retry cancel and startup recovery", async () => {
  const f = fixture();
  f.outputs.failFinalizeFor.add("output-proc-invoke-1");
  const result = await f.runtime.invoke({
    intent: intent(),
    grantId: "grant-invoke-1",
    ambientEnvironment: {},
  });
  assert.equal(result.outcome, "cleanup_failed");
  assert.deepEqual(
    pendingEffectsOf(f.store.readByInvocation("invoke-1")).map(
      ({ family, phase }) => ({ family, phase }),
    ),
    [{ family: "output_finalize", phase: "started" }],
  );
  const finalizeCount = f.outputs.calls.filter((call) =>
    call.startsWith("finalize:"),
  ).length;
  assert.equal(finalizeCount, 1);
  assert.equal(await f.runtime.cancel("invoke-1"), false);
  f.grants.issue(grantValue());
  assert.equal(
    (
      await f.runtime.invoke({
        intent: intent(),
        grantId: "grant-invoke-1",
        ambientEnvironment: {},
      })
    ).outcome,
    "cleanup_failed",
  );
  assert.deepEqual(await f.runtime.reconcileStartup(), [
    { invocationId: "invoke-1", state: "effect_outcome_unresolved" },
  ]);
  assert.equal(
    f.outputs.calls.filter((call) => call.startsWith("finalize:")).length,
    finalizeCount,
  );
});

test("transient heartbeat failure leaves a started marker after raw success and blocks contenders", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-transient-heartbeat-"));
  const path = join(root, "process.sqlite");
  const stateKey = new Uint8Array(32).fill(12);
  const backend = new Backend();
  const outputs = new Outputs();
  const clock = new Clock();
  const first = runtimeFor(
    { kind: "sqlite", path },
    stateKey,
    backend,
    clock,
    outputs,
    { leaseDurationMs: 40, leaseHeartbeatMs: 10 },
  );
  const database = new DatabaseSync(path);
  t.after(async () => {
    try {
      database.close();
    } catch {}
    try {
      first.readOnlyStore.close();
    } catch {}
    await rm(root, { recursive: true, force: true });
  });
  const finalizeGate = deferred();
  const finalizeStarted = deferred();
  outputs.finalizeGate = finalizeGate.promise;
  outputs.onFinalize = finalizeStarted.resolve;
  const invocation = first.runtime.invoke({
    intent: intent(),
    grantId: "grant-invoke-1",
    ambientEnvironment: {},
  });
  await finalizeStarted.promise;
  const row = database
    .prepare(
      "SELECT record_json, integrity FROM durable_processes WHERE invocation_id=?",
    )
    .get("invoke-1") as { record_json: string; integrity: string };
  database
    .prepare(
      "UPDATE durable_processes SET record_json=? WHERE invocation_id=?",
    )
    .run("{}", "invoke-1");
  await new Promise((resolve) => setTimeout(resolve, 30));
  database
    .prepare(
      "UPDATE durable_processes SET record_json=?, integrity=? WHERE invocation_id=?",
    )
    .run(row.record_json, row.integrity, "invoke-1");
  assert.equal(first.readOnlyStore.readByInvocation("invoke-1")?.state, "exited");
  finalizeGate.resolve();
  await assert.rejects(invocation, /authority|heartbeat|store|unavailable/i);
  const blocked = first.readOnlyStore.readByInvocation("invoke-1")!;
  assert.deepEqual(
    pendingEffectsOf(blocked).map(({ family, phase }) => ({ family, phase })),
    [{ family: "output_finalize", phase: "started" }],
  );
  const revision = blocked.revision;
  clock.current = new Date(clock.current.getTime() + 50);
  const contenderBackend = new Backend();
  const contenderOutputs = new Outputs();
  const contender = runtimeFor(
    { kind: "sqlite", path },
    stateKey,
    contenderBackend,
    clock,
    contenderOutputs,
    { leaseDurationMs: 40, leaseHeartbeatMs: 10 },
  );
  try {
    assert.deepEqual(await contender.runtime.reconcileStartup(), [
      { invocationId: "invoke-1", state: "effect_outcome_unresolved" },
    ]);
    assert.equal(
      contender.readOnlyStore.readByInvocation("invoke-1")?.revision,
      revision,
    );
    assert.deepEqual(contenderBackend.calls, []);
    assert.deepEqual(contenderOutputs.calls, []);
  } finally {
    contender.readOnlyStore.close();
  }
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

test("expired bound active observation blocks takeover reconciliation until its owner settles", async (t) => {
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
    { invocationId: "invoke-1", state: "effect_outcome_unresolved" },
  ]);
  const blocked = second.readOnlyStore.readByInvocation("invoke-1")!;
  assert.equal(blocked.ownerId, running.ownerId);
  assert.equal(blocked.fencingToken, running.fencingToken);
  assert.equal(backend.calls.filter((call) => call === "launch").length, 1);
  assert.equal(backend.calls.filter((call) => call === "reconcile").length, 0);

  observeGate.resolve();
  assert.equal((await stale).outcome, "exited");
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
  let rejectObservation!: (error: Error) => void;
  f.backend.observeGate = new Promise<void>((_resolve, reject) => {
    rejectObservation = reject;
  });
  const signalStarted = deferred();
  f.backend.onSignal = () => signalStarted.resolve();
  const invocation = f.runtime.invoke({
    intent: intent(),
    grantId: "grant-invoke-1",
    ambientEnvironment: {},
    deadline: new Date("2026-01-01T00:00:01.000Z"),
  });
  await signalStarted.promise;
  rejectObservation(new Error("observation transport lost"));
  await assert.rejects(invocation);
  assert.equal(
    f.store.readByInvocation("invoke-1")?.stopIntent?.reason,
    "timed_out",
  );
  f.backend.observeValue = { state: "exited", exitCode: 0 };
  assert.deepEqual(await f.runtime.reconcileStartup(), [
    { invocationId: "invoke-1", state: "effect_outcome_unresolved" },
  ]);
  assert.equal(f.store.readByInvocation("invoke-1")?.result, undefined);
});

test("backend-unavailable with durable stop cannot bypass an ambiguous observation when backend returns", async () => {
  const f = fixture();
  let rejectObservation!: (error: Error) => void;
  f.backend.observeGate = new Promise<void>((_resolve, reject) => {
    rejectObservation = reject;
  });
  f.backend.signalValues = [{ state: "exited" }];
  const signalStarted = deferred();
  f.backend.onSignal = () => signalStarted.resolve();
  const invocation = f.runtime.invoke({
    intent: intent(),
    grantId: "grant-invoke-1",
    ambientEnvironment: {},
    deadline: new Date("2026-01-01T00:00:01.000Z"),
  });
  await signalStarted.promise;
  rejectObservation(new Error("observation transport lost"));
  await assert.rejects(invocation);
  assert.equal(
    f.store.readByInvocation("invoke-1")?.state,
    "backend_unavailable",
  );
  f.backend.calls.length = 0;
  f.backend.reconcileValue = { state: "running" };
  f.backend.observeValue = { state: "exited", exitCode: 0 };
  f.backend.signalValues = [{ state: "exited" }];
  assert.deepEqual(await f.runtime.reconcileStartup(), [
    { invocationId: "invoke-1", state: "effect_outcome_unresolved" },
  ]);
  assert.equal(await f.runtime.cancel("invoke-1"), false);
  assert.deepEqual(f.backend.calls, []);
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

test("restart preserves each completed malformed observation without reopening output", async () => {
  const first = fixture("first");
  const secondIntent = intent("second");
  // Build two rows with completed-but-uncommitted observation markers.
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
  first.backend.observeValue = { state: "exited", exitCode: 0 };
  const outcomes = await first.runtime.reconcileStartup();
  assert.equal(outcomes.length, 2);
  assert.deepEqual(outcomes, [
    { invocationId: "first", state: "effect_outcome_unresolved" },
    { invocationId: "second", state: "effect_outcome_unresolved" },
  ]);
  assert.equal(first.store.readByInvocation("first")?.state, "backend_unavailable");
  assert.equal(first.store.readByInvocation("second")?.state, "backend_unavailable");
  assert.equal(
    first.outputs.calls.filter((call) => call.startsWith("reopen:")).length,
    0,
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
    ["exited", "exited"],
    ["verifying_empty", "verifying_empty"],
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
    const startup = await f.runtime.reconcileStartup();
    if (state === "exited" || state === "verifying_empty")
      assert.deepEqual(startup, [
        { invocationId: "invoke-1", state: "effect_outcome_unresolved" },
      ]);
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
      const startup = await f.runtime.reconcileStartup();
      assert.deepEqual(startup, [
        { invocationId: "invoke-1", state: "effect_outcome_unresolved" },
      ]);
      assert.equal(
        f.store.readByInvocation("invoke-1")?.state,
        state,
        `${state}/${outcome.want}`,
      );
    }
  }
});
