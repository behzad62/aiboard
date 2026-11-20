import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUNNER_PROCESS_MARK_NAME } from "./child-environment.js";
import { ManagedProcessError } from "./managed-process-contracts.js";
import type { WindowsEscapeSweepReport, WindowsEscapeSweepRequest } from "./windows-job-process-host.js";

/**
 * The Start-Process gap (docs/runner-v2/codex-windows-job-escape-2026-11-18.md §7, DECISION 2026-09-19 §8.1 as
 * amended 2026-11-20). On Windows a packaged (Store) program that a process in the Runner's Job starts (by name through
 * `Start-Process` or cmd's `start`, or by its path) is created outside the Job, so the Job's stop never sees it. It
 * inherits the environment of the process that started it, though. So every process the Runner starts for one owner
 * (run and agent session) carries {@link RUNNER_PROCESS_MARK_NAME} with a random value for that owner, and after the
 * owner's stop the Runner takes one snapshot of the host's processes and ends those carrying the mark
 * (sweepMarkedWindowsProcesses). It is detection, not proof: a program started without that environment (Start-Process
 * -UseNewEnvironment, or through Explorer or COM) is not seen.
 *
 * A mark is issued on the owner's first launch and kept in the run's state, so a stop retried after a Runner restart
 * still sweeps it. Its issue time bounds the sweep: an older process is never looked at.
 */
export interface ProcessEscapeMark {
  readonly runId: string;
  readonly sessionId: string;
  readonly value: string;
  readonly issuedAt: string;
}

/** A mark to sweep, with the session's launch count when it was taken. */
export interface PendingProcessEscapeMark extends ProcessEscapeMark { readonly launch: number }

export type ProcessEscapeSweeper = (request: WindowsEscapeSweepRequest) => Promise<WindowsEscapeSweepReport>;

const MARK_FILE = /^[0-9a-f]{32}\.json$/;

export class ProcessEscapeMarks {
  private readonly cache = new Map<string, ProcessEscapeMark>();
  /**
   * Sessions launched since their last settled sweep (all loaded ones count, after a restart), each with its launch
   * count, so a launch during a sweep keeps its session pending (settled only clears an unchanged count).
   */
  private readonly unswept = new Map<string, number>();
  private launches = 0;
  private loaded = false;

  constructor(private readonly directory: string, private readonly runId: string, private readonly clock: () => Date = () => new Date()) {}

  /** The owner's mark, issued and durably written on its first launch. A write that fails refuses the launch. */
  markFor(owner: { readonly runId: string; readonly sessionId: string }): string {
    if (owner.runId !== this.runId) throw new Error("Runner process mark belongs to another run.");
    this.load();
    let mark = this.cache.get(owner.sessionId);
    if (!mark) {
      mark = Object.freeze({ runId: this.runId, sessionId: owner.sessionId, value: randomBytes(16).toString("hex"), issuedAt: this.clock().toISOString() });
      mkdirSync(this.directory, { recursive: true });
      const path = join(this.directory, markFileName(owner.sessionId));
      const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      writeFileSync(temporary, JSON.stringify(mark), { encoding: "utf8", flag: "wx" });
      renameSync(temporary, path);
      this.cache.set(owner.sessionId, mark);
    }
    this.unswept.set(owner.sessionId, ++this.launches);
    return mark.value;
  }

  /**
   * The marks to sweep: the session's, or (no session) every session's, each only while it launched since its last
   * settled sweep. A settled sweep left no marked process alive, and only a launch makes a new one (its prepare calls
   * markFor), so a session with no launch since has nothing new to find.
   */
  pending(sessionId?: string): readonly PendingProcessEscapeMark[] {
    this.load();
    // A session's sweep covers its subagents' sessions (`<session>:subagent:<id>`, native-worker-driver.ts): after a
    // restart the worker's retried stop reaches only the subagents that still have a managed record.
    const sessions = [...this.unswept.keys()].filter((session) => sessionId === undefined || session === sessionId || session.startsWith(`${sessionId}:subagent:`));
    return sessions.flatMap((session) => {
      const mark = this.cache.get(session);
      return mark ? [Object.freeze({ ...mark, launch: this.unswept.get(session)! })] : [];
    });
  }

  /** The mark settled: no longer pending, unless the session launched again since the sweep began. */
  settled(mark: PendingProcessEscapeMark): void {
    if (this.unswept.get(mark.sessionId) === mark.launch) this.unswept.delete(mark.sessionId);
  }

  /** Appends one sweep's report to the run's durable sweep log (the unreadable processes are recorded there). */
  record(entry: Readonly<Record<string, unknown>>): void {
    mkdirSync(this.directory, { recursive: true });
    appendFileSync(join(this.directory, "sweeps.jsonl"), `${JSON.stringify({ at: this.clock().toISOString(), ...entry })}\n`, "utf8");
  }

  private load(): void {
    if (this.loaded) return;
    let names: string[];
    try { names = readdirSync(this.directory); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      names = [];
    }
    for (const name of names) {
      if (!MARK_FILE.test(name)) continue;
      const value = JSON.parse(readFileSync(join(this.directory, name), "utf8")) as Partial<ProcessEscapeMark>;
      if (value.runId !== this.runId || typeof value.sessionId !== "string" || markFileName(value.sessionId) !== name
        || typeof value.value !== "string" || !/^[0-9a-f]{32}$/.test(value.value)
        || typeof value.issuedAt !== "string" || !Number.isFinite(Date.parse(value.issuedAt))) {
        throw new ManagedProcessError("process_cleanup_unverified", `Runner process mark ${name} is malformed.`);
      }
      this.cache.set(value.sessionId, Object.freeze(value as ProcessEscapeMark));
      // Issued by an earlier Runner process: whether it was swept since is unknown, so it is swept again.
      this.unswept.set(value.sessionId, ++this.launches);
    }
    this.loaded = true;
  }
}

function markFileName(sessionId: string): string {
  return `${createHash("sha256").update(sessionId, "utf8").digest("hex").slice(0, 32)}.json`;
}

/**
 * Sweeps the session's mark (or, with no session, every mark launched since its last settled sweep). Resolves only when
 * every swept mark settled with nothing left unended. A sweep that fails, or a marked process that is not proven
 * gone, throws `process_cleanup_unverified`, which leaves the owner's stop unproven (process-stop-proof.ts), so the
 * worktree claim is kept. Each report is recorded, the unreadable processes with it: they are never ended and do not
 * by themselves leave the stop unproven, because nothing attributes them to the owner.
 */
export async function sweepEscapedProcesses(
  marks: ProcessEscapeMarks,
  sweep: ProcessEscapeSweeper,
  scope: { readonly sessionId?: string },
  injectedFault?: WindowsEscapeSweepRequest["injectedFault"],
): Promise<void> {
  const failures: string[] = [];
  for (const mark of marks.pending(scope.sessionId)) {
    let report: WindowsEscapeSweepReport;
    try {
      report = await sweep({ markName: RUNNER_PROCESS_MARK_NAME, markValue: mark.value, since: new Date(mark.issuedAt), ...(injectedFault ? { injectedFault } : {}) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try { marks.record({ sessionId: mark.sessionId, error: message }); } catch { /* the throw below already fails closed */ }
      failures.push(`session ${mark.sessionId}: ${message}`);
      continue;
    }
    marks.record({ sessionId: mark.sessionId, ...report });
    if (report.settled && report.unended.length === 0) {
      marks.settled(mark);
      continue;
    }
    const left = report.unended.map((entry) => `${entry.image || "process"} (pid ${entry.pid}${entry.reason ? `, ${entry.reason}` : ""})`);
    failures.push(`session ${mark.sessionId}: ${left.length > 0 ? `a process it started outside the Job is not proven ended: ${left.join(", ")}` : `processes it started outside the Job kept appearing after ${report.rounds} snapshots`}`);
  }
  if (failures.length > 0) {
    throw new ManagedProcessError("process_cleanup_unverified", `Processes started outside the Runner's Job are not proven stopped (${failures.join("; ")}).`);
  }
}
