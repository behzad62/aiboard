import { configureMcpServers } from "./mcp-configuration.js";
import { randomBytes } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { ControlServer } from "./control-server.js";
import { ArtifactStore } from "./artifact-store.js";
import type { BuildStepResult } from "./build-runtime.js";
import { EncryptedProviderConfigStore } from "./encrypted-provider-config-store.js";
import { createExecutionHost } from "./execution-host.js";
import { createRunnerInternalExecutionContext } from "./runner-internal-execution-context.js";
import { captureRunGitBaseline } from "./git-bootstrap.js";
import {
  classifyNativeBuildRecoveryError,
  NativeBuildFactory,
  preflightRecoveredRunnerCapabilities,
} from "./native-build-factory.js";
import {
  NativeBuildManager,
  type HistoricalTerminalState,
} from "./native-build-manager.js";
import {
  createLiveMcpStatusRegistry,
  type McpServerSpec,
} from "./mcp-tools.js";
import { assertSupportedNodeVersion } from "./node-version.js";
import { SqlitePermissionStore } from "./permission-store.js";
import {
  emptyRunnerCapabilitiesConfig,
  loadRunnerCapabilitiesConfig,
  type RunnerCapabilitiesConfig,
} from "./runner-capabilities-config.js";
import { RunSupervisor } from "./run-supervisor.js";
import { RUNNER_BUILTIN_TOOL_NAMES } from "./runner-extension.js";
import type { RunState } from "./contracts.js";
import {
  closeRunnerResources,
  startupFailureWithCleanup,
  type RunnerResources,
} from "./runner-resource-cleanup.js";
import { SqliteBuildSpecStore } from "./sqlite-build-spec-store.js";
import { SqliteEventStore } from "./sqlite-event-store.js";
import {
  type SchedulerProjection,
} from "./scheduler-store.js";

const PROTOCOL_VERSION = 2;

interface CliOptions {
  projectPath: string;
  stateDirectory: string;
  port: number;
  token: string;
  mcpServers: McpServerSpec[];
  allowOrigins: string[];
  capabilitiesConfigPath?: string;
}

void main();

async function main(): Promise<void> {
  const resources: RunnerResources = {};
  try {
    assertSupportedNodeVersion(process.versions.node);
    const args = parseRunnerArguments(process.argv.slice(2));
    if (isHelpRequested(args)) {
      printHelp();
      return;
    }
    const options = parseArguments(args);
    await assertDirectory(options.projectPath, "project");
    if (isInside(options.projectPath, options.stateDirectory)) {
      throw new Error(
        "invalid_state_directory: Runner state must be outside the project directory."
      );
    }
    if (
      options.capabilitiesConfigPath &&
      isInside(options.projectPath, options.capabilitiesConfigPath)
    ) {
      throw new Error(
        "invalid_capabilities_config: Runner capabilities configuration must be outside the project directory."
      );
    }
    const capabilitiesConfig = options.capabilitiesConfigPath
      ? await loadRunnerCapabilitiesConfig(options.capabilitiesConfigPath)
      : emptyRunnerCapabilitiesConfig();
    await mkdir(options.stateDirectory, { recursive: true });
    await assertDirectory(options.stateDirectory, "state");

    const artifactDirectory = join(options.stateDirectory, "artifacts");
    await mkdir(artifactDirectory, { recursive: true });
    const artifacts = new ArtifactStore(artifactDirectory);
    const executionHost = createExecutionHost({
      projectRoot: options.projectPath,
      stateDirectory: options.stateDirectory,
      artifacts,
    });
    resources.executionHost = executionHost;
    const internalExecutionContext = createRunnerInternalExecutionContext({
      projectDirectory: options.projectPath,
      stateDirectory: options.stateDirectory,
      processKernel: executionHost.internalProcesses,
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
    await validateActiveRecoveryCapabilityContracts(
      supervisor,
      capabilitiesConfig,
      options.stateDirectory,
      options.projectPath,
    );
    const providerConfigs = new EncryptedProviderConfigStore(
      join(options.stateDirectory, "provider-configs.enc"),
      options.token
    );
    resources.providerConfigs = providerConfigs;
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
      closeProviderConfigs: false,
      baselineFor: (runId) => {
        const revision = supervisor.getRun(runId).baselineRevision;
        if (!revision) throw new Error(`Run ${runId} has no Git baseline.`);
        return revision;
      },
    });
    resources.buildFactory = buildFactory;
    const blockingRecoveryFailures: unknown[] = [];
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
      prepareSpec: (spec) => buildFactory.prepareSpec(spec),
      shouldRecoverSpec: (spec) =>
        !isTerminalRunState(supervisor.getRun(spec.runId).state),
      validateRecoveredSpec: async (spec) => {
        const run = supervisor.getRun(spec.runId);
        if (isTerminalRunState(run.state)) return;
        await buildFactory.validateRecoveryCapabilityContract(spec);
      },
      onRecoverySpecError: (runId, error) => {
        recordRuntimeRecoveryFailure(supervisor, runId, error);
        const classified = classifyNativeBuildRecoveryError(error);
        if (
          classified?.kind === "capability" &&
          classified.code === "capability_preflight_failed"
        ) {
          blockingRecoveryFailures.push(error);
        }
      },
      shouldAutoRun: (runId) => supervisor.getRun(runId).state === "running",
      onPumpResult: (runId, result) =>
        syncAutonomousBuildLifecycle(
          supervisor,
          runId,
          result,
          builds.projection(runId),
        ),
      onPumpError: (runId, error) => writeRunnerWarning(runId, error),
      runArtifactCompaction: (operation) =>
        buildFactory.runArtifactCompaction(operation),
      prepareArtifactCleanup: () => buildFactory.prepareArtifactCleanup(),
    });
    resources.builds = builds;
    const server = new ControlServer({
      supervisor,
      builds,
      buildProvisioner: builds,
      providerConfigs,
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
    await builds.recover();
    if (blockingRecoveryFailures.length === 1) throw blockingRecoveryFailures[0];
    if (blockingRecoveryFailures.length > 1) {
      throw new AggregateError(
        blockingRecoveryFailures,
        "Runner startup rejected one or more active Build capability startups.",
      );
    }
    const address = await server.start(options.port);

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
    process.stdout.write(`${JSON.stringify(readiness)}\n`);
    writeReadableStartupSummary(readiness);

    let shuttingDown = false;
    const shutdown = (signal: NodeJS.Signals) => {
      if (shuttingDown) return;
      shuttingDown = true;
      void closeRunnerResources(resources).then(
        () => {
          process.exitCode = signal === "SIGINT" ? 130 : 0;
        },
        (error: unknown) => {
          writeStartupError(error);
          process.exitCode = 1;
        }
      );
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    let cleanupError: unknown;
    try {
      await closeRunnerResources(resources);
    } catch (closeError) {
      cleanupError = closeError;
    }
    writeStartupError(
      cleanupError
        ? startupFailureWithCleanup(error, cleanupError)
        : error,
    );
    process.exitCode = 1;
  }
}

function syncAutonomousBuildLifecycle(
  supervisor: RunSupervisor,
  runId: string,
  result: BuildStepResult,
  build: SchedulerProjection,
): void {
  const run = supervisor.getRun(runId);
  if (
    result.status === "completed" &&
    run.state === "running"
  ) {
    supervisor.completeBuild(
      runId,
      `autonomous-build-completed:${run.lastSequence}`,
      build,
    );
  } else if (result.status === "paused" && run.state === "running") {
    supervisor.pause(
      runId,
      `autonomous-build-paused:${run.lastSequence}`,
      result.action ?? "native-build"
    );
  }
}

function isTerminalRunState(state: RunState): state is HistoricalTerminalState {
  return state === "stopped" || state === "completed" || state === "failed";
}

async function validateActiveRecoveryCapabilityContracts(
  supervisor: RunSupervisor,
  capabilitiesConfig: RunnerCapabilitiesConfig,
  stateDirectory: string,
  projectDirectory: string,
): Promise<void> {
  const specs = new SqliteBuildSpecStore(join(stateDirectory, "build-specs.sqlite"));
  const failures: unknown[] = [];
  try {
    for (const spec of specs.list()) {
      const run = supervisor.getRun(spec.runId);
      if (isTerminalRunState(run.state)) continue;
      try {
        await preflightRecoveredRunnerCapabilities({
          spec,
          config: capabilitiesConfig,
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

function recordRuntimeRecoveryFailure(
  supervisor: RunSupervisor,
  runId: string,
  error: unknown,
): void {
  try {
    const run = supervisor.getRun(runId);
    if (isTerminalRunState(run.state)) return;
    supervisor.fail(
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
  const mcpServers: McpServerSpec[] = [];
  const mcpEnvelopes: string[] = [];
  const allowOrigins: string[] = [];
  const allowOriginSet = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!flag?.startsWith("--")) {
      throw new Error(`invalid_arguments: Unknown token ${flag ?? "argument"}.`);
    }
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
    mcpServers: [...configureMcpServers(mcpServers, mcpEnvelopes)],
    allowOrigins,
    ...(capabilitiesConfigPath ? { capabilitiesConfigPath } : {}),
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
    "  --allow-origin <url>    Allowed browser CORS origin (repeatable, comma-separated list supported).",
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

function writeRunnerWarning(runId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `${JSON.stringify({ warning: "runner_cleanup", runId, error: message })}\n`
  );
}
