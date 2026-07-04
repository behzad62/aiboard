/* Frontier leaderboard: per-model, per-pack scores recomputed EXCLUDING
 * saturated scenarios, from exported run files.
 *
 * Usage: npx tsx scripts/report-gameiq-frontier.mts <run1.json> <run2.json> ...
 *
 * Every scenario in GAMEIQ_SATURATED_SCENARIO_IDS (lib/benchmark/gameiq/
 * saturation.ts) was solved by every one of the four 2026-07 reference
 * models — it carries zero discrimination signal. This report replays each
 * run file's recorded traces through the real v0.3 scorer (the same
 * resolvePackTraceReplay + runGameIqScenarios path used by the replay CLI
 * and the saturation generator), then filters the per-scenario caseResults
 * down to only the UNSATURATED scenarios and re-aggregates metrics/score
 * over that subset via aggregateGameIqMetrics + scoreGameIqAttempt. That
 * produces a "frontier score": how a model does on the scenarios that still
 * separate frontier models from each other, instead of being padded by
 * scenarios every model already aces.
 *
 * Read-only ANALYSIS tool (like replay-gameiq-traces.mts / audit-gameiq-
 * consensus.mts): it prints a report and writes nothing.
 */
import { readFileSync } from "node:fs";
import {
  GAMEIQ_SATURATED_SCENARIO_IDS,
  aggregateGameIqMetrics,
  listGameIqScenarioPacks,
  resolvePackTraceReplay,
  runGameIqScenarios,
  type PackTraceRow,
} from "../lib/benchmark/gameiq";
import { scoreGameIqAttempt } from "../lib/benchmark/scoring/gameiq";
import type { GameIqScenarioResult } from "../lib/benchmark/gameiq";

interface PackFrontierRow {
  packId: string;
  label: string;
  fullScore: number;
  fullScoredCount: number;
  frontierScore: number | null;
  frontierScoredCount: number;
}

interface ModelReport {
  modelId: string;
  rows: PackFrontierRow[];
}

async function scoreCaseResults(
  modelId: string,
  packId: string,
  caseResults: GameIqScenarioResult[]
): Promise<{ score: number; scoredCount: number }> {
  // Re-aggregate over an arbitrary (possibly filtered) subset of already-
  // scored caseResults — no provider calls, no re-running scenarios. This is
  // exactly what aggregateGameIqMetrics + scoreGameIqAttempt were extracted
  // from runGameIqScenarios for.
  const metrics = aggregateGameIqMetrics(caseResults);
  return { score: scoreGameIqAttempt(metrics), scoredCount: metrics.scoredScenarioCount };
}

async function reportForRunFile(file: string): Promise<ModelReport> {
  const bundle = JSON.parse(readFileSync(file, "utf8"));
  const modelId: string | undefined = bundle.runs?.[0]?.modelIds?.[0];
  if (!modelId) {
    throw new Error(`Run file ${file} has no runs[0].modelIds[0].`);
  }
  const traces: PackTraceRow[] = bundle.traces ?? [];
  const packs = listGameIqScenarioPacks();
  const rows: PackFrontierRow[] = [];

  for (const pack of packs) {
    const packTraces = traces.filter((trace) => trace.caseId === pack.id);
    if (packTraces.length === 0) continue;

    const { replayScenarios, actions } = resolvePackTraceReplay(pack, packTraces);
    if (replayScenarios.length === 0) continue;

    let cursor = 0;
    const result = await runGameIqScenarios({
      runId: "frontier-report",
      modelId,
      teamCompositionId: "frontier-report",
      caseId: pack.id,
      scenarios: replayScenarios,
      moveProvider: () => ({ action: actions[cursor++] }),
    });

    const frontierResults = result.caseResults.filter(
      (caseResult) => !GAMEIQ_SATURATED_SCENARIO_IDS.has(caseResult.scenarioId)
    );

    const full = await scoreCaseResults(modelId, pack.id, result.caseResults);
    const hasUnsaturated = frontierResults.length > 0;
    const frontier = hasUnsaturated
      ? await scoreCaseResults(modelId, pack.id, frontierResults)
      : null;

    rows.push({
      packId: pack.id,
      label: pack.label,
      fullScore: full.score,
      fullScoredCount: full.scoredCount,
      frontierScore: frontier ? frontier.score : null,
      frontierScoredCount: frontier ? frontier.scoredCount : 0,
    });
  }

  return { modelId, rows };
}

function padLeft(value: string, width: number): string {
  return value.length >= width ? value : " ".repeat(width - value.length) + value;
}

function padRight(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function formatScore(score: number | null): string {
  return score === null ? "n/a" : score.toFixed(1);
}

function shortPackLabel(label: string): string {
  return label.replace("Certified GameIQ v1: ", "").replace("Certified GameIQ ", "");
}

async function main(): Promise<void> {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.log(
      "Usage: npx tsx scripts/report-gameiq-frontier.mts <run1.json> <run2.json> ..."
    );
    process.exit(2);
  }

  const reports: ModelReport[] = [];
  for (const file of files) {
    reports.push(await reportForRunFile(file));
  }

  const packOrder = listGameIqScenarioPacks().map((pack) => ({
    id: pack.id,
    label: pack.label,
  }));

  console.log("\n=== GameIQ frontier report (saturation-excluded scoring) ===");
  console.log(
    `Models: ${reports.map((report) => report.modelId).join(", ")}`
  );
  console.log(
    `Saturated scenario ids excluded from the frontier score: ${GAMEIQ_SATURATED_SCENARIO_IDS.size}\n`
  );

  // --- Per-pack, per-model full vs frontier table -----------------------
  for (const pack of packOrder) {
    console.log(`--- ${shortPackLabel(pack.label)} (${pack.id}) ---`);
    for (const report of reports) {
      const row = report.rows.find((candidate) => candidate.packId === pack.id);
      if (!row) {
        console.log(`  ${padRight(report.modelId, 34)} no replayable traces for this pack`);
        continue;
      }
      const zeroUnsaturated = row.frontierScore === null;
      const frontierText = zeroUnsaturated
        ? "no unsaturated scenarios — fully saturated, no frontier signal"
        : `frontier ${padLeft(formatScore(row.frontierScore), 6)} over ${row.frontierScoredCount} unsaturated`;
      console.log(
        `  ${padRight(report.modelId, 34)} full ${padLeft(formatScore(row.fullScore), 6)} over ${padLeft(
          String(row.fullScoredCount),
          3
        )} scored  /  ${frontierText}`
      );
    }
    console.log("");
  }

  // --- Overall frontier ranking: average frontier score across packs that --
  // --- actually had unsaturated scenarios for that model, per model. -------
  console.log("=== Overall FRONTIER ranking (avg frontier score across packs with unsaturated scenarios) ===");
  const ranking = reports
    .map((report) => {
      const scored = report.rows.filter((row) => row.frontierScore !== null);
      const avgFrontier =
        scored.length > 0
          ? scored.reduce((sum, row) => sum + (row.frontierScore as number), 0) /
            scored.length
          : null;
      const scoredFull = report.rows.filter((row) => row.fullScoredCount > 0);
      const avgFull =
        scoredFull.length > 0
          ? scoredFull.reduce((sum, row) => sum + row.fullScore, 0) / scoredFull.length
          : null;
      return {
        modelId: report.modelId,
        avgFrontier,
        avgFull,
        packsWithSignal: scored.length,
        packsTotal: report.rows.length,
      };
    })
    .sort((a, b) => (b.avgFrontier ?? -1) - (a.avgFrontier ?? -1));

  for (const entry of ranking) {
    console.log(
      `  ${padRight(entry.modelId, 34)} frontier avg ${padLeft(
        formatScore(entry.avgFrontier),
        6
      )}  (full avg ${padLeft(formatScore(entry.avgFull), 6)})  across ${entry.packsWithSignal}/${entry.packsTotal} packs with unsaturated scenarios`
    );
  }

  // --- Spread check: does frontier scoring separate the models MORE than ---
  // --- full scoring did? -----------------------------------------------
  const frontierValues = ranking
    .map((entry) => entry.avgFrontier)
    .filter((value): value is number => value !== null);
  const fullValues = ranking
    .map((entry) => entry.avgFull)
    .filter((value): value is number => value !== null);
  if (frontierValues.length > 1 && fullValues.length > 1) {
    const frontierSpread = Math.max(...frontierValues) - Math.min(...frontierValues);
    const fullSpread = Math.max(...fullValues) - Math.min(...fullValues);
    console.log(
      `\nSpread across models: full avg-score spread = ${fullSpread.toFixed(
        1
      )} pts, frontier avg-score spread = ${frontierSpread.toFixed(1)} pts` +
        (frontierSpread > fullSpread
          ? " (frontier scoring separates the models MORE than full scoring)."
          : " (frontier scoring did NOT widen the spread versus full scoring).")
    );
  }

  // --- Zero-unsaturated pack flags ---------------------------------------
  console.log("\n=== Packs with ZERO unsaturated scenarios (no frontier signal) ===");
  const zeroSignalPacks = packOrder.filter((pack) =>
    reports.every((report) => {
      const row = report.rows.find((candidate) => candidate.packId === pack.id);
      return !row || row.frontierScore === null;
    })
  );
  if (zeroSignalPacks.length === 0) {
    console.log("  (none — every pack retains at least one unsaturated scenario for at least one model)");
  } else {
    for (const pack of zeroSignalPacks) {
      console.log(`  ${pack.id} — ${shortPackLabel(pack.label)}: no unsaturated scenarios — fully saturated, no frontier signal`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
