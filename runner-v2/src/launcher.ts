// RUNNER_RAW_PROCESS_BOUNDARY: The launcher starts the fixed Runner V2 entrypoint and the OS URL opener.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
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
import { openLauncherMcpSession, requestLauncherApproval, requestLauncherControl, type LauncherHandshake } from "./launcher-ipc.js";
import { LOCAL_MCP_DEPTH_LIMIT, parseMcpDepth } from "./child-environment.js";
import { serveLocalStdioMcp } from "./local-stdio-mcp.js";
import { createLocalPairTicket, type LocalPairPeer } from "./local-pairing.js";
import { STUB_REMOTE_PAIRING_URL } from "./remote-auth.js";
import { RemoteDeviceStore } from "./remote-device-store.js";
import { DEFAULT_REMOTE_DEVICE_POLICY, RemotePrincipalStore } from "./remote-principal.js";
import { RemoteAuditStore } from "./remote-audit-store.js";
import { REMOTE_FIRST_RUN_NOTICE } from "./remote-service.js";
import { createRemoteStateNotices, REMOTE_REPAIR_NOTICE, REMOTE_STATE_MESSAGE, stampRemoteNotice } from "./remote-state-notice.js";
import { resolveRunnerOwnedRoots } from "./runner-owned-roots.js";
import { promptCommandApproval } from "./remote-approval.js";
import { pairingRelayConfiguration } from "./remote-pairing.js";
import { runDoctorCommand, runUninstallCommand, runUpdateCommand } from "./self-update.js";

export type RunnerKind = "runner" | "accounts" | "legacy" | "bench";
const RUNNER_KINDS: readonly RunnerKind[] = ["runner", "accounts", "legacy", "bench"];
export interface PeerInstance extends LauncherInstance { kind: RunnerKind }
const peerEntries: Record<Exclude<RunnerKind, "runner">, string> = {
  accounts: fileURLToPath(new URL("../../lib/account-provider-runner.mjs", import.meta.url)),
  legacy: fileURLToPath(new URL("../../scripts/runner.mjs", import.meta.url)),
  bench: fileURLToPath(new URL("../../scripts/bench-runner.mjs", import.meta.url)),
};

type Command = "start" | "status" | "stop" | "version" | "help" | "remote" | "mcp";
export interface LauncherArguments {
  command: Command;
  runners: RunnerKind[];
  project?: string;
  stateDirectory?: string;
  runnerFlags: string[];
  noOpen?: boolean;
  logout?: boolean;
  acknowledgeRemote?: boolean;
  stdio?: boolean;
  policy?: boolean;
  audit?: boolean;
  auditLimit?: number;
  policyFlags?: boolean;
}

const VALUE_FLAGS = new Set(["--project", "--state-dir", "--port", "--capabilities-config", "--extensions-home", "--mcp", "--mcp-envelope", "--allow-origin", "--set-aside-run", "--relay-url", "--relay-root-key"]);
const REPEATABLE_FLAGS = new Set(["--mcp", "--mcp-envelope", "--allow-origin", "--set-aside-run", "--relay-root-key"]);
const POLICY_FLAGS: Readonly<Record<string, string>> = Object.freeze({
  "--only-here": "scope", "--anywhere": "scope", "--read-only": "writes", "--writable": "writes",
  "--no-shell": "shell", "--shell": "shell", "--approve-commands": "approvals", "--no-approve-commands": "approvals",
  "--no-audit": "audit", "--audit-on": "audit",
});
const runnerEntry = fileURLToPath(new URL("../bin/aiboard-runner-v2.mjs", import.meta.url));
const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));

export function parseLauncherArguments(raw: string[]): LauncherArguments {
  const args = [...raw];
  while (args[0] === "--") args.shift();
  let command: Command = "start";
  const selected: RunnerKind[] = [];
  while (args[0] && !args[0].startsWith("-")) {
    const name = args[0];
    if (name === "mcp") {
      if (selected.length > 0 || args[1] !== "serve") throw new Error("invalid_arguments: Expected aiboard mcp serve --stdio.");
      args.splice(0, 2);
      command = "mcp";
      break;
    }
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
  const policyFields = new Set<string>();
  const result: LauncherArguments = { command, runners: selected.length > 0 ? selected : ["runner"], runnerFlags: [] };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === "--help" || flag === "-h") { result.command = "help"; continue; }
    if (["--no-open", "--stdio", "--logout", "--acknowledge-remote-access", "--policy", "--audit"].includes(flag) || Object.hasOwn(POLICY_FLAGS, flag)) {
      if (seen.has(flag)) throw new Error(`invalid_arguments: Duplicate option ${flag}.`);
      seen.add(flag);
    }
    if (flag === "--no-open") { result.noOpen = true; continue; }
    if (flag === "--stdio") {
      if (result.command !== "mcp" || result.stdio) throw new Error("invalid_arguments: --stdio applies once to mcp serve.");
      result.stdio = true; continue;
    }
    if (flag === "--logout") {
      if (result.command !== "remote") throw new Error("invalid_arguments: --logout applies only to aiboard remote.");
      result.logout = true; continue;
    }
    if (flag === "--acknowledge-remote-access") {
      if (result.command !== "remote") throw new Error("invalid_arguments: --acknowledge-remote-access applies only to aiboard remote.");
      result.acknowledgeRemote = true; continue;
    }
    if (flag === "--policy" || flag === "--audit") {
      if (result.command !== "remote") throw new Error(`invalid_arguments: ${flag} applies only to aiboard remote.`);
      if (flag === "--policy") result.policy = true; else result.audit = true;
      continue;
    }
    if (Object.hasOwn(POLICY_FLAGS, flag)) {
      if (result.command !== "remote") throw new Error(`invalid_arguments: ${flag} applies only to aiboard remote.`);
      const field = POLICY_FLAGS[flag]!;
      if (policyFields.has(field)) throw new Error(`invalid_arguments: Conflicting policy option ${flag}.`);
      policyFields.add(field); result.policyFlags = true; result.runnerFlags.push(flag); continue;
    }
    if (flag === "--limit") {
      if (seen.has(flag)) throw new Error("invalid_arguments: Duplicate option --limit.");
      seen.add(flag);
      const value = args[++index];
      if (!value || !/^[1-9][0-9]*$/.test(value) || Number(value) > 10_000) throw new Error("invalid_arguments: --limit must be an integer from 1 to 10000.");
      result.auditLimit = Number(value); continue;
    }
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
  if (result.command === "mcp" && !result.stdio) throw new Error("invalid_arguments: mcp serve requires --stdio.");
  if (Number(Boolean(result.logout)) + Number(Boolean(result.policy)) + Number(Boolean(result.audit)) > 1 ||
    ((result.logout || result.policy || result.audit) && (result.policyFlags || result.acknowledgeRemote || result.runnerFlags.length > 0)) ||
    (result.auditLimit !== undefined && !result.audit)) throw new Error("invalid_arguments: Conflicting remote options.");
  if (result.command !== "start" && result.command !== "remote" && result.command !== "mcp" && result.runnerFlags.length > 0) throw new Error("invalid_arguments: Runner options apply only when starting a Runner.");
  const relayIndex = result.runnerFlags.indexOf("--relay-url");
  const rootKeys = result.runnerFlags.flatMap((flag, index) => flag === "--relay-root-key" ? [result.runnerFlags[index + 1]!] : []);
  if (relayIndex >= 0 || rootKeys.length) {
    if (result.command !== "remote" || relayIndex < 0) throw new Error("invalid_arguments: Relay options require aiboard remote --relay-url.");
    try { pairingRelayConfiguration(result.runnerFlags[relayIndex + 1]!, rootKeys); }
    catch (error) { throw new Error(`invalid_arguments: ${error instanceof Error ? error.message : "Invalid relay configuration."}`); }
  }
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
  // Managed-install lifecycle (L2) never starts a Runner and has its own options.
  if (raw[0] === "update") return runUpdateCommand(raw.slice(1));
  if (raw[0] === "uninstall") return runUninstallCommand(raw.slice(1));
  if (raw[0] === "doctor") {
    if (raw.length > 1) throw new Error("invalid_arguments: aiboard doctor takes no options.");
    return runDoctorCommand(await readRunnerVersion());
  }
  const args = parseLauncherArguments(raw);
  const startLike = args.command === "start" || args.command === "mcp" || (args.command === "remote" && !args.logout && !args.policy && !args.audit);
  const write = runtime.write ?? ((message: string) => (args.command === "mcp" ? process.stderr : process.stdout).write(message));
  const depth = args.command === "mcp" ? parseMcpDepth((runtime.environment ?? process.env).AIBOARD_MCP_DEPTH) : 0;
  if (args.command === "mcp" && depth >= LOCAL_MCP_DEPTH_LIMIT) throw new Error("local_mcp_recursion_limit: MCP nesting limit is 2.");
  const version = await readRunnerVersion();
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
  const devicePath = args.command === "remote"
    ? remoteDeviceDirectory({ platform: runtime.platform ?? process.platform, environment, home }) : undefined;
  const flagValue = (flag: string) => {
    const index = args.runnerFlags.indexOf(flag);
    return index < 0 ? undefined : args.runnerFlags[index + 1];
  };
  const roots = devicePath ? await resolveRunnerOwnedRoots({
    projectPath: identity.projectPath,
    stateDirectory: requestedState,
    deviceDirectory: devicePath,
    extensionsHome: flagValue("--extensions-home") ?? join(home, ".aiboard", "runner-extensions"),
    ...(flagValue("--capabilities-config") ? { capabilitiesConfigPath: flagValue("--capabilities-config") } : {}),
    location: { platform: runtime.platform ?? process.platform, environment, home },
  }) : undefined;
  const nestedState = { allowNestedRunnerState: roots?.nested === true };
  // One remote device per user (D9): custody lives beside, not inside, the per-project state.
  const deviceDirectory = devicePath
    ? await prepareUserDirectory(identity.projectPath,
      devicePath,
      process.platform === "win32" ? { home, localAppData: environment.LOCALAPPDATA ?? "" } : undefined,
      nestedState)
    : undefined;
  if (args.command === "remote" && args.logout) {
    const deviceStore = new RemoteDeviceStore(deviceDirectory!);
    const present = deviceStore.loadSession() !== undefined;
    deviceStore.logout();
    write(present
      ? "Remote device logged out. The saved session was cleared; the device key was retained.\n"
      : "Remote device logged out. No saved session was present.\n");
    return;
  }
  await assertWindowsStatePath(requestedState, windowsDefault);
  const prospective = await canonicalFuturePath(requestedState);
  assertExternalState(identity.projectPath, prospective, nestedState);
  if (args.command === "remote" && (args.policy || args.audit)) {
    try {
      await stat(prospective);
      await prepareStateDirectory(identity.projectPath, requestedState, identity, windowsDefault, nestedState);
      await assertProjectBinding(prospective, identity);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await showRemoteLocalState(prospective, deviceDirectory!, args, write);
    return;
  }
  if (!startLike) {
    try { await stat(prospective); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (args.command === "stop") throw new Error("instance_not_running: No Runner is running for this project.");
      write("No Runner is running for this project.\n"); return;
    }
  }
  const stateDirectory = await prepareStateDirectory(identity.projectPath, requestedState, identity, windowsDefault, nestedState);
  let releaseDiscovery = await acquireDiscoveryLock(stateDirectory);
  let child: ChildProcess | undefined;
  let started = false;
  let remoteOnlyActive = roots?.nested === true;
  const freshChildren: ChildProcess[] = [];
  const freshKinds = new Set<RunnerKind>();
  const ownedKeys: Buffer[] = [];
  /** Set when the Runner reports a revoke it persisted; after a clean stop, the launcher runs again to pair a new key. */
  let rePairRequested = false;
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
            if (args.command === "remote" && args.policyFlags) throw new Error("remote_policy_requires_restart: Stop this Runner before applying policy flags.");
            if (args.command === "remote" && roots?.nested && !status.remoteOnly) throw new Error("remote_restart_required: Stop this Runner before starting remote-only mode.");
            if (args.command === "remote") remoteOnlyActive = status.remoteOnly === true;
            reuseV2 = true;
            instances.set("runner", recorded);
            if (args.command !== "mcp") tickets.set("runner", createLocalPairTicket(recorded.instanceId));
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
        const ticket = args.command === "mcp" ? undefined : createLocalPairTicket(instanceId);
        if (ticket) tickets.set("runner", ticket);
        const handshake: LauncherHandshake = {
          type: "aiboard-launcher-init", token: v2Token, controlKey: key.toString("hex"), instanceId,
          ...(ticket ? { pairDigest: ticket.digest, peers: peerListFor("runner", selected, instances, tickets) } : {}), identity, stateDirectory, version,
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
        if (args.command === "remote") {
          // Lives for the whole session (childReady detaches at ready): lost / reconnected / revoked reach the terminal.
          const notices = createRemoteStateNotices();
          v2Child.on("message", (message: unknown) => {
            if (typeof message !== "object" || message === null) return;
            const { type, state, reasonCode, persisted } = message as Record<string, unknown>;
            if (type !== REMOTE_STATE_MESSAGE) return;
            if (state === "revoked" && persisted === true) {
              // The next start rotates the identity and pairs (tested path); stop this Runner cleanly, then run again.
              if (!rePairRequested) {
                rePairRequested = true;
                write(stampRemoteNotice(REMOTE_REPAIR_NOTICE));
                if (v2Child?.connected) v2Child.send({ type: "aiboard-launcher-stop" });
              }
              return;
            }
            const line = notices(state, reasonCode);
            if (line) write(stampRemoteNotice(line));
          });
        }
        const ready = childReady(v2Child, handshake, (message) => {
          if (message.type === "aiboard-remote-pairing" && typeof message.verificationUri === "string" && typeof message.userCode === "string" &&
            typeof message.expiresAt === "string" && /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/.test(message.userCode)) {
            const minutes = Math.max(1, Math.ceil((Date.parse(message.expiresAt) - Date.now()) / 60_000));
            write(`Pair this computer: open ${message.verificationUri} and enter code ${message.userCode} (expires in ${minutes} min)\n`);
          } else if (message.type === "aiboard-remote-open" && typeof message.url === "string" && !args.noOpen) {
            try { (runtime.openUrl ?? ((target: string) => openPairUrl(target, runtime.platform ?? process.platform)))(message.url); } catch { /* terminal instructions are the fallback */ }
          } else if (message.type === "aiboard-remote-session" && typeof message.deviceName === "string" && typeof message.accountId === "string") {
            write(`Remote device: ${message.deviceName}; account: ${message.accountId}. Return to ChatGPT/Claude; keep this running; Ctrl+C to disconnect.\n`);
          }
        });
        const instance = await Promise.race([
          ready,
          v2Closed.then(() => {
            // The Runner's own error is the only diagnosis of an early exit; show it with launcher secrets redacted.
            const detail = redact(diagnostics.join(""), [v2Token, ...[...tickets.values()].flatMap((ticket) => [ticket.code, ticket.digest])]).slice(-4_000);
            throw new Error(`runner_start_failed: Runner exited before it became ready.${detail ? `\n${detail}` : ""}`);
          }),
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
    const anchorPeers = args.command === "mcp" ? [] : peerListFor(anchorKind, selected, instances, tickets);
    for (const kind of selected) {
      if (args.command === "mcp") break;
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
    if (args.command === "mcp") {
      const instance = instances.get("runner")!;
      const key = await readControlKey(stateDirectory);
      let session: Awaited<ReturnType<typeof openLauncherMcpSession>>;
      try { session = await openLauncherMcpSession(instance, key, depth); } finally { key.fill(0); }
      const stop = () => session.close();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try { await serveLocalStdioMcp({ port: instance.port, token: session.token, closed: session.closed }); }
      finally {
        process.off("SIGINT", stop); process.off("SIGTERM", stop); session.close();
        for (const fresh of freshChildren) if (fresh.connected) fresh.send({ type: "aiboard-launcher-stop" });
      }
    } else {
      for (const kind of selected) write(describe(instances.get(kind)!, freshKinds.has(kind) ? "running" : "already running"));
      if (args.command === "remote" && remoteOnlyActive) write("Remote-only: Build and Chat are unavailable when started from a folder that contains AIBoard state.\n");
      const orderedPorts = [instances.get(anchorKind)!.port, ...selected.filter((kind) => kind !== anchorKind).map((kind) => instances.get(kind)!.port)];
      showPairing(tickets.get(anchorKind)!.code, orderedPorts, args.noOpen === true, write, runtime);
    }
    if (args.command === "remote" && !args.runnerFlags.includes("--relay-url") && !new RemoteDeviceStore(deviceDirectory!).loadSession()) {
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
    const approvals = new AbortController();
    let approvalWork: Promise<void> | undefined;
    if (args.command === "remote" && process.stdin.isTTY) {
      const key = await readControlKey(stateDirectory);
      approvalWork = runTerminalApprovals(instances.get("runner")!, key, write, approvals.signal, onInterrupt)
        .finally(() => key.fill(0));
    }
    const closedPromises = freshChildren.map((fresh) => childClose(fresh).catch(() => ({ code: null, signal: null })));
    let firstSettled = false;
    for (const closedPromise of closedPromises) {
      void closedPromise.then(() => { if (!firstSettled) { firstSettled = true; requestStop(); } });
    }
    try {
      const results = await Promise.all(closedPromises);
      const v2Result = v2Child ? results[freshChildren.indexOf(v2Child)] : undefined;
      // Ctrl+C or an unclean Runner exit wins over the re-pair restart.
      if (interrupted || v2Result?.code || v2Result?.signal) rePairRequested = false;
      if (v2Result?.code) process.exitCode = v2Result.code;
      else if (interrupted) process.exitCode = 130;
      if (v2Result?.signal) process.exitCode = 1;
      if ((v2Result?.code && v2Result.code !== 130) || v2Result?.signal) {
        const detail = redact(diagnostics.join(""), [v2Token, ...[...tickets.values()].map((ticket) => ticket.code), ...[...tickets.values()].map((ticket) => ticket.digest)]);
        if (detail) process.stderr.write(`${detail}\n`);
      }
    } finally {
      approvals.abort();
      await approvalWork;
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
  if (rePairRequested) await runLauncher(raw.includes("--no-open") ? raw : [...raw, "--no-open"], runtime);
}

async function readRunnerVersion(): Promise<string> {
  const metadata: unknown = JSON.parse(await readFile(packagePath, "utf8"));
  return typeof metadata === "object" && metadata !== null && "version" in metadata && typeof metadata.version === "string" ? metadata.version : "unknown";
}

async function runTerminalApprovals(instance: LauncherInstance, key: Buffer, write: (message: string) => void,
  signal: AbortSignal, interrupt: () => void): Promise<void> {
  const pause = () => new Promise<void>((resolve) => {
    const timer = setTimeout(done, 1_000);
    function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
  while (!signal.aborted) {
    try {
      const request = (await requestLauncherApproval(instance, key)).approval;
      if (!request) { await pause(); continue; }
      const promptAbort = new AbortController();
      const abort = () => promptAbort.abort();
      signal.addEventListener("abort", abort, { once: true });
      try {
        const prompted = promptCommandApproval(request, process.stdin, write, promptAbort.signal, interrupt);
        let answer: boolean | undefined;
        while (!signal.aborted) {
          const result = await Promise.race([
            prompted.then((value) => ({ done: true as const, value })),
            pause().then(() => ({ done: false as const })),
          ]);
          if (result.done) { answer = result.value; break; }
          const current = (await requestLauncherApproval(instance, key)).approval;
          if (!current || current.summary.jobId !== request.summary.jobId || current.nonce !== request.nonce) {
            promptAbort.abort();
            await prompted;
            break;
          }
        }
        if (answer !== undefined && !signal.aborted) {
          const result = await requestLauncherApproval(instance, key, {
            jobId: request.summary.jobId, nonce: request.nonce, approved: answer,
          });
          if (!result.accepted) write("Approval is no longer pending.\n");
        }
      } finally {
        promptAbort.abort();
        signal.removeEventListener("abort", abort);
      }
    } catch {
      if (!signal.aborted) await pause();
    }
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
  if (!input.runtime.spawnPeer && !existsSync(peerEntries[kind])) {
    throw new Error(`runner_not_installed: The ${kind} runner is not part of this AIBoard install; download it from https://aiboard.me/runner-guide.`);
  }
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

function childReady(child: ChildProcess, handshake: LauncherHandshake, onRemoteMessage?: (message: Record<string, unknown>) => void): Promise<LauncherInstance> {
  return new Promise((resolve, reject) => {
    let initialized = false;
    const onMessage = (message: unknown) => {
      if (typeof message !== "object" || message === null || !("type" in message)) return;
      if (message.type === "aiboard-remote-pairing-error" && "code" in message && "message" in message && typeof message.code === "string" && typeof message.message === "string") {
        child.off("message", onMessage); child.off("error", reject);
        reject(new Error(`${message.code}: ${message.message}`));
        return;
      }
      if (typeof message.type === "string" && message.type.startsWith("aiboard-remote-")) {
        onRemoteMessage?.(message as Record<string, unknown>);
        return;
      }
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

export function openPairUrl(url: string, platform: NodeJS.Platform): void {
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

async function showRemoteLocalState(stateDirectory: string, deviceDirectory: string, args: LauncherArguments, write: (message: string) => void): Promise<void> {
  const exists = async (path: string): Promise<boolean> => {
    try { await stat(path); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  };
  if (args.policy) {
    const device = new RemoteDeviceStore(deviceDirectory);
    const identity = device.load();
    const session = device.loadSession();
    let status = { policy: DEFAULT_REMOTE_DEVICE_POLICY, fromDefaults: true };
    const path = join(stateDirectory, "remote-principals.sqlite");
    const devicePolicyPath = join(deviceDirectory, "remote-device-policy.sqlite");
    if (identity && session) {
      if (identity.accountId !== session.accountId) throw new Error("Remote device identity does not match its session.");
      const verified = { accountId: session.accountId, clientId: session.clientId, deviceId: identity.deviceId };
      if (await exists(path)) {
        const store = new RemotePrincipalStore(path, undefined, devicePolicyPath);
        try { status = store.policyStatus(verified); }
        finally { store.close(); }
      } else if (await exists(devicePolicyPath)) status = RemotePrincipalStore.readDevicePolicy(devicePolicyPath, verified);
    }
    write(`Remote policy (${status.fromDefaults ? "defaults" : "saved"}):\n` +
      `  shell: ${status.policy.shell ? "on" : "off"}\n  approvals: ${status.policy.approvals ? "on" : "off"}\n` +
      `  read-only: ${status.policy.readOnly ? "on" : "off"}\n  only-here: ${status.policy.onlyHere ? "on" : "off"}\n  audit: ${status.policy.audit ? "on" : "off"}\n`);
    return;
  }
  const path = join(stateDirectory, "remote-audit.sqlite");
  if (!(await exists(path))) { write("No remote audit records.\n"); return; }
  const audit = new RemoteAuditStore(path);
  try {
    const rows = audit.list(args.auditLimit ?? 50);
    if (!rows.length) { write("No remote audit records.\n"); return; }
    const cell = (value: string | null, width: number) => (value ?? "-").replace(/[\r\n\t]/g, " ").padEnd(width);
    write(`${cell("UTC", 25)} ${cell("ROLE", 10)} ${cell("ACCOUNT", 14)} ${cell("CLIENT", 14)} ${cell("DEVICE", 14)} ${cell("TOOL", 20)} ${cell("DECISION", 9)} REASON CATEGORY JOB OUTCOME\n` +
      rows.map((row) => `${cell(row.occurredAt, 25)} ${cell(row.role, 10)} ${cell(row.accountId, 14)} ${cell(row.clientId, 14)} ${cell(row.deviceId, 14)} ${cell(row.toolName, 20)} ${cell(row.decision, 9)} ${cell(row.reasonCode, 1)} ${cell(row.pathCategory, 1)} ${cell(row.jobId, 1)} ${row.outcomeCode}${row.origin ? ` origin=${row.origin} before=${row.beforeFlags} after=${row.afterFlags}` : ""}`).join("\n") + "\n");
  } finally { audit.close(); }
}

function describe(instance: LauncherInstance, state: string): string {
  return `Runner ${state}\nProject: ${instance.projectPath}\nURL: http://127.0.0.1:${instance.port}\nPID: ${instance.pid}\n`;
}
function redact(value: string, secrets: (string | undefined)[]): string {
  return secrets.reduce<string>((result, secret) => secret ? result.replaceAll(secret, "[redacted]") : result, value).trim();
}
function help(): string {
  return [
    "AIBoard Runner", "", "Usage: aiboard [runner|accounts|legacy|bench|all ...] [options]", "       aiboard [status|stop|version|doctor] [options]",
    "       aiboard update [--check | --rollback]  Install the newest signed release, or return to the previous one.",
    "       aiboard uninstall [--yes] [--keep-state | --remove-state]", "",
    "Runs the selected runners for the current directory in the foreground, or reuses healthy ones.",
    "With no selection only Runner V2 runs; `all` runs every runner. Runner V2 is",
    "the pairing anchor whenever it is selected, otherwise the first listed runner is.",
    "  --no-open                 Do not open a browser (print the pairing code and URL).",
    "  --project <absolute-path> Override the current project directory.",
    "  --state-dir <path>        Use an absolute state directory outside the project.",
    "  --port <number>           Runner port (0 selects an available port).",
    "  --capabilities-config, --extensions-home, --mcp, --mcp-envelope,",
    "  --allow-origin, --set-aside-run  Pass existing Runner options through.",
    "  aiboard remote            Start Runner V2 with the remote service; --logout clears the session.",
    "  remote --relay-url <wss-url> [--relay-root-key <base64url-spki> ...]",
    "  remote --only-here|--anywhere --read-only|--writable --no-shell|--shell",
    "  remote --approve-commands|--no-approve-commands  Set per-command approval.",
    "  remote --no-audit|--audit-on  Set local device policy; --policy shows it.",
    "  remote --audit [--limit N]  Show recent local audit records.",
    "  aiboard mcp serve --stdio Serve local tools through this project's Runner (maximum MCP nesting depth: 2).",
    "  --help, -h                Show this help.", "",
  ].join("\n");
}
