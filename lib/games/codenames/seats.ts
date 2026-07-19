import type {
  CodenamesGameMode,
  CodenamesPlayerRole,
  CodenamesSeatAssignments,
  CodenamesSeatId,
  CodenamesSeatKind,
  CodenamesTeam,
} from "@/lib/games/codenames/types";

const SEAT_IDS: CodenamesSeatId[] = [
  "redSpymaster",
  "redOperative",
  "blueSpymaster",
  "blueOperative",
];

export const DEFAULT_CODENAMES_SEAT_ASSIGNMENTS: CodenamesSeatAssignments = {
  redSpymaster: "ai",
  redOperative: "human",
  blueSpymaster: "ai",
  blueOperative: "ai",
};

export function seatId(
  team: CodenamesTeam,
  role: CodenamesPlayerRole
): CodenamesSeatId {
  const suffix = role === "spymaster" ? "Spymaster" : "Operative";
  return `${team}${suffix}`;
}

export function seatKindFor(
  assignments: CodenamesSeatAssignments,
  team: CodenamesTeam,
  role: CodenamesPlayerRole
): CodenamesSeatKind {
  return assignments[seatId(team, role)];
}

export function everySeatAI(assignments: CodenamesSeatAssignments): boolean {
  return SEAT_IDS.every((id) => assignments[id] === "ai");
}

export function seatAssignmentsFromLegacyMode(
  mode: CodenamesGameMode,
  humanTeam: CodenamesTeam
): CodenamesSeatAssignments {
  const teamKind = (team: CodenamesTeam): CodenamesSeatKind => {
    if (mode === "aivai") return "ai";
    if (mode === "pvai" && team !== humanTeam) return "ai";
    return "human";
  };
  const red = teamKind("red");
  const blue = teamKind("blue");
  return {
    redSpymaster: red,
    redOperative: red,
    blueSpymaster: blue,
    blueOperative: blue,
  };
}

export function isCodenamesSeatAssignments(
  value: unknown
): value is CodenamesSeatAssignments {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return SEAT_IDS.every(
    (id) => record[id] === "human" || record[id] === "ai"
  );
}

export function codenamesCompositionLabel(
  assignments: CodenamesSeatAssignments
): string {
  const aiCount = SEAT_IDS.filter((id) => assignments[id] === "ai").length;
  const humanCount = SEAT_IDS.length - aiCount;
  if (aiCount === 0) return "Player vs Player";
  if (humanCount === 0) return "AI vs AI";

  const redAllAI =
    assignments.redSpymaster === "ai" && assignments.redOperative === "ai";
  const redAllHuman =
    assignments.redSpymaster === "human" && assignments.redOperative === "human";
  const blueAllAI =
    assignments.blueSpymaster === "ai" && assignments.blueOperative === "ai";
  const blueAllHuman =
    assignments.blueSpymaster === "human" && assignments.blueOperative === "human";

  if ((redAllHuman && blueAllAI) || (blueAllHuman && redAllAI)) {
    return "Player vs AI";
  }
  return `${humanCount} Human · ${aiCount} AI`;
}
