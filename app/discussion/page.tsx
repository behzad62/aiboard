"use client";

import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  Suspense,
} from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  DiscussionTimeline,
  type TimelineMessage,
} from "@/components/DiscussionTimeline";
import { FinalAnswerCard } from "@/components/FinalAnswerCard";
import { BuildResultCard } from "@/components/BuildResultCard";
import { DiscussionAttachments } from "@/components/DiscussionAttachments";
import {
  DiscussionDiagnostics,
  type DiagnosticEntry,
} from "@/components/DiscussionDiagnostics";
import type { AttachmentSummary } from "@/lib/attachments/types";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  Bell,
  Download,
  Gavel,
  Play,
  RotateCcw,
  Square,
  StickyNote,
} from "lucide-react";
import type { Discussion } from "@/lib/db/schema";
import type { OrchestratorEvent } from "@/lib/orchestrator/engine";
import { getModelDisplayName } from "@/lib/providers/catalog";
import { getModeLabel } from "@/lib/orchestrator/config";
import {
  addBuildNote,
  continueDiscussion,
  ensureReady,
  getDiscussionData,
  restartDiscussion,
  runDiscussion as runClientDiscussion,
  stopDiscussion,
} from "@/lib/client/api";
import {
  getProjectHandle,
  queryProjectPermission,
  requestProjectPermission,
} from "@/lib/client/project-fs";
import {
  BuildTaskBoard,
  type BuildTaskView,
  type CommandRunView,
  type WrittenFileView,
} from "@/components/BuildTaskBoard";
import type { CommandApprovalDecision } from "@/lib/client/build-engine";
import {
  accentFor,
  buildAccentMap,
  modelMonogram,
} from "@/lib/ui/model-accent";
import { downloadMarkdown, fileSlug } from "@/lib/ui/download";

interface DiscussionData {
  discussion: Discussion;
  messages: Array<{
    id: string;
    round: number;
    modelId: string;
    content: string;
  }>;
  attachments: AttachmentSummary[];
  modelNames?: Record<string, string>;
  finalResult: {
    answer: string;
    confidence: number;
    dissent: string[];
  } | null;
}

const ACTIVE_STATUSES = new Set(["completed", "failed", "stopped"]);

function DiscussionPageInner() {
  const searchParams = useSearchParams();
  const id = searchParams.get("id") ?? "";
  const [discussion, setDiscussion] = useState<Discussion | null>(null);
  const [attachments, setAttachments] = useState<AttachmentSummary[]>([]);
  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  const [messages, setMessages] = useState<TimelineMessage[]>([]);
  const [finalResult, setFinalResult] =
    useState<DiscussionData["finalResult"]>(null);
  const [currentRound, setCurrentRound] = useState(0);
  const [maxRounds, setMaxRounds] = useState(4);
  const [convergenceScore, setConvergenceScore] = useState<number | null>(null);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticEntry[]>([]);
  const [streamConnected, setStreamConnected] = useState(false);
  const [buildTasks, setBuildTasks] = useState<BuildTaskView[]>([]);
  const [writtenFiles, setWrittenFiles] = useState<WrittenFileView[]>([]);
  const [commandRuns, setCommandRuns] = useState<CommandRunView[]>([]);
  const [pendingApproval, setPendingApproval] = useState<{
    command: string;
    reason?: string;
    resolve: (decision: CommandApprovalDecision) => void;
  } | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [folderGrant, setFolderGrant] = useState<"checking" | "needed" | "ready">(
    "checking"
  );
  const [folderHandle, setFolderHandle] =
    useState<FileSystemDirectoryHandle | null>(null);
  const notifiedRef = useRef(false);
  const streamingRef = useRef<Map<string, string>>(new Map());

  const requestNotificationPermission = useCallback(async () => {
    if (typeof window !== "undefined" && "Notification" in window) {
      if (Notification.permission === "default") {
        await Notification.requestPermission();
      }
    }
  }, []);

  const notifyComplete = useCallback((topic: string) => {
    if (notifiedRef.current) return;
    notifiedRef.current = true;
    if (typeof window !== "undefined" && "Notification" in window) {
      if (Notification.permission === "granted") {
        new Notification("Discussion complete", {
          body: `Best answer ready: ${topic.slice(0, 80)}${topic.length > 80 ? "..." : ""}`,
          icon: "/favicon.ico",
        });
      }
    }
  }, []);

  // A model that errors (or a stopped run) leaves message cards stuck in
  // their "Streaming…" state — settle them so the UI doesn't pulse forever.
  const settleStreamingMessages = useCallback(() => {
    streamingRef.current.clear();
    setMessages((prev) =>
      prev.some((m) => m.streaming)
        ? prev.map((m) => (m.streaming ? { ...m, streaming: false } : m))
        : prev
    );
  }, []);

  const handleEvent = useCallback(
    (event: OrchestratorEvent) => {
      switch (event.type) {
        case "status":
          setStatus(event.status);
          if (event.round !== undefined) setCurrentRound(event.round);
          if (event.maxRounds !== undefined) setMaxRounds(event.maxRounds);
          if (
            event.status === "completed" ||
            event.status === "failed" ||
            event.status === "stopped"
          ) {
            settleStreamingMessages();
          }
          break;
        case "message_start":
          streamingRef.current.set(event.messageId, "");
          setMessages((prev) => [
            ...prev.filter((m) => m.id !== event.messageId),
            {
              id: event.messageId,
              round: event.round,
              modelId: event.modelId,
              modelName: event.modelName,
              content: "",
              streaming: true,
            },
          ]);
          break;
        case "message_token": {
          const current =
            (streamingRef.current.get(event.messageId) ?? "") + event.token;
          streamingRef.current.set(event.messageId, current);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === event.messageId
                ? { ...m, content: current, streaming: true }
                : m
            )
          );
          break;
        }
        case "message_complete":
          streamingRef.current.delete(event.messageId);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === event.messageId
                ? { ...m, content: event.content, streaming: false }
                : m
            )
          );
          break;
        case "convergence":
          setConvergenceScore(event.score);
          break;
        case "build_plan":
          setBuildTasks(
            event.tasks.map((t) => ({
              id: t.id,
              title: t.title,
              status: t.status as BuildTaskView["status"],
            }))
          );
          break;
        case "task_status":
          setBuildTasks((prev) => {
            const idx = prev.findIndex((t) => t.id === event.taskId);
            const next: BuildTaskView = {
              id: event.taskId,
              title: event.title,
              status: event.status,
              worker: event.worker ?? (idx >= 0 ? prev[idx].worker : undefined),
            };
            if (idx >= 0) {
              const copy = [...prev];
              copy[idx] = next;
              return copy;
            }
            return [...prev, next];
          });
          break;
        case "file_written":
          setWrittenFiles((prev) => {
            const others = prev.filter((f) => f.path !== event.path);
            return [
              ...others,
              { path: event.path, bytes: event.bytes, location: event.location },
            ];
          });
          break;
        case "command_run":
          setCommandRuns((prev) => [
            ...prev,
            {
              command: event.command,
              exitCode: event.exitCode,
              durationMs: event.durationMs,
              outputPreview: event.outputPreview,
              denied: event.denied,
            },
          ]);
          break;
        case "final_answer":
          setFinalResult({
            answer: event.answer,
            confidence: event.confidence,
            dissent: event.dissent,
          });
          setStatus("completed");
          if (discussion) notifyComplete(discussion.topic);
          break;
        case "complete":
          setStatus("completed");
          break;
        case "error":
          setError(event.message);
          setStatus("failed");
          settleStreamingMessages();
          break;
        case "diagnostic":
          setDiagnostics((prev) => {
            const next: DiagnosticEntry[] = [
              {
                id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                at: new Date().toLocaleTimeString(),
                phase: event.phase,
                message: event.message,
                modelName: event.modelName,
                providerId: event.providerId,
                round: event.round,
              },
              ...prev,
            ];
            return next.slice(0, 40);
          });
          break;
      }
    },
    [discussion, notifyComplete, settleStreamingMessages]
  );

  useEffect(() => {
    requestNotificationPermission();

    (async () => {
      const { needsPassphrase } = await ensureReady();
      if (needsPassphrase) {
        setStatus("locked");
        return;
      }
      const data = getDiscussionData(id);
      if (!data) {
        setStatus("not_found");
        return;
      }
      setDiscussion(data.discussion);
      setAttachments(data.attachments ?? []);
      setModelNames(data.modelNames ?? {});
      setCurrentRound(data.discussion.currentRound);
      setMaxRounds(data.discussion.maxRounds);
      setConvergenceScore(data.discussion.convergenceScore);
      setStatus(data.discussion.status);
      setMessages(
        data.messages.map((m) => ({
          id: m.id,
          round: m.round,
          modelId: m.modelId,
          modelName:
            m.modelId === "user"
              ? "Your note"
              : data.modelNames?.[m.modelId] ?? getModelDisplayName(m.modelId),
          content: m.content,
        }))
      );
      setFinalResult(data.finalResult);
      if (data.discussion.status === "completed" && data.finalResult) {
        notifyComplete(data.discussion.topic);
      }
    })();
  }, [id, requestNotificationPermission, notifyComplete]);

  // Build mode with a stored project folder needs a permission check before
  // the run starts (re-granting requires a user gesture, so we gate on a button).
  useEffect(() => {
    if (!discussion) return;
    if (discussion.mode !== "build") {
      setFolderGrant("ready");
      return;
    }
    (async () => {
      const handle = await getProjectHandle(discussion.id);
      if (!handle) {
        setFolderGrant("ready");
        return;
      }
      setFolderHandle(handle);
      setFolderGrant((await queryProjectPermission(handle)) ? "ready" : "needed");
    })();
  }, [discussion]);

  const grantFolderAccess = async () => {
    if (!folderHandle) return;
    if (await requestProjectPermission(folderHandle)) {
      setFolderGrant("ready");
    }
  };

  // Build-mode command approval: the engine awaits this promise; the UI resolves
  // it when the user clicks Allow / Allow all / Deny.
  const requestCommandApproval = (
    command: string,
    reason?: string
  ): Promise<CommandApprovalDecision> =>
    new Promise((resolve) => {
      setPendingApproval({
        command,
        reason,
        resolve: (decision) => {
          setPendingApproval(null);
          resolve(decision);
        },
      });
    });

  // Keep the run callback fresh without restarting the run.
  const handleEventRef = useRef(handleEvent);
  handleEventRef.current = handleEvent;
  const startedRef = useRef(false);

  useEffect(() => {
    if (!id || !discussion || startedRef.current) return;
    if (
      status === "completed" ||
      status === "failed" ||
      status === "stopped" ||
      status === "locked"
    )
      return;
    if (folderGrant !== "ready") return;

    // The engine runs entirely in this tab; events update state directly.
    startedRef.current = true;
    setStreamConnected(true);
    runClientDiscussion(
      id,
      (event) => handleEventRef.current(event),
      { requestCommandApproval }
    ).finally(() => setStreamConnected(false));
  }, [id, discussion, status, folderGrant]);

  // Stop: abort the engine (it winds down at the next streamed token). If a
  // command approval is pending, deny it so the engine isn't stuck awaiting.
  const handleStop = () => {
    pendingApproval?.resolve("deny");
    stopDiscussion(id);
  };

  // Restart: wipe the previous run's output and re-queue; the run effect
  // picks the discussion up again as soon as status returns to "pending".
  const handleRestart = () => {
    try {
      restartDiscussion(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't restart");
      return;
    }
    streamingRef.current.clear();
    notifiedRef.current = false;
    // The store keeps user notes through a restart — reload what's left.
    setMessages(
      (getDiscussionData(id)?.messages ?? []).map((m) => ({
        id: m.id,
        round: m.round,
        modelId: m.modelId,
        modelName:
          m.modelId === "user"
            ? "Your note"
            : modelNames[m.modelId] ?? getModelDisplayName(m.modelId),
        content: m.content,
      }))
    );
    setFinalResult(null);
    setError(null);
    setBuildTasks([]);
    setWrittenFiles([]);
    setCommandRuns([]);
    setDiagnostics([]);
    setConvergenceScore(null);
    setCurrentRound(0);
    startedRef.current = false;
    setStatus("pending");
  };

  // Resume: keep everything already generated and continue from the failure
  // point. The engine skips rounds/models that already have saved responses
  // (so a judge-stage network error resumes straight at the judge); a build
  // re-plans over the kept transcript and the files already on disk.
  const handleResume = () => {
    continueDiscussion(id);
    notifiedRef.current = false;
    setError(null);
    setFinalResult(null);
    startedRef.current = false;
    setStatus("pending");
  };

  // Send a note to the Architect: queued for its next plan/review/summary
  // turn. If the build already finished (or stopped/failed), kick off a
  // follow-up pass so the note actually gets acted on.
  const submitNote = () => {
    const note = noteDraft.trim();
    if (!note) return;
    let saved: { id: string; round: number };
    try {
      saved = addBuildNote(id, note);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add the note");
      return;
    }
    setNoteDraft("");
    setMessages((prev) => [
      ...prev,
      {
        id: saved.id,
        round: saved.round,
        modelId: "user",
        modelName: "Your note",
        content: note,
      },
    ]);
    if (status === "completed" || status === "stopped" || status === "failed") {
      continueDiscussion(id);
      notifiedRef.current = false;
      setFinalResult(null);
      setError(null);
      startedRef.current = false;
      setStatus("pending");
    }
  };

  // Export the whole conversation — meta, every round's responses, and the
  // final answer — as one Markdown file.
  const downloadTranscript = () => {
    if (!discussion) return;
    const nameOf = (modelId: string) =>
      modelId === "user"
        ? "Your note"
        : modelNames[modelId] ?? getModelDisplayName(modelId);

    const lines: string[] = [`# ${discussion.topic}`, ""];
    lines.push(`- **Mode:** ${getModeLabel(discussion.mode)}`);
    lines.push(`- **Effort:** ${discussion.effort}`);
    lines.push(
      `- **Date:** ${new Date(discussion.createdAt).toLocaleString()}`
    );
    try {
      const ids = JSON.parse(discussion.modelIds) as string[];
      lines.push(`- **Participants:** ${ids.map(nameOf).join(", ")}`);
    } catch {
      // unreadable participant list — leave it out of the export
    }
    if (discussion.judgeModelId) {
      lines.push(
        `- **${discussion.mode === "build" ? "Architect" : "Judge"}:** ${nameOf(discussion.judgeModelId)}`
      );
    }

    let lastRound: number | null = null;
    for (const msg of [...messages].sort((a, b) => a.round - b.round)) {
      if (!msg.content || msg.streaming) continue;
      if (msg.round !== lastRound) {
        lastRound = msg.round;
        lines.push("", `## Round ${msg.round}`);
      }
      lines.push("", `### ${msg.modelName}`, "", msg.content);
    }

    if (finalResult) {
      lines.push(
        "",
        `## Final answer (confidence ${finalResult.confidence}/10)`,
        "",
        finalResult.answer
      );
      if (finalResult.dissent.length > 0) {
        lines.push(
          "",
          "### Remaining disagreements",
          "",
          ...finalResult.dissent.map((d) => `- ${d}`)
        );
      }
    }

    downloadMarkdown(
      `${fileSlug(discussion.topic)}-transcript.md`,
      `${lines.join("\n")}\n`
    );
  };

  const participantIds = useMemo<string[]>(() => {
    if (!discussion) return [];
    try {
      return JSON.parse(discussion.modelIds) as string[];
    } catch {
      return [];
    }
  }, [discussion]);

  const accentMap = useMemo(
    () => buildAccentMap(participantIds),
    [participantIds]
  );

  const activeModelNames = messages
    .filter((m) => m.streaming)
    .map((m) => m.modelName);
  const latestDiagnostic = diagnostics[0];
  const isActive = !ACTIVE_STATUSES.has(status);
  const liveActivity =
    activeModelNames.length > 0
      ? `Generating: ${activeModelNames.join(", ")}`
      : latestDiagnostic?.message ?? "Orchestrating…";

  if (!discussion) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-primary" />
        <p className="mt-4 text-muted-foreground">Loading discussion…</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── Hero ────────────────────────────────────────────────── */}
      <header className="relative overflow-hidden rounded-2xl border bg-card shadow-sm">
        <div
          className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-indigo-500 via-violet-500 to-amber-500"
          aria-hidden
        />
        <div className="p-6 sm:p-8">
          <div className="flex items-start justify-between gap-4">
            <Link
              href="/"
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to dashboard
            </Link>
            <div className="flex flex-wrap items-center gap-2">
              {isActive && streamConnected && (
                <Button variant="destructive" size="sm" onClick={handleStop}>
                  <Square className="mr-1 h-3.5 w-3.5" />
                  Stop
                </Button>
              )}
              {(status === "stopped" || status === "failed") &&
                !streamConnected && (
                  <>
                    <Button
                      size="sm"
                      onClick={handleResume}
                      title="Continue from where the run failed — already-generated responses are kept"
                    >
                      <Play className="mr-1 h-3.5 w-3.5" />
                      Resume
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleRestart}
                      title="Start over from scratch — wipes the previous run's output"
                    >
                      <RotateCcw className="mr-1 h-3.5 w-3.5" />
                      Restart
                    </Button>
                  </>
                )}
              <Button
                variant="outline"
                size="sm"
                onClick={requestNotificationPermission}
              >
                <Bell className="mr-1 h-4 w-4" />
                Notify me
              </Button>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <StatusPill status={status} />
            <MetaChip>{getModeLabel(discussion.mode)}</MetaChip>
            <MetaChip>{discussion.effort} effort</MetaChip>
            {convergenceScore != null && (
              <MetaChip>Convergence {convergenceScore.toFixed(1)}/10</MetaChip>
            )}
          </div>

          <h1 className="mt-4 max-w-4xl font-display text-3xl font-semibold leading-[1.15] tracking-tight text-foreground sm:text-4xl">
            {discussion.topic}
          </h1>

          {participantIds.length > 0 && (
            <div className="mt-6 flex flex-wrap items-center gap-2">
              <span className="font-mono text-[0.7rem] uppercase tracking-[0.18em] text-muted-foreground">
                {discussion.mode === "build" ? "Team" : "Panel"}
              </span>
              {participantIds.map((modelId) => {
                const accent = accentFor(accentMap, modelId);
                const isJudge = discussion.judgeModelId === modelId;
                return (
                  <span
                    key={modelId}
                    className="inline-flex items-center gap-1.5 rounded-full border bg-background/70 py-1 pl-1 pr-2.5"
                    title={isJudge ? "Final judge" : undefined}
                  >
                    <span
                      className={cnChip(accent.chipBg, accent.text)}
                    >
                      {modelMonogram(modelId)}
                    </span>
                    <span className="text-xs font-medium">
                      {modelNames[modelId] ?? getModelDisplayName(modelId)}
                    </span>
                    {isJudge && (
                      <Gavel className="h-3 w-3 text-muted-foreground" />
                    )}
                  </span>
                );
              })}
            </div>
          )}

          {isActive && (
            <div className="mt-6 space-y-2">
              <div className="flex items-center justify-between gap-3 font-mono text-[0.7rem] text-muted-foreground">
                <span>
                  Round {Math.max(currentRound, 0)} / {maxRounds}
                </span>
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <span className="relative flex h-1.5 w-1.5 shrink-0">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
                  </span>
                  <span className="truncate">{liveActivity}</span>
                </span>
              </div>
              <ProgressBar value={currentRound} max={maxRounds} />
            </div>
          )}
        </div>
      </header>

      {error && (
        <div className="rounded-xl border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      )}

      {folderGrant === "needed" &&
        status !== "completed" &&
        status !== "failed" && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950/30">
            <p className="text-amber-900 dark:text-amber-100">
              This build writes into the folder{" "}
              <strong>{folderHandle?.name}</strong>. The browser needs you to
              re-grant access before the run can start.
            </p>
            <div className="flex gap-2">
              <Button size="sm" onClick={grantFolderAccess}>
                Grant folder access
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setFolderGrant("ready")}
              >
                Continue without folder
              </Button>
            </div>
          </div>
        )}

      {pendingApproval && (
        <div className="rounded-xl border border-primary/40 bg-primary/5 p-4">
          <p className="text-sm font-medium">The Architect wants to run a command</p>
          {pendingApproval.reason && (
            <p className="mt-1 text-sm text-muted-foreground">
              {pendingApproval.reason}
            </p>
          )}
          <pre className="mt-2 overflow-x-auto rounded bg-background/80 p-2 font-mono text-xs">
            $ {pendingApproval.command}
          </pre>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => pendingApproval.resolve("allow")}>
              Allow once
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => pendingApproval.resolve("allow-all")}
            >
              Allow all this run
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => pendingApproval.resolve("deny")}
            >
              Deny
            </Button>
          </div>
        </div>
      )}

      {discussion.mode === "build" && (
        <BuildTaskBoard
          tasks={buildTasks}
          files={writtenFiles}
          commands={commandRuns}
          folderName={discussion.projectFolderName}
        />
      )}

      {discussion.mode === "build" &&
        status !== "loading" &&
        status !== "locked" &&
        status !== "not_found" && (
          <div className="rounded-xl border bg-card p-4 shadow-sm">
            <div className="flex items-center gap-2">
              <StickyNote className="h-4 w-4 text-muted-foreground" />
              <p className="text-sm font-medium">Note to the Architect</p>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {isActive
                ? "Picked up at the Architect's next planning or review step — use it to steer the build while it runs."
                : "The build is finished — sending a note starts a follow-up pass in which the Architect addresses it."}
            </p>
            <div className="mt-2 flex items-end gap-2">
              <textarea
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    submitNote();
                  }
                }}
                rows={2}
                placeholder="e.g. Use Postgres instead of SQLite, and add a dark-mode toggle…"
                className="flex-1 resize-y rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <Button size="sm" onClick={submitNote} disabled={!noteDraft.trim()}>
                Send note
              </Button>
            </div>
          </div>
        )}

      <DiscussionAttachments attachments={attachments} />

      {/* ── Result first when ready ─────────────────────────────── */}
      {finalResult &&
        (discussion.mode === "build" ? (
          <BuildResultCard
            answer={finalResult.answer}
            confidence={finalResult.confidence}
            dissent={finalResult.dissent}
            topic={discussion.topic}
            discussionId={discussion.id}
          />
        ) : (
          <FinalAnswerCard
            answer={finalResult.answer}
            confidence={finalResult.confidence}
            dissent={finalResult.dissent}
            topic={discussion.topic}
          />
        ))}

      {/* ── Transcript ──────────────────────────────────────────── */}
      <div className="space-y-5">
        <div className="flex items-center gap-3">
          <h2 className="font-mono text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            {discussion.mode === "build"
              ? finalResult
                ? "Build log"
                : "Live build"
              : finalResult
                ? "Discussion transcript"
                : "Live discussion"}
          </h2>
          <span className="h-px flex-1 bg-gradient-to-r from-border to-transparent" />
          {messages.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={downloadTranscript}
              title="Download the whole conversation as one Markdown file"
            >
              <Download className="mr-1 h-3.5 w-3.5" />
              Download .md
            </Button>
          )}
        </div>
        <DiscussionTimeline
          messages={messages}
          accentMap={accentMap}
          emptyTitle={
            discussion.mode === "build" ? "The build is starting…" : undefined
          }
          emptyHint={
            discussion.mode === "build"
              ? "The Architect is planning; tasks and files will appear in the board above and responses stream here."
              : undefined
          }
        />
      </div>

      {/* ── Diagnostics, tucked away ────────────────────────────── */}
      <DiscussionDiagnostics
        entries={diagnostics}
        connected={streamConnected}
        active={isActive}
      />
    </div>
  );
}

function cnChip(bg: string, text: string): string {
  return `flex h-5 w-5 items-center justify-center rounded-full font-mono text-[0.6rem] font-bold ${bg} ${text}`;
}

function MetaChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border bg-background/60 px-2.5 py-0.5 text-xs font-medium capitalize text-muted-foreground">
      {children}
    </span>
  );
}

function ProgressBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500 transition-[width] duration-500 ease-out"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const meta = statusMeta(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${meta.bg} ${meta.text}`}
    >
      <span className="relative flex h-1.5 w-1.5">
        {meta.pulse && (
          <span
            className={`absolute inline-flex h-full w-full animate-ping rounded-full ${meta.dot} opacity-70`}
          />
        )}
        <span
          className={`relative inline-flex h-1.5 w-1.5 rounded-full ${meta.dot}`}
        />
      </span>
      {meta.label}
    </span>
  );
}

function statusMeta(status: string): {
  label: string;
  bg: string;
  text: string;
  dot: string;
  pulse: boolean;
} {
  switch (status) {
    case "completed":
      return {
        label: "Completed",
        bg: "bg-emerald-500/12",
        text: "text-emerald-700 dark:text-emerald-300",
        dot: "bg-emerald-500",
        pulse: false,
      };
    case "stopped":
      return {
        label: "Stopped",
        bg: "bg-orange-500/12",
        text: "text-orange-700 dark:text-orange-300",
        dot: "bg-orange-500",
        pulse: false,
      };
    case "failed":
      return {
        label: "Failed",
        bg: "bg-rose-500/12",
        text: "text-rose-700 dark:text-rose-300",
        dot: "bg-rose-500",
        pulse: false,
      };
    case "judging":
      return {
        label: "Synthesizing verdict",
        bg: "bg-violet-500/12",
        text: "text-violet-700 dark:text-violet-300",
        dot: "bg-violet-500",
        pulse: true,
      };
    case "stagnation_detected":
      return {
        label: "Converged early",
        bg: "bg-sky-500/12",
        text: "text-sky-700 dark:text-sky-300",
        dot: "bg-sky-500",
        pulse: true,
      };
    case "running":
      return {
        label: "In discussion",
        bg: "bg-amber-500/12",
        text: "text-amber-700 dark:text-amber-300",
        dot: "bg-amber-500",
        pulse: true,
      };
    default:
      return {
        label: "Starting",
        bg: "bg-slate-500/12",
        text: "text-slate-600 dark:text-slate-300",
        dot: "bg-slate-400",
        pulse: true,
      };
  }
}

export default function DiscussionPage() {
  return (
    <Suspense>
      <DiscussionPageInner />
    </Suspense>
  );
}
