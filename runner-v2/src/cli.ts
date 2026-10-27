import { configureMcpServers, mcpConfigurationDigest } from "./mcp-configuration.js";
import { randomBytes } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { ControlServer } from "./control-server.js";
import { ToolBenchSessions } from "./toolbench-session.js";
import { ChatAgentSessions } from "./chat-agent-session.js";
import { ExtensionCredentialStore } from "./extension-credentials.js";
import { ExtensionManagementService, type ExternalItem } from "./extension-management-service.js";
import { ExtensionRunBindings } from "./extension-run-bindings.js";
import { fetchPackageMetadata, ManagedMcpRuntime } from "./extension-mcp.js";
import { activateStagedRunnerExtensions, createPluginHandler, type RunnerExtensionActivation } from "./extension-plugin.js";
import { OAUTH_CALLBACK_PATH } from "./extension-control-routes.js";
import { createBoundedGitCommandExecutor } from "./git-preflight.js";
import { SkillCatalog } from "./skill-catalog.js";
import { ArtifactStore } from "./artifact-store.js";
import { BuildUserMediaStore } from "./build-user-media.js";
import { EncryptedProviderConfigStore } from "./encrypted-provider-config-store.js";
import { prepareCredentialStores } from "./credential-migration.js";
import { createExecutionHost } from "./execution-host.js";
import { createRunnerInternalExecutionContext } from "./runner-internal-execution-context.js";
import { captureRunGitBaseline } from "./git-bootstrap.js";
import {
  classifyNativeBuildRecoveryError,
  NATIVE_BUILD_RUNTIME_RECOVERY_COVERAGE,
  NativeBuildFactory,
  preflightRecoveredRunnerCapabilities,
  selectRuntimeCandidates,
  snapshotNativeBuildAmbientEnvironment,
  defaultSharedSkillRoots,
} from "./native-build-factory.js";
import {
  NativeBuildManager,
} from "./native-build-manager.js";
import {
  failBuildIfActive,
  isTerminalRunState,
  syncAutonomousBuildLifecycle,
} from "./cli-lifecycle.js";
import {
  createLiveMcpStatusRegistry,
  type McpServerSpec,
} from "./mcp-tools.js";
import { assertSupportedNodeVersion } from "./node-version.js";
import { SqlitePermissionStore } from "./permission-store.js";
import {
  capabilitiesConfigCanonicalTargetIsInsideProject,
  emptyRunnerCapabilitiesConfig,
  loadRunnerCapabilitiesConfig,
  type RunnerCapabilitiesConfig,
} from "./runner-capabilities-config.js";
import { RunSupervisor } from "./run-supervisor.js";
import { RUNNER_BUILTIN_TOOL_NAMES } from "./runner-extension.js";
import {
  closeRunnerResources,
  reconcileRunnerStartup,
  startupFailureWithCleanup,
  type RunnerResources,
} from "./runner-resource-cleanup.js";
import { SqliteBuildSpecStore } from "./sqlite-build-spec-store.js";
import { SqliteEventStore } from "./sqlite-event-store.js";
import { assertExternalState, projectIdentity, tryAcquireLock } from "./launcher-instance.js";
import { receiveLauncherHandshake, startLauncherControl, type LauncherHandshake } from "./launcher-ipc.js";
import { LocalMcpSessions } from "./local-stdio-mcp.js";
import { LocalPairing } from "./local-pairing.js";
import { RemoteService } from "./remote-service.js";
import { StubRemoteSessionIssuer } from "./remote-auth.js";
import type { RemoteTransport } from "./remote-connector.js";

const PROTOCOL_VERSION = 2;

interface CliOptions {
  projectPath: string;
  stateDirectory: string;
  port: number;
  token: string;
  legacyTokenProvided: boolean;
  legacyToken?: string;
  mcpServers: McpServerSpec[];
  allowOrigins: string[];
  capabilitiesConfigPath?: string;
  /** Shared, AI Board-owned extension registry and package store (outside every project). */
  extensionsHome: string;
  /** Runs the owner set aside: left paused and untouched, not rebuilt at startup. */
  setAsideRuns: ReadonlySet<string>;
  /** aiboard remote: compose the Runner-owned remote service (R1d). */
  remote: boolean;
  /** Per-user remote device custody directory, required with --remote (launcher-supplied). */
  remoteDeviceDirectory?: string;
}

void main();

async function main(): Promise<void> {
  const resources: RunnerResources = {};
  let launcher: LauncherHandshake | undefined;
  let releaseLauncherLifetime: (() => void) | undefined;
  let launcherControl: Awaited<ReturnType<typeof startLauncherControl>> | undefined;
  let launcherStopRequested = false;
  let requestLauncherShutdown: (() => void) | undefined;
  try {
    assertSupportedNodeVersion(process.versions.node);
    const args = parseRunnerArguments(process.argv.slice(2));
    const launcherFlag = args.indexOf("--launcher-ipc");
    if (launcherFlag !== -1) {
      args.splice(launcherFlag, 1);
      if (args.includes("--launcher-ipc")) throw new Error("invalid_arguments: Duplicate launcher channel.");
      launcher = await receiveLauncherHandshake();
      process.on("message", (message: unknown) => {
        if (typeof message === "object" && message !== null && "type" in message && message.type === "aiboard-launcher-stop") {
          launcherStopRequested = true;
          requestLauncherShutdown?.();
        }
      });
      process.once("disconnect", () => { launcherStopRequested = true; requestLauncherShutdown?.(); });
    }
    if (isHelpRequested(args)) {
      printHelp();
      return;
    }
    const options = parseArguments(args);
    await assertDirectory(options.projectPath, "project");
    if (launcher) {
      const identity = await projectIdentity(options.projectPath);
      const canonicalState = await realpath(options.stateDirectory);
      if (identity.projectPath !== launcher.identity.projectPath || identity.projectKey !== launcher.identity.projectKey ||
          identity.owner !== launcher.identity.owner || options.stateDirectory !== launcher.stateDirectory ||
          (process.platform === "win32" ? canonicalState.toLowerCase() !== options.stateDirectory.toLowerCase() : canonicalState !== options.stateDirectory)) {
        throw new Error("launcher_identity_mismatch: The launcher and Runner identities do not match.");
      }
      assertExternalState(identity.projectPath, canonicalState);
      const release = tryAcquireLock(options.stateDirectory, "lifetime");
      if (!release) throw new Error("launcher_busy: A Runner already owns this project state.");
      releaseLauncherLifetime = release;
      options.token = launcher.token;
      options.legacyTokenProvided = launcher.legacyToken !== undefined;
      options.legacyToken = launcher.legacyToken;
    }
    if (isInside(options.projectPath, options.stateDirectory)) {
      throw new Error(
        "invalid_state_directory: Runner state must be outside the project directory."
      );
    }
    let capabilitiesConfig = emptyRunnerCapabilitiesConfig();
    if (options.capabilitiesConfigPath) {
      if (
        await capabilitiesConfigCanonicalTargetIsInsideProject(
          options.projectPath,
          options.capabilitiesConfigPath,
        )
      ) {
        throw new Error(
          "invalid_capabilities_config: Runner capabilities configuration must be outside the project directory."
        );
      }
      capabilitiesConfig = await loadRunnerCapabilitiesConfig(options.capabilitiesConfigPath);
    }
    await mkdir(options.stateDirectory, { recursive: true });
    await assertDirectory(options.stateDirectory, "state");

    if (isInside(options.projectPath, options.extensionsHome)) {
      throw new Error("invalid_extensions_home: The extension store must be outside the project directory.");
    }
    const credentialStorage = prepareCredentialStores({
      stateDirectory: options.stateDirectory,
      legacyToken: options.legacyTokenProvided ? options.legacyToken ?? options.token : undefined,
    });
    let providerConfigs: EncryptedProviderConfigStore;
    let extensionCredentials: ExtensionCredentialStore;
    try {
      const storeOptions = { requireExisting: true, beforeAccess: credentialStorage.assertLegacyUnchanged };
      providerConfigs = new EncryptedProviderConfigStore(credentialStorage.providerPath, credentialStorage.providerKey, storeOptions);
      resources.providerConfigs = providerConfigs;
      extensionCredentials = new ExtensionCredentialStore(credentialStorage.extensionPath, credentialStorage.extensionKey, storeOptions);
      resources.extensionCredentials = extensionCredentials;
    } finally {
      credentialStorage.providerKey.fill(0);
      credentialStorage.extensionKey.fill(0);
    }

    const artifactDirectory = join(options.stateDirectory, "artifacts");
    await mkdir(artifactDirectory, { recursive: true });
    const artifacts = new ArtifactStore(artifactDirectory);
    const ambientEnvironment = snapshotNativeBuildAmbientEnvironment();
    const executionHost = createExecutionHost({
      projectRoot: options.projectPath,
      stateDirectory: options.stateDirectory,
      artifacts,
      ambientEnvironment,
    });
    resources.executionHost = executionHost;
    const internalExecutionContext = createRunnerInternalExecutionContext({
      projectDirectory: options.projectPath,
      stateDirectory: options.stateDirectory,
      processKernel: executionHost.internalProcesses,
      ambientEnvironment: executionHost.filteredEnvironmentSource(),
    });
    resources.internalExecutionContext = internalExecutionContext;

    const git = (await internalExecutionContext.gitPreflight()).result;
    if (!git.available) {
      throw new Error(`${git.code}: ${git.reason}`);
    }
    const configuredCapabilitiesAttestation =
      await internalExecutionContext.attestConfiguredCapabilities({
        mcpServers: options.mcpServers,
        capabilitiesConfig,
      });

    const supervisor = new RunSupervisor(
      new SqliteEventStore(join(options.stateDirectory, "events.sqlite"))
    );
    resources.supervisor = supervisor;
    // Retain active and recently completed user visual evidence; prune only
    // terminal-run media older than 30 days before accepting new uploads.
    try {
      const userMedia = new BuildUserMediaStore(join(options.stateDirectory, "user-input-media"));
      await userMedia.cleanupExpired((runId) => {
        try { return isTerminalRunState(supervisor.getRun(runId).state); }
        catch { return true; } // Abandoned pre-build uploads with no run are pruned after 30 days.
      });
    } catch (error) {
      console.warn(`[runner] user media retention cleanup unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    await validateActiveRecoveryCapabilityContracts(
      supervisor,
      capabilitiesConfig,
      options.stateDirectory,
      options.projectPath,
      executionHost.filteredEnvironmentSource(),
      options.setAsideRuns,
    );
    const gitEnvironment = { ...executionHost.filteredEnvironmentSource(), GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" };
    // Versions bound by a live run or chat session are never collected.
    const pins: { bindings?: ExtensionRunBindings; chats?: ChatAgentSessions } = {};
    // Managed MCP servers: installers and readiness checks run through the same governed internal
    // process kernel; live tools use per-run/per-chat ExecutionHost bindings.
    const installerEnvironment = executionHost.filteredEnvironmentSource();
    const oauthRedirect: { uri?: string } = {};
    // Staged plugin Runner extensions are decided below, once the extension registry is open.
    let runnerExtensionActivation: RunnerExtensionActivation = { active: new Set(), refused: new Map(), deferred: "The Runner is still starting." };
    const managedMcp = new ManagedMcpRuntime({
      home: options.extensionsHome,
      stateDirectory: options.stateDirectory,
      projectRoot: options.projectPath,
      credentials: extensionCredentials,
      internal: internalExecutionContext,
      executionHost,
      capabilitiesConfig: () => capabilitiesConfig,
      reservedServerNames: options.mcpServers.map((server) => server.name),
      cliServers: options.mcpServers,
      oauthRedirectUri: () => oauthRedirect.uri,
      installer: {
        nodeExecutable: process.execPath,
        environment: installerEnvironment,
        fetchJson: fetchPackageMetadata,
        run: async (command, args, cwd) => await createBoundedGitCommandExecutor({ executionDeadlineMs: 600_000, terminationDeadlineMs: 15_000, environment: installerEnvironment, cwd, processKernel: executionHost.internalProcesses, maxOutputBytes: 4 * 1024 * 1024 })(command, [...args]),
      },
    });
    const extensions = await ExtensionManagementService.open({
      home: options.extensionsHome,
      pinnedGenerations: () => new Set([...(pins.bindings?.pinnedGenerations() ?? []), ...(pins.chats?.pinnedGenerations() ?? [])]),
      projectRoot: options.projectPath,
      credentials: extensionCredentials,
      // Git sources run through the same governed internal process kernel as Git preflight.
      git: { executorFor: (cwd) => createBoundedGitCommandExecutor({ executionDeadlineMs: 120_000, terminationDeadlineMs: 15_000, environment: gitEnvironment, cwd, processKernel: executionHost.internalProcesses, maxOutputBytes: 1024 * 1024 }) },
      external: async () => await discoverExternalItems(options.projectPath, options.mcpServers),
      handlers: [managedMcp.handler(), createPluginHandler({ home: options.extensionsHome, mcp: managedMcp, runnerExtensions: () => runnerExtensionActivation })],
    });
    managedMcp.attach(extensions);
    runnerExtensionActivation = await activateStagedRunnerExtensions({
      staged: await extensions.stagedRunnerExtensions(),
      unfinishedBuilds: () => countUnfinishedBuilds(supervisor, options.stateDirectory),
      configuredDirectories: capabilitiesConfig.extensions,
    });
    if (runnerExtensionActivation.deferred) console.warn(`[runner] plugin Runner extensions stay staged: ${runnerExtensionActivation.deferred}`);
    capabilitiesConfig = { ...capabilitiesConfig, extensions: [...capabilitiesConfig.extensions, ...runnerExtensionActivation.active] };
    const extensionBindings = new ExtensionRunBindings(options.stateDirectory, extensions);
    pins.bindings = extensionBindings;
    const mcpStatus = createLiveMcpStatusRegistry(options.mcpServers);
    const permissions = new SqlitePermissionStore(
      join(options.stateDirectory, "permissions.sqlite")
    );
    resources.permissions = permissions;
    const buildFactory = new NativeBuildFactory({
      projectRoot: options.projectPath,
      stateDirectory: options.stateDirectory,
      providerConfigs,
      permissions,
      capabilitiesConfig,
      executionHost,
      internalExecutionContext,
      mcpServers: options.mcpServers,
      mcpAttestation: configuredCapabilitiesAttestation.mcp,
      mcpStatusRegistry: mcpStatus,
      extensions: { service: extensions, bindings: extensionBindings, managedMcp },
      closeProviderConfigs: false,
      baselineFor: (runId) => {
        const revision = supervisor.getRun(runId).baselineRevision;
        if (!revision) throw new Error(`Run ${runId} has no Git baseline.`);
        return revision;
      },
    });
    resources.buildFactory = buildFactory;
    const builds = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(
        join(options.stateDirectory, "build-specs.sqlite")
      ),
      createRuntime: (spec) => buildFactory.create(spec),
      createHistoricalRuntime: (spec, terminalState) =>
        buildFactory.createHistorical(spec, terminalState),
      terminalStateForHistoricalSpec: (spec) => {
        const state = supervisor.getRun(spec.runId).state;
        return isTerminalRunState(state) ? state : undefined;
      },
      prepareSpec: (spec, options) => buildFactory.prepareSpec(spec, options),
      shouldRecoverSpec: (spec) =>
        !isTerminalRunState(supervisor.getRun(spec.runId).state) && !options.setAsideRuns.has(spec.runId),
      validateRecoveredSpec: async (spec) => {
        const run = supervisor.getRun(spec.runId);
        if (isTerminalRunState(run.state)) return;
        await buildFactory.validateRecoveryCapabilityContract(spec);
      },
      onRecoverySpecError: (runId, error) => {
        recordRuntimeRecoveryFailure(supervisor, runId, error);
      },
      validateCrewSpec: (spec) => {
        selectRuntimeCandidates(providerConfigs.load(), spec);
      },
      shouldAutoRun: (runId) => supervisor.getRun(runId).state === "running",
      onBuildFailed: (runId, reason) => failBuildIfActive(supervisor, runId, reason),
      onPumpResult: (runId, result) =>
        syncAutonomousBuildLifecycle(
          supervisor,
          runId,
          result,
          builds.projection(runId),
        ),
      // Pump and cleanup failures share this hook; "runner_cleanup" mislabelled a pump error that paused a run.
      onPumpError: (runId, error) => writeRunnerWarning(runId, error, "runner_error"),
      runArtifactCompaction: (operation) =>
        buildFactory.runArtifactCompaction(operation),
      prepareArtifactCleanup: () => buildFactory.prepareArtifactCleanup(),
    });
    resources.builds = builds;
    await reconcileRunnerStartup([{
      resource: "nativeBuildRuntime",
      covers: NATIVE_BUILD_RUNTIME_RECOVERY_COVERAGE,
      reconcile: async () => {
        const report = await builds.recover();
        if (report.failures.length === 0) return;
        throw new AggregateError(
          report.failures.map((failure) => failure.error),
          `Native Build startup recovery left ${report.failures.length} unresolved owned resource failure(s): ${report.failures.map((failure) => `${failure.runId}:${failure.stage}`).join(", ")}. ` +
          `The run stays paused; a fixed runner recovers it, or start with ${[...new Set(report.failures.map((failure) => `--set-aside-run ${failure.runId}`))].join(" ")} to leave it untouched.`,
        );
      },
    }]);
    const toolBench = new ToolBenchSessions({ projectRoot: options.projectPath, stateDirectory: options.stateDirectory, providerConfigs, executionHost, capabilitiesConfig });
    await toolBench.recover();
    const chatSessions = new ChatAgentSessions({ projectRoot: options.projectPath, stateDirectory: options.stateDirectory, providerConfigs, extensions, skillRoots: defaultSharedSkillRoots(),
      generationTools: async (generation, sessionId, artifacts) => await managedMcp.chatTools(generation, sessionId, artifacts) });
    pins.chats = chatSessions;
    await chatSessions.recover();
    const localPairing = launcher ? new LocalPairing(launcher.instanceId) : undefined;
    if (launcher && localPairing) {
      if (launcher.pairDigest) localPairing.register(launcher.pairDigest);
      if (launcher.peers?.length) localPairing.setPeers(launcher.peers);
    }
    let remoteService: RemoteService | undefined;
    if (options.remote) {
      const unavailableTransport = (): RemoteTransport => ({
        connect: async () => { throw new Error("Remote transport is unavailable until R1e."); },
        close: async () => undefined,
        send: () => undefined,
        onMessage: () => undefined,
        onClose: () => undefined,
      });
      remoteService = new RemoteService({
        stateDirectory: options.stateDirectory,
        deviceDirectory: options.remoteDeviceDirectory!,
        workspacePath: options.projectPath,
        host: executionHost,
        permissionProfile: "full",
        capabilitiesConfig,
        createTransport: unavailableTransport,
        issuer: new StubRemoteSessionIssuer(),
      });
      resources.remote = remoteService;
      await remoteService.start();
    }
    const localMcp = launcher ? new LocalMcpSessions({ host: executionHost, workspacePath: options.projectPath, statePath: join(options.stateDirectory, "local-mcp-owners.sqlite"),
      permissionProfile: "full", capabilitiesConfig }) : undefined;
    const server = new ControlServer({
      ...(remoteService ? { remoteStatus: () => remoteService.status() } : {}),
      localPairing,
      localMcp,
      allowLocalPairDevOrigin: process.env.AIBOARD_LOCAL_PAIR_DEV_ORIGIN === "1",
      toolBench,
      extensions,
      chatSessions,
      supervisor,
      builds,
      buildProvisioner: builds,
      processRecovery: builds,
      providerConfigs,
      userMediaDirectory: join(options.stateDirectory, "user-input-media"),
      allowedOrigins: options.allowOrigins,
      runnerInfo: {
        projectPath: options.projectPath,
        nodeVersion: process.versions.node,
      },
      mcp: mcpStatus,
      permissions,
      token: options.token,
      checkGit: async () => git,
      bootstrapRun: async (input) => {
        if (resolve(input.projectPath) !== options.projectPath) {
          throw new Error(
            `project_mismatch: Runner is bound to ${options.projectPath}.`
          );
        }
        const baseline = await captureRunGitBaseline({
          host: executionHost,
          permissionProfile: input.permissionProfile,
          capabilitiesConfig,
          projectPath: options.projectPath,
          stateDirectory: options.stateDirectory,
          runId: input.runId,
        });
        return {
          baselineRevision: baseline.revision,
          baselineRef: baseline.ref,
        };
      },
    });
    resources.server = server;
    await localMcp?.recover();
    const address = await server.start(options.port);
    oauthRedirect.uri = `${address.url}${OAUTH_CALLBACK_PATH}`;

    const readiness = {
      protocolVersion: PROTOCOL_VERSION,
      url: address.url,
      token: options.token,
      tokenHint: options.token.slice(-6),
      pid: process.pid,
      projectPath: options.projectPath,
      stateDirectory: options.stateDirectory,
      gitVersion: git.version,
      mcp: mcpStatus.status(),
      allowOrigins: options.allowOrigins,
    };
    let shuttingDown = false;
    const shutdown = (signal: NodeJS.Signals) => {
      if (shuttingDown) return;
      shuttingDown = true;
      localPairing?.close();
      void (async () => {
        let controlError: unknown;
        try { await launcherControl?.close(); } catch (error) { controlError = error; }
        try { await closeRunnerResources(resources); }
        catch (error) {
          if (controlError) throw new AggregateError([controlError, error], "Runner control and resource cleanup failed.");
          throw error;
        }
        if (controlError) throw controlError;
      })().then(
        () => {
          process.exitCode = signal === "SIGINT" ? 130 : 0;
          releaseLauncherLifetime?.();
          releaseLauncherLifetime = undefined;
          if (launcher && process.connected) process.disconnect?.();
        },
        (error: unknown) => {
          writeStartupError(error);
          process.exitCode = 1;
        }
      );
    };
    const signalShutdown = (signal: NodeJS.Signals) => {
      if (launcher && !launcherControl) { launcherStopRequested = true; return; }
      shutdown(signal);
    };
    process.once("SIGINT", signalShutdown);
    process.once("SIGTERM", signalShutdown);
    requestLauncherShutdown = () => signalShutdown("SIGTERM");

    if (launcher) {
      launcherControl = await startLauncherControl({
        identity: launcher.identity,
        instanceId: launcher.instanceId,
        version: launcher.version,
        startedAt: Math.floor(Date.now() - process.uptime() * 1_000),
        port: address.port,
        token: options.token,
        controlKey: Buffer.from(launcher.controlKey, "hex"),
        registerPair: (digest, peers) => {
          if (!localPairing) throw new Error("Pairing unavailable.");
          localPairing.register(digest);
          if (peers?.length) localPairing.setPeers(peers);
        },
        registerLocalMcp: (depth) => {
          if (!localMcp) throw new Error("Local MCP is unavailable.");
          return localMcp.mint(depth);
        },
        shutdown: requestLauncherShutdown,
      });
      if (process.connected) process.send?.({ type: "aiboard-launcher-ready", instance: launcherControl.instance });
      if (launcherStopRequested || !process.connected) requestLauncherShutdown();
    } else {
      process.stdout.write(`${JSON.stringify(readiness)}\n`);
      writeReadableStartupSummary(readiness);
    }
  } catch (error) {
    let cleanupError: unknown;
    try { await launcherControl?.close(); } catch (closeError) { cleanupError = closeError; }
    try { await closeRunnerResources(resources); }
    catch (closeError) { cleanupError = cleanupError ? new AggregateError([cleanupError, closeError], "Runner cleanup failed.") : closeError; }
    writeStartupError(
      cleanupError
        ? startupFailureWithCleanup(error, cleanupError)
        : error,
    );
    process.exitCode = 1;
    if (!cleanupError) {
      releaseLauncherLifetime?.();
      if (launcher && process.connected) process.disconnect?.();
    }
  }
}

/** Builds that are not terminal, set-aside runs included: their capability contracts are fixed. */
function countUnfinishedBuilds(supervisor: RunSupervisor, stateDirectory: string): number {
  const specs = new SqliteBuildSpecStore(join(stateDirectory, "build-specs.sqlite"));
  try {
    return specs.list().filter((spec) => !isTerminalRunState(supervisor.getRun(spec.runId).state)).length;
  } finally {
    specs.close();
  }
}

async function validateActiveRecoveryCapabilityContracts(
  supervisor: RunSupervisor,
  capabilitiesConfig: RunnerCapabilitiesConfig,
  stateDirectory: string,
  projectDirectory: string,
  environment: Readonly<Record<string, string>>,
  setAsideRuns: ReadonlySet<string>,
): Promise<void> {
  const specs = new SqliteBuildSpecStore(join(stateDirectory, "build-specs.sqlite"));
  const failures: unknown[] = [];
  try {
    for (const spec of specs.list()) {
      const run = supervisor.getRun(spec.runId);
      if (isTerminalRunState(run.state) || setAsideRuns.has(spec.runId)) continue;
      try {
        await preflightRecoveredRunnerCapabilities({
          spec,
          config: capabilitiesConfig,
          environment,
          projectDirectory,
          stateDirectory,
          reservedToolNames: RUNNER_BUILTIN_TOOL_NAMES,
        });
      } catch (error) {
        recordRuntimeRecoveryFailure(supervisor, spec.runId, error);
        failures.push(error);
      }
    }
  } finally {
    specs.close();
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      "Runner startup rejected active Build capability contracts.",
    );
  }
}

/**
 * A capability-contract refusal is a lasting incompatibility and fails the run. Any other rebuild
 * failure pauses it instead: twice a runner defect (a replay check the new code disagreed with)
 * permanently failed a healthy run (tunnel run). A fixed runner recovers it; --set-aside-run lets the
 * owner start the runner without it.
 */
function recordRuntimeRecoveryFailure(
  supervisor: RunSupervisor,
  runId: string,
  error: unknown,
): void {
  try {
    const run = supervisor.getRun(runId);
    if (isTerminalRunState(run.state)) return;
    if (classifyNativeBuildRecoveryError(error)?.kind === "capability") {
      supervisor.fail(runId, `runtime-recovery:${run.lastSequence}`, runtimeRecoveryReason(error));
      return;
    }
    writeRunnerWarning(runId, new Error(`${runtimeRecoveryReason(error)}: the run stays ${run.state === "running" ? "paused" : run.state}; start with --set-aside-run ${runId} to leave it untouched.`, { cause: error }));
    if (run.state !== "running") return;
    supervisor.pause(
      runId,
      `runtime-recovery:${run.lastSequence}`,
      runtimeRecoveryReason(error),
    );
  } catch (recordError) {
    writeRunnerWarning(runId, new AggregateError(
      [error, recordError],
      "Unable to record Runner recovery failure.",
    ));
  }
}

function runtimeRecoveryReason(error: unknown): string {
  const classified = classifyNativeBuildRecoveryError(error);
  if (classified?.kind === "capability") {
    return `capability-contract:${classified.code}`;
  }
  if (classified?.kind === "runtime") {
    return `runtime-recovery:${classified.stage}_failed`;
  }
  return "runtime-recovery:runtime_failed";
}

function parseRunnerArguments(rawArgs: string[]): string[] {
  const args = [...rawArgs];
  while (args.length > 0 && args[0] === "--") {
    args.shift();
  }
  if (
    args.length >= 2 &&
    isAbsolute(args[0]) &&
    args[1].startsWith("--") &&
    args.includes("--state-dir")
  ) {
    args.unshift("--project");
  }
  return args;
}

function isHelpRequested(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

function parseArguments(args: string[]): CliOptions {
  const values = new Map<string, string>();
  let remote = false;
  const mcpServers: McpServerSpec[] = [];
  const mcpEnvelopes: string[] = [];
  const allowOrigins: string[] = [];
  const allowOriginSet = new Set<string>();
  const setAsideRuns = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!flag?.startsWith("--")) {
      throw new Error(`invalid_arguments: Unknown token ${flag ?? "argument"}.`);
    }
    if (flag === "--remote") { remote = true; continue; }
    if (flag === "--mcp-envelope") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("invalid_arguments: Expected name=JSON after --mcp-envelope.");
      mcpEnvelopes.push(value); index += 1; continue;
    }
    if (flag === "--mcp") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("invalid_arguments: Expected value after --mcp.");
      }
      const separator = value.indexOf("=");
      if (separator < 1 || !value.slice(separator + 1).trim()) {
        throw new Error("invalid_arguments: --mcp must be name=command.");
      }
      mcpServers.push({
        name: value.slice(0, separator).trim(),
        command: value.slice(separator + 1).trim(),
      });
      index += 1;
      continue;
    }
    if (flag === "--set-aside-run") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--") || !value.trim()) {
        throw new Error("invalid_arguments: Expected a run ID after --set-aside-run.");
      }
      setAsideRuns.add(value.trim());
      index += 1;
      continue;
    }
    if (flag === "--allow-origin") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("invalid_arguments: Expected value after --allow-origin.");
      }
      for (const origin of parseAllowOriginValue(value)) {
        if (!allowOriginSet.has(origin)) {
          allowOriginSet.add(origin);
          allowOrigins.push(origin);
        }
      }
      index += 1;
      continue;
    }
    if (
      ![
        "--project",
        "--state-dir",
        "--port",
        "--token",
        "--capabilities-config",
        "--extensions-home",
        "--remote-device-dir",
      ].includes(flag)
    ) {
      throw new Error(`invalid_arguments: Unknown option ${flag}.`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`invalid_arguments: Expected a value after ${flag}.`);
    }
    if (values.has(flag)) {
      throw new Error(`invalid_arguments: Duplicate option ${flag}.`);
    }
    values.set(flag, value);
    index += 1;
  }

  const projectPath = requiredAbsolutePath(values, "--project");
  const stateDirectory = requiredAbsolutePath(values, "--state-dir");
  const capabilitiesConfigPath = optionalAbsolutePath(
    values,
    "--capabilities-config",
  );
  const remoteDeviceDirectory = optionalAbsolutePath(values, "--remote-device-dir");
  if (remote !== (remoteDeviceDirectory !== undefined)) {
    throw new Error("invalid_arguments: --remote and --remote-device-dir must be given together.");
  }
  const extensionsHome = optionalAbsolutePath(values, "--extensions-home") ?? join(homedir(), ".aiboard", "runner-extensions");
  const portText = values.get("--port") ?? "0";
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("invalid_arguments: --port must be an integer from 0 to 65535.");
  }
  const token = values.get("--token") ?? randomBytes(32).toString("hex");
  if (token.length < 16) {
    throw new Error("invalid_arguments: --token must contain at least 16 characters.");
  }
  return {
    projectPath,
    stateDirectory,
    port,
    token,
    legacyTokenProvided: values.has("--token"),
    mcpServers: [...configureMcpServers(mcpServers, mcpEnvelopes)],
    allowOrigins,
    extensionsHome,
    ...(capabilitiesConfigPath ? { capabilitiesConfigPath } : {}),
    setAsideRuns,
    remote,
    ...(remoteDeviceDirectory ? { remoteDeviceDirectory } : {}),
  };
}

function parseAllowOriginValue(raw: string): string[] {
  const entries = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (entries.length === 0) {
    throw new Error("invalid_arguments: --allow-origin requires at least one origin.");
  }
  return entries.map((entry) => {
    try {
      return new URL(entry).origin;
    } catch {
      throw new Error(
        `invalid_arguments: --allow-origin value "${entry}" is not a valid origin URL.`
      );
    }
  });
}

function printHelp(): void {
  const usage = [
    "AI Board Runner V2",
    "",
    "Usage:",
    "  npm run runner:v2 -- --project <abs-path> --state-dir <abs-path> --port <port> [options]",
    "",
    "Options:",
    "  --project <path>        Absolute path to the project directory. (required)",
    "  --state-dir <path>      Absolute path to runner state. Must be outside project. (required)",
    "  --port <number>         TCP port to bind (0 = random). Default 0.",
    "  --token <string>        Authentication token. Auto-generated if omitted.",
    "  --capabilities-config <path>  Absolute trusted JSON configuration outside the project.",
    "  --mcp <name=command>    Register MCP server; can be repeated.",
    "  --mcp-envelope <name=JSON> Fixed paths/network/credential requirements; defaults to no extra access.",
    "  --extensions-home <abs-path> Managed skills/MCP/plugins store (default ~/.aiboard/runner-extensions).",
    "  --allow-origin <url>    Allowed browser CORS origin (repeatable, comma-separated list supported).",
    "  --set-aside-run <id>    Start without rebuilding this run; it stays paused and untouched (repeatable).",
    "  --remote                Also start the Runner-owned remote service (aiboard remote).",
    "                         Defaults to loopback origins + aiboard.me.",
    "  --help, -h              Show this help text.",
    "",
    "Examples:",
    "  npm run runner:v2 -- --project C:\\path\\to\\project --state-dir C:\\path\\to\\runner-state --port 8787",
    "  npm run runner:v2 -- --project C:\\path\\to\\project --state-dir C:\\path\\to\\runner-state --capabilities-config C:\\path\\to\\runner-capabilities.json",
    "  npm run runner:v2 -- --project C:\\path\\to\\project --state-dir C:\\path\\to\\runner-state --allow-origin https://aiboard.me",
    "  npm run runner:v2 -- --project C:\\path\\to\\project --state-dir C:\\path\\to\\runner-state --allow-origin https://aiboard.me,https://127.0.0.1:8787",
    "",
  ];
  process.stdout.write(`${usage.join("\n")}\n`);
}

function writeReadableStartupSummary(
  readiness: {
    protocolVersion: number;
    url: string;
    tokenHint: string;
    pid: number;
    projectPath: string;
    stateDirectory: string;
    gitVersion: string;
    mcp: unknown[];
    allowOrigins: string[];
  }
): void {
  const lines = [
    "AI Board Runner V2",
    "===================",
    `  Protocol   : ${readiness.protocolVersion}`,
    `  URL        : ${readiness.url}`,
    `  Token hint : ...${readiness.tokenHint}`,
    `  PID        : ${readiness.pid}`,
    `  Project    : ${readiness.projectPath}`,
    `  State      : ${readiness.stateDirectory}`,
    `  Git        : ${readiness.gitVersion}`,
    `  MCP servers: ${readiness.mcp.length}`,
  ];
  if (readiness.allowOrigins.length > 0) {
    lines.push("  Allowed CORS origins:");
    for (const origin of readiness.allowOrigins) {
      lines.push(`    - ${origin}`);
    }
  } else {
    lines.push("  Allowed CORS origins:");
    lines.push("    - loopback (127.0.0.1, localhost)");
    lines.push("    - https://aiboard.me");
    lines.push("    - https://www.aiboard.me");
  }
  lines.push("");
  lines.push("  Tip: Use --help to show all CLI flags and defaults.");
  process.stderr.write(`${lines.join("\n")}\n`);
}

function requiredAbsolutePath(values: Map<string, string>, flag: string): string {
  const value = values.get(flag);
  if (!value) throw new Error(`invalid_arguments: ${flag} is required.`);
  if (!isAbsolute(value)) {
    throw new Error(`invalid_arguments: ${flag} must be an absolute path.`);
  }
  return resolve(value);
}

function optionalAbsolutePath(
  values: Map<string, string>,
  flag: string,
): string | undefined {
  const value = values.get(flag);
  if (value === undefined) return undefined;
  if (!isAbsolute(value)) {
    throw new Error(`invalid_arguments: ${flag} must be an absolute path.`);
  }
  return resolve(value);
}

function isInside(parent: string, candidate: string): boolean {
  const traversal = relative(parent, candidate);
  return traversal === "" || (!traversal.startsWith("..") && !isAbsolute(traversal));
}

async function assertDirectory(path: string, label: string): Promise<void> {
  let details;
  try {
    details = await stat(path);
  } catch {
    throw new Error(`invalid_${label}_directory: ${path} does not exist.`);
  }
  if (!details.isDirectory()) {
    throw new Error(`invalid_${label}_directory: ${path} is not a directory.`);
  }
}

function writeStartupError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
}

function writeRunnerWarning(runId: string, error: unknown, warning = "runner_cleanup"): void {
  const message = error instanceof Error ? error.message : String(error);
  // The wrapper alone ("Artifact reachability scan failed") left the actual failure unknowable.
  const cause = error instanceof Error && error.cause !== undefined
    ? (error.cause instanceof Error ? error.cause.message : String(error.cause))
    : undefined;
  process.stderr.write(
    `${JSON.stringify({ warning, runId, error: message, ...(cause ? { cause } : {}) })}\n`
  );
}

/**
 * Items AI Board does not manage, shown read-only with provenance: the project's own skills, other
 * tools' skill folders and CLI-configured MCP servers (adoptable explicitly, never silently).
 */
async function discoverExternalItems(projectPath: string, mcpServers: readonly McpServerSpec[]): Promise<ExternalItem[]> {
  const catalog = new SkillCatalog({ projectRoot: projectPath, sharedRoots: defaultSharedSkillRoots() });
  const skills = await catalog.discover().catch(() => []);
  return [
    ...skills.map((skill): ExternalItem => ({
      kind: "skill",
      name: skill.name,
      provenance: skill.source === "project" ? "project" : "external",
      source: { type: "external_skill", path: skill.relativePath, digest: skill.digest },
      description: skill.description,
      detail: skill.source === "built-in" ? "Bundled with AI Board" : skill.source === "project" ? `Project file ${skill.relativePath}` : `User skill folder (${skill.relativePath.replace(/^user:/, "")})`,
    })),
    ...mcpServers.map((server): ExternalItem => ({
      kind: "mcp_server",
      name: server.name,
      provenance: "cli",
      source: { type: "cli_config", name: server.name, configDigest: mcpConfigurationDigest(server) },
      detail: "Configured with --mcp when this Runner started.",
      adoptable: true,
    })),
  ];
}
