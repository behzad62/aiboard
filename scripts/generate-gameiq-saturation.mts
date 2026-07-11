/* Regenerates lib/benchmark/gameiq/saturation.ts from exported run files.
 *
 * Usage:
 *   npx tsx scripts/generate-gameiq-saturation.mts [--prior lib/benchmark/gameiq/saturation.ts] <run1.json> <run2.json> ... > lib/benchmark/gameiq/saturation.ts
 *
 * For each run file we read runs[0].modelIds[0] (the model id) and its recorded
 * model-call traces, then for every pack in listGameIqScenarioPacks() we replay
 * the pack's traces through the REAL v0.3 scorer (resolvePackTraceReplay +
 * runGameIqScenarios) — the SAME uniform path used by the replay/recovery CLIs,
 * so completed and recovered/partial runs are treated identically. Each scored
 * (not `unscored`) caseResult contributes a per-(scenario, model) `correct`
 * verdict.
 *
 * WITHOUT --prior (clean-slate generation): a scenario is SATURATED when at
 * least GAMEIQ_SATURATION_MIN_MODELS distinct models have a verdict for it AND
 * every one of those verdicts is correct.
 *
 * WITH --prior <path> (evidence-cumulative pruning): the prior registry's id
 * set is read from <path> AS TEXT (the ids inside its `new Set([...])`
 * literal — deliberately not an import, so the flag honors the actual path
 * argument and keeps working after this script's output overwrites the file).
 * New evidence can only REMOVE saturation:
 *   saturated_new = prior_ids MINUS { id | ANY fresh run's replayed verdict
 *                                          for id is incorrect }
 * Scenarios whose fresh verdicts are all-correct but that were NOT previously
 * saturated stay OUT (the prior exclusion recorded a failure whose per-model
 * evidence is gone — the conservative call is to trust it). Scenarios with NO
 * fresh verdicts (e.g. battleship, excluded from the default bundle) keep
 * their prior status. Re-running --prior against the freshly written file
 * with the same run files is therefore a NO-OP unless new contradictions
 * exist (the output is a fixed point).
 *
 * The emitted module is DETERMINISTIC and byte-stable: ids and run-summary
 * lines are sorted and no wall-clock timestamp is written, so re-running the
 * generator over the same inputs produces a byte-identical file (clean diff).
 * A human-readable pruning summary (removed ids per pack, failing models)
 * goes to STDERR so stdout stays a clean module.
 */
import { readFileSync } from "node:fs";
import {
  GAMEIQ_CORRECT_QUALITY_BAR,
  GAMEIQ_SCORING_VERSION,
  listGameIqScenarioPacks,
  resolvePackTraceReplay,
  runGameIqScenarios,
  type PackTraceRow,
} from "../lib/benchmark/gameiq";

const GAMEIQ_SATURATION_MIN_MODELS = 3;

interface RunSummary {
  runId: string;
  modelId: string;
  scenarioVerdicts: number;
  packsContributing: number;
}

function loadPriorSaturatedIds(path: string): Set<string> {
  const text = readFileSync(path, "utf8");
  const block = text.match(
    /GAMEIQ_SATURATED_SCENARIO_IDS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/
  );
  if (!block) {
    throw new Error(
      `--prior file ${path} has no GAMEIQ_SATURATED_SCENARIO_IDS = new Set([...]) literal.`
    );
  }
  const ids = [...block[1].matchAll(/"([^"\n]+)"/g)].map((match) => match[1]);
  if (ids.length === 0) {
    throw new Error(`--prior file ${path} parsed to zero saturated ids.`);
  }
  return new Set(ids);
}

function parseArgs(argv: string[]): { priorPath: string | null; files: string[] } {
  let priorPath: string | null = null;
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--prior") {
      const next = argv[i + 1];
      if (!next) {
        console.error("--prior requires a path argument.");
        process.exit(2);
      }
      priorPath = next;
      i++;
    } else {
      files.push(argv[i]);
    }
  }
  return { priorPath, files };
}

async function main(): Promise<void> {
  const { priorPath, files } = parseArgs(process.argv.slice(2));
  if (files.length === 0) {
    console.error(
      "Usage: npx tsx scripts/generate-gameiq-saturation.mts [--prior lib/benchmark/gameiq/saturation.ts] <run1.json> <run2.json> ... > lib/benchmark/gameiq/saturation.ts"
    );
    process.exit(2);
  }
  const priorIds = priorPath ? loadPriorSaturatedIds(priorPath) : null;

  const packs = listGameIqScenarioPacks();
  // scenarioId -> modelId -> correct (last write wins per model; used for the
  // clean-slate all-correct criterion).
  const verdicts = new Map<string, Map<string, boolean>>();
  // scenarioId -> modelIds with ANY incorrect fresh verdict (across ALL files,
  // so a model failing in one run contradicts saturation even if a second run
  // of the same model solved the scenario).
  const freshFailures = new Map<string, Set<string>>();
  const runSummaries: RunSummary[] = [];

  for (const file of files) {
    const bundle = JSON.parse(readFileSync(file, "utf8"));
    const runId: string = bundle.runs?.[0]?.id ?? file;
    const modelId: string | undefined = bundle.runs?.[0]?.modelIds?.[0];
    if (!modelId) {
      throw new Error(`Run file ${file} has no runs[0].modelIds[0].`);
    }
    const traces: PackTraceRow[] = bundle.traces ?? [];

    let scenarioVerdicts = 0;
    let packsContributing = 0;
    for (const pack of packs) {
      const packTraces = traces.filter((trace) => trace.caseId === pack.id);
      if (packTraces.length === 0) continue;
      const { replayScenarios, actions } = resolvePackTraceReplay(
        pack,
        packTraces
      );
      if (replayScenarios.length === 0) continue;
      let cursor = 0;
      const result = await runGameIqScenarios({
        runId: "saturation-replay",
        modelId,
        teamCompositionId: "saturation-replay",
        caseId: pack.id,
        scenarios: replayScenarios,
        moveProvider: () => ({ action: actions[cursor++] }),
      });
      let packContributed = false;
      for (const caseResult of result.caseResults) {
        if (caseResult.unscored) continue;
        packContributed = true;
        scenarioVerdicts++;
        let modelMap = verdicts.get(caseResult.scenarioId);
        if (!modelMap) {
          modelMap = new Map();
          verdicts.set(caseResult.scenarioId, modelMap);
        }
        modelMap.set(modelId, caseResult.correct);
        if (!caseResult.correct) {
          let failed = freshFailures.get(caseResult.scenarioId);
          if (!failed) {
            failed = new Set();
            freshFailures.set(caseResult.scenarioId, failed);
          }
          failed.add(modelId);
        }
      }
      if (packContributed) packsContributing++;
    }

    runSummaries.push({ runId, modelId, scenarioVerdicts, packsContributing });
  }

  let saturatedIds: string[];
  if (priorIds) {
    saturatedIds = [...priorIds]
      .filter((id) => !freshFailures.has(id))
      .sort();
  } else {
    saturatedIds = [];
    for (const [scenarioId, modelMap] of verdicts) {
      if (modelMap.size < GAMEIQ_SATURATION_MIN_MODELS) continue;
      if ([...modelMap.values()].every((correct) => correct === true)) {
        saturatedIds.push(scenarioId);
      }
    }
    saturatedIds.sort();
  }

  const sortedSummaries = [...runSummaries].sort(
    (a, b) => a.modelId.localeCompare(b.modelId) || a.runId.localeCompare(b.runId)
  );
  const runLines = sortedSummaries.map(
    (summary) =>
      `//   ${summary.modelId} (${summary.runId}) — ${summary.scenarioVerdicts} scenarios across ${summary.packsContributing} packs`
  );
  const idLines = saturatedIds.map((id) => `  ${JSON.stringify(id)},`);

  const provenanceLines = priorIds
    ? [
        "// Provenance (evidence-cumulative pruning): the prior committed registry —",
        "// originally generated clean-slate from the four 2026-07 reference runs,",
        "// whose run files have since been deleted — MINUS every scenario ANY fresh",
        "// model's replayed verdict got wrong. Fresh evidence can only REMOVE",
        "// saturation (one failure proves a scenario non-trivial); scenarios with no",
        "// fresh verdicts (battleship — excluded from the default bundle) keep their",
        "// prior status. Re-running --prior against THIS file with the same fresh",
        "// runs is a no-op unless new contradictions exist.",
        "// Fresh source runs (model — run id):",
        ...runLines,
        `// Refined using ${sortedSummaries.length} fresh runs; a prior id is removed when any fresh model's verdict for it is incorrect.`,
      ]
    : [
        "// Source runs (model — run id):",
        ...runLines,
        `// Generated from ${sortedSummaries.length} runs; a scenario is listed when >= ${GAMEIQ_SATURATION_MIN_MODELS} models attempted it and ALL solved it.`,
      ];

  const out = [
    "// AUTO-GENERATED by scripts/generate-gameiq-saturation.mts — DO NOT hand-edit.",
    "// Regenerate: npx tsx scripts/generate-gameiq-saturation.mts [--prior lib/benchmark/gameiq/saturation.ts] <run files...> > lib/benchmark/gameiq/saturation.ts",
    ...provenanceLines,
    `// Definition: correct = actionQuality >= GAMEIQ_CORRECT_QUALITY_BAR (${GAMEIQ_CORRECT_QUALITY_BAR}) under scoring ${GAMEIQ_SCORING_VERSION}.`,
    `export const GAMEIQ_SATURATION_MIN_MODELS = ${GAMEIQ_SATURATION_MIN_MODELS};`,
    "export const GAMEIQ_SATURATED_SCENARIO_IDS: ReadonlySet<string> = new Set([",
    ...idLines,
    "]);",
    "",
  ].join("\n");

  process.stdout.write(out);

  if (priorIds) {
    const scenarioPackId = new Map<string, string>();
    for (const pack of packs) {
      for (const scenario of pack.scenarios) {
        scenarioPackId.set(scenario.id, pack.id);
      }
    }
    const removed = [...priorIds].filter((id) => freshFailures.has(id)).sort();
    console.error(
      `[saturation] prior ${priorIds.size} ids -> new ${saturatedIds.length} ids (${removed.length} removed by fresh contradictions).`
    );
    const byPack = new Map<string, string[]>();
    for (const id of removed) {
      const packId = scenarioPackId.get(id) ?? "(unknown pack)";
      const list = byPack.get(packId) ?? [];
      list.push(id);
      byPack.set(packId, list);
    }
    for (const [packId, ids] of [...byPack.entries()].sort((a, b) =>
      a[0].localeCompare(b[0])
    )) {
      console.error(`[saturation]   ${packId}: ${ids.length} removed`);
      for (const id of ids) {
        const failedBy = [...(freshFailures.get(id) ?? [])].sort().join(", ");
        console.error(`[saturation]     ${id} — failed by ${failedBy}`);
      }
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
