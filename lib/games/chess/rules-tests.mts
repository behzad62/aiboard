/* Chess rules regression checks (run: npx tsx lib/games/chess/rules-tests.mts) */
import {
  fromFEN,
  generateLegalMovesFromSquare,
  isLegalMove,
  makeMove,
} from "./engine";
import type { Move } from "./types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

function sameMove(a: Move, b: Move): boolean {
  return a.from === b.from && a.to === b.to && a.promotion === b.promotion;
}

const checkedState = fromFEN("4k3/8/8/8/8/8/4r3/R3K3 w - - 0 1");
const responseMove: Move = { from: "e1", to: "e2" };
const responseMoves = generateLegalMovesFromSquare(checkedState, "e1");

check("position with legal response is check", checkedState.status === "check", {
  status: checkedState.status,
});
check(
  "legal responses are generated while in check",
  responseMoves.some((move) => sameMove(move, responseMove)),
  responseMoves
);
check(
  "legal response is accepted while in check",
  isLegalMove(checkedState, responseMove),
  responseMoves
);

try {
  const nextState = makeMove(checkedState, responseMove);
  check("legal response can be made from check", nextState.status === "playing", {
    status: nextState.status,
  });
} catch (err) {
  check("legal response can be made from check", false, {
    error: err instanceof Error ? err.message : String(err),
  });
}

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
