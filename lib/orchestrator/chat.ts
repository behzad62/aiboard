import type { ChatMessage } from "@/lib/providers/base";

/**
 * Single-model chat: a plain multi-turn conversation. The discussion topic is
 * the first user turn; every later turn is a stored Message with role "user"
 * or "assistant". Turn N's user message and its reply share `round = N`
 * (the topic is turn 1 and has no stored user message).
 */
export interface ChatTurnMessage {
  id: string;
  round: number;
  role: string;
  content: string;
  createdAt: string;
}

export interface ChatTurn {
  round: number;
  role: "user" | "assistant";
  content: string;
}

export function chatSystemPrompt(input: {
  modelName: string;
  verbosityInstruction: string;
  now?: Date;
}): string {
  const date = (input.now ?? new Date()).toISOString().slice(0, 10);
  return [
    `You are ${input.modelName}, a helpful assistant in a one-on-one chat.`,
    `Today's date is ${date}.`,
    "Answer directly, use Markdown when it helps (lists, tables, fenced code), and ask a short clarifying question only when the request is genuinely ambiguous.",
    input.verbosityInstruction,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The conversation in order: the topic, then stored user/assistant turns. */
export function chatTurns(topic: string, messages: ChatTurnMessage[]): ChatTurn[] {
  const stored = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice()
    .sort((a, b) =>
      a.round !== b.round
        ? a.round - b.round
        : // A turn's user message precedes its reply.
          a.role === b.role
          ? a.createdAt.localeCompare(b.createdAt)
          : a.role === "user"
            ? -1
            : 1
    )
    .map((message) => ({
      round: message.round,
      role: message.role as "user" | "assistant",
      content: message.content,
    }));
  return [{ round: 1, role: "user", content: topic }, ...stored];
}

/** The round awaiting a reply, or null when the model already answered the latest turn. */
export function pendingChatRound(turns: ChatTurn[]): number | null {
  const last = turns[turns.length - 1];
  return last && last.role === "user" ? last.round : null;
}

export function nextChatRound(turns: ChatTurn[]): number {
  return turns.reduce((max, turn) => Math.max(max, turn.round), 0) + 1;
}

const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/**
 * Builds the provider messages for the pending turn, dropping the oldest
 * turns (never the first question or the latest one) once the conversation
 * no longer fits the model's input budget.
 */
export function buildChatMessages(input: {
  systemPrompt: string;
  turns: ChatTurn[];
  inlineAttachmentText?: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
}): { messages: ChatMessage[]; droppedTurns: number } {
  const turns = input.turns.map((turn, index) =>
    index === 0 && input.inlineAttachmentText
      ? { ...turn, content: `${turn.content}\n\n${input.inlineAttachmentText}` }
      : turn
  );
  const budget = Math.max(
    1_000,
    Math.floor((input.contextWindowTokens - input.maxOutputTokens) * 0.9)
  );
  let total =
    estimateTokens(input.systemPrompt) +
    turns.reduce((sum, turn) => sum + estimateTokens(turn.content), 0);
  const kept = [...turns];
  let droppedTurns = 0;
  // Drop from just after the first turn, oldest first, keeping the latest.
  while (total > budget && kept.length > 2) {
    const [removed] = kept.splice(1, 1);
    total -= estimateTokens(removed!.content);
    droppedTurns++;
  }
  const messages: ChatMessage[] = [{ role: "system", content: input.systemPrompt }];
  if (droppedTurns > 0) {
    messages.push(kept[0]!, {
      role: "user",
      content: `(${droppedTurns} earlier message${droppedTurns === 1 ? " was" : "s were"} omitted to fit the context window.)`,
    });
    for (const turn of kept.slice(1)) messages.push(turn);
  } else {
    for (const turn of kept) messages.push(turn);
  }
  // Providers expect strictly alternating roles; merge any adjacent same-role turns.
  const merged: ChatMessage[] = [];
  for (const message of messages) {
    const previous = merged[merged.length - 1];
    if (previous && previous.role === message.role && message.role !== "system") {
      previous.content = `${previous.content}\n\n${message.content}`;
    } else {
      merged.push({ role: message.role, content: message.content });
    }
  }
  return { messages: merged, droppedTurns };
}
