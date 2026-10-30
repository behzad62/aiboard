"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { OperationCard } from "@/components/extensions/OperationCard";
import type { NativeRunnerConnection } from "@/lib/client/runner-v2";
import { getRunnerChatSession, type ExtensionOperationDto } from "@/lib/client/runner-extensions";
import { runnerChatSessionId } from "@/lib/client/runner-chat";
import { resolveRunnerConnection } from "@/lib/client/local-runner-handoff";

const POLL_MS = 2_000;

/**
 * Extension operations this chat's agent started, rendered with the same card as Settings. Approval,
 * choices and secrets happen here, never in the conversation text.
 */
export function RunnerChatOperations({ discussionId, runnerUrl, runnerToken, replying }: { discussionId: string; runnerUrl: string; runnerToken: string; replying: boolean }) {
  // Primitive deps keep polling stable across parent re-renders.
  const resolved = useMemo(
    () => resolveRunnerConnection({ runnerUrl, runnerToken }),
    [runnerUrl, runnerToken]
  );
  const connection = useMemo<NativeRunnerConnection>(
    () => resolved ?? { url: runnerUrl, token: runnerToken },
    [resolved, runnerUrl, runnerToken]
  );
  const [operations, setOperations] = useState<ExtensionOperationDto[]>([]);
  const [loadedAt, setLoadedAt] = useState(0);
  const [unreachable, setUnreachable] = useState(false);

  const load = useCallback(async () => {
    if (!resolved) return;
    try {
      const snapshot = await getRunnerChatSession(connection, runnerChatSessionId(discussionId));
      setOperations(snapshot.operations);
      setLoadedAt(Date.now());
      setUnreachable(false);
    } catch (error) {
      // A chat that has not replied yet has no Runner session; only a network failure is worth showing.
      setUnreachable(error instanceof TypeError);
    }
  }, [connection, discussionId, resolved]);

  useEffect(() => { void load(); }, [load, replying]);
  const active = replying || operations.some((operation) => operation.outcome === "running" || operation.outcome === "awaiting_user");
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [active, load]);

  const visible = operations
    .filter((operation) => operation.outcome === "awaiting_user" || operation.outcome === "running" || loadedAt - Date.parse(operation.updatedAt) < 10 * 60_000)
    .slice(0, 4);
  if (!resolved) {
    return (
      <p className="mb-4 rounded-md bg-muted p-3 text-sm">
        Reconnect: run `aiboard` again to reconnect this chat to its Runner. This tab no longer has the session credential.
      </p>
    );
  }
  if (unreachable) {
    return (
      <p className="mb-4 rounded-md bg-muted p-3 text-sm">
        The Runner for this chat is not reachable. <Link className="underline" href="/settings?tab=tools">Check the Runner connection</Link>; your message is kept and can be retried.
      </p>
    );
  }
  if (visible.length === 0) return null;
  return (
    <section aria-label="Extension changes" className="mb-4 space-y-2">
      {visible.map((operation) => (
        <OperationCard key={operation.id} connection={connection} operation={operation} onChanged={() => void load()} />
      ))}
    </section>
  );
}
