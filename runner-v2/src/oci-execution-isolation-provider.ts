// RUNNER_RAW_PROCESS_BOUNDARY: configured OCI runtime invocation is confined to this attested isolation provider.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

import type {
  ExecutionIsolationAcquireRequest,
  ExecutionIsolationCleanupTransition,
  ExecutionIsolationLease,
  ExecutionIsolationProvider,
  ExecutionIsolationRecoveryResult,
} from "./execution-isolation-provider.js";
import {
  createExecutionIsolationProviderRegistration,
  createExecutionIsolationRegistry,
  createExecutionIsolationSelector,
  type ExecutionIsolationSelector,
} from "./execution-isolation-provider.js";
import { withOwnedFenceLock } from "./owned-fence-lock.mjs";
import type { RunnerCapabilitiesConfig } from "./runner-capabilities-config.js";

const OWNED_LABEL = "ai-board.runner-v2.owned";
const PROVIDER_LABEL = "ai-board.runner-v2.provider";
const RUN_LABEL = "ai-board.runner-v2.run";
const INVOCATION_LABEL = "ai-board.runner-v2.invocation";
const GRANT_LABEL = "ai-board.runner-v2.grant";
const IMAGE_LABEL = "ai-board.runner-v2.image";
const PROBE_LABEL = "ai-board.runner-v2.probe";
const MAX_CLI_OUTPUT_BYTES = 1024 * 1024;
const STATE_LOCK_TIMEOUT_MS = 10_000;
const MAX_LEASE_STATE_BYTES = 1024 * 1024;
const MAX_DURABLE_LEASES = 1_000;
const MAX_DURABLE_ACCESS = 256;

export type OciExecutionIsolationErrorCode =
  | "oci_configuration_invalid"
  | "oci_cli_unavailable"
  | "oci_image_unavailable"
  | "oci_interactive_attach_unavailable"
  | "oci_image_executable_unavailable"
  | "oci_attestation_failed"
  | "oci_grant_unrepresentable"
  | "oci_environment_unrepresentable"
  | "oci_path_escape"
  | "oci_create_failed"
  | "oci_release_failed"
  | "oci_recovery_blocked";

export class OciExecutionIsolationError extends Error {
  constructor(
    readonly code: OciExecutionIsolationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "OciExecutionIsolationError";
  }
}

export interface OciCliInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface OciCliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface OciCli {
  run(invocation: OciCliInvocation): Promise<OciCliResult>;
  runDuplex?(invocation: OciCliInvocation, input: string): Promise<OciCliResult>;
}

export interface OciExecutionIsolationProviderOptions {
  readonly providerId: string;
  /** Explicit absolute Docker-compatible executable; PATH discovery is forbidden. */
  readonly cliPath: string;
  /** Explicit configured image reference; the provider resolves it to an immutable image id. */
  readonly image: string;
  readonly stateDirectory: string;
  readonly allowNetwork?: boolean;
  readonly expectedCliIdentity?: Readonly<{ path: string; digest: string }>;
  readonly cli?: OciCli;
  readonly clock?: () => Date;
  /** Injectable private-file cleanup seam for deterministic fault testing. */
  readonly removeEnvironmentHandoff?: (path: string, root: string) => Promise<void>;
  /** Injectable private-file write seam for deterministic fault testing. */
  readonly writeEnvironmentHandoff?: (prepared: PreparedEnvironmentHandoff) => Promise<void>;
  /** Test/fault barrier around the two durable create boundaries. */
  readonly acquireBarrier?: (stage: "after_create_journal" | "after_environment_handoff") => Promise<void>;
}

export interface PreparedEnvironmentHandoff {
  readonly path: string;
  readonly root: string;
  readonly contents: string;
}

interface DurableOciLease {
  readonly lease: ExecutionIsolationLease;
  readonly containerId?: string;
  readonly containerName: string;
  readonly runId: string;
  readonly createStage?: "creating" | "bound";
  readonly cleanupStage: "active" | "cleanup_started" | "cleaned_pending_ack";
  readonly cleanupToken?: string;
  readonly cleanedAt?: string;
  readonly environmentHandoffPath?: string;
}

export async function createConfiguredOciIsolationSelector(
  config: RunnerCapabilitiesConfig,
  stateDirectory: string,
): Promise<ExecutionIsolationSelector> {
  const root = resolve(stateDirectory);
  await mkdir(root, { recursive: true });
  const registrations = (config.isolationProviders ?? []).map((providerConfig) => {
    const providerState = join(root, providerConfig.id);
    return {
      providerConfig,
      providerState,
    };
  });
  for (const registration of registrations) await mkdir(registration.providerState, { recursive: true });
  return createExecutionIsolationSelector(createExecutionIsolationRegistry(
    registrations.map(({ providerConfig, providerState }) =>
      createExecutionIsolationProviderRegistration({
        stableProviderId: providerConfig.id,
        codeDigest: createHash("sha256")
          .update("runner-v2/oci-execution-isolation-provider@1")
          .digest("hex"),
        configDigest: createHash("sha256")
          .update(JSON.stringify({
            id: providerConfig.id,
            type: providerConfig.type,
            cliPath: resolve(providerConfig.cliPath),
            image: providerConfig.image,
            allowNetwork: providerConfig.allowNetwork,
          }))
          .digest("hex"),
        provider: createOciExecutionIsolationProvider({
          providerId: providerConfig.id,
          cliPath: providerConfig.cliPath,
          image: providerConfig.image,
          allowNetwork: providerConfig.allowNetwork,
          stateDirectory: providerState,
          ...(providerConfig.cliIdentity
            ? { expectedCliIdentity: { ...providerConfig.cliIdentity } }
            : {}),
        }),
      })),
  ), { statePath: join(root, "execution-enforcement-state.json") });
}

export function createOciExecutionIsolationProvider(
  options: OciExecutionIsolationProviderOptions,
): ExecutionIsolationProvider {
  const providerId = safeLabel(options.providerId, "provider id");
  if (!isAbsolute(options.cliPath) || options.cliPath.includes("\0")) {
    throw ociError("oci_configuration_invalid", "OCI CLI path must be explicit and absolute.");
  }
  const configuredCli = resolve(options.cliPath);
  const image = safeText(options.image, "image", 1024);
  if (!isAbsolute(options.stateDirectory) || options.stateDirectory.includes("\0")) {
    throw ociError("oci_configuration_invalid", "OCI state directory must be absolute.");
  }
  const stateDirectory = resolve(options.stateDirectory);
  const statePath = join(stateDirectory, `oci-leases-${providerId}.json`);
  const environmentHandoffRoot = join(stateDirectory, "environment-handoffs");
  const cli = options.cli ?? createNativeOciCli();
  const removeEnvironmentHandoff = options.removeEnvironmentHandoff ?? removePrivateEnvironmentHandoff;
  const writeEnvironmentHandoff = options.writeEnvironmentHandoff ?? writePrivateEnvironmentHandoff;
  const clock = options.clock ?? (() => new Date());
  let cliPath: string | undefined;
  let cliDigest: string | undefined;
  let interactiveAttach = false;
  const attestedImageExecutables = new Set<string>();

  const runCli = async (args: readonly string[]): Promise<OciCliResult> => {
    if (!cliPath) throw ociError("oci_attestation_failed", "OCI provider is not attested.");
    if (cliDigest) {
      const currentPath = await attestExecutable(configuredCli);
      const currentDigest = createHash("sha256").update(await readFile(currentPath)).digest("hex");
      if (normalize(currentPath) !== normalize(cliPath) || currentDigest !== cliDigest) {
        throw ociError("oci_attestation_failed", "Configured OCI CLI identity changed after attestation.");
      }
    }
    return await cli.run({
      executable: cliPath,
      args: Object.freeze([...args]),
      environment: Object.freeze({}),
      timeoutMs: 30_000,
    });
  };
  const runCliDuplex = async (args: readonly string[], input: string): Promise<OciCliResult> => {
    if (!cliPath || !cli.runDuplex) {
      throw ociError("oci_interactive_attach_unavailable", "OCI CLI has no semantic duplex execution seam.");
    }
    if (cliDigest) {
      const currentPath = await attestExecutable(configuredCli);
      const currentDigest = createHash("sha256").update(await readFile(currentPath)).digest("hex");
      if (normalize(currentPath) !== normalize(cliPath) || currentDigest !== cliDigest) {
        throw ociError("oci_attestation_failed", "Configured OCI CLI identity changed after attestation.");
      }
    }
    return await cli.runDuplex({
      executable: cliPath,
      args: Object.freeze([...args]),
      environment: Object.freeze({}),
      timeoutMs: 30_000,
    }, input);
  };

  const settleCreatingRecord = async (
    initialLeases: DurableOciLease[],
    initialOwned: DurableOciLease,
  ): Promise<{ leases: DurableOciLease[]; blockers: string[] }> => {
    let leases = initialLeases;
    let owned = initialOwned;
    const blockers: string[] = [];
    if (owned.environmentHandoffPath) {
      try {
        await removeEnvironmentHandoff(owned.environmentHandoffPath, environmentHandoffRoot);
        const cleared = withoutEnvironmentHandoff(owned);
        leases = leases.map((entry) => entry === owned ? cleared : entry);
        owned = cleared;
        await writeLeaseState(statePath, leases);
      } catch (error) {
        blockers.push(`OCI environment handoff cleanup remains blocked for lease ${owned.lease.leaseId}: ${bounded(error)}.`);
      }
    }
    const discovery = await discoverExactNamedContainer(runCli, owned.containerName, providerId, owned);
    if (discovery.state === "blocked") {
      blockers.push(discovery.detail);
      return { leases, blockers };
    }
    if (discovery.state === "absent") {
      if (!owned.environmentHandoffPath) {
        const pending = pendingCleanup(owned, clock());
        leases = leases.map((entry) => entry === owned ? pending : entry);
        await writeLeaseState(statePath, leases);
      }
      return { leases, blockers };
    }
    const bound: DurableOciLease = {
      ...owned, containerId: discovery.containerId, createStage: "bound", cleanupStage: "cleanup_started",
    };
    leases = leases.map((entry) => entry === owned ? bound : entry);
    owned = bound;
    await writeLeaseState(statePath, leases);
    const removed = await runCli(["rm", "--force", discovery.containerId]);
    if (removed.exitCode !== 0) {
      blockers.push(`Owned container ${discovery.containerId} cleanup failed: ${bounded(removed.stderr)}.`);
      return { leases, blockers };
    }
    if (!owned.environmentHandoffPath) {
      const pending = pendingCleanup(owned, clock());
      leases = leases.map((entry) => entry === owned ? pending : entry);
      await writeLeaseState(statePath, leases);
    }
    return { leases, blockers };
  };

  return Object.freeze({
    async attest() {
      cliPath = await attestExecutable(configuredCli);
      cliDigest = createHash("sha256").update(await readFile(cliPath)).digest("hex");
      if (options.expectedCliIdentity &&
          (normalize(options.expectedCliIdentity.path) !== normalize(cliPath) ||
            options.expectedCliIdentity.digest !== cliDigest)) {
        throw ociError(
          "oci_attestation_failed",
          "Configured OCI CLI differs from the active Build capability contract.",
        );
      }
      const immutableId = await attestImage(runCli, image);
      interactiveAttach = await attestInteractiveAttach(
        runCli,
        runCliDuplex,
        immutableId,
        providerId,
      );
      return deepFreeze({
        attestationVersion: 1 as const,
        providerId,
        verified: true,
        mechanism: "docker-compatible-oci",
        exactGrantWriteConfinement: true,
        interactiveAttach,
        expiresAt: new Date(clock().getTime() + 60_000).toISOString(),
        executableIdentity: { path: cliPath, digest: cliDigest },
        imageIdentity: { configuredReference: image, immutableId },
        capabilities: {
          tree_termination: "enforced" as const,
          crash_cleanup: "partial" as const,
          verified_emptiness: "enforced" as const,
          write_confinement: "enforced" as const,
        },
      });
    },

    async attestExecution(
      intent: ExecutionIsolationAcquireRequest["intent"],
      imageExecutable?: string,
    ) {
      if (!cliPath || !cliDigest) {
        throw ociError("oci_attestation_failed", "OCI provider must be attested before intent attestation.");
      }
      const executable = strictImageExecutable(intent, imageExecutable);
      if (!requiresInteractiveAttach(intent)) return;
      if (!interactiveAttach) {
        throw ociError(
          "oci_interactive_attach_unavailable",
          "Configured OCI CLI does not attest exact interactive create/start attach support.",
        );
      }
      const immutableId = await attestImage(runCli, image);
      const key = imageExecutableKey(immutableId, executable);
      if (!attestedImageExecutables.has(key)) {
        await attestImageExecutable(runCli, immutableId, executable);
        attestedImageExecutables.add(key);
      }
    },

    async acquire(request: ExecutionIsolationAcquireRequest) {
      if (!cliPath || !cliDigest) {
        throw ociError("oci_attestation_failed", "OCI provider must be attested before acquire.");
      }
      if (request.providerId !== providerId ||
          request.intent.runId !== request.grant.runId ||
          request.intent.sessionId !== request.grant.sessionId) {
        throw ociError("oci_grant_unrepresentable", "OCI request does not match its exact grant.");
      }
      const imageExecutable = strictImageExecutable(
        request.intent,
        request.imageExecutable,
      );
      const representation = await representGrant(request, imageExecutable);
      const interactive = requiresInteractiveAttach(request.intent);
      if (interactive && !interactiveAttach) {
        throw ociError(
          "oci_interactive_attach_unavailable",
          "Configured OCI CLI does not attest exact interactive create/start attach support.",
        );
      }
      await withStateLock(statePath, async () => {
        const existing = await readLeaseState(statePath);
        if (existing.length >= MAX_DURABLE_LEASES) throw ociError("oci_create_failed", "OCI durable lease capacity is exhausted.");
      });
      const acquisitionImageId = await attestImage(runCli, image);
      const key = imageExecutableKey(acquisitionImageId, imageExecutable);
      if (!attestedImageExecutables.has(key)) {
        await attestImageExecutable(runCli, acquisitionImageId, imageExecutable);
        attestedImageExecutables.add(key);
      }
      const leaseId = `oci-lease-${randomUUID()}`;
      const containerName = `aiboard-${createHash("sha256")
        .update(`${providerId}\0${request.intent.runId}\0${request.intent.invocationId}\0${leaseId}`)
        .digest("hex").slice(0, 32)}`;
      const labels = [
        `${OWNED_LABEL}=true`,
        `${PROVIDER_LABEL}=${providerId}`,
        `${RUN_LABEL}=${safeLabel(request.intent.runId, "run id")}`,
        `${INVOCATION_LABEL}=${safeLabel(request.intent.invocationId, "invocation id")}`,
        `${GRANT_LABEL}=${safeLabel(request.grant.grantId, "grant id")}`,
        `${IMAGE_LABEL}=${acquisitionImageId}`,
      ];
      const args = ["create", ...(interactive ? ["--interactive"] : []), "--name", containerName];
      for (const label of labels) args.push("--label", label);
      args.push("--network", request.grant.networkApproved && options.allowNetwork === true
        ? "bridge" : "none");
      for (const mount of representation.mounts) args.push("--mount", mount);
      const environmentHandoff = preparePrivateEnvironmentHandoff(
        environmentHandoffRoot,
        // Executable attestation uses the immutable image's own search path.
        // A prepared host child environment can contain Windows PATH/Path or
        // host-only POSIX paths; copying those into the image would invalidate
        // that attestation and even break the image's entrypoint resolution.
        // Other approved child values still use the private handoff, never the
        // Docker control-plane environment. Leave the caller's object intact.
        Object.fromEntries(Object.entries(request.environment ?? {}).filter(([name]) => name.toUpperCase() !== "PATH")),
      );
      const environmentFile = environmentHandoff?.path;
      if (environmentFile) args.push("--env-file", environmentFile);
      args.push("--workdir", representation.cwd, acquisitionImageId, representation.executable);
      args.push(...representation.arguments);
      assertSafeOciArguments(args);
      const acquiredAt = clock().toISOString();
      const lease = deepFreeze({
        leaseId,
        providerId,
        invocationId: request.intent.invocationId,
        grantId: request.grant.grantId,
        grantedAccess: request.grant.access.map((entry) => ({ ...entry })),
        acquiredAt,
        state: "active" as const,
        providerIdentity: request.implementationDigest,
        immutableImageId: acquisitionImageId,
      });
      const creating: DurableOciLease = {
        lease, containerName, runId: request.intent.runId, createStage: "creating", cleanupStage: "cleanup_started",
        ...(environmentFile ? { environmentHandoffPath: environmentFile } : {}),
      };
      try {
        await withStateLock(statePath, async () => {
          const leases = await readLeaseState(statePath);
          leases.push(creating);
          await writeLeaseState(statePath, leases);
        });
      } catch (error) {
        throw ociError("oci_recovery_blocked", "Could not durably journal OCI create intent before launch.", error);
      }
      let containerId: string;
      try {
        await options.acquireBarrier?.("after_create_journal");
        if (environmentHandoff) {
          await writeEnvironmentHandoff(environmentHandoff);
          await options.acquireBarrier?.("after_environment_handoff");
        }
        const created = await runCli(args);
        if (created.exitCode !== 0) {
          throw ociError("oci_create_failed", `OCI container create failed: ${bounded(created.stderr)}.`);
        }
        containerId = created.stdout.trim();
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/.test(containerId)) {
          throw ociError("oci_create_failed", "OCI create returned an invalid container identity.");
        }
        const returnedIdentity = await inspectOwnedContainer(runCli, containerId);
        if (!matchesOwnedScope(returnedIdentity, providerId, creating) ||
            returnedIdentity?.containerName !== containerName) {
          throw ociError("oci_create_failed", "OCI create returned a container that failed exact identity re-attestation.");
        }
        await withStateLock(statePath, async () => {
          const leases = await readLeaseState(statePath);
          const owned = leases.find((entry) => entry.lease.leaseId === leaseId);
          if (!owned || owned.createStage !== "creating") {
            throw ociError("oci_recovery_blocked", "OCI create intent lost durable ownership before identity bind.");
          }
          await writeLeaseState(statePath, leases.map((entry) => entry === owned ? {
            ...owned, containerId, createStage: "bound" as const, cleanupStage: "active" as const,
          } : entry));
        });
      } catch (error) {
        const settled = await withStateLock(statePath, async () => {
          const leases = await readLeaseState(statePath);
          const owned = leases.find((entry) => entry.lease.leaseId === leaseId);
          if (!owned) return { leases, blockers: ["OCI create intent lost durable cleanup ownership."] };
          return await settleCreatingRecord(leases, owned);
        }).catch((cleanupError) => ({ leases: [], blockers: [`OCI create reconciliation failed: ${bounded(cleanupError)}.`] }));
        if (settled.blockers.length > 0) {
          throw ociError("oci_recovery_blocked", settled.blockers.join(" "), error);
        }
        throw error;
      }
      if (environmentFile) {
        try {
          await removeEnvironmentHandoff(environmentFile, environmentHandoffRoot);
          await withStateLock(statePath, async () => {
            const leases = await readLeaseState(statePath);
            await writeLeaseState(statePath, leases.map((entry) => entry.lease.leaseId === leaseId
              ? withoutEnvironmentHandoff(entry) : entry));
          });
        } catch (error) {
          await withStateLock(statePath, async () => {
            const leases = await readLeaseState(statePath);
            const entry = leases.find((candidate) => candidate.lease.leaseId === leaseId);
            if (!entry) throw ociError("oci_recovery_blocked", "Created OCI container lost durable cleanup ownership.");
            const started = { ...entry, cleanupStage: "cleanup_started" as const };
            await writeLeaseState(statePath, leases.map((candidate) => candidate === entry ? started : candidate));
          });
          const cleanup = await runCli(["rm", "--force", containerId]);
          if (cleanup.exitCode === 0) {
            await withStateLock(statePath, async () => {
              const leases = await readLeaseState(statePath);
              const entry = leases.find((candidate) => candidate.lease.leaseId === leaseId);
              if (entry) await writeLeaseState(statePath, leases.map((candidate) => candidate === entry
                ? pendingCleanup(entry, clock()) : candidate));
            });
          }
          throw ociError(
            "oci_recovery_blocked",
            cleanup.exitCode === 0
              ? "OCI environment handoff cleanup failed; container compensation is durably pending acknowledgement."
              : `OCI environment handoff cleanup and container compensation failed: ${bounded(cleanup.stderr)}.`,
            error,
          );
        }
      }
      return lease;
    },

    async release(lease: ExecutionIsolationLease): Promise<void> {
      await withStateLock(statePath, async () => {
        const leases = await readLeaseState(statePath);
        const owned = leases.find((entry) => entry.lease.leaseId === lease.leaseId);
        if (!owned || !owned.containerId || owned.createStage === "creating" || owned.lease.providerId !== providerId ||
            owned.lease.grantId !== lease.grantId || owned.lease.invocationId !== lease.invocationId) {
          throw ociError("oci_release_failed", "OCI lease is not durably owned by this provider.");
        }
        const identity = await inspectOwnedContainer(runCli, owned.containerId);
        if (!matchesOwnedScope(identity, providerId, owned)) {
          throw ociError("oci_release_failed", "OCI container identity no longer matches its durable lease.");
        }
        const removed = await runCli(["rm", "--force", owned.containerId]);
        if (removed.exitCode !== 0) throw ociError("oci_release_failed", `OCI container release failed: ${bounded(removed.stderr)}.`);
        await writeLeaseState(statePath, leases.filter((entry) => entry !== owned));
      });
    },

    async prepareExecution(
      lease: ExecutionIsolationLease,
      intent: ExecutionIsolationAcquireRequest["intent"],
    ) {
      if (!cliPath || !cliDigest) {
        throw ociError("oci_attestation_failed", "OCI provider must be attested before execution.");
      }
      const currentPath = await attestExecutable(configuredCli);
      const currentDigest = createHash("sha256").update(await readFile(currentPath)).digest("hex");
      if (normalize(currentPath) !== normalize(cliPath) || currentDigest !== cliDigest) {
        throw ociError("oci_attestation_failed", "Configured OCI CLI identity changed before execution.");
      }
      const currentImage = await attestImage(runCli, image);
      const leases = await readLeaseState(statePath);
      const owned = leases.find((entry) => entry.lease.leaseId === lease.leaseId);
      if (
        !owned ||
        !owned.containerId ||
        owned.createStage === "creating" ||
        owned.cleanupStage !== "active" ||
        owned.lease.providerId !== providerId ||
        owned.lease.invocationId !== intent.invocationId ||
        owned.lease.invocationId !== lease.invocationId ||
        owned.lease.grantId !== lease.grantId ||
        owned.lease.providerIdentity !== lease.providerIdentity ||
        owned.lease.immutableImageId !== lease.immutableImageId ||
        currentImage !== owned.lease.immutableImageId
      ) {
        throw ociError("oci_attestation_failed", "OCI execution lease identity is no longer exact.");
      }
      const identity = await inspectOwnedContainer(runCli, owned.containerId);
      if (!matchesOwnedScope(identity, providerId, owned)) {
        throw ociError("oci_attestation_failed", "OCI container identity changed before execution.");
      }
      return deepFreeze({
        ...intent,
        executable: cliPath,
        arguments: requiresInteractiveAttach(intent)
          ? ["start", "--attach", "--interactive", owned.containerId]
          : ["start", "--attach", owned.containerId],
      });
    },

    async recoverOwned(): Promise<ExecutionIsolationRecoveryResult> {
      cliPath ??= await attestExecutable(configuredCli);
      cliDigest ??= createHash("sha256").update(await readFile(cliPath)).digest("hex");
      if (options.expectedCliIdentity &&
          (normalize(options.expectedCliIdentity.path) !== normalize(cliPath) ||
            options.expectedCliIdentity.digest !== cliDigest)) {
        throw ociError(
          "oci_attestation_failed",
          "Configured OCI CLI differs from the active Build capability contract.",
        );
      }
      return await withStateLock(statePath, async () => {
      let leases = await readLeaseState(statePath);
      const listed = await runCli([
        "ps", "--all",
        "--no-trunc",
        "--filter", `label=${OWNED_LABEL}=true`,
        "--filter", `label=${PROVIDER_LABEL}=${providerId}`,
        "--format", "{{.ID}}",
      ]);
      if (listed.exitCode !== 0) {
        return { cleaned: 0, blockers: [`OCI owned-container listing failed: ${bounded(listed.stderr)}.`], transitions: [] };
      }
      let cleaned = 0;
      const blockers: string[] = [];
      const transitions: import("./execution-isolation-provider.js").ExecutionIsolationCleanupTransition[] = [];
      for (const owned of [...leases]) {
        if (!owned.environmentHandoffPath) continue;
        try {
          await removeEnvironmentHandoff(owned.environmentHandoffPath, environmentHandoffRoot);
          const cleared = withoutEnvironmentHandoff(owned);
          leases = leases.map((entry) => entry === owned ? cleared : entry);
          await writeLeaseState(statePath, leases);
        } catch (error) {
          blockers.push(`OCI environment handoff cleanup remains blocked for lease ${owned.lease.leaseId}: ${bounded(error)}.`);
        }
      }
      for (const owned of [...leases].filter((entry) => entry.createStage === "creating")) {
        const settled = await settleCreatingRecord(leases, owned);
        leases = settled.leases;
        blockers.push(...settled.blockers);
      }
      const byContainer = new Map(leases.flatMap((entry) => entry.containerId ? [[entry.containerId, entry] as const] : []));
      const remaining = new Set(leases.filter((entry) => entry.createStage !== "creating"));
      for (const owned of leases.filter((entry) => entry.cleanupStage === "cleaned_pending_ack")) {
        if (owned.environmentHandoffPath) continue;
        transitions.push(cleanupTransition(owned, "cleaned"));
        cleaned += 1;
        remaining.delete(owned);
      }
      const listedDurableLeases = new Set<DurableOciLease>();
      for (const containerId of listed.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
        const owned = byContainer.get(containerId);
        if (!owned) {
          blockers.push(`Labelled container ${containerId} has no matching durable Runner lease.`);
          continue;
        }
        if (owned.cleanupStage === "cleaned_pending_ack") continue;
        listedDurableLeases.add(owned);
        const identity = await inspectOwnedContainer(runCli, containerId);
        if (!matchesOwnedScope(identity, providerId, owned)) {
          const blocker = `Labelled container ${containerId} failed owned identity validation.`;
          blockers.push(blocker);
          transitions.push(cleanupTransition(owned, "blocked", blocker));
          continue;
        }
        const started = owned.cleanupStage === "cleanup_started" ? owned : { ...owned, cleanupStage: "cleanup_started" as const };
        if (started !== owned) {
          leases = leases.map((entry) => entry === owned ? started : entry);
          await writeLeaseState(statePath, leases);
        }
        const removed = await runCli(["rm", "--force", containerId]);
        if (removed.exitCode !== 0) {
          const blocker = `Owned container ${containerId} cleanup failed: ${bounded(removed.stderr)}.`;
          blockers.push(blocker);
          transitions.push(cleanupTransition(owned, "blocked", blocker));
          continue;
        }
        remaining.delete(owned);
        const pending = pendingCleanup(started, clock());
        leases = leases.map((entry) => entry === started || entry === owned ? pending : entry);
        await writeLeaseState(statePath, leases);
        cleaned += 1;
        transitions.push(cleanupTransition(pending, "cleaned"));
      }
      for (const owned of remaining) {
        if (listedDurableLeases.has(owned)) continue;
        if (!owned.containerId) continue;
        const absence = await inspectContainerAbsence(runCli, owned.containerId);
        if (absence.absent) {
          remaining.delete(owned);
          const pending = pendingCleanup(owned, clock());
          leases = leases.map((entry) => entry === owned ? pending : entry);
          await writeLeaseState(statePath, leases);
          cleaned += 1;
          transitions.push(cleanupTransition(pending, "cleaned"));
          continue;
        }
        const blocker = `Durable container ${owned.containerId} was omitted from the owned listing and its absence could not be verified: ${absence.detail}.`;
        blockers.push(blocker);
        transitions.push(cleanupTransition(owned, "blocked", blocker));
      }
      await writeLeaseState(statePath, leases);
      return { cleaned, blockers, transitions };
      });
    },

    async acknowledgeRecovery(transitions: readonly ExecutionIsolationCleanupTransition[]) {
      await withStateLock(statePath, async () => {
        const leases = await readLeaseState(statePath);
        const acknowledged = new Set<string>();
        for (const transition of transitions) {
          const owned = leases.find((entry) => entry.lease.leaseId === transition.leaseId);
          if (!owned || owned.cleanupStage !== "cleaned_pending_ack" || owned.cleanupToken !== transition.cleanupToken ||
              owned.lease.providerId !== transition.providerId || owned.lease.providerIdentity !== transition.implementationDigest ||
              owned.lease.invocationId !== transition.invocationId || owned.lease.grantId !== transition.grantId ||
              owned.lease.immutableImageId !== transition.immutableImageId ||
              JSON.stringify(owned.lease.grantedAccess) !== JSON.stringify(transition.access)) {
            throw ociError("oci_recovery_blocked", "OCI cleanup acknowledgement does not match its durable tombstone.");
          }
          acknowledged.add(owned.lease.leaseId);
        }
        await writeLeaseState(statePath, leases.filter((entry) => !acknowledged.has(entry.lease.leaseId)));
      });
    },
  });
}

function pendingCleanup(owned: DurableOciLease, now: Date): DurableOciLease {
  return { ...owned, cleanupStage: "cleaned_pending_ack", cleanupToken: owned.cleanupToken ?? `cleanup-${randomUUID()}`,
    cleanedAt: owned.cleanedAt ?? now.toISOString() };
}

function withoutEnvironmentHandoff(owned: DurableOciLease): DurableOciLease {
  const { environmentHandoffPath: _removed, ...rest } = owned;
  return rest;
}

function cleanupTransition(
  owned: DurableOciLease,
  status: "cleaned" | "blocked",
  blocker?: string,
): import("./execution-isolation-provider.js").ExecutionIsolationCleanupTransition {
  return {
    status, runId: owned.runId, invocationId: owned.lease.invocationId,
    grantId: owned.lease.grantId, leaseId: owned.lease.leaseId,
    providerId: owned.lease.providerId, implementationDigest: owned.lease.providerIdentity,
    ...(owned.lease.immutableImageId ? { immutableImageId: owned.lease.immutableImageId } : {}),
    access: owned.lease.grantedAccess,
    ...(blocker ? { blocker: blocker.slice(0, 512) } : {}),
    ...(status === "cleaned" ? { cleanupToken: owned.cleanupToken, cleanedAt: owned.cleanedAt } : {}),
  };
}

async function representGrant(
  request: ExecutionIsolationAcquireRequest,
  imageExecutable: string,
): Promise<{
  mounts: string[];
  cwd: string;
  executable: string;
  arguments: string[];
}> {
  const workspace = await realDirectory(request.grant.workspacePath, "workspace");
  const cwdHost = await realDirectory(request.intent.workingDirectory, "working directory");
  if (!contained(workspace, cwdHost)) {
    throw ociError("oci_grant_unrepresentable", "OCI working directory must be inside the task workspace.");
  }
  const roots: { host: string; container: string; writable: boolean }[] = [];
  let workspaceWritable = false;
  let externalIndex = 0;
  for (const access of request.grant.access) {
    const host = await realPath(access.canonicalPath, "grant root");
    if (normalize(host) !== normalize(access.canonicalPath)) {
      throw ociError("oci_path_escape", "OCI grant root identity changed after authorization.");
    }
    if (normalize(host) === normalize(parse(host).root)) {
      throw ociError("oci_grant_unrepresentable", "OCI grants cannot mount a filesystem root.");
    }
    if (contained(host, workspace) && normalize(host) !== normalize(workspace)) {
      throw ociError("oci_grant_unrepresentable", "OCI grants cannot broaden to a parent of the workspace.");
    }
    const writable = access.mode === "write" || access.mode === "create";
    if (contained(workspace, host)) {
      if (normalize(host) === normalize(workspace)) {
        workspaceWritable ||= writable;
      } else if (writable) {
        const traversal = relative(workspace, host).split(sep).join("/");
        roots.push({
          host,
          container: `/runner/workspace/${traversal}`,
          writable: true,
        });
      }
      continue;
    }
    roots.push({ host, container: `/runner/grants/${externalIndex}`, writable });
    externalIndex += 1;
  }
  roots.unshift({ host: workspace, container: "/runner/workspace", writable: workspaceWritable });
  const mounts = roots.map((root) => mountArgument(root.host, root.container, root.writable));
  const translate = async (value: string): Promise<string> => {
    if (!isAbsolute(value)) return value;
    await assertNoSymbolicPathComponents(value);
    const actual = await realPath(value, "command path");
    const root = roots.find((candidate) => contained(candidate.host, actual));
    if (!root) {
      throw ociError("oci_grant_unrepresentable", "OCI command contains an ungranted absolute path.");
    }
    const traversal = relative(root.host, actual).split(sep).join("/");
    return traversal ? `${root.container}/${traversal}` : root.container;
  };
  const executable = assertImageRelativeExecutable(imageExecutable);
  const arguments_: string[] = [];
  for (const argument of request.intent.arguments) arguments_.push(await translate(argument));
  const cwdTraversal = relative(workspace, cwdHost).split(sep).join("/");
  return {
    mounts,
    cwd: cwdTraversal ? `/runner/workspace/${cwdTraversal}` : "/runner/workspace",
    executable,
    arguments: arguments_,
  };
}

interface InspectedOwnedContainer {
  readonly labels: Record<string, unknown>;
  readonly imageId: string;
  readonly containerName: string;
}

async function inspectOwnedContainer(
  runCli: (args: readonly string[]) => Promise<OciCliResult>,
  containerId: string,
): Promise<InspectedOwnedContainer | undefined> {
  const inspected = await runCli(["inspect", "--format", "{{json .Config.Labels}}", containerId]);
  if (inspected.exitCode !== 0) return undefined;
  try {
    const labels = JSON.parse(inspected.stdout) as unknown;
    if (!labels || typeof labels !== "object" || Array.isArray(labels)) return undefined;
    const image = await runCli(["inspect", "--format", "{{.Image}}", containerId]);
    const name = await runCli(["inspect", "--format", "{{.Name}}", containerId]);
    const imageId = image.stdout.trim();
    const containerName = name.stdout.trim().replace(/^\//, "");
    return image.exitCode === 0 && name.exitCode === 0 && containerName.length > 0 &&
      /^sha256:[a-f0-9]{64}$/.test(imageId)
      ? { labels: labels as Record<string, unknown>, imageId, containerName } : undefined;
  } catch {
    return undefined;
  }
}

async function discoverExactNamedContainer(
  runCli: (args: readonly string[]) => Promise<OciCliResult>,
  containerName: string,
  providerId: string,
  owned: DurableOciLease,
): Promise<{ state: "absent" } | { state: "found"; containerId: string } | { state: "blocked"; detail: string }> {
  let inspected: OciCliResult;
  try {
    inspected = await runCli(["inspect", "--format", "{{.Id}}", containerName]);
  } catch (error) {
    return { state: "blocked", detail: `Exact OCI container discovery threw: ${bounded(error)}.` };
  }
  if (inspected.exitCode !== 0) {
    const detail = bounded(inspected.stderr || inspected.stdout);
    return /\b(?:no such (?:object|container)|not found)\b/i.test(detail)
      ? { state: "absent" }
      : { state: "blocked", detail: `Exact OCI container discovery failed: ${detail || "unclassified failure"}.` };
  }
  const containerId = inspected.stdout.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/.test(containerId)) {
    return { state: "blocked", detail: "Exact OCI container discovery returned an invalid identity." };
  }
  let identity: InspectedOwnedContainer | undefined;
  try { identity = await inspectOwnedContainer(runCli, containerId); }
  catch (error) {
    return { state: "blocked", detail: `Exact OCI identity inspection threw: ${bounded(error)}.` };
  }
  return matchesOwnedScope(identity, providerId, owned)
      && identity?.containerName === containerName
    ? { state: "found", containerId }
    : { state: "blocked", detail: `Exact named container ${containerName} failed owned identity validation.` };
}

async function inspectContainerAbsence(
  runCli: (args: readonly string[]) => Promise<OciCliResult>,
  containerId: string,
): Promise<{ absent: true } | { absent: false; detail: string }> {
  const inspected = await runCli(["inspect", "--format", "{{json .Config.Labels}}", containerId]);
  if (inspected.exitCode === 0) {
    return { absent: false, detail: "the container still exists" };
  }
  const detail = bounded(inspected.stderr || inspected.stdout);
  if (/\b(?:no such (?:object|container)|not found)\b/i.test(detail)) {
    return { absent: true };
  }
  return { absent: false, detail: detail || "the OCI CLI returned an unclassified inspection failure" };
}

function matchesOwnedScope(
  identity: InspectedOwnedContainer | undefined,
  providerId: string,
  owned: DurableOciLease,
): boolean {
  const labels = identity?.labels;
  return labels?.[OWNED_LABEL] === "true" &&
    labels[PROVIDER_LABEL] === providerId &&
    labels[RUN_LABEL] === owned.runId &&
    labels[INVOCATION_LABEL] === owned.lease.invocationId &&
    labels[GRANT_LABEL] === owned.lease.grantId &&
    typeof owned.lease.immutableImageId === "string" &&
    labels[IMAGE_LABEL] === owned.lease.immutableImageId &&
    identity?.imageId === owned.lease.immutableImageId;
}

async function attestExecutable(input: string): Promise<string> {
  try {
    await assertNoSymbolicPathComponents(input);
    const metadata = await lstat(input);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error();
    const actual = resolve(await realpath(input));
    if (normalize(actual) !== normalize(input)) throw new Error();
    return actual;
  } catch (error) {
    throw ociError("oci_cli_unavailable", "Configured OCI CLI is unavailable or not canonical.", error);
  }
}

async function attestImage(
  runCli: (args: readonly string[]) => Promise<OciCliResult>,
  image: string,
): Promise<string> {
  const inspected = await runCli(["image", "inspect", "--format", "{{.Id}}", image]);
  if (inspected.exitCode !== 0) {
    throw ociError("oci_image_unavailable", `Configured OCI image is unavailable: ${bounded(inspected.stderr)}.`);
  }
  const immutableId = inspected.stdout.trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(immutableId)) {
    throw ociError("oci_attestation_failed", "OCI image did not resolve to an immutable id.");
  }
  return immutableId;
}

async function attestInteractiveAttach(
  runCli: (args: readonly string[]) => Promise<OciCliResult>,
  runCliDuplex: (args: readonly string[], input: string) => Promise<OciCliResult>,
  immutableImageId: string,
  providerId: string,
): Promise<boolean> {
  if (!(await cleanupOwnedProbeContainers(runCli, providerId))) {
    throw ociError("oci_attestation_failed", "Stale owned OCI capability probes could not be cleaned.");
  }
  const probeName = `aiboard-probe-${createHash("sha256")
    .update(`${providerId}\0${randomUUID()}`)
    .digest("hex").slice(0, 32)}`;
  const token = `runner-v2-${randomUUID()}`;
  let probeIdentity: string | undefined;
  let result = false;
  try {
    const created = await runCli([
      "create",
      "--interactive",
      "--name", probeName,
      "--label", `${OWNED_LABEL}=true`,
      "--label", `${PROVIDER_LABEL}=${providerId}`,
      "--label", `${PROBE_LABEL}=true`,
      "--network", "none",
      "--read-only",
      "--entrypoint", "/bin/sh",
      immutableImageId,
      "-c", 'IFS= read -r token; printf "%s" "$token"',
    ]);
    if (created.exitCode !== 0) return false;
    const candidate = created.stdout.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/.test(candidate)) {
      throw ociError("oci_attestation_failed", "OCI duplex probe returned an invalid container identity.");
    }
    probeIdentity = candidate;
    const attached = await runCliDuplex(
      ["start", "--attach", "--interactive", probeIdentity],
      `${token}\n`,
    );
    result = attached.exitCode === 0 && attached.stdout === token;
  } catch (error) {
    if (error instanceof OciExecutionIsolationError && error.code === "oci_attestation_failed") throw error;
    result = false;
  } finally {
    const identity = probeIdentity ?? probeName;
    const removed = await runCli(["rm", "--force", identity]);
    if (removed.exitCode !== 0 && !isOciAbsent(removed)) {
      throw ociError("oci_attestation_failed", "Owned OCI duplex probe cleanup failed.");
    }
    const inspected = await runCli(["inspect", "--format", "{{.Id}}", identity]);
    if (inspected.exitCode === 0 || !isOciAbsent(inspected)) {
      throw ociError("oci_attestation_failed", "Owned OCI duplex probe absence could not be verified.");
    }
    if (!(await cleanupOwnedProbeContainers(runCli, providerId))) {
      throw ociError("oci_attestation_failed", "Owned OCI capability probe residue remains.");
    }
  }
  return result;
}

async function cleanupOwnedProbeContainers(
  runCli: (args: readonly string[]) => Promise<OciCliResult>,
  providerId: string,
): Promise<boolean> {
  const listed = await runCli([
    "ps", "--all", "--quiet",
    "--filter", `label=${OWNED_LABEL}=true`,
    "--filter", `label=${PROVIDER_LABEL}=${providerId}`,
    "--filter", `label=${PROBE_LABEL}=true`,
  ]);
  if (listed.exitCode !== 0) return false;
  const identities = listed.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  if (identities.some((identity) => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/.test(identity))) return false;
  for (const identity of identities) {
    const inspected = await runCli(["inspect", "--format", "{{json .Config.Labels}}", identity]);
    if (inspected.exitCode !== 0) {
      if (isOciAbsent(inspected)) continue;
      return false;
    }
    let labels: Record<string, unknown>;
    try {
      const parsed = JSON.parse(inspected.stdout) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
      labels = parsed as Record<string, unknown>;
    } catch {
      return false;
    }
    if (labels[OWNED_LABEL] !== "true" || labels[PROVIDER_LABEL] !== providerId ||
        labels[PROBE_LABEL] !== "true") return false;
    const removed = await runCli(["rm", "--force", identity]);
    if (removed.exitCode !== 0 && !isOciAbsent(removed)) return false;
    const absent = await runCli(["inspect", "--format", "{{.Id}}", identity]);
    if (absent.exitCode === 0 || !isOciAbsent(absent)) return false;
  }
  return true;
}

function isOciAbsent(result: OciCliResult): boolean {
  return result.exitCode !== 0 && /\b(?:no such (?:object|container)|not found)\b/i
    .test(result.stderr || result.stdout);
}

async function attestImageExecutable(
  runCli: (args: readonly string[]) => Promise<OciCliResult>,
  immutableImageId: string,
  executable: string,
): Promise<void> {
  const requested = safeText(executable, "image executable", 4096);
  const result = await runCli([
    "run",
    "--rm",
    "--network", "none",
    "--read-only",
    "--entrypoint", "/bin/sh",
    immutableImageId,
    "-c", 'command -v "$1" >/dev/null 2>&1',
    "runner-v2-executable-probe",
    requested,
  ]);
  if (result.exitCode !== 0) {
    throw ociError(
      "oci_image_executable_unavailable",
      "Requested executable is unavailable in the configured immutable OCI image.",
    );
  }
}

function imageExecutableKey(immutableImageId: string, executable: string): string {
  return `${immutableImageId}\0${executable}`;
}

function assertImageRelativeExecutable(executable: string): string {
  const requested = safeText(executable, "image executable", 4096);
  if (isAbsolute(requested) || /^[a-zA-Z]:[\\/]/u.test(requested) || requested.startsWith("\\\\")) {
    throw ociError(
      "oci_grant_unrepresentable",
      "Strict OCI execution requires an image-relative executable; host executables are forbidden.",
    );
  }
  return requested;
}

function strictImageExecutable(
  intent: ExecutionIsolationAcquireRequest["intent"],
  imageExecutable?: string,
): string {
  return assertImageRelativeExecutable(imageExecutable ?? intent.executable);
}

function requiresInteractiveAttach(
  intent: ExecutionIsolationAcquireRequest["intent"],
): boolean {
  return intent.kind === "mcp_server" || intent.kind === "language_server";
}

async function withStateLock<T>(statePath: string, action: () => Promise<T>): Promise<T> {
  const lockPath = `${statePath}.lock`;
  try {
    return await withOwnedFenceLock(lockPath, action, {
      deadlineMs: STATE_LOCK_TIMEOUT_MS,
      retryDelayMs: 10,
      retireAfterEffect: false,
    });
  } catch (error) {
    if (error instanceof OciExecutionIsolationError) throw error;
    throw ociError(
      "oci_recovery_blocked",
      "OCI durable lease state lock is unavailable.",
      error,
    );
  }
}

async function realDirectory(input: string, label: string): Promise<string> {
  await assertNoSymbolicPathComponents(input);
  const metadata = await lstat(input);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw ociError("oci_path_escape", `OCI ${label} must be a real directory.`);
  }
  return resolve(await realpath(input));
}

async function realPath(input: string, label: string): Promise<string> {
  if (!isAbsolute(input) || input.includes("\0")) {
    throw ociError("oci_grant_unrepresentable", `OCI ${label} must be absolute.`);
  }
  await assertNoSymbolicPathComponents(input);
  try {
    return resolve(await realpath(input));
  } catch (error) {
    throw ociError("oci_grant_unrepresentable", `OCI ${label} must exist before launch.`, error);
  }
}

async function assertNoSymbolicPathComponents(input: string): Promise<void> {
  const candidate = resolve(input);
  const root = parse(candidate).root;
  let current = root;
  for (const segment of relative(root, candidate).split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw ociError("oci_path_escape", `OCI path crosses symbolic component ${current}.`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

function mountArgument(host: string, container: string, writable: boolean): string {
  if (/[\r\n,]/.test(host) || /[\r\n,]/.test(container)) {
    throw ociError("oci_grant_unrepresentable", "OCI mount path is not representable safely.");
  }
  return `type=bind,src=${host},dst=${container}${writable ? "" : ",readonly"}`;
}

function assertSafeOciArguments(args: readonly string[]): void {
  const forbidden = ["--privileged", "--pid=host", "/var/run/docker.sock"];
  if (args.some((argument) => forbidden.some((value) => argument.includes(value)))) {
    throw ociError("oci_grant_unrepresentable", "OCI invocation requested a forbidden host boundary.");
  }
}

async function readLeaseState(path: string): Promise<DurableOciLease[]> {
  try {
    const handle = await open(path, "r");
    let text: string;
    try {
      const stat = await handle.stat();
      if (stat.size > MAX_LEASE_STATE_BYTES) throw new Error();
      const buffer = Buffer.alloc(MAX_LEASE_STATE_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_LEASE_STATE_BYTES) throw new Error();
      text = buffer.subarray(0, bytesRead).toString("utf8");
    } finally { await handle.close(); }
    const parsed = JSON.parse(text) as unknown;
    return parseLeaseState(parsed, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw ociError("oci_recovery_blocked", "OCI durable lease state is unreadable.", error);
  }
}

function parseLeaseState(value: unknown, path: string): DurableOciLease[] {
  if (!Array.isArray(value) || value.length > MAX_DURABLE_LEASES) throw new Error();
  const leaseIds = new Set<string>();
  const containerIds = new Set<string>();
  return value.map((value) => {
      const row = exactLeaseObject(value, ["lease", "containerId", "containerName", "runId", "createStage", "cleanupStage", "cleanupToken", "cleanedAt", "environmentHandoffPath"]);
      const lease = exactLeaseObject(row.lease, ["leaseId", "providerId", "invocationId", "grantId", "grantedAccess", "acquiredAt", "expiresAt", "state", "providerIdentity", "immutableImageId"]);
      const textField = (input: unknown, pattern?: RegExp) => {
        if (typeof input !== "string" || !input || input.length > 512 || input.includes("\0") || (pattern && !pattern.test(input))) throw new Error();
        return input;
      };
      const leaseId = textField(lease.leaseId);
      const createStage = row.createStage === undefined ? "bound" : row.createStage;
      if (createStage !== "creating" && createStage !== "bound") throw new Error();
      const containerId = row.containerId === undefined ? undefined
        : textField(row.containerId, /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/);
      if ((createStage === "bound") !== (containerId !== undefined) || leaseIds.has(leaseId) ||
          (containerId !== undefined && containerIds.has(containerId))) throw new Error();
      leaseIds.add(leaseId); if (containerId) containerIds.add(containerId);
      if (lease.providerId !== pathProviderId(path) || lease.state !== "active" ||
          !Array.isArray(lease.grantedAccess) || lease.grantedAccess.length > MAX_DURABLE_ACCESS ||
          typeof lease.providerIdentity !== "string" || !/^[a-f0-9]{64}$/.test(lease.providerIdentity) ||
          typeof lease.immutableImageId !== "string" || !/^sha256:[a-f0-9]{64}$/.test(lease.immutableImageId) ||
          !canonicalTimestamp(lease.acquiredAt) || (lease.expiresAt !== undefined && !canonicalTimestamp(lease.expiresAt))) throw new Error();
      const accessSeen = new Map<string, string>();
      const access = lease.grantedAccess.map((entry) => {
        const item = exactLeaseObject(entry, ["canonicalPath", "mode"]);
        const canonicalPath = textField(item.canonicalPath);
        if (!isAbsolute(canonicalPath) || resolve(canonicalPath) !== canonicalPath || !["read", "write", "create"].includes(String(item.mode))) throw new Error();
        const key = process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath;
        if (accessSeen.has(key)) throw new Error();
        accessSeen.set(key, String(item.mode));
        return { canonicalPath, mode: item.mode as "read" | "write" | "create" };
      });
      const runId = textField(row.runId);
      const invocationId = textField(lease.invocationId);
      const expectedName = `aiboard-${createHash("sha256").update(`${lease.providerId}\0${runId}\0${invocationId}\0${leaseId}`).digest("hex").slice(0, 32)}`;
      const containerName = textField(row.containerName, /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/);
      if (containerName !== expectedName) throw new Error();
      const cleanupStage = row.cleanupStage === undefined ? "active" : row.cleanupStage;
      if (!["active", "cleanup_started", "cleaned_pending_ack"].includes(String(cleanupStage)) ||
          (createStage === "creating" && cleanupStage === "active") ||
          (cleanupStage === "cleaned_pending_ack") !== (row.cleanupToken !== undefined && row.cleanedAt !== undefined) ||
          (cleanupStage !== "cleaned_pending_ack" && (row.cleanupToken !== undefined || row.cleanedAt !== undefined)) ||
          (row.cleanedAt !== undefined && !canonicalTimestamp(row.cleanedAt))) throw new Error();
      const environmentHandoffPath = row.environmentHandoffPath === undefined
        ? undefined : textField(row.environmentHandoffPath);
      if (environmentHandoffPath !== undefined && (
        !isAbsolute(environmentHandoffPath) || resolve(environmentHandoffPath) !== environmentHandoffPath ||
        normalize(dirname(environmentHandoffPath)) !== normalize(join(dirname(path), "environment-handoffs")) ||
        !/^environment-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.env$/i.test(basename(environmentHandoffPath))
      )) throw new Error();
      return {
        lease: {
          leaseId, providerId: textField(lease.providerId), invocationId, grantId: textField(lease.grantId),
          grantedAccess: access, acquiredAt: textField(lease.acquiredAt), ...(lease.expiresAt === undefined ? {} : { expiresAt: textField(lease.expiresAt) }),
          state: "active" as const, providerIdentity: lease.providerIdentity, immutableImageId: lease.immutableImageId,
        },
        ...(containerId === undefined ? {} : { containerId }), containerName, runId,
        createStage: createStage as DurableOciLease["createStage"],
        cleanupStage: cleanupStage as DurableOciLease["cleanupStage"],
        ...(row.cleanupToken === undefined ? {} : { cleanupToken: textField(row.cleanupToken) }),
        ...(row.cleanedAt === undefined ? {} : { cleanedAt: textField(row.cleanedAt) }),
        ...(environmentHandoffPath === undefined ? {} : { environmentHandoffPath }),
      };
  });
}

function exactLeaseObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !keys.includes(key))) throw new Error();
  return object;
}

function pathProviderId(path: string): string {
  const match = /oci-leases-(.+)\.json$/.exec(path);
  if (!match) throw new Error();
  return match[1]!;
}

async function writeLeaseState(path: string, leases: readonly DurableOciLease[]): Promise<void> {
  if (leases.length > MAX_DURABLE_LEASES) throw ociError("oci_recovery_blocked", "OCI durable lease capacity is exceeded.");
  const serialized = JSON.stringify(leases);
  if (Buffer.byteLength(serialized) > MAX_LEASE_STATE_BYTES) throw ociError("oci_recovery_blocked", "OCI durable lease state exceeds its byte bound.");
  parseLeaseState(JSON.parse(serialized), path);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, serialized, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function canonicalTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 512 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function createNativeOciCli(options: {
  readonly spawnProcess?: typeof spawn;
  readonly terminationGraceMs?: number;
} = {}): OciCli {
  const spawnProcess = options.spawnProcess ?? spawn;
  const terminationGraceMs = options.terminationGraceMs ?? 1_000;
  const execute = async (invocation: OciCliInvocation, input?: string): Promise<OciCliResult> => {
      return await new Promise((resolvePromise, reject) => {
        const child = spawnProcess(invocation.executable, [...invocation.args], {
          env: { ...invocation.environment },
          stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let settled = false;
        let grace: NodeJS.Timeout | undefined;
        const settle = (action: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (grace) clearTimeout(grace);
          child.removeAllListeners();
          child.stdout?.removeAllListeners();
          child.stderr?.removeAllListeners();
          child.stdin?.removeAllListeners();
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.stdin?.destroy();
          child.unref();
          action();
        };
        const append = (target: Buffer[], chunk: Buffer, stream: "stdout" | "stderr") => {
          const next = (stream === "stdout" ? stdoutBytes : stderrBytes) + chunk.byteLength;
          if (next > MAX_CLI_OUTPUT_BYTES) {
            try { child.kill("SIGKILL"); } catch { /* settle still closes local handles */ }
            settle(() => reject(ociError("oci_attestation_failed", "OCI CLI output exceeded its bound.")));
            return;
          }
          if (stream === "stdout") stdoutBytes = next; else stderrBytes = next;
          target.push(Buffer.from(chunk));
        };
        child.stdout?.on("data", (chunk: Buffer) => append(stdout, chunk, "stdout"));
        child.stderr?.on("data", (chunk: Buffer) => append(stderr, chunk, "stderr"));
        child.once("error", (error) => settle(() => reject(error)));
        if (input !== undefined) child.stdin?.end(input, "utf8");
        const timer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* bounded grace still settles */ }
          grace = setTimeout(() => settle(() => reject(ociError(
            "oci_attestation_failed",
            "OCI CLI exceeded its bounded timeout and termination grace.",
          ))), terminationGraceMs);
        }, invocation.timeoutMs);
        child.once("close", (code) => {
          settle(() => resolvePromise({
            exitCode: code ?? 1,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          }));
        });
      });
  };
  return Object.freeze({
    async run(invocation: OciCliInvocation): Promise<OciCliResult> {
      return await execute(invocation);
    },
    async runDuplex(invocation: OciCliInvocation, input: string): Promise<OciCliResult> {
      return await execute(invocation, input);
    },
  });
}

function safeText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") ||
      Buffer.byteLength(value) > maximum) {
    throw ociError("oci_configuration_invalid", `OCI ${label} is invalid.`);
  }
  return value;
}

function safeLabel(value: unknown, label: string): string {
  const text = safeText(value, label, 256);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/.test(text)) {
    throw ociError("oci_configuration_invalid", `OCI ${label} cannot be represented as a label.`);
  }
  return text;
}

function contained(root: string, candidate: string): boolean {
  const traversal = relative(root, candidate);
  return traversal === "" || (!traversal.startsWith("..") && !isAbsolute(traversal));
}

function normalize(path: string): string {
  const value = resolve(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function bounded(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text.length <= 512 ? text : `${text.slice(0, 512)}…`;
}

function preparePrivateEnvironmentHandoff(
  root: string,
  environment: Readonly<Record<string, string>>,
): PreparedEnvironmentHandoff | undefined {
  const entries = Object.entries(environment).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return undefined;
  const lines = entries.map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /[\0\r\n]/.test(value)) {
      throw ociError(
        "oci_environment_unrepresentable",
        "Prepared child environment cannot be represented by a private OCI handoff.",
      );
    }
    return `${name}=${value}`;
  });
  const path = join(root, `environment-${randomUUID()}.env`);
  return { path, root, contents: `${lines.join("\n")}\n` };
}

async function writePrivateEnvironmentHandoff(
  prepared: PreparedEnvironmentHandoff,
): Promise<void> {
  await mkdir(prepared.root, { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(prepared.path, "wx", 0o600);
    await handle.writeFile(prepared.contents, "utf8");
    await handle.sync();
  } catch (error) {
    await rm(prepared.path, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await handle?.close();
  }
}

async function removePrivateEnvironmentHandoff(path: string, root: string): Promise<void> {
  await rm(path, { force: true });
  await rmdir(root).catch((error) => {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw error;
    }
  });
}

function ociError(
  code: OciExecutionIsolationErrorCode,
  message: string,
  cause?: unknown,
): OciExecutionIsolationError {
  return new OciExecutionIsolationError(code, message, cause === undefined ? undefined : { cause });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
