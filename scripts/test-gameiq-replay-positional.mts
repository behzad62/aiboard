/* Definitive acceptance test for the gap/duplicate-aware POSITIONAL trace
 * pairing in resolvePackTraceReplay (run: npx tsx
 * scripts/test-gameiq-replay-positional.mts).
 *
 * Ground truth = the OFFICIAL verifier baked into two COMPLETED reference runs
 * (Spark + Opus, READ-ONLY under AIBoard). The positional resolver is correct
 * iff, replaying each pack's recorded legacy traces (no scenarioId) through
 * resolvePackTraceReplay, EVERY scenario is fed EXACTLY the action the live
 * verifier scored — and a scenario the verifier scored as a null/failed action
 * (a mid-list transport gap or a double-recorded call whose final state errored)
 * is DROPPED, never shifted onto a neighbor.
 *
 * This pins the bug the 2026-07-03 review reproduced: an empty trace mid-list
 * (e.g. the Spark chess smothered-mate timeout at position 2) made the old
 * filter-then-slice collapse past the gap, scoring chess 2/15 where the verifier
 * said 14/15; and a duplicate trace (Spark connect-four 41 traces for 40
 * scenarios) shifted every trailing scenario. The fix dedups by promptHash
 * (keeping the FINAL recorded state) then index-pairs after the dedup and
 * filters gaps.
 *
 * TWO layers of assertion:
 *  1. ACTION-PAIRING (load-bearing, strict): for every scenario the verifier
 *     scored, the replay feeds the byte-identical action, or drops it iff the
 *     verifier's recorded action was null. Any mid-list shift or bad dedup
 *     breaks this. This is the resolver's actual contract and must be 100%.
 *  2. VERDICT (correctness cross-check): the replayed `correct` verdict equals
 *     the verifier's `passed` for every scenario. These reference runs were
 *     scored under GameIQ scoring v0.2; the current worktree scores v0.3, whose
 *     rule refinements legitimately re-grade a HANDFUL of already-correctly-
 *     PAIRED actions. Such a divergence is allowed ONLY when the replay action
 *     is byte-identical to the verifier's (so it cannot mask a pairing bug) and
 *     is enumerated in ALLOWED_SCORER_DIVERGENCES below. A NEW divergence, or
 *     one where the actions differ, FAILS the test.
 */
import { readFileSync } from "node:fs";
import {
  GAMEIQ_SCORING_VERSION,
  listGameIqScenarioPacks,
  resolvePackTraceReplay,
  runGameIqScenarios,
  type PackTraceRow,
} from "../lib/benchmark/gameiq";
import type { BenchmarkReportBundleV2 } from "../lib/benchmark/types";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const AIBOARD_RUNS =
  "C:/Users/b_a_s/OneDrive/Documents/AIBoard/benchmarks/runs/";

// The two COMPLETED reference runs whose official verifierResults are the ground
// truth. READ-ONLY — this test never writes under AIBoard.
const REFERENCE_RUNS = [
  {
    tag: "spark",
    file: "ui-gameiq-1783020292687-chatgpt-chatgpt-gpt-5-3-codex-spark-1.json",
  },
  {
    tag: "opus",
    file: "ui-gameiq-1783020292687-foundry-foundry-claude-opus-4-5-0.json",
  },
];

// Scorer-version (v0.2 recorded → v0.3 replay) re-grades: the action pairing is
// proven byte-identical (asserted below), only the verdict changed. Keyed
// "tag/scenarioId". Any divergence NOT listed here — or one whose actions do
// not match — is a real regression and fails the test.
const ALLOWED_SCORER_DIVERGENCES = new Set<string>([
  // v0.3 auto-widens an equivalent-information clue (clue_color P1 blue) to the
  // authored discard/clue_rank expectation for this fireworks-hard scenario;
  // v0.2 scored it wrong. Action fed is identical to the verifier's.
  "spark/gameiq-fireworks-hard-v1-20",
]);

interface OracleCase {
  scenarioId: string;
  passed: boolean;
  action: unknown;
}

function canon(value: unknown): string {
  return JSON.stringify(value ?? null);
}

const packs = listGameIqScenarioPacks();

for (const ref of REFERENCE_RUNS) {
  console.log(`\n===== ${ref.tag} (${GAMEIQ_SCORING_VERSION} replay) =====`);
  const bundle = JSON.parse(
    readFileSync(AIBOARD_RUNS + ref.file, "utf8")
  ) as BenchmarkReportBundleV2;
  const model = bundle.runs[0].modelIds[0];
  const traces = bundle.traces as PackTraceRow[];

  // The reference runs must be the legacy (no-scenarioId) shape this branch
  // targets; otherwise the test would silently exercise the OTHER branch.
  check(
    `${ref.tag}: reference traces are legacy positional (no scenarioId)`,
    traces.every((trace) => !("scenarioId" in trace) || !trace.scenarioId),
    traces.find((trace) => Boolean(trace.scenarioId))
  );

  for (const pack of packs) {
    const packTraces = traces.filter((trace) => trace.caseId === pack.id);
    if (packTraces.length === 0) continue;

    // Ground-truth caseResults from the official verifier for this pack.
    const verifier = bundle.verifierResults.find(
      (result) => result.caseId === pack.id
    );
    if (!verifier) {
      check(`${ref.tag}/${pack.id}: has official verifierResult`, false);
      continue;
    }
    const oracleCases = (
      JSON.parse(verifier.resultJson) as { caseResults: OracleCase[] }
    ).caseResults;

    // Replay through the shared resolver + real scorer.
    const { replayScenarios, actions } = resolvePackTraceReplay(
      pack,
      packTraces
    );
    const replayActionById = new Map<string, unknown>();
    replayScenarios.forEach((scenario, index) =>
      replayActionById.set(scenario.id, actions[index])
    );

    let cursor = 0;
    const result = await runGameIqScenarios({
      runId: `positional-accept-${ref.tag}`,
      modelId: model,
      teamCompositionId: "positional-accept",
      scenarios: replayScenarios,
      moveProvider: () => ({ action: actions[cursor++] }),
    });
    const replayCorrectById = new Map(
      result.caseResults.map((r) => [r.scenarioId, r.legal && r.correct])
    );

    // ── Layer 1: ACTION-PAIRING (strict) ─────────────────────────────────────
    const pairingProblems: unknown[] = [];
    for (const oracle of oracleCases) {
      const replayed = replayActionById.has(oracle.scenarioId)
        ? replayActionById.get(oracle.scenarioId)
        : "<DROPPED>";
      if (oracle.action === null || oracle.action === undefined) {
        // Verifier scored a null/failed action → replay MUST drop this scenario
        // (never shift a neighbor's action onto it).
        if (replayed !== "<DROPPED>") {
          pairingProblems.push({
            scenarioId: oracle.scenarioId,
            issue: "verifier action null but replay fed one",
            replay: canon(replayed),
          });
        }
      } else if (replayed === "<DROPPED>") {
        pairingProblems.push({
          scenarioId: oracle.scenarioId,
          issue: "verifier had an action but replay DROPPED the scenario",
          oracle: canon(oracle.action),
        });
      } else if (canon(replayed) !== canon(oracle.action)) {
        pairingProblems.push({
          scenarioId: oracle.scenarioId,
          issue: "replay fed a DIFFERENT action than the verifier scored",
          replay: canon(replayed),
          oracle: canon(oracle.action),
        });
      }
    }
    check(
      `${ref.tag}/${pack.id}: every scenario fed the verifier's own action (gaps dropped)`,
      pairingProblems.length === 0,
      pairingProblems
    );

    // ── Layer 2: VERDICT (with enumerated scorer-version divergences) ─────────
    const verdictProblems: unknown[] = [];
    for (const oracle of oracleCases) {
      if (!replayCorrectById.has(oracle.scenarioId)) {
        // Not scored by replay: only legitimate when the verifier's action was
        // null (a gap) — already checked in layer 1.
        if (oracle.action !== null && oracle.action !== undefined) {
          verdictProblems.push({
            scenarioId: oracle.scenarioId,
            issue: "replay did not score a scenario the verifier scored",
          });
        }
        continue;
      }
      const replayCorrect = replayCorrectById.get(oracle.scenarioId);
      if (replayCorrect === oracle.passed) continue;
      // Divergence: allowed ONLY if enumerated AND action byte-identical.
      const key = `${ref.tag}/${oracle.scenarioId}`;
      const actionIdentical =
        canon(replayActionById.get(oracle.scenarioId)) === canon(oracle.action);
      if (ALLOWED_SCORER_DIVERGENCES.has(key) && actionIdentical) {
        console.log(
          `  note: ${key} verdict re-graded by ${GAMEIQ_SCORING_VERSION} (replay ${replayCorrect} vs verifier ${oracle.passed}); action byte-identical, pairing intact`
        );
        continue;
      }
      verdictProblems.push({
        scenarioId: oracle.scenarioId,
        replay: replayCorrect,
        verifier: oracle.passed,
        actionIdentical,
        enumerated: ALLOWED_SCORER_DIVERGENCES.has(key),
      });
    }
    check(
      `${ref.tag}/${pack.id}: replay verdicts match the verifier (modulo enumerated scorer re-grades)`,
      verdictProblems.length === 0,
      verdictProblems
    );
  }
}

// ── Named regression pins the review called out explicitly ───────────────────
// This used to prove two headline numbers (Spark chess 14/15, Spark
// connect-four 37/40) by replaying the v0.1 chess/connect-four packs by id.
// Those packs were hard-deleted 2026-07-17 — the design's accepted tradeoff
// is that historical v0.1 traces become unreplayable, so this specific pin no
// longer has a pack to replay against. The main loop above already proves the
// resolver's pairing/dedup correctness generically for every pack still
// registered (and for whichever reference-run packs still exist); it does not
// need this pack-id-specific pin to stay meaningful.

console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
