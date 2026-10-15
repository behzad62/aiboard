import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync, rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import { createChildEnvironmentFactory } from "../src/child-environment.js";
import type { ExecutionInvocationIntent, GenericProcessResult } from "../src/execution-safety-contracts.js";
import {createProcessBackendRegistration, createProcessBackendRegistry, ProcessReleasePendingError, type ProcessBackend, type ProcessBackendBinding, type ProcessLaunchRequest} from "../src/process-backend.js";
import {createSubprocessRuntimeKernel, type ProcessOutputFactory, type SubprocessRuntimeClock} from "../src/subprocess-runtime.js";
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
  requiredLifecycleScope: "process_group",
  requestedCapabilities: [],
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
    attestationVersion: 2,
    backendId: "fake",
    verified: true,
    platformLabel: "fixture",
    lifecycle: { scope: "process_group", termination: "enforced", emptiness: "enforced" },
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
  releasePendingFailures = 0;
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
    if (this.releasePendingFailures > 0) {
      this.releasePendingFailures -= 1;
      throw new ProcessReleasePendingError("terminal witness is still alive");
    }
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

const original: GenericProcessResult = {logicalProcessId: "original-owned-process", outcome: "exited", exitCode: 0, startedAt: "2025-12-31T00:00:00.000Z", finishedAt: "2025-12-31T00:00:01.000Z", output: [], cleanup: {state: "verified_empty", verifiedAt: "2025-12-31T00:00:02.000Z"}};

test("V2 miss consumes actual environment once and launches exactly once", async () => {
  const f = fixture(); let lookups = 0; let observed = "";
  const result = await f.runtime.invoke({intent: intent(), grantId: "grant-invoke-1", ambientEnvironment: {V2_VALUE: "actual"}, reusePreparedEnvironment: async (environment) => {lookups++; observed = environment.V2_VALUE!; return undefined;}});
  assert.equal(observed, "actual"); assert.equal(lookups, 1); assert.equal(result.exitCode, 0);
  assert.equal(f.backend.calls.filter((call) => call === "launch").length, 1);
  assert.equal(f.store.readByInvocation("invoke-1")?.state, "cleaned"); f.store.close();
});

test("V2 hit settles unused output and records no new workload witnesses", async () => {
  const f = fixture();
  const result = await f.runtime.invoke({intent: intent(), grantId: "grant-invoke-1", ambientEnvironment: {}, reusePreparedEnvironment: async () => ({reused_from: "evidence-original", process: original})});
  assert.deepEqual(result, original); assert.equal(f.backend.calls.includes("launch"), false);
  const row = f.store.readByInvocation("invoke-1")!;
  assert.equal(row.state, "reused"); assert.equal(row.reused_from, "evidence-original");
  assert.equal(row.backendBinding, undefined); assert.equal(row.result, undefined); assert.equal(row.observation, undefined); assert.equal(row.output, undefined);
  assert.ok(f.outputs.calls.some((call) => call.startsWith("cleanup:"))); assert.equal(row.cleanup.state, "not_required"); f.store.close();
});

for (const hit of [false, true]) {
  for (const race of ["revocation", "cancellation", "expiry"] as const) {
    test(`V2 ${hit ? "hit" : "miss"} ${race} during lookup refuses backend launch`, async () => {
      const f = fixture(); const abort = new AbortController(); let live = true;
      await assert.rejects(f.runtime.invoke({intent: intent(), grantId: "grant-invoke-1", ambientEnvironment: {}, signal: abort.signal,
        assertReuseAuthority: () => {if (!live) throw new Error("revoked exact parent grant");},
        reusePreparedEnvironment: async () => {
          await Promise.resolve();
          if (race === "revocation") live = false;
          if (race === "cancellation") abort.abort();
          if (race === "expiry") f.clock.current = new Date("2026-01-01T02:00:00.000Z");
          return hit ? {reused_from: "evidence-original", process: original} : undefined;
        }}));
      assert.equal(f.backend.calls.includes("launch"), false); assert.notEqual(f.store.readByInvocation("invoke-1")?.state, "reused"); f.store.close();
    });
  }
}

test("V2 hit cannot return original success when unused output cleanup fails", async () => {
  const f = fixture();
  await assert.rejects(f.runtime.invoke({intent: intent(), grantId: "grant-invoke-1", ambientEnvironment: {}, reusePreparedEnvironment: async () => {
    f.outputs.failCleanupFor.add(f.store.readByInvocation("invoke-1")!.outputOwnerId);
    return {reused_from: "evidence-original", process: original};
  }}));
  const row = f.store.readByInvocation("invoke-1")!;
  assert.equal(row.state, "cleanup_blocked"); assert.equal(row.cleanup.state, "failed"); assert.equal(row.reused_from, undefined); assert.equal(f.backend.calls.includes("launch"), false); f.store.close();
});

for (const race of ["revocation", "cancellation", "expiry", "deadline"] as const) {
  test(`V2 miss ${race} after prepared-environment observer refuses launch`, async () => {
    const f = fixture(); const abort = new AbortController(); let live = true;
    if (race === "deadline") f.clock.sleep = async () => await new Promise(() => undefined);
    await assert.rejects(f.runtime.invoke({intent: intent(), grantId: "grant-invoke-1", ambientEnvironment: {}, signal: abort.signal,
      ...(race === "deadline" ? {deadline: new Date("2026-01-01T00:01:00.000Z")} : {}),
      assertReuseAuthority: () => {if (!live) throw new Error("revoked original claims");},
      reusePreparedEnvironment: async () => undefined,
      onPreparedEnvironment: async () => {
        await Promise.resolve();
        if (race === "revocation") live = false;
        if (race === "cancellation") abort.abort();
        if (race === "expiry") f.clock.current = new Date("2026-01-01T02:00:00.000Z");
        if (race === "deadline") f.clock.current = new Date("2026-01-01T00:02:00.000Z");
      }}));
    assert.equal(f.backend.calls.includes("launch"), false); f.store.close();
  });
}

for (const hit of [false, true]) test(`V2 ${hit ? "hit" : "miss"} original launching fence cannot adopt a durable replacement`, async () => {
  const root = mkdtempSync(join(tmpdir(), "v2-reuse-fence-")); const path = join(root, "process.sqlite");
  const clock = new Clock(); const stateKey = new Uint8Array(32).fill(9); const backend = new Backend(); const replacementBackend = new Backend();
  const create = (selected: Backend) => createSubprocessRuntimeKernel({registry: backendRegistry(selected), state: {kind: "sqlite", path}, stateKey, clock, outputs: new Outputs(), environments: createChildEnvironmentFactory({credentialResolver: {consume: () => {throw new Error("unused");}}, now: () => clock.now()})});
  const originalKernel = create(backend); const replacement = create(replacementBackend); originalKernel.grantsController.issue(grantValue()); let originalFence = 0;
  try {
    const takeover = async () => {
      originalFence = originalKernel.readOnlyStore.readByInvocation("invoke-1")!.fencingToken;
      clock.current = new Date("2026-01-01T00:10:00.000Z");
      await replacement.runtime.reconcileStartup();
      assert.notEqual(replacement.readOnlyStore.readByInvocation("invoke-1")!.fencingToken, originalFence);
    };
    await assert.rejects(originalKernel.runtime.invoke({intent: intent(), grantId: "grant-invoke-1", ambientEnvironment: {},
      reusePreparedEnvironment: async () => {if (hit) {await takeover(); return {reused_from: "evidence-original", process: original};} return undefined;},
      onPreparedEnvironment: hit ? undefined : takeover}), /fenc|owner|stale|launch/i);
    assert.equal(backend.calls.includes("launch"), false); assert.equal(replacementBackend.calls.includes("launch"), false);
    const row = replacement.readOnlyStore.readByInvocation("invoke-1")!; assert.equal(row.backendBinding, undefined); assert.notEqual(row.fencingToken, originalFence); assert.notEqual(row.state, "reused");
  } finally {originalKernel.readOnlyStore.close(); replacement.readOnlyStore.close(); rmSync(root, {recursive: true, force: true});}
});
