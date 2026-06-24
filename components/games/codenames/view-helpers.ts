import type {
  CodenamesCardRole,
  CodenamesGameMode,
  CodenamesPlayerRole,
  CodenamesTeam,
} from "@/lib/games/codenames/types";

export function teamLabel(team: CodenamesTeam): string {
  return team === "red" ? "Red" : "Blue";
}

export function roleLabel(role: CodenamesPlayerRole): string {
  return role === "spymaster" ? "Spymaster" : "Operative";
}

export function modeLabel(mode: CodenamesGameMode): string {
  if (mode === "pvai") return "Player vs AI";
  if (mode === "aivai") return "AI vs AI";
  return "Player vs Player";
}

export function roleText(role: CodenamesCardRole | null): string {
  if (role === "red") return "Red agent";
  if (role === "blue") return "Blue agent";
  if (role === "neutral") return "Bystander";
  if (role === "assassin") return "Assassin";
  return "Hidden";
}

export function compactReasoningLabel(reasoningEffort: string): string {
  if (reasoningEffort === "low") return "Low";
  if (reasoningEffort === "medium") return "Medium";
  if (reasoningEffort === "high") return "High";
  if (reasoningEffort === "max") return "Max";
  return "Off";
}
