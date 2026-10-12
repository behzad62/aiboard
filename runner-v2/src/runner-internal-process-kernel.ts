import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import type { ExecutionInvocationKind } from "./execution-safety-contracts.js";
import type {
  BackpressuredInteractiveProcessChannelProvider,
  BackpressuredOutputMetadata,
  InteractiveProcessChannel,
} from "./interactive-process-channel.js";
import {
  digestProcessBackendAttestation,
  parseProcessBackendProbe,
  parseProcessEmptyVerification,
  parseProcessLaunchResult,
  parseProcessReconciliation,
  parseProcessReleaseResult,
  parseProcessSignalResult,
  ProcessReleasePendingError,
  type ProcessBackend,
  type ProcessBackendBinding,
  type ProcessEffectFence,
  type ProcessReconciliation,
} from "./process-backend.js";
import { createPosixProcessBackend } from "./posix-process-backend.js";
import { createWindowsProcessBackend } from "./windows-process-backend.js";
import { NativeOwnedProcessBackend } from "./native-process-backend.js";

const POLL_INTERVAL_MS = 25;

interface BackpressuredProcessBackend extends ProcessBackend {
  backpressuredChannelProvider(): BackpressuredInteractiveProcessChannelProvider;
}

export interface RunnerInternalProcessLaunchInput {
  readonly principalId: string;
  readonly callId: string;
  readonly runId: string;
  readonly kind: ExecutionInvocationKind;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly access: readonly Readonly<{
    canonicalPath: string;
    mode: "read" | "write" | "create";
  }>[];
}

export interface RunnerInternalOwnedProcess {
  readonly rootPid?: number;
  readonly binding: ProcessBackendBinding;
  setOutputSink(
    sink: (metadata: BackpressuredOutputMetadata, bytes: Uint8Array) => void | Promise<void>,
  ): () => void;
  write(payload: Uint8Array, timeoutMs: number): Promise<void>;
  closeInput(): Promise<void>;
  reconcile(): Promise<ProcessReconciliation>;
  closeVerified(input: {
    readonly shutdownTimeoutMs: number;
    readonly terminationTimeoutMs: number;
    readonly forceImmediately?: boolean;
    readonly absoluteDeadline?: number;
  }): Promise<Readonly<{ exitCode?: number; signal?: string }>>;
}

export interface RunnerInternalProcessKernel {
  launch(input: RunnerInternalProcessLaunchInput): Promise<RunnerInternalOwnedProcess>;
  activeCount(): number;
  close(): Promise<void>;
}

export function createRunnerInternalProcessKernel(options: {
  readonly stateDirectory: string;
  readonly platform?: NodeJS.Platform;
  /** Deterministic backend seam for focused fault injection; production omits it. */
  readonly backend?: ProcessBackend;
}): RunnerInternalProcessKernel {
  const stateDirectory = resolve(options.stateDirectory);
  const platform = options.platform ?? process.platform;
  const rawBackend = options.backend ?? (
    platform === "win32"
      ? createWindowsProcessBackend({
          stateDirectory,
          jobObjects: "unavailable",
          replayCapacityChunks: 16,
          replayCapacityBytes: 256 * 1024,
        })
      : createPosixProcessBackend({
          stateDirectory,
          replayCapacityChunks: 16,
          replayCapacityBytes: 256 * 1024,
        })
  );
  let closeInspection: (() => Promise<void>) | undefined;
  if (options.backend === undefined && rawBackend instanceof NativeOwnedProcessBackend) {
    rawBackend.registerInspectionCleanup((cleanup) => {
      closeInspection = () => cleanup(Date.now() + 5_000);
    });
  }
  const backend = asBackpressured(rawBackend);
  const active = new Set<RunnerInternalOwnedProcess>();
  const pendingLaunches = new Set<Promise<void>>();
  let closed = false;
  let closingDeadline: number | undefined;
  let closePromise: Promise<void> | undefined;

  const kernel: RunnerInternalProcessKernel = Object.freeze({
    async launch(input: RunnerInternalProcessLaunchInput) {
      if (closed) throw new Error("Runner internal process kernel is closed.");
      let finishLaunch!: () => void;
      const completion = new Promise<void>((resolveCompletion) => { finishLaunch = resolveCompletion; });
      pendingLaunches.add(completion);
      try {
      await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
      const fence = Object.freeze({
        ownerId: boundedIdentity(input.principalId, "principalId"),
        fencingToken: 1,
      });
      const invocationId = boundedIdentity(input.callId, "callId");
      const probe = parseProcessBackendProbe(await backend.probe(fence));
      if (probe.attestationVersion !== 2) throw new Error("Runner internal process backend uses a legacy lifecycle attestation.");
      const rawLaunch = await backend.launch({
        intent: {
          invocationId,
          runId: boundedIdentity(input.runId, "runId"),
          kind: input.kind,
          executable: input.executable,
          arguments: Object.freeze([...input.arguments]),
          workingDirectory: input.workingDirectory,
          requiredLifecycleScope: "process_group",
          requestedCapabilities: Object.freeze([]),
        },
        grant: {
          grantId: `internal-grant-${randomUUID()}`,
          runId: input.runId,
          invocationId,
          issuedAt: new Date().toISOString(),
          access: input.access.map((entry) => ({ ...entry })),
        },
        environment: Object.freeze({ ...input.environment }),
        outputOwnerId: `internal-output-${createHash("sha256")
          .update(`${input.principalId}\0${input.callId}`)
          .digest("hex")}`,
        fence,
      });
      const launch = parseProcessLaunchResult(rawLaunch);
      const binding: ProcessBackendBinding = Object.freeze({
        registryId: "runner-internal-process-registry-v1",
        backendId: probe.backendId,
        implementationGeneration: "runner-internal-process-generation-v1",
        implementationDigest: createHash("sha256")
          .update(`runner-v2/internal-process-kernel\0${probe.backendId}`)
          .digest("hex"),
        attestationVersion: probe.attestationVersion,
        attestationDigest: digestProcessBackendAttestation(probe),
        ...launch,
      });
      let channel: InteractiveProcessChannel & {
        subscribeBackpressuredOutput(
          sink: (
            metadata: BackpressuredOutputMetadata,
            bytes: Uint8Array,
          ) => Promise<BackpressuredOutputMetadata>,
        ): () => void;
      };
      try {
        channel = await backend.backpressuredChannelProvider().acquire(binding, fence);
      } catch (acquisitionError) {
        try {
          await cleanupExactBackend(backend, binding, fence, 15_000, closed ? closingDeadline : undefined);
        } catch (cleanupError) {
          const retained = createCleanupOnlyOwner({
            backend,
            binding,
            fence,
            onReleased: (owned) => active.delete(owned),
          });
          active.add(retained);
          throw new AggregateError(
            [acquisitionError, cleanupError],
            "Runner internal channel acquisition failed and process cleanup remains owned.",
          );
        }
        throw acquisitionError;
      }
      let sink: ((metadata: BackpressuredOutputMetadata, bytes: Uint8Array) => void | Promise<void>) | undefined;
      let resolveSink!: (
        value: (metadata: BackpressuredOutputMetadata, bytes: Uint8Array) => void | Promise<void>,
      ) => void;
      const sinkReady = new Promise<
        (metadata: BackpressuredOutputMetadata, bytes: Uint8Array) => void | Promise<void>
      >((resolveReady) => { resolveSink = resolveReady; });
      let nextWriteSequence = 1;
      let writeTail = Promise.resolve();
      let cleanupPromise: Promise<Readonly<{ exitCode?: number; signal?: string }>> | undefined;
      let cleanupResult: Readonly<{ exitCode?: number; signal?: string }> | undefined;
      const unsubscribe = channel.subscribeBackpressuredOutput(async (metadata, bytes) => {
        const target = sink ?? await sinkReady;
        await target(metadata, new Uint8Array(bytes));
        return metadata;
      });
      const owned: RunnerInternalOwnedProcess = Object.freeze({
        rootPid: binding.rootPid,
        binding,
        setOutputSink(next: (
          metadata: BackpressuredOutputMetadata,
          bytes: Uint8Array,
        ) => void | Promise<void>) {
          if (sink) throw new Error("Runner internal process output already has a sink.");
          sink = next;
          resolveSink(next);
          return () => {
            if (sink === next) sink = undefined;
          };
        },
        async write(payload: Uint8Array, timeoutMs: number) {
          const bytes = new Uint8Array(payload);
          const sequence = nextWriteSequence++;
          const operation = writeTail.then(async () => {
            await channel.write({
              sequence,
              byteLength: bytes.byteLength,
              digest: createHash("sha256").update(bytes).digest("hex"),
              timeoutMs: positiveTimeout(timeoutMs, "write timeout"),
            }, bytes);
          });
          writeTail = operation.catch(() => undefined);
          await operation;
        },
        async closeInput() {
          await writeTail;
          await channel.closeInput();
        },
        async reconcile() {
          return parseProcessReconciliation(await backend.reconcile(binding, fence));
        },
        async closeVerified(closeInput: {
          readonly shutdownTimeoutMs: number;
          readonly terminationTimeoutMs: number;
          readonly forceImmediately?: boolean;
          readonly absoluteDeadline?: number;
        }) {
          if (cleanupResult) return cleanupResult;
          if (cleanupPromise) return await cleanupPromise;
          const attempt = (async () => {
            const absoluteDeadline = validateCleanupDeadline(closeInput.absoluteDeadline);
            assertCleanupBudget(absoluteDeadline);
            if (!sink) {
              sink = () => undefined;
              resolveSink(sink);
            }
            let disposition: Readonly<{ exitCode?: number; signal?: string }> = {};
            const shutdownTimeoutMs = positiveTimeout(
              closeInput.shutdownTimeoutMs,
              "shutdown timeout",
            );
            const terminationTimeoutMs = positiveTimeout(
              closeInput.terminationTimeoutMs,
              "termination timeout",
            );
            try { await writeTail; assertCleanupBudget(absoluteDeadline); await channel.closeInput(); } catch {}
            assertCleanupBudget(absoluteDeadline);
            let observed = await waitForTerminal(
              backend,
              binding,
              fence,
              Math.min(Date.now() + shutdownTimeoutMs, absoluteDeadline),
              absoluteDeadline,
            );
            assertCleanupBudget(absoluteDeadline);
            if (observed.state !== "exited" && closeInput.forceImmediately !== true) {
              try {
                parseProcessSignalResult(await backend.signal(binding, "terminate", fence));
              } catch {}
              assertCleanupBudget(absoluteDeadline);
              observed = await waitForTerminal(
                backend,
                binding,
                fence,
                Math.min(Date.now() + terminationTimeoutMs, Date.now() + 5_000, absoluteDeadline),
                absoluteDeadline,
              );
            }
            const forceDeadline = Math.min(Date.now() + terminationTimeoutMs, absoluteDeadline);
            while (observed.state !== "exited" && Date.now() < forceDeadline) {
              try {
                const signalled = parseProcessSignalResult(await backend.signal(binding, "force_terminate", fence));
                if (signalled.state === "exited") {
                  observed = { state: "exited" };
                  break;
                }
              } catch {}
              assertCleanupBudget(absoluteDeadline);
              observed = parseProcessReconciliation(
                await backend.reconcile(binding, fence),
              );
              if (observed.state !== "exited") await delay(POLL_INTERVAL_MS);
            }
            if (observed.state !== "exited") {
              throw new Error("Runner internal process cleanup outcome is unverified.");
            }
            disposition = Object.freeze({
              ...(observed.exitCode === undefined ? {} : { exitCode: observed.exitCode }),
              ...(observed.signal === undefined ? {} : { signal: observed.signal }),
            });
            assertCleanupBudget(absoluteDeadline);
            const emptyDeadline = Math.min(Date.now() + terminationTimeoutMs, absoluteDeadline);
            let empty = parseProcessEmptyVerification(
              await backend.verifyEmpty(binding, fence),
            );
            while (!empty.empty && Date.now() < emptyDeadline) {
              await delay(POLL_INTERVAL_MS);
              assertCleanupBudget(absoluteDeadline);
              empty = parseProcessEmptyVerification(
                await backend.verifyEmpty(binding, fence),
              );
            }
            if (!empty.empty) {
              throw new Error(`Runner internal process cleanup could not prove emptiness: ${empty.detail}`);
            }
            assertCleanupBudget(absoluteDeadline);
            unsubscribe();
            await channel.detach();
            const releaseDeadline = Math.min(Date.now() + terminationTimeoutMs, absoluteDeadline);
            for (;;) {
              assertCleanupBudget(absoluteDeadline);
              try {
                parseProcessReleaseResult(await backend.release(binding, fence));
                break;
              } catch (error) {
                if (!(error instanceof ProcessReleasePendingError) || Date.now() >= releaseDeadline) throw error;
                await delay(Math.min(POLL_INTERVAL_MS, Math.max(1, releaseDeadline - Date.now())));
              }
            }
            active.delete(owned);
            return disposition;
          })();
          cleanupPromise = attempt;
          try {
            cleanupResult = await attempt;
            return cleanupResult;
          } catch (error) {
            if (cleanupPromise === attempt) cleanupPromise = undefined;
            throw error;
          }
        },
      });
      active.add(owned);
      if (closed) {
        await owned.closeVerified({ shutdownTimeoutMs: 1, terminationTimeoutMs: 15_000, absoluteDeadline: closingDeadline });
        throw new Error("Runner internal process kernel closed during launch.");
      }
      return owned;
      } finally {
        finishLaunch();
        pendingLaunches.delete(completion);
      }
    },
    activeCount() {
      return active.size;
    },
    async close() {
      if (closePromise) return await closePromise;
      closed = true;
      const deadline = Date.now() + 15_000;
      closingDeadline = deadline;
      const attempt = (async () => {
        await awaitCleanupSettlement(Promise.all([...pendingLaunches]), deadline);
        assertCleanupBudget(deadline);
        const settled = await awaitCleanupSettlement(Promise.allSettled([...active].map(async (owned) =>
          await owned.closeVerified({ shutdownTimeoutMs: 1_000, terminationTimeoutMs: 15_000, absoluteDeadline: deadline }))), deadline);
        const failures = settled
          .filter((entry): entry is PromiseRejectedResult => entry.status === "rejected")
          .map((entry) => entry.reason);
        if (failures.length > 0) {
          throw new AggregateError(failures, "Runner internal process kernel cleanup failed.");
        }
        assertCleanupBudget(deadline);
        await closeInspection?.();
      })();
      closePromise = attempt;
      try {
        return await attempt;
      } finally {
        if (closePromise === attempt) closePromise = undefined;
      }
    },
  });
  return kernel;
}

function createCleanupOnlyOwner(options: {
  readonly backend: BackpressuredProcessBackend;
  readonly binding: ProcessBackendBinding;
  readonly fence: ProcessEffectFence;
  readonly onReleased: (owned: RunnerInternalOwnedProcess) => void;
}): RunnerInternalOwnedProcess {
  let cleanupPromise: Promise<Readonly<{ exitCode?: number; signal?: string }>> | undefined;
  let cleanupResult: Readonly<{ exitCode?: number; signal?: string }> | undefined;
  const unavailable = async () => {
    throw new Error("Runner internal process channel acquisition did not complete.");
  };
  const owned: RunnerInternalOwnedProcess = Object.freeze({
    rootPid: options.binding.rootPid,
    binding: options.binding,
    setOutputSink: () => () => undefined,
    write: unavailable,
    closeInput: unavailable,
    async reconcile() {
      return parseProcessReconciliation(
        await options.backend.reconcile(options.binding, options.fence),
      );
    },
    async closeVerified(input: Parameters<RunnerInternalOwnedProcess["closeVerified"]>[0]) {
      if (cleanupResult) return cleanupResult;
      if (cleanupPromise) return await cleanupPromise;
      positiveTimeout(input.shutdownTimeoutMs, "shutdown timeout");
      const timeoutMs = positiveTimeout(input.terminationTimeoutMs, "termination timeout");
      const attempt = (async () => {
        await cleanupExactBackend(options.backend, options.binding, options.fence, timeoutMs, input.absoluteDeadline);
        const result = Object.freeze({});
        options.onReleased(owned);
        return result;
      })();
      cleanupPromise = attempt;
      try {
        cleanupResult = await attempt;
        return cleanupResult;
      } catch (error) {
        if (cleanupPromise === attempt) cleanupPromise = undefined;
        throw error;
      }
    },
  });
  return owned;
}

async function cleanupExactBackend(
  backend: BackpressuredProcessBackend,
  binding: ProcessBackendBinding,
  fence: ProcessEffectFence,
  timeoutMs: number,
  absoluteDeadline?: number,
): Promise<void> {
  const deadline = Math.min(Date.now() + timeoutMs, validateCleanupDeadline(absoluteDeadline));
  assertCleanupBudget(deadline);
  let observed = parseProcessReconciliation(await backend.reconcile(binding, fence));
  while (observed.state !== "exited" && Date.now() < deadline) {
    try { parseProcessSignalResult(await backend.signal(binding, "force_terminate", fence)); }
    catch {}
    assertCleanupBudget(deadline);
    observed = parseProcessReconciliation(await backend.reconcile(binding, fence));
    if (observed.state !== "exited") await delay(POLL_INTERVAL_MS);
  }
  if (observed.state !== "exited") throw new Error("Runner internal failed-launch cleanup is unverified.");
  assertCleanupBudget(deadline);
  let empty = parseProcessEmptyVerification(await backend.verifyEmpty(binding, fence));
  while (!empty.empty && Date.now() < deadline) {
    await delay(POLL_INTERVAL_MS);
    assertCleanupBudget(deadline);
    empty = parseProcessEmptyVerification(await backend.verifyEmpty(binding, fence));
  }
  if (!empty.empty) throw new Error("Runner internal failed-launch cleanup could not prove emptiness.");
  assertCleanupBudget(deadline);
  parseProcessReleaseResult(await backend.release(binding, fence));
}

function validateCleanupDeadline(deadline: number | undefined): number {
  if (deadline === undefined) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(deadline) || deadline <= 0) throw new Error("Runner internal cleanup absolute deadline is invalid.");
  return deadline;
}

function assertCleanupBudget(deadline: number): void {
  if (Date.now() >= deadline) throw new Error("Runner internal cleanup deadline exhausted; ownership remains retained.");
}

async function awaitCleanupSettlement<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    void promise.catch(() => undefined);
    throw new Error("Runner internal cleanup deadline exhausted; ownership remains retained.");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Runner internal cleanup remains unsettled; ownership remains retained.")), remaining);
    })]);
  } finally { clearTimeout(timer); }
}

async function waitForTerminal(
  backend: ProcessBackend,
  binding: ProcessBackendBinding,
  fence: ProcessEffectFence,
  deadline: number,
  absoluteDeadline = Number.POSITIVE_INFINITY,
): Promise<ProcessReconciliation> {
  assertCleanupBudget(absoluteDeadline);
  let observed = parseProcessReconciliation(await backend.reconcile(binding, fence));
  while (observed.state !== "exited" && Date.now() < deadline) {
    await delay(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
    assertCleanupBudget(absoluteDeadline);
    if (Date.now() >= deadline) break;
    observed = parseProcessReconciliation(await backend.reconcile(binding, fence));
  }
  return observed;
}

function asBackpressured(backend: ProcessBackend): BackpressuredProcessBackend {
  if (typeof (backend as Partial<BackpressuredProcessBackend>)
    .backpressuredChannelProvider !== "function") {
    throw new Error("Runner internal process backend lacks a backpressured channel.");
  }
  return backend as BackpressuredProcessBackend;
}

function boundedIdentity(value: string, label: string): string {
  if (typeof value !== "string" || !value || value.includes("\0") ||
      Buffer.byteLength(value) > 512) {
    throw new Error(`Runner internal ${label} is invalid.`);
  }
  return value;
}

function positiveTimeout(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 3_600_000) {
    throw new Error(`Runner internal ${label} is invalid.`);
  }
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
