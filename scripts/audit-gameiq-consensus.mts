/* Multi-model convergence audit: flag scenarios where 2+ models converged on
 * the same NON-keyed answer (an oracle-narrowness signal), across all packs,
 * using recorded traces from exported benchmark run files.
 * Run: npx tsx scripts/audit-gameiq-consensus.mts <run-file.json> [...more]
 */
import { readFileSync } from "node:fs";
import { listGameIqScenarioPacks, stableStringify } from "../lib/benchmark/gameiq";
import { actionMatchesExpected } from "../lib/benchmark/gameiq/validation";
import type { GameIqScenario } from "../lib/benchmark/gameiq/types";

interface TraceRow {
  caseId: string;
  startedAt: string;
  parsedResponseJson?: string | null;
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

const packs = listGameIqScenarioPacks();
// scenarioId -> { scenario, answers: Map<modelId, action> }
const table = new Map<
  string,
  { scenario: GameIqScenario; answers: Map<string, unknown> }
>();

for (const file of process.argv.slice(2)) {
  const run = JSON.parse(readFileSync(file, "utf8"));
  const model: string = String(run.runs[0].modelIds);
  const traces: TraceRow[] = run.traces;
  for (const pack of packs) {
    const caseTraces = traces
      .filter((t) => t.caseId === pack.id)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .filter((t) => t.parsedResponseJson && t.parsedResponseJson.length > 0);
    const n = Math.min(caseTraces.length, pack.scenarios.length);
    for (let i = 0; i < n; i++) {
      const scenario = pack.scenarios[i];
      let action: unknown;
      try {
        action = actionFromParsedJson(JSON.parse(caseTraces[i].parsedResponseJson as string));
      } catch {
        continue;
      }
      const row = table.get(scenario.id) ?? { scenario, answers: new Map() };
      row.answers.set(model, action);
      table.set(scenario.id, row);
    }
  }
}

console.log("Scenarios where 2+ models converged on the same NON-keyed answer:\n");
let flagged = 0;
for (const [id, row] of table) {
  // group identical answers
  const groups = new Map<string, { action: unknown; models: string[] }>();
  for (const [model, action] of row.answers) {
    const key = stableStringify(action);
    const group = groups.get(key) ?? { action, models: [] };
    group.models.push(model);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.models.length < 2) continue;
    const quality = actionMatchesExpected(row.scenario, group.action);
    if (quality > 0) continue; // keyed (full or partial credit) — fine
    flagged++;
    const expected = row.scenario.expectedActions
      .map((e) => `${JSON.stringify(e.action)}@${e.weight}`)
      .join(" | ");
    console.log(`${id}`);
    console.log(`  consensus (${group.models.length}): ${JSON.stringify(group.action)}  models: ${group.models.join(", ")}`);
    console.log(`  keyed: ${expected}`);
    if (row.scenario.forbiddenActions?.length) {
      console.log(`  forbidden: ${row.scenario.forbiddenActions.map((f) => JSON.stringify(f)).join(" | ")}`);
    }
    console.log();
  }
}
console.log(`${flagged} convergence flag(s) across ${table.size} scenarios with 2+ model answers.`);
