/* Replay recorded GameIQ traces from exported benchmark run files through the
 * real runGameIqScenarios scorer, recovering per-scenario verdicts for runs
 * whose verifier results were voided (provider_unavailable).
 * Run: npx tsx scripts/replay-gameiq-traces.mts <run-file.json> [...more]
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  listGameIqScenarioPacks,
  runGameIqScenarios,
} from "../lib/benchmark/gameiq";

interface TraceRow {
  caseId: string;
  startedAt: string;
  parsedResponseJson?: string | null;
  rawResponse?: string | null;
  latencyMs?: number;
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
const packById = new Map(packs.map((p) => [p.id, p]));

const out: Record<string, unknown> = {};

for (const file of process.argv.slice(2)) {
  const run = JSON.parse(readFileSync(file, "utf8"));
  const model: string = run.runs[0].modelIds;
  const traces: TraceRow[] = run.traces;
  const perCase: Record<string, unknown> = {};

  for (const pack of packs) {
    const caseTraces = traces
      .filter((t) => t.caseId === pack.id)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    if (caseTraces.length === 0) continue;

    // usable = traces whose parsedResponseJson is non-empty (the dying call
    // records an empty response)
    const usable = caseTraces.filter(
      (t) => t.parsedResponseJson && t.parsedResponseJson.length > 0
    );
    const n = Math.min(usable.length, pack.scenarios.length);
    const scenarios = pack.scenarios.slice(0, n);
    const actions = usable.slice(0, n).map((t) => {
      try {
        return actionFromParsedJson(JSON.parse(t.parsedResponseJson as string));
      } catch {
        return t.rawResponse ?? null;
      }
    });

    let i = 0;
    const result = await runGameIqScenarios({
      runId: "replay",
      modelId: model,
      teamCompositionId: "replay",
      scenarios,
      moveProvider: () => ({ action: actions[i++] }),
    });

    perCase[pack.id] = {
      label: pack.label,
      scenarioTotal: pack.scenarios.length,
      replayed: n,
      partial: n < pack.scenarios.length,
      score: result.score,
      status: result.attempt.status,
      metrics: {
        correct: result.metrics.correctActions,
        legal: result.metrics.legalActions,
        structured: result.metrics.structuredActions,
        forbiddenBlunders: result.metrics.forbiddenBlunders,
      },
      scenarios: result.caseResults.map((r) => ({
        id: r.scenarioId,
        passed: r.legal && r.correct,
        legal: r.legal,
        structured: r.structured,
        forbiddenBlunder: r.forbiddenBlunder,
        quality: r.actionQuality,
      })),
    };
  }
  out[model] = perCase;
}

writeFileSync(process.env.REPLAY_OUT ?? "replay-out.json", JSON.stringify(out, null, 2));

for (const [model, cases] of Object.entries(out)) {
  console.log(`\n=== ${model} (replayed) ===`);
  for (const [id, c] of Object.entries(cases as Record<string, any>)) {
    console.log(
      `  ${String(c.label).replace("Certified GameIQ v1: ", "").padEnd(30)} score=${String(c.score).padStart(6)} status=${c.status}${c.partial ? ` PARTIAL ${c.replayed}/${c.scenarioTotal}` : ""} correct=${c.metrics.correct}/${c.replayed}`
    );
  }
}
