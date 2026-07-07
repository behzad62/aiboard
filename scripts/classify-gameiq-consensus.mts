/* Engine classification of consensus-audit flags: sorts each >=2-model
 * non-keyed convergence into GENUINE failure vs MISKEY-candidate classes, so
 * only engine-equivalent answers need human adjudication.
 * Run: npx tsx scripts/classify-gameiq-consensus.mts <run-file.json> [...more]
 */
import { readFileSync } from "node:fs";
import {
  GAMEIQ_CORRECT_QUALITY_BAR,
  listGameIqScenarioPacks,
  stableStringify,
} from "../lib/benchmark/gameiq";
import { actionMatchesExpected } from "../lib/benchmark/gameiq/validation";
import type { GameIqScenario } from "../lib/benchmark/gameiq/types";
import {
  FIREWORKS_MEMORY_SCENARIOS,
  FIREWORKS_TACTICS_SCENARIOS,
} from "../lib/benchmark/fireworks/scenario-packs";
import type { FireworksScenario } from "../lib/benchmark/fireworks/types";
import {
  applyFireworksAction,
  cloneFireworksState,
  fireworksActionsEqual,
  getLegalFireworksActions,
  isCriticalCard,
  isPlayableCard,
} from "../lib/games/fireworks/engine";
import type {
  FireworksAction,
  FireworksColor,
  FireworksGameState,
  FireworksRank,
} from "../lib/games/fireworks/types";
import { dropDisc, getLegalColumns } from "../lib/games/connect-four/engine";
import type { ConnectFourGameState } from "../lib/games/connect-four/types";
import { fromFEN, isLegalMove, makeMove } from "../lib/games/chess/engine";
import type { Move } from "../lib/games/chess/types";

interface TraceRow {
  caseId: string;
  startedAt: string;
  parsedResponseJson?: string | null;
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

// ── 1. Rebuild consensus flags (same grouping as audit-gameiq-consensus) ────
const packs = listGameIqScenarioPacks();
const table = new Map<
  string,
  { scenario: GameIqScenario; answers: Map<string, unknown> }
>();

const runFiles = process.argv.slice(2);
if (runFiles.length === 0) {
  console.log("Usage: npx tsx scripts/classify-gameiq-consensus.mts <run-file.json> [...more]");
  process.exit(2);
}

for (const file of runFiles) {
  const run = JSON.parse(readFileSync(file, "utf8"));
  const model: string = String(run.runs[0].modelIds);
  const traces: TraceRow[] = run.traces;
  for (const pack of packs) {
    const packTraces = traces.filter((t) => t.caseId === pack.id && t.scenarioId);
    const byScenarioId = new Map<string, TraceRow>();
    for (const trace of packTraces) {
      const existing = byScenarioId.get(trace.scenarioId as string);
      if (!existing || trace.startedAt.localeCompare(existing.startedAt) > 0) {
        byScenarioId.set(trace.scenarioId as string, trace);
      }
    }
    for (const scenario of pack.scenarios) {
      const trace = byScenarioId.get(scenario.id);
      if (!trace?.parsedResponseJson || trace.parsedResponseJson.length === 0) continue;
      let action: unknown;
      try {
        action = actionFromParsedJson(JSON.parse(trace.parsedResponseJson));
      } catch {
        continue;
      }
      const row = table.get(scenario.id) ?? { scenario, answers: new Map() };
      row.answers.set(model, action);
      table.set(scenario.id, row);
    }
  }
}

interface Flag {
  scenario: GameIqScenario;
  action: unknown;
  models: string[];
}
const flags: Flag[] = [];
for (const row of table.values()) {
  const groups = new Map<string, { action: unknown; models: string[] }>();
  for (const [model, action] of row.answers) {
    const key = stableStringify(action);
    const group = groups.get(key) ?? { action, models: [] };
    group.models.push(model);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.models.length < 2) continue;
    if (actionMatchesExpected(row.scenario, group.action) >= GAMEIQ_CORRECT_QUALITY_BAR) continue;
    flags.push({ scenario: row.scenario, action: group.action, models: group.models });
  }
}

// ── 2. Engine classification ────────────────────────────────────────────────

const HARD_SRC = FIREWORKS_TACTICS_SCENARIOS;
const MEM_SRC = FIREWORKS_MEMORY_SCENARIOS;
const fwSourceById = new Map<string, FireworksScenario>(
  [...HARD_SRC, ...MEM_SRC].map((s) => [s.id, s])
);

function fwSource(scenario: GameIqScenario): FireworksScenario | null {
  const tag = scenario.tags.find((t) => t.startsWith("source:"));
  return tag ? (fwSourceById.get(tag.slice("source:".length)) ?? null) : null;
}

function fwPrepared(source: FireworksScenario): FireworksGameState {
  const state = cloneFireworksState(source.state);
  const idx = state.players.findIndex((p) => p.id === source.actingPlayerId);
  if (idx >= 0) state.currentPlayerIndex = idx;
  state.status = "playing";
  return state;
}

function toEngineFw(raw: unknown): FireworksAction | null {
  const r = raw as Record<string, unknown>;
  const kind = (r.action ?? r.type) as string;
  if (kind === "play" || kind === "discard") {
    if (typeof r.cardIndex !== "number") return null;
    return { action: kind, cardIndex: r.cardIndex };
  }
  if (kind === "clue_color") {
    return {
      action: "clue_color",
      targetPlayerId: r.targetPlayerId as string,
      color: r.color as FireworksColor,
    };
  }
  if (kind === "clue_rank") {
    return {
      action: "clue_rank",
      targetPlayerId: r.targetPlayerId as string,
      rank: r.rank as FireworksRank,
    };
  }
  return null;
}

function clueTouchKey(state: FireworksGameState, action: FireworksAction): string | null {
  if (action.action !== "clue_color" && action.action !== "clue_rank") return null;
  const hand = state.hands.find((h) => h.playerId === action.targetPlayerId);
  if (!hand) return null;
  const ids = hand.cards
    .filter((c) => (action.action === "clue_color" ? c.color === action.color : c.rank === action.rank))
    .map((c) => c.id)
    .sort();
  return `${action.targetPlayerId}:${ids.join(",")}`;
}

function classifyFireworks(flag: Flag): { cls: string; note: string } {
  const source = fwSource(flag.scenario);
  if (!source) return { cls: "REVIEW", note: "source scenario not found" };
  const state = fwPrepared(source);
  const action = toEngineFw(flag.action);
  if (!action) return { cls: "GENUINE_MALFORMED", note: "unparseable action shape" };
  const legal = getLegalFireworksActions(state, source.actingPlayerId);
  if (!legal.some((l) => fireworksActionsEqual(l, action))) {
    return { cls: "GENUINE_ILLEGAL", note: "not a legal action in state" };
  }
  if ((source.forbiddenActions ?? []).some((f) => fireworksActionsEqual(f, action))) {
    return { cls: "GENUINE_FORBIDDEN", note: "matches forbiddenActions (trap)" };
  }
  const hand = state.hands.find((h) => h.playerId === source.actingPlayerId);
  if (action.action === "play") {
    const card = hand?.cards[action.cardIndex];
    if (!card) return { cls: "GENUINE_ILLEGAL", note: "no card at index" };
    if (isPlayableCard(state, card)) {
      return {
        cls: "EQUIV_PLAYABLE_PLAY",
        note: `plays ${card.color}${card.rank} which IS playable (+1) — value-equivalent alternative`,
      };
    }
    return { cls: "GENUINE_MISPLAY", note: `plays ${card.color}${card.rank} (unplayable, burns fuse)` };
  }
  if (action.action === "discard") {
    const card = hand?.cards[action.cardIndex];
    if (!card) return { cls: "GENUINE_ILLEGAL", note: "no card at index" };
    if (isCriticalCard(state, card)) {
      return { cls: "GENUINE_CRITICAL_DISCARD", note: `discards critical ${card.color}${card.rank}` };
    }
    if (state.stacks[card.color] >= card.rank) {
      return {
        cls: "EQUIV_DEAD_DISCARD",
        note: `discards dead ${card.color}${card.rank} — value-safe alternative`,
      };
    }
    return { cls: "GENUINE_NEUTRAL_DISCARD", note: `discards live ${card.color}${card.rank} (0.3 neutral by design)` };
  }
  // clue
  const key = clueTouchKey(state, action);
  const keyedClueKeys = new Set(
    source.expectedActions
      .filter((e) => e.weight >= 0.75)
      .map((e) => clueTouchKey(state, e.action))
      .filter((k): k is string => k !== null)
  );
  if (key && keyedClueKeys.has(key)) {
    return { cls: "MISKEY_CLUE_SET", note: "clue touches SAME set as a keyed clue — A2 widening should have keyed it!" };
  }
  const target = state.hands.find((h) => h.playerId === action.targetPlayerId);
  const touched =
    target?.cards.filter((c) =>
      action.action === "clue_color" ? c.color === action.color : c.rank === action.rank
    ) ?? [];
  if (touched.length > 0 && touched.every((c) => state.stacks[c.color] >= c.rank)) {
    return { cls: "GENUINE_DEAD_CLUE", note: "clue touches only dead cards (0.1)" };
  }
  return { cls: "GENUINE_NEUTRAL_CLUE", note: "legal clue, different info than keyed (0.3 neutral by design)" };
}

function cfWinningColumns(state: ConnectFourGameState): number[] {
  const wins: number[] = [];
  for (const column of getLegalColumns(state)) {
    const next = dropDisc(structuredClone(state), column, 0);
    if (next.status === "win" && next.winner === state.turn) wins.push(column);
  }
  return wins;
}

function classifyConnectFour(flag: Flag): { cls: string; note: string } {
  const state = flag.scenario.initialState as ConnectFourGameState;
  const col = (flag.action as { column?: number }).column;
  if (typeof col !== "number" || !getLegalColumns(state).includes(col)) {
    return { cls: "GENUINE_ILLEGAL", note: `column ${col} not legal` };
  }
  const category = flag.scenario.category;
  const after = dropDisc(structuredClone(state), col, 0);
  if (category === "win-in-one") {
    return after.status === "win" && after.winner === state.turn
      ? { cls: "MISKEY_WINNING_COL", note: "consensus column WINS but is not keyed (violates completeness!)" }
      : { cls: "GENUINE_NOT_WINNING", note: "consensus column does not win" };
  }
  if (after.status === "win") {
    return { cls: "MISKEY_WINS_OUTRIGHT", note: "consensus column wins outright, not keyed" };
  }
  // opponent's immediate wins after consensus move
  const oppWins = cfWinningColumns(after);
  if (category === "block-win" || category === "avoid-losing-move") {
    return oppWins.length > 0
      ? { cls: "GENUINE_LOSES", note: `opponent then wins via [${oppWins.join(",")}]` }
      : { cls: "EQUIV_SAFE_MOVE", note: "no immediate opponent win after consensus — check keyed-uniqueness claim" };
  }
  if (category === "trap-setup") {
    const probe = structuredClone(after);
    probe.turn = state.turn;
    const myThreats = cfWinningColumns(probe);
    if (oppWins.length === 0 && myThreats.length >= 2) {
      return { cls: "EQUIV_FORK", note: `consensus also forks (${myThreats.length} threats, no opp win)` };
    }
    return {
      cls: "GENUINE_NO_FORK",
      note: `threats-after=${myThreats.length}, opp-wins=[${oppWins.join(",")}]`,
    };
  }
  return { cls: "REVIEW", note: `unhandled CF category ${category}` };
}

function classifyChess(flag: Flag): { cls: string; note: string } {
  const fen = (flag.scenario.initialState as { fen: string }).fen;
  const state = fromFEN(fen);
  const a = flag.action as { from?: string; to?: string; promotion?: string | null };
  if (!a.from || !a.to) return { cls: "GENUINE_MALFORMED", note: "no from/to" };
  const move = {
    from: a.from,
    to: a.to,
    ...(a.promotion ? { promotion: a.promotion } : {}),
  } as Move;
  if (!isLegalMove(state, move)) {
    return { cls: "GENUINE_ILLEGAL", note: `${a.from}-${a.to} not legal` };
  }
  const isMateScenario =
    flag.scenario.category === "mate-in-one" || flag.scenario.id.includes("mate");
  const next = makeMove(state, move);
  if (isMateScenario) {
    return next.status === "checkmate"
      ? { cls: "MISKEY_MATING_MOVE", note: "consensus move MATES but is not keyed (violates completeness!)" }
      : { cls: "GENUINE_NOT_MATE", note: `status after move: ${next.status}` };
  }
  return { cls: "REVIEW", note: `non-mate chess category ${flag.scenario.category} — manual look` };
}

// ── 3. Classify all flags and report ────────────────────────────────────────
const results: Array<Flag & { cls: string; note: string }> = [];
for (const flag of flags) {
  let cls: { cls: string; note: string };
  switch (flag.scenario.gameId) {
    case "fireworks":
      cls = classifyFireworks(flag);
      break;
    case "connect-four":
      cls = classifyConnectFour(flag);
      break;
    case "chess":
      cls = classifyChess(flag);
      break;
    default:
      cls = { cls: "REVIEW", note: `unhandled game ${flag.scenario.gameId}` };
  }
  results.push({ ...flag, ...cls });
}

const byClass = new Map<string, number>();
for (const r of results) byClass.set(r.cls, (byClass.get(r.cls) ?? 0) + 1);
console.log("=== CLASS SUMMARY ===");
for (const [cls, n] of [...byClass.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${cls.padEnd(26)} ${n}`);
}

const interesting = results.filter(
  (r) => r.cls.startsWith("MISKEY") || r.cls.startsWith("EQUIV") || r.cls === "REVIEW"
);
console.log(`\n=== NEEDS ADJUDICATION (${interesting.length}) ===`);
for (const r of interesting) {
  console.log(`\n${r.scenario.id} [${r.cls}]`);
  console.log(`  consensus (${r.models.length}): ${JSON.stringify(r.action)}`);
  console.log(`  models: ${r.models.join(", ")}`);
  console.log(`  keyed: ${r.scenario.expectedActions.map((e) => `${JSON.stringify(e.action)}@${e.weight}`).join(" | ")}`);
  console.log(`  note: ${r.note}`);
}
console.log(`\n${results.length} flags classified; ${interesting.length} need adjudication.`);
