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
// - On POSIX, Playwright starts Chrome in a session of its own, outside the owned process group. After the session
//   process's stop, PlaywrightCliSessions reads the browser Chrome recorded in the session's own profile, confirms
//   it by PID, birth and group, and waits a short grace for it to leave. One still running is a known escape: it is
//   recorded, re-checked on the owner's later stops, and blocks the run's folder removal; it is never signalled
//   (DECISION 2026-09-19 §8.3). The browser is found through its profile, never by enumerating the host's
//   processes: every read is by PID, and the only listing is on the grace's last pass, one
//   `ps -e -o pid=,pgid=,stat=` per browser group that still answers kill(-group, 0), read only as that group's
//   emptiness evidence.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { RunnerProcessEnvironment } from "./child-environment.js";
import type { ManagedProcessLaunchIdentity, ManagedProcessStopObserver } from "./execution-host.js";
import { ManagedProcessError } from "./managed-process-contracts.js";
import type { ManagedProcessTarget } from "./managed-process-transport.js";
import {
  inspectPosixProcessIdentities,
  posixProcessGroupAlive,
  readPosixProcessCommandLine,
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
const ALREADY_TEXT =
  "This agent session's browser session is already running: use it with playwright-cli, or stop its process with process.signal before starting another. Nothing was started.";
/**
 * The daemon reads `$PWTEST_CLI_GLOBAL_CONFIG/.playwright/cli.config.json` (default: the user's home) and every
 * PLAYWRIGHT_MCP_* variable, and the environment outranks `--config`. The session command points the first at an
 * empty config in the owner's state folder and drops every PLAYWRIGHT_MCP_* but the output folder, so neither the
 * user's own Playwright setup nor a model's variable can point the session at another browser or endpoint.
 */
export const PLAYWRIGHT_CLI_GLOBAL_CONFIG_FOLDER = "global";

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
      // One session per owner: cmd holds handle 9 on the lock file, open for writing, while :run runs (the daemon
      // inherits it), so a second start's redirection fails and its :run never runs.
      'set "AIBOARD_SESSION_RAN="',
      '9>"%AIBOARD_PLAYWRIGHT_STATE%\\session.lock" call :run',
      'set "AIBOARD_SESSION_CODE=%ERRORLEVEL%"',
      "if not defined AIBOARD_SESSION_RAN goto already",
      "exit /b %AIBOARD_SESSION_CODE%",
      ":run",
      'set "AIBOARD_SESSION_RAN=1"',
      'if "%PLAYWRIGHT_MCP_OUTPUT_DIR%"=="" goto prepared',
      'if not exist "%PLAYWRIGHT_MCP_OUTPUT_DIR%\\" mkdir "%PLAYWRIGHT_MCP_OUTPUT_DIR%" || exit /b 4',
      'if not exist "%PLAYWRIGHT_MCP_OUTPUT_DIR%\\.gitignore" >"%PLAYWRIGHT_MCP_OUTPUT_DIR%\\.gitignore" echo *',
      ":prepared",
      '>"%AIBOARD_PLAYWRIGHT_STATE%\\cli.config.json" echo {}',
      `if not exist "%AIBOARD_PLAYWRIGHT_STATE%\\${PLAYWRIGHT_CLI_GLOBAL_CONFIG_FOLDER}\\.playwright\\" mkdir "%AIBOARD_PLAYWRIGHT_STATE%\\${PLAYWRIGHT_CLI_GLOBAL_CONFIG_FOLDER}\\.playwright" || exit /b 4`,
      `>"%AIBOARD_PLAYWRIGHT_STATE%\\${PLAYWRIGHT_CLI_GLOBAL_CONFIG_FOLDER}\\.playwright\\cli.config.json" echo {}`,
      `set "PWTEST_CLI_GLOBAL_CONFIG=%AIBOARD_PLAYWRIGHT_STATE%\\${PLAYWRIGHT_CLI_GLOBAL_CONFIG_FOLDER}"`,
      `for /f "delims==" %%V in ('set PLAYWRIGHT_MCP_ 2^>nul') do if /i not "%%V"=="PLAYWRIGHT_MCP_OUTPUT_DIR" set "%%V="`,
      'set "TEMP=%AIBOARD_PLAYWRIGHT_STATE%\\tmp"',
      'set "TMP=%AIBOARD_PLAYWRIGHT_STATE%\\tmp"',
      `"${node}" "${daemon}" "%PLAYWRIGHT_CLI_SESSION%" --browser=%AIBOARD_PLAYWRIGHT_BROWSER% "--config=%AIBOARD_PLAYWRIGHT_STATE%\\cli.config.json"`,
      "exit /b %ERRORLEVEL%",
      ":already",
      `>&2 echo ${ALREADY_TEXT}`,
      "exit /b 5",
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
    // One session per owner: the pidfile holds this shell's PID, which the daemon keeps through exec. A recorded PID
    // counts only while it is alive and still runs this owner's daemon, or this command before its exec (a reused
    // PID does not). Linux without procps reads /proc. Two starts racing on a stale pidfile can both run: both are
    // owned managed processes with attributed profiles, so this is a usability guard, not a boundary.
    'PIDFILE="$AIBOARD_PLAYWRIGHT_STATE/session.pid"',
    'if ! (set -C; echo "$$" > "$PIDFILE") 2>/dev/null; then',
    '  OLD=$(cat "$PIDFILE" 2>/dev/null)',
    '  case "$OLD" in',
    '    ""|*[!0-9]*) ;;',
    '    *) if kill -0 "$OLD" 2>/dev/null; then',
    `         ARGS=$(ps -p "$OLD" -o args= 2>/dev/null || tr '\\000' ' ' < "/proc/$OLD/cmdline" 2>/dev/null)`,
    `         case "$ARGS" in *cliDaemon.js*"$PLAYWRIGHT_CLI_SESSION"*|*/${PLAYWRIGHT_CLI_SESSION_COMMAND}|*/${PLAYWRIGHT_CLI_SESSION_COMMAND}" ") echo ${shQuote(ALREADY_TEXT)} >&2; exit 5 ;; esac`,
    '       fi ;;',
    '  esac',
    '  echo "$$" > "$PIDFILE" || exit 4',
    'fi',
    // The socket folder may be in the shared temp folder (a long state path): this user's own, mode 0700, never a link.
    'mkdir -m 700 "$AIBOARD_PLAYWRIGHT_SOCKETS" 2>/dev/null || true',
    'if [ -L "$AIBOARD_PLAYWRIGHT_SOCKETS" ] || [ ! -d "$AIBOARD_PLAYWRIGHT_SOCKETS" ] || [ ! -O "$AIBOARD_PLAYWRIGHT_SOCKETS" ]; then echo "The browser session socket folder is not this user\'s own: $AIBOARD_PLAYWRIGHT_SOCKETS" >&2; exit 4; fi',
    'chmod 700 "$AIBOARD_PLAYWRIGHT_SOCKETS" || exit 4',
    'if [ -n "${PLAYWRIGHT_MCP_OUTPUT_DIR:-}" ]; then',
    '  mkdir -p "$PLAYWRIGHT_MCP_OUTPUT_DIR" || exit 4',
    "  [ -f \"$PLAYWRIGHT_MCP_OUTPUT_DIR/.gitignore\" ] || printf '*\\n' > \"$PLAYWRIGHT_MCP_OUTPUT_DIR/.gitignore\"",
    "fi",
    "printf '{}\\n' > \"$AIBOARD_PLAYWRIGHT_STATE/cli.config.json\" || exit 4",
    `mkdir -p "$AIBOARD_PLAYWRIGHT_STATE/${PLAYWRIGHT_CLI_GLOBAL_CONFIG_FOLDER}/.playwright" || exit 4`,
    `printf '{}\\n' > "$AIBOARD_PLAYWRIGHT_STATE/${PLAYWRIGHT_CLI_GLOBAL_CONFIG_FOLDER}/.playwright/cli.config.json" || exit 4`,
    `PWTEST_CLI_GLOBAL_CONFIG="$AIBOARD_PLAYWRIGHT_STATE/${PLAYWRIGHT_CLI_GLOBAL_CONFIG_FOLDER}"; export PWTEST_CLI_GLOBAL_CONFIG`,
    "for name in $(env | sed -n 's/^\\(PLAYWRIGHT_MCP_[A-Za-z0-9_]*\\)=.*/\\1/p'); do [ \"$name\" = PLAYWRIGHT_MCP_OUTPUT_DIR ] || unset \"$name\"; done",
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

/** The process reads and signals this module uses, each by PID or group only. Tests inject fakes. */
export interface PosixProcessTable {
  /** The current identities of these PIDs, in one bounded read (a zombie is absent). */
  inspect(pids: readonly number[]): ReadonlyMap<number, PosixProcessIdentityInspection>;
  /** One process's command line, by its PID. */
  commandLine(pid: number): string | undefined;
  /**
   * Whether the group still has a live member: false only on proof of emptiness, undefined when unknown. Without
   * `confirm` only kill(-group, 0) is used; with it, a group that answers is confirmed by the zombie-aware snapshot.
   */
  groupAlive(groupId: number, confirm: boolean): boolean | undefined;
  hostname(): string;
}

const OS_PROCESS_TABLE: PosixProcessTable = Object.freeze({
  inspect: (pids: readonly number[]) => inspectPosixProcessIdentities(pids),
  commandLine: (pid: number) => readPosixProcessCommandLine(pid),
  groupAlive: (groupId: number, confirm: boolean) => posixProcessGroupAlive(groupId, confirm),
  hostname: () => hostname(),
});

/**
 * The session's browser, attributed through the session's own profile: Chrome writes `SingletonLock -> <host>-<pid>`
 * into its user-data-dir, which Playwright creates inside the owner's state folder. The PID is confirmed by its
 * command line naming that profile, with the same birth and group read before and after.
 */
export interface AttributedBrowserProcess {
  readonly pid: number;
  readonly groupId: number;
  readonly birth: string;
  readonly profile: string;
}

export interface BrowserCleanupRecord {
  readonly runId: string;
  readonly sessionId: string;
  /** The stopped session process, or `run` when the run's folders are removed. */
  readonly processId: string;
  /** none: no browser recorded; exited: it left within the grace; escaped: still running (recorded, never signalled). */
  readonly status: "none" | "exited" | "escaped" | "unknown";
  readonly attributed: readonly AttributedBrowserProcess[];
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
  /** Every check's outcome (runner-start logs the ones that are not clean). */
  readonly onCleanup?: (record: BrowserCleanupRecord) => void;
}

interface RunBrowsing {
  readonly browser: PlaywrightCliBrowser | null;
}

interface StopRecord {
  readonly kind: "session";
  readonly folder: string;
  readonly launches: number;
  readonly before: readonly AttributedBrowserProcess[] | undefined;
}

type Owner = { readonly runId: string; readonly sessionId: string; readonly processId: string };

/**
 * The Runner's Playwright CLI sessions. A run opts in with `configureRun` (a run that records the CLI tool surface
 * at its start); every other run gets nothing from here, so runs from before VF7b keep their environment.
 *
 * POSIX stop check (spike §9.5, §9.6; DECISION 2026-09-19 §8). The Runner's stop proves only the managed process
 * group, and Chrome leaves it (setsid). The check records that known escape and blocks on it; it never signals a
 * process outside the group (§8.3). Nothing is matched by name or ancestry, and the host's processes are never
 * enumerated to find the browser: the only listing is the zombie-aware group snapshot (`ps -e -o pid=,pgid=,stat=`)
 * on the grace's last pass, once per browser group that still answers kill(-group, 0), read only as emptiness
 * evidence. A session process is one the Runner itself launched as `playwright-cli-session` (its launch record).
 * When one is stopped, the Runner reads, before and after the stop, the browser PIDs Chrome wrote into the profiles
 * in the owner's state folder (`SingletonLock -> <host>-<pid>`), confirms each (command line naming that profile;
 * birth and group unchanged around the read), and waits a short grace for the browser and its group to leave.
 * Chrome quits on DevTools-pipe EOF when the daemon dies (spike §5).
 *
 * A browser still there, or one that cannot be read, is recorded (`escaped`/`unknown`) and the owner folder stays.
 * The session process's own stop is still proven, so the stop itself succeeds and an agent's close never pauses its
 * run. A known escape is kept per owner folder and re-checked on the owner's later stops; the run's folder removal
 * (`removeRun`) checks every owner again and throws `process_cleanup_unverified` while one runs, so the run's
 * resources are not released. Crashpad handlers leave Chrome's group too, are not in any file, and exit with
 * Chrome; this check does not claim them. Windows does nothing here: the Job proves the whole tree.
 */
export class PlaywrightCliSessions {
  private readonly runs = new Map<string, RunBrowsing>();
  private readonly platform: NodeJS.Platform;
  private readonly processes: PosixProcessTable;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly cleanups: BrowserCleanupRecord[] = [];
  /** Managed process ids the Runner launched as the session command, per owner key. */
  private readonly sessionProcesses = new Set<string>();
  /** Session launches per owner key; a change between a stop's two halves means a new session started. */
  private readonly launches = new Map<string, number>();
  private readonly socketNames = new Map<string, string>();
  /** Browsers recorded as escaped, per owner folder, until a later check proves them gone. */
  private readonly knownEscapes = new Map<string, readonly AttributedBrowserProcess[]>();

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
   * Removes a finished run's state folders, after every managed process of the run stopped. On POSIX it first runs
   * the browser check for each owner folder (a session that ended by itself was never stopped, so never checked),
   * and throws, keeping the folder, when a browser survives or cannot be read; the run's cleanup retries it. The
   * check runs whenever the run's folder exists, also for a run this Runner process never configured (a settled
   * run's cleanup after a restart): a folder exists only for a run that browsed.
   *
   * What this blocks is the run's browser state (the owner folders, profiles and socket folders) and the run's
   * cleanup being marked done. By then the run's managed processes are stopped, each one's own group proven empty
   * (§8.4, group-scoped), and its ExecutionHost binding closed; the lingering browser holds none of those.
   */
  async removeRun(runId: string): Promise<void> {
    this.runs.delete(runId);
    for (const key of [...this.sessionProcesses]) if (key.startsWith(`${runId}\0`)) this.sessionProcesses.delete(key);
    const folder = this.runFolder(runId);
    if (this.platform !== "win32" && existsSync(folder)) {
      const survivors: number[] = [];
      let unknown = false;
      for (const name of safeReaddir(folder).filter((entry) => /^t-[0-9a-f]{8}$/.test(entry))) {
        const owner = join(folder, name);
        const leaders = this.leaders(owner);
        const outcome = await this.clean({ runId, sessionId: name, processId: "run" }, owner, leaders && withKnown(this.knownEscapes.get(owner), leaders), false);
        if (outcome === "unknown") unknown = true;
        else if (outcome !== "clean") survivors.push(...outcome.map((entry) => entry.pid));
      }
      if (unknown || survivors.length > 0) {
        throw new ManagedProcessError("process_cleanup_unverified", unknown
          ? `The browser of a session of run ${runId} could not be read, so its state folder stays.`
          : `The browser of a session of run ${runId} is still running outside its process group (PIDs ${survivors.join(", ")}); it is recorded, not signalled.`);
      }
    }
    try { rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    catch { /* a held file on Windows; the next removal or the state directory's own cleanup takes it */ }
    for (const key of [...this.knownEscapes.keys()]) if (key.startsWith(`${folder}${sep}`)) this.knownEscapes.delete(key);
    for (const [key, name] of [...this.socketNames]) {
      if (!key.startsWith(`${runId}\0`)) continue;
      this.socketNames.delete(key);
      try { rmSync(join(this.options.temporaryDirectory ?? tmpdir(), name), { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  /**
   * Startup: a Runner that stopped without its own cleanup (a crash, a kill) leaves run folders behind. A folder
   * whose sessions' profiles name no live browser is removed; one that still does, or that cannot be read, is kept
   * and reported, never signalled (no stop of it was recorded by this Runner). Never throws: cleanup, not a gate.
   */
  reconcileStartup(): { readonly removed: readonly string[]; readonly kept: readonly string[] } {
    const root = resolve(this.options.stateRoot);
    const entries = safeReaddir(root).filter((name) => /^r-[0-9a-f]{12}$/.test(name));
    const removed: string[] = [], kept: string[] = [];
    for (const name of entries) {
      const folder = join(root, name);
      const live = this.platform !== "win32" && safeReaddir(folder).some((owner) => {
        const leaders = this.leaders(join(folder, owner));
        return leaders === undefined || leaders.length > 0;
      });
      if (live) { kept.push(folder); continue; }
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
    this.sessionProcesses.add(`${key}\0${identity.processId}`);
    this.launches.set(key, (this.launches.get(key) ?? 0) + 1);
  }

  /**
   * The browsers Chrome recorded in the owner's profiles, each confirmed by PID: same birth and group before and
   * after reading a command line that names that profile. A lock naming another host, a PID that is gone, or a PID
   * now running something else is not the session's browser. Undefined when a recorded PID cannot be read.
   */
  private leaders(folder: string): AttributedBrowserProcess[] | undefined {
    const host = this.processes.hostname();
    const found: AttributedBrowserProcess[] = [];
    let unknown = false;
    for (const name of safeReaddir(join(folder, "tmp"))) {
      const profile = join(folder, "tmp", name);
      let lock: string;
      try { lock = readlinkSync(join(profile, "SingletonLock")); } catch { continue; }
      const match = /^(.*)-(\d+)$/.exec(lock);
      if (!match || match[1] !== host) continue;
      const pid = Number(match[2]);
      if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) continue;
      const first = this.processes.inspect([pid]).get(pid);
      if (first?.state === "absent") continue;
      if (first?.state !== "present") { unknown = true; continue; }
      const command = this.processes.commandLine(pid);
      const second = this.processes.inspect([pid]).get(pid);
      if (second?.state === "absent") continue;
      if (command === undefined || second?.state !== "present") { unknown = true; continue; }
      if (second.value.birth !== first.value.birth || second.value.groupId !== first.value.groupId) continue;
      if (!`${command} `.includes(`--user-data-dir=${profile} `)) continue;
      found.push(Object.freeze({ pid, groupId: first.value.groupId, birth: first.value.birth, profile }));
    }
    return unknown ? undefined : found;
  }

  private beforeStop(target: Readonly<ManagedProcessTarget>): StopRecord | undefined {
    if (this.platform === "win32" || !this.runs.has(target.runId) || !this.sessionProcesses.has(`${ownerKey(target)}\0${target.processId}`)) return undefined;
    const folder = this.ownerFolder(target);
    return { kind: "session", folder, launches: this.launches.get(ownerKey(target)) ?? 0, before: this.leaders(folder) };
  }

  /**
   * Never throws for the browser: the session process's own stop is proven by the time this runs, and a stop that
   * failed here would pause the closing agent's whole run (a verifier's, a reviewer's or an Architect copy's close).
   * An escaped or unreadable browser is recorded, the owner folder stays, and `removeRun` blocks on it.
   */
  private async afterStop(target: Readonly<ManagedProcessTarget>, recorded: unknown): Promise<void> {
    if (!recorded || typeof recorded !== "object" || (recorded as StopRecord).kind !== "session") return;
    const stop = recorded as StopRecord;
    this.sessionProcesses.delete(`${ownerKey(target)}\0${target.processId}`);
    try {
      // A session the owner started again in the meantime writes its own profile into the same folder: only what was
      // recorded before the stop is this session's browser, and the folder stays.
      const restarted = (this.launches.get(ownerKey(target)) ?? 0) !== stop.launches;
      const now = restarted ? undefined : this.leaders(stop.folder);
      const read = stop.before === undefined && now === undefined ? undefined : [...(stop.before ?? []), ...(now ?? [])];
      await this.clean(target, stop.folder, read && withKnown(this.knownEscapes.get(stop.folder), read), !restarted);
    } catch {
      // Only a fault of the check itself lands here: record it as unknown (known escapes stay), never fail the stop.
      this.record(target, "unknown", this.knownEscapes.get(stop.folder) ?? [], []);
    }
  }

  /**
   * Waits a short grace for the session's browser to leave (Chrome quits on DevTools-pipe EOF), and records the
   * outcome. A browser still there is a known escape: recorded, kept for the owner folder's later checks and
   * returned, never signalled (DECISION 2026-09-19 §8.3). "clean", "unknown" or the escaped browsers.
   */
  private async clean(owner: Owner, folder: string, attributed: readonly AttributedBrowserProcess[] | undefined, removeFolder: boolean): Promise<"clean" | "unknown" | AttributedBrowserProcess[]> {
    if (attributed === undefined) {
      this.record(owner, "unknown", this.knownEscapes.get(folder) ?? [], []);
      return "unknown";
    }
    const done = (status: BrowserCleanupRecord["status"]): "clean" => {
      this.knownEscapes.delete(folder);
      this.record(owner, status, attributed, []);
      if (removeFolder) { try { rmSync(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* removed with the run */ } }
      return "clean";
    };
    if (attributed.length === 0) return done("none");
    const lingering = await this.waitGone(attributed, this.options.graceMs ?? POSIX_BROWSER_EXIT_GRACE_MS);
    if (lingering.length === 0) return done("exited");
    this.knownEscapes.set(folder, Object.freeze(lingering));
    this.record(owner, "escaped", attributed, lingering.map((entry) => entry.pid));
    return lingering;
  }

  private record(owner: Owner, status: BrowserCleanupRecord["status"], attributed: readonly AttributedBrowserProcess[], alive: readonly number[]): void {
    const entry: BrowserCleanupRecord = Object.freeze({ runId: owner.runId, sessionId: owner.sessionId, processId: owner.processId, status,
      attributed: Object.freeze([...attributed]), alive: Object.freeze([...alive]), at: new Date(this.now()).toISOString() });
    this.cleanups.push(entry);
    if (this.cleanups.length > 256) this.cleanups.shift();
    try { this.options.onCleanup?.(entry); } catch { /* a logging failure never changes the outcome */ }
  }

  /**
   * The browsers not yet gone: a leader still present with its birth, or (when it leads its group) a group not yet
   * proven empty. Unreadable counts as not gone. Bounded by `ms`: each pass reads by PID and kill(-group, 0); only
   * the last pass takes the zombie-aware membership snapshot of a group (emptiness evidence, never ownership).
   */
  private async waitGone(processes: readonly AttributedBrowserProcess[], ms: number): Promise<AttributedBrowserProcess[]> {
    const deadline = this.now() + ms;
    for (;;) {
      const last = this.now() >= deadline;
      const current = this.processes.inspect(processes.map((entry) => entry.pid));
      const remaining = processes.filter((entry) => {
        const now = current.get(entry.pid);
        // A PID reused by another process: the kernel never reuses a PID still in use as a group id, so the
        // browser's group is gone too.
        if (now?.state === "present") return now.value.birth === entry.birth;
        if (now?.state !== "absent") return true;
        return entry.pid === entry.groupId ? this.processes.groupAlive(entry.groupId, last) !== false : false;
      });
      if (remaining.length === 0 || last) return remaining;
      await this.sleep(100);
    }
  }
}

/** The browsers read now, with the owner folder's earlier known escapes, each once (by PID and birth). */
function withKnown(known: readonly AttributedBrowserProcess[] | undefined, read: readonly AttributedBrowserProcess[]): AttributedBrowserProcess[] {
  const all = new Map<string, AttributedBrowserProcess>();
  for (const entry of [...(known ?? []), ...read]) all.set(`${entry.pid}:${entry.birth}`, entry);
  return [...all.values()];
}

function ownerKey(owner: { readonly runId: string; readonly sessionId: string }): string {
  return `${owner.runId}\0${owner.sessionId}`;
}

function safeReaddir(folder: string): string[] {
  try { return readdirSync(folder); } catch { return []; }
}
