import { createNativeProviderConfig } from "./native-build-engine";
import { configureNativeProviders, type NativeRunnerConnection } from "./runner-v2";
import {
  createRunnerChatSession,
  getRunnerChatSession,
  sendRunnerChatMessage,
  stopRunnerChatSession,
  type RunnerChatSnapshotDto,
} from "./runner-extensions";

const POLL_START_MS = 700;
const POLL_MAX_MS = 2_500;

export function runnerChatSessionId(discussionId: string): string {
  return `chat-${discussionId}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
}

/**
 * One single-model chat reply produced by the Runner, so the model can use skills, read project files
 * and manage extensions with native tool continuation. Earlier turns are sent once as context; only
 * the new message counts as the user's request.
 */
export async function runRunnerChatTurn(input: {
  connection: NativeRunnerConnection;
  discussionId: string;
  modelId: string;
  reasoningEffort?: string | null;
  round: number;
  text: string;
  history: { role: "user" | "assistant"; text: string }[];
  signal: AbortSignal;
  onProgress?: (snapshot: RunnerChatSnapshotDto) => void;
}): Promise<{ text: string; snapshot: RunnerChatSnapshotDto }> {
  const sessionId = runnerChatSessionId(input.discussionId);
  await configureNativeProviders(input.connection, [createNativeProviderConfig(input.modelId, 0, input.reasoningEffort ?? undefined)], fetch, input.signal);
  let snapshot = await createRunnerChatSession(input.connection, { sessionId, runtimeId: input.modelId }, input.signal);
  const messageId = `round-${input.round}`;
  if (!snapshot.messages.some((message) => message.id === messageId)) {
    snapshot = await sendRunnerChatMessage(input.connection, sessionId, {
      messageId, text: input.text,
      ...(snapshot.messages.length === 0 && input.history.length ? { history: input.history } : {}),
    }, input.signal);
  }
  const abort = () => { void stopRunnerChatSession(input.connection, sessionId).catch(() => undefined); };
  input.signal.addEventListener("abort", abort, { once: true });
  try {
    let delay = POLL_START_MS;
    for (;;) {
      const reply = replyTo(snapshot, messageId);
      if (reply && snapshot.status !== "running") return { text: reply, snapshot };
      if (snapshot.status === "failed") throw new Error(snapshot.error ?? "The Runner chat reply failed.");
      if (snapshot.status === "idle" && !reply) throw new Error("The Runner finished without a reply; send the message again.");
      input.onProgress?.(snapshot);
      await wait(delay, input.signal);
      delay = Math.min(POLL_MAX_MS, Math.round(delay * 1.4));
      snapshot = await getRunnerChatSession(input.connection, sessionId, input.signal);
    }
  } finally {
    input.signal.removeEventListener("abort", abort);
  }
}

function replyTo(snapshot: RunnerChatSnapshotDto, messageId: string): string | undefined {
  const index = snapshot.messages.findIndex((message) => message.id === messageId);
  if (index < 0) return undefined;
  return snapshot.messages.slice(index + 1).find((message) => message.role === "assistant")?.text;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
