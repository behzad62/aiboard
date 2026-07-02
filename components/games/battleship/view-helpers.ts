import type { GameAIModelOption } from "@/components/games/GameAIConfigPanel";
import type {
  BattleshipGameMode,
  BattleshipPlayer,
  BattleshipPlayerBoard,
} from "@/lib/games/battleship/types";

export function opponentOf(player: BattleshipPlayer): BattleshipPlayer {
  return player === "blue" ? "orange" : "blue";
}

export function playerLabel(player: BattleshipPlayer): string {
  return player === "blue" ? "Blue" : "Orange";
}

export function modeLabel(
  mode: BattleshipGameMode,
  humanPlayer: BattleshipPlayer
): string {
  if (mode === "pvp") return "Player vs Player";
  if (mode === "aivai") return "AI vs AI";
  return `${playerLabel(humanPlayer)} Player vs ${playerLabel(
    opponentOf(humanPlayer)
  )} AI`;
}

export function isAIControlledPlayer(
  mode: BattleshipGameMode,
  humanPlayer: BattleshipPlayer,
  player: BattleshipPlayer
): boolean {
  if (mode === "aivai") return true;
  if (mode === "pvai") return player !== humanPlayer;
  return false;
}

export function compactReasoningLabel(config: {
  reasoningEffort: string;
}): string {
  switch (config.reasoningEffort) {
    case "none":
      return "Off";
    case "default":
      return "Default";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "max":
      return "Max";
    default:
      return "Off";
  }
}

export function modelLabel(
  models: GameAIModelOption[],
  modelId: string
): string | undefined {
  return models.find((model) => model.modelId === modelId)?.displayName ?? modelId;
}

export function remainingShipCells(board: BattleshipPlayerBoard): number {
  const hits = new Set(
    board.shotsReceived
      .filter((shot) => shot.shipId)
      .map((shot) => `${shot.target.row}:${shot.target.column}`)
  );

  return board.ships.reduce(
    (sum, ship) =>
      sum +
      ship.cells.filter((cell) => !hits.has(`${cell.row}:${cell.column}`))
        .length,
    0
  );
}

export function sunkShipCount(board: BattleshipPlayerBoard): number {
  const sunkIds = new Set(
    board.shotsReceived
      .map((shot) => shot.sunkShipId)
      .filter((value): value is string => Boolean(value))
  );
  return sunkIds.size;
}
