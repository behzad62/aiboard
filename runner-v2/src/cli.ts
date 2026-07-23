import { randomBytes } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { ControlServer } from "./control-server.js";
import type { BuildStepResult } from "./build-runtime.js";
import { EncryptedProviderConfigStore } from "./encrypted-provider-config-store.js";
import { captureGitBaseline } from "./git-baseline.js";
import { checkGit } from "./git-preflight.js";
import { NativeBuildFactory } from "./native-build-factory.js";
import { NativeBuildManager } from "./native-build-manager.js";
import { McpManager, type McpServerSpec } from "./mcp-tools.js";
import { assertSupportedNodeVersion } from "./node-version.js";
import { SqlitePermissionStore } from "./permission-store.js";
import { RunSupervisor } from "./run-supervisor.js";
import { SqliteBuildSpecStore } from "./sqlite-build-spec-store.js";
import { SqliteEventStore } from "./sqlite-event-store.js";

const PROTOCOL_VERSION = 2;

interface CliOptions {
  projectPath: string;
  stateDirectory: string;
  port: number;
  token: string;
  mcpServers: McpServerSpec[];
  allowOrigins: string[];
}

interface RunnerResources {
  server: ControlServer;
  supervisor: RunSupervisor;
  builds: NativeBuildManager;
  buildFactory: NativeBuildFactory;
  mcpManager: McpManager;
  permissions: SqlitePermissionStore;
}

void main();

async function main(): Promise<void> {
  let resources: RunnerResources | undefined;
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
    await mkdir(options.stateDirectory, { recursive: true });
    await assertDirectory(options.stateDirectory, "state");

    const git = await checkGit();
    if (!git.available) {
      throw new Error(`${git.code}: ${git.reason}`);
    }

    const artifactDirectory = join(options.stateDirectory, "artifacts");
    await mkdir(artifactDirectory, { recursive: true });
    const supervisor = new RunSupervisor(
      new SqliteEventStore(join(options.stateDirectory, "events.sqlite"))
    );
    const providerConfigs = new EncryptedProviderConfigStore(
      join(options.stateDirectory, "provider-configs.enc"),
      options.token
    );
    const mcpManager = new McpManager({
      cwd: options.projectPath,
      servers: options.mcpServers,
    });
    await mcpManager.start();
    const permissions = new SqlitePermissionStore(
      join(options.stateDirectory, "permissions.sqlite")
    );
    const buildFactory = new NativeBuildFactory({
      projectRoot: options.projectPath,
      stateDirectory: options.stateDirectory,
      providerConfigs,
      mcpManager,
      permissions,
      baselineFor: (runId) => {
        const revision = supervisor.getRun(runId).baselineRevision;
        if (!revision) throw new Error(`Run ${runId} has no Git baseline.`);
        return revision;
      },
    });
    const builds = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(
        join(options.stateDirectory, "build-specs.sqlite")
      ),
      createRuntime: (spec) => buildFactory.create(spec),
      shouldAutoRun: (runId) => supervisor.getRun(runId).state === "running",
      onPumpResult: (runId, result) =>
        syncAutonomousBuildLifecycle(supervisor, runId, result),
      onPumpError: (runId, error) => writeRunnerWarning(runId, error),
      runArtifactCompaction: (operation) =>
        buildFactory.runArtifactCompaction(operation),
      prepareArtifactCleanup: () => buildFactory.prepareArtifactCleanup(),
    });
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
      mcp: mcpManager,
      permissions,
      token: options.token,
      checkGit: async () => git,
      bootstrapRun: async (input) => {
        if (resolve(input.projectPath) !== options.projectPath) {
          throw new Error(
            `project_mismatch: Runner is bound to ${options.projectPath}.`
          );
        }
        const baseline = await captureGitBaseline({
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
    resources = { server, supervisor, builds, buildFactory, mcpManager, permissions };
    await builds.recover();
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
      mcp: mcpManager.status(),
      allowOrigins: options.allowOrigins,
    };
    process.stdout.write(`${JSON.stringify(readiness)}\n`);
    writeReadableStartupSummary(readiness);

    let shuttingDown = false;
    const shutdown = (signal: NodeJS.Signals) => {
      if (shuttingDown) return;
      shuttingDown = true;
      void closeResources(resources).then(
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
    await closeResources(resources);
    writeStartupError(error);
    process.exitCode = 1;
  }
}

function syncAutonomousBuildLifecycle(
  supervisor: RunSupervisor,
  runId: string,
  result: BuildStepResult
): void {
  const run = supervisor.getRun(runId);
  if (result.status === "completed" && run.state === "running") {
    supervisor.complete(
      runId,
      `autonomous-build-completed:${run.lastSequence}`
    );
  } else if (result.status === "paused" && run.state === "running") {
    supervisor.pause(
      runId,
      `autonomous-build-paused:${run.lastSequence}`,
      result.action ?? "native-build"
    );
  }
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
  const allowOrigins: string[] = [];
  const allowOriginSet = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!flag?.startsWith("--")) {
      throw new Error(`invalid_arguments: Unknown token ${flag ?? "argument"}.`);
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
  if (!["--project", "--state-dir", "--port", "--token"].includes(flag)) {
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
    mcpServers,
    allowOrigins,
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
    "  --mcp <name=command>    Register MCP server; can be repeated.",
    "  --allow-origin <url>    Allowed browser CORS origin (repeatable, comma-separated list supported).",
    "                         Defaults to loopback origins + aiboard.me.",
    "  --help, -h              Show this help text.",
    "",
    "Examples:",
    "  npm run runner:v2 -- --project C:\\path\\to\\project --state-dir C:\\path\\to\\runner-state --port 8787",
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

async function closeResources(resources: RunnerResources | undefined): Promise<void> {
  if (!resources) return;
  await resources.server.close();
  resources.permissions.close();
  await resources.builds.close();
  await resources.buildFactory.close();
  await resources.mcpManager.close();
  resources.supervisor.close();
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
