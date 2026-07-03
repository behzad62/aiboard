/* Regression guard for the B4/B4.6 replay pairing in resolvePackTraceReplay
 * (run: npx tsx scripts/test-gameiq-replay-pairing.mts).
 *
 * Pins the bug the 2026-07-03 quality review reproduced: when a MIDDLE
 * scenario's trace has an empty parsedResponseJson (a failed transport call,
 * which B4 runs record WITH a scenarioId at model-call.ts's error trace site),
 * a filter-then-positional-slice collapses past the gap — the failed scenario
 * inherits its neighbor's action (scored WRONG) and a good trailing scenario
 * is silently dropped. The fix pairs scenario↔trace as TUPLES keyed by
 * scenarioId and filters the tuples, so a dropped middle trace removes exactly
 * its own scenario and never shifts the others. This test exercises the
 * SHARED resolvePackTraceReplay (the ONE implementation both replay and
 * recovery call) and asserts s0/s2 keep their OWN actions while s1 is skipped.
 *
 * This file covers BOTH branches of resolvePackTraceReplay hermetically
 * (synthetic in-memory fixtures only, no external file reads):
 *  - scenarioId branch (B4+ files): tuple-pair by scenarioId, filter usable.
 *  - positional branch (B4.6, legacy pre-B4 files with no scenarioId): sort by
 *    startedAt -> dedup by promptHash (keep latest/non-empty) -> index-pair
 *    after dedup -> filter empty-trace pairs. See the "POSITIONAL branch"
 *    section below. The AIBoard-dependent acceptance test
 *    scripts/test-gameiq-replay-positional.mts remains the local ground-truth
 *    check against real reference run files; it is not CI-runnable, so this
 *    section is the CI-runnable regression pin for that branch's unique
 *    dedup + gap-aware pairing logic.
 */
import {
  getGameIqScenarioPack,
  resolvePackTraceReplay,
  runGameIqScenarios,
  type GameIqScenario,
  type PackTraceRow,
} from "../lib/benchmark/gameiq";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

function actionFromParsedJson(parsedJson: unknown): unknown {
  if (
    parsedJson &&
    typeof parsedJson === "object" &&
    !Array.isArray(parsedJson) &&
    "action" in parsedJson
  ) {
    return (parsedJson as { action: unknown }).action;
  }
  return parsedJson;
}

const pack = getGameIqScenarioPack("connect-four");
if (!pack) {
  check("connect-four pack available", false);
  process.exit(1);
}

// A 3-scenario slice with distinct correct answers. s0 and s2 get correct
// actions; s1's trace is a failed transport call (empty parsedResponseJson).
const scenarios: GameIqScenario[] = pack.scenarios.slice(0, 3);

const traceFor = (scenario: GameIqScenario, empty: boolean): PackTraceRow => ({
  caseId: pack.id,
  startedAt: `2026-07-03T00:00:0${scenarios.indexOf(scenario)}.000Z`,
  scenarioId: scenario.id,
  parsedResponseJson: empty
    ? "" // failed transport call: dying call records an empty response
    : JSON.stringify({ action: scenario.expectedActions[0].action }),
  rawResponse: empty ? "provider transport failure" : undefined,
});

// All three traces carry a scenarioId; only the MIDDLE one (s1) is empty. Build
// a pack scoped to just these three scenarios so the shared resolver's
// scenario-order filtering is exercised against exactly this slice.
const packTraces: PackTraceRow[] = [
  traceFor(scenarios[0], false),
  traceFor(scenarios[1], true),
  traceFor(scenarios[2], false),
];

// --- Drive the SHARED resolver (hasScenarioIds tuple pairing branch) ---
const slicePack = { ...pack, scenarios };
const { replayScenarios, actions } = resolvePackTraceReplay(slicePack, packTraces);

// The failed middle scenario is dropped (not replayed), and exactly the two
// good scenarios remain — in scenario order, each still paired to its OWN
// trace.
check(
  "middle failed scenario is skipped, s0 and s2 survive (no drop of s2)",
  replayScenarios.map((s) => s.id).join() ===
    [scenarios[0].id, scenarios[2].id].join(),
  replayScenarios.map((s) => s.id)
);
check(
  "s0 keeps its OWN action (not shifted)",
  JSON.stringify(actions[0]) === JSON.stringify(scenarios[0].expectedActions[0].action),
  { got: actions[0], expected: scenarios[0].expectedActions[0].action }
);
check(
  "s2 keeps its OWN action (NOT s1's neighbor and NOT dropped)",
  JSON.stringify(actions[1]) === JSON.stringify(scenarios[2].expectedActions[0].action),
  { got: actions[1], expected: scenarios[2].expectedActions[0].action }
);

// End-to-end through the real scorer: both replayed scenarios must be scored
// correct (proving s2 was matched to its own keyed answer, not misattributed).
let i = 0;
const result = await runGameIqScenarios({
  runId: "replay-pairing-test",
  modelId: "fake:replay-pairing",
  teamCompositionId: "team-fake-replay-pairing",
  scenarios: replayScenarios,
  moveProvider: () => ({ action: actions[i++] }),
});
check(
  "replayed scenarios both score correct (s2 matched its own oracle, not shifted)",
  result.caseResults.length === 2 &&
    result.caseResults.every((r) => r.correct && r.legal),
  result.caseResults.map((r) => ({ id: r.scenarioId, correct: r.correct }))
);

// Negative control: prove a POSITIONAL filter-then-slice (the pre-fix bug)
// WOULD misattribute — s2 would inherit s1's slot and be scored on s0/s2 order
// collapse. This demonstrates the tuple filter is load-bearing, not incidental.
const positionalUsable = packTraces.filter(
  (t) => t.parsedResponseJson && t.parsedResponseJson.length > 0
);
// Under the buggy path, scenarios.slice(0, 2) = [s0, s1] while usable actions
// = [s0-action, s2-action]; s1 would be scored with s2's action. Confirm the
// tuple path does NOT reproduce that misalignment.
check(
  "buggy positional path would misalign (s1 paired with s2's action) — control",
  positionalUsable.length === 2 &&
    JSON.stringify(
      actionFromParsedJson(JSON.parse(positionalUsable[1].parsedResponseJson as string))
    ) === JSON.stringify(scenarios[2].expectedActions[0].action),
  positionalUsable.map((t) => t.scenarioId)
);
// And confirm the tuple path never assigns s2's action to s1's scenario slot.
check(
  "tuple path never pairs s1's scenario with s2's action",
  !replayScenarios.some((s) => s.id === scenarios[1].id),
  replayScenarios.map((s) => s.id)
);

/* ------------------------------------------------------------------------
 * POSITIONAL branch (B4.6): traces with NO scenarioId. resolvePackTraceReplay
 * takes the `else` branch, which (1) sorts by startedAt, (2) dedups by
 * promptHash keeping the LATEST recorded state, (3) index-pairs
 * dedupedTraces[i] <-> scenarios[i], then (4) filters out pairs whose trace is
 * empty. This section is the hermetic CI regression pin for that branch —
 * previously only exercised by the AIBoard-dependent
 * scripts/test-gameiq-replay-positional.mts (not runnable in CI).
 * ------------------------------------------------------------------------ */

// Reuse a fresh 3-scenario slice (real scenario ids/shapes from the pack) so
// each block below is independent and order-of-execution-proof.
const posScenarios: GameIqScenario[] = pack.scenarios.slice(0, 3);

function positionalTrace(
  scenario: GameIqScenario,
  opts: {
    startedAt: string;
    completedAt?: string;
    empty?: boolean;
    promptHash?: string;
    action?: unknown;
  }
): PackTraceRow {
  const action = opts.action ?? scenario.expectedActions[0].action;
  return {
    caseId: pack.id,
    startedAt: opts.startedAt,
    completedAt: opts.completedAt,
    // NO scenarioId: forces resolvePackTraceReplay into the positional branch.
    parsedResponseJson: opts.empty ? "" : JSON.stringify({ action }),
    rawResponse: opts.empty ? "provider transport failure" : undefined,
    promptHash: opts.promptHash,
  };
}

// --- Case A: mid-list gap (the B4.6 headline regression pin) ---
// [ok(s0), empty(s1), ok(s2)] with NO scenarioId. Under the OLD filter-then-
// slice logic, filtering first collapses to [s0-trace, s2-trace] and THEN
// slices positionally against [s0, s1] (first 2 scenarios) — s1 would
// inherit s2's action and s2 would be silently dropped. The fixed resolver
// index-pairs BEFORE filtering, so s1 alone drops and s2 keeps its own
// action.
{
  const gapTraces: PackTraceRow[] = [
    positionalTrace(posScenarios[0], { startedAt: "2026-07-03T00:00:00.000Z" }),
    positionalTrace(posScenarios[1], {
      startedAt: "2026-07-03T00:00:01.000Z",
      empty: true,
    }),
    positionalTrace(posScenarios[2], { startedAt: "2026-07-03T00:00:02.000Z" }),
  ];
  const gapSlicePack = { ...pack, scenarios: posScenarios };
  const gapResult = resolvePackTraceReplay(gapSlicePack, gapTraces);

  check(
    "positional mid-gap: s1 dropped, s0 and s2 survive in order",
    gapResult.replayScenarios.map((s) => s.id).join() ===
      [posScenarios[0].id, posScenarios[2].id].join(),
    gapResult.replayScenarios.map((s) => s.id)
  );
  check(
    "positional mid-gap: s0 keeps its OWN action",
    JSON.stringify(gapResult.actions[0]) ===
      JSON.stringify(posScenarios[0].expectedActions[0].action),
    { got: gapResult.actions[0] }
  );
  check(
    "positional mid-gap: s2 keeps its OWN action (NOT shifted into s1's slot)",
    JSON.stringify(gapResult.actions[1]) ===
      JSON.stringify(posScenarios[2].expectedActions[0].action),
    { got: gapResult.actions[1], expected: posScenarios[2].expectedActions[0].action }
  );
  check(
    "positional mid-gap: replayed=2, total=3, partial=true",
    gapResult.replayed === 2 && gapResult.total === 3 && gapResult.partial === true,
    gapResult
  );

  // Non-vacuity: reproduce the OLD filter-then-positional-slice and prove it
  // disagrees with the fixed resolver (i.e. this case would catch a revert).
  const oldUsable = gapTraces.filter(
    (t) => t.parsedResponseJson && t.parsedResponseJson.length > 0
  );
  const oldSliceScenarios = posScenarios.slice(0, oldUsable.length);
  const oldActionFor = (t: PackTraceRow): unknown =>
    (JSON.parse(t.parsedResponseJson as string) as { action: unknown }).action;
  check(
    "non-vacuity: OLD filter-then-slice would misattribute s2's action onto s1's slot (control)",
    oldSliceScenarios.map((s) => s.id).join() ===
      [posScenarios[0].id, posScenarios[1].id].join() &&
      JSON.stringify(oldActionFor(oldUsable[1])) ===
        JSON.stringify(posScenarios[2].expectedActions[0].action) &&
      JSON.stringify(oldActionFor(oldUsable[1])) !==
        JSON.stringify(posScenarios[1].expectedActions[0].action),
    {
      oldSliceScenarios: oldSliceScenarios.map((s) => s.id),
      oldSlot1Action: oldActionFor(oldUsable[1]),
    }
  );
}

// --- Case B: duplicate promptHash (the Spark connect-four retry case) ---
// Two traces share the SAME promptHash: an earlier empty/parse-error attempt
// and a later non-empty retry. Plus other distinct-hash traces. Dedup must
// collapse the pair to ONE (the later/non-empty), keeping the deduped count
// aligned to scenario count and pairing intact for all three scenarios.
{
  const dupHash = "hash-s1-retry";
  const dupTraces: PackTraceRow[] = [
    positionalTrace(posScenarios[0], {
      startedAt: "2026-07-03T00:00:00.000Z",
      promptHash: "hash-s0",
    }),
    // s1's FIRST attempt: empty/parse_error, earlier completedAt.
    positionalTrace(posScenarios[1], {
      startedAt: "2026-07-03T00:00:01.000Z",
      completedAt: "2026-07-03T00:00:01.500Z",
      empty: true,
      promptHash: dupHash,
    }),
    // s1's RETRY: same promptHash, later completedAt, has a real action.
    positionalTrace(posScenarios[1], {
      startedAt: "2026-07-03T00:00:01.700Z",
      completedAt: "2026-07-03T00:00:02.000Z",
      promptHash: dupHash,
    }),
    positionalTrace(posScenarios[2], {
      startedAt: "2026-07-03T00:00:03.000Z",
      promptHash: "hash-s2",
    }),
  ];
  const dupSlicePack = { ...pack, scenarios: posScenarios };
  const dupResult = resolvePackTraceReplay(dupSlicePack, dupTraces);

  check(
    "positional dedup: all three scenarios replayed (duplicate collapsed to one)",
    dupResult.replayScenarios.map((s) => s.id).join() ===
      posScenarios.map((s) => s.id).join(),
    dupResult.replayScenarios.map((s) => s.id)
  );
  check(
    "positional dedup: replayed=3, total=3, partial=false",
    dupResult.replayed === 3 && dupResult.total === 3 && dupResult.partial === false,
    dupResult
  );
  check(
    "positional dedup: s1 gets the LATER/non-empty retry action, not dropped",
    JSON.stringify(dupResult.actions[1]) ===
      JSON.stringify(posScenarios[1].expectedActions[0].action),
    { got: dupResult.actions[1], expected: posScenarios[1].expectedActions[0].action }
  );
  check(
    "positional dedup: s0 and s2 are not shifted by the duplicate",
    JSON.stringify(dupResult.actions[0]) ===
      JSON.stringify(posScenarios[0].expectedActions[0].action) &&
      JSON.stringify(dupResult.actions[2]) ===
        JSON.stringify(posScenarios[2].expectedActions[0].action),
    { got: [dupResult.actions[0], dupResult.actions[2]] }
  );
}

// --- Case C: all-usable, no gaps (sanity/baseline) ---
{
  const cleanTraces: PackTraceRow[] = posScenarios.map((scenario, i) =>
    positionalTrace(scenario, {
      startedAt: `2026-07-03T00:01:0${i}.000Z`,
      promptHash: `hash-clean-${i}`,
    })
  );
  const cleanSlicePack = { ...pack, scenarios: posScenarios };
  const cleanResult = resolvePackTraceReplay(cleanSlicePack, cleanTraces);

  check(
    "positional all-usable: replayed equals total, partial=false",
    cleanResult.replayed === cleanResult.total && cleanResult.partial === false,
    cleanResult
  );
  check(
    "positional all-usable: every scenario gets its OWN action",
    posScenarios.every(
      (scenario, i) =>
        JSON.stringify(cleanResult.actions[i]) ===
        JSON.stringify(scenario.expectedActions[0].action)
    ),
    cleanResult.actions
  );
}

// --- Case D (optional): trailing gap — matches legacy files' shape ---
// [ok(s0), ok(s1), empty(s2)]: the last scenario is dropped, earlier ones
// intact (confirms trailing gaps, not just mid-list gaps, still work).
{
  const trailingTraces: PackTraceRow[] = [
    positionalTrace(posScenarios[0], { startedAt: "2026-07-03T00:02:00.000Z" }),
    positionalTrace(posScenarios[1], { startedAt: "2026-07-03T00:02:01.000Z" }),
    positionalTrace(posScenarios[2], {
      startedAt: "2026-07-03T00:02:02.000Z",
      empty: true,
    }),
  ];
  const trailingSlicePack = { ...pack, scenarios: posScenarios };
  const trailingResult = resolvePackTraceReplay(trailingSlicePack, trailingTraces);

  check(
    "positional trailing gap: s0 and s1 survive, s2 dropped",
    trailingResult.replayScenarios.map((s) => s.id).join() ===
      [posScenarios[0].id, posScenarios[1].id].join(),
    trailingResult.replayScenarios.map((s) => s.id)
  );
  check(
    "positional trailing gap: replayed=2, total=3, partial=true",
    trailingResult.replayed === 2 &&
      trailingResult.total === 3 &&
      trailingResult.partial === true,
    trailingResult
  );
}

console.log(failures === 0 ? "PASS" : `FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
