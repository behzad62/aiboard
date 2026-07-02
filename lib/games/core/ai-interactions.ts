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

const GAME_AI_GESTURE_LABELS: Record<
  NonNullable<GameAIInteraction["gesture"]>,
  string
> = {
  thinking: "Thinking",
  confident: "Confident",
  confused: "Uncertain",
  celebrating: "Celebrating",
  apologetic: "Recovering",
  neutral: "Ready",
};

const GAME_AI_SAFE_UTTERANCES: Record<
  NonNullable<GameAIInteraction["gesture"]>,
  string
> = {
  thinking: "Give me a second...",
  confident: "I like this turn.",
  confused: "I need to clean that up.",
  celebrating: "That worked out.",
  apologetic: "That was not what I wanted.",
  neutral: "Your move.",
};

const GAME_AI_INTENT_LEAK_PATTERNS = [
  /\b[a-h][1-8]\b/i,
  /\b[A-J](?:10|[1-9])\b/,
  /\bcolumn\s*(?:[1-7]|one|two|three|four|five|six|seven)\b/i,
  /\b[a-h]-?file\b/i,
  /\b(?:file|rank|diagonal|pawn|knight|bishop|rook|queen|king|mate|check|capture|capturing|fork|pin|skewer|gambit|opening|center|central)\b/i,
  /\b(?:target|targeting|pressure|attack|attacking|threat|block|blocking|trap|line|lane|adjacent|coordinate|pattern)\b/i,
  /\b(?:ship|carrier|battleship|submarine|destroyer|cruiser|hit|miss|sink|sunk)\b/i,
  /\b(?:clue|assassin|neutral|operative|spymaster|intended|word|guess|guesses)\b/i,
  /\b(?:card|playable|discard|discarding|stack|token)\b/i,
];

export interface GameAIDisplay {
  actorLabel: string;
  gestureLabel: string;
  utterance: string;
}

export function isGameAIGesture(
  value: unknown
): value is GameAIInteraction["gesture"] {
  return (
    typeof value === "string" &&
    GAME_AI_GESTURES.has(value as GameAIInteraction["gesture"])
  );
}

export function formatGameAIActorLabel(actorId: string): string {
  const normalized = actorId.replace(/[-_:]+/g, " ").trim();
  if (!normalized || normalized.toLowerCase() === "ai") return "AI";

  return normalized
    .split(/\s+/)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
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

export function isLikelyGameAIIntentLeak(value: string): boolean {
  return GAME_AI_INTENT_LEAK_PATTERNS.some((pattern) => pattern.test(value));
}

export function buildGameAIThinkingInteraction(
  actorId: string
): GameAIInteraction {
  return {
    actorId,
    gesture: "thinking",
    utterance: GAME_AI_SAFE_UTTERANCES.thinking,
  };
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

export function resolveGameAIDisplay(
  interaction: GameAIInteraction | null | undefined
): GameAIDisplay | null {
  if (!hasVisibleGameAIInteraction(interaction)) return null;

  const gesture = interaction.gesture ?? "neutral";
  const safeDefault = GAME_AI_SAFE_UTTERANCES[gesture];
  const utterance =
    interaction.utterance && !isLikelyGameAIIntentLeak(interaction.utterance)
      ? interaction.utterance
      : safeDefault;

  return {
    actorLabel: formatGameAIActorLabel(interaction.actorId),
    gestureLabel: GAME_AI_GESTURE_LABELS[gesture],
    utterance,
  };
}
