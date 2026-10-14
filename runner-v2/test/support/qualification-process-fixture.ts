/**
 * Shared process-backend fixture helpers for qualification scenarios.
 * Exact-owned cleanup only; PID/tree kills are never authority.
 */
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  parseProcessEmptyVerification,
  parseProcessLaunchResult,
  parseProcessReconciliation,
  parseProcessReleaseResult,
  type ProcessLaunchRequest,
  type ProcessBackend,
  type ProcessBackendBinding,
  type ProcessEffectFence,
  type ProcessLaunchResult,
} from "../../src/process-backend.js";
import type { WindowsProcessBackend } from "../../src/windows-process-backend.js";
import { NativeProcessLaunchBlockedError } from "../../src/native-process-backend.js";
import { withInspectionFixture } from "./inspection-fixture.js";
import { finalizeCertifiedFixture } from "./certified-fixture-cleanup.js";
import { deferQualificationFixtureRemoval } from "./qualification-harness.js";

export const QUAL_FENCE: ProcessEffectFence = { ownerId: "qualification-owner", fencingToken: 1 };

export const verifiedWindowsSemanticFacts = {
  portableDuplex: "verified",
  windowsBatchArgv: "verified",
  exactTreeBirth: "partial",
  jobContainment: "verified",
} as const;

export function fixtureEnvironment(): Record<string, string> {
  const allowed = new Set(["systemroot", "windir", "comspec", "path", "pathext", "temp", "tmp", "home", "userprofile", "logname"]);
  return Object.fromEntries(
    Object.entries(process.env).filter(([key, value]) => allowed.has(key.toLowerCase()) && value !== undefined),
  ) as Record<string, string>;
}

export function processLaunchRequest(input: Readonly<{
  args: readonly string[];
  invocationId: string;
  backendHint?: string;
  workingDirectory?: string;
  requiredLifecycleScope?: "process_group" | "contained_workload";
  fence?: ProcessEffectFence;
}>) {
  const fence = input.fence ?? QUAL_FENCE;
  return {
    intent: {
      invocationId: input.invocationId,
      runId: "qualification-run",
      kind: "command" as const,
      executable: process.execPath,
      arguments: [...input.args],
      workingDirectory: input.workingDirectory ?? process.cwd(),
      requiredLifecycleScope: input.requiredLifecycleScope ?? "process_group" as const,
      requestedCapabilities: [] as const,
    },
    grant: {
      grantId: "qualification-grant",
      runId: "qualification-run",
      invocationId: input.invocationId,
      issuedAt: new Date().toISOString(),
      access: [],
    },
    environment: fixtureEnvironment(),
    outputOwnerId: "qualification-output",
    fence,
  };
}

export function bindingFor(launch: ProcessLaunchResult, backendId: string): ProcessBackendBinding {
  return {
    registryId: "qualification-registry",
    backendId,
    implementationGeneration: "generation",
    implementationDigest: "1".repeat(64),
    attestationVersion: 1,
    attestationDigest: "2".repeat(64),
    ...launch,
  };
}

export function opaqueDirectory(launch: ProcessLaunchResult): string {
  const identity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8")) as { directory?: unknown };
  if (typeof identity.directory !== "string") throw new Error("Launch returned no authenticated authority directory.");
  return identity.directory;
}

export async function drainAndCleanupWindowsFixture(backend: ProcessBackend, binding: ProcessBackendBinding, cleanupFence: ProcessEffectFence): Promise<void> {
  const streamed = backend as ProcessBackend & Pick<WindowsProcessBackend, "backpressuredChannelProvider">;
  let channel: Awaited<ReturnType<ReturnType<WindowsProcessBackend["backpressuredChannelProvider"]>["acquire"]>> | undefined;
  let unsubscribe: (() => void) | undefined;
  const deadline = Date.now() + 15_000;
  let hasPrimaryFailure = false;
  let primaryFailure: unknown;
  try {
    channel = await streamed.backpressuredChannelProvider().acquire(binding, cleanupFence);
    unsubscribe = channel.subscribeBackpressuredOutput(async (metadata) => metadata);
    for (;;) {
      try { await backend.signal(binding, "force_terminate", cleanupFence); }
      catch (error) { if (Date.now() >= deadline) throw error; }
      const state = parseProcessReconciliation(await backend.reconcile(binding, cleanupFence));
      if (state.state === "identity_mismatch") throw new Error("Fixture cleanup lost its exact backend identity.");
      if (state.state === "exited") {
        assert.equal(parseProcessEmptyVerification(await backend.verifyEmpty(binding, cleanupFence)).empty, true);
        unsubscribe(); unsubscribe = undefined; await channel.detach(); channel = undefined;
        parseProcessReleaseResult(await backend.release(binding, cleanupFence)); return;
      }
      if (Date.now() >= deadline) throw new Error("Fixture output/backend cleanup remains unverified at its deadline.");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } catch (error) { hasPrimaryFailure = true; primaryFailure = error; }
  finally {
    const failures: unknown[] = [];
    try { unsubscribe?.(); } catch (error) { failures.push(error); }
    try { await channel?.detach(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(
      [...(hasPrimaryFailure ? [primaryFailure] : []), ...failures],
      "Windows fixture output cleanup remains unverified.",
      hasPrimaryFailure ? { cause: primaryFailure } : undefined,
    );
    if (hasPrimaryFailure) throw primaryFailure;
  }
}

export async function cleanupPortableBackendFixture(
  backend: WindowsProcessBackend,
  binding: ProcessBackendBinding,
  cleanupFence: ProcessEffectFence,
): Promise<void> {
  let drainFailure: unknown;
  // Prefer drain+release so retained output cannot keep the session running.
  try {
    await drainAndCleanupWindowsFixture(backend, binding, cleanupFence);
    return;
  } catch (error) {
    drainFailure = error;
    // Fall through to bounded force/reconcile cleanup below.
  }
  try {
  const deadline = Date.now() + 30_000;
  let last = "cleanup not attempted";
  while (Date.now() < deadline) {
    try { await backend.signal(binding, "force_terminate", cleanupFence); } catch (error) { last = String(error); }
    const observation = parseProcessReconciliation(await backend.reconcile(binding, cleanupFence));
    last = observation.state;
    if (observation.state === "identity_mismatch") throw new Error("Portable fixture cleanup lost exact ownership.");
    if (observation.state === "exited") {
      assert.equal(parseProcessEmptyVerification(await backend.verifyEmpty(binding, cleanupFence)).empty, true);
      parseProcessReleaseResult(await backend.release(binding, cleanupFence));
      throw drainFailure; // Fresh workload release cannot settle the original failed channel.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Portable fixture cleanup did not reach durable terminal state: ${last}`);
  } catch (error) {
    if (error === drainFailure) throw error;
    throw new AggregateError([drainFailure, error], "Portable fixture fallback cleanup remains unverified.", { cause: drainFailure });
  }
}

export async function finalizePosixLiveFixture(
  backend: Pick<ProcessBackend, "signal" | "release">,
  binding: ProcessBackendBinding,
  effectFence: ProcessEffectFence,
  root: string,
  authorityDirectory: string,
  settleAndDetachChannel?: () => Promise<void>,
  deferRootRemoval = false,
): Promise<void> {
  const resolvedRoot = resolve(root);
  const resolvedDirectory = resolve(authorityDirectory);
  if (!(resolvedDirectory === resolvedRoot || resolvedDirectory.startsWith(resolvedRoot + sep))) {
    throw new Error("POSIX live fixture cleanup target is outside its exact fixture root.");
  }
  if (!existsSync(resolvedRoot)) throw new Error("POSIX live fixture root missing before cleanup.");
  try {
    await backend.signal(binding, "force_terminate", effectFence);
  } catch (error) {
    throw new AggregateError([error], `POSIX live fixture force cleanup failed; retained exact authority at ${resolvedDirectory}.`);
  }
  if (settleAndDetachChannel) {
    try { await settleAndDetachChannel(); }
    catch (error) {
      throw new AggregateError([error], `POSIX live fixture channel cleanup failed; retained exact authority at ${resolvedDirectory}.`);
    }
  }
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      await backend.release(binding, effectFence);
      break;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new AggregateError([error], `POSIX live fixture release failed; retained exact authority at ${resolvedDirectory}.`);
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
  }
  if (existsSync(resolvedDirectory)) {
    throw new Error("POSIX live fixture release returned without retiring its exact authority directory.");
  }
  if (deferRootRemoval) deferQualificationFixtureRemoval(resolvedRoot);
  else rmSync(resolvedRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
}

export async function withCertifiedRoot(input: Readonly<{
  fixtureName: string;
  root: string;
  body: () => Promise<void>;
  cleanup: () => Promise<void>;
  certify?: () => Promise<void>;
}>): Promise<void> {
  let failed = false;
  let primary: unknown;
  try {
    await input.body();
  } catch (error) {
    failed = true;
    primary = error;
  } finally {
    await finalizeCertifiedFixture({
      fixtureName: input.fixtureName,
      root: input.root,
      hasPrimaryFailure: failed,
      primaryFailure: primary,
      cleanup: input.cleanup,
      certify: input.certify ?? (async () => undefined),
      removeRoot: () => {
        deferQualificationFixtureRemoval(input.root);
      },
    });
  }
}

export function readSupervisorState(directory: string): string {
  return readFileSync(join(directory, "state.json"), "utf8");
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export { parseProcessLaunchResult, parseProcessReconciliation, parseProcessEmptyVerification };

/** Creator escrow for the default Windows inspection scope and its exact workload. */
export async function withWindowsInspectionQualification(input: Readonly<{
  fixtureName: string;
  root: string;
  backend: WindowsProcessBackend;
  body(fixture: Readonly<{
    launch(request: ProcessLaunchRequest): Promise<ProcessLaunchResult>;
    deferCleanup(cleanup: () => void | Promise<unknown>): void;
    useCleanupFence(fence: ProcessEffectFence): void;
    release(): Promise<{ released: true }>;
    retryRelease(): Promise<{ released: true }>;
  }>): Promise<void>;
}>): Promise<void> {
  const { backend } = input;
  let binding: ProcessBackendBinding | undefined;
  let retainedLaunch: unknown;
  let rootWitness: { canonical: string; dev: number | bigint; ino: number | bigint } | undefined;
  let noWorkload = false;
  let released = false;
  let releaseAttempted = false;
  let cleanupFence = QUAL_FENCE;
  const channelCleanup: Array<() => void | Promise<unknown>> = [];
  const retain = (launch: ProcessLaunchResult) => {
    binding = bindingFor(launch, "runner-windows-supervisor-v1");
    return launch;
  };
  const certifyEmptyRoot = () => {
    assert.equal(retainedLaunch, undefined); assert.equal(binding, undefined); assert.ok(rootWitness);
    const stat = lstatSync(input.root);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    assert.equal(realpathSync.native(input.root), rootWitness.canonical);
    assert.equal(stat.dev, rootWitness.dev); assert.equal(stat.ino, rootWitness.ino);
    assert.equal(readdirSync(input.root).length, 0, "an unreturned capability cannot retire inspection while authority files remain");
    const after = lstatSync(input.root);
    assert.equal(after.dev, rootWitness.dev); assert.equal(after.ino, rootWitness.ino);
    assert.ok(after.isDirectory() && !after.isSymbolicLink());
    assert.equal(realpathSync.native(input.root), rootWitness.canonical);
  };
  await withInspectionFixture({
    fixtureName: input.fixtureName, root: input.root,
    registerCleanup: register => backend.registerInspectionCleanup(register),
    body: async () => {
      const stat = lstatSync(input.root);
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
      rootWitness = { canonical: realpathSync.native(input.root), dev: stat.dev, ino: stat.ino };
      return await input.body({
      launch: async request => {
        if (retainedLaunch !== undefined) throw new Error("Qualification fixture already retains its workload capability.");
        try {
          retainedLaunch = await backend.launch(request);
          return retain(parseProcessLaunchResult(retainedLaunch));
        }
        catch (error) {
          if (error instanceof NativeProcessLaunchBlockedError) { retainedLaunch = error.launchResult; retain(error.launchResult); }
          throw error;
        }
      },
      deferCleanup: cleanup => { channelCleanup.push(cleanup); },
      useCleanupFence: fence => { cleanupFence = fence; },
      release: async () => {
        assert.ok(binding, "release requires the original retained launch capability");
        assert.equal(parseProcessEmptyVerification(await backend.verifyEmpty(binding, cleanupFence)).empty, true);
        releaseAttempted = true;
        const result = parseProcessReleaseResult(await backend.release(binding, cleanupFence));
        assert.equal(result.released, true); released = true;
        return { released: true };
      },
      retryRelease: async () => {
        assert.ok(binding && releaseAttempted && !released, "release retry requires a prior verified release attempt");
        // release() itself freshly reattests terminal emptiness/output and the
        // exact durable fence, including its retired-authority cleanup path.
        const result = parseProcessReleaseResult(await backend.release(binding, cleanupFence));
        assert.equal(result.released, true); released = true;
        return { released: true };
      },
    }); },
    cleanupWorkloads: async () => {
      const failures: unknown[] = [];
      for (const cleanup of channelCleanup.reverse()) {
        try { await cleanup(); } catch (error) { failures.push(error); }
      }
      try {
        if (!binding && retainedLaunch !== undefined) retain(parseProcessLaunchResult(retainedLaunch));
        if (!binding) { certifyEmptyRoot(); noWorkload = true; }
        else if (!released) { await drainAndCleanupWindowsFixture(backend, binding, cleanupFence); released = true; }
      } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "Windows qualification workload cleanup remains unverified.");
    },
    certifyWorkloads: async () => { if (noWorkload) certifyEmptyRoot(); else assert.equal(released, true); },
    removeRoot: () => deferQualificationFixtureRemoval(input.root),
  });
}
