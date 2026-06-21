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
import { BuildRunStats } from "@/components/BuildRunStats";
import { BuildTranscriptPanel } from "@/components/BuildTranscriptPanel";
import { FinalAnswerCard } from "@/components/FinalAnswerCard";
import { BuildResultCard } from "@/components/BuildResultCard";
import { ArtifactPanel } from "@/components/ArtifactPanel";
import type { RunnerSelection } from "@/components/RunnerSetup";
import {
  DiscussionSessionSettings,
  type DiscussionSessionSettingsValue,
} from "@/components/DiscussionSessionSettings";
import { DiscussionAttachments } from "@/components/DiscussionAttachments";
import type { ExtractedFile } from "@/lib/artifacts/extract";
import { getBuildFiles } from "@/lib/client/store";
import {
  DiscussionDiagnostics,
  type DiagnosticEntry,
} from "@/components/DiscussionDiagnostics";
import type { AttachmentSummary } from "@/lib/attachments/types";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import type { BuildUsageWindow, Discussion } from "@/lib/db/schema";
import type { OrchestratorEvent } from "@/lib/orchestrator/engine";
import { getModelDisplayName } from "@/lib/providers/catalog";
import { getModelPricing } from "@/lib/providers/pricing";
import { getModeLabel } from "@/lib/orchestrator/config";
import {
  addBuildUsageCall,
  createBuildUsageWindow,
} from "@/lib/client/build-usage";
import {
  addBuildNote,
  continueDiscussion,
  ensureReady,
  getDiscussionData,
  loadDashboard,
  restartDiscussion,
  runDiscussion as runClientDiscussion,
  setDiscussionRunner,
  stopDiscussion,
  updateDiscussionConfig,
} from "@/lib/client/api";
import {
  getProjectHandle,
  queryProjectPermission,
  requestProjectPermission,
} from "@/lib/client/project-fs";
import { checkRunner } from "@/lib/client/runner";
import {
  BuildTaskBoard,
  type BuildTaskView,
  type CommandRunView,
  type WrittenFileView,
} from "@/components/BuildTaskBoard";
import {
  RepoWorkflowPanel,
  type RepoStatusView,
  type RepoDiffView,
  type RepoWorkflowView,
} from "@/components/RepoWorkflowPanel";
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

// Activity-log persistence is tab-session only by design: it survives
// navigating away and back, but closing the tab clears it (sessionStorage).
const ACTIVITY_LOG_CAP = 40;
const activityKey = (discussionId: string) => `activity-log:${discussionId}`;

function loadDiagnostics(discussionId: string): DiagnosticEntry[] {
  if (!discussionId || typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(activityKey(discussionId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as DiagnosticEntry[];
    return Array.isArray(parsed) ? parsed.slice(0, ACTIVITY_LOG_CAP) : [];
  } catch {
    return [];
  }
}

function saveDiagnostics(discussionId: string, entries: DiagnosticEntry[]) {
  if (!discussionId || typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      activityKey(discussionId),
      JSON.stringify(entries)
    );
  } catch {
    // quota exceeded / private mode — never break the page over a log cache.
  }
}

function clearDiagnostics(discussionId: string) {
  if (!discussionId || typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(activityKey(discussionId));
  } catch {
    // ignore
  }
}

function DiscussionPageInner() {
  const searchParams = useSearchParams();
  const id = searchParams.get("id") ?? "";
  const [discussion, setDiscussion] = useState<Discussion | null>(null);
  const [attachments, setAttachments] = useState<AttachmentSummary[]>([]);
  const [enabledModels, setEnabledModels] = useState<
    ReturnType<typeof loadDashboard>["enabledModels"]
  >([]);
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
  const [buildUsage, setBuildUsage] = useState<BuildUsageWindow | null>(null);
  const [writtenFiles, setWrittenFiles] = useState<WrittenFileView[]>([]);
  const [commandRuns, setCommandRuns] = useState<CommandRunView[]>([]);
  const [repoStatus, setRepoStatus] = useState<RepoStatusView | null>(null);
  const [repoDiff, setRepoDiff] = useState<RepoDiffView | null>(null);
  const [repoWorkflow, setRepoWorkflow] = useState<RepoWorkflowView | null>(null);
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
  const [persistedFiles, setPersistedFiles] = useState<ExtractedFile[]>([]);
  const [activeTab, setActiveTab] = useState("activity");
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
          icon: "/favicon.svg",
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
              background: event.background,
            },
          ]);
          break;
        case "repo_status":
          setRepoStatus(event.status);
          break;
        case "repo_diff":
          setRepoDiff(event.diff);
          break;
        case "repo_workflow":
          // Merge each milestone's non-null fields so issue/push/PR accumulate
          // across separate events (they land at different times).
          setRepoWorkflow((prev) => ({
            issue: event.issue ?? prev?.issue ?? null,
            issues: [
              ...new Set([...(prev?.issues ?? []), ...(event.issues ?? [])]),
            ],
            milestone: event.milestone ?? prev?.milestone ?? null,
            pushedBranch: event.pushedBranch ?? prev?.pushedBranch ?? null,
            prUrl: event.prUrl ?? prev?.prUrl ?? null,
          }));
          break;
        case "build_usage":
          setBuildUsage(event.usage);
          break;
        case "build_stopped":
          setBuildUsage(event.usage ?? null);
          setDiagnostics((prev) => {
            const next: DiagnosticEntry[] = [
              {
                id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                at: new Date().toLocaleTimeString(),
                phase: "finished" as const,
                message: event.message,
              },
              ...prev,
            ].slice(0, ACTIVITY_LOG_CAP);
            saveDiagnostics(id, next);
            return next;
          });
          break;
        case "tool_batch":
          setDiagnostics((prev) => {
            const next: DiagnosticEntry[] = [
              {
                id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                at: new Date().toLocaleTimeString(),
                phase: "model_streaming" as const,
                message: `${event.actor}: ${event.summary}`,
              },
              ...prev,
            ].slice(0, ACTIVITY_LOG_CAP);
            saveDiagnostics(id, next);
            return next;
          });
          break;
        case "token_usage":
          if (discussion?.mode === "build") {
            setBuildUsage((prev) => {
              const startedAt = prev?.startedAt ?? new Date().toISOString();
              const base = prev ?? createBuildUsageWindow(startedAt);
              const elapsedSinceWindowStartMs = Math.max(
                base.elapsedMs,
                Date.now() - new Date(startedAt).getTime()
              );
              let pricing: ReturnType<typeof getModelPricing> = null;
              try {
                pricing = getModelPricing(
                  event.modelId,
                  loadDashboard().settings.modelPricingOverrides
                );
              } catch {
                pricing = null;
              }
              return addBuildUsageCall(base, {
                modelId: event.modelId,
                modelName: event.modelName,
                providerId: event.providerId,
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
                pricing,
                elapsedSinceWindowStartMs,
              });
            });
            break;
          }
          setDiagnostics((prev) => {
            const entry: DiagnosticEntry = {
              id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
              at: new Date().toLocaleTimeString(),
              phase: "model_completed",
              message: `${event.modelName}: estimated ${event.totalTokens.toLocaleString()} tokens (${event.inputTokens.toLocaleString()} in / ${event.outputTokens.toLocaleString()} out)`,
              modelName: event.modelName,
              providerId: event.providerId,
              round: event.round,
              tokenUsage: {
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
                totalTokens: event.totalTokens,
                maxTokens: event.maxTokens,
                estimated: event.estimated,
              },
            };
            const next: DiagnosticEntry[] = [
              entry,
              ...prev,
            ].slice(0, ACTIVITY_LOG_CAP);
            saveDiagnostics(id, next);
            return next;
          });
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
            ].slice(0, ACTIVITY_LOG_CAP);
            saveDiagnostics(id, next);
            return next;
          });
          break;
      }
    },
    [id, discussion, notifyComplete, settleStreamingMessages]
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
      setEnabledModels(loadDashboard().enabledModels);
      setDiscussion(data.discussion);
      setBuildUsage(
        data.discussion.mode === "build"
          ? createBuildUsageWindow(new Date().toISOString())
          : null
      );
      // Restore the tab-session activity log so it survives navigation.
      setDiagnostics(loadDiagnostics(id));
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

  useEffect(() => {
    if (activeTab !== "settings" || status === "loading" || status === "locked") {
      return;
    }
    try {
      setEnabledModels(loadDashboard().enabledModels);
    } catch {
      // The encrypted store may still be locked.
    }
  }, [activeTab, status]);

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

  // Re-read the persisted build files whenever the run settles (or starts).
  // They're written to the store as the build goes; we only show the panel
  // for an unfinished build, so refresh when status flips and once on load.
  useEffect(() => {
    if (!discussion || discussion.mode !== "build") {
      setPersistedFiles([]);
      return;
    }
    const stored = getBuildFiles(discussion.id);
    setPersistedFiles(
      stored.map((f) => ({
        path: f.path,
        language: languageOf(f.path),
        content: f.content,
      }))
    );
  }, [discussion, status]);

  // Attach / replace / disconnect the runner between runs. Persist it and
  // mirror into local discussion state so the RunnerChip re-pings the new URL.
  const handleRunnerChange = useCallback(
    (sel: RunnerSelection | null) => {
      if (!discussion) return;
      setDiscussionRunner(discussion.id, sel);
      setDiscussion((prev) =>
        prev
          ? {
              ...prev,
              runnerUrl: sel?.url ?? null,
              runnerToken: sel?.token ?? null,
              runnerAccess: sel?.access ?? null,
            }
          : prev
      );
    },
    [discussion]
  );

  const handleSessionSettingsSave = useCallback(
    (value: DiscussionSessionSettingsValue) => {
      if (!discussion) return false;
      try {
        const updated = updateDiscussionConfig(discussion.id, value);
        setDiscussion(updated);
        const fresh = getDiscussionData(discussion.id);
        setModelNames(fresh?.modelNames ?? {});
        setError(null);
        return true;
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : "Couldn't save session settings";
        setError(message);
        return false;
      }
    },
    [discussion]
  );

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
    setBuildUsage(
      discussion?.mode === "build"
        ? createBuildUsageWindow(new Date().toISOString())
        : null
    );
    setWrittenFiles([]);
    setCommandRuns([]);
    setRepoStatus(null);
    setRepoDiff(null);
    setRepoWorkflow(null);
    setDiagnostics([]);
    clearDiagnostics(id);
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

  // Lead participants (Architect/Judge) that aren't among the
  // workers in modelIds — they'd otherwise never appear in the Team row even
  // though they're the most important models. Rendered as standalone chips,
  // role-labelled, before the workers. If a lead IS in participantIds (the
  // non-build judge case), it keeps its inline gavel and is skipped here.
  const leadChips = useMemo<
    Array<{ modelId: string; role: string }>
  >(() => {
    if (!discussion) return [];
    const leads: Array<{
      modelId: string;
      role: string;
    }> = [];
    const isBuild = discussion.mode === "build";
    if (
      discussion.judgeModelId &&
      !participantIds.includes(discussion.judgeModelId)
    ) {
      leads.push({
        modelId: discussion.judgeModelId,
        role: isBuild ? "Architect" : "Judge",
      });
    }
    return leads;
  }, [discussion, participantIds]);

  const activeModelNames = messages
    .filter((m) => m.streaming)
    .map((m) => m.modelName);
  const latestDiagnostic = diagnostics[0];
  const isActive = !ACTIVE_STATUSES.has(status);
  const liveActivity =
    activeModelNames.length > 0
      ? `Generating: ${activeModelNames.join(", ")}`
      : latestDiagnostic?.message ?? "Orchestrating…";

  // Locked store: without this the page would sit on the loading spinner
  // forever (discussion stays null until the store is unlocked).
  if (status === "locked") {
    return (
      <div className="mx-auto max-w-md rounded-xl border bg-card p-6 text-center shadow-sm">
        <h2 className="font-display text-xl font-semibold">Storage is locked</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Your data is encrypted. Open{" "}
          <a href="/settings?tab=storage" className="underline">
            Settings → Storage
          </a>{" "}
          and enter your passphrase, then return to this discussion.
        </p>
      </div>
    );
  }

  if (!discussion) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-primary" />
        <p className="mt-4 text-muted-foreground">Loading discussion…</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[100rem] pb-16 xl:grid xl:grid-cols-[380px_minmax(0,1fr)] xl:items-start xl:gap-6 xl:pb-0 2xl:grid-cols-[440px_minmax(0,1fr)]">
      {/* ── Activity log — left sidebar on wide screens (always open) ── */}
      <aside className="hidden xl:sticky xl:top-6 xl:block xl:self-start">
        <DiscussionDiagnostics
          entries={diagnostics}
          connected={streamConnected}
          active={isActive}
          variant="sidebar"
          roundLabel={discussion.mode === "build" ? "turn" : "round"}
          showEntryTokenUsage={discussion.mode !== "build"}
        />
      </aside>

      {/* ── Main column ─────────────────────────────────────────── */}
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
            {discussion.mode === "build" && (
              <RunnerChip
                url={discussion.runnerUrl ?? null}
                token={discussion.runnerToken ?? null}
                isActive={isActive}
                onManage={
                  !isActive && !streamConnected
                    ? () => {
                        setActiveTab("settings");
                      }
                    : undefined
                }
              />
            )}
          </div>

          {/* Topics range from a short question to a long build spec — scale
              the size down as it gets longer so an essay-length prompt doesn't
              dominate the page. */}
          <h1
            className={cnTopic(discussion.topic.length)}
            title={discussion.topic}
          >
            {discussion.topic}
          </h1>

          {(participantIds.length > 0 || leadChips.length > 0) && (
            <div className="mt-6 flex flex-wrap items-center gap-2">
              <span className="font-mono text-[0.7rem] uppercase tracking-[0.18em] text-muted-foreground">
                {discussion.mode === "build" ? "Team" : "Panel"}
              </span>
              {leadChips.map((lead) => (
                <span
                  key={lead.modelId}
                  className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 py-1 pl-1 pr-2.5"
                  title={`${lead.role}: ${modelNames[lead.modelId] ?? getModelDisplayName(lead.modelId)}`}
                >
                  <span
                    className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/15 text-primary"
                  >
                    <Gavel className="h-3 w-3" />
                  </span>
                  <span className="text-xs font-medium">
                    {modelNames[lead.modelId] ?? getModelDisplayName(lead.modelId)}
                  </span>
                  <span className="font-mono text-[0.6rem] uppercase tracking-wide text-muted-foreground">
                    {lead.role}
                  </span>
                </span>
              ))}
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
                  {discussion.mode === "build"
                    ? currentRound > 0
                      ? `Wave ${currentRound} / ${maxRounds}`
                      : "Preparing…"
                    : `Round ${Math.max(currentRound, 0)} / ${maxRounds}`}
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

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-5">
        <TabsList className="grid w-full max-w-md grid-cols-2">
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="settings">Session settings</TabsTrigger>
        </TabsList>

        <TabsContent value="activity" className="space-y-6">
      {discussion.mode === "build" && (
        <BuildRunStats
          status={status}
          policy={discussion.buildRunPolicy ?? "finish"}
          budgetUsd={discussion.buildBudgetUsd ?? 0}
          timeLimitMinutes={discussion.buildTimeLimitMinutes ?? 120}
          stopReason={discussion.buildStopReason}
          branch={repoWorkflow?.pushedBranch ?? repoStatus?.currentBranch ?? null}
          prUrl={repoWorkflow?.prUrl ?? null}
          usage={buildUsage}
        />
      )}

      {discussion.mode === "build" &&
        discussion.buildStopReason &&
        status === "stopped" && (
          <p className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
            {discussion.buildStopReason === "blocked"
              ? "Build stopped after repeated no-progress recovery attempts."
              : `Build stopped because the ${discussion.buildStopReason} guardrail was reached.`}{" "}
            Resume starts a fresh budget window and keeps the current checkpoint
            (task graph, files, and repo/GitHub refs).
          </p>
        )}

      {discussion.mode === "build" && (
        <BuildTaskBoard
          tasks={buildTasks}
          files={writtenFiles}
          commands={commandRuns}
          folderName={discussion.projectFolderName}
        />
      )}

      {discussion.mode === "build" && (
        <RepoWorkflowPanel status={repoStatus} diff={repoDiff} workflow={repoWorkflow} />
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

      {/* ── Files from an unfinished build ──────────────────────────
          No final result yet, the run isn't live, but earlier passes already
          produced files. Surface them so they aren't stranded — download them,
          or attach a runner in Session settings and Resume. */}
      {discussion.mode === "build" &&
        !finalResult &&
        !streamConnected &&
        persistedFiles.length > 0 && (
          <div className="space-y-3">
            <p className="rounded-lg border border-dashed bg-card/50 px-4 py-3 text-sm text-muted-foreground">
              Files produced so far — the build didn&apos;t finish. Download them
              or attach a runner in Session settings and Resume.
            </p>
            <ArtifactPanel files={persistedFiles} />
          </div>
        )}

      {/* ── Transcript ──────────────────────────────────────────── */}
      {discussion.mode === "build" ? (
        <BuildTranscriptPanel
          messages={messages}
          accentMap={accentMap}
          onDownload={downloadTranscript}
        />
      ) : (
      <div className="space-y-5">
        <div className="flex items-center gap-3">
          <h2 className="font-mono text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            {finalResult ? "Discussion transcript" : "Live discussion"}
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
        />
      </div>
      )}
        </TabsContent>

        <TabsContent value="settings">
          <DiscussionSessionSettings
            discussion={discussion}
            enabledModels={enabledModels}
            attachments={attachments}
            canEdit={!isActive && !streamConnected}
            onSave={handleSessionSettingsSave}
            onRunnerChange={handleRunnerChange}
          />
        </TabsContent>
      </Tabs>

      </div>

      {/* ── Activity log — fixed footer bar below xl (collapsed by default) ── */}
      <div className="xl:hidden">
        <DiscussionDiagnostics
          entries={diagnostics}
          connected={streamConnected}
          active={isActive}
          variant="footer"
          roundLabel={discussion.mode === "build" ? "turn" : "round"}
          showEntryTokenUsage={discussion.mode !== "build"}
        />
      </div>
    </div>
  );
}

function languageOf(path: string): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path);
  return ext ? ext[1].toLowerCase() : "";
}

function cnChip(bg: string, text: string): string {
  return `flex h-5 w-5 items-center justify-center rounded-full font-mono text-[0.6rem] font-bold ${bg} ${text}`;
}

/** Topic heading size: large for short titles, smaller for long build specs. */
function cnTopic(length: number): string {
  const base =
    "mt-4 max-w-4xl font-display font-semibold tracking-tight text-foreground";
  if (length > 280) {
    return `${base} text-lg leading-snug sm:text-xl`;
  }
  if (length > 120) {
    return `${base} text-xl leading-snug sm:text-2xl`;
  }
  return `${base} text-3xl leading-[1.15] sm:text-4xl`;
}

function MetaChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border bg-background/60 px-2.5 py-0.5 text-xs font-medium capitalize text-muted-foreground">
      {children}
    </span>
  );
}

type RunnerState =
  | { kind: "none" }
  | { kind: "checking" }
  | { kind: "reachable"; dir?: string }
  | { kind: "unreachable"; error?: string };

/**
 * Build-mode runner status: is a local runner attached, reachable, and what
 * folder does it point at? Pings /health and, while a run is active, re-checks
 * every 30s. The loud case is "unreachable while active" — the build will
 * silently fall back to in-app files, so the user needs to see it.
 */
function RunnerChip({
  url,
  token,
  isActive,
  onManage,
}: {
  url: string | null;
  token: string | null;
  isActive: boolean;
  onManage?: () => void;
}) {
  const configured = !!url && !!token;
  const [state, setState] = useState<RunnerState>(
    configured ? { kind: "checking" } : { kind: "none" }
  );

  useEffect(() => {
    if (!url || !token) {
      setState({ kind: "none" });
      return;
    }
    let cancelled = false;
    const ping = async () => {
      const res = await checkRunner({ url, token });
      if (cancelled) return;
      setState(
        res.ok
          ? { kind: "reachable", dir: res.dir }
          : { kind: "unreachable", error: res.error }
      );
    };
    ping();
    // Re-poll only while the run is live; a finished run's runner going offline
    // is normal and shouldn't trigger background fetches forever.
    const interval = isActive ? window.setInterval(ping, 30_000) : undefined;
    return () => {
      cancelled = true;
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [url, token, isActive]);

  const base =
    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium";
  const hint = onManage ? " — click to manage the runner connection" : "";
  // When onManage is provided, render as an interactive button (with a hover
  // affordance) so the chip itself is the way into the runner editor; otherwise
  // a plain, non-interactive span.
  const Chip = ({
    className,
    title,
    children,
  }: {
    className: string;
    title: string;
    children: React.ReactNode;
  }) =>
    onManage ? (
      <button
        type="button"
        onClick={onManage}
        className={`${className} hover:bg-accent/40 cursor-pointer transition-colors`}
        title={`${title}${hint}`}
      >
        {children}
      </button>
    ) : (
      <span className={className} title={title}>
        {children}
      </span>
    );
  const dot = (cls: string, pulse?: boolean) => (
    <span className="relative flex h-1.5 w-1.5">
      {pulse && (
        <span
          className={`absolute inline-flex h-full w-full animate-ping rounded-full ${cls} opacity-70`}
        />
      )}
      <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${cls}`} />
    </span>
  );

  if (state.kind === "none") {
    return (
      <Chip
        className={`${base} bg-background/60 text-muted-foreground`}
        title="No local runner was attached to this build — files stay in the app (and the browser-picked folder, if any). Attach a runner on the dashboard when creating a build."
      >
        {dot("bg-slate-400")}
        No runner
      </Chip>
    );
  }

  if (state.kind === "checking") {
    return (
      <Chip
        className={`${base} bg-background/60 text-muted-foreground`}
        title={`Checking the local runner at ${url}…`}
      >
        {dot("bg-slate-400", true)}
        Runner: checking…
      </Chip>
    );
  }

  if (state.kind === "reachable") {
    return (
      <Chip
        className={`${base} border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300`}
        title={`Local runner connected at ${url}${state.dir ? ` — ${state.dir}` : ""}`}
      >
        {dot("bg-emerald-500")}
        {/* dir is an absolute path — keep long ones from blowing up the chip */}
        <span className="max-w-[14rem] truncate">
          Runner: {state.dir ?? "connected"}
        </span>
      </Chip>
    );
  }

  // unreachable
  if (isActive) {
    return (
      <Chip
        className={`${base} border-amber-500/40 bg-amber-500/12 text-amber-700 dark:text-amber-300`}
        title={`Can't reach the runner at ${url}${state.error ? ` — ${state.error}` : ""}. This build will fall back to in-app files.`}
      >
        {dot("bg-amber-500", true)}
        Runner unreachable
      </Chip>
    );
  }
  return (
    <Chip
      className={`${base} bg-background/60 text-muted-foreground`}
      title={
        onManage
          ? `A local runner was attached at ${url}, but it isn't reachable now. If you restarted the runner it printed a NEW token — paste it here to reconnect and Resume.`
          : `A local runner was attached at ${url}, but it isn't reachable now. That's normal once a run has finished.`
      }
    >
      {dot("bg-slate-400")}
      {onManage ? "Runner offline — reconnect" : "Runner attached (offline now)"}
    </Chip>
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
