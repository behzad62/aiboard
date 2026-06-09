"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { DiscussionTimeline, type TimelineMessage } from "@/components/DiscussionTimeline";
import { FinalAnswerCard } from "@/components/FinalAnswerCard";
import { DiscussionAttachments } from "@/components/DiscussionAttachments";
import type { AttachmentSummary } from "@/lib/attachments/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Bell } from "lucide-react";
import type { Discussion } from "@/lib/db/schema";
import type { OrchestratorEvent } from "@/lib/orchestrator/engine";
import { getModelDisplayName } from "@/lib/providers/model-names";

interface DiscussionData {
  discussion: Discussion;
  messages: Array<{
    id: string;
    round: number;
    modelId: string;
    content: string;
  }>;
  attachments: AttachmentSummary[];
  finalResult: {
    answer: string;
    confidence: number;
    dissent: string[];
  } | null;
}

export default function DiscussionPage() {
  const params = useParams();
  const id = params.id as string;
  const [discussion, setDiscussion] = useState<Discussion | null>(null);
  const [attachments, setAttachments] = useState<AttachmentSummary[]>([]);
  const [messages, setMessages] = useState<TimelineMessage[]>([]);
  const [finalResult, setFinalResult] = useState<DiscussionData["finalResult"]>(null);
  const [currentRound, setCurrentRound] = useState(0);
  const [maxRounds, setMaxRounds] = useState(4);
  const [convergenceScore, setConvergenceScore] = useState<number | null>(null);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState<string | null>(null);
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

  const handleEvent = useCallback(
    (event: OrchestratorEvent) => {
      switch (event.type) {
        case "status":
          setStatus(event.status);
          if (event.round !== undefined) setCurrentRound(event.round);
          if (event.maxRounds !== undefined) setMaxRounds(event.maxRounds);
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
          const current = (streamingRef.current.get(event.messageId) ?? "") + event.token;
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
          break;
      }
    },
    [discussion, notifyComplete]
  );

  useEffect(() => {
    requestNotificationPermission();

    fetch(`/api/discussions/${id}`)
      .then((r) => r.json())
      .then((data: DiscussionData) => {
        setDiscussion(data.discussion);
        setAttachments(data.attachments ?? []);
        setCurrentRound(data.discussion.currentRound);
        setMaxRounds(data.discussion.maxRounds);
        setConvergenceScore(data.discussion.convergenceScore);
        setStatus(data.discussion.status);
        setMessages(
          data.messages.map((m) => ({
            id: m.id,
            round: m.round,
            modelId: m.modelId,
            modelName: getModelDisplayName(m.modelId),
            content: m.content,
          }))
        );
        setFinalResult(data.finalResult);
        if (data.discussion.status === "completed" && data.finalResult) {
          notifyComplete(data.discussion.topic);
        }
      });
  }, [id, requestNotificationPermission, notifyComplete]);

  useEffect(() => {
    if (!id || status === "completed" || status === "failed") return;

    const source = new EventSource(`/api/discussions/${id}/stream`);

    source.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as OrchestratorEvent;
        handleEvent(event);
      } catch {
        // ignore parse errors
      }
    };

    source.onerror = () => {
      source.close();
    };

    return () => source.close();
  }, [id, status, handleEvent]);

  if (!discussion) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        Loading discussion...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href="/"
            className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to dashboard
          </Link>
          <h1 className="text-2xl font-bold">{discussion.topic}</h1>
          <div className="mt-2 flex flex-wrap gap-2">
            <Badge variant="secondary">{discussion.mode}</Badge>
            <Badge variant="secondary">{discussion.effort} effort</Badge>
            <Badge
              variant={
                status === "completed"
                  ? "success"
                  : status === "failed"
                    ? "destructive"
                    : "warning"
              }
            >
              {status}
            </Badge>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={requestNotificationPermission}>
          <Bell className="mr-1 h-4 w-4" />
          Enable notifications
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      )}

      <DiscussionAttachments attachments={attachments} />

      <DiscussionTimeline
        messages={messages}
        currentRound={currentRound}
        maxRounds={maxRounds}
        convergenceScore={convergenceScore}
      />

      {finalResult && (
        <FinalAnswerCard
          answer={finalResult.answer}
          confidence={finalResult.confidence}
          dissent={finalResult.dissent}
          topic={discussion.topic}
        />
      )}
    </div>
  );
}
