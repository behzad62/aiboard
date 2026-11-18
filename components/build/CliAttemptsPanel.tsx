"use client";

import { CheckCircle2, Clock3, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { CliAttemptView, CliLiveTail, CliRerunView } from "@/lib/client/cli-workers";
import { cn } from "@/lib/utils";

/** A running CLI's live tail, with the task it works on when the page knows it. */
export interface CliRunningTail extends CliLiveTail {
  name: string;
  taskTitle?: string;
}

function outcomeVariant(attempt: CliAttemptView): "success" | "warning" | "destructive" | "secondary" {
  if (!attempt.collected) return "warning";
  if (attempt.outcome === "done") return "success";
  if (attempt.outcome === "failure") return "destructive";
  if (attempt.outcome === "stopped") return "secondary";
  return "warning";
}

function Rerun({ rerun }: { rerun: CliRerunView }) {
  const Icon = rerun.passed ? CheckCircle2 : rerun.timedOut ? Clock3 : XCircle;
  return (
    <li className="flex min-w-0 items-start gap-1.5">
      <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", rerun.passed ? "text-success" : rerun.timedOut ? "text-warning" : "text-destructive")} aria-hidden="true" />
      <span className="min-w-0 break-words">
        {rerun.label}
        <span className="text-muted-foreground">
          {rerun.timedOut ? " · timed out" : rerun.exitCode === null ? "" : ` · exit ${rerun.exitCode}`}
        </span>
      </span>
    </li>
  );
}

function Tail({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <details className="rounded-md bg-muted/50" open={streaming}>
      <summary className="cursor-pointer select-none px-2 py-1 text-xs font-medium">
        {streaming ? "Live output" : "Last output"}
      </summary>
      {/* The tail is replaced on every delta, so a screen reader is not sent each one (aria-live off). */}
      <pre
        className="max-h-56 overflow-auto whitespace-pre-wrap break-words px-2 pb-2 font-mono text-[11px] leading-relaxed"
        aria-live="off"
      >
        {text || "Waiting for output…"}
      </pre>
    </details>
  );
}

/** One recorded CLI run: version, outcome, replaced commits and the Runner's re-runs of its checks. */
export function CliAttemptCard({ attempt, tail }: { attempt: CliAttemptView; tail?: CliLiveTail }) {
  const model = attempt.reportedModel ?? attempt.model ?? "CLI default";
  const facts: Array<[string, string]> = [
    ["Version", attempt.cliVersion ?? "not reported"],
    ["Model", attempt.reportedModel && attempt.model && attempt.reportedModel !== attempt.model ? `${attempt.model} (ran ${attempt.reportedModel})` : model],
    ["Outcome", attempt.outcomeLabel],
    ["Commits replaced", attempt.replacedCliCommits === undefined
      ? "not collected yet"
      : attempt.replacedCliCommits === 0
        ? "none"
        : `${attempt.replacedCliCommits}: the CLI committed; the Runner undid those commits and kept their changes for its own checked commit`],
  ];
  if (attempt.usage) facts.push(["Tokens", `${attempt.usage.inputTokens.toLocaleString()} in · ${attempt.usage.outputTokens.toLocaleString()} out (not billed by AI Board)`]);
  if (attempt.stoppedBy) facts.push(["Stopped by", attempt.stoppedBy === "deadline" ? "its time limit" : "a cancel"]);
  return (
    <article className="space-y-2 rounded-md border bg-background/40 p-3 text-xs" aria-label={`${attempt.name} on ${attempt.taskTitle ?? attempt.taskId}, attempt ${attempt.attempt}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{attempt.name}</span>
        <Badge variant={outcomeVariant(attempt)}>{attempt.collected ? attempt.outcomeLabel : "Not collected yet"}</Badge>
        <span className="text-muted-foreground">attempt {attempt.attempt}</span>
      </div>
      <p className="truncate text-muted-foreground" title={attempt.taskTitle ?? attempt.taskId}>
        {attempt.taskTitle ?? attempt.taskId}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {facts.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words">{value}</dd>
          </div>
        ))}
      </dl>
      {!attempt.collected && (
        <p className="rounded-md border border-warning/40 bg-warning-soft px-2 py-1">
          The CLI finished, but its programs could not be proven stopped yet, so nothing was collected.
          {attempt.stopFailure ? ` ${attempt.stopFailure}` : ""}
        </p>
      )}
      {attempt.collectedAfterStop && (
        <p className="text-muted-foreground">
          Collected after its programs were proven stopped.
        </p>
      )}
      {attempt.restoredProjectDocs.length > 0 && (
        <p>
          Restored {attempt.restoredProjectDocs.length} file{attempt.restoredProjectDocs.length === 1 ? "" : "s"} under docs/project the CLI changed:{" "}
          <span className="font-mono">{attempt.restoredProjectDocs.slice(0, 4).join(", ")}{attempt.restoredProjectDocs.length > 4 ? ", …" : ""}</span>
        </p>
      )}
      {attempt.projectChangedDuringAttempt.length > 0 && (
        <p className="text-warning">
          Your project folder changed while the CLI ran ({attempt.projectChangedDuringAttempt.join(", ")}). The Architect sees this.
        </p>
      )}
      {attempt.browser?.status === "start_failed" && (
        <p className="text-muted-foreground">No browser: {attempt.browser.reason ?? "its session did not start"}. Browser checks were not run.</p>
      )}
      <div className="space-y-1">
        <p className="font-medium">Re-runs of its checks</p>
        {attempt.reruns.length > 0 ? (
          <ul className="space-y-1">{attempt.reruns.map((rerun) => <Rerun key={rerun.id} rerun={rerun} />)}</ul>
        ) : (
          <p className="text-muted-foreground">
            {attempt.outcome === "done" && attempt.collected
              ? "None recorded yet. The Runner re-runs each check the CLI reports before its work counts."
              : "None: the Runner re-runs a CLI's checks only after it reports the task done."}
          </p>
        )}
      </div>
      {attempt.summary && (
        <details>
          <summary className="cursor-pointer select-none font-medium">The CLI&apos;s report (its claim)</summary>
          <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{attempt.summary}</p>
        </details>
      )}
      {tail && <Tail text={tail.text} streaming={tail.streaming} />}
    </article>
  );
}

/**
 * Run details → CLI workers (CW9): a card per running CLI with its live tail, then each recorded CLI run, newest
 * first. Nothing renders for a Build without CLI workers.
 */
export function CliAttemptsPanel({
  attempts,
  tails = [],
  limit = 6,
}: {
  attempts: CliAttemptView[];
  tails?: CliRunningTail[];
  limit?: number;
}) {
  // A run's tail is its own live turn (CLI_LIVE_TURN_BASE + its run number); a tail with no record yet is a CLI
  // still running, or one that finished moments ago.
  const tailKey = (sessionId: string, runNumber: number) => `${sessionId}\u0000${runNumber}`;
  const recordedRuns = new Set(attempts.map((attempt) => tailKey(attempt.sessionId, attempt.runNumber)));
  const running = tails.filter((tail) => tail.streaming || !recordedRuns.has(tailKey(tail.sessionId, tail.runNumber)));
  const settledTail = (attempt: CliAttemptView) =>
    tails.find((tail) => !tail.streaming && tail.sessionId === attempt.sessionId && tail.runNumber === attempt.runNumber);
  if (attempts.length === 0 && running.length === 0) return null;
  return (
    <section aria-labelledby="details-cli-title" className="space-y-2 text-sm">
      <h3 id="details-cli-title" className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        CLI workers
      </h3>
      {running.map((tail) => (
        <article key={`running:${tail.sessionId}:${tail.runNumber}`} className="space-y-2 rounded-md border bg-background/40 p-3 text-xs" aria-label={`${tail.name} running`}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{tail.name}</span>
            <Badge variant="secondary">{tail.streaming ? "Running" : "Finished"}</Badge>
          </div>
          {tail.taskTitle && <p className="truncate text-muted-foreground" title={tail.taskTitle}>{tail.taskTitle}</p>}
          <Tail text={tail.text} streaming={tail.streaming} />
        </article>
      ))}
      {attempts.slice(0, limit).map((attempt) => {
        const tail = settledTail(attempt);
        return <CliAttemptCard key={`${attempt.sequence}`} attempt={attempt} {...(tail ? { tail } : {})} />;
      })}
      {attempts.length > limit && (
        <p className="text-xs text-muted-foreground">{attempts.length - limit} earlier CLI runs are in the run audit.</p>
      )}
    </section>
  );
}
