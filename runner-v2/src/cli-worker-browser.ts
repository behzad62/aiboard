/**
 * CW8: browsing for CLI workers (docs/plans/2026-11-14-cli-workers.md §3.10, §3.11 case 3).
 *
 * A CLI cannot call the Runner's `process.start`, and a session it starts from its own shell is not one the Runner
 * launched, so on POSIX its browser would be checked only at the run's removal. So when the run's tool inventory
 * recorded a browser, the Runner starts the worker owner's Playwright CLI session itself, before the CLI: the command
 * `playwright-cli-session` with no arguments, as a managed process of that exact owner (the same owner the CLI runs
 * as), ready on "Daemon listening on". The CLI's `playwright-cli` commands reach it through the environment and PATH
 * the Runner sets for that owner (playwright-cli.ts environmentFor). It stops with the owner (`closeAgent`), and the
 * owner folder's browsers are checked afresh after that stop (`checkOwnerBrowsers`).
 *
 * A session that does not start (it exits, never prints its ready line, or its `until.pattern` wait fails, such as at
 * the pattern's wall ceiling on a busy host) is case 3: it is recorded, the CLI runs without a browser, and its browser
 * checks are not run. No bound is raised and the start is not retried: one start per CLI run, and one for the Runner's
 * re-runs of the CLI's browser checks.
 */

import { randomUUID } from "node:crypto";

import type { ToolExecutionContext } from "./agent-contracts.js";
import type { CliBrowserSessions, CliWorkerOwner } from "./cli-worker-runtime.js";
import type { PermissionProfile } from "./contracts.js";
import type { ExecutionGrantAuthority } from "./execution-grants.js";
import type { ManagedProcessService } from "./managed-process.js";
import { MANAGED_OUTPUT_WAIT_MAX_MS } from "./managed-process-contracts.js";
import {
  PLAYWRIGHT_CLI_COMMAND,
  PLAYWRIGHT_CLI_OUTPUT_FOLDER,
  PLAYWRIGHT_CLI_READY_PATTERN,
  PLAYWRIGHT_CLI_SESSION_COMMAND,
  type PlaywrightCliSessions,
} from "./playwright-cli.js";
import { errorMessage } from "./process-stop-proof.js";

/**
 * How long the Runner waits for the session's ready line: one bounded read, the same 30 s the playwright-cli skill
 * gives a model's own `process.start` of the session. The pattern ends the wait as soon as the daemon prints it.
 */
export const CLI_BROWSER_SESSION_READY_WAIT_MS = MANAGED_OUTPUT_WAIT_MAX_MS;
const READY_READ_MAX_BYTES = 16 * 1024;

/** The run's browsing facts and checks the CLI branch reads (PlaywrightCliSessions). */
export type CliBrowsingRuns = Pick<PlaywrightCliSessions, "browserFor" | "checkOwnerBrowsers" | "knownEscapePids">;

/**
 * A check the CLI reported that drives the browser: its executable is the `playwright-cli` command the Runner puts on
 * PATH (a `.cmd` on Windows). Its re-run needs the owner's session (CW6 runs it as not run when there is none).
 */
export function isPlaywrightCliCheck(check: { readonly executable: string }): boolean {
  const name = check.executable.trim().split(/[\\/]/).at(-1)?.toLowerCase().replace(/\.(?:cmd|bat|exe)$/, "");
  return name === PLAYWRIGHT_CLI_COMMAND;
}

/** The preamble's browsing line when the session is running (§3.10): the session, the skill file, and the evidence. */
export function cliBrowserStartedNote(skillPath: string): string {
  return [
    "A browser is running for this task: AIBoard started this worker's Playwright CLI session before you, so use it with",
    `\`${PLAYWRIGHT_CLI_COMMAND}\` commands (add --json to a command whose result you read).`,
    `Never start \`${PLAYWRIGHT_CLI_SESSION_COMMAND}\`, run \`${PLAYWRIGHT_CLI_COMMAND} open\`, or install a browser.`,
    `The skill file ${skillPath} lists the commands; its process.start and run_evidence_command steps are for AIBoard's`,
    "own tools: here the session is already running, and your checks go in your result.",
    "AIBoard re-runs your checks after your turn, in a new session on an empty page, after everything you started has",
    `stopped: list \`${PLAYWRIGHT_CLI_COMMAND} --json goto <url>\` as its own check before the checks that read the page, and`,
    "for a page that needs your own server, make the check one program that starts the server, browses and stops it.",
    `To keep a screenshot or snapshot as evidence, write it under ${PLAYWRIGHT_CLI_OUTPUT_FOLDER}/ with --filename and name`,
    "that path in the check's outputs.",
  ].join(" ");
}

/** The preamble's line when the run's inventory recorded no browser (no session is started). */
export const CLI_NO_BROWSER_NOTE =
  "No browser is available for this task: this machine has no browser the Playwright CLI can use, so do not browse or install one; put any browser check in notRun with that reason.";

/** The preamble's line when the run browses with no Playwright CLI at all (no session is started). */
export const CLI_NO_BROWSING_NOTE =
  "No browser is available in this run: AIBoard does not browse for it, so do not browse with your own tools or install a browser; put any browser check in notRun with that reason.";

/**
 * Production: the owner's session through `ManagedProcessService`, as a final check and the CLI launch do, with one
 * grant per call. `checkAfterStop` and `escapedPids` are the owner folder's fresh check and its known escapes.
 */
export function createManagedCliBrowserSessions(options: {
  managedProcesses: ManagedProcessService;
  executionGrants: ExecutionGrantAuthority;
  permissionProfile: PermissionProfile;
  runs: CliBrowsingRuns;
  /** The AIBoard skill file the preamble names (playwrightCliSkillPath). */
  skillPath: string;
}): CliBrowserSessions {
  const managed = options.managedProcesses;
  const invoke = async <T>(owner: CliWorkerOwner, workspacePath: string, toolName: string, signal: AbortSignal | undefined,
    perform: (context: ToolExecutionContext) => Promise<T>): Promise<T> => {
    const callId = `cli-worker-browser:${randomUUID()}:${toolName}`;
    const grant = await options.executionGrants.issue({
      runId: owner.runId, sessionId: owner.sessionId, actor: { ...owner.actor }, toolName, callId,
      permissionProfile: options.permissionProfile, workspacePath, access: [{ path: workspacePath, mode: "write" }],
      externalApproved: false, destructiveApproved: false, networkApproved: false,
    });
    try {
      return await perform({
        runId: owner.runId, sessionId: owner.sessionId, actor: { ...owner.actor }, callId, toolName, workspacePath,
        executionGrant: grant, ...(signal ? { signal } : {}),
      });
    } finally {
      await options.executionGrants.revoke(grant, "completed");
    }
  };
  return Object.freeze({
    async start(owner: CliWorkerOwner, input: { workspacePath: string; signal?: AbortSignal }) {
      const browser = options.runs.browserFor(owner.runId);
      // No session when the run does not browse through the Playwright CLI, or its inventory found no browser (CWD-2);
      // either way the CLI is told so, so it does not browse with its own tools.
      if (browser === undefined) return { status: "none" as const, note: CLI_NO_BROWSING_NOTE };
      if (browser === null) return { status: "none" as const, note: CLI_NO_BROWSER_NOTE };
      let processId: string;
      try {
        // In the worktree, so its `.aiboard-browser/` output folder is the one the CLI's checks name.
        const started = await invoke(owner, input.workspacePath, "process.start", input.signal, (context) =>
          managed.start({ command: PLAYWRIGHT_CLI_SESSION_COMMAND, args: [], cwd: "." }, context, input.workspacePath));
        processId = started.processId;
      } catch (error) {
        return { status: "start_failed" as const, reason: `the session did not start: ${errorMessage(error)}` };
      }
      let read: Awaited<ReturnType<ManagedProcessService["readOutput"]>>;
      try {
        read = await invoke(owner, input.workspacePath, "process.read_output", input.signal, (context) =>
          managed.readOutput(processId, {
            until: { pattern: PLAYWRIGHT_CLI_READY_PATTERN }, waitMs: CLI_BROWSER_SESSION_READY_WAIT_MS, maxBytes: READY_READ_MAX_BYTES,
          }, context));
      } catch (error) {
        // The wall ceiling of the pattern's evaluation on a busy host lands here, as any failed wait does (§3.11a).
        return { status: "start_failed" as const, reason: `the session's ready wait failed: ${errorMessage(error)}` };
      }
      if (read.completion?.source === "pattern") return { status: "started" as const, note: cliBrowserStartedNote(options.skillPath) };
      const said = read.slices.map((slice) => slice.text).join("").replace(/\s+/g, " ").trim().slice(-300);
      return {
        status: "start_failed" as const,
        reason: read.status !== "running"
          ? `the session ended (exit code ${read.exitCode ?? "unknown"}) before it was ready${said ? `: ${said}` : ""}`
          : `the session did not print "${PLAYWRIGHT_CLI_READY_PATTERN}" within ${CLI_BROWSER_SESSION_READY_WAIT_MS} ms`,
      };
    },
    checkAfterStop: (owner: CliWorkerOwner) => options.runs.checkOwnerBrowsers(owner),
    escapedPids: (owner: CliWorkerOwner) => options.runs.knownEscapePids(owner),
  });
}
