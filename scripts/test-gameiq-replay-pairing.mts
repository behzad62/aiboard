/* Regression guard for the B4 replay scenarioId pairing (run: npx tsx
 * scripts/test-gameiq-replay-pairing.mts).
 *
 * Pins the bug the 2026-07-03 quality review reproduced: when a MIDDLE
 * scenario's trace has an empty parsedResponseJson (a failed transport call,
 * which B4 runs record WITH a scenarioId at model-call.ts's error trace site),
 * a filter-then-positional-slice collapses past the gap — the failed scenario
 * inherits its neighbor's action (scored WRONG) and a good trailing scenario
 * is silently dropped. The fix pairs scenario↔trace as TUPLES keyed by
 * scenarioId and filters the tuples, so a dropped middle trace removes exactly
 * its own scenario and never shifts the others. This test replicates that
 * id-keyed tuple pairing (the exact logic used in replay-gameiq-traces.mts's
 * hasScenarioIds branch) and asserts s0/s2 keep their OWN actions while s1 is
 * skipped.
 */
import {
  getGameIqScenarioPack,
  runGameIqScenarios,
  type GameIqScenario,
} from "../lib/benchmark/gameiq";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

interface TraceRow {
  caseId: string;
  startedAt: string;
  parsedResponseJson?: string | null;
  rawResponse?: string | null;
  scenarioId?: string;
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

const traceFor = (scenario: GameIqScenario, empty: boolean): TraceRow => ({
  caseId: pack.id,
  startedAt: `2026-07-03T00:00:0${scenarios.indexOf(scenario)}.000Z`,
  scenarioId: scenario.id,
  parsedResponseJson: empty
    ? "" // failed transport call: dying call records an empty response
    : JSON.stringify({ action: scenario.expectedActions[0].action }),
  rawResponse: empty ? "provider transport failure" : undefined,
});

// All three traces carry a scenarioId; only the MIDDLE one (s1) is empty.
const packTraces: TraceRow[] = [
  traceFor(scenarios[0], false),
  traceFor(scenarios[1], true),
  traceFor(scenarios[2], false),
];

// --- Replicate replay-gameiq-traces.mts hasScenarioIds tuple pairing ---
const byScenarioId = new Map<string, TraceRow>();
for (const trace of packTraces) {
  if (!trace.scenarioId) continue;
  const existing = byScenarioId.get(trace.scenarioId);
  if (!existing || trace.startedAt.localeCompare(existing.startedAt) > 0) {
    byScenarioId.set(trace.scenarioId, trace);
  }
}
const keyed = pack.scenarios.filter((s) => byScenarioId.has(s.id));
const usablePairs = keyed
  .map((scenario) => ({ scenario, trace: byScenarioId.get(scenario.id)! }))
  .filter(
    ({ trace }) =>
      trace && trace.parsedResponseJson && trace.parsedResponseJson.length > 0
  );
const replayScenarios = usablePairs.map((p) => p.scenario);
const actions = usablePairs.map(({ trace }) => {
  try {
    return actionFromParsedJson(JSON.parse(trace.parsedResponseJson as string));
  } catch {
    return trace.rawResponse ?? null;
  }
});

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

console.log(failures === 0 ? "PASS" : `FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
