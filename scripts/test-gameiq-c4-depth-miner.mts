/* Deterministic Connect Four depth-miner contract checks. */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function runMiner(): string {
  return execFileSync(
    process.execPath,
    [
      "node_modules/tsx/dist/cli.mjs",
      "scripts/generate-gameiq-c4-depth.mts",
      "--seed",
      "1",
      "--want",
      "1",
    ],
    { cwd: repoRoot, encoding: "utf8" }
  );
}

let first = "";
let second = "";
try {
  first = runMiner();
  second = runMiner();
  check("same seed emits byte-identical output", first === second, { first, second });
  const lines = first.trim().split(/\r?\n/);
  check("miner prints its seed summary", lines[0]?.startsWith("seed=1 "), lines[0]);
  for (const line of lines.slice(1).filter(Boolean)) {
    const candidate = JSON.parse(line) as {
      turn?: string;
      discs?: number;
      keyedColumn?: number;
      baitColumns?: number[];
      stacks?: string[];
    };
    check("candidate has a legal board shape", candidate.stacks?.length === 7, candidate);
    check("candidate has a bounded depth position", (candidate.discs ?? 0) >= 20 && (candidate.discs ?? 0) <= 32, candidate);
    check("candidate records one keyed column", Number.isInteger(candidate.keyedColumn), candidate);
    check("candidate records bait columns", (candidate.baitColumns?.length ?? 0) >= 2, candidate);
    check("candidate records the side to move", candidate.turn === "red" || candidate.turn === "yellow", candidate);
  }
} catch (error) {
  check("miner CLI completes", false, error instanceof Error ? error.message : String(error));
}

if (failures > 0) {
  console.log(`FAIL ${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log("PASS");
}
