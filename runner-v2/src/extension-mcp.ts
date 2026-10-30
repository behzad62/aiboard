import { createHash, randomBytes } from "node:crypto";
import { access, constants, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { NativeTool, ToolResult } from "./agent-contracts.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { ExtensionCredentialStore } from "./extension-credentials.js";
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
  close(): Promise<void>;
}

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
    const client = this.remoteClient(extensionId, component);
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
    this.storeTokens(pending.extensionId, tokens, pending.description.resource);
    await this.writeOAuthClient(pending.extensionId, { tokenEndpoint: pending.description.tokenEndpoint, clientId: pending.clientId, resource: pending.description.resource });
    return { extensionId: pending.extensionId };
  }

  private storeTokens(extensionId: string, tokens: OAuthTokens, resource: string): void {
    this.options.credentials.put({
      extensionId, name: "oauth", kind: "oauth", value: tokens.accessToken, resource,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}), ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}), ...(tokens.scope ? { scope: tokens.scope } : {}),
    });
  }

  /** A current access token, refreshed inside the Runner when it is about to expire. */
  private async oauthAuthorization(extensionId: string): Promise<string> {
    const stored = this.options.credentials.list(extensionId).find((entry) => entry.name === "oauth");
    if (!stored) throw new RemoteMcpError("needs_auth", "Not signed in.");
    const token = this.options.credentials.reveal(stored.ref);
    if (!token.expiresAt || Date.parse(token.expiresAt) - 60_000 > Date.now()) return `Bearer ${token.value}`;
    const client = (await this.readOAuthClients())[extensionId];
    if (!token.refreshToken || !client) throw new RemoteMcpError("needs_auth", "The sign-in expired.");
    const refreshed = await exchangeToken({ tokenEndpoint: client.tokenEndpoint, resource: client.resource }, { grant_type: "refresh_token", refresh_token: token.refreshToken, client_id: client.clientId }, this.options.remoteFetch ?? fetch);
    this.storeTokens(extensionId, { ...refreshed, ...(refreshed.refreshToken ?? token.refreshToken ? { refreshToken: refreshed.refreshToken ?? token.refreshToken } : {}) }, client.resource);
    return `Bearer ${refreshed.accessToken}`;
  }

  private remoteClient(extensionId: string, component: McpServerComponent): RemoteMcpClient {
    return new RemoteMcpClient({
      url: component.url!, ...(this.options.remoteFetch ? { fetch: this.options.remoteFetch } : {}),
      authorization: async () => {
        if (component.auth === "oauth") return await this.oauthAuthorization(extensionId);
        if (component.auth === "bearer") return `Bearer ${this.credentialValues(extensionId, ["MCP_BEARER_TOKEN"]).MCP_BEARER_TOKEN}`;
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
  async launchPlans(generation: number): Promise<{ plans: LaunchPlan[]; unavailable: Array<{ serverName: string; reason: string }> }> {
    const service = this.requireService();
    const reserved = new Set(this.options.reservedServerNames ?? []);
    const plans: LaunchPlan[] = [];
    const unavailable: Array<{ serverName: string; reason: string }> = [];
    for (const entry of await service.managedMcpServers(generation)) {
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
    const remote = await this.remoteChatTools(generation, artifacts);
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

  /** The only extension tool surface offered to a future remote connector. */
  async remoteAdmittedTools(generation: number, sessionId: string, artifacts: ArtifactStore): Promise<ChatMcpTools> {
    const remote = await this.remoteChatTools(generation, artifacts, true);
    try {
      const local = await this.stdioChatTools(generation, sessionId, artifacts, undefined, true);
      return { tools: [...local.tools, ...remote.tools], ...(local.binding ? { binding: local.binding } : {}),
        unavailable: [...local.unavailable, ...remote.unavailable],
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
  private async remoteChatTools(generation: number, artifacts: ArtifactStore, remotelyExposed = false): Promise<ChatMcpTools> {
    const tools: NativeTool<unknown>[] = [];
    const unavailable: Array<{ serverName: string; reason: string }> = [];
    const clients: RemoteMcpClient[] = [];
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
      const client = this.remoteClient(entry.extensionId, component);
      try {
        await client.initialize();
        const listed = await client.listTools();
        const snapshot = { schemaDigest: canonicalMcpDigest(listed), names: listed.map((tool) => tool.name) };
        const decisions = await Promise.all(listed.map((tool) => this.requireService().managedMcpToolAdmitted(entry, snapshot.schemaDigest, snapshot.names, tool.name, remotelyExposed)));
        const admitted = new Set(listed.filter((_tool, index) => decisions[index]).map((tool) => tool.name));
        clients.push(client);
        const created = createRemoteMcpTools(component.serverName, listed, async (name, args, context) => {
          try {
            return await client.callTool(name, args, context.signal) as McpCallResult;
          } catch (error) {
            const unknown = error instanceof RemoteMcpError && error.code === "outcome_unknown";
            return { isError: true, content: [{ type: "text", text: (unknown ? "OUTCOME UNKNOWN (not retried): " : "") + describe(error) }] };
          }
        }, artifacts, {
          admit: (_server, tool) => admitted.has(tool.name),
          ...(remotelyExposed ? { name: (_server: string, tool: { name: string }) => remoteToolName(entry, tool.name, snapshot.schemaDigest) } : {}),
          guard: (tool, _server, discovered) => this.guard(tool, entry, discovered.name, snapshot, remotelyExposed, async () => {
            const current = await client.listTools();
            return { schemaDigest: canonicalMcpDigest(current), names: current.map((item) => item.name) };
          }),
        }) as NativeTool<unknown>[];
        tools.push(...created);
      } catch (error) {
        await client.close();
        unavailable.push({ serverName: component.serverName, reason: error instanceof RemoteMcpError && error.code === "needs_auth" ? "Needs sign-in in Settings → Extensions." : describe(error) });
      }
    }
    return { tools, unavailable, close: async () => { await Promise.allSettled(clients.map((client) => client.close())); } };
  }

  private guard<T>(tool: NativeTool<T>, entry: ManagedMcpServerEntry, toolName: string,
    snapshot: { schemaDigest: string; names: readonly string[] }, remotelyExposed: boolean,
    refresh?: () => Promise<{ schemaDigest: string; names: readonly string[] }>): NativeTool<T> {
    return {
      ...tool,
      execute: async (input, context) => {
        let admitted = false;
        try {
          const current = refresh ? await refresh() : snapshot;
          admitted = await this.requireService().managedMcpToolAdmitted(entry, current.schemaDigest, current.names, toolName, remotelyExposed);
        } catch { /* An unavailable policy or changed server fails closed. */ }
        const refusal = await this.refusal(entry, tool.assessAccess?.(input, context)?.destructive !== false).catch(() => undefined);
        if (!admitted) {
          // Local callers keep the actionable disabled/removed reason; remote callers see only unavailable.
          if (!remotelyExposed && refusal) return { isError: true, content: [{ type: "text", text: refusal }], error: { code: "permission_denied", message: refusal } };
          return { isError: true, content: [{ type: "text", text: "Tool is unavailable." }], error: { code: "tool_unavailable", message: "Tool is unavailable." } };
        }
        if (refusal) return { isError: true, content: [{ type: "text", text: refusal }], error: { code: "permission_denied", message: refusal } };
        return await tool.execute(input, context);
      },
    };
  }

  private async stdioChatTools(generation: number, sessionId: string, artifacts: ArtifactStore,
    build?: { binding: ExecutionHostRunBinding; permissionProfile: PermissionProfile }, remotelyExposed = false): Promise<ChatMcpTools> {
    const launched = await this.launchPlans(generation);
    const unavailable = launched.unavailable;
    const eligible = await Promise.all(launched.plans.map((plan) => this.requireService().managedMcpServerEligible(plan.entry, remotelyExposed)));
    const plans = launched.plans.filter((_plan, index) => eligible[index]);
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
    const snapshots = new Map<string, { schemaDigest: string; names: readonly string[] }>();
    try {
      if (!build) {
        await binding.recover({ maxRecords: 1_024, timeoutMs: 30_000 });
        await cleanupRecoveredMcpTransports(binding);
      }
      for (const plan of plans) if (plan.secrets) await provisionMcpSecrets(plan.secrets.directory, plan.secrets.values);
      const discovery = this.options.internal.createMcpDiscoveryExecutor({ runId, servers, attestation });
      let discovered;
      try {
        discovered = await discovery.discover();
      } finally {
        await discovery.close();
      }
      const launches = await this.options.internal.resolveMcpRuntimeLaunches({ servers, attestation });
      manager = new McpManager({
        runId, discovery: discovered, cwd: this.options.projectRoot, servers,
        reattest: () => this.options.internal.resolveMcpRuntimeLaunches({ servers, attestation }),
        transportFactory: this.wrapTransport(createExecutionHostMcpTransportFactory({ run: binding, permissionProfile, projectDirectory: this.options.projectRoot, launches }), async (name) => await this.beforeLaunch(plans, name)),
      });
      await manager.start();
      for (const server of discovered.servers) {
        if (server.status !== "ready" || !server.schemaDigest) unavailable.push({ serverName: server.name, reason: "It did not complete the MCP handshake." });
        else snapshots.set(server.name, { schemaDigest: server.schemaDigest, names: server.tools.map((tool) => tool.name) });
      }
    } catch (error) {
      await manager?.close().catch(() => undefined);
      if (!build) await binding.close().catch(() => undefined);
      throw error;
    }
    const owned = manager;
    const entries = new Map(plans.map((plan) => [plan.spec.name, plan.entry]));
    const admitted = new Set<string>();
    for (const { client, tool } of owned.toolEntries()) {
      const entry = entries.get(client.spec.name);
      const snapshot = snapshots.get(client.spec.name);
      if (entry && snapshot && await this.requireService().managedMcpToolAdmitted(entry, snapshot.schemaDigest, snapshot.names, tool.name, remotelyExposed)) {
        admitted.add(JSON.stringify([client.spec.name, tool.name]));
      }
    }
    const tools = createMcpTools(owned, artifacts, {
      admit: (server, tool) => admitted.has(JSON.stringify([server, tool.name])),
      ...(remotelyExposed ? { name: (server: string, tool: { name: string }) => remoteToolName(entries.get(server)!, tool.name, snapshots.get(server)!.schemaDigest) } : {}),
      guard: (tool, server, discovered) => this.guard(tool, entries.get(server)!, discovered.name, snapshots.get(server)!, remotelyExposed),
    }) as NativeTool<unknown>[];
    return {
      tools,
      binding,
      unavailable,
      status: () => owned.status(),
      close: async () => {
        try { await owned.close(); } finally { if (!build) await binding.close(); }
      },
    };
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
  let current: { generation: number; admitted: ChatMcpTools; broker: ToolBroker } | undefined;
  let sequence = 0;
  const activeCalls = new Set<string>();
  const notSentCalls = new Set<string>();
  const load = async () => {
    const generation = await options.generation();
    if (current && current.generation === generation) return current;
    const previous = current;
    current = undefined;
    if (previous) await previous.admitted.close().catch(() => undefined);
    const admitted = await runtime.remoteAdmittedTools(generation, sessionId, options.artifacts);
    const broker = new ToolBroker({
      // A crashed MCP server must settle as outcome_unknown promptly, not at
      // the generic two-minute broker ceiling; recovery is a fresh request.
      toolTimeoutMs: 30_000,
      permissionProfile: "full", workspacePath: options.workspacePath, artifacts: options.artifacts,
      ...(admitted.binding ? { executionGrants: admitted.binding.executionGrants } : {}),
    });
    for (const tool of admitted.tools) broker.register({
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
    current = { generation, admitted, broker };
    return current;
  };
  const invoke = async (identity: VerifiedRemoteIdentity, relayToolId: string, args: unknown, signal?: AbortSignal,
    beforeBroker?: () => boolean): Promise<RemoteInvocationResult> => {
    const loaded = await load();
    const tool = loaded.admitted.tools.find((entry) => entry.definition.name === relayToolId);
    if (!tool) throw new Error("Plugin tool is not admitted for remote use.");
    if (signal?.aborted || (beforeBroker && !beforeBroker())) {
      throw new McpProtocolError("mcp_request_cancelled", "Remote plugin was refused before dispatch.", "not_sent");
    }
    const callId = `remote-plugin-${++sequence}`;
    activeCalls.add(callId);
    try {
      const result = await loaded.broker.invoke(
        { type: "tool_call", callId, name: relayToolId, arguments: args },
        {
          runId: loaded.admitted.binding?.runId ?? `remote-plugin-${loaded.generation}`,
          sessionId, actor: { role: "remote", id: identity.clientId }, workspacePath: options.workspacePath,
          ...(signal ? { signal } : {}),
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
    async close(): Promise<void> {
      const previous = current;
      current = undefined;
      if (previous) await previous.admitted.close();
    },
  };
}

// ---- Helpers ---------------------------------------------------------------------------------------------

/** Plan P2 relay naming: plugin_<server>_<tool>_<digest8>, digest8 from the R1c schema digest. */
export function remotePluginToolId(serverName: string, toolName: string, schemaDigest: string): string {
  const clean = (value: string) => value.replace(/[^A-Za-z0-9_-]+/g, "_");
  return `plugin_${clean(serverName)}_${clean(toolName)}_${schemaDigest.slice(0, 8)}`;
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
