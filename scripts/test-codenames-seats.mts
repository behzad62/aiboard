/** Codenames seat-assignment helpers (run: npx tsx scripts/test-codenames-seats.mts) */
import {
  DEFAULT_CODENAMES_SEAT_ASSIGNMENTS,
  codenamesCompositionLabel,
  everySeatAI,
  isCodenamesSeatAssignments,
  seatAssignmentsFromLegacyMode,
  seatId,
  seatKindFor,
} from "../lib/games/codenames/seats";
import type { CodenamesSeatAssignments } from "../lib/games/codenames/types";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const allAI: CodenamesSeatAssignments = {
  redSpymaster: "ai",
  redOperative: "ai",
  blueSpymaster: "ai",
  blueOperative: "ai",
};
const allHuman: CodenamesSeatAssignments = {
  redSpymaster: "human",
  redOperative: "human",
  blueSpymaster: "human",
  blueOperative: "human",
};
const classicPvai: CodenamesSeatAssignments = {
  redSpymaster: "human",
  redOperative: "human",
  blueSpymaster: "ai",
  blueOperative: "ai",
};

check("seatId maps red spymaster", seatId("red", "spymaster") === "redSpymaster");
check("seatId maps blue operative", seatId("blue", "operative") === "blueOperative");

check(
  "default is AI spymaster + human operative on red, AI blue",
  DEFAULT_CODENAMES_SEAT_ASSIGNMENTS.redSpymaster === "ai" &&
    DEFAULT_CODENAMES_SEAT_ASSIGNMENTS.redOperative === "human" &&
    DEFAULT_CODENAMES_SEAT_ASSIGNMENTS.blueSpymaster === "ai" &&
    DEFAULT_CODENAMES_SEAT_ASSIGNMENTS.blueOperative === "ai",
  DEFAULT_CODENAMES_SEAT_ASSIGNMENTS
);

check(
  "seatKindFor reads the map by team+role",
  seatKindFor(DEFAULT_CODENAMES_SEAT_ASSIGNMENTS, "red", "operative") === "human" &&
    seatKindFor(DEFAULT_CODENAMES_SEAT_ASSIGNMENTS, "red", "spymaster") === "ai"
);

check("everySeatAI true when all ai", everySeatAI(allAI) === true);
check("everySeatAI false on default", everySeatAI(DEFAULT_CODENAMES_SEAT_ASSIGNMENTS) === false);

check(
  "legacy pvp migrates to all human",
  JSON.stringify(seatAssignmentsFromLegacyMode("pvp", "red")) === JSON.stringify(allHuman)
);
check(
  "legacy pvai humanTeam red migrates to human red / ai blue",
  JSON.stringify(seatAssignmentsFromLegacyMode("pvai", "red")) === JSON.stringify(classicPvai)
);
check(
  "legacy pvai humanTeam blue migrates to ai red / human blue",
  JSON.stringify(seatAssignmentsFromLegacyMode("pvai", "blue")) ===
    JSON.stringify({
      redSpymaster: "ai",
      redOperative: "ai",
      blueSpymaster: "human",
      blueOperative: "human",
    })
);
check(
  "legacy aivai migrates to all ai",
  JSON.stringify(seatAssignmentsFromLegacyMode("aivai", "red")) === JSON.stringify(allAI)
);

check("label all human", codenamesCompositionLabel(allHuman) === "Player vs Player");
check("label all ai", codenamesCompositionLabel(allAI) === "AI vs AI");
check("label classic pvai", codenamesCompositionLabel(classicPvai) === "Player vs AI");
check(
  "label mixed default",
  codenamesCompositionLabel(DEFAULT_CODENAMES_SEAT_ASSIGNMENTS) === "1 Human · 3 AI",
  codenamesCompositionLabel(DEFAULT_CODENAMES_SEAT_ASSIGNMENTS)
);

check("validator accepts default", isCodenamesSeatAssignments(DEFAULT_CODENAMES_SEAT_ASSIGNMENTS) === true);
check(
  "validator rejects missing seat",
  isCodenamesSeatAssignments({ redSpymaster: "ai", redOperative: "human", blueSpymaster: "ai" }) === false
);
check(
  "validator rejects bad kind",
  isCodenamesSeatAssignments({
    redSpymaster: "robot",
    redOperative: "human",
    blueSpymaster: "ai",
    blueOperative: "ai",
  }) === false
);
check("validator rejects non-object", isCodenamesSeatAssignments(null) === false);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}
process.exit(failures === 0 ? 0 : 1);
