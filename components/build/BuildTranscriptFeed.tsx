"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Download, ScrollText, Sparkles } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { cn } from "@/lib/utils";

export interface BuildFeedMessage {
  id: string;
  round: number;
  ordinal?: number;
  modelId: string;
  modelName: string;
  content: string;
  /** Live turns only: streamed reasoning / answer text / tool-call starts, in order. */
  segments?: Array<{ channel: "text" | "reasoning" | "tool"; text: string }>;
  streaming?: boolean;
}

export type BuildActorRole = "architect" | "worker" | "subagent" | "verifier" | "model";

export interface ActiveBuildActor {
  id: string;
  role: BuildActorRole;
  name: string;
}

export function buildActorRole(message: Pick<BuildFeedMessage, "modelName" | "modelId">): BuildActorRole {
  const name = message.modelName.toLowerCase();
  const id = message.modelId.toLowerCase();
  if (name.startsWith("architect") || id.includes(":architect:")) return "architect";
  if (name.startsWith("verifier") || id.includes(":verifier:")) return "verifier";
  if (name.startsWith("subagent") || id.includes(":subagent:")) return "subagent";
  if (name.startsWith("worker") || id.includes(":worker:")) return "worker";
  return "model";
}

export function sortedBuildFeed(messages: readonly BuildFeedMessage[]): BuildFeedMessage[] {
  return [...messages].sort((a, b) =>
    a.round - b.round || (a.ordinal ?? 0) - (b.ordinal ?? 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

const roleTone: Record<BuildActorRole, string> = {
  architect: "border-primary/30 bg-primary/10 text-primary",
  worker: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-300",
  subagent: "border-indigo-500/30 bg-indigo-500/10 text-indigo-600 dark:text-indigo-300",
  verifier: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  model: "border-border bg-muted text-muted-foreground",
};

/**
 * Role identity belongs to the timeline marker. The card heading is reserved
 * for the actual model/runtime name, not another copy of "Architect/Worker".
 */
export function buildModelDisplayName(
  message: Pick<BuildFeedMessage, "modelName" | "modelId">
): string {
  const role = buildActorRole(message);
  const name = message.modelName.trim();
  const separator = name.indexOf(" · ");
  if (separator >= 0) {
    const model = name.slice(separator + 3).trim();
    if (model) return model;
  }
  if (role !== "model") {
    const rolePrefix = new RegExp(`^${role}(?:\\s+|$)`, "i");
    const identifier = name.replace(rolePrefix, "").trim();
    return identifier || "Model output";
  }
  return name || "Model output";
}

/** Presentation only: retain verbatim text in the underlying transcript/export. */
export function buildDisplayText(content: string, role: BuildActorRole): string {
  if (role === "model") return content;
  // Only an explicit leading speaker label is redundant. Do not delete prose
  // that naturally begins with the word "architect", "worker", etc.
  const prefix = new RegExp(
    `^(\\s*)(?:\\*\\*)?${role}(?:\\s+\\d+)?(?:\\*\\*)?\\s*(?::|[—–])(?:\\*\\*)?\\s*`,
    "i"
  );
  const withoutLabel = content.replace(prefix, "$1");
  if (withoutLabel !== content) return withoutLabel;
  // Some models emit their role as a standalone Markdown heading.
  const standalone = new RegExp(
    `^(\\s*)(?:#{1,3}\\s+)?(?:\\*\\*)?${role}(?:\\*\\*)?\\s*\\r?\\n(?:\\r?\\n)?`,
    "i"
  );
  return content.replace(standalone, "$1");
}

const PAGE_SIZE = 25;
const FOLLOW_THRESHOLD_PX = 320;
/** Finished turns at most this long open by default; longer ones show a one-line preview. */
const AUTO_EXPAND_CHARS = 1_500;

export function BuildTranscriptFeed({
  messages,
  active,
  activeActors = [],
  onDownload,
}: {
  messages: BuildFeedMessage[];
  active: boolean;
  activeActors?: ActiveBuildActor[];
  onDownload: () => void;
}) {
  const sorted = useMemo(() => sortedBuildFeed(messages), [messages]);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [manualExpansion, setManualExpansion] = useState<Record<string, boolean>>({});
  const tailRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const visible = sorted.slice(-visibleCount);
  const hiddenCount = Math.max(0, sorted.length - visible.length);

  // "Following" is measured against the transcript's own tail, not the page end: panels below the
  // transcript and the sticky composer made the page-end distance exceed the threshold, so the feed
  // silently stopped following (tunnel run).
  useEffect(() => {
    const watchScroll = () => {
      const tail = tailRef.current;
      if (!tail) return;
      followRef.current = tail.getBoundingClientRect().top - window.innerHeight < FOLLOW_THRESHOLD_PX;
    };
    window.addEventListener("scroll", watchScroll, { passive: true });
    window.addEventListener("resize", watchScroll);
    return () => {
      window.removeEventListener("scroll", watchScroll);
      window.removeEventListener("resize", watchScroll);
    };
  }, []);

  const latest = sorted.at(-1);
  const latestSize = (latest?.content.length ?? 0) +
    (latest?.segments?.reduce((sum, segment) => sum + segment.text.length, 0) ?? 0);
  useEffect(() => {
    if (!active || !followRef.current || sorted.length === 0) return;
    const frame = requestAnimationFrame(() => tailRef.current?.scrollIntoView({ block: "end" }));
    return () => cancelAnimationFrame(frame);
  }, [active, latestSize, sorted.length]);

  return (
    <section aria-label="Build transcript" className="mx-auto w-full max-w-4xl">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b pb-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <ScrollText className="h-5 w-5 text-primary" aria-hidden="true" />
          <div>
            <h2 className="text-base font-semibold tracking-tight">Build transcript</h2>
            <p className="text-xs text-muted-foreground">
              Architect, workers and verifiers · {sorted.length} turn{sorted.length === 1 ? "" : "s"}
            </p>
          </div>
        </div>
        <button type="button" onClick={onDownload} disabled={!sorted.length}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
          title="Export all retained model turns as Markdown">
          <Download className="h-3.5 w-3.5" /> Export
        </button>
      </div>
      {sorted.length === 0 && activeActors.length === 0 ? (
        <div className="rounded-xl border border-dashed bg-card/30 px-6 py-14 text-center">
          <Sparkles className="mx-auto mb-3 h-7 w-7 text-primary/70" aria-hidden="true" />
          <h3 className="text-sm font-semibold">{active ? "Waiting for the first model turn" : "No transcript recorded yet"}</h3>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            {active ? "Model output will appear here as the build progresses." : "Start or resume a build to see the architect, workers and verifier together."}
          </p>
        </div>
      ) : (
        <div className="relative">
          {hiddenCount > 0 && (
            <button type="button" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
              className="mb-5 ml-8 rounded-md border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent">
              Show {Math.min(PAGE_SIZE, hiddenCount)} earlier turns
            </button>
          )}
          <ol className="space-y-1">
            {visible.map((message) => {
              const role = buildActorRole(message);
              const modelLabel = buildModelDisplayName(message);
              const displayContent = buildDisplayText(message.content, role);
              const displaySegments = message.segments?.map((segment) =>
                segment.channel === "text"
                  ? { ...segment, text: buildDisplayText(segment.text, role) }
                  : segment
              );
              // A fixed default per turn: the old "newest open, previous closed" rule reshuffled the
              // page whenever a new turn arrived.
              const expanded = manualExpansion[message.id] ??
                (Boolean(message.streaming) || message.content.length <= AUTO_EXPAND_CHARS);
              const preview = displayContent.trim().replace(/[#*_`>\[\]]/g, "").replace(/\s+/g, " ").slice(0, 200);
              return (
                <li key={message.id} className="relative pl-9 pb-4 before:absolute before:bottom-0 before:left-[11px] before:top-7 before:w-px before:bg-border/70 last:before:hidden">
                  <span className={cn("absolute left-0 top-2 flex h-6 w-6 items-center justify-center rounded-full border text-[10px] font-bold uppercase", roleTone[role])} title={role} aria-hidden="true">
                    {role === "architect" ? "A" : role === "verifier" ? "V" : role === "worker" ? "W" : role === "subagent" ? "S" : "M"}
                  </span>
                  <article className={cn("min-w-0 overflow-hidden rounded-xl border transition-colors", expanded ? "bg-card/70" : "border-transparent hover:border-border hover:bg-card/50")}>
                    <button type="button" aria-expanded={expanded} aria-controls={`build-turn-${message.id}`}
                      onClick={() => setManualExpansion((current) => ({ ...current, [message.id]: !expanded }))}
                      className="flex w-full items-start gap-2 px-3 py-3 text-left focus-visible:outline-2 focus-visible:outline-primary">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="sr-only">{role} turn: </span>
                          <span className="truncate text-sm font-medium" title={message.modelName}>{modelLabel}</span>
                          {message.streaming && <span className="text-xs font-medium text-primary motion-safe:animate-pulse">Streaming…</span>}
                        </div>
                        {!expanded && <p className="mt-1.5 truncate text-xs text-muted-foreground">{preview || "Model response"}</p>}
                      </div>
                      <ChevronDown className={cn("mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-180")} aria-hidden="true" />
                    </button>
                    {expanded && (
                      <div id={`build-turn-${message.id}`} className="min-w-0 border-t border-border/60 px-4 py-4 text-sm">
                        {message.streaming
                          ? <LiveTurnBody message={{ ...message, content: displayContent, segments: displaySegments }} />
                          : <Markdown content={displayContent} />}
                      </div>
                    )}
                  </article>
                </li>
              );
            })}
          </ol>
        </div>
      )}
      {activeActors.length > 0 && (
        <div className="mt-2 space-y-2 border-t pt-4" aria-label="Active model sessions">
          {activeActors.map((actor) => (
            <div key={actor.id} className="flex items-center gap-2 pl-2 text-sm text-muted-foreground">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary motion-safe:animate-pulse" aria-hidden="true" />
              <span className={cn("rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase", roleTone[actor.role])}>{actor.role}</span>
              <span className="min-w-0 truncate">{actor.name}</span>
              <span className="ml-auto shrink-0 text-xs">Working…</span>
            </div>
          ))}
        </div>
      )}
      {/* Scroll margin keeps the newest line above the sticky composer / Needs-you dock. */}
      <div ref={tailRef} aria-hidden="true" className="scroll-mb-56" />
    </section>
  );
}

/**
 * A streaming turn rendered like a coding-agent terminal: reasoning folds into one "Thinking" line
 * the owner can expand, tool calls are one-line entries, and only answer text shows in full.
 */
function LiveTurnBody({ message }: { message: BuildFeedMessage }) {
  const segments = message.segments?.length
    ? message.segments
    : message.content ? [{ channel: "text" as const, text: message.content }] : [];
  if (segments.length === 0) {
    return <p className="text-sm text-muted-foreground motion-safe:animate-pulse">Generating…</p>;
  }
  return (
    <div className="space-y-1.5">
      {segments.map((segment, index) => {
        const last = index === segments.length - 1;
        if (segment.channel === "reasoning") return <ReasoningLine key={index} text={segment.text} active={last} />;
        if (segment.channel === "tool") {
          return (
            <p key={index} className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
              <span aria-hidden="true">→</span> {segment.text}
            </p>
          );
        }
        return (
          <div key={index} className="whitespace-pre-wrap break-words leading-relaxed text-foreground/90">
            {segment.text}
            {last && <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-primary align-middle" aria-hidden="true" />}
          </div>
        );
      })}
    </div>
  );
}

function ReasoningLine({ text, active }: { text: string; active: boolean }) {
  const [open, setOpen] = useState(false);
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return (
    <div className="text-xs text-muted-foreground">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}
        className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-accent hover:text-foreground">
        <ChevronDown className={cn("h-3 w-3 transition-transform", !open && "-rotate-90")} aria-hidden="true" />
        <span className={cn(active && "motion-safe:animate-pulse")}>{active ? "Thinking…" : "Thought"}</span>
        <span className="tabular-nums">· {words} words</span>
      </button>
      {open && (
        <div className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md border-l-2 border-border bg-muted/30 px-3 py-2 italic leading-relaxed">
          {text}
        </div>
      )}
    </div>
  );
}
