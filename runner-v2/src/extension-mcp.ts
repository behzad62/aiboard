import type { McpTaskRecoveryReceipt, McpTaskReceiptRecorder } from "./mcp-task-recovery.js";
import { mcpOutput } from "./mcp-tools.js";
import { appCallRisk, type McpAppResult, type McpAppCallRisk } from "./mcp-chat-app.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { access, constants, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { NativeTool, ToolExecutionContext, ToolResult } from "./agent-contracts.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { ExtensionCredentialStore, OAuthCredentialClient } from "./extension-credentials.js";
import {
  ExtensionManagementError,
  type AccessSummary,
  type ExtensionChangePlan,
  type ExtensionReadiness,
  type ExtensionVersion,
  type InstalledExtension,
  type McpServerComponent,
  type ResolvedSource,
} from "./extension-management-contracts.js";
import type {
  ExtensionKindHandler,
  ExtensionManagementService,
  HandlerInspection,
  HandlerInstallContext,
  ManagedMcpServerEntry,
} from "./extension-management-service.js";
import { ensureMcpLauncher, provisionMcpSecrets, verifyMcpLauncher } from "./extension-mcp-launcher.js";
import type { SourceRequest } from "./extension-sources.js";
import {
  assertRemoteDestination,
  authorizationUrl,
  discoverOAuthServer,
  exchangeToken,
  pkcePair,
  registerOAuthClient,
  RemoteMcpClient,
  type BoundMcpAuthorization,
  RemoteMcpError,
  type OAuthServerDescription,
  type OAuthTokens,
} from "./mcp-remote.js";
import type { ExecutionHost, ExecutionHostRunBinding } from "./execution-host.js";
import { cleanupRecoveredMcpTransports, createExecutionHostMcpTransportFactory } from "./execution-host-mcp-transport.js";
import type { PermissionProfile } from "./contracts.js";
import { canonicalMcpDigest, formatMcpCommand, parseMcpCommand, type McpServerSpec } from "./mcp-configuration.js";
import { hashExecutableDescriptor } from "./mcp-executable-digest.js";
import { McpProtocolError } from "./mcp-rpc-peer.js";
import { createMcpTools, createRemoteMcpTools, McpManager, type McpCallResult, type McpServerStatus, type McpTransportFactory } from "./mcp-tools.js";
import type { RunnerCapabilitiesConfig } from "./runner-capabilities-config.js";
import { ToolBroker } from "./tool-broker.js";
import type { RemotePluginToolInfo, RemotePluginToolProvider } from "./remote-connector.js";
import type { VerifiedRemoteIdentity } from "./remote-principal.js";
import type { RemoteInvocationResult } from "./remote-tool-runtime.js";
import { createRunnerCapabilityContractSnapshot } from "./runner-capability-contract.js";
import type { McpConfigurationAttestation, RunnerInternalExecutionContext } from "./runner-internal-execution-context.js";
import { runnerRunStateSegment } from "./run-state-identity.js";
import { isSensitiveKey } from "./sensitive-redaction.js";
import { MCP_GATEWAY_TOOLS, type GatewayInput } from "./mcp-gateway-tools.js";

/** Governed command execution for installers (the Runner's internal process kernel). */
export type McpInstallerCommand = (command: string, args: readonly string[], cwd: string) => Promise<Readonly<{ exitCode: number; stdout: string; stderr: string }>>;

export interface McpInstallerEnvironment {
  readonly run: McpInstallerCommand;
  /** Bounded JSON GET for package metadata (registry.npmjs.org / pypi.org). */
  readonly fetchJson: (url: string) => Promise<unknown>;
  /** The Node runtime managed npm servers run on (the Runner's own). */
  readonly nodeExecutable: string;
  readonly environment: Readonly<Record<string, string>>;
}

export interface ManagedMcpRuntimeOptions {
  readonly home: string;
  readonly stateDirectory: string;
  readonly projectRoot: string;
  readonly credentials: ExtensionCredentialStore;
  readonly internal: RunnerInternalExecutionContext;
  readonly installer: McpInstallerEnvironment;
  /** Live per-chat bindings; absent in tests that only install and check. */
  readonly executionHost?: ExecutionHost;
  /** The Runner's capability configuration as of now (startup may add activated plugin extensions). */
  readonly capabilitiesConfig?: () => RunnerCapabilitiesConfig;
  /** CLI-configured server names; a managed server with the same name is not started. */
  readonly reservedServerNames?: readonly string[];
  /** CLI-configured servers, offered for explicit adoption with their exact launch arguments. */
  readonly cliServers?: readonly McpServerSpec[];
  /** The Runner's own OAuth callback URL (known once the control server listens). */
  readonly oauthRedirectUri?: () => string | undefined;
  /** Test seam for remote servers; production uses global fetch. */
  readonly remoteFetch?: typeof fetch;
}

interface PendingSignIn {
  readonly extensionId: string;
  readonly description: OAuthServerDescription;
  readonly clientId: string;
  readonly verifier: string;
  readonly redirectUri: string;
  readonly expiresAt: number;
}

const SIGN_IN_TTL_MS = 10 * 60_000;

export interface ChatMcpTools {
  readonly tools: NativeTool<unknown>[];
  readonly binding?: ExecutionHostRunBinding;
  readonly unavailable: Array<{ serverName: string; reason: string }>;
  readonly status?: () => McpServerStatus[];
  readonly gatewayTools?: readonly GatewayTool[];
  readonly gatewayServers?: readonly { serverId: string; transport: McpServerComponent["transport"] }[];
  readonly closeClient?: (clientId: string) => Promise<void>;
  close(): Promise<void>;
}

interface GatewayTool {
  readonly serverId: string;
  readonly toolName: string;
  readonly relayToolId: string;
}

interface StdioAppInvocation {
  readonly risk?: McpAppCallRisk;
  readonly recovery?: McpTaskRecoveryReceipt;
  readonly signal?: AbortSignal;
  readonly entry: ManagedMcpServerEntry;
  readonly snapshot: { schemaDigest: string; names: readonly string[] };
  readonly target: string;
  readonly authorize: () => Promise<boolean>;
  readonly capture: (result: McpCallResult) => void;
}

/** Stops waiting on abort without cancelling the shared operation itself. */
async function waitUnlessAborted<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await operation;
  signal.throwIfAborted();
  let stop!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    stop = () => reject(signal.reason ?? new Error("Aborted."));
    signal.addEventListener("abort", stop, { once: true });
  });
  try { return await Promise.race([operation, aborted]); }
  finally { signal.removeEventListener("abort", stop); }
}

function sameMcpEntry(a: ManagedMcpServerEntry, b: ManagedMcpServerEntry): boolean {
  return a.extensionId === b.extensionId && a.versionId === b.versionId &&
    a.component.componentId === b.component.componentId && a.component.serverName === b.component.serverName &&
    a.generation === b.generation;
}
const appUnavailable = (): McpAppResult => ({content:[{type:"text",text:"App tool is unavailable or no longer approved."}],isError:true});

interface LaunchPlan {
  readonly spec: McpServerSpec;
  readonly secrets?: Readonly<{ directory: string; launcher: string; values: Readonly<Record<string, string>> }>;
  readonly entry: ManagedMcpServerEntry;
}

const SCRIPTS_DISABLED_NOTE = "Installation runs with package install scripts disabled.";
const SERVER_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Managed local MCP servers: registration of an installed executable and pinned npm / Python installs
 * into AI Board-owned directories. Every launch reuses the existing attested, discovered, governed MCP
 * sessions; secrets reach a server only through the credential launcher.
 */
export class ManagedMcpRuntime {
  private service: ExtensionManagementService | undefined;
  private readonly signIns = new Map<string, PendingSignIn>();
  /** One refresh exchange per credential revision, never aborted by one caller. */
  private readonly refreshes = new Map<string, Promise<ReturnType<ExtensionCredentialStore["taskCredential"]>>>();

  constructor(private readonly options: ManagedMcpRuntimeOptions) {}

  attach(service: ExtensionManagementService): void {
    this.service = service;
  }

  handler(): ExtensionKindHandler {
    return {
      kind: "mcp_server",
      claims: (request) => request.type === "executable" || request.type === "npm" || request.type === "pypi" || request.type === "remote_http",
      inspect: async (request) => await this.inspect(request),
      install: async (plan, context) => await this.install(plan, context),
      check: async (extension, version) => await this.check(extension, version),
      beginSignIn: async (extension, version) => await this.beginSignIn(extension, version),
      completeSignIn: async (state, code) => await this.completeSignIn(state, code),
      adoptionSource: (name) => {
        const server = this.options.cliServers?.find((entry) => entry.name === name);
        if (!server) return undefined;
        const [command, ...args] = parseMcpCommand(server.command);
        const env = [...(server.envelope?.credentialNames ?? [])];
        return { type: "executable", command: command!, args, serverName: server.name, ...(env.length ? { env } : {}) };
      },
      toolPolicy: {
        get: async (extensionId) => {
          const service = this.requireService();
          const record = await service.extensionRecord(extensionId);
          if (!record) return undefined;
          const entries = await service.managedMcpServers(record.activeGeneration ?? (await service.generation()).generation);
          return await this.toolPolicyFor(extensionId, entries.find((entry) => entry.extensionId === extensionId)?.component);
        },
        set: async (extensionId, policy) => await this.setToolPolicy(extensionId, policy),
      },
    };
  }

  // ---- Inspection (no package code runs) -------------------------------------------------------------

  private async inspect(request: SourceRequest): Promise<HandlerInspection> {
    if ("args" in request && request.args) refuseSecretArguments(request.args);
    if (request.type === "executable") return await this.inspectExecutable(request);
    if (request.type === "npm") return await this.inspectNpm(request);
    if (request.type === "pypi") return await this.inspectPypi(request);
    if (request.type === "remote_http") return await this.inspectRemote(request);
    throw new ExtensionManagementError("source_kind_unsupported", `${request.type} is not a local MCP server source.`);
  }

  /**
   * An MCP server declared inside a plugin bundle: a program (arguments may name files in the bundle
   * via ${PLUGIN_ROOT}) or a remote URL. Same validation, digests and access rules as standalone servers.
   */
  async pluginServerComponent(definition: unknown, pluginRoot: string): Promise<{ component: McpServerComponent; access: AccessSummary; requiredCredentials: string[] }> {
    const value = definition && typeof definition === "object" && !Array.isArray(definition) ? definition as Record<string, unknown> : undefined;
    const allowed = ["transport", "command", "args", "env", "serverName", "url", "auth"];
    if (!value || Object.keys(value).some((key) => !allowed.includes(key))) throw new ExtensionManagementError("plugin_invalid", `An MCP definition may only contain ${allowed.join(", ")}.`);
    const strings = (field: unknown) => Array.isArray(field) && field.every((entry) => typeof entry === "string") ? field as string[] : field === undefined ? [] : undefined;
    const args = strings(value.args);
    const env = strings(value.env);
    if (!args || !env || typeof value.serverName !== "string" && value.serverName !== undefined) throw new ExtensionManagementError("plugin_invalid", "MCP definition fields have the wrong types.");
    const serverName = value.serverName as string | undefined;
    if (value.transport === "streamable_http") {
      if (typeof value.url !== "string") throw new ExtensionManagementError("plugin_invalid", "A remote MCP definition needs a url.");
      const inspection = await this.inspectRemote({ type: "remote_http", url: value.url, ...(serverName ? { serverName } : {}), ...(value.auth === "bearer" || value.auth === "oauth" ? { auth: value.auth } : {}) });
      return { component: inspection.components[0] as McpServerComponent, access: inspection.access, requiredCredentials: [...(inspection.requiredCredentials ?? [])] };
    }
    if (value.transport !== "stdio" || typeof value.command !== "string") throw new ExtensionManagementError("plugin_invalid", "An MCP definition needs transport stdio with a command, or streamable_http with a url.");
    const resolved = args.map((arg) => arg.replaceAll("${PLUGIN_ROOT}", pluginRoot));
    for (const arg of resolved) if (arg.includes("${")) throw new ExtensionManagementError("plugin_invalid", "Only ${PLUGIN_ROOT} may be substituted in MCP arguments.");
    const command = value.command.replaceAll("${PLUGIN_ROOT}", pluginRoot);
    if (command.startsWith(pluginRoot)) throw new ExtensionManagementError("plugin_invalid", "Run bundled scripts through an installed program (for example node and ${PLUGIN_ROOT}/server.mjs); bundled executables are not supported.");
    const inspection = await this.inspectExecutable({ type: "executable", command, args: resolved, ...(env.length ? { env } : {}), ...(serverName ? { serverName } : {}) });
    return { component: inspection.components[0] as McpServerComponent, access: inspection.access, requiredCredentials: [...(inspection.requiredCredentials ?? [])] };
  }

  private async inspectExecutable(request: Extract<SourceRequest, { type: "executable" }>): Promise<HandlerInspection> {
    if (request.args) refuseSecretArguments(request.args);
    const command = await resolveExecutable(request.command, this.options.projectRoot, this.options.installer.environment);
    const args = [...(request.args ?? [])];
    const env = [...(request.env ?? [])];
    if (env.length && isBatchFile(command)) throw new ExtensionManagementError("executable_unsupported", "A server that needs credentials can't be a .cmd/.bat script; point at the program it runs instead (for example node.exe and the script path).");
    formatMcpCommand([command, ...args]);
    const scripts = await scriptArguments(args, this.options.projectRoot);
    const serverName = request.serverName ?? serverNameFrom(scripts[0] ?? command);
    const component: McpServerComponent = {
      kind: "mcp_server", componentId: `mcp:${serverName}`, serverName, transport: "stdio", command, args,
      environment: env.map((name) => ({ name, required: true })), route: "runner",
      executableDigest: await hashExecutableDescriptor(command),
      ...(scripts.length ? { installDigest: await digestFiles(scripts) } : {}),
      toolApproval: "all", network: false,
    };
    const source: ResolvedSource = { type: "executable", command, args, executableDigest: component.executableDigest! };
    return {
      kind: "mcp_server", name: serverName, source, components: [component],
      warnings: scripts.length ? [`Runs ${scripts.map((path) => basename(path)).join(", ")}; AI Board re-checks its bytes before every start.`] : [],
      access: localAccess(env, []), requiresExecutableTrust: true, requiredCredentials: env, trees: new Map(),
    };
  }

  private async inspectNpm(request: Extract<SourceRequest, { type: "npm" }>): Promise<HandlerInspection> {
    const manifest = record(await this.options.installer.fetchJson(`https://registry.npmjs.org/${request.packageName.replace("/", "%2f")}/${request.version ?? "latest"}`), "npm metadata");
    const version = text(manifest.version, "npm version");
    const bins = typeof manifest.bin === "string" ? { [unscoped(request.packageName)]: manifest.bin } : record(manifest.bin ?? {}, "npm bin");
    const names = Object.keys(bins);
    const bin = request.bin ?? (names.length === 1 ? names[0] : names.find((name) => name === unscoped(request.packageName)));
    if (!bin || typeof bins[bin] !== "string") {
      throw new ExtensionManagementError("selection_required", names.length ? `This package has several programs; choose one with bin: ${names.join(", ")}.` : "This npm package declares no program to run, so it can't be an MCP server.", 409);
    }
    const dist = record(manifest.dist ?? {}, "npm dist");
    const integrity = typeof dist.integrity === "string" ? dist.integrity : undefined;
    const scripts = record(manifest.scripts ?? {}, "npm scripts");
    const installScripts = ["preinstall", "install", "postinstall"].filter((name) => typeof scripts[name] === "string");
    const serverName = request.serverName ?? serverNameFrom(bin);
    const env = [...(request.env ?? [])];
    const component: McpServerComponent = {
      kind: "mcp_server", componentId: `mcp:${serverName}`, serverName, transport: "stdio",
      command: this.options.installer.nodeExecutable, args: [bin, ...(request.args ?? [])],
      environment: env.map((name) => ({ name, required: true })), route: "runner", toolApproval: "all", network: false,
    };
    return {
      kind: "mcp_server", name: serverName, version,
      source: { type: "npm", packageName: request.packageName, version, ...(integrity ? { integrity } : {}) },
      components: [component],
      warnings: [
        ...(request.version ? [] : [`Pinned to ${version}, the current release; it will not change on its own.`]),
        ...(installScripts.length ? [`The package declares ${installScripts.join("/")} scripts. ${SCRIPTS_DISABLED_NOTE} If the server needs them it will fail its check.`] : []),
      ],
      access: localAccess(env, ["registry.npmjs.org (installation only)"]), requiresExecutableTrust: true, requiredCredentials: env, trees: new Map(),
    };
  }

  private async inspectPypi(request: Extract<SourceRequest, { type: "pypi" }>): Promise<HandlerInspection> {
    await this.python();
    const metadata = record(await this.options.installer.fetchJson(`https://pypi.org/pypi/${encodeURIComponent(request.packageName)}/${request.version ? `${encodeURIComponent(request.version)}/` : ""}json`), "PyPI metadata");
    const info = record(metadata.info, "PyPI info");
    const version = text(info.version, "PyPI version");
    const files = Array.isArray(metadata.urls) ? metadata.urls as Array<Record<string, unknown>> : [];
    if (!files.some((file) => file.packagetype === "bdist_wheel")) {
      throw new ExtensionManagementError("package_unsupported", `${request.packageName} ${version} has no prebuilt wheel. AI Board does not run source builds during installation.`);
    }
    const entry = request.entry ?? request.packageName;
    const serverName = request.serverName ?? serverNameFrom(entry);
    const env = [...(request.env ?? [])];
    const component: McpServerComponent = {
      kind: "mcp_server", componentId: `mcp:${serverName}`, serverName, transport: "stdio", command: entry, args: [...(request.args ?? [])],
      environment: env.map((name) => ({ name, required: true })), route: "runner", toolApproval: "all", network: false,
    };
    return {
      kind: "mcp_server", name: serverName, version,
      source: { type: "pypi", packageName: request.packageName, version },
      components: [component],
      warnings: [
        ...(request.version ? [] : [`Pinned to ${version}, the current release; it will not change on its own.`]),
        "Installed from prebuilt wheels only, into a private Python environment.",
      ],
      access: localAccess(env, ["pypi.org and files.pythonhosted.org (installation only)"]), requiresExecutableTrust: true, requiredCredentials: env, trees: new Map(),
    };
  }

  private async inspectRemote(request: Extract<SourceRequest, { type: "remote_http" }>): Promise<HandlerInspection> {
    const url = await assertRemoteDestination(request.url).catch((error: unknown) => { throw new ExtensionManagementError("destination_refused", describe(error)); });
    const auth = request.auth ?? "none";
    const serverName = request.serverName ?? serverNameFrom(url.hostname.split(".").find((part) => part !== "www" && part !== "mcp") ?? url.hostname);
    const env = auth === "bearer" ? ["MCP_BEARER_TOKEN"] : [];
    const component: McpServerComponent = {
      kind: "mcp_server", componentId: `mcp:${serverName}`, serverName, transport: "streamable_http", url: url.href,
      environment: env.map((name) => ({ name, required: true })), route: "runner", auth, network: true, toolApproval: "non_destructive",
    };
    return {
      kind: "mcp_server", name: serverName, source: { type: "remote_http", url: url.href }, components: [component],
      warnings: url.protocol === "http:" ? ["Plain http is allowed only because this is a local development server."] : [],
      access: {
        executesCode: "never", network: [url.host], filesystem: "None on this computer.",
        credentials: auth === "bearer" ? env : auth === "oauth" ? [`Sign-in with ${url.host}`] : [],
        notes: [
          "Runner-hosted: the Runner calls this server for you, so models never see its tokens.",
          "Until you allow all tools in Settings → Extensions, the assistant can call only tools the server marks as non-destructive.",
        ],
      },
      requiresExecutableTrust: false, requiredCredentials: env, trees: new Map(),
    };
  }

  // ---- Installation (after authorization) ------------------------------------------------------------

  private async install(plan: ExtensionChangePlan, context: HandlerInstallContext): Promise<{ components: McpServerComponent[] }> {
    const component = plan.components.find((entry): entry is McpServerComponent => entry.kind === "mcp_server");
    if (!component || !plan.source) throw new ExtensionManagementError("plan_invalid", "The plan has no MCP server.");
    if (plan.source.type === "remote_http") return { components: [component] };
    if (plan.source.type === "executable") {
      // A registered program is used where it is; its bytes must still match what was approved.
      if (await hashExecutableDescriptor(component.command!) !== component.executableDigest) throw new ExtensionManagementError("executable_changed", "The program changed after it was inspected; inspect it again.", 409);
      await this.verifyInstallDigest(component);
      return { components: [component] };
    }
    const root = join(this.options.home, "mcp-runtimes", safeSegment(context.extensionId), `${safeSegment(plan.version ?? "0")}-${randomBytes(4).toString("hex")}`);
    await mkdir(dirname(root), { recursive: true });
    await mkdir(root);
    try {
      if (plan.source.type === "npm") return { components: [await this.installNpm(plan.source, component, root, context)] };
      if (plan.source.type === "pypi") return { components: [await this.installPypi(plan.source, component, root, context)] };
    } catch (error) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    throw new ExtensionManagementError("source_kind_unsupported", "Unsupported MCP installation source.");
  }

  private async installNpm(source: Extract<ResolvedSource, { type: "npm" }>, component: McpServerComponent, root: string, context: HandlerInstallContext): Promise<McpServerComponent> {
    const npm = await npmCli(this.options.installer.nodeExecutable);
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "aiboard-mcp-runtime", private: true }));
    await context.report(`Installing ${source.packageName}@${source.version} (scripts disabled)`);
    const result = await this.options.installer.run(this.options.installer.nodeExecutable, [npm, "install", `${source.packageName}@${source.version}`, "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", "--prefix", root], root);
    if (result.exitCode !== 0) throw new ExtensionManagementError("install_failed", `npm install failed: ${tail(result.stderr || result.stdout)}`);
    const lock = await readFile(join(root, "package-lock.json"), "utf8");
    const locked = record(record(JSON.parse(lock).packages ?? {}, "lock")[`node_modules/${source.packageName}`] ?? {}, "lock entry");
    if (locked.version !== source.version) throw new ExtensionManagementError("install_mismatch", `npm installed ${String(locked.version)} instead of the pinned ${source.version}.`);
    if (source.integrity && locked.integrity !== source.integrity) throw new ExtensionManagementError("install_mismatch", "The downloaded package does not match the registry integrity hash.");
    const packageRoot = join(root, "node_modules", ...source.packageName.split("/"));
    const manifest = record(JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")), "package.json");
    const binName = component.args?.[0];
    const bins = typeof manifest.bin === "string" ? { [unscoped(source.packageName)]: manifest.bin } : record(manifest.bin ?? {}, "bin");
    const entry = resolve(packageRoot, text(bins[binName ?? ""], "package bin"));
    if (!isWithin(packageRoot, entry)) throw new ExtensionManagementError("package_invalid", "The package's program is outside the package.");
    await access(entry, constants.R_OK);
    const node = this.options.installer.nodeExecutable;
    return {
      ...component, command: node, args: [entry, ...(component.args ?? []).slice(1)], installRoot: root,
      executableDigest: await hashExecutableDescriptor(node), installDigest: await digestFiles([entry, join(root, "package-lock.json")]),
    };
  }

  private async installPypi(source: Extract<ResolvedSource, { type: "pypi" }>, component: McpServerComponent, root: string, context: HandlerInstallContext): Promise<McpServerComponent> {
    const python = await this.python();
    await context.report("Creating a private Python environment");
    const venv = join(root, "venv");
    const created = await this.options.installer.run(python, ["-m", "venv", venv], root);
    if (created.exitCode !== 0) throw new ExtensionManagementError("install_failed", `Python could not create an environment: ${tail(created.stderr || created.stdout)}`);
    const windows = process.platform === "win32";
    const venvPython = join(venv, windows ? "Scripts" : "bin", windows ? "python.exe" : "python");
    await context.report(`Installing ${source.packageName}==${source.version} from wheels`);
    const installed = await this.options.installer.run(venvPython, ["-m", "pip", "install", "--no-input", "--disable-pip-version-check", "--only-binary=:all:", `${source.packageName}==${source.version}`], root);
    if (installed.exitCode !== 0) throw new ExtensionManagementError("install_failed", `pip install failed: ${tail(installed.stderr || installed.stdout)}`);
    const entry = join(venv, windows ? "Scripts" : "bin", `${component.command}${windows ? ".exe" : ""}`);
    try {
      await access(entry, constants.R_OK);
    } catch {
      throw new ExtensionManagementError("package_invalid", `The package installed no "${component.command}" program; choose its program name with entry.`);
    }
    return { ...component, command: entry, installRoot: root, executableDigest: await hashExecutableDescriptor(entry), installDigest: await digestFiles([entry]) };
  }

  private async python(): Promise<string> {
    for (const candidate of process.platform === "win32" ? ["python.exe", "python3.exe"] : ["python3", "python"]) {
      const found = await findOnPath(candidate, this.options.installer.environment);
      // The Microsoft Store alias is a stub that opens the Store instead of running Python.
      if (found && !/WindowsApps/i.test(found)) return found;
    }
    throw new ExtensionManagementError("runtime_missing", "Python 3 was not found on this computer's PATH. Install Python 3.10 or newer yourself, then try again; AI Board never installs system runtimes.", 424);
  }

  // ---- Readiness: handshake + tools/list through the existing discovery executor ---------------------

  private async check(extension: InstalledExtension, version: ExtensionVersion): Promise<ExtensionReadiness> {
    const now = new Date().toISOString();
    const component = version.components.find((entry): entry is McpServerComponent => entry.kind === "mcp_server");
    if (!component) return { state: "failed", checkedAt: now, lastError: { code: "mcp_component_missing", message: "No MCP server in this version.", at: now } };
    return await this.checkComponent(extension.id, version.versionId, component);
  }

  /** Readiness of one MCP component (also used for servers inside plugin bundles). */
  async checkComponent(extensionId: string, versionId: string, component: McpServerComponent): Promise<ExtensionReadiness> {
    const now = new Date().toISOString();
    const extension = { id: extensionId };
    const version = { versionId };
    const missing = this.missingCredentials(extension.id, component);
    if (missing.length) return { state: "needs_auth", checkedAt: now, detail: `Enter ${missing.join(", ")} in Settings → Extensions.` };
    if (component.route !== "runner") return { state: "unsupported", checkedAt: now, detail: "Provider-hosted tools cannot be filtered by the Runner." };
    if (component.transport === "streamable_http") return await this.checkRemote(extension.id, version.versionId, component);
    const runId = `ext-check-${randomBytes(8).toString("hex")}`;
    const runRoot = join(this.options.stateDirectory, "builds", runnerRunStateSegment(runId));
    let createdRunRoot = false;
    try {
      const plan = await this.launchPlan({ extensionId: extension.id, versionId: version.versionId, generation: -1, component });
      const attestation = await this.options.internal.attestMcpServers([plan.spec]);
      if (plan.secrets) await provisionMcpSecrets(plan.secrets.directory, plan.secrets.values);
      await mkdir(dirname(runRoot), { recursive: true });
      await mkdir(runRoot);
      createdRunRoot = true;
      const executor = this.options.internal.createMcpDiscoveryExecutor({ runId, servers: [plan.spec], attestation, requestTimeoutMs: 30_000 });
      let result;
      try {
        result = await executor.discover();
      } finally {
        await executor.close();
      }
      const server = result.servers[0];
      if (!server || server.status !== "ready") {
        return { state: "failed", checkedAt: now, lastError: { code: "mcp_handshake_failed", message: "The server started but did not complete the MCP handshake and tool listing.", at: now } };
      }
      const names = server.tools.map((tool) => tool.name);
      if (!server.schemaDigest || !server.cleanupVerified) throw new Error("MCP discovery was not verified.");
      await this.requireService().recordMcpDiscovery(extension.id, version.versionId, { componentId: component.componentId, schemaDigest: server.schemaDigest, toolNames: names });
      return { state: "ready", checkedAt: now, detail: `${names.length} tool${names.length === 1 ? "" : "s"}: ${names.slice(0, 12).join(", ")}${names.length > 12 ? ", …" : ""}` };
    } catch (error) {
      return { state: "failed", checkedAt: now, lastError: { code: "mcp_start_failed", message: describe(error), at: now } };
    } finally {
      if (createdRunRoot) await rm(runRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async checkRemote(extensionId: string, versionId: string, component: McpServerComponent): Promise<ExtensionReadiness> {
    const now = new Date().toISOString();
    const client = this.remoteClient(extensionId, component, true);
    try {
      const session = await client.initialize();
      const listed = await client.listTools();
      const names = listed.map((tool) => tool.name);
      await this.requireService().recordMcpDiscovery(extensionId, versionId, { componentId: component.componentId, schemaDigest: canonicalMcpDigest(listed), toolNames: names });
      return { state: "ready", checkedAt: now, detail: `${names.length} tool${names.length === 1 ? "" : "s"}: ${names.slice(0, 12).join(", ")}${names.length > 12 ? ", …" : ""} (MCP ${session.protocolVersion})` };
    } catch (error) {
      if (error instanceof RemoteMcpError && (error.code === "needs_auth" || error.code === "insufficient_scope")) {
        return { state: "needs_auth", checkedAt: now, detail: component.auth === "oauth" ? `Sign in to ${new URL(component.url!).host} to finish connecting.` : "The server refused the stored credential; enter it again in Settings → Extensions." };
      }
      return { state: "failed", checkedAt: now, lastError: { code: error instanceof RemoteMcpError ? `remote_${error.code}` : "remote_check_failed", message: describe(error), at: now } };
    } finally {
      await client.close();
    }
  }

  // ---- OAuth sign-in (state-validated callback, PKCE, tokens stay in the credential service) ---------

  private async beginSignIn(extension: InstalledExtension, version: ExtensionVersion): Promise<string> {
    const component = version.components.find((entry): entry is McpServerComponent => entry.kind === "mcp_server" && entry.auth === "oauth");
    if (!component?.url) throw new ExtensionManagementError("sign_in_unsupported", "This extension does not use OAuth sign-in.");
    const redirectUri = this.options.oauthRedirectUri?.();
    if (!redirectUri) throw new ExtensionManagementError("sign_in_unavailable", "The Runner's sign-in callback is not available yet.", 503);
    const fetcher = this.options.remoteFetch ?? fetch;
    try {
      const description = await discoverOAuthServer(component.url, fetcher);
      const clientId = await registerOAuthClient(description, redirectUri, fetcher);
      const { verifier, challenge } = pkcePair();
      const state = randomBytes(24).toString("base64url");
      const now = Date.now();
      for (const [key, pending] of this.signIns) if (pending.expiresAt <= now || pending.extensionId === extension.id) this.signIns.delete(key);
      this.signIns.set(state, { extensionId: extension.id, description, clientId, verifier, redirectUri, expiresAt: now + SIGN_IN_TTL_MS });
      return authorizationUrl(description, { clientId, redirectUri, state, challenge });
    } catch (error) {
      if (error instanceof ExtensionManagementError) throw error;
      throw new ExtensionManagementError("sign_in_failed", describe(error), 502);
    }
  }

  private async completeSignIn(state: string, code: string): Promise<{ extensionId: string }> {
    const pending = this.signIns.get(state);
    // Single use: a replayed or forged state never reaches the token endpoint.
    this.signIns.delete(state);
    if (!pending || pending.expiresAt <= Date.now()) throw new ExtensionManagementError("sign_in_expired", "That sign-in link is unknown or expired; start sign-in again from AI Board.", 400);
    const tokens = await exchangeToken(pending.description, { grant_type: "authorization_code", code, redirect_uri: pending.redirectUri, client_id: pending.clientId, code_verifier: pending.verifier }, this.options.remoteFetch ?? fetch);
    this.storeTokens(pending.extensionId, tokens, pending.description.resource, {tokenEndpoint:pending.description.tokenEndpoint,clientId:pending.clientId,resource:pending.description.resource});
    await this.writeOAuthClient(pending.extensionId, { tokenEndpoint: pending.description.tokenEndpoint, clientId: pending.clientId, resource: pending.description.resource });
    return { extensionId: pending.extensionId };
  }

  private storeTokens(extensionId: string, tokens: OAuthTokens, resource: string, oauthClient: OAuthCredentialClient): void {
    this.options.credentials.put({
      extensionId, name: "oauth", kind: "oauth", value: tokens.accessToken, resource, oauthClient,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}), ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}), ...(tokens.scope ? { scope: tokens.scope } : {}),
    });
  }

  /** A current access token, refreshed inside the Runner when it is about to expire. */
  private boundCredential(snapshot: ReturnType<ExtensionCredentialStore["taskCredential"]>): BoundMcpAuthorization {
    return {header:"Bearer "+snapshot.value,binding:snapshot.lineage,current:()=>{
      try {return this.options.credentials.taskCredential(snapshot.ref).revision===snapshot.revision;}
      catch {return false;}
    }};
  }

  private async oauthAuthorization(extensionId: string, expected?: string, signal?: AbortSignal): Promise<BoundMcpAuthorization> {
    const stored = this.options.credentials.list(extensionId).find(entry=>entry.name==="oauth" && entry.kind==="oauth");
    if (!stored) throw new RemoteMcpError("needs_auth","Not signed in.");
    const token=this.options.credentials.taskCredential(stored.ref);
    if (expected && token.lineage!==expected) throw new RemoteMcpError("needs_auth","Downstream sign-in changed.");
    if (!token.expiresAt || Date.parse(token.expiresAt)-60_000>Date.now()) return this.boundCredential(token);
    const client=token.oauthClient ?? (await this.readOAuthClients())[extensionId];
    if (!token.refreshToken || !client || token.resource!==client.resource) throw new RemoteMcpError("needs_auth","The sign-in expired.");
    // Legacy entries do not have a pinned client. They can still refresh
    // normally, but recovery cannot prove their grant continuity.
    if(expected && !token.oauthClient) throw new RemoteMcpError("needs_auth","Original OAuth grant cannot be verified after refresh.");
    signal?.throwIfAborted();
    if(this.options.credentials.taskCredential(stored.ref).revision!==token.revision)
      throw new RemoteMcpError("needs_auth","Downstream sign-in changed before refresh.");
    // A sent refresh request may already have rotated the refresh token at the
    // issuer. Aborting it with one caller's signal (a cancelled tool call or a
    // recovery deadline) would lose the rotated token and could trip reuse
    // detection, so the exchange runs to its own deadline and is stored by
    // compare-and-swap; callers only stop waiting for it.
    const key=stored.ref+"|"+token.revision;
    let exchange=this.refreshes.get(key);
    if(!exchange){
      const refreshToken=token.refreshToken;
      exchange=exchangeToken({tokenEndpoint:client.tokenEndpoint,resource:client.resource},
        {grant_type:"refresh_token",refresh_token:refreshToken,client_id:client.clientId},this.options.remoteFetch??fetch,Date.now())
        .then(refreshed=>{
          try {
            return this.options.credentials.rotateOAuth(stored.ref,token.revision,
              {value:refreshed.accessToken,refreshToken:refreshed.refreshToken,expiresAt:refreshed.expiresAt,scope:refreshed.scope},client);
          } catch { throw new RemoteMcpError("needs_auth","Downstream sign-in changed during refresh."); }
        })
        .finally(()=>{this.refreshes.delete(key);});
      this.refreshes.set(key,exchange);
      exchange.catch(()=>undefined);
    }
    const next=await waitUnlessAborted(exchange,signal);
    if(expected && next.lineage!==expected) throw new RemoteMcpError("needs_auth","Downstream authorization changed during refresh.");
    return this.boundCredential(next);
  }

  private currentCredentialBinding(extensionId: string, component: McpServerComponent): string | undefined {
    if (!component.auth || component.auth==="none") return undefined;
    const name=component.auth==="oauth"?"oauth":"MCP_BEARER_TOKEN";
    const stored=this.options.credentials.list(extensionId).find(entry=>entry.name===name);
    if(!stored) throw new RemoteMcpError("needs_auth","Downstream credential is unavailable.");
    return this.options.credentials.taskCredential(stored.ref).lineage;
  }

  private remoteClient(extensionId: string, component: McpServerComponent, apps = false, recovery?: {binding?:string}): RemoteMcpClient {
    return new RemoteMcpClient({
      url:component.url!, apps, ...(this.options.remoteFetch?{fetch:this.options.remoteFetch}:{}),
      authorizeBeforeCredentials:!!recovery,
      authorization:async signal=>{
        if(recovery && this.currentCredentialBinding(extensionId,component)!==recovery.binding)
          throw new RemoteMcpError("needs_auth","Downstream credential changed.");
        if(component.auth==="oauth") return await this.oauthAuthorization(extensionId,recovery?.binding,signal);
        if(component.auth==="bearer"){
          const stored=this.options.credentials.list(extensionId).find(entry=>entry.name==="MCP_BEARER_TOKEN");
          if(!stored) throw new RemoteMcpError("needs_auth","Downstream credential is unavailable.");
          const token=this.options.credentials.taskCredential(stored.ref);
          if(recovery && token.lineage!==recovery.binding) throw new RemoteMcpError("needs_auth","Downstream credential changed.");
          return this.boundCredential(token);
        }
        return undefined;
      },
    });
  }

  private async readOAuthClients(): Promise<Record<string, { tokenEndpoint: string; clientId: string; resource: string }>> {
    return await readFile(join(this.options.home, "oauth-clients.json"), "utf8").then((text) => JSON.parse(text) as Record<string, { tokenEndpoint: string; clientId: string; resource: string }>).catch(() => ({}));
  }

  private async writeOAuthClient(extensionId: string, client: { tokenEndpoint: string; clientId: string; resource: string }): Promise<void> {
    const path = join(this.options.home, "oauth-clients.json");
    const current = await this.readOAuthClients();
    current[extensionId] = client;
    await mkdir(this.options.home, { recursive: true });
    await writeAtomic(path, JSON.stringify(current));
  }

  // ---- Generation binding -----------------------------------------------------------------------------

  /** Launch specs for a generation's managed servers that can start now, plus reasons for the rest. */
  async launchPlans(generation: number, only?: ManagedMcpServerEntry): Promise<{ plans: LaunchPlan[]; unavailable: Array<{ serverName: string; reason: string }> }> {
    const service = this.requireService();
    const reserved = new Set(this.options.reservedServerNames ?? []);
    const plans: LaunchPlan[] = [];
    const unavailable: Array<{ serverName: string; reason: string }> = [];
    for (const entry of await service.managedMcpServers(generation)) {
      if (only && !sameMcpEntry(entry,only)) continue;
      const name = entry.component.serverName;
      if (entry.component.transport !== "stdio" || entry.component.route !== "runner") continue;
      if (reserved.has(name)) { unavailable.push({ serverName: name, reason: "A command-line MCP server already uses this name." }); continue; }
      if (plans.some((plan) => plan.spec.name === name)) { unavailable.push({ serverName: name, reason: "Another installed server already uses this name." }); continue; }
      const missing = this.missingCredentials(entry.extensionId, entry.component);
      if (missing.length) { unavailable.push({ serverName: name, reason: `Needs ${missing.join(", ")}.` }); continue; }
      try {
        plans.push(await this.launchPlan(entry));
      } catch (error) {
        unavailable.push({ serverName: name, reason: describe(error) });
      }
    }
    return { plans, unavailable };
  }

  /** Attested servers for a Build run's pinned generation (bound once at run construction). */
  async forRun(generation: number): Promise<{ servers: McpServerSpec[]; attestation: readonly McpConfigurationAttestation[]; beforeLaunch(name: string): Promise<void> } | undefined> {
    const { plans } = await this.launchPlans(generation);
    if (!plans.length) return undefined;
    const servers = plans.map((plan) => plan.spec);
    return { servers, attestation: await this.options.internal.attestMcpServers(servers), beforeLaunch: async (name) => await this.beforeLaunch(plans, name) };
  }

  /** Wraps a transport factory so a credentialed server gets its single-use secret file per launch. */
  wrapTransport(factory: McpTransportFactory, beforeLaunch: (name: string) => Promise<void>): McpTransportFactory {
    return { open: async (request) => { await beforeLaunch(request.server.name); return await factory.open(request); } };
  }

  /**
   * Managed MCP tools for one chat session at one generation: a dedicated ExecutionHost binding,
   * real discovery and the lazy per-agent MCP sessions, closed with the chat turn.
   */
  async chatTools(generation: number, sessionId: string, artifacts: ArtifactStore): Promise<ChatMcpTools> {
    const remote = await this.remoteChatTools(generation, artifacts, false, true);
    try {
      const local = await this.stdioChatTools(generation, sessionId, artifacts);
      return {
        tools: [...local.tools, ...remote.tools],
        ...(local.binding ? { binding: local.binding } : {}),
        unavailable: [...local.unavailable, ...remote.unavailable],
        ...(local.status ? { status: local.status } : {}),
        close: async () => { try { await local.close(); } finally { await remote.close(); } },
      };
    } catch (error) {
      await remote.close();
      throw error;
    }
  }

  /** The admitted extension tool surface for remote and top-level local MCP. */
  async remoteAdmittedTools(generation: number, sessionId: string, artifacts: ArtifactStore): Promise<ChatMcpTools> {
    const gatewayServers = (await this.requireService().managedMcpServers(generation))
      .filter((entry) => entry.toolPolicy?.remoteExposure && entry.component.route === "runner")
      .map(({ component }) => ({ serverId: component.serverName, transport: component.transport }));
    const remote = await this.remoteChatTools(generation, artifacts, true);
    try {
      const local = await this.stdioChatTools(generation, sessionId, artifacts, undefined, true);
      return { tools: [...local.tools, ...remote.tools], ...(local.binding ? { binding: local.binding } : {}),
        unavailable: [...local.unavailable, ...remote.unavailable],
        gatewayServers,
        gatewayTools: [...(local.gatewayTools ?? []), ...(remote.gatewayTools ?? [])],
        closeClient: async (clientId) => { await Promise.all([local.closeClient?.(clientId), remote.closeClient?.(clientId)]); },
        ...(local.status ? { status: local.status } : {}),
        close: async () => { try { await local.close(); } finally { await remote.close(); } } };
    } catch (error) { await remote.close(); throw error; }
  }

  /** Managed local and remote tools using the Build's existing authority/profile. */
  async buildTools(generation: number, binding: ExecutionHostRunBinding, permissionProfile: PermissionProfile, artifacts: ArtifactStore): Promise<ChatMcpTools> {
    const remote = await this.remoteChatTools(generation, artifacts);
    try {
      const local = await this.stdioChatTools(generation, binding.runId, artifacts, { binding, permissionProfile });
      return { tools: [...local.tools, ...remote.tools], binding, unavailable: [...local.unavailable, ...remote.unavailable],
        ...(local.status ? { status: local.status } : {}),
        close: async () => { try { await local.close(); } finally { await remote.close(); } } };
    } catch (error) { await remote.close(); throw error; }
  }

  /** Runner-hosted remote servers: one session per agent turn/generation, no local process. */
  private async remoteChatTools(generation: number, artifacts: ArtifactStore, remotelyExposed = false, apps = false): Promise<ChatMcpTools> {
    const tools: NativeTool<unknown>[] = [];
    const unavailable: Array<{ serverName: string; reason: string }> = [];
    const clients = new Set<RemoteMcpClient>();
    const retiring = new Set<Promise<void>>();
    const closeClientHooks: Array<(id: string) => Promise<void>> = [];
    const retire = (client: RemoteMcpClient): Promise<void> => {
      clients.delete(client);
      const pending = client.close().catch(() => undefined).finally(() => retiring.delete(pending));
      retiring.add(pending);
      return pending;
    };
    const gatewayTools: GatewayTool[] = [];
    const reserved = new Set(this.options.reservedServerNames ?? []);
    for (const entry of await this.requireService().managedMcpServers(generation)) {
      const component = entry.component;
      if (component.route === "provider_hosted") {
        unavailable.push({ serverName: component.serverName, reason: "Provider-hosted filtering is unsupported." });
        continue;
      }
      if (component.transport !== "streamable_http" || !component.url) continue;
      if (!await this.requireService().managedMcpServerEligible(entry, remotelyExposed)) continue;
      if (reserved.has(component.serverName)) { unavailable.push({ serverName: component.serverName, reason: "A command-line MCP server already uses this name." }); continue; }
      const client = this.remoteClient(entry.extensionId, component, apps);
      try {
        await client.initialize();
        const listed = await client.listTools();
        const snapshot = { schemaDigest: canonicalMcpDigest(listed), names: listed.map((tool) => tool.name) };
        const decisions = await Promise.all(listed.map((tool) => this.requireService().managedMcpToolAdmitted(entry, snapshot.schemaDigest, snapshot.names, tool.name, remotelyExposed)));
        const admitted = new Set(listed.filter((_tool, index) => decisions[index]).map((tool) => tool.name));
        clients.add(client);
        const sessions = new Map<string, { client: RemoteMcpClient; active: number }>();
        const clientFor = (context: ToolExecutionContext) => sessions.get(context.actor.id)?.client ?? client;
        closeClientHooks.push(async (id) => {
          const session = sessions.get(id);
          if (!session) return;
          sessions.delete(id);
          await retire(session.client);
        });
        const created = createRemoteMcpTools(component.serverName, listed, async (name, args, context) => {
          try {
            const downstream = clientFor(context);
            const hasApp = !remotelyExposed && !!context.mcpGateway?.publishApp && !!listed.find(tool=>tool.name===name)?.uiResourceUri;
            let binding: string | null | undefined;
            let credentialObserved=false;
            const credentialMatches=()=>{
              try{return credentialObserved && binding!==null && this.currentCredentialBinding(entry.extensionId,component)===binding;}
              catch{return false;}
            };
            const result = await downstream.callTool(name, args, context.signal, context.mcpGateway?.progress, context.mcpGateway?.authorize, context.mcpGateway?.resolveInput ? (request, signal) => context.mcpGateway!.resolveInput!(request, signal, component.serverName) : undefined,
              remotelyExposed && context.mcpGateway?.recordTask
                ? task => context.mcpGateway!.recordTask!({...task,extensionId:entry.extensionId,versionId:entry.versionId,
                  generation:entry.generation,componentId:component.componentId,serverName:component.serverName,toolName:name,
                  componentDigest:canonicalMcpDigest(component),schemaDigest:snapshot.schemaDigest}) : undefined,
              hasApp ? observed=>{binding=observed;credentialObserved=true;} : undefined);
            const uri = listed.find(tool => tool.name === name)?.uiResourceUri;
            if (uri && !result.isError && context.mcpGateway?.publishApp && !remotelyExposed && credentialMatches()) {
              try {
                const resourceAuthorized=async()=>credentialMatches() &&
                  (!context.mcpGateway?.authorize || await context.mcpGateway.authorize()) && credentialMatches();
                const document = await downstream.readAppResourceDocument(uri, context.signal, resourceAuthorized);
                if (document && !context.signal?.aborted && await resourceAuthorized()) {
                  // Only the reviewed server inventory can determine a tool's risk.
                  const candidates = listed.filter(tool=>admitted.has(tool.name) && !tool.modelOnly);
                  const approved = await Promise.all(candidates.map(tool=>this.appTargetAllowed(entry,snapshot,tool.name,appCallRisk(tool))));
                  const available = candidates.filter((_tool,index)=>approved[index]);
                  const allowed = available.map(tool=>tool.name);
                  const risks = Object.freeze(Object.fromEntries(available.map(tool=>[tool.name,appCallRisk(tool)])));
                  const originRisk=appCallRisk(listed.find(tool=>tool.name===name)!);
                  if (!await resourceAuthorized()) return result as McpCallResult;
                  context.mcpGateway.publishApp({ server: component.serverName, tool: name, uri, ...document, arguments: args, result }, {
                    tools: credentialMatches()?allowed:[],
                    risks,
                    call: async (target, input, signal, stillAllowed) => {
                      const unavailable = appUnavailable;
                      if (!allowed.includes(target) || !stillAllowed() || !credentialMatches()) return unavailable();
                      const risk=risks[target]!;
                      const eligible = async () => stillAllowed() && !signal.aborted && credentialMatches() &&
                        await this.appTargetAllowed(entry,snapshot,target,risk) &&
                        await this.requireService().managedMcpToolAdmitted(entry, snapshot.schemaDigest, snapshot.names, name, false) &&
                        !await this.refusal(entry,originRisk==="destructive") && credentialMatches() && stillAllowed() && !signal.aborted;
                      if (!await eligible()) return unavailable();
                      const fresh = this.remoteClient(entry.extensionId, component, true,{binding:binding??undefined});
                      try {
                        await fresh.initialize(signal,true,eligible);
                        const observed = await fresh.listTools(signal,eligible);
                        const candidate = observed.find(tool => tool.name === target);
                        if (canonicalMcpDigest(observed) !== snapshot.schemaDigest ||
                          !candidate || candidate.modelOnly || appCallRisk(candidate)!==risk || !await eligible()) return unavailable();
                        // Single-use host approval is the HTTP dispatch authority; every write rechecks it.
                        const reply=await fresh.callTool(target, input, signal, undefined, eligible);
                        return await eligible()?reply:{content:[{type:"text",text:"App call authority changed before its result could be delivered. It was not retried."}],isError:true};
                      } finally { await fresh.close(); }
                    },
                  });
                }
              } catch { /* Optional presentation failure must not change the actual tool outcome. */ }
            }
            return result as McpCallResult;
          } catch (error) {
            const unknown = error instanceof RemoteMcpError && error.code === "outcome_unknown";
            return { isError: true, content: [{ type: "text", text: (unknown ? "OUTCOME UNKNOWN (not retried): " : "") + describe(error) }] };
          }
        }, artifacts, {
          visualResults: remotelyExposed,
          admit: (_server, tool) => admitted.has(tool.name),
          ...(remotelyExposed ? { name: (_server: string, tool: { name: string }) => remoteToolName(entry, tool.name, snapshot.schemaDigest) } : {}),
          guard: (tool, _server, discovered) => {
            const guarded = this.guard(tool, entry, discovered.name, snapshot, remotelyExposed, async (context) => {
              const current = await clientFor(context).listTools();
              return { schemaDigest: canonicalMcpDigest(current), names: current.map((item) => item.name) };
            });
            if (!remotelyExposed) return guarded;
            return { ...guarded, execute: async (input, context) => {
              const id = context.actor.id;
              let session = sessions.get(id);
              if (!session) {
                if (sessions.size >= 32) {
                  const idle = [...sessions].find(([, value]) => value.active === 0);
                  if (!idle) throw new Error("The downstream MCP server has no free session slots.");
                  sessions.delete(idle[0]);
                  void retire(idle[1].client);
                }
                session = { client: this.remoteClient(entry.extensionId, component), active: 0 };
                clients.add(session.client);
              }
              sessions.delete(id);
              sessions.set(id, session);
              session.active += 1;
              try { return await guarded.execute(input, context); }
              finally { session.active -= 1; }
            } };
          },
        }) as NativeTool<unknown>[];
        tools.push(...created);
        if (remotelyExposed) for (const toolName of admitted) {
          gatewayTools.push({ serverId: component.serverName, toolName,
            relayToolId: remoteToolName(entry, toolName, snapshot.schemaDigest) });
        }
      } catch (error) {
        await retire(client);
        unavailable.push({ serverName: component.serverName, reason: error instanceof RemoteMcpError && error.code === "needs_auth" ? "Needs sign-in in Settings → Extensions." : describe(error) });
      }
    }
    return { tools, unavailable, gatewayTools,
      closeClient: async (id) => { await Promise.all(closeClientHooks.map((close) => close(id))); },
      close: async () => { await Promise.all([...retiring, ...[...clients].map(retire)]); },
    };
  }

  private guard<T>(tool: NativeTool<T>, entry: ManagedMcpServerEntry, toolName: string,
    snapshot: { schemaDigest: string; names: readonly string[] }, remotelyExposed: boolean,
    refresh?: (context: ToolExecutionContext) => Promise<{ schemaDigest: string; names: readonly string[] }>): NativeTool<T> {
    return {
      ...tool,
      execute: async (input, context) => {
        let admitted = false;
        let current = snapshot;
        const destructive = tool.assessAccess?.(input, context)?.destructive !== false;
        try {
          current = refresh ? await refresh(context) : snapshot;
          admitted = await this.requireService().managedMcpToolAdmitted(entry, current.schemaDigest, current.names, toolName, remotelyExposed);
        } catch { /* An unavailable policy or changed server fails closed. */ }
        const refusal = await this.refusal(entry, destructive).catch(() => undefined);
        if (!admitted) {
          // Local callers keep the actionable disabled/removed reason; remote callers see only unavailable.
          if (!remotelyExposed && refusal) return { isError: true, content: [{ type: "text", text: refusal }], error: { code: "permission_denied", message: refusal } };
          return { isError: true, content: [{ type: "text", text: "Tool is unavailable." }], error: { code: "tool_unavailable", message: "Tool is unavailable." } };
        }
        if (refusal) return { isError: true, content: [{ type: "text", text: refusal }], error: { code: "permission_denied", message: refusal } };
        const authorize = async () => {
          try {
            if (context.signal?.aborted || !await this.requireService().managedMcpToolAdmitted(entry, current.schemaDigest, current.names, toolName, remotelyExposed) ||
                await this.refusal(entry, destructive)) return false;
            return !context.signal?.aborted && (context.mcpGateway?.authorize ? await context.mcpGateway.authorize() : true);
          } catch { return false; }
        };
        return await tool.execute(input, { ...context, mcpGateway: { ...context.mcpGateway, authorize } });
      },
    };
  }

  private async stdioChatTools(generation: number, sessionId: string, artifacts: ArtifactStore,
    build?: { binding: ExecutionHostRunBinding; permissionProfile: PermissionProfile }, remotelyExposed = false, appInvocation?: StdioAppInvocation): Promise<ChatMcpTools> {
    const launched = await this.launchPlans(generation, appInvocation?.entry);
    const unavailable = launched.unavailable;
    const eligible = await Promise.all(launched.plans.map((plan) => this.requireService().managedMcpServerEligible(plan.entry, remotelyExposed)));
    const plans = launched.plans.filter((_plan, index) => eligible[index]);
    if (appInvocation && !await appInvocation.authorize()) return { tools: [], unavailable, close: async () => undefined };
    if (!plans.length || !this.options.executionHost) return { tools: [], unavailable, close: async () => undefined };
    const host = this.options.executionHost;
    const servers = plans.map((plan) => plan.spec);
    const attestation = await this.options.internal.attestMcpServers(servers);
    const runId = build?.binding.runId ?? `chat-${createHash("sha256").update(sessionId).digest("hex").slice(0, 24)}-g${generation}`;
    // Chat sessions use the process-group lifecycle of Full-access Builds: these servers run unsandboxed
    // as the user (as the install card says), and a chat has no per-call approval UI. What a model may
    // call is decided per server by the Settings tool policy below.
    const permissionProfile: PermissionProfile = build?.permissionProfile ?? "full";
    const capabilitiesConfig = this.options.capabilitiesConfig!();
    const binding = build?.binding ?? await host.bindRun({ runId, permissionProfile,
      capabilityContract: await createRunnerCapabilityContractSnapshot(capabilitiesConfig, this.options.stateDirectory), capabilitiesConfig });
    let manager: McpManager | undefined;
    const snapshots = new Map<string, { schemaDigest: string; names: readonly string[]; stdioBinding?: string }>();
    try {
      if (!build) {
        await binding.recover({ maxRecords: 1_024, timeoutMs: 30_000 });
        await cleanupRecoveredMcpTransports(binding);
      }
      for (const plan of plans) if (plan.secrets) await provisionMcpSecrets(plan.secrets.directory, plan.secrets.values);
      if (appInvocation && !await appInvocation.authorize()) throw new Error("App or task authority changed before discovery.");
      const discovery = this.options.internal.createMcpDiscoveryExecutor({ runId, servers, attestation });
      let discovered;
      const stopDiscovery=()=>{void discovery.close().catch(()=>undefined);};
      appInvocation?.signal?.addEventListener("abort",stopDiscovery,{once:true});
      try {
        appInvocation?.signal?.throwIfAborted();
        discovered = await discovery.discover();
      } finally {
        appInvocation?.signal?.removeEventListener("abort",stopDiscovery);
        await discovery.close();
      }
      if (appInvocation && !await appInvocation.authorize()) throw new Error("App or task authority changed after discovery.");
      const launches = await this.options.internal.resolveMcpRuntimeLaunches({ servers, attestation });
      if(appInvocation?.recovery && !discovered.servers.some(server=>server.name===appInvocation.recovery!.serverName &&
        server.durableTasks && server.schemaDigest===appInvocation.recovery!.schemaDigest &&
        canonicalMcpDigest([server.configDigest,server.executableDigest])===appInvocation.recovery!.stdioBinding))
        throw new Error("Durable task discovery changed.");
      manager = new McpManager({
        ...(appInvocation?.recovery?{recovery:Object.freeze({...appInvocation.recovery})}:{}),
        runId, discovery: discovered, cwd: this.options.projectRoot, servers,
        reattest: () => this.options.internal.resolveMcpRuntimeLaunches({ servers, attestation }),
        transportFactory: this.wrapTransport(createExecutionHostMcpTransportFactory({ run: binding, permissionProfile, projectDirectory: this.options.projectRoot, launches }), async (name) => {
          if(appInvocation && !await appInvocation.authorize()) throw new Error("App or task authority changed before live launch.");
          await this.beforeLaunch(plans,name);
          if(appInvocation && !await appInvocation.authorize()) throw new Error("App or task authority changed during live launch preparation.");
        }),
      });
      await manager.start();
      for (const server of discovered.servers) {
        if (server.status !== "ready" || !server.schemaDigest) unavailable.push({ serverName: server.name, reason: "It did not complete the MCP handshake." });
        else snapshots.set(server.name, { schemaDigest: server.schemaDigest, names: server.tools.map((tool) => tool.name), ...(server.durableTasks ? {stdioBinding:canonicalMcpDigest([server.configDigest,server.executableDigest])}:{} ) });
      }
    } catch (error) {
      await manager?.close().catch(() => undefined);
      if (!build) await binding.close().catch(() => undefined);
      throw error;
    }
    const owned = manager;
    try {
      const entries = new Map(plans.map((plan) => [plan.spec.name, plan.entry]));
      const admitted = new Set<string>();
      const gatewayTools: GatewayTool[] = [];
      for (const { client, tool } of owned.toolEntries()) {
        const entry = entries.get(client.spec.name);
        const snapshot = snapshots.get(client.spec.name);
        if (appInvocation && (!entry || !sameMcpEntry(entry, appInvocation.entry) ||
          snapshot?.schemaDigest !== appInvocation.snapshot.schemaDigest ||
          tool.name !== appInvocation.target || tool.modelOnly ||
          appCallRisk(tool)!==(appInvocation.recovery?"read_only":appInvocation.risk) ||
          (!appInvocation.recovery && !await this.appTargetAllowed(entry,snapshot,tool.name,appCallRisk(tool))))) continue;
        if (entry && snapshot && await this.requireService().managedMcpToolAdmitted(entry, snapshot.schemaDigest, snapshot.names, tool.name, remotelyExposed)) {
          admitted.add(JSON.stringify([client.spec.name, tool.name]));
          if (remotelyExposed) gatewayTools.push({ serverId: client.spec.name, toolName: tool.name,
            relayToolId: remoteToolName(entry, tool.name, snapshot.schemaDigest) });
        }
      }
      const entriesForApps = owned.toolEntries();
      const tools = createMcpTools(owned, artifacts, {
        visualResults: remotelyExposed,
        admit: (server, tool) => admitted.has(JSON.stringify([server, tool.name])),
        ...(appInvocation ? { projectResult: (result: McpCallResult) => {
          appInvocation.capture(result);
          // The approved app receives the original result out of band. The
          // broker output is only a status, not an additional model message.
          return {isError: result.isError === true, content:[{type:"text" as const,text:"App call completed."}]};
        }} : {}),
        ...(remotelyExposed ? { name: (server: string, tool: { name: string }) => remoteToolName(entries.get(server)!, tool.name, snapshots.get(server)!.schemaDigest) } : {}),
        guard: (tool, server, discovered) => {
          const entry = entries.get(server)!;
          const snapshot = snapshots.get(server)!;
          const guarded = this.guard(tool, entry, discovered.name, snapshot, remotelyExposed);
          if (remotelyExposed && !appInvocation && snapshot.stdioBinding && entry.component.environment.length===0 &&
              discovered.annotations?.readOnlyHint===true && discovered.annotations.destructiveHint===false)
            return {...guarded,execute:async(input,context)=>await guarded.execute(input,{...context,mcpGateway:{...context.mcpGateway,
              observeStdioTask:task=>context.mcpGateway?.recordTask?.({...task,extensionId:entry.extensionId,versionId:entry.versionId,
                generation:entry.generation,componentId:entry.component.componentId,serverName:server,toolName:discovered.name,
                componentDigest:canonicalMcpDigest(entry.component),schemaDigest:snapshot.schemaDigest,stdioBinding:snapshot.stdioBinding})}})};
          if (build || remotelyExposed || appInvocation) return guarded;
          const candidates = entriesForApps.filter(({client,tool}) => client.spec.name===server &&
            admitted.has(JSON.stringify([server,tool.name])) && !tool.modelOnly).map(({tool})=>tool);
          return {...guarded, execute: async (input, context) => {
            const publish = context.mcpGateway?.publishApp;
            if (!publish || !candidates.length) return await guarded.execute(input, context);
            const approved=await Promise.all(candidates.map(candidate=>this.appTargetAllowed(entry,snapshot,candidate.name,appCallRisk(candidate))));
            const available=candidates.filter((_candidate,index)=>approved[index]);
            const allowed=available.map(candidate=>candidate.name);
            const risks=Object.freeze(Object.fromEntries(available.map(candidate=>[candidate.name,appCallRisk(candidate)])));
            return await guarded.execute(input, {...context,mcpGateway:{...context.mcpGateway,publishApp: app => {
              publish(app, {tools:allowed, risks, call: async (target,args,signal,stillAllowed) => {
                if (!allowed.includes(target)) return appUnavailable();
                return await this.invokeStdioApp(entry,snapshot,discovered.name,appCallRisk(discovered)==="destructive",target,risks[target]!,args,artifacts,sessionId,signal,stillAllowed);
              }});
            }}});
          }};
        },
      }) as NativeTool<unknown>[];
      return {
        tools,
        binding,
        unavailable,
        gatewayTools,
        status: () => owned.status(),
        ...(remotelyExposed ? { closeClient: async (clientId: string) => {
          await owned.closeAgent({ runId, sessionId, actor: { role: "remote", id: clientId } });
        } } : {}),
        close: async () => {
          try { await owned.close(); } finally { if (!build) await binding.close(); }
        },
      };
    } catch (error) {
      try { await owned.close(); } finally { if (!build) await binding.close(); }
      throw error;
    }
  }

  async recoverRemoteTask(receipt: McpTaskRecoveryReceipt, artifacts: ArtifactStore, signal: AbortSignal, allowed: () => boolean): Promise<ToolResult | undefined> {
    const service=this.requireService();
    const current=await service.generation();
    if (current.generation!==receipt.generation || receipt.expiresAt<=Date.now() || !allowed() || signal.aborted) return;
    const entry=(await service.managedMcpServers(receipt.generation)).find(e=>e.extensionId===receipt.extensionId &&
      e.versionId===receipt.versionId && e.component.componentId===receipt.componentId && e.component.serverName===receipt.serverName);
    if (!entry || canonicalMcpDigest(entry.component)!==receipt.componentDigest) return;
    if(entry.component.transport==="stdio")return await this.recoverStdioTask(entry,receipt,artifacts,signal,allowed);
    if(entry.component.transport!=="streamable_http" || receipt.stdioBinding) return;
    const credentialMatches=()=>{
      try {
        const authenticated=entry.component.auth==="oauth" || entry.component.auth==="bearer";
        return authenticated===!!receipt.credentialBinding &&
          this.currentCredentialBinding(entry.extensionId,entry.component)===receipt.credentialBinding;
      }catch{return false;}
    };
    if(!credentialMatches()) return;
    const inventory=entry.toolPolicy?.reviewed.find(i=>i.componentId===receipt.componentId);
    if (!inventory || inventory.schemaDigest!==receipt.schemaDigest ||
      !await service.managedMcpToolAdmitted(entry,receipt.schemaDigest,inventory.toolNames,receipt.toolName,true) ||
      !allowed() || signal.aborted) return;
    const preflight=async()=>credentialMatches() && allowed() && !signal.aborted && (await service.generation()).generation===receipt.generation &&
      await service.managedMcpToolAdmitted(entry,receipt.schemaDigest,inventory.toolNames,receipt.toolName,true) &&
      credentialMatches() && allowed() && !signal.aborted;
    const client=this.remoteClient(entry.extensionId,entry.component,false,{binding:receipt.credentialBinding});
    try {
      if ((await client.initialize(signal,true,preflight)).protocolVersion!=="2026-07-28" || !allowed() || signal.aborted) return;
      const tools=await client.listTools(signal,preflight);
      const tool=tools.find(t=>t.name===receipt.toolName);
      if (!tool || canonicalMcpDigest(tools)!==receipt.schemaDigest) return;
      const authorize=async()=>credentialMatches() && allowed() && !signal.aborted && (await service.generation()).generation===receipt.generation &&
        await service.managedMcpToolAdmitted(entry,receipt.schemaDigest,tools.map(t=>t.name),tool.name,true) &&
        !await this.refusal(entry,tool.annotations?.destructiveHint!==false) && credentialMatches() && allowed() && !signal.aborted;
      if (!await authorize()) return;
      const raw=await client.readTaskOutcome(receipt.taskId,receipt.createdAt,signal,authorize);
      if (!raw || !await authorize()) return;
      const output=await mcpOutput(raw as unknown as McpCallResult,artifacts,entry.component.serverName+"."+tool.name,true);
      if (!await authorize()) return;
      return {callId:"recovered-"+randomUUID(),toolName:"mcp_tool_call",...output};
    } finally {await client.close();}
  }

  private async recoverStdioTask(entry: ManagedMcpServerEntry,receipt:McpTaskRecoveryReceipt,artifacts:ArtifactStore,signal:AbortSignal,allowed:()=>boolean):Promise<ToolResult|undefined>{
    if(!receipt.stdioBinding || receipt.credentialBinding || entry.component.environment.length) return;
    const service=this.requireService();
    const inventory=entry.toolPolicy?.reviewed.find(i=>i.componentId===receipt.componentId);
    if(!inventory || inventory.schemaDigest!==receipt.schemaDigest)return;
    const authorize=async()=>allowed()&&!signal.aborted&&receipt.expiresAt>Date.now()&&
      (await service.generation()).generation===receipt.generation&&
      await service.managedMcpToolAdmitted(entry,receipt.schemaDigest,inventory.toolNames,receipt.toolName,true)&&
      !await this.refusal(entry,false)&&allowed()&&!signal.aborted;
    if(!await authorize())return;
    const callId=randomUUID();
    let raw:McpCallResult|undefined;
    const extra=await this.stdioChatTools(receipt.generation,"task-recovery-"+callId,artifacts,undefined,true,
      {entry,snapshot:{schemaDigest:receipt.schemaDigest,names:inventory.toolNames},target:receipt.toolName,authorize,recovery:receipt,signal,capture:value=>{raw=value;}});
    try{
      if(!extra.binding||extra.tools.length!==1||!await authorize())return;
      const broker=new ToolBroker({permissionProfile:"full",workspacePath:this.options.projectRoot,artifacts,executionGrants:extra.binding.executionGrants});
      const tool=extra.tools[0]!;
      broker.register(tool);
      const result=await broker.invoke({type:"tool_call",callId,name:tool.definition.name,arguments:{}},
        {runId:extra.binding.runId,sessionId:"task-recovery-"+callId,actor:{role:"remote",id:"task-recovery-"+callId},
          workspacePath:this.options.projectRoot,signal,mcpGateway:{authorize}});
      if(!raw||!Array.isArray(raw.content)||!await authorize()||(result.isError&&raw.isError!==true))return;
      const output=await mcpOutput(raw,artifacts,entry.component.serverName+"."+receipt.toolName,true);
      if(await authorize())return {callId,toolName:"mcp_tool_call",...output};
    }finally{await extra.close();}
  }

  private async appTargetAllowed(entry: ManagedMcpServerEntry, snapshot: StdioAppInvocation["snapshot"],
    target: string, risk: McpAppCallRisk): Promise<boolean> {
    // Credentialed stdio launchers do not yet bind a fresh process to the
    // exact original App credential lineage. Do not enable writes there.
    if (risk!=="read_only" && entry.component.transport==="stdio" && entry.component.environment.length) return false;
    return await this.requireService().managedMcpToolAdmitted(entry,snapshot.schemaDigest,snapshot.names,target,false,risk!=="read_only") &&
      !await this.refusal(entry,risk==="destructive");
  }

  private async invokeStdioApp(entry: ManagedMcpServerEntry, snapshot: StdioAppInvocation["snapshot"],
    origin: string, originDestructive: boolean, target: string, risk: McpAppCallRisk, args: Record<string, unknown>, artifacts: ArtifactStore,
    sessionId: string, signal: AbortSignal, stillAllowed: () => boolean): Promise<McpAppResult> {
    const authorize = async () => stillAllowed() && !signal.aborted &&
      await this.requireService().managedMcpToolAdmitted(entry,snapshot.schemaDigest,snapshot.names,origin,false) &&
      await this.appTargetAllowed(entry,snapshot,target,risk) &&
      !await this.refusal(entry,originDestructive) && stillAllowed() && !signal.aborted;
    if (!await authorize()) return appUnavailable();
    let raw: McpCallResult | undefined;
    const callId = randomUUID();
    // A fresh run and broker own this exact user-approved operation. Never
    // reuse the chat turn's closed runtime or grant, nor expose other servers.
    const extra = await this.stdioChatTools(entry.generation,sessionId+"-app-"+callId,artifacts,undefined,false,
      {entry,snapshot,target,risk,authorize,signal,capture: result=>{raw=result;}});
    try {
      if (!extra.binding || extra.tools.length!==1 || !await authorize()) return appUnavailable();
      const broker = new ToolBroker({permissionProfile:"full",workspacePath:this.options.projectRoot,artifacts,executionGrants:extra.binding.executionGrants});
      const tool=extra.tools[0]!;
      broker.register(tool);
      const result=await broker.invoke({type:"tool_call",callId,name:tool.definition.name,arguments:args},
        {runId:extra.binding.runId,sessionId,actor:{role:"worker",id:"mcp-app:"+callId},workspacePath:this.options.projectRoot,
          signal,mcpGateway:{authorize}});
      if (!raw || !Array.isArray(raw.content) || !await authorize() || (result.isError && raw.isError!==true))
        return {content:[{type:"text",text:"App call did not return a verified result. Effects may have occurred; it was not retried."}],isError:true};
      return {content:raw.content,isError:raw.isError===true,
        ...(Object.hasOwn(raw,"structuredContent")?{structuredContent:raw.structuredContent}:{}),
        ...(raw._meta?{_meta:raw._meta}:{})};
    } finally { await extra.close(); }
  }

  // ---- Internals -------------------------------------------------------------------------------------

  /** Why a chat call is refused now: the server was disabled/removed, or the tool may change things under "non_destructive". */
  private async refusal(entry: ManagedMcpServerEntry, destructive: boolean): Promise<string | undefined> {
    const current = await this.requireService().extensionRecord(entry.extensionId);
    if (!current?.enabled) return `${entry.component.serverName} was disabled or removed; its tools can no longer be called.`;
    const policy = (await this.toolPolicy(entry.extensionId)) ?? entry.component.toolApproval ?? "all";
    if ((policy === "non_destructive" || entry.pinnedApproval === "non_destructive") && destructive) return `${entry.component.serverName} is limited to tools it marks as non-destructive; the user can allow all tools in Settings → Extensions.`;
    return undefined;
  }

  private async launchPlan(entry: ManagedMcpServerEntry): Promise<LaunchPlan> {
    const component = entry.component;
    if (!component.command || !SERVER_NAME.test(component.serverName)) throw new Error("The server's launch configuration is incomplete.");
    if (await hashExecutableDescriptor(component.command) !== component.executableDigest) throw new Error("The server's program changed since it was installed; reinstall or update it.");
    await this.verifyInstallDigest(component);
    const argv = [component.command, ...(component.args ?? [])];
    const names = component.environment.map((variable) => variable.name);
    if (!names.length) return { entry, spec: { name: component.serverName, command: formatMcpCommand(argv), envelope: { network: component.network === true } } };
    const values = this.credentialValues(entry.extensionId, names);
    const launcher = await ensureMcpLauncher(join(this.options.home, "runtime"));
    const directory = join(this.options.home, "mcp-secrets", createHash("sha256").update(`${entry.extensionId}\0${component.serverName}`).digest("hex").slice(0, 24));
    return {
      entry,
      spec: { name: component.serverName, command: formatMcpCommand([this.options.installer.nodeExecutable, launcher, directory, "--", ...argv]), envelope: { network: component.network === true } },
      secrets: { directory, launcher, values },
    };
  }

  private async beforeLaunch(plans: readonly LaunchPlan[], name: string): Promise<void> {
    const plan = plans.find((entry) => entry.spec.name === name);
    if (!plan?.secrets) return;
    await verifyMcpLauncher(plan.secrets.launcher);
    // Values are re-read at each launch, so a revoked credential stops new starts immediately.
    const values = this.credentialValues(plan.entry.extensionId, Object.keys(plan.secrets.values));
    await provisionMcpSecrets(plan.secrets.directory, values);
  }

  private credentialValues(extensionId: string, names: readonly string[]): Record<string, string> {
    const stored = this.options.credentials.list(extensionId);
    const values: Record<string, string> = {};
    for (const name of names) {
      const entry = stored.find((candidate) => candidate.name === name);
      if (!entry) throw new Error(`Needs ${name}; enter it in Settings → Extensions.`);
      values[name] = this.options.credentials.reveal(entry.ref).value;
    }
    return values;
  }

  private missingCredentials(extensionId: string, component: McpServerComponent): string[] {
    const stored = new Set(this.options.credentials.list(extensionId).map((entry) => entry.name));
    return component.environment.filter((variable) => variable.required && !stored.has(variable.name)).map((variable) => variable.name);
  }

  private async toolPolicy(extensionId: string): Promise<"all" | "non_destructive" | undefined> {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(join(this.options.home, "mcp-tool-policy.json"), "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new ExtensionManagementError("tool_policy_invalid", "MCP approval policy is unreadable.", 500);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ExtensionManagementError("tool_policy_invalid", "MCP approval policy is malformed.", 500);
    const policy = raw as Record<string, unknown>;
    for (const [id, value] of Object.entries(policy)) {
      if (!/^ext_[a-z0-9_-]{4,80}$/.test(id) || (value !== "all" && value !== "non_destructive")) throw new ExtensionManagementError("tool_policy_invalid", "MCP approval policy is malformed.", 500);
    }
    const value = policy[extensionId];
    return value === "all" || value === "non_destructive" ? value : undefined;
  }

  /** Settings choice: let the assistant call every tool, or only tools the server marks non-destructive. */
  async setToolPolicy(extensionId: string, policy: "all" | "non_destructive"): Promise<void> {
    await this.requireService().registry.mutate(async (state) => {
      if (!state.extension(extensionId)) throw new ExtensionManagementError("extension_not_found", "No such MCP server.", 404);
      await this.toolPolicy(extensionId);
      const path = join(this.options.home, "mcp-tool-policy.json");
      const current = await readFile(path, "utf8").then((text) => JSON.parse(text) as Record<string, string>).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return {} as Record<string, string>;
        throw error;
      });
      current[extensionId] = policy;
      await mkdir(this.options.home, { recursive: true });
      await writeAtomic(path, JSON.stringify(current));
      state.setToolApproval(extensionId, policy);
      const extension = state.extension(extensionId)!;
      state.putExtension({ ...extension, desiredGeneration: state.registry.currentGeneration + 1, updatedAt: new Date().toISOString() });
      state.publishGeneration(undefined, new Date().toISOString());
    });
  }

  async toolPolicyFor(extensionId: string, component?: McpServerComponent): Promise<"all" | "non_destructive"> {
    return (await this.toolPolicy(extensionId)) ?? component?.toolApproval ?? "all";
  }

  private async verifyInstallDigest(component: McpServerComponent): Promise<void> {
    if (!component.installDigest) return;
    let files: string[];
    if (!component.installRoot) files = await scriptArguments(component.args ?? [], this.options.projectRoot);
    else if (await exists(join(component.installRoot, "package-lock.json"))) files = [component.args?.[0] ?? "", join(component.installRoot, "package-lock.json")];
    else files = [component.command!];
    if (await digestFiles(files) !== component.installDigest) throw new Error("The server's installed files changed since installation; reinstall or update it.");
  }

  private requireService(): ExtensionManagementService {
    if (!this.service) throw new Error("Managed MCP runtime is not attached to the extension service.");
    return this.service;
  }
}


/** Options for the connector-facing admitted extension tool provider (R1c + plan P2). */
export interface RemotePluginToolProviderOptions {
  readonly generation: () => Promise<number>;
  readonly artifacts: ArtifactStore;
  readonly workspacePath: string;
  readonly sessionId?: string;
  readonly requiredRelayToolIds?: ReadonlySet<string>;
}

/**
 * Routes relay plugin ids to the current generation's `remoteAdmittedTools`.
 * Tools are executed through a ToolBroker bound to the admitted binding, so
 * grants and the manager's re-attested restart semantics stay Runner-owned.
 */
export function createRemotePluginToolProvider(runtime: ManagedMcpRuntime, options: RemotePluginToolProviderOptions): RemotePluginToolProvider {
  const sessionId = options.sessionId ?? "remote-plugins";
  let current: { generation: number; admitted: ChatMcpTools; legacyBroker: ToolBroker; gatewayBroker: ToolBroker } | undefined;
  let pending: Promise<NonNullable<typeof current>> | undefined;
  let closing = false;
  let failedLoad: ChatMcpTools | undefined;
  let discoveryRetryAfter = 0;
  let sequence = 0;
  const activeCalls = new Set<string>();
  const notSentCalls = new Set<string>();
  const loadCurrent = async (retryDiscovery: boolean) => {
    if (failedLoad) {
      await failedLoad.close();
      failedLoad = undefined;
    }
    const generation = await options.generation();
    if (current && current.generation === generation) {
      const exposed = new Set(current.admitted.gatewayServers?.map(({ serverId }) => serverId));
      const unavailable = current.admitted.unavailable.some(({ serverName }) => exposed.has(serverName));
      if (!retryDiscovery || activeCalls.size || !unavailable || Date.now() < discoveryRetryAfter) return current;
    }
    const previous = current;
    if (previous) {
      await previous.admitted.close();
      current = undefined;
    }
    const admitted = await runtime.remoteAdmittedTools(generation, sessionId, options.artifacts);
    discoveryRetryAfter = Date.now() + 5_000;
    const createBroker = (toolTimeoutMs: number) => new ToolBroker({
      toolTimeoutMs,
      permissionProfile: "full", workspacePath: options.workspacePath, artifacts: options.artifacts,
      ...(admitted.binding ? { executionGrants: admitted.binding.executionGrants } : {}),
    });
    const legacyBroker = createBroker(30_000);
    const gatewayBroker = createBroker(120_000);
    try {
      for (const broker of [legacyBroker, gatewayBroker]) for (const tool of admitted.tools) broker.register({
        ...tool,
        execute: async (input, context) => {
          try { return await tool.execute(input, context); }
          catch (error) {
            if (error instanceof McpProtocolError && error.outcome === "not_sent" && context.callId && activeCalls.has(context.callId)) {
              notSentCalls.add(context.callId);
            }
            throw error;
          }
        },
      });
    } catch (error) {
      failedLoad = admitted;
      try { await admitted.close(); failedLoad = undefined; }
      catch (cleanup) { throw new AggregateError([error, cleanup], "MCP gateway cleanup remains unverified."); }
      throw error;
    }
    current = { generation, admitted, legacyBroker, gatewayBroker };
    return current;
  };
  const load = async (retryDiscovery = false) => {
    if (closing) throw new Error("MCP gateway is closing.");
    pending ??= loadCurrent(retryDiscovery).finally(() => { pending = undefined; });
    return await pending;
  };
  const invoke = async (identity: VerifiedRemoteIdentity, relayToolId: string, args: unknown, signal?: AbortSignal,
    beforeBroker?: () => boolean, progress?: import("./mcp-gateway-tools.js").McpProgressReporter, resolveInput?: import("./mcp-optional-features.js").McpInputResolver, recordTask?: McpTaskReceiptRecorder): Promise<RemoteInvocationResult> => {
    const loaded = await load(MCP_GATEWAY_TOOLS.some((tool) => tool.name === relayToolId));
    if (signal?.aborted || (beforeBroker && !beforeBroker())) {
      throw new McpProtocolError("mcp_request_cancelled", "Remote plugin was refused before dispatch.", "not_sent");
    }
    const callId = `remote-plugin-${++sequence}`;
    const gateway = MCP_GATEWAY_TOOLS.find((entry) => entry.name === relayToolId);
    if (gateway) {
      const parsed = gateway.schema.safeParse(args);
      const reply = (content: ToolResult["content"], error?: ToolResult["error"]): RemoteInvocationResult => ({
        brokerInvoked: true, stopEvidence: { effect: "no_effect" }, result: {
          callId, toolName: relayToolId, content, isError: Boolean(error), ...(error ? { error } : {}),
        },
      });
      const reject = (code: string, message: string) => reply([{ type: "text", text: message }], { code, message });
      if (!parsed.success) return reply([{ type: "text", text: "Invalid MCP gateway arguments." }], {
        code: "invalid_arguments", message: "Invalid MCP gateway arguments.",
      });
      const entries = loaded.admitted.gatewayTools ?? [];
      const statuses = new Map(loaded.admitted.status?.().map(({ name, status }) => [name, status]));
      const servers = (loaded.admitted.gatewayServers ?? []).map(({ serverId, transport }) => {
        const unavailable = loaded.admitted.unavailable.some(({ serverName }) => serverName === serverId);
        const toolCount = entries.filter((tool) => tool.serverId === serverId).length;
        return { serverId, transport, status: unavailable ? "error" : statuses.get(serverId) ?? (toolCount ? "ready" : "unavailable"), toolCount };
      });
      if (relayToolId === "mcp_servers_list") {
        return reply([{ type: "json", value: { servers, ...(!servers.length ? {
          message: "No MCP servers are exposed on this Runner. In AI Board Settings â†’ Extensions, add the server, review its tools, and enable remote exposure.",
        } : {}) } }]);
      }
      const input = parsed.data as GatewayInput;
      const server = servers.find((item) => item.serverId === input.serverId);
      if (!server) return reject("mcp_server_not_exposed", "This server is not exposed on this Runner. Use mcp_servers_list or review Settings â†’ Extensions on the device.");
      if (!server.toolCount && server.status === "error") {
        return reject("mcp_server_unavailable", "The Runner could not connect to this MCP server. Check its status in AI Board Settings â†’ Extensions.");
      }
      if (!server.toolCount) {
        return reject("mcp_no_approved_tools", "No tools are approved for this server's current inventory. Review its tools in AI Board Settings â†’ Extensions.");
      }
      const tools = entries.filter((entry) => entry.serverId === input.serverId);
      if (relayToolId === "mcp_tools_list") {
        return reply([{ type: "json", value: { serverId: input.serverId, tools: tools.map(({ relayToolId, toolName }) => {
          const definition = loaded.admitted.tools.find((tool) => tool.definition.name === relayToolId)!.definition;
          return { name: toolName, description: definition.description, inputSchema: definition.inputSchema, readOnly: definition.readOnly };
        }) } }]);
      }
      const matches = tools.filter((entry) => entry.toolName === input.toolName);
      if (matches.length !== 1) return reject("tool_unavailable", "This MCP tool is unavailable or has not been approved. Use mcp_tools_list to see the approved tools.");
      relayToolId = matches[0]!.relayToolId;
      args = input.arguments ?? {};
      const timeout = AbortSignal.timeout(input.timeoutMs ?? 30_000);
      signal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    }
    const tool = loaded.admitted.tools.find((entry) => entry.definition.name === relayToolId);
    if (!tool) throw new McpProtocolError("mcp_transport_unavailable", "Plugin tool is not admitted for remote use.", "not_sent");
    activeCalls.add(callId);
    try {
      const broker = gateway ? loaded.gatewayBroker : loaded.legacyBroker;
      const result = await broker.invoke(
        { type: "tool_call", callId, name: relayToolId, arguments: args },
        {
          runId: loaded.admitted.binding?.runId ?? `remote-plugin-${loaded.generation}`,
          sessionId, actor: { role: "remote", id: identity.clientId }, workspacePath: options.workspacePath,
          ...(signal ? { signal } : {}), mcpGateway: { authorize: beforeBroker, progress, resolveInput, recordTask },
        },
      );
      return { result, brokerInvoked: true, ...(notSentCalls.has(callId) ? { stopEvidence: { effect: "no_effect" as const } } : {}) };
    } finally {
      activeCalls.delete(callId);
      notSentCalls.delete(callId);
    }
  };
  return {
    async list(): Promise<readonly RemotePluginToolInfo[]> {
      const loaded = await load();
      const statuses = loaded.admitted.status?.() ?? [];
      return loaded.admitted.tools.map((tool) => {
        const relayToolId = tool.definition.name;
        const status = statuses
          .filter((entry) => relayToolId.startsWith(`plugin_${entry.name}_`))
          .sort((a, b) => b.name.length - a.name.length)[0];
        return {
          relayToolId,
          required: options.requiredRelayToolIds?.has(relayToolId) ?? false,
          available: !status || status.status === "ready",
        };
      });
    },
    async invoke(identity: VerifiedRemoteIdentity, relayToolId: string, args: unknown, signal?: AbortSignal,
      beforeBroker?: () => boolean): Promise<ToolResult> {
      return (await invoke(identity, relayToolId, args, signal, beforeBroker)).result;
    },
    invokeAdmitted: invoke,
    recoverTask: (receipt,signal,allowed)=>runtime.recoverRemoteTask(receipt,options.artifacts,signal,allowed),
    async closeClient(clientId) {
      await pending?.catch(() => undefined);
      await current?.admitted.closeClient?.(clientId);
    },
    async close(): Promise<void> {
      closing = true;
      await pending?.catch(() => undefined);
      if (failedLoad) {
        await failedLoad.close();
        failedLoad = undefined;
      }
      if (current) await current.admitted.close();
      current = undefined;
    },
  };
}

// ---- Helpers ---------------------------------------------------------------------------------------------

/** Plan P2 relay naming: plugin_<server>_<tool>_<digest8>, digest8 from the R1c schema digest. */
export function remotePluginToolId(serverName: string, toolName: string, schemaDigest: string): string {
  const classic = `plugin_${serverName}_${toolName}_${schemaDigest.slice(0, 8)}`;
  if (/^[a-z0-9-]+$/.test(serverName) && /^[a-z0-9_-]+$/.test(toolName) && classic.length <= 64) return classic;
  const clean = (value: string) => value.toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
  const suffix = createHash("sha256").update(JSON.stringify([serverName, toolName, schemaDigest])).digest("hex").slice(0, 20);
  const prefix = `plugin_${clean(serverName)}_${clean(toolName)}`.slice(0, 43);
  return `${prefix}-${suffix}`;
}

function remoteToolName(entry: ManagedMcpServerEntry, toolName: string, schemaDigest: string): string {
  return remotePluginToolId(entry.component.serverName, toolName, schemaDigest);
}



/** npm installs keep a lock file (entry + lock are digested); Python installs digest the console script. */
async function exists(path: string): Promise<boolean> {
  return await access(path, constants.R_OK).then(() => true, () => false);
}

function localAccess(env: readonly string[], network: readonly string[]): AccessSummary {
  return {
    executesCode: "on_use",
    network: [...network],
    filesystem: "Runs as your user account with the project folder as its working directory. It is not sandboxed.",
    credentials: [...env],
    notes: [
      "Started by the Runner only when one of its tools is used, and stopped with the conversation or Build.",
      "The assistant can call its tools without asking each time; limit that per server in Settings → Extensions.",
      ...(env.length ? ["Secrets are entered in a secure field and given only to this server's process."] : []),
    ],
  };
}

async function resolveExecutable(command: string, cwd: string, environment: Readonly<Record<string, string>>): Promise<string> {
  if (isAbsolute(command) || /[\\/]/.test(command)) {
    const path = resolve(cwd, command);
    try {
      await access(path, constants.R_OK);
      if (!(await stat(path)).isFile()) throw new Error("not a file");
      return await realpath(path);
    } catch {
      throw new ExtensionManagementError("executable_missing", `${command} was not found.`, 404);
    }
  }
  const found = await findOnPath(command, environment);
  if (!found) throw new ExtensionManagementError("executable_missing", `${command} was not found on this computer's PATH. Install it yourself first; AI Board never installs system programs.`, 424);
  return found;
}

async function findOnPath(command: string, environment: Readonly<Record<string, string>>): Promise<string | undefined> {
  const value = (name: string) => Object.entries(environment).find(([key]) => key.toUpperCase() === name)?.[1];
  const extensions = process.platform === "win32" && !extname(command) ? (value("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const directory of (value("PATH") ?? "").split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension.toLowerCase()}`);
      try {
        if ((await stat(candidate)).isFile()) return await realpath(candidate);
      } catch {
        // not here
      }
    }
  }
  return undefined;
}

async function npmCli(node: string): Promise<string> {
  const candidates = [join(dirname(node), "node_modules", "npm", "bin", "npm-cli.js"), join(dirname(dirname(node)), "lib", "node_modules", "npm", "bin", "npm-cli.js")];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.R_OK);
      return candidate;
    } catch {
      // try the next layout
    }
  }
  throw new ExtensionManagementError("runtime_missing", "npm was not found next to the Node.js runtime the Runner uses. Install Node.js with npm, then try again.", 424);
}

/** Absolute or project-relative arguments that name existing files (for example a server script). */
async function scriptArguments(args: readonly string[], cwd: string): Promise<string[]> {
  const files: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-") || !/\.(m?[jt]s|cjs|py|rb|ps1|sh)$/i.test(arg)) continue;
    const path = resolve(cwd, arg);
    try {
      if ((await stat(path)).isFile()) files.push(await realpath(path));
    } catch {
      // not a file argument
    }
  }
  return files;
}

async function digestFiles(paths: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(path.replaceAll("\\", "/")).update("\0").update(await readFile(path)).update("\0");
  }
  return hash.digest("hex");
}

/** Secrets belong in env names the user fills in, never in stored, displayed arguments. */
function refuseSecretArguments(args: readonly string[]): void {
  args.forEach((arg, index) => {
    const flag = /^--?([A-Za-z0-9_-]+)(?:=(.*))?$/.exec(arg);
    const valued = flag && (flag[2] !== undefined || (args[index + 1] !== undefined && !args[index + 1]!.startsWith("-")));
    if ((flag && valued && isSensitiveKey(flag[1]!)) || /^(sk-|ghp_|github_pat_|xox[bp]-|AKIA)[A-Za-z0-9_-]{8,}/.test(arg)) {
      throw new ExtensionManagementError("secret_in_arguments", "Arguments look like they contain a secret. List the variable name under env instead; the user enters its value in a secure field.");
    }
  });
}

function serverNameFrom(value: string): string {
  const base = basename(value).replace(/\.[A-Za-z0-9]+$/, "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "").slice(0, 32).replace(/-+$/, "");
  return SERVER_NAME.test(base) ? base : "server";
}

function unscoped(name: string): string {
  return name.includes("/") ? name.slice(name.indexOf("/") + 1) : name;
}

function isBatchFile(path: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(path);
}

function isWithin(root: string, path: string): boolean {
  const offset = relative(root, path);
  return offset !== "" && !offset.startsWith("..") && !isAbsolute(offset) && !offset.split(sep).includes("..");
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "x";
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ExtensionManagementError("metadata_invalid", `Unexpected ${what}.`, 502);
  return value as Record<string, unknown>;
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string" || !value || value.length > 4096) throw new ExtensionManagementError("metadata_invalid", `Unexpected ${what}.`, 502);
  return value;
}

function tail(value: string): string {
  return value.trim().split(/\r?\n/).slice(-6).join(" ").slice(-600);
}

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 600);
}

/** Bounded metadata fetch: HTTPS only, no redirects, 2 MiB cap, 20 s timeout. */
export async function fetchPackageMetadata(url: string): Promise<unknown> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !["registry.npmjs.org", "pypi.org"].includes(parsed.hostname)) throw new ExtensionManagementError("source_not_allowed", "Package metadata comes only from registry.npmjs.org or pypi.org.");
  const response = await fetch(parsed, { redirect: "error", signal: AbortSignal.timeout(20_000), headers: { accept: "application/json" } });
  if (response.status === 404) throw new ExtensionManagementError("package_not_found", "That package or version does not exist.", 404);
  if (!response.ok) throw new ExtensionManagementError("registry_unavailable", `The package registry answered ${response.status}.`, 502);
  const body = await response.arrayBuffer();
  if (body.byteLength > 2 * 1024 * 1024) throw new ExtensionManagementError("metadata_invalid", "Package metadata is too large.", 502);
  return JSON.parse(Buffer.from(body).toString("utf8"));
}

/** Directory listing helper for tests and diagnostics. */
export async function listMcpRuntimeRoots(home: string): Promise<string[]> {
  return await readdir(join(home, "mcp-runtimes")).catch(() => []);
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${randomBytes(16).toString("hex")}.tmp`;
  await writeFile(temporary, contents, { flag: "wx" });
  try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; }
}
