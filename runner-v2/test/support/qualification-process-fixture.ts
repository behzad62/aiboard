/**
 * Shared process-backend fixture helpers for qualification scenarios.
 * Exact-owned cleanup only; PID/tree kills are never authority.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  parseProcessEmptyVerification,
  parseProcessLaunchResult,
  parseProcessReconciliation,
  type ProcessBackend,
  type ProcessBackendBinding,
  type ProcessEffectFence,
  type ProcessLaunchResult,
} from "../../src/process-backend.js";
import type { WindowsProcessBackend } from "../../src/windows-process-backend.js";
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

export async function drainAndCleanupWindowsFixture(
  backend: ProcessBackend,
  binding: ProcessBackendBinding,
  cleanupFence: ProcessEffectFence,
): Promise<void> {
  const streamed = backend as ProcessBackend & Pick<WindowsProcessBackend, "backpressuredChannelProvider">;
  let channel: Awaited<ReturnType<ReturnType<WindowsProcessBackend["backpressuredChannelProvider"]>["acquire"]>> | undefined;
  let unsubscribe: (() => void) | undefined;
  const deadline = Date.now() + 15_000;
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
        await backend.release(binding, cleanupFence); return;
      }
      if (Date.now() >= deadline) throw new Error("Fixture output/backend cleanup remains unverified at its deadline.");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally { unsubscribe?.(); await channel?.detach(); }
}

export async function cleanupPortableBackendFixture(
  backend: WindowsProcessBackend,
  binding: ProcessBackendBinding,
  cleanupFence: ProcessEffectFence,
): Promise<void> {
  // Prefer drain+release so retained output cannot keep the session running.
  try {
    await drainAndCleanupWindowsFixture(backend, binding, cleanupFence);
    return;
  } catch {
    // Fall through to bounded force/reconcile cleanup below.
  }
  const deadline = Date.now() + 30_000;
  let last = "cleanup not attempted";
  while (Date.now() < deadline) {
    try { await backend.signal(binding, "force_terminate", cleanupFence); } catch (error) { last = String(error); }
    const observation = parseProcessReconciliation(await backend.reconcile(binding, cleanupFence));
    last = observation.state;
    if (observation.state === "identity_mismatch") throw new Error("Portable fixture cleanup lost exact ownership.");
    if (observation.state === "exited") {
      await backend.release(binding, cleanupFence);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Portable fixture cleanup did not reach durable terminal state: ${last}`);
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
