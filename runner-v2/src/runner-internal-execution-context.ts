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
const MAX_MCP_TOOLS = 1_024;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000;
const DEFAULT_TERMINATION_TIMEOUT_MS = 15_000;
const GIT_PREFLIGHT_TIMEOUT_MS = 30_000;
const GIT_PREFLIGHT_TERMINATION_TIMEOUT_MS = 15_000;
const MCP_SHELL_LAUNCHER_SOURCE = [
  'const { spawn } = require("node:child_process");',
  'const command = Buffer.from(process.argv[1], "base64url").toString("utf8");',
  'const child = spawn(command, { shell: true, stdio: "inherit", windowsHide: true });',
  'child.once("error", (error) => { process.stderr.write(String(error)); process.exitCode = 1; });',
  'child.once("exit", (code) => { process.exitCode = code ?? 1; });',
].join("");

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
          if (started) throw new Error("MCP discovery already completed or is in progress.");
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
  private closed = false;
  private closeComplete = false;
  private closePromise: Promise<void> | undefined;
  private nextId = 1;
  private outputBuffer = Buffer.alloc(0);
  private stderrBytes = 0;
  private protocolFailure: Error | undefined;
  private removeOutputSink: (() => void) | undefined;
  private readonly pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timeout: NodeJS.Timeout;
  }>();

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
    const owned = await this.options.processKernel.launch({
      principalId: this.options.principal.principalId,
      callId: `${this.options.principal.callId}:${this.options.server.name}`,
      runId: this.options.principal.runId!,
      kind: "mcp_server",
      executable: this.options.server.executablePath,
      arguments: this.options.server.arguments,
      workingDirectory: this.options.cwd,
      environment: this.options.environment,
      access: [{ canonicalPath: this.options.cwd, mode: "read" }],
    });
    this.owned = owned;
    this.removeOutputSink = owned.setOutputSink((metadata, bytes) => {
      if (metadata.stream === "stderr") {
        this.stderrBytes += bytes.byteLength;
        if (this.stderrBytes > MAX_MCP_LINE_BYTES) {
          this.failProtocol("MCP discovery stderr exceeded its byte bound.");
        }
        return;
      }
      this.receiveBytes(bytes);
    });
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "aiboard-runner-v2-discovery", version: "2" },
    });
    this.notify("notifications/initialized", {});
    const result = await this.request("tools/list", {});
    return parseTools(result);
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
    const owned = this.owned;
    this.closed = true;
    this.rejectPending(new Error("MCP discovery transport closed."));
    if (!owned) return;
    await owned.closeVerified({
      shutdownTimeoutMs: this.options.shutdownTimeoutMs,
      terminationTimeoutMs: this.options.terminationTimeoutMs,
      forceImmediately: this.protocolFailure !== undefined,
    });
    this.removeOutputSink?.();
    this.removeOutputSink = undefined;
    this.owned = undefined;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const owned = this.owned;
    if (!owned) return Promise.reject(new Error("MCP discovery transport is not running."));
    if (this.protocolFailure) return Promise.reject(this.protocolFailure);
    const id = this.nextId++;
    return new Promise((resolveRequest, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP discovery request timed out: ${method}.`));
      }, this.options.requestTimeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject, timeout });
      const payload = Buffer.from(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
      void owned.write(payload, Math.min(this.options.requestTimeoutMs, 30_000))
        .catch((error) => {
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          clearTimeout(pending.timeout);
          pending.reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  private notify(method: string, params: unknown): void {
    const owned = this.owned;
    if (!owned || this.protocolFailure) return;
    const payload = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    void owned.write(payload, Math.min(this.options.requestTimeoutMs, 30_000))
      .catch((error) => this.failProtocol(
        error instanceof Error ? error.message : String(error),
      ));
  }

  private receiveBytes(bytes: Uint8Array): void {
    if (this.protocolFailure) return;
    let offset = 0;
    for (let index = 0; index < bytes.byteLength; index += 1) {
      if (bytes[index] !== 0x0a) continue;
      if (!this.appendOutput(bytes.subarray(offset, index))) return;
      const line = this.outputBuffer.at(-1) === 0x0d
        ? this.outputBuffer.subarray(0, -1)
        : this.outputBuffer;
      this.outputBuffer = Buffer.alloc(0);
      this.receiveLine(line.toString("utf8"));
      offset = index + 1;
    }
    this.appendOutput(bytes.subarray(offset));
  }

  private appendOutput(bytes: Uint8Array): boolean {
    if (this.outputBuffer.byteLength + bytes.byteLength > MAX_MCP_LINE_BYTES) {
      this.failProtocol("MCP discovery response exceeded its line bound.");
      return false;
    }
    if (bytes.byteLength > 0) {
      this.outputBuffer = Buffer.concat([this.outputBuffer, Buffer.from(bytes)]);
    }
    return true;
  }

  private failProtocol(message: string): void {
    if (this.protocolFailure) return;
    this.protocolFailure = new Error(message);
    this.outputBuffer = Buffer.alloc(0);
    this.rejectPending(this.protocolFailure);
  }

  private receiveLine(line: string): void {
    if (Buffer.byteLength(line) > MAX_MCP_LINE_BYTES) {
      this.failProtocol("MCP discovery response exceeded its line bound.");
      return;
    }
    let message: Record<string, unknown>;
    try { message = JSON.parse(line) as Record<string, unknown>; }
    catch { return; }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (recordOrUndefined(message.error)) {
      pending.reject(new Error("MCP discovery request failed."));
    } else pending.resolve(message.result);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

async function attestMcpConfigurations(
  servers: readonly McpServerSpec[],
  cwd: string,
  environment: Readonly<Record<string, string>>,
): Promise<readonly TrustedMcpAttestation[]> {
  const names = new Set<string>();
  return await Promise.all(servers.map(async (server) => {
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
      configDigest: digestJson({ name, command: server.command }),
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
        trusted.configDigest !== attestation.configDigest ||
        trusted.executableDigest !== attestation.executableDigest) {
      throw new Error("MCP discovery attestation authority is invalid.");
    }
    return trusted;
  });
}

function parseTools(value: unknown): readonly McpDiscoveryTool[] {
  const result = record(value);
  if (!Array.isArray(result.tools) || result.tools.length > MAX_MCP_TOOLS) {
    throw new Error("MCP discovery tools/list result is invalid.");
  }
  const tools = result.tools.map((value) => {
    const tool = record(value);
    if (typeof tool.name !== "string" || !tool.name.trim() || tool.name.length > 256) {
      throw new Error("MCP discovery tool name is invalid.");
    }
    const parsed = {
      name: tool.name,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      ...(recordOrUndefined(tool.inputSchema)
        ? { inputSchema: structuredClone(tool.inputSchema as Record<string, unknown>) }
        : {}),
      ...(recordOrUndefined(tool.annotations)
        ? { annotations: parseAnnotations(tool.annotations) }
        : {}),
    };
    if (Buffer.byteLength(JSON.stringify(parsed)) > MAX_MCP_LINE_BYTES) {
      throw new Error("MCP discovery tool schema exceeds its bound.");
    }
    return deepFreeze(parsed);
  });
  return Object.freeze(tools);
}

function parseAnnotations(value: unknown) {
  const annotations = record(value);
  return deepFreeze({
    ...(typeof annotations.readOnlyHint === "boolean"
      ? { readOnlyHint: annotations.readOnlyHint }
      : {}),
    ...(typeof annotations.destructiveHint === "boolean"
      ? { destructiveHint: annotations.destructiveHint }
      : {}),
  });
}

async function reattestTrustedMcpServer(
  server: TrustedMcpAttestation,
  cwd: string,
  environment: Readonly<Record<string, string>>,
): Promise<void> {
  const executable = await configuredExecutableIdentity(server.command, cwd, environment);
  if (normalizePath(executable.path) !== normalizePath(server.executablePath) ||
      executable.digest !== server.executableDigest ||
      executable.imageExecutable !== server.imageExecutable ||
      JSON.stringify(executable.arguments) !== JSON.stringify(server.arguments)) {
    throw new Error("MCP executable identity changed after static attestation.");
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
  let argv: readonly string[];
  try {
    argv = parseConfiguredCommand(command);
  } catch {
    return await configuredShellIdentity(command);
  }
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
  return await configuredShellIdentity(command);
}

function portableImageExecutable(token: string): boolean {
  return !isAbsolute(token) && !/[\\/]/u.test(token);
}

async function configuredShellIdentity(
  command: string,
): Promise<Readonly<{ path: string; digest: string; arguments: readonly string[] }>> {
  const identity = await canonicalExecutableIdentity(
    process.execPath,
    "MCP behavior-neutral shell launcher executable",
  );
  return Object.freeze({
    ...identity,
    arguments: Object.freeze([
      "-e",
      MCP_SHELL_LAUNCHER_SOURCE,
      Buffer.from(command, "utf8").toString("base64url"),
    ]),
  });
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
  const bytes = await readFile(actual);
  if (normalizePath(resolve(await realpath(candidate))) !== normalizePath(actual)) {
    throw new Error(`${label} identity changed during attestation.`);
  }
  return Object.freeze({
    path: actual,
    digest: createHash("sha256").update(bytes).digest("hex"),
  });
}

function parseConfiguredCommand(command: string): readonly string[] {
  const argv: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (!quote && /\s/.test(character)) {
      if (tokenStarted) {
        argv.push(token);
        token = "";
        tokenStarted = false;
      }
      continue;
    }
    if (!quote && /[\0\r\n&|;<>]/.test(character)) {
      throw new Error("MCP configured command requires unsupported shell evaluation.");
    }
    if (character === '"' || (character === "'" && process.platform !== "win32")) {
      tokenStarted = true;
      if (!quote) { quote = character as "'" | '"'; continue; }
      if (quote === character) { quote = undefined; continue; }
    }
    if (character === "\\" && process.platform !== "win32" && quote !== "'" &&
        index + 1 < command.length) {
      token += command[++index]!;
      tokenStarted = true;
      continue;
    }
    token += character;
    tokenStarted = true;
  }
  if (quote) throw new Error("MCP configured command has an unterminated quote.");
  if (tokenStarted) argv.push(token);
  if (argv.length === 0 || argv.some((argument) => argument.includes("\0"))) {
    throw new Error("MCP configured command is invalid.");
  }
  return Object.freeze(argv);
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

function record(value: unknown): Record<string, unknown> {
  if (!recordOrUndefined(value)) throw new Error("MCP discovery response is invalid.");
  return value;
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
