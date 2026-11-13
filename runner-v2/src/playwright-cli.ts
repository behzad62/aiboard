// VF7b (docs/plans/2026-11-13-build-verification.md §4.5, design in docs/runner-v2/playwright-cli-spike-2026-11-13.md §9):
// every Build role browses through the Playwright CLI the Runner ships, with ordinary commands.
//
// - Each owning agent session gets one CLI session, `t-<8 hex>`, and a state folder the Runner owns. Every process
//   the Runner starts for that owner gets PLAYWRIGHT_CLI_SESSION, the registry folder (PWTEST_DAEMON_SESSION_DIR),
//   the output folder and the two commands below first on PATH (child-environment.ts processEnvironment).
// - `playwright-cli-session` runs the CLI daemon in the foreground. A model starts it with its own process.start,
//   so it is an ordinary owned managed process, stopped with its owner. It is never started through the CLI's
//   `open`, which hangs process.run on Windows and leaves the owned process group on POSIX (spike §4).
// - `playwright-cli` runs the bundled CLI behind playwright-cli-guard.mjs, a guardrail that refuses the commands
//   that would escape the managed session.
// - On POSIX, Playwright starts Chrome in a session of its own, outside the owned process group. After a managed
//   stop, PlaywrightCliSessions checks the browser processes it can attribute to the owner exactly (PID and birth),
//   kills the ones still alive, verifies, and fails the stop closed when one survives (spike §9.6).
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { RunnerProcessEnvironment } from "./child-environment.js";
import type { ManagedProcessStopObserver } from "./execution-host.js";
import { ManagedProcessError } from "./managed-process-contracts.js";
import type { ManagedProcessTarget } from "./managed-process-transport.js";
import {
  inspectPosixProcessIdentity,
  listPosixProcessCommands,
  type PosixProcessCommandRow,
  type PosixProcessIdentityInspection,
} from "./portable-process-posix-control.mjs";

export const PLAYWRIGHT_CLI_COMMAND = "playwright-cli";
export const PLAYWRIGHT_CLI_SESSION_COMMAND = "playwright-cli-session";
/** The daemon prints this once it serves commands: the `until` pattern of the session's process.start. */
export const PLAYWRIGHT_CLI_READY_PATTERN = "Daemon listening on";
/**
 * Where the daemon writes auto-named snapshots, console logs and screenshots, relative to its working directory
 * (the agent's workspace root when process.start names no cwd). The session command creates it with a
 * `.gitignore` of `*`, so `git status` and the Runner's `git add -A` task commits never see it, while VF6
 * `outputs` can still keep its files as evidence.
 */
export const PLAYWRIGHT_CLI_OUTPUT_FOLDER = ".aiboard-browser";
export const PLAYWRIGHT_CLI_BROWSERS = ["chrome", "msedge", "chromium"] as const;
export type PlaywrightCliBrowser = typeof PLAYWRIGHT_CLI_BROWSERS[number];
/** playwright-core's UNIX_SOCKET_PATH_MAX (packages/utils/fileUtils.ts). */
export const POSIX_SOCKET_PATH_MAX = 103;
/** `/cli/` + the 16-hex workspace hash + `-` + `t-<8 hex>` + `.sock`. */
export const POSIX_SOCKET_NAME_BYTES = "/cli/".length + 16 + 1 + "t-00000000".length + ".sock".length;
/** The Runner-set names: kept out of command-evidence identity so evidence still matches across owners. */
export const PLAYWRIGHT_CLI_RUNNER_VARIABLES = Object.freeze([
  "AIBOARD_PLAYWRIGHT_BROWSER",
  "AIBOARD_PLAYWRIGHT_SOCKETS",
  "AIBOARD_PLAYWRIGHT_STATE",
  "PLAYWRIGHT_CLI_SESSION",
  "PLAYWRIGHT_MCP_OUTPUT_DIR",
  "PWTEST_DAEMON_SESSION_DIR",
]);
/** How long Chrome gets to leave on its own after the stop (it quits on DevTools-pipe EOF within 0.25 s, spike §5). */
export const POSIX_BROWSER_EXIT_GRACE_MS = 2_000;
/** How long a SIGKILL of an attributed process gets before the stop is reported unverified. */
export const POSIX_BROWSER_KILL_VERIFY_MS = 2_000;

export function isPlaywrightCliBrowser(value: unknown): value is PlaywrightCliBrowser {
  return typeof value === "string" && (PLAYWRIGHT_CLI_BROWSERS as readonly string[]).includes(value);
}

/** One CLI session per owning agent session: short and `[a-z0-9-]` only (POSIX socket budget, `_`→`-` sanitizing). */
export function playwrightCliSessionName(runId: string, sessionId: string): string {
  return `t-${createHash("sha256").update(`${runId}\0${sessionId}`).digest("hex").slice(0, 8)}`;
}

function runSegment(runId: string): string {
  return `r-${createHash("sha256").update(runId).digest("hex").slice(0, 12)}`;
}

// ---------------------------------------------------------------- the commands on PATH

export interface PlaywrightCliInstall {
  /** The Node that runs the Runner: the bundled one in a release. */
  readonly node: string;
  /** `<app>/node_modules/playwright/cli.js`. */
  readonly cli: string;
  /** `<app>/node_modules/playwright-core/lib/entry/cliDaemon.js`. */
  readonly daemon: string;
  /** `runner-v2/src/playwright-cli-guard.mjs`. */
  readonly guard: string;
}

export function resolvePlaywrightCliInstall(node = process.execPath): PlaywrightCliInstall {
  const requireFromRunner = createRequire(import.meta.url);
  const playwrightManifest = requireFromRunner.resolve("playwright/package.json");
  const coreManifest = createRequire(playwrightManifest).resolve("playwright-core/package.json");
  return Object.freeze({
    node,
    cli: join(dirname(playwrightManifest), "cli.js"),
    daemon: join(dirname(coreManifest), "lib", "entry", "cliDaemon.js"),
    guard: fileURLToPath(new URL("./playwright-cli-guard.mjs", import.meta.url)),
  });
}

const NO_BROWSER_TEXT =
  "No browser for the Playwright CLI: this machine has no Google Chrome, no Microsoft Edge and no Playwright Chromium. " +
  "The owner can install one with: aiboard browser install (or the Install browser button in Settings, Tools). Nothing was started.";
const ARGUMENTS_TEXT =
  "playwright-cli-session takes no arguments. Start it once with process.start: command playwright-cli-session, until pattern Daemon listening on.";
const OUTSIDE_TEXT =
  "playwright-cli-session runs only in a process the AIBoard Runner starts for a Build agent session, which sets its session and state folder.";

function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function cmdPath(value: string): string {
  if (/["\r\n]/.test(value)) throw new Error(`A path the Playwright CLI shims run cannot hold quotes or line breaks: ${value}`);
  return value.replaceAll("%", "%%");
}

/** The four shim files for this platform: name, content and mode. */
export function playwrightCliShimFiles(install: PlaywrightCliInstall, platform: NodeJS.Platform = process.platform): { name: string; content: string; mode: number }[] {
  if (platform === "win32") {
    const node = cmdPath(install.node), daemon = cmdPath(install.daemon), guard = cmdPath(install.guard);
    const session = [
      "@echo off",
      "rem AIBoard Runner (VF7b): this agent session's Playwright CLI browser, in the foreground. Start it with process.start.",
      "setlocal",
      'if not "%~1"=="" goto arguments',
      'if "%PLAYWRIGHT_CLI_SESSION%"=="" goto outside',
      'if "%AIBOARD_PLAYWRIGHT_STATE%"=="" goto outside',
      'if /i "%AIBOARD_PLAYWRIGHT_BROWSER%"=="chrome" goto start',
      'if /i "%AIBOARD_PLAYWRIGHT_BROWSER%"=="msedge" goto start',
      'if /i "%AIBOARD_PLAYWRIGHT_BROWSER%"=="chromium" goto start',
      `>&2 echo ${NO_BROWSER_TEXT}`,
      "exit /b 3",
      ":start",
      'if not exist "%AIBOARD_PLAYWRIGHT_STATE%\\tmp\\" mkdir "%AIBOARD_PLAYWRIGHT_STATE%\\tmp" || exit /b 4',
      'if "%PLAYWRIGHT_MCP_OUTPUT_DIR%"=="" goto prepared',
      'if not exist "%PLAYWRIGHT_MCP_OUTPUT_DIR%\\" mkdir "%PLAYWRIGHT_MCP_OUTPUT_DIR%" || exit /b 4',
      'if not exist "%PLAYWRIGHT_MCP_OUTPUT_DIR%\\.gitignore" >"%PLAYWRIGHT_MCP_OUTPUT_DIR%\\.gitignore" echo *',
      ":prepared",
      'if not exist "%AIBOARD_PLAYWRIGHT_STATE%\\cli.config.json" >"%AIBOARD_PLAYWRIGHT_STATE%\\cli.config.json" echo {}',
      'set "TEMP=%AIBOARD_PLAYWRIGHT_STATE%\\tmp"',
      'set "TMP=%AIBOARD_PLAYWRIGHT_STATE%\\tmp"',
      `"${node}" "${daemon}" "%PLAYWRIGHT_CLI_SESSION%" --browser=%AIBOARD_PLAYWRIGHT_BROWSER% "--config=%AIBOARD_PLAYWRIGHT_STATE%\\cli.config.json"`,
      "exit /b %ERRORLEVEL%",
      ":arguments",
      `>&2 echo ${ARGUMENTS_TEXT}`,
      "exit /b 2",
      ":outside",
      `>&2 echo ${OUTSIDE_TEXT}`,
      "exit /b 2",
      "",
    ].join("\r\n");
    const cli = ["@echo off", `"${node}" "${guard}" %*`, "exit /b %ERRORLEVEL%", ""].join("\r\n");
    return [
      { name: `${PLAYWRIGHT_CLI_SESSION_COMMAND}.cmd`, content: session, mode: 0o644 },
      { name: `${PLAYWRIGHT_CLI_COMMAND}.cmd`, content: cli, mode: 0o644 },
    ];
  }
  const linux = platform === "linux";
  const session = [
    "#!/bin/sh",
    "# AIBoard Runner (VF7b): this agent session's Playwright CLI browser, in the foreground. Start it with process.start.",
    `if [ "$#" -ne 0 ]; then echo ${shQuote(ARGUMENTS_TEXT)} >&2; exit 2; fi`,
    `if [ -z "\${PLAYWRIGHT_CLI_SESSION:-}" ] || [ -z "\${AIBOARD_PLAYWRIGHT_STATE:-}" ] || [ -z "\${AIBOARD_PLAYWRIGHT_SOCKETS:-}" ]; then echo ${shQuote(OUTSIDE_TEXT)} >&2; exit 2; fi`,
    'case "${AIBOARD_PLAYWRIGHT_BROWSER:-}" in',
    "  chrome|msedge|chromium) ;;",
    `  *) echo ${shQuote(NO_BROWSER_TEXT)} >&2; exit 3 ;;`,
    "esac",
    `mkdir -p "$AIBOARD_PLAYWRIGHT_STATE/tmp" "$AIBOARD_PLAYWRIGHT_SOCKETS"${linux ? ' "$AIBOARD_PLAYWRIGHT_STATE/xdg"' : ""} || exit 4`,
    'if [ -n "${PLAYWRIGHT_MCP_OUTPUT_DIR:-}" ]; then',
    '  mkdir -p "$PLAYWRIGHT_MCP_OUTPUT_DIR" || exit 4',
    "  [ -f \"$PLAYWRIGHT_MCP_OUTPUT_DIR/.gitignore\" ] || printf '*\\n' > \"$PLAYWRIGHT_MCP_OUTPUT_DIR/.gitignore\"",
    "fi",
    "[ -f \"$AIBOARD_PLAYWRIGHT_STATE/cli.config.json\" ] || printf '{}\\n' > \"$AIBOARD_PLAYWRIGHT_STATE/cli.config.json\"",
    'TMPDIR="$AIBOARD_PLAYWRIGHT_STATE/tmp"; TEMP="$TMPDIR"; TMP="$TMPDIR"; PWTEST_SOCKETS_DIR="$AIBOARD_PLAYWRIGHT_SOCKETS"',
    "export TMPDIR TEMP TMP PWTEST_SOCKETS_DIR",
    ...(linux ? ['XDG_CONFIG_HOME="$AIBOARD_PLAYWRIGHT_STATE/xdg"', "export XDG_CONFIG_HOME"] : []),
    `exec ${shQuote(install.node)} ${shQuote(install.daemon)} "$PLAYWRIGHT_CLI_SESSION" "--browser=$AIBOARD_PLAYWRIGHT_BROWSER" "--config=$AIBOARD_PLAYWRIGHT_STATE/cli.config.json"`,
    "",
  ].join("\n");
  const cli = ["#!/bin/sh", `exec ${shQuote(install.node)} ${shQuote(install.guard)} "$@"`, ""].join("\n");
  return [
    { name: PLAYWRIGHT_CLI_SESSION_COMMAND, content: session, mode: 0o755 },
    { name: PLAYWRIGHT_CLI_COMMAND, content: cli, mode: 0o755 },
  ];
}

/** Writes the shims into `directory` (only when their content changed) and returns it. */
export function installPlaywrightCliShims(directory: string, install: PlaywrightCliInstall, platform: NodeJS.Platform = process.platform): string {
  mkdirSync(directory, { recursive: true });
  for (const file of playwrightCliShimFiles(install, platform)) {
    const target = join(directory, file.name);
    let current: string | undefined;
    try { current = readFileSync(target, "utf8"); } catch { current = undefined; }
    if (current !== file.content) {
      const temporary = `${target}.${process.pid}.tmp`;
      writeFileSync(temporary, file.content, { encoding: "utf8", mode: file.mode });
      renameSync(temporary, target);
    }
    if (platform !== "win32") chmodSync(target, file.mode);
  }
  return directory;
}

// ---------------------------------------------------------------- sessions, state folders and the stop check

/** The pieces of a POSIX process table this module reads. Tests inject fakes; production reads the OS. */
export interface PosixProcessTable {
  list(): readonly PosixProcessCommandRow[] | undefined;
  inspect(pid: number): PosixProcessIdentityInspection;
  kill(pid: number, signal: NodeJS.Signals): void;
}

const OS_PROCESS_TABLE: PosixProcessTable = Object.freeze({
  list: () => listPosixProcessCommands(),
  inspect: (pid: number) => inspectPosixProcessIdentity(pid),
  kill: (pid: number, signal: NodeJS.Signals) => { process.kill(pid, signal); },
});

export interface AttributedBrowserProcess {
  readonly pid: number;
  readonly groupId: number;
  readonly birth: string;
  /** daemon_child: a child of the session's daemon while it ran; state_folder: its command line names the owner's folder. */
  readonly reason: "daemon_child" | "state_folder";
}

export interface BrowserCleanupRecord {
  readonly runId: string;
  readonly sessionId: string;
  readonly processId: string;
  readonly status: "none" | "exited" | "killed" | "unverified" | "unknown";
  readonly attributed: readonly AttributedBrowserProcess[];
  readonly killed: readonly number[];
  readonly alive: readonly number[];
  readonly at: string;
}

export interface PlaywrightCliSessionsOptions {
  /** Owner state folders live under `<stateRoot>/<run>/<session>`. */
  readonly stateRoot: string;
  /** The folder holding the shims; put first on PATH for every owner of an enabled run. */
  readonly binDirectory: string;
  readonly platform?: NodeJS.Platform;
  readonly temporaryDirectory?: string;
  readonly processes?: PosixProcessTable;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly graceMs?: number;
  readonly killVerifyMs?: number;
  readonly onCleanup?: (record: BrowserCleanupRecord) => void;
}

interface RunBrowsing {
  readonly browser: PlaywrightCliBrowser | null;
}

/**
 * The Runner's Playwright CLI sessions. A run opts in with `configureRun` (a run that records the CLI tool surface
 * at its start); every other run gets nothing from here, so runs from before VF7b keep their environment.
 */
export class PlaywrightCliSessions {
  private readonly runs = new Map<string, RunBrowsing>();
  private readonly platform: NodeJS.Platform;
  private readonly processes: PosixProcessTable;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly cleanups: BrowserCleanupRecord[] = [];

  constructor(private readonly options: PlaywrightCliSessionsOptions) {
    this.platform = options.platform ?? process.platform;
    this.processes = options.processes ?? OS_PROCESS_TABLE;
    this.sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    this.now = options.now ?? Date.now;
  }

  configureRun(runId: string, input: { readonly browser: PlaywrightCliBrowser | null | undefined }): void {
    this.runs.set(runId, Object.freeze({ browser: isPlaywrightCliBrowser(input.browser) ? input.browser : null }));
  }

  forgetRun(runId: string): void {
    this.runs.delete(runId);
  }

  isEnabled(runId: string): boolean {
    return this.runs.has(runId);
  }

  /** The owner's own folder: registry, temp folder (Chrome's profile), Linux XDG config and the daemon's config. */
  ownerFolder(owner: { readonly runId: string; readonly sessionId: string }): string {
    return join(resolve(this.options.stateRoot), runSegment(owner.runId), playwrightCliSessionName(owner.runId, owner.sessionId));
  }

  runFolder(runId: string): string {
    return join(resolve(this.options.stateRoot), runSegment(runId));
  }

  /** POSIX: the daemon's socket folder, inside the owner folder when the 103-byte socket path allows it. */
  socketFolder(owner: { readonly runId: string; readonly sessionId: string }): string {
    const inside = join(this.ownerFolder(owner), "s");
    if (Buffer.byteLength(inside) + POSIX_SOCKET_NAME_BYTES <= POSIX_SOCKET_PATH_MAX) return inside;
    return join(this.options.temporaryDirectory ?? tmpdir(), `aib-${playwrightCliSessionName(owner.runId, owner.sessionId).slice(2)}`);
  }

  readonly environmentFor = (owner: { readonly runId: string; readonly sessionId: string }): RunnerProcessEnvironment | undefined => {
    const run = this.runs.get(owner.runId);
    if (!run) return undefined;
    const folder = this.ownerFolder(owner);
    return Object.freeze({
      values: Object.freeze({
        PLAYWRIGHT_CLI_SESSION: playwrightCliSessionName(owner.runId, owner.sessionId),
        PWTEST_DAEMON_SESSION_DIR: join(folder, "registry"),
        PLAYWRIGHT_MCP_OUTPUT_DIR: PLAYWRIGHT_CLI_OUTPUT_FOLDER,
        AIBOARD_PLAYWRIGHT_STATE: folder,
        ...(this.platform !== "win32" ? { AIBOARD_PLAYWRIGHT_SOCKETS: this.socketFolder(owner) } : {}),
        ...(run.browser ? { AIBOARD_PLAYWRIGHT_BROWSER: run.browser } : {}),
      }),
      pathPrepend: Object.freeze([resolve(this.options.binDirectory)]),
    });
  };

  /** Results of the POSIX post-stop checks, newest last (diagnostics and tests). */
  cleanupRecords(): readonly BrowserCleanupRecord[] {
    return [...this.cleanups];
  }

  /** Removes a finished run's state folders (best effort: a folder a live process still holds stays). */
  async removeRun(runId: string): Promise<void> {
    this.runs.delete(runId);
    try { rmSync(this.runFolder(runId), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    catch { /* a held file on Windows; the next removal or the state directory's own cleanup takes it */ }
  }

  /**
   * Startup: a Runner that stopped without its own cleanup (a crash, a kill) leaves run folders behind. Each one no
   * live process names is removed. One a live process still names is kept and reported, never killed: no PID and
   * birth were recorded for it by this Runner, so it is not attributable exactly (the general POSIX
   * detached-process gap, spike §7.1). Never throws: it is cleanup, not a gate.
   */
  reconcileStartup(): { readonly removed: readonly string[]; readonly kept: readonly string[] } {
    const root = resolve(this.options.stateRoot);
    let entries: string[];
    try { entries = readdirSync(root).filter((name) => /^r-[0-9a-f]{12}$/.test(name)); } catch { return { removed: [], kept: [] }; }
    const rows = this.platform === "win32" ? [] : this.processes.list();
    const removed: string[] = [], kept: string[] = [];
    for (const name of entries) {
      const folder = join(root, name);
      if (this.platform !== "win32" && (!rows || rows.some((row) => row.command.includes(folder)))) { kept.push(folder); continue; }
      try { rmSync(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); removed.push(folder); }
      catch { kept.push(folder); }
    }
    return { removed, kept };
  }

  stopObserver(): ManagedProcessStopObserver {
    return Object.freeze({
      beforeStop: (target: Readonly<ManagedProcessTarget>) => this.beforeStop(target),
      afterStop: (target: Readonly<ManagedProcessTarget>, recorded: unknown) => this.afterStop(target, recorded),
    });
  }

  private ownsBrowsingState(target: Readonly<ManagedProcessTarget>): string | undefined {
    if (this.platform === "win32" || !this.runs.has(target.runId)) return undefined;
    const folder = this.ownerFolder(target);
    return existsSync(folder) ? folder : undefined;
  }

  /** The owner's live session daemon: the one process whose command line runs cliDaemon.js with the owner's config. */
  private daemonRow(rows: readonly PosixProcessCommandRow[], folder: string): PosixProcessCommandRow | undefined {
    return rows.find((row) => row.command.includes("cliDaemon.js") && row.command.includes(folder));
  }

  /**
   * While the daemon still runs: its direct children and every process naming the owner's folder, by PID and
   * birth. A stop of any other of the owner's processes, while the owner's session runs, is left alone.
   */
  private beforeStop(target: Readonly<ManagedProcessTarget>): { readonly skip: true } | { readonly attributed: readonly AttributedBrowserProcess[] } | undefined {
    const folder = this.ownsBrowsingState(target);
    if (!folder) return undefined;
    const rows = this.processes.list();
    if (!rows) return undefined;
    const daemon = this.daemonRow(rows, folder);
    if (daemon && daemon.pid !== target.pid) return { skip: true };
    return { attributed: this.attribute(rows, folder, daemon ? daemon.pid : undefined) };
  }

  private attribute(rows: readonly PosixProcessCommandRow[], folder: string, daemonPid: number | undefined): AttributedBrowserProcess[] {
    const found = new Map<number, AttributedBrowserProcess>();
    for (const row of rows) {
      if (row.pid === process.pid || row.pid <= 1) continue;
      const reason = row.command.includes(folder) ? "state_folder" as const
        : daemonPid !== undefined && row.ppid === daemonPid ? "daemon_child" as const : undefined;
      if (!reason) continue;
      const identity = this.processes.inspect(row.pid);
      if (identity.state !== "present") continue;
      found.set(row.pid, Object.freeze({ pid: row.pid, groupId: identity.value.groupId, birth: identity.value.birth, reason }));
    }
    return [...found.values()];
  }

  private alive(entry: AttributedBrowserProcess): boolean | undefined {
    const now = this.processes.inspect(entry.pid);
    if (now.state === "absent") return false;
    if (now.state !== "present") return undefined;
    return now.value.birth === entry.birth;
  }

  private async waitGone(processes: readonly AttributedBrowserProcess[], ms: number): Promise<AttributedBrowserProcess[]> {
    const deadline = this.now() + ms;
    for (;;) {
      const remaining = processes.filter((entry) => this.alive(entry) !== false);
      if (remaining.length === 0 || this.now() >= deadline) return remaining;
      await this.sleep(50);
    }
  }

  private async afterStop(target: Readonly<ManagedProcessTarget>, recorded: unknown): Promise<void> {
    const folder = this.ownsBrowsingState(target);
    if (!folder) return;
    if (recorded && typeof recorded === "object" && "skip" in recorded) return;
    const before = recorded && typeof recorded === "object" && "attributed" in recorded
      ? [...(recorded as { attributed: readonly AttributedBrowserProcess[] }).attributed] : [];
    const rows = this.processes.list();
    // A session the owner started again in the meantime is live: nothing of it is a leftover.
    if (rows && this.daemonRow(rows, folder)) return;
    const record = (status: BrowserCleanupRecord["status"], attributed: readonly AttributedBrowserProcess[], killed: readonly number[], alive: readonly number[]) => {
      const entry: BrowserCleanupRecord = Object.freeze({ runId: target.runId, sessionId: target.sessionId, processId: target.processId, status,
        attributed: Object.freeze([...attributed]), killed: Object.freeze([...killed]), alive: Object.freeze([...alive]), at: new Date(this.now()).toISOString() });
      this.cleanups.push(entry);
      if (this.cleanups.length > 256) this.cleanups.shift();
      this.options.onCleanup?.(entry);
      return entry;
    };
    if (!rows && before.length === 0) {
      record("unknown", [], [], []);
      return;
    }
    // Anything that names the folder now (a crashpad handler started after the first look), plus what was recorded.
    const attributed = new Map<string, AttributedBrowserProcess>();
    for (const entry of [...before, ...(rows ? this.attribute(rows, folder, undefined) : [])]) attributed.set(`${entry.pid}:${entry.birth}`, entry);
    const all = [...attributed.values()];
    if (all.length === 0) {
      record("none", [], [], []);
      this.removeOwnerFolder(target, folder);
      return;
    }
    const lingering = await this.waitGone(all, this.options.graceMs ?? POSIX_BROWSER_EXIT_GRACE_MS);
    if (lingering.length === 0) {
      record("exited", all, [], []);
      this.removeOwnerFolder(target, folder);
      return;
    }
    const ownGroup = (() => { const self = this.processes.inspect(process.pid); return self.state === "present" ? self.value.groupId : undefined; })();
    const killed: number[] = [];
    for (const entry of lingering) {
      // Exact identity, checked again right before the signal: a reused PID is never signalled.
      if (this.alive(entry) !== true) continue;
      const leadsGroup = entry.pid === entry.groupId && entry.groupId > 1 && entry.groupId !== ownGroup;
      try {
        this.processes.kill(leadsGroup ? -entry.groupId : entry.pid, "SIGKILL");
        killed.push(entry.pid);
      } catch { /* already gone */ }
    }
    const survivors = await this.waitGone(lingering, this.options.killVerifyMs ?? POSIX_BROWSER_KILL_VERIFY_MS);
    if (survivors.length > 0) {
      record("unverified", all, killed, survivors.map((entry) => entry.pid));
      throw new ManagedProcessError("process_cleanup_unverified",
        `The browser session's processes outside the owned process group are still running after SIGKILL (PIDs ${survivors.map((entry) => entry.pid).join(", ")}).`);
    }
    record("killed", all, killed, []);
    this.removeOwnerFolder(target, folder);
  }

  /** Only after the session's daemon itself stopped and nothing names the folder any more. */
  private removeOwnerFolder(target: Readonly<ManagedProcessTarget>, folder: string): void {
    const rows = this.processes.list();
    if (!rows || rows.some((row) => row.command.includes(folder) && row.pid !== process.pid)) return;
    try { rmSync(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* removed with the run */ }
    const sockets = this.socketFolder(target);
    if (!sockets.startsWith(folder)) {
      try { rmSync(sockets, { recursive: true, force: true }); } catch { /* removed with the run */ }
    }
  }
}
