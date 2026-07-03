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

const packs = listGameIqScenarioPacks();
const packById = new Map(packs.map((p) => [p.id, p]));

const runFiles = process.argv.slice(2);
if (runFiles.length === 0) {
  console.log("Usage: npx tsx scripts/replay-gameiq-traces.mts <run-file.json> [...more]");
  process.exit(2);
}

const out: Record<string, unknown> = {};

for (const file of runFiles) {
  const run = JSON.parse(readFileSync(file, "utf8"));
  const model: string = run.runs[0].modelIds;
  const traces: TraceRow[] = run.traces;
  const perCase: Record<string, unknown> = {};

  for (const pack of packs) {
    const packTraces = traces.filter((t) => t.caseId === pack.id);
    if (packTraces.length === 0) continue;

    // Prefer scenarioId when the pack's traces carry it (B4+ run files):
    // pair each scenario to its own trace by id, using the LAST trace by
    // startedAt when a scenario has multiple traces (retries) — the final
    // attempt is the scored one.
    const hasScenarioIds = packTraces.some((t) => Boolean(t.scenarioId));
    let replayScenarios;
    let actions: unknown[];
    if (hasScenarioIds) {
      const byScenarioId = new Map<string, TraceRow>();
      for (const trace of packTraces) {
        if (!trace.scenarioId) continue;
        const existing = byScenarioId.get(trace.scenarioId);
        if (!existing || trace.startedAt.localeCompare(existing.startedAt) > 0) {
          byScenarioId.set(trace.scenarioId, trace);
        }
      }
      const scenarios = pack.scenarios.filter((s) => byScenarioId.has(s.id));
      // Pair scenario↔trace as tuples and filter the TUPLES: a scenario whose
      // trace has an empty parsedResponseJson (a failed transport call, which
      // B4 runs record WITH a scenarioId at model-call.ts's error trace site)
      // drops exactly its own tuple and never shifts its neighbors' actions.
      // (A filter-then-positional-slice would collapse past a middle gap and
      // misattribute every trailing scenario — the exact fragility scenarioId
      // exists to eliminate.)
      const usablePairs = scenarios
        .map((scenario) => ({ scenario, trace: byScenarioId.get(scenario.id)! }))
        .filter(
          ({ trace }) =>
            trace && trace.parsedResponseJson && trace.parsedResponseJson.length > 0
        );
      replayScenarios = usablePairs.map((p) => p.scenario);
      actions = usablePairs.map(({ trace }) => {
        try {
          return actionFromParsedJson(JSON.parse(trace.parsedResponseJson as string));
        } catch {
          return trace.rawResponse ?? null;
        }
      });
    } else {
      // Positional pairing assumes one trace per scenario in scenario order —
      // valid only for pre-B4 sequential run files; newer files use
      // scenarioId. Pre-B4 run files have no scenarioId; positional pairing
      // is correct for them because they were recorded sequentially, one
      // trace per scenario.
      const orderedTraces = [...packTraces].sort((a, b) =>
        a.startedAt.localeCompare(b.startedAt)
      );
      const scenarios = pack.scenarios.slice(0, orderedTraces.length);
      // usable = traces whose parsedResponseJson is non-empty (the dying call
      // records an empty response)
      const usable = orderedTraces.filter(
        (t) => t.parsedResponseJson && t.parsedResponseJson.length > 0
      );
      const n = Math.min(usable.length, scenarios.length);
      replayScenarios = scenarios.slice(0, n);
      actions = usable.slice(0, n).map((t) => {
        try {
          return actionFromParsedJson(JSON.parse(t.parsedResponseJson as string));
        } catch {
          return t.rawResponse ?? null;
        }
      });
    }
    const n = replayScenarios.length;

    let i = 0;
    const result = await runGameIqScenarios({
      runId: "replay",
      modelId: model,
      teamCompositionId: "replay",
      scenarios: replayScenarios,
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
