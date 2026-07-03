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
 *  - gap/duplicate-aware positional pairing (pre-B4 legacy run files): traces
 *    have no scenarioId, but were recorded sequentially one-per-scenario-attempt
 *    in scenario order (INCLUDING an empty trace for a failed transport call).
 *    We first DEDUP duplicates — a double-recorded call or a retry re-hashes to
 *    the SAME promptHash, so we collapse same-promptHash traces to one, keeping
 *    the FINAL recorded state (latest completedAt) because that is exactly the
 *    trace the live verifier scored — then index-pair dedupedTraces[i] ↔
 *    scenarios[i] and filter out pairs whose trace is empty. Each empty removes
 *    ONLY its own scenario, mirroring the scenarioId branch's tuple-then-filter
 *    shape but keyed by deduped position.
 *    This REPLACES a previous filter-then-slice that mis-attributed mid-list
 *    gaps: when an empty trace landed in the MIDDLE (e.g. the Spark chess
 *    smothered-mate timeout at position 2), filtering before slicing collapsed
 *    past the gap so every trailing scenario inherited its neighbor's action —
 *    scoring chess 2/15 where the live verifier said 14/15. promptHash
 *    uniqueness (each scenario's prompt begins "Scenario N of M" over a distinct
 *    board, so distinct scenarios never collide; only retries share a hash) was
 *    verified across all four legacy reference run files before relying on it.
 */
import type { GameIqScenario, GameIqScenarioPack } from "./types";

export interface PackTraceRow {
  caseId: string;
  startedAt: string;
  completedAt?: string;
  parsedResponseJson?: string | null;
  rawResponse?: string | null;
  latencyMs?: number;
  scenarioId?: string;
  /**
   * Stable hash of the scored prompt. Each GameIQ scenario's prompt begins
   * "Scenario N of M" over a distinct board, so a promptHash is UNIQUE per
   * scenario; a duplicate (a double-recorded call or a retry of the same
   * scenario) re-hashes to the SAME value. The positional branch uses this to
   * collapse those duplicates (see below).
   */
  promptHash?: string;
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

/** A trace is usable iff it recorded a non-empty parsedResponseJson (a failed
 * transport call records an empty one). */
function traceHasParsedResponse(trace: PackTraceRow): boolean {
  return Boolean(trace.parsedResponseJson && trace.parsedResponseJson.length > 0);
}

function actionForTrace(trace: PackTraceRow): unknown {
  try {
    return actionFromParsedJson(JSON.parse(trace.parsedResponseJson as string));
  } catch {
    return trace.rawResponse ?? null;
  }
}

/**
 * Collapse duplicate traces (a double-recorded call, or a retry of the same
 * scenario — both re-hash to the same promptHash) in an (already startedAt-
 * ordered) trace list, keeping ONE trace per promptHash: the FINAL recorded
 * state of that scenario's call, i.e. the latest by completedAt (falling back
 * to startedAt, then array order). This is exactly the trace the LIVE verifier
 * scored, so a duplicate where the final recording was a parse/transport error
 * (empty parsedResponseJson) is kept as empty and later filtered out as a gap —
 * reproducing the run's actual verdict rather than a "better" earlier attempt.
 * (Verified on the Spark connect-four avoid-loss-5 double-record: the later
 * completedAt was the parse_error the official verifier scored as failed.)
 * Traces without a promptHash are each kept as-is (they can't be deduped and are
 * treated as distinct). Order is preserved by first-appearance so the survivors
 * stay in scenario order.
 */
function dedupTracesByPromptHash(orderedTraces: PackTraceRow[]): PackTraceRow[] {
  const byHash = new Map<string, PackTraceRow>();
  const noHash: { index: number; trace: PackTraceRow }[] = [];
  const firstSeenIndex = new Map<string, number>();
  const traceOrderIndex = new Map<PackTraceRow, number>();
  orderedTraces.forEach((trace, index) => {
    traceOrderIndex.set(trace, index);
    if (!trace.promptHash) {
      noHash.push({ index, trace });
      return;
    }
    const existing = byHash.get(trace.promptHash);
    if (!existing) {
      byHash.set(trace.promptHash, trace);
      firstSeenIndex.set(trace.promptHash, index);
      return;
    }
    // Keep whichever was recorded LAST: latest completedAt, then latest
    // startedAt, then latest array position. The final state is what the live
    // run scored.
    if (isLaterRecording(trace, existing, traceOrderIndex)) {
      byHash.set(trace.promptHash, trace);
    }
  });
  // Reassemble in first-appearance order (= scenario order for legacy files).
  const hashed = [...byHash.entries()].map(([hash, trace]) => ({
    index: firstSeenIndex.get(hash) as number,
    trace,
  }));
  return [...hashed, ...noHash]
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.trace);
}

/** True if `candidate` was recorded after `existing` (latest completedAt, then
 * startedAt, then array order). */
function isLaterRecording(
  candidate: PackTraceRow,
  existing: PackTraceRow,
  traceOrderIndex: Map<PackTraceRow, number>
): boolean {
  const byCompleted = (candidate.completedAt ?? "").localeCompare(
    existing.completedAt ?? ""
  );
  if (byCompleted !== 0) return byCompleted > 0;
  const byStarted = candidate.startedAt.localeCompare(existing.startedAt);
  if (byStarted !== 0) return byStarted > 0;
  return (
    (traceOrderIndex.get(candidate) ?? 0) > (traceOrderIndex.get(existing) ?? 0)
  );
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
    // Gap/duplicate-aware positional pairing for pre-B4 legacy run files (no
    // scenarioId). Traces were recorded one-per-scenario-attempt in scenario
    // order, INCLUDING an empty trace for a failed transport call.
    //  1. Sort by startedAt (stable).
    //  2. DEDUP by promptHash (a double-record or retry re-hashes to the same
    //     value): keep one per hash — the FINAL recorded state (latest
    //     completedAt), the trace the live verifier scored. This collapses e.g.
    //     the Spark connect-four 41→40 duplicate.
    //  3. INDEX-PAIR dedupedTraces[i] ↔ scenarios[i], then FILTER out pairs
    //     whose trace is empty. Each empty removes ONLY its own scenario, so a
    //     mid-list gap no longer shifts trailing scenarios' actions (the old
    //     filter-then-slice scored Spark chess 2/15 instead of 14/15).
    const orderedTraces = [...packTraces].sort((a, b) =>
      a.startedAt.localeCompare(b.startedAt)
    );
    const dedupedTraces = dedupTracesByPromptHash(orderedTraces);
    const n = Math.min(dedupedTraces.length, pack.scenarios.length);
    const usablePairs = pack.scenarios
      .slice(0, n)
      .map((scenario, index) => ({ scenario, trace: dedupedTraces[index] }))
      .filter(({ trace }) => traceHasParsedResponse(trace));
    replayScenarios = usablePairs.map((p) => p.scenario);
    actions = usablePairs.map(({ trace }) => actionForTrace(trace));
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
