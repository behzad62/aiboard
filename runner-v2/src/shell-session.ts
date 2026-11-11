import { randomBytes } from "node:crypto";

import type { ToolExecutionContext } from "./agent-contracts.js";
import { ManagedProcessError, type ManagedOutputStreamEvidence } from "./managed-process-contracts.js";
import type { ManagedOutputReadResult } from "./managed-process-output.js";
import type { ManagedProcessService } from "./managed-process.js";
import { SESSION_HOST_COMMAND, SESSION_HOST_SCRIPT } from "./shell-session-host.js";
import { BASH_SESSION_HOST_COMMAND, BASH_SESSION_HOST_SCRIPT } from "./shell-session-bash-host.js";
import { bashExecutable, isStoreAppAlias, pwshExecutable } from "./shell-inventory.js";

/**
 * Shell sessions: process.run with shellSession runs its script in a PowerShell or bash that stays up between calls, so
 * variables, functions, environment values and the current location carry over (shell-session-host.ts,
 * shell-session-bash-host.ts). A session is an ordinary managed
 * process in the run's Job, owned by the exact caller that started it: the same launch, input and output authority as
 * process.start and process.interact, under the process.run call's own grant. It ends with its owner, when it is idle
 * for SESSION_IDLE_MS, or by process.signal on its processId.
 */
export const SESSION_SHELLS = ["powershell", "pwsh", "bash"] as const;
export type SessionShell = (typeof SESSION_SHELLS)[number];
export const SESSION_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u;
/**
 * A session command can run this long. A call's grant lives 120 s and its reads need it, so this leaves time for the
 * session to start, for the stop at the limit, and for the reply. Longer jobs belong in process.start.
 */
export const SESSION_MAX_TIMEOUT_MS = 90_000;
const SESSION_IDLE_MS = 15 * 60_000;
/** After a command's limit PowerShell stops it like Ctrl+C; past this as well, the session is ended. */
const STOP_GRACE_MS = 10_000;
/** Bash cannot stop one command and keep the shell, so its session ends at the limit, after the reply's own margin. */
const BASH_STOP_GRACE_MS = 1_000;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
/** The first command travels in the launch environment, whose values are bounded at 32 KiB. */
const FIRST_COMMAND_MAX_BYTES = 24 * 1024;
/** Per stream, the most of one command's output kept in memory; past it the oldest is dropped and counted as lost. */
const OUTPUT_KEEP_CHARS = 8 * 1024 * 1024;

export interface SessionCommand {
  readonly name: string;
  readonly shell: SessionShell;
  readonly script: string;
  /** Absolute. On a later call the session moves there first, and stays there. */
  readonly cwd?: string;
  /** Set in the session's environment, where they stay. */
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface SessionOutcome {
  readonly processId: string;
  /** started: this call launched the session. replaced: an earlier one with this name had ended, so its state is gone. */
  readonly began?: "started" | "replaced";
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** Why the session is gone after this command, when it is. */
  readonly ended?: string;
  /** The session's current location after the command. */
  readonly cwd?: string;
  readonly streams: readonly ManagedOutputStreamEvidence[];
  readonly lossReasons: readonly string[];
  readonly error?: Readonly<{ code: string; message: string }>;
}

interface Session {
  readonly key: string;
  readonly shell: SessionShell;
  readonly processId: string;
  readonly nonce: string;
  turns: number;
  idle?: NodeJS.Timeout;
}

export class ShellSessions {
  private readonly sessions = new Map<string, Session>();
  /** Sessions this service ended (a command past its limit, the shell's exit, idleness): the next call there says replaced. */
  private readonly ended = new Set<string>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly service: ManagedProcessService) {}

  /** Runs one command in the caller's session of this name, starting the session when it has none. */
  async run(command: SessionCommand, context: ToolExecutionContext): Promise<SessionOutcome> {
    if (!SESSION_NAME_PATTERN.test(command.name)) throw new ManagedProcessError("invalid_arguments", "shellSession is 1-64 characters of letters, digits, '.', '_' or '-'.");
    const badName = command.shell === "bash" ? Object.keys(command.env ?? {}).find((name) => !ENV_NAME.test(name)) : undefined;
    if (badName !== undefined) throw new ManagedProcessError("invalid_arguments", `${JSON.stringify(badName)} is not a bash variable name; use letters, digits and '_', not starting with a digit.`);
    const key = sessionKey(context, command.name);
    // One command at a time per session: a second call waits for the first, as a shell would.
    const previous = this.queues.get(key) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(() => this.runNext(key, command, context));
    this.queues.set(key, work);
    try { return await work; } finally { if (this.queues.get(key) === work) this.queues.delete(key); }
  }

  private async runNext(key: string, command: SessionCommand, context: ToolExecutionContext): Promise<SessionOutcome> {
    const existing = this.sessions.get(key);
    if (existing && existing.shell !== command.shell) {
      throw new ManagedProcessError("session_shell_mismatch", `Shell session ${command.name} runs ${existing.shell}; send shell: "${existing.shell}", or use another shellSession name for ${command.shell}.`);
    }
    // Checked from the record, before this call's grant is used: once it has been, the call cannot launch a new session.
    if (existing && this.service.isRunning(existing.processId, context)) return await this.send(existing, command, context);
    if (existing) this.forget(existing);
    const replaced = existing !== undefined || this.ended.delete(key);
    return await this.start(key, command, context, replaced ? "replaced" : "started");
  }

  private async start(key: string, command: SessionCommand, context: ToolExecutionContext, began: "started" | "replaced"): Promise<SessionOutcome> {
    const nonce = randomBytes(12).toString("hex");
    const first = frame(1, command, false);
    if (Buffer.byteLength(first) > FIRST_COMMAND_MAX_BYTES) {
      throw new ManagedProcessError("invalid_arguments", `A session's first command can be at most ${FIRST_COMMAND_MAX_BYTES / 1024} KiB; start the session with a short command, then send this one.`);
    }
    const snapshot = await this.service.start({
      ...launch(command.shell),
      ...(command.cwd ? { cwd: command.cwd } : {}),
      env: { ...command.env, AIBOARD_SESSION_NONCE: nonce, AIBOARD_SESSION_FIRST: first,
        AIBOARD_SESSION_HOST: command.shell === "bash" ? BASH_SESSION_HOST_SCRIPT : SESSION_HOST_SCRIPT },
      interactive: true,
    }, context, context.workspacePath!);
    const session: Session = { key, shell: command.shell, processId: snapshot.processId, nonce, turns: 1 };
    this.sessions.set(key, session);
    const outcome = await this.converse(session, 1, command, context, undefined);
    return { ...outcome, began };
  }

  private async send(session: Session, command: SessionCommand, context: ToolExecutionContext): Promise<SessionOutcome> {
    const id = ++session.turns;
    try {
      return await this.converse(session, id, command, context, { writeId: `session-${session.nonce}-${id}`, data: frame(id, command, true) });
    } catch (error) {
      // It ended after its record last said it was running. Nothing ran; the next call starts a new session.
      if (error instanceof ManagedProcessError && ["process_not_found", "process_input_unavailable", "process_input_closed"].includes(error.code)) {
        this.forget(session, true);
        throw new ManagedProcessError("session_ended", "The session had already ended, so nothing ran. Send the command again to run it in a new session; its variables and location start fresh.");
      }
      throw error;
    }
  }

  private async converse(session: Session, id: number, command: SessionCommand, context: ToolExecutionContext,
    input: { writeId: string; data: string } | undefined): Promise<SessionOutcome> {
    clearTimeout(session.idle);
    const reply = new Reply(session.nonce, id);
    const exchange = await this.service.exchange(session.processId, {
      ...(input ? { input } : {}),
      consume: (read) => reply.add(read),
      until: { pattern: escapeRegExp(`<<aiboard:${session.nonce}:${id}:end>>`) },
      deadline: Date.now() + command.timeoutMs + (command.shell === "bash" ? BASH_STOP_GRACE_MS : STOP_GRACE_MS),
    }, context);
    if (exchange.ended === "not_sent") {
      const write = exchange.write!;
      if (write.status === "rejected" && write.errorCode === "process_input_unavailable") throw new ManagedProcessError("process_input_unavailable", write.message ?? "The session has ended.");
      return reply.outcome(session.processId, { error: { code: write.errorCode ?? "process_input_outcome_unknown",
        message: write.message ?? "The command was not delivered to the session." } });
    }
    let ended: string | undefined;
    if (exchange.ended === "deadline") {
      ended = command.shell === "bash"
        ? `The command ran past its ${command.timeoutMs} ms limit. Bash cannot stop one command and keep the shell, so the session was ended; its variables and location are gone.`
        : `The session did not stop the command at its ${command.timeoutMs} ms limit, so the session was ended; its variables and location are gone.`;
      await this.service.stopProcesses([session.processId]).catch(() => undefined);
    } else if (exchange.ended === "exited") {
      ended = "The session's shell exited, so its variables and location are gone.";
    }
    if (ended) this.forget(session, true);
    else this.keepAlive(session);
    return reply.outcome(session.processId, {
      ...(ended ? { ended } : {}),
      ...(exchange.ended === "deadline" ? { timedOut: true } : {}),
      ...(exchange.readError ? { error: exchange.readError } : {}),
    });
  }

  private keepAlive(session: Session): void {
    clearTimeout(session.idle);
    session.idle = setTimeout(() => {
      if (this.sessions.get(session.key) !== session) return;
      this.forget(session, true);
      void this.service.stopProcesses([session.processId]).catch(() => undefined);
    }, SESSION_IDLE_MS);
    session.idle.unref();
  }

  private forget(session: Session, ended = false): void {
    clearTimeout(session.idle);
    if (this.sessions.get(session.key) === session) this.sessions.delete(session.key);
    if (ended) this.ended.add(session.key);
  }
}

const registries = new WeakMap<ManagedProcessService, ShellSessions>();

/** The sessions of one managed process service: every tool set built on it sees the same sessions. */
export function shellSessionsFor(service: ManagedProcessService): ShellSessions {
  let sessions = registries.get(service);
  if (!sessions) registries.set(service, sessions = new ShellSessions(service));
  return sessions;
}

/**
 * The shell a session runs in. A managed launch pins its program by its real path and contents, which a Microsoft Store
 * app's pwsh (an app execution alias under WindowsApps) does not have, so that pwsh starts through cmd.exe, which
 * follows the alias. The Job host's desktop app policy keeps it in the Job (shell-inventory.ts pwshExecutable).
 */
function launch(shell: SessionShell): { command: string; args: string[] } {
  // Git Bash on Windows without its profile, which can cd to the home folder; a login shell elsewhere, as process.run's bash.
  if (shell === "bash") {
    return process.platform === "win32"
      ? { command: bashExecutable() ?? "bash.exe", args: ["--noprofile", "--norc", "-c", BASH_SESSION_HOST_COMMAND] }
      : { command: "bash", args: ["-lc", BASH_SESSION_HOST_COMMAND] };
  }
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", SESSION_HOST_COMMAND];
  if (shell === "powershell") return { command: "powershell.exe", args };
  const pwsh = pwshExecutable() ?? "pwsh.exe";
  return isStoreAppAlias(pwsh) ? { command: "cmd.exe", args: ["/d", "/c", "pwsh.exe", ...args] } : { command: pwsh, args };
}

function sessionKey(context: ToolExecutionContext, name: string): string {
  return JSON.stringify([context.runId, context.sessionId, context.actor.role, context.actor.id, name]);
}

function frame(id: number, command: SessionCommand, withPlace: boolean): string {
  if (command.shell === "bash") {
    const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
    const env = withPlace && command.env && Object.keys(command.env).length
      ? Object.entries(command.env).map(([name, value]) => `${name}:${b64(value)}`).join(",") : "-";
    // Forward slashes: Git Bash takes D:/path as it is.
    return [String(id), b64(command.script), withPlace && command.cwd ? b64(command.cwd.replaceAll("\\", "/")) : "-", env].join(" ");
  }
  return Buffer.from(JSON.stringify({ id, script: command.script, timeoutMs: command.timeoutMs,
    ...(withPlace && command.cwd ? { cwd: command.cwd } : {}),
    ...(withPlace && command.env && Object.keys(command.env).length ? { env: command.env } : {}) }), "utf8").toString("base64");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

type StreamName = "stdout" | "stderr";

/** One command's reply, cut out of the session's streams by its start and end lines. */
class Reply {
  private readonly raw: Record<StreamName, string> = { stdout: "", stderr: "" };
  private readonly body: Record<StreamName, string> = { stdout: "", stderr: "" };
  private readonly started: Record<StreamName, boolean> = { stdout: false, stderr: false };
  private readonly finished: Record<StreamName, boolean> = { stdout: false, stderr: false };
  private readonly lost: Record<StreamName, number> = { stdout: 0, stderr: 0 };
  private readonly reasons = new Set<string>();
  private result?: { exitCode?: number | null; timedOut?: boolean; cwd?: string };
  private readonly start: string;
  private readonly end: string;

  constructor(nonce: string, id: number) {
    this.start = `<<aiboard:${nonce}:${id}:start>>\n`;
    this.end = `\n<<aiboard:${nonce}:${id}:end>>`;
  }

  /** True once both streams have ended. */
  add(read: ManagedOutputReadResult): boolean {
    for (const slice of read.slices) {
      const stream = slice.stream;
      if (this.finished[stream]) continue;
      if (slice.gap) { this.lost[stream] += slice.gap.toOffset - slice.gap.fromOffset; this.reasons.add(slice.gap.reason); }
      if (slice.lossyBytes > 0) { this.lost[stream] += slice.lossyBytes; for (const reason of slice.lossReasons) this.reasons.add(reason); }
      this.raw[stream] += slice.text.replace(/\r\n/gu, "\n");
      this.scan(stream);
    }
    return this.finished.stdout && this.finished.stderr;
  }

  private scan(stream: StreamName): void {
    if (!this.started[stream]) {
      const at = this.raw[stream].indexOf(this.start);
      if (at < 0) {
        // Anything before the start line belongs to an earlier command or the shell's own startup.
        this.raw[stream] = this.raw[stream].slice(-this.start.length);
        return;
      }
      this.started[stream] = true;
      this.raw[stream] = this.raw[stream].slice(at + this.start.length);
    }
    const at = this.raw[stream].indexOf(this.end);
    if (at < 0) {
      // Keep the possible start of an end line; the rest is the command's output.
      const keep = Math.max(0, this.raw[stream].length - this.end.length);
      this.append(stream, this.raw[stream].slice(0, keep));
      this.raw[stream] = this.raw[stream].slice(keep);
      return;
    }
    this.append(stream, this.raw[stream].slice(0, at));
    const rest = this.raw[stream].slice(at + this.end.length);
    if (stream === "stdout") {
      const line = rest.indexOf("\n");
      if (line < 0) return; // the result is still arriving
      try { this.result = JSON.parse(rest.slice(0, line)) as typeof this.result; } catch { this.result = {}; }
    }
    this.finished[stream] = true;
    this.raw[stream] = "";
  }

  private append(stream: StreamName, text: string): void {
    if (!text) return;
    this.body[stream] += text;
    if (this.body[stream].length > OUTPUT_KEEP_CHARS) {
      const drop = this.body[stream].length - OUTPUT_KEEP_CHARS;
      this.lost[stream] += Buffer.byteLength(this.body[stream].slice(0, drop));
      this.body[stream] = this.body[stream].slice(drop);
      this.reasons.add("session_output_cap");
    }
  }

  outcome(processId: string, extra: Partial<Pick<SessionOutcome, "ended" | "timedOut" | "error">>): SessionOutcome {
    // Whatever arrived after the start line and before a missing end line is still this command's output.
    for (const stream of ["stdout", "stderr"] as const) if (this.started[stream] && !this.finished[stream]) { this.append(stream, this.raw[stream]); this.raw[stream] = ""; }
    const streams = (["stdout", "stderr"] as const).map((stream): ManagedOutputStreamEvidence => {
      const bytes = new Uint8Array(Buffer.from(this.body[stream], "utf8"));
      return Object.freeze({ stream, totalBytes: bytes.byteLength + this.lost[stream], tail: bytes, lossyBytes: this.lost[stream], lossReasons: Object.freeze([]) });
    });
    const exitCode = typeof this.result?.exitCode === "number" ? this.result.exitCode : null;
    return Object.freeze({
      processId, exitCode,
      timedOut: extra.timedOut === true || this.result?.timedOut === true,
      ...(typeof this.result?.cwd === "string" ? { cwd: this.result.cwd } : {}),
      ...(extra.ended ? { ended: extra.ended } : {}),
      ...(extra.error ? { error: extra.error } : {}),
      streams: Object.freeze(streams), lossReasons: Object.freeze([...this.reasons]),
    });
  }
}
