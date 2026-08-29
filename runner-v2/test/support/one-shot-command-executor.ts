import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { ArtifactStore } from "../../src/artifact-store.js";
import { createChildEnvironmentFactory } from "../../src/child-environment.js";
import type { PermissionProfile } from "../../src/contracts.js";
import { createExecutionGrantAuthority } from "../../src/execution-grants.js";
import { createExecutionIsolationRegistry, createExecutionIsolationSelector } from "../../src/execution-isolation-provider.js";
import { ManagedProcessService } from "../../src/managed-process.js";
import {
  createBoundedProcessOutputFactory,
  createRuntimeBackedOneShotCommandExecutor,
  type OneShotCommandExecutor,
} from "../../src/one-shot-command-executor.js";
import { createProcessBackendRegistration, createProcessBackendRegistry } from "../../src/process-backend.js";
import type { ProcessBackend } from "../../src/process-backend.js";
import { createPosixProcessBackend } from "../../src/posix-process-backend.js";
import { createSubprocessRuntimeKernel, type ReconciliationOutcome } from "../../src/subprocess-runtime.js";
import { createWindowsProcessBackend } from "../../src/windows-process-backend.js";

export interface ProductionOneShotCommandFixture {
  readonly execution: OneShotCommandExecutor;
  readonly internalExecution: OneShotCommandExecutor;
  /** Production Runner-owned entry used by non-model families such as final verification. */
  readonly runnerOwnedExecution: OneShotCommandExecutor;
  readonly executionGrants: ReturnType<typeof createExecutionGrantAuthority>;
  readonly artifacts: ArtifactStore;
  readonly root: string;
  reconcileStartup(): Promise<ReconciliationOutcome[]>;
  hasBackendBinding(runId: string, sessionId: string, callId: string): boolean;
  close(): Promise<void>;
}

export interface ProductionOneShotCommandFixtureOptions {
  readonly artifacts?: ArtifactStore;
  readonly spillFault?: boolean;
  readonly permissionProfile?: PermissionProfile;
  readonly backend?: ProcessBackend;
  readonly backendId?: string;
  readonly leaseDurationMs?: number;
  readonly leaseHeartbeatMs?: number;
  readonly managedProcessStartDeadlineMs?: number;
  readonly backendDecorator?: (backend: ProcessBackend) => ProcessBackend;
}

/** Test-scoped instance of the production grant/isolation/runtime/backend/output graph. */
export function createProductionOneShotCommandFixture(
  t?: TestContext,
  options: ProductionOneShotCommandFixtureOptions = {},
): ProductionOneShotCommandFixture {
  const root = mkdtempSync(join(tmpdir(), "aiboard-production-one-shot-"));
  const artifacts = options.artifacts ?? new ArtifactStore(join(root, "artifacts"));
  const projectBoundary = join(root, "project-boundary");
  mkdirSync(projectBoundary);
  const environments = createChildEnvironmentFactory({
    credentialResolver: { consume: () => { throw new Error("Unexpected credential grant."); } },
  });
  const managed = process.platform === "win32"
    ? new ManagedProcessService({
      stateDirectory: join(root, "managed"),
      ...(options.managedProcessStartDeadlineMs
        ? { startDeadlineMs: options.managedProcessStartDeadlineMs }
        : {}),
    })
    : undefined;
  const nativeBackend = options.backend ?? (process.platform === "win32"
    ? createWindowsProcessBackend({ jobObjects: { service: managed! } })
    : createPosixProcessBackend({ stateDirectory: join(root, "backend") }));
  const backend = options.backendDecorator ? options.backendDecorator(nativeBackend) : nativeBackend;
  const kernel = createSubprocessRuntimeKernel({
    registry: createProcessBackendRegistry([createProcessBackendRegistration({
      stableAdapterId: `test-${process.platform}-production-adapter`,
      backendId: options.backendId ?? (process.platform === "win32" ? "runner-windows-job-v1" : "runner-posix-process-group-v1"),
      codeDigest: createHash("sha256").update("test-production-platform-adapter-v1").digest("hex"),
      configDigest: createHash("sha256").update("test-production-one-shot-v1").digest("hex"),
      backend,
    })]),
    state: { kind: "sqlite", path: join(root, "runtime.sqlite") },
    stateKey: randomBytes(32),
    clock: {
      now: () => new Date(),
      sleep: async (milliseconds) => await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, milliseconds);
        timer.unref();
      }),
    },
    environments,
    outputs: createBoundedProcessOutputFactory({
      spillRoot: options.spillFault ? projectBoundary : join(root, "spill"),
      projectRoot: projectBoundary,
      artifacts,
    }),
    ...(options.leaseDurationMs ? { leaseDurationMs: options.leaseDurationMs } : {}),
    ...(options.leaseHeartbeatMs ? { leaseHeartbeatMs: options.leaseHeartbeatMs } : {}),
  });
  const executionGrants = createExecutionGrantAuthority();
  const execution = createRuntimeBackedOneShotCommandExecutor({
    runtime: kernel.runtime,
    runtimeGrants: kernel.grantsController,
    executionGrants,
    isolation: createExecutionIsolationSelector(createExecutionIsolationRegistry([])),
    permissionProfile: options.permissionProfile ?? "full",
    ambientEnvironment: Object.freeze(Object.fromEntries(
      Object.entries(process.env).filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)),
    )),
    environments,
  });
  const internalExecution: OneShotCommandExecutor = {
    execute: async (request) => {
      const { executionGrant: _ignored, ...context } = request.context;
      return await execution.execute({ ...request, context: { ...context, runnerInternal: true } });
    },
  };
  let closed = false;
  const fixture: ProductionOneShotCommandFixture = {
    execution,
    internalExecution,
    runnerOwnedExecution: internalExecution,
    executionGrants,
    artifacts,
    root,
    reconcileStartup: async () => await kernel.runtime.reconcileStartup(),
    hasBackendBinding(runId, sessionId, callId) {
      const invocationId = `inv-${createHash("sha256").update(`${runId}\0${sessionId}\0${callId}`).digest("hex")}`;
      return kernel.readOnlyStore.readByInvocation(invocationId)?.backendBinding !== undefined;
    },
    async close() {
      if (closed) return;
      closed = true;
      await executionGrants.revokeAll("cleanup");
      await kernel.runtime.reconcileStartup();
      kernel.readOnlyStore.close();
      managed?.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
  t?.after(async () => await fixture.close());
  return fixture;
}

/** Existing tests use Runner-internal grants but the full production runtime graph. */
export function createTestOneShotCommandExecutor(
  t?: TestContext,
  options: ProductionOneShotCommandFixtureOptions = {},
): OneShotCommandExecutor {
  return createProductionOneShotCommandFixture(t, options).internalExecution;
}
