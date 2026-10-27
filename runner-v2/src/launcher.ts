// RUNNER_RAW_PROCESS_BOUNDARY: The launcher starts the fixed Runner V2 entrypoint and the OS URL opener.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  acquireDiscoveryLock, assertExternalState, assertInstanceIdentity, assertProjectBinding, assertWindowsStatePath,
  canonicalFuturePath, clearStaleInstance, createControlKey, prepareStateDirectory, prepareUserDirectory,
  projectDataDirectory, projectIdentity, readControlKey, readInstance, remoteDeviceDirectory, tryAcquireLock, writeInstance,
  type LauncherIdentity, type LauncherInstance,
} from "./launcher-instance.js";
import { requestLauncherControl, type LauncherHandshake } from "./launcher-ipc.js";
import { createLocalPairTicket, type LocalPairPeer } from "./local-pairing.js";
import { STUB_REMOTE_PAIRING_URL } from "./remote-auth.js";
import { RemoteDeviceStore } from "./remote-device-store.js";
import { REMOTE_FIRST_RUN_NOTICE } from "./remote-service.js";

export type RunnerKind = "runner" | "accounts" | "legacy" | "bench";
const RUNNER_KINDS: readonly RunnerKind[] = ["runner", "accounts", "legacy", "bench"];
export interface PeerInstance extends LauncherInstance { kind: RunnerKind }
const peerEntries: Record<Exclude<RunnerKind, "runner">, string> = {
  accounts: fileURLToPath(new URL("../../lib/account-provider-runner.mjs", import.meta.url)),
  legacy: fileURLToPath(new URL("../../scripts/runner.mjs", import.meta.url)),
  bench: fileURLToPath(new URL("../../scripts/bench-runner.mjs", import.meta.url)),
};

type Command = "start" | "status" | "stop" | "version" | "help" | "remote";
export interface LauncherArguments {
  command: Command;
  runners: RunnerKind[];
  project?: string;
  stateDirectory?: string;
  runnerFlags: string[];
  noOpen?: boolean;
  logout?: boolean;
  acknowledgeRemote?: boolean;
}

const VALUE_FLAGS = new Set(["--project", "--state-dir", "--port", "--capabilities-config", "--extensions-home", "--mcp", "--mcp-envelope", "--allow-origin", "--set-aside-run"]);
const REPEATABLE_FLAGS = new Set(["--mcp", "--mcp-envelope", "--allow-origin", "--set-aside-run"]);
const runnerEntry = fileURLToPath(new URL("../bin/aiboard-runner-v2.mjs", import.meta.url));
const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));

export function parseLauncherArguments(raw: string[]): LauncherArguments {
  const args = [...raw];
  while (args[0] === "--") args.shift();
  let command: Command = "start";
  const selected: RunnerKind[] = [];
  while (args[0] && !args[0].startsWith("-")) {
    const name = args[0];
    if (name === "remote") {
      if (selected.length > 0) throw new Error("invalid_arguments: Unknown aiboard command. See --help.");
      args.shift();
      command = "remote";
      break;
    }
    if (name === "status" || name === "stop" || name === "version") {
      if (selected.length > 0) throw new Error("invalid_arguments: Unknown aiboard command. See --help.");
      args.shift();
      command = name;
      break;
    }
    if (name !== "runner" && name !== "accounts" && name !== "legacy" && name !== "bench" && name !== "all") {
      throw new Error("invalid_arguments: Unknown aiboard command. See --help.");
    }
    args.shift();
    const expanded: RunnerKind[] = name === "all" ? [...RUNNER_KINDS] : [name];
    for (const kind of expanded) {
      if (selected.includes(kind)) throw new Error(`invalid_arguments: Duplicate runner ${kind}.`);
      selected.push(kind);
    }
  }
  const seen = new Set<string>();
  const result: LauncherArguments = { command, runners: selected.length > 0 ? selected : ["runner"], runnerFlags: [] };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === "--help" || flag === "-h") { result.command = "help"; continue; }
    if (flag === "--no-open") { result.noOpen = true; continue; }
    if (flag === "--logout") {
      if (result.command !== "remote") throw new Error("invalid_arguments: --logout applies only to aiboard remote.");
      result.logout = true; continue;
    }
    if (flag === "--acknowledge-remote-access") { result.acknowledgeRemote = true; continue; }
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
  if (result.command !== "start" && result.command !== "remote" && result.runnerFlags.length > 0) throw new Error("invalid_arguments: Runner options apply only when starting a Runner.");
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
  confirmNotice?: () => Promise<boolean>;
  spawnRunner?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  spawnPeer?: (kind: RunnerKind, command: string, args: string[], options: SpawnOptions) => ChildProcess;
  openUrl?: (url: string) => void;
}

export async function runLauncher(raw: string[], runtime: LauncherRuntime = {}): Promise<void> {
  const args = parseLauncherArguments(raw);
  const startLike = args.command === "start" || (args.command === "remote" && args.logout !== true);
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
  // One remote device per user (D9): custody lives beside, not inside, the per-project state.
  const deviceDirectory = args.command === "remote"
    ? await prepareUserDirectory(identity.projectPath,
      remoteDeviceDirectory({ platform: runtime.platform ?? process.platform, environment, home }),
      process.platform === "win32" ? { home, localAppData: environment.LOCALAPPDATA ?? "" } : undefined)
    : undefined;
  if (args.command === "remote" && args.logout) {
    const deviceStore = new RemoteDeviceStore(deviceDirectory!);
    const present = deviceStore.load() !== undefined;
    deviceStore.logout();
    write(present
      ? "Remote device logged out. Device credentials and session state were wiped.\n"
      : "Remote device logged out. No device credentials were present.\n");
    return;
  }
  await assertWindowsStatePath(requestedState, windowsDefault);
  const prospective = await canonicalFuturePath(requestedState);
  assertExternalState(identity.projectPath, prospective);
  if (!startLike) {
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
  const freshChildren: ChildProcess[] = [];
  const freshKinds = new Set<RunnerKind>();
  const ownedKeys: Buffer[] = [];
  try {
    await assertProjectBinding(stateDirectory, identity);
    if (args.command === "remote") {
      const deviceStore = new RemoteDeviceStore(deviceDirectory!);
      const probe = deviceStore.acquireOwnerLock();
      if (probe) probe();
      else {
        const owner = deviceStore.activeOwnerProject();
        if (owner !== identity.projectPath) {
          throw new Error(`remote_already_active: Remote access is already active${owner ? ` for ${owner}` : ""}; stop that Runner first.`);
        }
      }
      if (!deviceStore.noticeAcknowledged()) {
        write(REMOTE_FIRST_RUN_NOTICE + "\n");
        const accepted = args.acknowledgeRemote === true || (runtime.confirmNotice ? await runtime.confirmNotice() : false);
        if (!accepted) throw new Error("remote_notice_required: Review the notice above, then rerun with --acknowledge-remote-access to accept whole-machine remote access.");
        deviceStore.acknowledgeNotice();
      }
      if (!args.runnerFlags.includes("--remote")) args.runnerFlags.push("--remote", "--remote-device-dir", deviceDirectory!);
    }
    const recorded = await readInstance(stateDirectory);
    if (recorded) assertInstanceIdentity(recorded, identity);
    const peerRecords = await readPeerInstances(stateDirectory, identity);

    if (!startLike) {
      if (!recorded && peerRecords.length === 0) {
        const freeLifetime = tryAcquireLock(stateDirectory, "lifetime");
        if (freeLifetime) {
          freeLifetime();
          if (args.command === "status") { write("No Runner is running for this project.\n"); return; }
          throw new Error("instance_not_running: No Runner is running for this project.");
        }
        throw new Error("instance_unverified: A Runner may still be starting or closing; retry after it settles.");
      }
      const probe = tryAcquireLock(stateDirectory, "lifetime");
      const v2Stale = probe !== null;
      if (probe) probe();
      if (args.command === "status") {
        const lines: string[] = [];
        if (recorded && !v2Stale) {
          const key = await readControlKey(stateDirectory);
          ownedKeys.push(key);
          const status = await requestLauncherControl(recorded, key, "status").catch(() => {
            throw new Error("instance_unverified: The recorded Runner cannot be verified; no process was stopped.");
          });
          lines.push(describe(recorded, status.healthy ? "running" : "unhealthy"));
        }
        for (const peer of peerRecords) {
          const key = await readPeerControlKey(stateDirectory, peer.kind);
          ownedKeys.push(key);
          const status = await requestLauncherControl(peer, key, "status").catch(() => {
            throw new Error("instance_unverified: A recorded Runner cannot be verified; no process was stopped.");
          });
          lines.push(describe(peer, status.healthy ? "running" : "unhealthy"));
        }
        const remoteLine = await remoteStatusLine(stateDirectory);
        if (remoteLine) lines.push(remoteLine);
        write(lines.length > 0 ? lines.join("") : "No Runner is running for this project.\n");
        return;
      }
      // stop: verify every recorded runner before stopping any of them.
      if (recorded && v2Stale && peerRecords.length === 0) {
        throw new Error("instance_stale: The recorded Runner is no longer running; no process was stopped.");
      }
      let v2Key: Buffer | undefined;
      const peerKeys = new Map<RunnerKind, Buffer>();
      if (recorded && !v2Stale) {
        v2Key = await readControlKey(stateDirectory);
        ownedKeys.push(v2Key);
        await requestLauncherControl(recorded, v2Key, "status").catch(() => {
          throw new Error("instance_unverified: The recorded Runner cannot be verified; no process was stopped.");
        });
      }
      for (const peer of peerRecords) {
        const key = await readPeerControlKey(stateDirectory, peer.kind);
        ownedKeys.push(key);
        peerKeys.set(peer.kind, key);
        await requestLauncherControl(peer, key, "status").catch(() => {
          throw new Error("instance_unverified: A recorded Runner cannot be verified; no process was stopped.");
        });
      }
      if (recorded && !v2Stale && v2Key) {
        await requestLauncherControl(recorded, v2Key, "stop");
        const releasedLifetime = await waitForLifetimeRelease(stateDirectory);
        try { await clearStaleInstance(stateDirectory, identity); } finally { releasedLifetime(); }
      } else if (recorded && v2Stale) {
        await clearStaleInstance(stateDirectory, identity);
      }
      for (const peer of peerRecords) {
        await requestLauncherControl(peer, peerKeys.get(peer.kind)!, "stop").catch(() => undefined);
        await waitForControlDown(peer);
      }
      if (peerRecords.length > 0) await clearPeerInstances(stateDirectory);
      write("Runner stopped.\n");
      return;
    }

    const selected = args.runners;
    const anchorKind: RunnerKind = selected.includes("runner") ? "runner" : selected[0]!;
    const instances = new Map<RunnerKind, LauncherInstance>();
    const tickets = new Map<RunnerKind, { code: string; digest: string }>();
    const reused = new Set<RunnerKind>();
    const diagnostics: string[] = [];
    let diagnosticBytes = 0;
    const captureDiagnostics = (chunk: Buffer) => {
      if (diagnosticBytes >= 262_144) return;
      const text = chunk.toString("utf8").slice(0, 262_144 - diagnosticBytes);
      diagnosticBytes += text.length;
      diagnostics.push(text);
    };

    // Non-V2 runners first (anchor last), so the anchor learns every peer.
    const peerOrder: RunnerKind[] = [
      ...selected.filter((entry) => entry !== "runner" && entry !== anchorKind),
      ...(anchorKind !== "runner" ? [anchorKind] : []),
    ];
    for (const kind of peerOrder) {
      const existing = peerRecords.find((peer) => peer.kind === kind);
      if (existing) {
        const key = await readPeerControlKey(stateDirectory, kind).catch(() => {
          throw new Error("instance_unverified: A recorded Runner cannot be verified; no process was stopped.");
        });
        ownedKeys.push(key);
        const healthy = await requestLauncherControl(existing, key, "status").then((value) => value.healthy).catch(() => false);
        if (healthy) {
          instances.set(kind, existing);
          tickets.set(kind, createLocalPairTicket(existing.instanceId));
          reused.add(kind);
          continue;
        }
        if (pidAlive(existing.pid)) throw new Error("instance_unverified: A recorded Runner cannot be verified; no process was stopped.");
        await removePeerInstance(stateDirectory, kind, identity);
      }
      const port = await freePort();
      const instanceId = randomBytes(16).toString("hex");
      const ticket = createLocalPairTicket(instanceId);
      tickets.set(kind, ticket);
      const key = await createPeerControlKey(stateDirectory, kind);
      ownedKeys.push(key);
      const spawned = spawnPeerRunner(kind as Exclude<RunnerKind, "runner">, {
        runtime, identity, stateDirectory, port, instanceId, ticket,
        controlKey: key.toString("hex"), version,
        peers: kind === anchorKind ? peerListFor(anchorKind, selected, instances, tickets) : [],
        captureDiagnostics,
      });
      child ??= spawned.child;
      freshChildren.push(spawned.child);
      freshKinds.add(kind);
      const instance = await Promise.race([
        spawned.ready,
        spawned.closed.then(() => { throw new Error("runner_start_failed: A selected Runner exited before it became ready."); }),
      ]);
      if (instance.instanceId !== instanceId || instance.pid !== spawned.child.pid || instance.port !== port) {
        throw new Error("instance_unverified: Runner startup identity does not match its child handle.");
      }
      instances.set(kind, instance);
    }

    let v2Child: ChildProcess | undefined;
    let v2Closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
    let v2Token = "";
    if (selected.includes("runner")) {
      let reuseV2 = false;
      const freeLifetime = tryAcquireLock(stateDirectory, "lifetime");
      if (!freeLifetime) {
        if (!recorded) throw new Error("instance_unverified: A Runner may still be starting or closing; retry after it settles.");
        const key = await readControlKey(stateDirectory);
        ownedKeys.push(key);
        try {
          const status = await requestLauncherControl(recorded, key, "status").catch(() => {
            throw new Error("instance_unverified: The recorded Runner cannot be verified; no process was stopped.");
          });
          if (status.healthy) {
            reuseV2 = true;
            instances.set("runner", recorded);
            tickets.set("runner", createLocalPairTicket(recorded.instanceId));
            reused.add("runner");
          } else {
            await requestLauncherControl(recorded, key, "stop");
            const releasedLifetime = await waitForLifetimeRelease(stateDirectory);
            try { await clearStaleInstance(stateDirectory, identity); } finally { releasedLifetime(); }
          }
        } finally { key.fill(0); }
      } else {
        try { await clearStaleInstance(stateDirectory, identity); } finally { freeLifetime(); }
      }
      if (!reuseV2) {
        const key = await createControlKey(stateDirectory);
        ownedKeys.push(key);
        v2Token = randomBytes(32).toString("hex");
        const instanceId = randomBytes(16).toString("hex");
        const ticket = createLocalPairTicket(instanceId);
        tickets.set("runner", ticket);
        const handshake: LauncherHandshake = {
          type: "aiboard-launcher-init", token: v2Token, controlKey: key.toString("hex"), instanceId,
          pairDigest: ticket.digest, peers: peerListFor("runner", selected, instances, tickets), identity, stateDirectory, version,
        };
        const spawnRunner = runtime.spawnRunner ?? spawn;
        v2Child = spawnRunner(process.execPath, runnerSpawnArguments(identity, stateDirectory, args.runnerFlags), {
          stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
        });
        child = v2Child;
        freshChildren.push(v2Child);
        freshKinds.add("runner");
        v2Child.stderr?.on("data", captureDiagnostics);
        v2Child.stdout?.resume();
        v2Closed = childClose(v2Child);
        const ready = childReady(v2Child, handshake);
        const instance = await Promise.race([
          ready,
          v2Closed.then(() => { throw new Error("runner_start_failed: Runner exited before it became ready."); }),
        ]);
        if (instance.instanceId !== instanceId || instance.pid !== v2Child.pid || instance.version !== version) {
          throw new Error("instance_unverified: Runner startup identity does not match its child handle.");
        }
        assertInstanceIdentity(instance, identity);
        const unexpectedlyFree = tryAcquireLock(stateDirectory, "lifetime");
        if (unexpectedlyFree) { unexpectedlyFree(); throw new Error("instance_unverified: Runner did not retain its lifetime lock."); }
        if (!(await requestLauncherControl(instance, key, "status")).healthy) throw new Error("runner_start_failed: Runner did not pass its health check.");
        await writeInstance(stateDirectory, instance);
        instances.set("runner", instance);
      }
    }

    // Anchor peers are registered first, then the anchor with its peer list.
    const anchorPeers = peerListFor(anchorKind, selected, instances, tickets);
    for (const kind of selected) {
      if (!reused.has(kind)) continue;
      const instance = instances.get(kind)!;
      const key = kind === "runner"
        ? await readControlKey(stateDirectory)
        : await readPeerControlKey(stateDirectory, kind);
      ownedKeys.push(key);
      try {
        await requestLauncherControl(instance, key, "pair", tickets.get(kind)!.digest, kind === anchorKind ? anchorPeers : undefined);
      } finally { key.fill(0); }
    }
    const remainingPeers = [
      ...peerRecords.filter((peer) => !selected.includes(peer.kind)),
      ...selected.filter((kind) => kind !== "runner").map((kind) => ({ ...(instances.get(kind)!), kind })),
    ];
    if (remainingPeers.length > 0) await writePeerInstances(stateDirectory, remainingPeers);
    else if (peerRecords.length > 0) await clearPeerInstances(stateDirectory);

    started = true;
    releaseDiscovery();
    releaseDiscovery = () => undefined;
    for (const kind of selected) {
      write(describe(instances.get(kind)!, freshKinds.has(kind) ? "running" : "already running"));
    }
    const orderedPorts = [instances.get(anchorKind)!.port, ...selected.filter((kind) => kind !== anchorKind).map((kind) => instances.get(kind)!.port)];
    showPairing(tickets.get(anchorKind)!.code, orderedPorts, args.noOpen === true, write, runtime);
    if (args.command === "remote" && !new RemoteDeviceStore(deviceDirectory!).loadSession()) {
      write("Remote pairing: " + STUB_REMOTE_PAIRING_URL + "\n");
      if (args.noOpen !== true) {
        try { (runtime.openUrl ?? ((target: string) => openPairUrl(target, runtime.platform ?? process.platform)))(STUB_REMOTE_PAIRING_URL); } catch { /* printed URL is the fallback */ }
      }
    }
    if (freshChildren.length === 0) return;

    let interrupted = false;
    const requestStop = () => {
      for (const fresh of freshChildren) if (fresh.connected) fresh.send({ type: "aiboard-launcher-stop" });
    };
    const onInterrupt = () => { interrupted = true; requestStop(); };
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", requestStop);
    const closedPromises = freshChildren.map((fresh) => childClose(fresh).catch(() => ({ code: null, signal: null })));
    let firstSettled = false;
    for (const closedPromise of closedPromises) {
      void closedPromise.then(() => { if (!firstSettled) { firstSettled = true; requestStop(); } });
    }
    try {
      const results = await Promise.all(closedPromises);
      const v2Result = v2Child ? results[freshChildren.indexOf(v2Child)] : undefined;
      if (v2Result?.code) process.exitCode = v2Result.code;
      else if (interrupted) process.exitCode = 130;
      if (v2Result?.signal) process.exitCode = 1;
      if ((v2Result?.code && v2Result.code !== 130) || v2Result?.signal) {
        const detail = redact(diagnostics.join(""), [v2Token, ...[...tickets.values()].map((ticket) => ticket.code), ...[...tickets.values()].map((ticket) => ticket.digest)]);
        if (detail) process.stderr.write(`${detail}\n`);
      }
    } finally {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", requestStop);
    }
    const release = await acquireDiscoveryLock(stateDirectory);
    try {
      if (freshKinds.has("runner")) {
        const free = tryAcquireLock(stateDirectory, "lifetime");
        if (free) {
          try {
            const current = await readInstance(stateDirectory);
            const mine = instances.get("runner");
            if (current && mine && current.instanceId === mine.instanceId) await clearStaleInstance(stateDirectory, identity);
          } finally { free(); }
        }
      }
      const currentPeers = await readPeerInstances(stateDirectory, identity).catch(() => [] as PeerInstance[]);
      const kept = currentPeers.filter((peer) => !(freshKinds.has(peer.kind) && instances.get(peer.kind)?.instanceId === peer.instanceId));
      if (kept.length > 0) await writePeerInstances(stateDirectory, kept);
      else if (currentPeers.length > 0) await clearPeerInstances(stateDirectory);
      for (const kind of freshKinds) if (kind !== "runner") await removePeerControlKey(stateDirectory, kind);
    } finally { release(); }
  } catch (error) {
    for (const fresh of freshChildren) if (fresh.connected) fresh.disconnect();
    const detail = redact(diagnosticsSafe(error), []);
    void detail;
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    for (const key of ownedKeys) key.fill(0);
    releaseDiscovery();
    if (child?.connected && !started) child.disconnect();
  }
}

function diagnosticsSafe(_error: unknown): string { return ""; }

function peerListFor(anchorKind: RunnerKind, selected: readonly RunnerKind[], instances: ReadonlyMap<RunnerKind, LauncherInstance>, tickets: ReadonlyMap<RunnerKind, { code: string }>): LocalPairPeer[] {
  return selected.filter((kind) => kind !== anchorKind).map((kind) => {
    const instance = instances.get(kind)!;
    return { instanceId: instance.instanceId, kind, port: instance.port, code: tickets.get(kind)!.code };
  });
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address();
  const port = address && typeof address !== "string" ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error("runner_start_failed: No local port is available.");
  return port;
}

function peerSpawnArguments(kind: Exclude<RunnerKind, "runner">, identity: LauncherIdentity, stateDirectory: string, port: number): string[] {
  if (kind === "accounts") return [peerEntries.accounts, "--port", String(port), "--host", "127.0.0.1"];
  if (kind === "legacy") return [peerEntries.legacy, identity.projectPath, "--port", String(port), "--host", "127.0.0.1"];
  return [peerEntries.bench, "--port", String(port), "--host", "127.0.0.1", "--root", join(stateDirectory, "bench-runs")];
}

function spawnPeerRunner(kind: Exclude<RunnerKind, "runner">, input: {
  runtime: LauncherRuntime; identity: LauncherIdentity; stateDirectory: string; port: number;
  instanceId: string; ticket: { digest: string }; controlKey: string; version: string;
  peers: LocalPairPeer[]; captureDiagnostics: (chunk: Buffer) => void;
}): { child: ChildProcess; ready: Promise<PeerInstance>; closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> } {
  const spawnPeer = input.runtime.spawnPeer ?? ((_kind, command, args, options) => spawn(command, args, options));
  const child = spawnPeer(kind, process.execPath, peerSpawnArguments(kind, input.identity, input.stateDirectory, input.port), {
    stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
  });
  child.stderr?.on("data", input.captureDiagnostics);
  child.stdout?.on("data", input.captureDiagnostics);
  const closed = childClose(child);
  const ready = new Promise<PeerInstance>((resolve, reject) => {
    let initialized = false;
    const onMessage = (message: unknown) => {
      if (typeof message !== "object" || message === null || !("type" in message)) return;
      if (message.type === "aiboard-local-pair-awaiting-init" && !initialized) {
        initialized = true;
        child.send({
          type: "aiboard-local-pair-init", kind, instanceId: input.instanceId, pairDigest: input.ticket.digest,
          peers: input.peers, controlKey: input.controlKey, identity: input.identity, version: input.version, startedAt: Date.now(),
        }, (error) => { if (error) reject(new Error("launcher_ipc_unavailable: Cannot send the Runner handshake.")); });
        return;
      }
      if (message.type !== "aiboard-local-pair-ready" || !initialized || !("instance" in message)) return;
      child.off("message", onMessage);
      resolve(message.instance as PeerInstance);
    };
    child.on("message", onMessage);
    child.once("error", reject);
  });
  return { child, ready, closed };
}

async function readPeerInstances(stateDirectory: string, identity: LauncherIdentity): Promise<PeerInstance[]> {
  let raw: string;
  try { raw = await readFile(join(stateDirectory, "launcher-peers.json"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || !("peers" in value) || !Array.isArray(value.peers)) {
    throw new Error("instance_invalid: The launcher peer record is invalid; no process was stopped.");
  }
  const peers = value.peers as PeerInstance[];
  for (const peer of peers) {
    if (!RUNNER_KINDS.includes(peer.kind) || peer.kind === "runner") throw new Error("instance_invalid: The launcher peer record is invalid; no process was stopped.");
    assertInstanceIdentity(peer, identity);
  }
  return peers;
}

async function writePeerInstances(stateDirectory: string, peers: readonly PeerInstance[]): Promise<void> {
  const target = join(stateDirectory, "launcher-peers.json");
  const temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, JSON.stringify({ schemaVersion: 1, peers }), { flag: "wx", mode: 0o600 });
  try { await rename(temporary, target); }
  catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
}

async function clearPeerInstances(stateDirectory: string): Promise<void> {
  await unlink(join(stateDirectory, "launcher-peers.json")).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
}

async function removePeerInstance(stateDirectory: string, kind: RunnerKind, identity: LauncherIdentity): Promise<void> {
  const peers = await readPeerInstances(stateDirectory, identity);
  const kept = peers.filter((peer) => peer.kind !== kind);
  if (kept.length > 0) await writePeerInstances(stateDirectory, kept);
  else await clearPeerInstances(stateDirectory);
  await removePeerControlKey(stateDirectory, kind);
}

function peerControlKeyPath(stateDirectory: string, kind: RunnerKind): string {
  return join(stateDirectory, `launcher-control-${kind}.key`);
}

async function createPeerControlKey(stateDirectory: string, kind: RunnerKind): Promise<Buffer> {
  const key = randomBytes(32);
  await unlink(peerControlKeyPath(stateDirectory, kind)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  try { await writeFile(peerControlKeyPath(stateDirectory, kind), key, { flag: "wx", mode: 0o600 }); }
  catch (error) { key.fill(0); throw error; }
  return key;
}

async function readPeerControlKey(stateDirectory: string, kind: RunnerKind): Promise<Buffer> {
  const key = await readFile(peerControlKeyPath(stateDirectory, kind));
  if (key.length !== 32) { key.fill(0); throw new Error("instance_invalid: The launcher control key is invalid."); }
  return key;
}

async function removePeerControlKey(stateDirectory: string, kind: RunnerKind): Promise<void> {
  await unlink(peerControlKeyPath(stateDirectory, kind)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
}

async function waitForControlDown(instance: LauncherInstance): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!pidAlive(instance.pid)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
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

function showPairing(code: string, ports: readonly number[], noOpen: boolean, write: (message: string) => void, runtime: LauncherRuntime): void {
  const url = `https://aiboard.me/connect#pair=${code}&runners=${ports.join(",")}`;
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

async function remoteStatusLine(stateDirectory: string): Promise<string | undefined> {
  let raw: string;
  try { raw = await readFile(join(stateDirectory, "remote-status.json"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || !("state" in value)) return "Remote: status unverified\n";
    const status = value as { state: string; deviceId?: string };
    return "Remote: " + status.state + (status.deviceId ? " (device " + status.deviceId + ")" : "") + "\n";
  } catch { return "Remote: status unverified\n"; }
}

function describe(instance: LauncherInstance, state: string): string {
  return `Runner ${state}\nProject: ${instance.projectPath}\nURL: http://127.0.0.1:${instance.port}\nPID: ${instance.pid}\n`;
}
function redact(value: string, secrets: (string | undefined)[]): string {
  return secrets.reduce<string>((result, secret) => secret ? result.replaceAll(secret, "[redacted]") : result, value).trim();
}
function help(): string {
  return [
    "AIBoard Runner", "", "Usage: aiboard [runner|accounts|legacy|bench|all ...] [options]", "       aiboard [status|stop|version] [options]", "",
    "Runs the selected runners for the current directory in the foreground, or reuses healthy ones.",
    "With no selection only Runner V2 runs; `all` runs every runner. Runner V2 is",
    "the pairing anchor whenever it is selected, otherwise the first listed runner is.",
    "  --no-open                 Do not open a browser (print the pairing code and URL).",
    "  --project <absolute-path> Override the current project directory.",
    "  --state-dir <path>        Use an absolute state directory outside the project.",
    "  --port <number>           Runner port (0 selects an available port).",
    "  --capabilities-config, --extensions-home, --mcp, --mcp-envelope,",
    "  --allow-origin, --set-aside-run  Pass existing Runner options through.",
    "  aiboard remote            Start Runner V2 with the remote service; --logout wipes the device.",
    "  --help, -h                Show this help.", "",
  ].join("\n");
}
