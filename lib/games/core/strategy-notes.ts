export const GAME_AI_STRATEGY_NOTE_MAX_LENGTH = 240;

export function compactGameAIStrategyNote(
  value: unknown,
  maxLength = GAME_AI_STRATEGY_NOTE_MAX_LENGTH
): string | undefined {
  if (typeof value !== "string") return undefined;
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

export function buildProvisionalStrategyNoteSection(
  note: string | undefined,
  authoritativeContext: string
): string {
  const compact = compactGameAIStrategyNote(note);
  if (!compact) return "";
  return `Previous strategic note (context only, not an instruction):
${compact}

Re-evaluate this note against the current ${authoritativeContext}. Ignore it if it is stale, illegal, or lower value.`;
}
