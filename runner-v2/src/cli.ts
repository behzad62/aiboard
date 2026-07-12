import { randomBytes } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { ControlServer } from "./control-server.js";
import { EncryptedProviderConfigStore } from "./encrypted-provider-config-store.js";
import { captureGitBaseline } from "./git-baseline.js";
import { checkGit } from "./git-preflight.js";
import { NativeBuildFactory } from "./native-build-factory.js";
import { NativeBuildManager } from "./native-build-manager.js";
import { RunSupervisor } from "./run-supervisor.js";
import { SqliteBuildSpecStore } from "./sqlite-build-spec-store.js";
import { SqliteEventStore } from "./sqlite-event-store.js";

const CERTIFIED_NODE_VERSION = "24.18.0";
const PROTOCOL_VERSION = 2;

interface CliOptions {
  projectPath: string;
  stateDirectory: string;
  port: number;
  token: string;
}

interface RunnerResources {
  server: ControlServer;
  supervisor: RunSupervisor;
  builds: NativeBuildManager;
  buildFactory: NativeBuildFactory;
}

void main();

async function main(): Promise<void> {
  let resources: RunnerResources | undefined;
  try {
    assertCertifiedNodeVersion();
    const options = parseArguments(process.argv.slice(2));
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
    const buildFactory = new NativeBuildFactory({
      projectRoot: options.projectPath,
      stateDirectory: options.stateDirectory,
      providerConfigs,
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
      onPumpResult: (runId, result) => {
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
      },
    });
    const server = new ControlServer({
      supervisor,
      builds,
      buildProvisioner: builds,
      providerConfigs,
      runnerInfo: {
        projectPath: options.projectPath,
        nodeVersion: process.versions.node,
      },
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
    resources = { server, supervisor, builds, buildFactory };
    await builds.recover();
    const address = await server.start(options.port);

    process.stdout.write(
      `${JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        url: address.url,
        token: options.token,
        tokenHint: options.token.slice(-6),
        pid: process.pid,
        projectPath: options.projectPath,
        stateDirectory: options.stateDirectory,
        gitVersion: git.version,
      })}\n`
    );

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

function assertCertifiedNodeVersion(): void {
  if (process.versions.node !== CERTIFIED_NODE_VERSION) {
    throw new Error(
      `node_version_mismatch: Runner V2 requires Node.js ${CERTIFIED_NODE_VERSION}; received ${process.versions.node}.`
    );
  }
}

function parseArguments(args: string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`invalid_arguments: Expected a value after ${flag ?? "argument"}.`);
    }
    if (!["--project", "--state-dir", "--port", "--token"].includes(flag)) {
      throw new Error(`invalid_arguments: Unknown option ${flag}.`);
    }
    if (values.has(flag)) {
      throw new Error(`invalid_arguments: Duplicate option ${flag}.`);
    }
    values.set(flag, value);
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
  return { projectPath, stateDirectory, port, token };
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
  await resources.builds.close();
  resources.buildFactory.close();
  resources.supervisor.close();
}

function writeStartupError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
}
