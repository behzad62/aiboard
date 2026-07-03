/* Shared trace->scenario replay resolver for GameIQ run files.
 *
 * Both the replay CLI (scripts/replay-gameiq-traces.mts) and the recovery CLI
 * (scripts/recover-gameiq-run.mts) rebuild per-pack scenario scores from the
 * recorded model-call traces of a run file. They MUST pair traces to scenarios
 * identically — a divergent second copy of this logic is exactly what the B4
 * quality review found had drifted into a pairing bug. This module is the ONE
 * implementation; callers import resolvePackTraceReplay.
 *
 * Two branches, chosen per pack from whether the pack's traces carry a
 * scenarioId:
 *  - scenarioId-keyed tuple pairing (B4+ run files): each scenario is paired to
 *    its OWN trace by id, and tuples are filtered, so a dropped middle trace
 *    removes exactly its own scenario and never shifts its neighbors' actions.
 *  - positional filter-then-slice (pre-B4 legacy run files): traces have no
 *    scenarioId, but were recorded sequentially one-per-scenario in order, so
 *    positional pairing is correct for them. Its exact behavior is a
 *    byte-identical guarantee — do not "improve" it.
 */
import type { GameIqScenario, GameIqScenarioPack } from "./types";

export interface PackTraceRow {
  caseId: string;
  startedAt: string;
  parsedResponseJson?: string | null;
  rawResponse?: string | null;
  latencyMs?: number;
  scenarioId?: string;
}

export interface PackTraceReplay {
  replayScenarios: GameIqScenario[];
  actions: unknown[];
  replayed: number;
  total: number;
  partial: boolean;
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

/**
 * Resolve which of a pack's scenarios can be replayed from its recorded traces
 * and the positionally-aligned actions to feed them. `packTraces` must already
 * be filtered to this pack (traces.filter(t => t.caseId === pack.id)).
 */
export function resolvePackTraceReplay(
  pack: GameIqScenarioPack,
  packTraces: PackTraceRow[]
): PackTraceReplay {
  // Prefer scenarioId when the pack's traces carry it (B4+ run files):
  // pair each scenario to its own trace by id, using the LAST trace by
  // startedAt when a scenario has multiple traces (retries) — the final
  // attempt is the scored one.
  const hasScenarioIds = packTraces.some((t) => Boolean(t.scenarioId));
  let replayScenarios: GameIqScenario[];
  let actions: unknown[];
  if (hasScenarioIds) {
    const byScenarioId = new Map<string, PackTraceRow>();
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
  const replayed = replayScenarios.length;
  return {
    replayScenarios,
    actions,
    replayed,
    total: pack.scenarios.length,
    partial: replayed < pack.scenarios.length,
  };
}
