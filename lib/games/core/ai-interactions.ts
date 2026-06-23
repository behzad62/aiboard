import type { GameAIInteraction } from "./types";

export interface GameAIInteractionResult<TAction> {
  action: TAction;
  gesture?: GameAIInteraction["gesture"];
  utterance?: string;
  confidence?: number;
  diagnostics?: string;
}

const GAME_AI_GESTURES = new Set<GameAIInteraction["gesture"]>([
  "thinking",
  "confident",
  "confused",
  "celebrating",
  "apologetic",
  "neutral",
]);

export function isGameAIGesture(
  value: unknown
): value is GameAIInteraction["gesture"] {
  return (
    typeof value === "string" &&
    GAME_AI_GESTURES.has(value as GameAIInteraction["gesture"])
  );
}

export function normalizeGameAIUtterance(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  const oneLine = value.replace(/\s+/g, " ").trim();
  if (!oneLine) return undefined;

  const sentenceMatch = oneLine.match(/^(.+?[.!?])(?:\s|$)/);
  const sentence = sentenceMatch?.[1] ?? oneLine;
  return sentence.length <= 140 ? sentence : `${sentence.slice(0, 137)}...`;
}

export function normalizeGameAIConfidence(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(1, value));
}

export function buildGameAIInteraction(
  actorId: string,
  input: {
    gesture?: unknown;
    utterance?: unknown;
    confidence?: unknown;
    diagnostics?: unknown;
  }
): GameAIInteraction | null {
  const gesture = isGameAIGesture(input.gesture) ? input.gesture : undefined;
  const utterance = normalizeGameAIUtterance(input.utterance);
  const confidence = normalizeGameAIConfidence(input.confidence);
  const diagnostics =
    typeof input.diagnostics === "string" && input.diagnostics.trim()
      ? input.diagnostics.trim()
      : undefined;

  if (!gesture && !utterance && confidence === undefined && !diagnostics) {
    return null;
  }

  return {
    actorId,
    ...(gesture ? { gesture } : {}),
    ...(utterance ? { utterance } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(diagnostics ? { diagnostics } : {}),
  };
}

export function hasVisibleGameAIInteraction(
  interaction: GameAIInteraction | null | undefined
): interaction is GameAIInteraction {
  return Boolean(
    interaction?.utterance ||
      (interaction?.gesture && interaction.gesture !== "neutral")
  );
}
