import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

import type {
  ExecutionIsolationAcquireRequest,
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
import type { RunnerCapabilitiesConfig } from "./runner-capabilities-config.js";

const OWNED_LABEL = "ai-board.runner-v2.owned";
const PROVIDER_LABEL = "ai-board.runner-v2.provider";
const RUN_LABEL = "ai-board.runner-v2.run";
const INVOCATION_LABEL = "ai-board.runner-v2.invocation";
const GRANT_LABEL = "ai-board.runner-v2.grant";
const MAX_CLI_OUTPUT_BYTES = 1024 * 1024;

export type OciExecutionIsolationErrorCode =
  | "oci_configuration_invalid"
  | "oci_cli_unavailable"
  | "oci_image_unavailable"
  | "oci_attestation_failed"
  | "oci_grant_unrepresentable"
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
}

interface DurableOciLease {
  readonly lease: ExecutionIsolationLease;
  readonly containerId: string;
  readonly containerName: string;
  readonly runId: string;
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
  ));
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
  const statePath = join(resolve(options.stateDirectory), `oci-leases-${providerId}.json`);
  const cli = options.cli ?? createNativeOciCli();
  const clock = options.clock ?? (() => new Date());
  let cliPath: string | undefined;
  let cliDigest: string | undefined;
  let imageId: string | undefined;

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
      const inspected = await runCli(["image", "inspect", "--format", "{{.Id}}", image]);
      if (inspected.exitCode !== 0) {
        throw ociError(
          "oci_image_unavailable",
          `Configured OCI image is unavailable: ${bounded(inspected.stderr)}.`,
        );
      }
      const immutableId = inspected.stdout.trim();
      if (!/^sha256:[a-f0-9]{64}$/.test(immutableId)) {
        throw ociError("oci_attestation_failed", "OCI image did not resolve to an immutable id.");
      }
      imageId = immutableId;
      return deepFreeze({
        attestationVersion: 1 as const,
        providerId,
        verified: true,
        mechanism: "docker-compatible-oci",
        exactGrantWriteConfinement: true,
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

    async acquire(request: ExecutionIsolationAcquireRequest) {
      if (!cliPath || !cliDigest || !imageId) {
        throw ociError("oci_attestation_failed", "OCI provider must be attested before acquire.");
      }
      if (request.providerId !== providerId ||
          request.intent.runId !== request.grant.runId ||
          request.intent.sessionId !== request.grant.sessionId) {
        throw ociError("oci_grant_unrepresentable", "OCI request does not match its exact grant.");
      }
      const representation = await representGrant(request);
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
      ];
      const args = ["create", "--name", containerName];
      for (const label of labels) args.push("--label", label);
      args.push("--network", request.grant.networkApproved && options.allowNetwork === true
        ? "bridge" : "none");
      for (const mount of representation.mounts) args.push("--mount", mount);
      args.push("--workdir", representation.cwd, imageId, representation.executable);
      args.push(...representation.arguments);
      assertSafeOciArguments(args);
      const created = await runCli(args);
      if (created.exitCode !== 0) {
        throw ociError("oci_create_failed", `OCI container create failed: ${bounded(created.stderr)}.`);
      }
      const containerId = created.stdout.trim();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/.test(containerId)) {
        throw ociError("oci_create_failed", "OCI create returned an invalid container identity.");
      }
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
      });
      const leases = await readLeaseState(statePath);
      leases.push({ lease, containerId, containerName, runId: request.intent.runId });
      try {
        await writeLeaseState(statePath, leases);
      } catch (error) {
        const cleanup = await runCli(["rm", "--force", containerId]);
        throw new AggregateError(
          [error, ...(cleanup.exitCode === 0 ? [] : [new Error(bounded(cleanup.stderr))])],
          "Could not durably own newly created OCI container.",
        );
      }
      return lease;
    },

    async release(lease: ExecutionIsolationLease): Promise<void> {
      const leases = await readLeaseState(statePath);
      const owned = leases.find((entry) => entry.lease.leaseId === lease.leaseId);
      if (!owned || owned.lease.providerId !== providerId ||
          owned.lease.grantId !== lease.grantId ||
          owned.lease.invocationId !== lease.invocationId) {
        throw ociError("oci_release_failed", "OCI lease is not durably owned by this provider.");
      }
      const identity = await inspectOwnedLabels(runCli, owned.containerId);
      if (!matchesOwnedScope(identity, providerId, owned)) {
        throw ociError("oci_release_failed", "OCI container identity no longer matches its durable lease.");
      }
      const removed = await runCli(["rm", "--force", owned.containerId]);
      if (removed.exitCode !== 0) {
        throw ociError("oci_release_failed", `OCI container release failed: ${bounded(removed.stderr)}.`);
      }
      await writeLeaseState(statePath, leases.filter((entry) => entry !== owned));
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
      const leases = await readLeaseState(statePath);
      const byContainer = new Map(leases.map((entry) => [entry.containerId, entry]));
      const listed = await runCli([
        "ps", "--all",
        "--filter", `label=${OWNED_LABEL}=true`,
        "--filter", `label=${PROVIDER_LABEL}=${providerId}`,
        "--format", "{{.ID}}",
      ]);
      if (listed.exitCode !== 0) {
        return { cleaned: 0, blockers: [`OCI owned-container listing failed: ${bounded(listed.stderr)}.`] };
      }
      let cleaned = 0;
      const blockers: string[] = [];
      const remaining = new Set(leases);
      const listedDurableLeases = new Set<DurableOciLease>();
      for (const containerId of listed.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
        const owned = byContainer.get(containerId);
        if (!owned) {
          blockers.push(`Labelled container ${containerId} has no matching durable Runner lease.`);
          continue;
        }
        listedDurableLeases.add(owned);
        const labels = await inspectOwnedLabels(runCli, containerId);
        if (!matchesOwnedScope(labels, providerId, owned)) {
          blockers.push(`Labelled container ${containerId} failed owned identity validation.`);
          continue;
        }
        const removed = await runCli(["rm", "--force", containerId]);
        if (removed.exitCode !== 0) {
          blockers.push(`Owned container ${containerId} cleanup failed: ${bounded(removed.stderr)}.`);
          continue;
        }
        remaining.delete(owned);
        cleaned += 1;
      }
      for (const owned of remaining) {
        if (listedDurableLeases.has(owned)) continue;
        const absence = await inspectContainerAbsence(runCli, owned.containerId);
        if (absence.absent) {
          remaining.delete(owned);
          cleaned += 1;
          continue;
        }
        blockers.push(
          `Durable container ${owned.containerId} was omitted from the owned listing and its absence could not be verified: ${absence.detail}.`,
        );
      }
      await writeLeaseState(statePath, [...remaining]);
      return { cleaned, blockers };
    },
  });
}

async function representGrant(request: ExecutionIsolationAcquireRequest): Promise<{
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
  const executable = await translate(request.intent.executable);
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

async function inspectOwnedLabels(
  runCli: (args: readonly string[]) => Promise<OciCliResult>,
  containerId: string,
): Promise<Record<string, unknown> | undefined> {
  const inspected = await runCli(["inspect", "--format", "{{json .Config.Labels}}", containerId]);
  if (inspected.exitCode !== 0) return undefined;
  try {
    const labels = JSON.parse(inspected.stdout) as unknown;
    return labels && typeof labels === "object" && !Array.isArray(labels)
      ? labels as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
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
  labels: Record<string, unknown> | undefined,
  providerId: string,
  owned: DurableOciLease,
): boolean {
  return labels?.[OWNED_LABEL] === "true" &&
    labels[PROVIDER_LABEL] === providerId &&
    labels[RUN_LABEL] === owned.runId &&
    labels[INVOCATION_LABEL] === owned.lease.invocationId &&
    labels[GRANT_LABEL] === owned.lease.grantId;
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
    const parsed = JSON.parse((await readFile(path)).toString("utf8")) as unknown;
    if (!Array.isArray(parsed)) throw new Error();
    return parsed as DurableOciLease[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw ociError("oci_recovery_blocked", "OCI durable lease state is unreadable.", error);
  }
}

async function writeLeaseState(path: string, leases: readonly DurableOciLease[]): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(leases), { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function createNativeOciCli(): OciCli {
  return Object.freeze({
    async run(invocation: OciCliInvocation): Promise<OciCliResult> {
      return await new Promise((resolvePromise, reject) => {
        const child = spawn(invocation.executable, [...invocation.args], {
          env: { ...invocation.environment },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        const append = (target: Buffer[], chunk: Buffer, stream: "stdout" | "stderr") => {
          const next = (stream === "stdout" ? stdoutBytes : stderrBytes) + chunk.byteLength;
          if (next > MAX_CLI_OUTPUT_BYTES) {
            child.kill("SIGKILL");
            reject(ociError("oci_attestation_failed", "OCI CLI output exceeded its bound."));
            return;
          }
          if (stream === "stdout") stdoutBytes = next; else stderrBytes = next;
          target.push(Buffer.from(chunk));
        };
        child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk, "stdout"));
        child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk, "stderr"));
        child.once("error", reject);
        const timer = setTimeout(() => child.kill("SIGKILL"), invocation.timeoutMs);
        child.once("close", (code) => {
          clearTimeout(timer);
          resolvePromise({
            exitCode: code ?? 1,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          });
        });
      });
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
