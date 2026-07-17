/* Replay recorded GameIQ traces from exported benchmark run files through the
 * real runGameIqScenarios scorer, recovering per-scenario verdicts for runs
 * whose verifier results were voided (provider_unavailable).
 * Run: npx tsx scripts/replay-gameiq-traces.mts <run-file.json> [...more]
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  listGameIqScenarioPacks,
  resolvePackTraceReplay,
  runGameIqScenarios,
  type PackTraceRow,
} from "../lib/benchmark/gameiq";

type TraceRow = PackTraceRow;

const packs = listGameIqScenarioPacks();

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

  // Graceful unknown-caseId guard: a historical run file can still carry
  // traces for a pack that has since been hard-deleted (e.g. the v0.1
  // battleship/chess/connect-four packs removed 2026-07-17). SKIP them with a
  // clear console note instead of throwing — there is no pack left to replay
  // them against.
  const knownPackIds = new Set(packs.map((pack) => pack.id));
  const traceCaseIds = new Set(traces.map((trace) => trace.caseId));
  for (const caseId of traceCaseIds) {
    if (knownPackIds.has(caseId)) continue;
    const traceCount = traces.filter((trace) => trace.caseId === caseId).length;
    console.log(`pack ${caseId} no longer exists — skipped ${traceCount} traces`);
  }

  for (const pack of packs) {
    const packTraces = traces.filter((t) => t.caseId === pack.id);
    if (packTraces.length === 0) continue;

    const { replayScenarios, actions, replayed: n } = resolvePackTraceReplay(
      pack,
      packTraces
    );

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

interface PrintedCase {
  label: string;
  score: number;
  status: string;
  partial: boolean;
  replayed: number;
  scenarioTotal: number;
  metrics: { correct: number };
}

for (const [model, cases] of Object.entries(out)) {
  console.log(`\n=== ${model} (replayed) ===`);
  for (const c of Object.values(cases as Record<string, PrintedCase>)) {
    console.log(
      `  ${String(c.label).replace("Certified GameIQ v1: ", "").padEnd(30)} score=${String(c.score).padStart(6)} status=${c.status}${c.partial ? ` PARTIAL ${c.replayed}/${c.scenarioTotal}` : ""} correct=${c.metrics.correct}/${c.replayed}`
    );
  }
}
