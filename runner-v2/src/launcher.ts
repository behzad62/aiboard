// RUNNER_RAW_PROCESS_BOUNDARY: The launcher starts the fixed Runner V2 entrypoint and the OS URL opener.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  acquireDiscoveryLock, assertExternalState, assertInstanceIdentity, assertProjectBinding, assertWindowsStatePath,
  canonicalFuturePath, clearStaleInstance, createControlKey, prepareStateDirectory,
  projectDataDirectory, projectIdentity, readControlKey, readInstance, tryAcquireLock, writeInstance,
  type LauncherIdentity, type LauncherInstance,
} from "./launcher-instance.js";
import { requestLauncherControl, type LauncherHandshake } from "./launcher-ipc.js";
import { createLocalPairTicket } from "./local-pairing.js";

type Command = "start" | "status" | "stop" | "version" | "help";
export interface LauncherArguments {
  command: Command;
  project?: string;
  stateDirectory?: string;
  runnerFlags: string[];
  noOpen?: boolean;
}

const VALUE_FLAGS = new Set(["--project", "--state-dir", "--port", "--capabilities-config", "--extensions-home", "--mcp", "--mcp-envelope", "--allow-origin", "--set-aside-run"]);
const REPEATABLE_FLAGS = new Set(["--mcp", "--mcp-envelope", "--allow-origin", "--set-aside-run"]);
const runnerEntry = fileURLToPath(new URL("../bin/aiboard-runner-v2.mjs", import.meta.url));
const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));

export function parseLauncherArguments(raw: string[]): LauncherArguments {
  const args = [...raw];
  while (args[0] === "--") args.shift();
  let command: Command = "start";
  if (args[0] && !args[0].startsWith("-")) {
    const name = args.shift();
    if (name !== "status" && name !== "stop" && name !== "version") throw new Error("invalid_arguments: Unknown aiboard command. See --help.");
    command = name;
  }
  const seen = new Set<string>();
  const result: LauncherArguments = { command, runnerFlags: [] };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === "--help" || flag === "-h") { result.command = "help"; continue; }
    if (flag === "--no-open") { result.noOpen = true; continue; }
    if (flag === "--token") throw new Error("invalid_arguments: aiboard uses fresh state and does not accept --token; legacy users should use aiboard-runner-v2.");
    if (!VALUE_FLAGS.has(flag)) throw new Error("invalid_arguments: Unknown launcher option. See --help.");
    const value = args[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`invalid_arguments: Expected a value after ${flag}.`);
    if (seen.has(flag) && !REPEATABLE_FLAGS.has(flag)) throw new Error(`invalid_arguments: Duplicate option ${flag}.`);
    seen.add(flag);
    if (flag === "--project") result.project = value;
    else if (flag === "--state-dir") result.stateDirectory = value;
    else result.runnerFlags.push(flag, value);
  }
  if (result.project && !isAbsolute(result.project)) throw new Error("invalid_arguments: --project must be an absolute path.");
  if (result.stateDirectory && !isAbsolute(result.stateDirectory)) throw new Error("invalid_arguments: --state-dir must be an absolute path.");
  if (result.command !== "start" && result.runnerFlags.length > 0) throw new Error("invalid_arguments: Runner options apply only when starting a Runner.");
  return result;
}

export function runnerSpawnArguments(identity: LauncherIdentity, stateDirectory: string, flags: string[]): string[] {
  return [runnerEntry, "--project", identity.projectPath, "--state-dir", stateDirectory, "--launcher-ipc", ...flags];
}

interface LauncherRuntime {
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  write?: (message: string) => void;
  spawnRunner?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  openUrl?: (url: string) => void;
}

export async function runLauncher(raw: string[], runtime: LauncherRuntime = {}): Promise<void> {
  const args = parseLauncherArguments(raw);
  const write = runtime.write ?? ((message: string) => process.stdout.write(message));
  const metadata: unknown = JSON.parse(await readFile(packagePath, "utf8"));
  const version = typeof metadata === "object" && metadata !== null && "version" in metadata && typeof metadata.version === "string" ? metadata.version : "unknown";
  if (args.command === "version") { write(`AIBoard Runner V2 ${version}\n`); return; }
  if (args.command === "help") { write(help()); return; }

  const identity = await projectIdentity(args.project ?? runtime.cwd ?? process.cwd());
  const environment = runtime.environment ?? process.env;
  const home = runtime.home ?? homedir();
  const requestedState = args.stateDirectory ?? projectDataDirectory(identity.projectKey, {
    platform: runtime.platform ?? process.platform, environment, home,
  });
  const windowsDefault = process.platform === "win32" && !args.stateDirectory
    ? { home, localAppData: environment.LOCALAPPDATA ?? "" }
    : undefined;
  await assertWindowsStatePath(requestedState, windowsDefault);
  const prospective = await canonicalFuturePath(requestedState);
  assertExternalState(identity.projectPath, prospective);
  if (args.command !== "start") {
    try { await stat(prospective); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (args.command === "stop") throw new Error("instance_not_running: No Runner is running for this project.");
      write("No Runner is running for this project.\n"); return;
    }
  }
  const stateDirectory = await prepareStateDirectory(identity.projectPath, requestedState, identity, windowsDefault);
  let releaseDiscovery = await acquireDiscoveryLock(stateDirectory);
  let child: ChildProcess | undefined;
  let started = false;
  try {
    await assertProjectBinding(stateDirectory, identity);
    const recorded = await readInstance(stateDirectory);
    if (recorded) assertInstanceIdentity(recorded, identity);
    const freeLifetime = tryAcquireLock(stateDirectory, "lifetime");
    if (!freeLifetime) {
      if (!recorded) throw new Error("instance_unverified: A Runner may still be starting or closing; retry after it settles.");
      const key = await readControlKey(stateDirectory);
      let releasedLifetime: (() => void) | undefined;
      try {
        const status = await requestLauncherControl(recorded, key, "status").catch(() => {
          throw new Error("instance_unverified: The recorded Runner cannot be verified; no process was stopped.");
        });
        if (args.command === "status") { write(describe(recorded, status.healthy ? "running" : "unhealthy")); return; }
        if (args.command === "start" && status.healthy) {
          const ticket = createLocalPairTicket(recorded.instanceId);
          await requestLauncherControl(recorded, key, "pair", ticket.digest);
          write(describe(recorded, "already running"));
          showPairing(ticket.code, recorded.port, args.noOpen === true, write, runtime);
          return;
        }
        await requestLauncherControl(recorded, key, "stop");
        releasedLifetime = await waitForLifetimeRelease(stateDirectory);
      } finally { key.fill(0); }
      try { await clearStaleInstance(stateDirectory, identity); } finally { releasedLifetime?.(); }
      if (args.command === "stop") { write("Runner stopped.\n"); return; }
    } else {
      try { await clearStaleInstance(stateDirectory, identity); } finally { freeLifetime(); }
      if (args.command === "status") { write("No Runner is running for this project.\n"); return; }
      if (args.command === "stop") throw new Error(recorded ? "instance_stale: The recorded Runner is no longer running; no process was stopped." : "instance_not_running: No Runner is running for this project.");
    }

    const key = await createControlKey(stateDirectory);
    const token = randomBytes(32).toString("hex");
    const instanceId = randomBytes(16).toString("hex");
    const ticket = createLocalPairTicket(instanceId);
    const handshake: LauncherHandshake = {
      type: "aiboard-launcher-init", token, controlKey: key.toString("hex"), instanceId, pairDigest: ticket.digest, identity, stateDirectory, version,
    };
    const diagnostics: string[] = [];
    let diagnosticBytes = 0;
    try {
      const spawnRunner = runtime.spawnRunner ?? spawn;
      child = spawnRunner(process.execPath, runnerSpawnArguments(identity, stateDirectory, args.runnerFlags), {
        stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
      });
      const capturedChild = child;
      child.stderr?.on("data", (chunk: Buffer) => {
        if (diagnosticBytes >= 262_144) return;
        const text = chunk.toString("utf8").slice(0, 262_144 - diagnosticBytes);
        diagnosticBytes += text.length;
        diagnostics.push(text);
      });
      child.stdout?.resume();
      const closed = childClose(child);
      const ready = childReady(child, handshake);
      const instance = await Promise.race([
        ready,
        closed.then(() => { throw new Error("runner_start_failed: Runner exited before it became ready."); }),
      ]);
      if (instance.instanceId !== instanceId || instance.pid !== child.pid || instance.version !== version) {
        throw new Error("instance_unverified: Runner startup identity does not match its child handle.");
      }
      assertInstanceIdentity(instance, identity);
      const unexpectedlyFree = tryAcquireLock(stateDirectory, "lifetime");
      if (unexpectedlyFree) { unexpectedlyFree(); throw new Error("instance_unverified: Runner did not retain its lifetime lock."); }
      if (!(await requestLauncherControl(instance, key, "status")).healthy) throw new Error("runner_start_failed: Runner did not pass its health check.");
      await writeInstance(stateDirectory, instance);
      started = true;
      releaseDiscovery();
      releaseDiscovery = () => undefined;
      key.fill(0);
      write(describe(instance, "running"));
      showPairing(ticket.code, instance.port, args.noOpen === true, write, runtime);
      let interrupted = false;
      const requestStop = () => { if (capturedChild.connected) capturedChild.send({ type: "aiboard-launcher-stop" }); };
      const onInterrupt = () => { interrupted = true; requestStop(); };
      process.once("SIGINT", onInterrupt);
      process.once("SIGTERM", requestStop);
      try {
        const result = await closed;
        if (result.code) process.exitCode = result.code;
        else if (interrupted) process.exitCode = 130;
        if (result.signal) process.exitCode = 1;
        if ((result.code && result.code !== 130) || result.signal) {
          const detail = redact(diagnostics.join(""), [token, ticket.code, ticket.digest]);
          if (detail) process.stderr.write(`${detail}\n`);
        }
      } finally {
        process.off("SIGINT", onInterrupt); process.off("SIGTERM", requestStop);
      }
      const release = await acquireDiscoveryLock(stateDirectory);
      try {
        const free = tryAcquireLock(stateDirectory, "lifetime");
        if (free) {
          try {
            const current = await readInstance(stateDirectory);
            if (current?.instanceId === instance.instanceId) await clearStaleInstance(stateDirectory, identity);
          } finally { free(); }
        }
      } finally { release(); }
    } catch (error) {
      if (child?.connected) child.disconnect();
      const detail = redact(diagnostics.join(""), [token, ticket.code, ticket.digest]);
      throw new Error(`${error instanceof Error ? error.message : String(error)}${detail ? `\n${detail}` : ""}`);
    } finally { key.fill(0); }
  } finally {
    releaseDiscovery();
    if (child?.connected && !started) child.disconnect();
  }
}

function childReady(child: ChildProcess, handshake: LauncherHandshake): Promise<LauncherInstance> {
  return new Promise((resolve, reject) => {
    let initialized = false;
    const onMessage = (message: unknown) => {
      if (typeof message !== "object" || message === null || !("type" in message)) return;
      if (message.type === "aiboard-launcher-awaiting-init" && !initialized) {
        initialized = true;
        child.send(handshake, (error) => { if (error) reject(new Error("launcher_ipc_unavailable: Cannot send the Runner handshake.")); });
        return;
      }
      if (message.type !== "aiboard-launcher-ready" || !initialized || !("instance" in message)) return;
      child.off("message", onMessage); child.off("error", reject);
      resolve(message.instance as LauncherInstance);
    };
    child.on("message", onMessage); child.once("error", reject);
  });
}

function childClose(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

async function waitForLifetimeRelease(stateDirectory: string): Promise<() => void> {
  const deadline = Date.now() + 60_000;
  do {
    const release = tryAcquireLock(stateDirectory, "lifetime");
    if (release) return release;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  } while (Date.now() < deadline);
  throw new Error("runner_shutdown_pending: Runner cleanup is still in progress; retry status later.");
}

function showPairing(code: string, port: number, noOpen: boolean, write: (message: string) => void, runtime: LauncherRuntime): void {
  const url = `https://aiboard.me/connect#pair=${code}&runners=${port}`;
  write(`Pairing code: ${code}\nConnect: ${url}\n`);
  if (noOpen) return;
  try { (runtime.openUrl ?? ((target) => openPairUrl(target, runtime.platform ?? process.platform)))(url); }
  catch { /* The printed code and URL are the manual fallback. */ }
}

function openPairUrl(url: string, platform: NodeJS.Platform): void {
  const base: SpawnOptions = { stdio: "ignore", windowsHide: true, detached: true };
  let command = "xdg-open";
  let args: string[] = [url];
  let options = base;
  if (platform === "win32") {
    command = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
    args = ["/d", "/s", "/c", `start "" "${url}"`];
    options = { ...base, windowsVerbatimArguments: true };
  } else if (platform === "darwin") {
    command = "open";
  }
  const child = spawn(command, args, options);
  child.once("error", () => undefined);
  child.unref();
}

function describe(instance: LauncherInstance, state: string): string {
  return `Runner ${state}\nProject: ${instance.projectPath}\nURL: http://127.0.0.1:${instance.port}\nPID: ${instance.pid}\n`;
}
function redact(value: string, secrets: (string | undefined)[]): string {
  return secrets.reduce<string>((result, secret) => secret ? result.replaceAll(secret, "[redacted]") : result, value).trim();
}
function help(): string {
  return [
    "AIBoard Runner V2", "", "Usage: aiboard [status|stop|version] [options]", "",
    "Runs the current directory in the foreground, or reuses its healthy Runner.",
    "  --no-open                 Do not open a browser (print the pairing code and URL).",
    "  --project <absolute-path> Override the current project directory.",
    "  --state-dir <path>        Use an absolute state directory outside the project.",
    "  --port <number>           Runner port (0 selects an available port).",
    "  --capabilities-config, --extensions-home, --mcp, --mcp-envelope,",
    "  --allow-origin, --set-aside-run  Pass existing Runner options through.",
    "  --help, -h                Show this help.", "",
  ].join("\n");
}
