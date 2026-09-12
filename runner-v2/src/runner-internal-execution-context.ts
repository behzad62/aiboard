import { hashExecutableDescriptor } from "./mcp-executable-digest.js";
import { McpRpcPeer, parseMcpToolList } from "./mcp-rpc-peer.js";
import { McpConfigurationError, parseMcpCommand, snapshotMcpServerSpec, mcpConfigurationDigest, fixedMcpEnvelope, type McpFixedEnvelope } from "./mcp-configuration.js";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";

import {
  checkGit,
  createBoundedGitCommandExecutor,
  type GitCommandExecutor,
  type GitPreflightResult,
} from "./git-preflight.js";
import type { McpServerSpec } from "./mcp-tools.js";
import {
  attestRunnerCapabilitiesLanguageServers,
} from "./runner-capability-contract.js";
import type { RunnerCapabilitiesConfig } from "./runner-capabilities-config.js";
import { runnerRunStateSegment } from "./run-state-identity.js";
import { isSensitiveKey } from "./sensitive-redaction.js";
import {
  createRunnerInternalProcessKernel,
  type RunnerInternalOwnedProcess,
  type RunnerInternalProcessKernel,
} from "./runner-internal-process-kernel.js";

const MAX_MCP_LINE_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000;
const DEFAULT_TERMINATION_TIMEOUT_MS = 15_000;
const GIT_PREFLIGHT_TIMEOUT_MS = 30_000;
const GIT_PREFLIGHT_TERMINATION_TIMEOUT_MS = 15_000;


export interface RunnerInternalPrincipal {
  readonly role: "runner_internal";
  readonly purpose: "git_preflight" | "mcp_discovery";
  readonly principalId: string;
  readonly callId: string;
  readonly runId?: string;
  readonly deadlineMs: number;
}

export interface McpConfigurationAttestation {
  readonly name: string;
  readonly configDigest: string;
  readonly executableDigest: string;
}

export interface RunnerConfiguredCapabilitiesAttestation {
  readonly mcp: readonly McpConfigurationAttestation[];
  readonly lsp: readonly Readonly<{
    id: string;
    descriptorDigest: string;
    executableDigest?: string;
  }>[];
}

export interface McpDiscoveryTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  readonly annotations?: Readonly<{
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  }>;
}

export interface McpDiscoveryResult {
  readonly version: 1;
  readonly runId: string;
  readonly principal: RunnerInternalPrincipal;
  readonly servers: readonly Readonly<{
    name: string;
    configDigest: string;
    executableDigest: string;
    status: "ready" | "error";
    tools: readonly McpDiscoveryTool[];
    schemaDigest?: string;
    cleanupVerified: true;
    errorCode?: "protocol_unavailable";
  }>[];
}

export interface McpDiscoveryExecutor {
  discover(): Promise<McpDiscoveryResult>;
  close(): Promise<void>;
}

/** Freshly re-attested executable identity for one run-owned public MCP server. */
export interface McpRuntimeServerLaunch {
  readonly envelope: McpFixedEnvelope;
  readonly name: string;
  readonly command: string;
  readonly executablePath: string;
  /** Exact parsed command token when it is independently safe inside an OCI image. */
  readonly imageExecutable?: string;
  readonly arguments: readonly string[];
  readonly configDigest: string;
  readonly executableDigest: string;
}

export interface RunnerInternalExecutionContextOptions {
  readonly projectDirectory: string;
  readonly stateDirectory: string;
  readonly gitExecutor?: GitCommandExecutor;
  readonly gitExecutionDeadlineMs?: number;
  readonly gitTerminationDeadlineMs?: number;
  readonly ambientEnvironment?: Readonly<Record<string, string | undefined>>;
  /** Production supplies the one ExecutionHost-owned portable process kernel. */
  readonly processKernel?: RunnerInternalProcessKernel;
  /** Deterministic ownership seam for focused cleanup tests; production omits it. */
  readonly closeInjectedProcessKernel?: boolean;
}

export interface RunnerInternalExecutionContext {
  gitPreflight(): Promise<Readonly<{
    principal: RunnerInternalPrincipal;
    result: GitPreflightResult;
  }>>;
  attestConfiguredCapabilities(input: {
    readonly mcpServers: readonly McpServerSpec[];
    readonly capabilitiesConfig: RunnerCapabilitiesConfig;
  }): Promise<RunnerConfiguredCapabilitiesAttestation>;
  createMcpDiscoveryExecutor(input: {
    readonly runId: string;
    readonly servers: readonly McpServerSpec[];
    readonly attestation: readonly McpConfigurationAttestation[];
    readonly requestTimeoutMs?: number;
    readonly shutdownTimeoutMs?: number;
    readonly terminationTimeoutMs?: number;
  }): McpDiscoveryExecutor;
  resolveMcpRuntimeLaunches(input: {
    readonly servers: readonly McpServerSpec[];
    readonly attestation: readonly McpConfigurationAttestation[];
  }): Promise<readonly McpRuntimeServerLaunch[]>;
  close(): Promise<void>;
}

interface TrustedMcpAttestation extends McpConfigurationAttestation {
  readonly envelope: McpFixedEnvelope;
  readonly command: string;
  readonly executablePath: string;
  readonly imageExecutable?: string;
  readonly arguments: readonly string[];
}

const TRUSTED_MCP_ATTESTATIONS = new WeakMap<object, TrustedMcpAttestation>();

export function createRunnerInternalExecutionContext(
  options: RunnerInternalExecutionContextOptions,
): RunnerInternalExecutionContext {
  const projectDirectory = absoluteRoot(options.projectDirectory, "projectDirectory");
  const stateDirectory = absoluteRoot(options.stateDirectory, "stateDirectory");
  const environment = filteredInternalEnvironment(
    options.ambientEnvironment ?? process.env,
  );
  const contextId = `runner-internal-${randomUUID()}`;
  const processKernel = options.processKernel ?? createRunnerInternalProcessKernel({
    stateDirectory: join(stateDirectory, "internal-processes"),
  });
  const ownsProcessKernel = options.processKernel === undefined ||
    options.closeInjectedProcessKernel === true;
  const executors = new Set<McpDiscoveryExecutor>();
  let closed = false;
  let closeComplete = false;
  let contextClosePromise: Promise<void> | undefined;

  const context: RunnerInternalExecutionContext = Object.freeze({
    async gitPreflight() {
      assertOpen(closed);
      const executionDeadlineMs = positiveBound(
        options.gitExecutionDeadlineMs ?? GIT_PREFLIGHT_TIMEOUT_MS,
        "gitExecutionDeadlineMs",
      );
      const terminationDeadlineMs = positiveBound(
        options.gitTerminationDeadlineMs ?? GIT_PREFLIGHT_TERMINATION_TIMEOUT_MS,
        "gitTerminationDeadlineMs",
      );
      const principal = internalPrincipal(
        contextId,
        "git_preflight",
        executionDeadlineMs + (terminationDeadlineMs * 2),
      );
      const executor = options.gitExecutor ?? createBoundedGitCommandExecutor({
        executionDeadlineMs,
        terminationDeadlineMs,
        environment,
        cwd: projectDirectory,
        processKernel,
      });
      const result = options.gitExecutor
        ? await bounded(
            checkGit(executor),
            executionDeadlineMs,
            "Git preflight exceeded its internal execution deadline.",
          )
        : await checkGit(executor);
      await writeJsonAtomic(
        join(stateDirectory, "internal-execution", `${principal.callId}.json`),
        { version: 1, principal, result },
      );
      return deepFreeze({ principal, result });
    },

    async attestConfiguredCapabilities(input: {
      readonly mcpServers: readonly McpServerSpec[];
      readonly capabilitiesConfig: RunnerCapabilitiesConfig;
    }) {
      assertOpen(closed);
      const trusted = await attestMcpConfigurations(
        input.mcpServers,
        projectDirectory,
        environment,
      );
      const lsp = await attestRunnerCapabilitiesLanguageServers(
        input.capabilitiesConfig,
        { commandSearchDirectory: projectDirectory },
      );
      const visibleMcp = trusted.map((entry) => {
        const visible = deepFreeze({
          name: entry.name,
          configDigest: entry.configDigest,
          executableDigest: entry.executableDigest,
        });
        TRUSTED_MCP_ATTESTATIONS.set(visible, entry);
        return visible;
      });
      return deepFreeze({
        mcp: visibleMcp,
        lsp: lsp.languageServers.map((server) => ({
          id: server.descriptor.id,
          descriptorDigest: descriptorDigest(server),
          ...(server.commandIdentity
            ? { executableDigest: server.commandIdentity.digest }
            : {}),
        })),
      });
    },

    createMcpDiscoveryExecutor(input: {
      readonly runId: string;
      readonly servers: readonly McpServerSpec[];
      readonly attestation: readonly McpConfigurationAttestation[];
      readonly requestTimeoutMs?: number;
      readonly shutdownTimeoutMs?: number;
      readonly terminationTimeoutMs?: number;
    }) {
      assertOpen(closed);
      const runId = safeId(input.runId, "runId");
      const requestTimeoutMs = positiveBound(
        input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        "requestTimeoutMs",
      );
      const shutdownTimeoutMs = positiveBound(
        input.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
        "shutdownTimeoutMs",
      );
      const terminationTimeoutMs = positiveBound(
        input.terminationTimeoutMs ?? DEFAULT_TERMINATION_TIMEOUT_MS,
        "terminationTimeoutMs",
      );
      const trusted = matchAttestations(input.servers, input.attestation);
      const principal = internalPrincipal(
        contextId,
        "mcp_discovery",
        requestTimeoutMs + shutdownTimeoutMs + terminationTimeoutMs,
        runId,
      );
      let started = false;
      let complete = false;
      let closePromise: Promise<void> | undefined;
      const active = new Set<DiscoveryClient>();
      const executor: McpDiscoveryExecutor = Object.freeze({
        async discover() {
          if (started || complete || closePromise) throw new Error("MCP discovery already completed, closed, or is in progress.");
          if (closed) throw new Error("Runner internal execution context is closed.");
          started = true;
          const servers = await Promise.all(trusted.map(async (server) => {
            const client = new DiscoveryClient({
              server,
              cwd: projectDirectory,
              environment,
              requestTimeoutMs,
              shutdownTimeoutMs,
              terminationTimeoutMs,
              processKernel,
              principal,
            });
            active.add(client);
            let tools: readonly McpDiscoveryTool[] = [];
            let status: "ready" | "error" = "ready";
            try {
              tools = await client.discover();
            } catch {
              status = "error";
            } finally {
              let cleanupComplete = false;
              try {
                await client.closeVerified();
                cleanupComplete = true;
              } finally {
                if (cleanupComplete) active.delete(client);
              }
            }
            const schemaDigest = status === "ready"
              ? digestJson(tools)
              : undefined;
            return deepFreeze({
              name: server.name,
              configDigest: server.configDigest,
              executableDigest: server.executableDigest,
              status,
              tools,
              ...(schemaDigest ? { schemaDigest } : {}),
              cleanupVerified: true as const,
              ...(status === "error"
                ? { errorCode: "protocol_unavailable" as const }
                : {}),
            });
          }));
          const result = deepFreeze({
            version: 1 as const,
            runId,
            principal,
            servers,
          });
          await writeJsonAtomic(
            join(
              stateDirectory,
              "builds",
              runnerRunStateSegment(runId),
              "mcp-discovery.json",
            ),
            result,
          );
          complete = true;
          executors.delete(executor);
          return result;
        },
        async close() {
          if (complete) return;
          if (closePromise) return await closePromise;
          const clients = [...active];
          const attempt = (async () => {
            const settled = await Promise.allSettled(clients.map((client) => client.closeVerified()));
            settled.forEach((entry, index) => {
              if (entry.status === "fulfilled") active.delete(clients[index]!);
            });
            const failures = settled
              .filter((entry): entry is PromiseRejectedResult => entry.status === "rejected")
              .map((entry) => entry.reason);
            if (failures.length > 0) {
              throw new AggregateError(failures, "MCP discovery cleanup could not be verified.");
            }
            complete = true;
            executors.delete(executor);
          })();
          closePromise = attempt;
          try {
            return await attempt;
          } finally {
            if (closePromise === attempt) closePromise = undefined;
          }
        },
      });
      void complete;
      executors.add(executor);
      return executor;
    },

    async resolveMcpRuntimeLaunches(input: {
      readonly servers: readonly McpServerSpec[];
      readonly attestation: readonly McpConfigurationAttestation[];
    }) {
      assertOpen(closed);
      const trusted = matchAttestations(input.servers, input.attestation);
      await Promise.all(trusted.map(async (server) => {
        await reattestTrustedMcpServer(server, projectDirectory, environment);
      }));
      return Object.freeze(trusted.map((server) => deepFreeze({
        name: server.name,
        command: server.command,
        envelope: server.envelope,
        executablePath: server.executablePath,
        ...(server.imageExecutable ? { imageExecutable: server.imageExecutable } : {}),
        arguments: [...server.arguments],
        configDigest: server.configDigest,
        executableDigest: server.executableDigest,
      })));
    },

    async close() {
      if (closeComplete) return;
      closed = true;
      if (contextClosePromise) return await contextClosePromise;
      const attempt = (async () => {
        const settled = await Promise.allSettled([...executors].map((executor) => executor.close()));
        const failures = settled
          .filter((entry): entry is PromiseRejectedResult => entry.status === "rejected")
          .map((entry) => entry.reason);
        if (ownsProcessKernel) {
          try { await processKernel.close(); } catch (error) { failures.push(error); }
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, "Runner internal execution cleanup failed.");
        }
        closeComplete = true;
      })();
      contextClosePromise = attempt;
      try {
        return await attempt;
      } finally {
        if (contextClosePromise === attempt) contextClosePromise = undefined;
      }
    },
  });
  return context;
}

class DiscoveryClient {
  private owned: RunnerInternalOwnedProcess | undefined;
  private acquisition: Promise<RunnerInternalOwnedProcess> | undefined;
  private closed = false;
  private closeComplete = false;
  private closePromise: Promise<void> | undefined;
  private stderrBytes = 0;
  private protocolFailure: Error | undefined;
  private removeOutputSink: (() => void) | undefined;
  private readonly peer = new McpRpcPeer({ maximumLineBytes: MAX_MCP_LINE_BYTES,
    onFailure: (error) => { this.protocolFailure = error; } });

  constructor(private readonly options: {
    readonly server: TrustedMcpAttestation;
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly requestTimeoutMs: number;
    readonly shutdownTimeoutMs: number;
    readonly terminationTimeoutMs: number;
    readonly processKernel: RunnerInternalProcessKernel;
    readonly principal: RunnerInternalPrincipal;
  }) {}

  async discover(): Promise<readonly McpDiscoveryTool[]> {
    if (this.owned || this.closed) throw new Error("MCP discovery client is unavailable.");
    await reattestTrustedMcpServer(
      this.options.server,
      this.options.cwd,
      this.options.environment,
    );
    if (this.closed) throw new Error("MCP discovery closed before process acquisition.");
    this.acquisition = this.options.processKernel.launch({
      principalId: this.options.principal.principalId,
      callId: `${this.options.principal.callId}:${this.options.server.name}`,
      runId: this.options.principal.runId!,
      kind: "mcp_server",
      executable: this.options.server.executablePath,
      arguments: this.options.server.arguments,
      workingDirectory: this.options.cwd,
      environment: this.options.environment,
      access: [{ canonicalPath: this.options.cwd, mode: "read" }],
    }).then((owned) => { this.owned = owned; return owned; });
    const owned = await this.acquisition;
    if (this.closed) throw new Error("MCP discovery closed during process acquisition.");
    this.removeOutputSink = owned.setOutputSink((metadata, bytes) => {
      if (metadata.stream === "stderr") {
        this.stderrBytes += bytes.byteLength;
        if (this.stderrBytes > MAX_MCP_LINE_BYTES) {
          this.failProtocol("MCP discovery stderr exceeded its byte bound.");
        }
        return;
      }
      this.peer.feed("stdout", bytes);
    });
    await this.peer.request(owned, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "aiboard-runner-v2-discovery", version: "2" },
    }, this.options.requestTimeoutMs);
    await this.peer.notify(owned, "notifications/initialized", {}, this.options.requestTimeoutMs);
    const result = await this.peer.request(owned, "tools/list", {}, this.options.requestTimeoutMs);
    return parseMcpToolList(result);
  }

  async closeVerified(): Promise<void> {
    if (this.closeComplete) return;
    if (this.closePromise) return await this.closePromise;
    const attempt = this.closeVerifiedOnce();
    this.closePromise = attempt;
    try {
      await attempt;
      this.closeComplete = true;
    } finally {
      if (this.closePromise === attempt) this.closePromise = undefined;
    }
  }

  private async closeVerifiedOnce(): Promise<void> {
    this.closed = true;
    const protocolFailed = this.protocolFailure !== undefined;
    this.peer.close(new Error("MCP discovery transport closed."));
    // Retain and join the exact acquisition. A concurrent close cannot certify
    // an empty owner while a process may still arrive from the owned kernel.
    await this.acquisition?.catch(() => undefined);
    const owned = this.owned;
    if (!owned) return;
    await owned.closeVerified({
      shutdownTimeoutMs: this.options.shutdownTimeoutMs,
      terminationTimeoutMs: this.options.terminationTimeoutMs,
      forceImmediately: protocolFailed,
    });
    this.removeOutputSink?.();
    this.removeOutputSink = undefined;
    this.owned = undefined;
  }

  private failProtocol(message: string): void {
    this.peer.close(new Error(message));
  }

}

async function attestMcpConfigurations(
  servers: readonly McpServerSpec[],
  cwd: string,
  environment: Readonly<Record<string, string>>,
): Promise<readonly TrustedMcpAttestation[]> {
  const names = new Set<string>();
  return await Promise.all(servers.map(async (supplied) => {
    const server = snapshotMcpServerSpec(supplied);
    const name = safeId(server.name, "MCP server name");
    if (names.has(name)) throw new Error(`Duplicate MCP server ${name}.`);
    names.add(name);
    if (typeof server.command !== "string" || !server.command.trim() ||
        Buffer.byteLength(server.command) > 64 * 1024 || server.command.includes("\0")) {
      throw new Error(`MCP server ${name} command is invalid.`);
    }
    const executable = await configuredExecutableIdentity(
      server.command,
      cwd,
      environment,
    );
    return deepFreeze({
      name,
      command: server.command,
      executablePath: executable.path,
      ...(executable.imageExecutable ? { imageExecutable: executable.imageExecutable } : {}),
      arguments: executable.arguments,
      executableDigest: executable.digest,
      envelope: fixedMcpEnvelope(server.envelope),
      configDigest: mcpConfigurationDigest(server),
    });
  }));
}

function matchAttestations(
  servers: readonly McpServerSpec[],
  visible: readonly McpConfigurationAttestation[],
): readonly TrustedMcpAttestation[] {
  if (servers.length !== visible.length) {
    throw new Error("MCP discovery configuration differs from static attestation.");
  }
  return visible.map((attestation, index) => {
    const trusted = TRUSTED_MCP_ATTESTATIONS.get(attestation as object);
    const server = servers[index];
    if (!trusted || !server || trusted.name !== server.name ||
        trusted.command !== server.command ||
        trusted.configDigest !== mcpConfigurationDigest(server) ||
        trusted.configDigest !== attestation.configDigest ||
        trusted.executableDigest !== attestation.executableDigest) {
      throw new Error("MCP discovery attestation authority is invalid.");
    }
    return trusted;
  });
}

async function reattestTrustedMcpServer(
  server: TrustedMcpAttestation,
  _cwd: string,
  _environment: Readonly<Record<string, string>>,
): Promise<void> {
  // The attested absolute path, not a second PATH search, is the launch identity.
  // Hash fresh bytes through a stable descriptor and refuse replacement. The
  // immutable configuration already owns the exact parsed argv/image token.
  const executable = await canonicalExecutableIdentity(server.executablePath, "MCP pinned executable");
  if (normalizePath(executable.path) !== normalizePath(server.executablePath) ||
      executable.digest !== server.executableDigest) {
    throw new McpConfigurationError("mcp_executable_unavailable", "MCP executable identity changed after static attestation.");
  }
}

async function configuredExecutableIdentity(
  command: string,
  cwd: string,
  environment: Readonly<Record<string, string>>,
): Promise<Readonly<{
  path: string;
  digest: string;
  imageExecutable?: string;
  arguments: readonly string[];
}>> {
  const argv = parseMcpCommand(command);
  const token = argv[0]!;
  for (const candidate of configuredExecutableCandidates(token, cwd, environment)) {
    try {
      const identity = await canonicalExecutableIdentity(candidate, "MCP configured executable");
      return Object.freeze({
        ...identity,
        ...(portableImageExecutable(token) ? { imageExecutable: token } : {}),
        arguments: Object.freeze(argv.slice(1)),
      });
    } catch {}
  }
  throw new McpConfigurationError("mcp_executable_unavailable", "The exact MCP executable is unavailable; shell fallback is not permitted.");
}

function portableImageExecutable(token: string): boolean {
  return !isAbsolute(token) && !/[\\/]/u.test(token);
}

function configuredExecutableCandidates(
  token: string,
  cwd: string,
  environment: Readonly<Record<string, string>>,
): readonly string[] {
  if (isAbsolute(token)) return [token];
  if (/[\\/]/.test(token)) return [resolve(cwd, token)];
  const candidates: string[] = [];
  const pathValue = environmentValue(environment, "PATH") ?? "";
  const extensions = process.platform === "win32" && !extname(token)
    ? (environmentValue(environment, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [""];
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      candidates.push(resolve(directory.replace(/^"|"$/g, ""), `${token}${extension}`));
    }
  }
  return candidates;
}

async function canonicalExecutableIdentity(
  candidate: string,
  label: string,
): Promise<Readonly<{ path: string; digest: string }>> {
  const actual = resolve(await realpath(resolve(candidate)));
  const metadata = await lstat(actual);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} identity is invalid.`);
  }
  if (process.platform !== "win32") await access(actual, fsConstants.X_OK);
  const digest = await hashExecutableDescriptor(actual);
  if (normalizePath(resolve(await realpath(candidate))) !== normalizePath(actual)) {
    throw new Error(`${label} identity changed during attestation.`);
  }
  return Object.freeze({
    path: actual,
    digest,
  });
}

function environmentValue(
  environment: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  const matches = Object.entries(environment)
    .filter(([key]) => key.toLowerCase() === name.toLowerCase())
    .map(([, value]) => value);
  return new Set(matches).size === 1 ? matches[0] : undefined;
}

function normalizePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function internalPrincipal(
  contextId: string,
  purpose: RunnerInternalPrincipal["purpose"],
  deadlineMs: number,
  runId?: string,
): RunnerInternalPrincipal {
  return deepFreeze({
    role: "runner_internal" as const,
    purpose,
    principalId: `${contextId}:${purpose}:${randomUUID()}`,
    callId: `${purpose}-${randomUUID()}`,
    ...(runId ? { runId } : {}),
    deadlineMs,
  });
}

function descriptorDigest(server: RunnerCapabilitiesConfig["languageServers"][number]): string {
  return digestJson(server.descriptor);
}

function filteredInternalEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const result = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(source)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && value !== undefined &&
        !isSensitiveKey(name) &&
        // Preserve the older internal path's broader substring exclusions too.
        !/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|API[_-]?KEY)/i.test(name)) {
      result[name] = value;
    }
  }
  return Object.freeze(result);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function digestJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (recordOrUndefined(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function recordOrUndefined(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function safeId(value: string, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function positiveBound(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 3_600_000) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function absoluteRoot(value: string, label: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    throw new Error(`Runner internal ${label} must be absolute.`);
  }
  return resolve(value);
}

function assertOpen(closed: boolean): void {
  if (closed) throw new Error("Runner internal execution context is closed.");
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return await new Promise<T>((resolveBounded, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timeout); resolveBounded(value); },
      (error) => { clearTimeout(timeout); reject(error); },
    );
  });
}
