import { randomBytes } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { ControlServer } from "./control-server.js";
import { checkGit } from "./git-preflight.js";
import { RunSupervisor } from "./run-supervisor.js";
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
}

void main();

async function main(): Promise<void> {
  let resources: RunnerResources | undefined;
  try {
    assertCertifiedNodeVersion();
    const options = parseArguments(process.argv.slice(2));
    await assertDirectory(options.projectPath, "project");
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
    const server = new ControlServer({
      supervisor,
      token: options.token,
      checkGit: async () => git,
    });
    resources = { server, supervisor };
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
  return value;
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
  resources.supervisor.close();
}

function writeStartupError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
}
