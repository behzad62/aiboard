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
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { RunnerProcessEnvironment } from "./child-environment.js";
import type { ManagedProcessLaunchIdentity, ManagedProcessStopObserver } from "./execution-host.js";
import { ManagedProcessError } from "./managed-process-contracts.js";
import type { ManagedProcessTarget } from "./managed-process-transport.js";
import {
  inspectPosixProcessIdentities,
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
/**
 * The Runner-set names that differ between owners of one run: kept out of command-evidence identity so evidence
 * still matches across owners. The run's browser and the output folder are the same for every owner and stay in.
 */
export const PLAYWRIGHT_CLI_OWNER_VARIABLES = Object.freeze([
  "AIBOARD_PLAYWRIGHT_SOCKETS",
  "AIBOARD_PLAYWRIGHT_STATE",
  "PLAYWRIGHT_CLI_SESSION",
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
    `mkdir -p "$AIBOARD_PLAYWRIGHT_STATE/tmp"${linux ? ' "$AIBOARD_PLAYWRIGHT_STATE/xdg"' : ""} || exit 4`,
    // The socket folder may be in the shared temp folder (a long state path): this user's own, mode 0700, never a link.
    'mkdir -m 700 "$AIBOARD_PLAYWRIGHT_SOCKETS" 2>/dev/null || true',
    'if [ -L "$AIBOARD_PLAYWRIGHT_SOCKETS" ] || [ ! -d "$AIBOARD_PLAYWRIGHT_SOCKETS" ] || [ ! -O "$AIBOARD_PLAYWRIGHT_SOCKETS" ]; then echo "The browser session socket folder is not this user\'s own: $AIBOARD_PLAYWRIGHT_SOCKETS" >&2; exit 4; fi',
    'chmod 700 "$AIBOARD_PLAYWRIGHT_SOCKETS" || exit 4',
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
  /** Every visible process, each row's group and birth read with its command line; undefined when unreadable. */
  list(): readonly PosixProcessCommandRow[] | undefined;
  /** The current identities of these PIDs, in one bounded read. */
  inspect(pids: readonly number[]): ReadonlyMap<number, PosixProcessIdentityInspection>;
  kill(pid: number, signal: NodeJS.Signals): void;
  /** The Runner's own effective uid; only that user's processes are ever attributed. */
  uid(): number;
}

const OS_PROCESS_TABLE: PosixProcessTable = Object.freeze({
  list: () => listPosixProcessCommands(),
  inspect: (pids: readonly number[]) => inspectPosixProcessIdentities(pids),
  kill: (pid: number, signal: NodeJS.Signals) => { process.kill(pid, signal); },
  uid: () => (typeof process.geteuid === "function" ? process.geteuid() : -1),
});

/** A process whose command line named the session's state folder, by PID, group and birth from one read. */
export interface AttributedBrowserProcess {
  readonly pid: number;
  readonly groupId: number;
  readonly birth: string;
}

export interface BrowserCleanupRecord {
  readonly runId: string;
  readonly sessionId: string;
  /** The stopped session process, or `run` for the sweep when the run's folders are removed. */
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
  /** Every check's outcome (runner-start logs the ones that are not clean). */
  readonly onCleanup?: (record: BrowserCleanupRecord) => void;
}

interface RunBrowsing {
  readonly browser: PlaywrightCliBrowser | null;
}

type StopRecord =
  | { readonly kind: "session"; readonly folder: string; readonly launches: number; readonly before: readonly AttributedBrowserProcess[] | undefined };

/**
 * The Runner's Playwright CLI sessions. A run opts in with `configureRun` (a run that records the CLI tool surface
 * at its start); every other run gets nothing from here, so runs from before VF7b keep their environment.
 *
 * POSIX stop check (spike §9.5, §9.6). The Runner's stop proves only the managed process group, and Chrome leaves
 * it (setsid). A session process is one the Runner itself launched as `playwright-cli-session` (its own launch
 * record, never a command line a model could write). When one is stopped, the Runner records, before the stop,
 * every process of its own user whose command line names the owner's state folder as a path (Chrome's profile,
 * crashpad's database and the daemon's config all live there), each with the PID, group and birth read together
 * with that command line. After the stop it waits a short grace, kills what still matches exactly (birth checked
 * again right before the signal), verifies, records the outcome, and fails the stop closed when a process survives
 * or nothing could be read. Other processes' stops are not checked: they leave the session alone. Windows does
 * nothing here: the Job proves the whole tree.
 */
export class PlaywrightCliSessions {
  private readonly runs = new Map<string, RunBrowsing>();
  private readonly platform: NodeJS.Platform;
  private readonly processes: PosixProcessTable;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly cleanups: BrowserCleanupRecord[] = [];
  /** Managed process ids the Runner launched as the session command, per owner key. */
  private readonly sessionProcesses = new Map<string, string>();
  /** Session launches per owner key; a change between a stop's two halves means a new session started. */
  private readonly launches = new Map<string, number>();
  private readonly socketNames = new Map<string, string>();

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

  /**
   * POSIX: the daemon's socket folder, inside the owner folder when the 103-byte socket path allows it. Otherwise a
   * folder in the temp directory with a random name, which the session command creates with mode 0700 and refuses
   * when it exists and is not this user's own.
   */
  socketFolder(owner: { readonly runId: string; readonly sessionId: string }): string {
    const inside = join(this.ownerFolder(owner), "s");
    if (Buffer.byteLength(inside) + POSIX_SOCKET_NAME_BYTES <= POSIX_SOCKET_PATH_MAX) return inside;
    const key = ownerKey(owner);
    let name = this.socketNames.get(key);
    if (!name) { name = `aib-${randomBytes(6).toString("hex")}`; this.socketNames.set(key, name); }
    return join(this.options.temporaryDirectory ?? tmpdir(), name);
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

  /** Results of the POSIX checks, newest last (diagnostics and tests). */
  cleanupRecords(): readonly BrowserCleanupRecord[] {
    return [...this.cleanups];
  }

  /**
   * Removes a finished run's state folders, after every managed process of the run stopped. On POSIX it first
   * sweeps what still names the run's folder (a session that ended by itself, so no stop of it was checked) the
   * same way as a stop, and keeps the folder when something survives.
   */
  async removeRun(runId: string): Promise<void> {
    const enabled = this.runs.has(runId);
    this.runs.delete(runId);
    for (const key of [...this.sessionProcesses.keys()]) if (key.startsWith(`${runId}\0`)) this.sessionProcesses.delete(key);
    const folder = this.runFolder(runId);
    if (this.platform !== "win32" && enabled && existsSync(folder)) {
      const owner = { runId, sessionId: "run", processId: "run" };
      let survived = true;
      try { survived = (await this.clean(owner, folder, this.scan(folder), true)) !== "clean"; } catch { survived = true; }
      if (survived) return;
    }
    try { rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    catch { /* a held file on Windows; the next removal or the state directory's own cleanup takes it */ }
    for (const [key, name] of [...this.socketNames]) {
      if (!key.startsWith(`${runId}\0`)) continue;
      this.socketNames.delete(key);
      try { rmSync(join(this.options.temporaryDirectory ?? tmpdir(), name), { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  /**
   * Startup: a Runner that stopped without its own cleanup (a crash, a kill) leaves run folders behind. Each one no
   * live process names is removed. One a live process still names is kept and reported, never killed: no PID and
   * birth were recorded for it by this Runner (the general POSIX detached-process gap, spike §7.1). Never throws:
   * it is cleanup, not a gate.
   */
  reconcileStartup(): { readonly removed: readonly string[]; readonly kept: readonly string[] } {
    const root = resolve(this.options.stateRoot);
    let entries: string[];
    try { entries = readdirSync(root).filter((name) => /^r-[0-9a-f]{12}$/.test(name)); } catch { return { removed: [], kept: [] }; }
    const rows = this.platform === "win32" ? [] : this.processes.list();
    const removed: string[] = [], kept: string[] = [];
    for (const name of entries) {
      const folder = join(root, name);
      if (this.platform !== "win32" && (!rows || rows.some((row) => namesFolder(row.command, folder)))) { kept.push(folder); continue; }
      try { rmSync(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); removed.push(folder); }
      catch { kept.push(folder); }
    }
    return { removed, kept };
  }

  stopObserver(): ManagedProcessStopObserver {
    return Object.freeze({
      launching: (identity: Readonly<ManagedProcessLaunchIdentity>) => this.launching(identity),
      beforeStop: (target: Readonly<ManagedProcessTarget>) => this.beforeStop(target),
      afterStop: (target: Readonly<ManagedProcessTarget>, recorded: unknown) => this.afterStop(target, recorded),
    });
  }

  /** The Runner's own launch request: a session process is one launched as the session command, with no arguments. */
  private launching(identity: Readonly<ManagedProcessLaunchIdentity>): void {
    if (!this.runs.has(identity.runId) || identity.command !== PLAYWRIGHT_CLI_SESSION_COMMAND || identity.args.length !== 0) return;
    const key = ownerKey(identity);
    this.sessionProcesses.set(`${key}\0${identity.processId}`, identity.processId);
    this.launches.set(key, (this.launches.get(key) ?? 0) + 1);
  }

  private isSessionProcess(target: Readonly<ManagedProcessTarget>): boolean {
    return this.sessionProcesses.has(`${ownerKey(target)}\0${target.processId}`);
  }

  /** Processes of the Runner's user whose command line names `folder` as a path, from one table read. */
  private scan(folder: string): AttributedBrowserProcess[] | undefined {
    const rows = this.processes.list();
    if (!rows) return undefined;
    const uid = this.processes.uid();
    return rows
      .filter((row) => row.uid === uid && row.pid > 1 && row.pid !== process.pid && namesFolder(row.command, folder))
      .map((row) => Object.freeze({ pid: row.pid, groupId: row.groupId, birth: row.birth }));
  }

  private beforeStop(target: Readonly<ManagedProcessTarget>): StopRecord | undefined {
    if (this.platform === "win32" || !this.runs.has(target.runId) || !this.isSessionProcess(target)) return undefined;
    const folder = this.ownerFolder(target);
    return { kind: "session", folder, launches: this.launches.get(ownerKey(target)) ?? 0, before: existsSync(folder) ? this.scan(folder) : [] };
  }

  private async afterStop(target: Readonly<ManagedProcessTarget>, recorded: unknown): Promise<void> {
    if (!recorded || typeof recorded !== "object" || (recorded as StopRecord).kind !== "session") return;
    const stop = recorded as StopRecord;
    this.sessionProcesses.delete(`${ownerKey(target)}\0${target.processId}`);
    // A session the owner started again in the meantime names the same folder: only what was recorded before the
    // stop is this session's, and the folder stays.
    const restarted = (this.launches.get(ownerKey(target)) ?? 0) !== stop.launches;
    const now = restarted ? [] : this.scan(stop.folder);
    if (stop.before === undefined && now === undefined) {
      this.record(target, "unknown", [], [], []);
      throw new ManagedProcessError("process_cleanup_unverified",
        "The browser session's processes outside the owned process group could not be listed after its stop.");
    }
    const all = new Map<string, AttributedBrowserProcess>();
    for (const entry of [...(stop.before ?? []), ...(now ?? [])]) all.set(`${entry.pid}:${entry.birth}`, entry);
    const outcome = await this.clean(target, stop.folder, [...all.values()], !restarted);
    if (outcome !== "clean") {
      throw new ManagedProcessError("process_cleanup_unverified",
        `The browser session's processes outside the owned process group are still running after SIGKILL (PIDs ${outcome.join(", ")}).`);
    }
  }

  /** Waits, kills what still matches exactly, verifies and records. Returns "clean" or the surviving PIDs. */
  private async clean(owner: { readonly runId: string; readonly sessionId: string; readonly processId: string }, folder: string,
    attributed: readonly AttributedBrowserProcess[] | undefined, removeFolder: boolean): Promise<"clean" | number[]> {
    if (attributed === undefined) {
      this.record(owner, "unknown", [], [], []);
      return [];
    }
    const done = (status: BrowserCleanupRecord["status"], killed: readonly number[]): "clean" => {
      this.record(owner, status, attributed, killed, []);
      if (removeFolder) this.removeOwnerFolder(owner, folder);
      return "clean";
    };
    if (attributed.length === 0) return done("none", []);
    const lingering = await this.waitGone(attributed, this.options.graceMs ?? POSIX_BROWSER_EXIT_GRACE_MS);
    if (lingering.length === 0) return done("exited", []);
    const ownGroup = this.processes.inspect([process.pid]).get(process.pid);
    const ownGroupId = ownGroup?.state === "present" ? ownGroup.value.groupId : undefined;
    const current = this.processes.inspect(lingering.map((entry) => entry.pid));
    const killed: number[] = [];
    const killedGroups = new Set<number>();
    for (const entry of lingering) {
      // Exact identity, read again right before the signal: a reused PID or a changed group is never signalled.
      const now = current.get(entry.pid);
      if (now?.state !== "present" || now.value.birth !== entry.birth || now.value.groupId !== entry.groupId) continue;
      if (killedGroups.has(entry.groupId)) continue; // signalled with its group leader just now
      const leadsGroup = ownGroupId !== undefined && entry.pid === entry.groupId && entry.groupId > 1 && entry.groupId !== ownGroupId;
      try {
        this.processes.kill(leadsGroup ? -entry.groupId : entry.pid, "SIGKILL");
        if (leadsGroup) killedGroups.add(entry.groupId);
        killed.push(entry.pid);
      } catch { /* already gone */ }
    }
    const survivors = await this.waitGone(lingering, this.options.killVerifyMs ?? POSIX_BROWSER_KILL_VERIFY_MS);
    if (survivors.length > 0) {
      this.record(owner, "unverified", attributed, killed, survivors.map((entry) => entry.pid));
      return survivors.map((entry) => entry.pid);
    }
    return done("killed", killed);
  }

  private record(owner: { readonly runId: string; readonly sessionId: string; readonly processId: string }, status: BrowserCleanupRecord["status"],
    attributed: readonly AttributedBrowserProcess[], killed: readonly number[], alive: readonly number[]): void {
    const entry: BrowserCleanupRecord = Object.freeze({ runId: owner.runId, sessionId: owner.sessionId, processId: owner.processId, status,
      attributed: Object.freeze([...attributed]), killed: Object.freeze([...killed]), alive: Object.freeze([...alive]), at: new Date(this.now()).toISOString() });
    this.cleanups.push(entry);
    if (this.cleanups.length > 256) this.cleanups.shift();
    try { this.options.onCleanup?.(entry); } catch { /* a logging failure never changes the outcome */ }
  }

  /** The processes still alive with the same birth (an unreadable identity counts as alive). Bounded by `ms`. */
  private async waitGone(processes: readonly AttributedBrowserProcess[], ms: number): Promise<AttributedBrowserProcess[]> {
    const deadline = this.now() + ms;
    for (;;) {
      const current = this.processes.inspect(processes.map((entry) => entry.pid));
      const remaining = processes.filter((entry) => {
        const now = current.get(entry.pid);
        return !(now?.state === "absent" || (now?.state === "present" && now.value.birth !== entry.birth));
      });
      if (remaining.length === 0 || this.now() >= deadline) return remaining;
      await this.sleep(100);
    }
  }

  /** Only after the session's own stop and when nothing names the folder any more. */
  private removeOwnerFolder(owner: { readonly runId: string; readonly sessionId: string }, folder: string): void {
    const rows = this.processes.list();
    if (!rows || rows.some((row) => row.pid !== process.pid && namesFolder(row.command, folder))) return;
    try { rmSync(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* removed with the run */ }
    if (owner.sessionId === "run") return;
    const sockets = this.socketFolder(owner);
    if (!sockets.startsWith(`${folder}${sep}`)) {
      try { rmSync(sockets, { recursive: true, force: true }); } catch { /* removed with the run */ }
    }
  }
}

function ownerKey(owner: { readonly runId: string; readonly sessionId: string }): string {
  return `${owner.runId}\0${owner.sessionId}`;
}

/** A command line names `folder` as a path: the folder followed by a separator, never a longer sibling's prefix. */
function namesFolder(command: string, folder: string): boolean {
  return command.includes(`${folder}${sep}`);
}
