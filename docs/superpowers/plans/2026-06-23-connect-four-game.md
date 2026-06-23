# Connect Four Game Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Connect Four as a second game with PvP, PvAI, AIvAI, persistence, import/export, replay, and minimal benchmark support.

**Architecture:** Keep Connect Four rules, AI, sessions, exports, UI components, and benchmark code in focused modules. Convert the Games page into a picker shell that delegates to a chess client boundary or a Connect Four client boundary. Reuse generic game core types/stores and extract small UI helpers only when both games need them.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript strict, Tailwind, plain `tsx` script tests, browser-side provider registry.

---

## File Structure

Create:
- `lib/games/connect-four/types.ts`: Connect Four state, move, player, AI response, and match record types.
- `lib/games/connect-four/engine.ts`: Pure Connect Four rules.
- `lib/games/connect-four/ai.ts`: Prompt construction, JSON parsing, retries, fallback columns, provider calls.
- `lib/games/connect-four/session.ts`: Session snapshot conversion and validation.
- `lib/games/connect-four/export.ts`: JSON and text export/import helpers.
- `lib/games/connect-four/rules-tests.mts`: Rules regression script.
- `scripts/test-connect-four-ai.mts`: AI parser/prompt/fallback regression script.
- `scripts/test-connect-four-session-export.mts`: Session and export regression script.
- `scripts/test-games-catalog.mts`: Game catalog regression script.
- `lib/games/catalog.ts`: Game picker descriptors.
- `components/games/GamePicker.tsx`: Compact picker cards for games.
- `components/games/GameAIConfigPanel.tsx`: Game-neutral AI model/reasoning selector extracted from chess setup.
- `components/games/GameAIPresence.tsx`: Game-neutral AI interaction display extracted from chess presence.
- `app/games/chess-game-client.tsx`: Existing chess client boundary.
- `app/games/connect-four-game-client.tsx`: Connect Four client orchestration.
- `components/games/connect-four/ConnectFourBoard.tsx`: Board and column input.
- `components/games/connect-four/ConnectFourSetup.tsx`: Setup controls.
- `components/games/connect-four/ConnectFourPlayerPanel.tsx`: Player identity/current turn panel.
- `components/games/connect-four/ConnectFourControls.tsx`: Reset, pause/resume, replay controls.
- `components/games/connect-four/ConnectFourMoveHistory.tsx`: Move list.
- `components/games/connect-four/ConnectFourExportMenu.tsx`: Export menu.
- `components/games/connect-four/ConnectFourImportMenu.tsx`: Import menu.
- `lib/games/connect-four/benchmark.ts`: Minimal AI vs AI benchmark runner logic.

Modify:
- `app/games/games-client.tsx`: Replace chess-only top-level implementation with game picker shell.
- `components/games/chess/AIPresence.tsx`: Wrap `GameAIPresence` so existing chess imports keep working.
- `components/games/GamesBenchmark.tsx`: Add game selection and Connect Four runner support without mixing chess/connect-four rules.
- `lib/games/index.ts`: Export Connect Four public modules intentionally.
- `package.json`: Add Connect Four scripts to `test:games`.

---

### Task 1: Connect Four Pure Rules

**Files:**
- Create: `lib/games/connect-four/types.ts`
- Create: `lib/games/connect-four/engine.ts`
- Create: `lib/games/connect-four/rules-tests.mts`
- Modify: `lib/games/index.ts`

- [x] **Step 1: Write the failing rules test**

Create `lib/games/connect-four/rules-tests.mts`:

```ts
import {
  CONNECT_FOUR_COLUMNS,
  CONNECT_FOUR_ROWS,
  createInitialConnectFourState,
  dropDisc,
  getLegalColumns,
  isLegalColumn,
} from "./engine";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

function play(columns: number[]) {
  return columns.reduce((state, column) => dropDisc(state, column), createInitialConnectFourState());
}

const initial = createInitialConnectFourState();
check("board is 7 columns by 6 rows", initial.board.length === CONNECT_FOUR_ROWS && initial.board.every((row) => row.length === CONNECT_FOUR_COLUMNS), initial.board);
check("red starts", initial.turn === "red", initial.turn);
check("all columns are initially legal", getLegalColumns(initial).join(",") === "0,1,2,3,4,5,6", getLegalColumns(initial));

const oneMove = dropDisc(initial, 3);
check("disc drops to bottom row", oneMove.board[5][3] === "red", oneMove.board);
check("turn alternates after legal move", oneMove.turn === "yellow", oneMove.turn);
check("move history stores one-based display column", oneMove.moveHistory[0]?.displayColumn === 4, oneMove.moveHistory);

let fullColumn = createInitialConnectFourState();
for (let i = 0; i < CONNECT_FOUR_ROWS; i++) {
  fullColumn = dropDisc(fullColumn, 0);
}
check("full column is not legal", !isLegalColumn(fullColumn, 0), getLegalColumns(fullColumn));

const horizontal = play([0, 0, 1, 1, 2, 2, 3]);
check("horizontal win is detected", horizontal.status === "win" && horizontal.winner === "red", horizontal);

const vertical = play([0, 1, 0, 1, 0, 1, 0]);
check("vertical win is detected", vertical.status === "win" && vertical.winner === "red", vertical);

const diagonalUp = play([0, 1, 1, 2, 3, 2, 2, 3, 4, 3, 3]);
check("diagonal win is detected", diagonalUp.status === "win" && diagonalUp.winner === "red", diagonalUp);

let draw = createInitialConnectFourState();
const drawColumns = [0, 1, 2, 3, 4, 5, 6, 0, 1, 2, 3, 4, 5, 6, 1, 0, 3, 2, 5, 4, 0, 6, 2, 1, 4, 3, 6, 5, 0, 1, 2, 3, 4, 5, 6, 1, 0, 3, 2, 5, 4, 6];
for (const column of drawColumns) {
  if (draw.status === "playing") draw = dropDisc(draw, column);
}
check("full board without winner is draw", draw.status === "draw", draw.status);

try {
  dropDisc(fullColumn, 0);
  check("dropping in full column throws", false);
} catch (error) {
  check("dropping in full column throws", error instanceof Error && error.message.includes("Column 1 is full"));
}

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
```

- [x] **Step 2: Run the failing rules test**

Run: `npx tsx lib/games/connect-four/rules-tests.mts`

Expected: failure because `lib/games/connect-four/engine.ts` does not exist.

- [x] **Step 3: Add Connect Four types**

Create `lib/games/connect-four/types.ts`:

```ts
import type { GameAIInteraction } from "@/lib/games/core/types";

export type ConnectFourPlayer = "red" | "yellow";
export type ConnectFourCell = ConnectFourPlayer | null;
export type ConnectFourBoard = ConnectFourCell[][];
export type ConnectFourStatus = "playing" | "paused" | "win" | "draw";
export type ConnectFourGameMode = "pvp" | "pvai" | "aivai";

export interface ConnectFourMove {
  column: number;
}

export interface ConnectFourMoveRecord {
  move: ConnectFourMove;
  player: ConnectFourPlayer;
  displayColumn: number;
  boardAfter: ConnectFourBoard;
  timestamp: number;
  aiInteraction?: GameAIInteraction | null;
}

export interface ConnectFourGameState {
  board: ConnectFourBoard;
  turn: ConnectFourPlayer;
  status: ConnectFourStatus;
  winner: ConnectFourPlayer | null;
  moveHistory: ConnectFourMoveRecord[];
}

export interface ConnectFourAIResponse {
  column: number;
  reasoning?: string;
  gesture?: GameAIInteraction["gesture"];
  utterance?: string;
  confidence?: number;
  diagnostics?: string;
}

export interface ConnectFourAIConfig {
  modelId: string;
  reasoningEffort: string;
}

export interface ConnectFourMatchRecord {
  id: string;
  timestamp: string;
  mode: ConnectFourGameMode;
  redModel?: string;
  yellowModel?: string;
  redReasoningEffort?: string;
  yellowReasoningEffort?: string;
  result: ConnectFourPlayer | "draw";
  moves: number;
  durationMs: number;
  avgAiResponseMs?: number;
  invalidResponses?: number;
  fallbackMoves?: number;
}
```

- [x] **Step 4: Add the minimal pure engine**

Create `lib/games/connect-four/engine.ts`:

```ts
import type {
  ConnectFourBoard,
  ConnectFourGameState,
  ConnectFourMove,
  ConnectFourPlayer,
  ConnectFourStatus,
} from "./types";

export const CONNECT_FOUR_COLUMNS = 7;
export const CONNECT_FOUR_ROWS = 6;

function otherPlayer(player: ConnectFourPlayer): ConnectFourPlayer {
  return player === "red" ? "yellow" : "red";
}

function cloneBoard(board: ConnectFourBoard): ConnectFourBoard {
  return board.map((row) => [...row]);
}

export function createInitialConnectFourState(): ConnectFourGameState {
  return {
    board: Array.from({ length: CONNECT_FOUR_ROWS }, () =>
      Array.from({ length: CONNECT_FOUR_COLUMNS }, () => null)
    ),
    turn: "red",
    status: "playing",
    winner: null,
    moveHistory: [],
  };
}

export function getLegalColumns(state: ConnectFourGameState): number[] {
  if (state.status !== "playing") return [];
  return Array.from({ length: CONNECT_FOUR_COLUMNS }, (_, column) => column).filter(
    (column) => state.board[0][column] === null
  );
}

export function isLegalColumn(state: ConnectFourGameState, column: number): boolean {
  return Number.isInteger(column) && getLegalColumns(state).includes(column);
}

function findDropRow(board: ConnectFourBoard, column: number): number {
  for (let row = CONNECT_FOUR_ROWS - 1; row >= 0; row--) {
    if (board[row][column] === null) return row;
  }
  return -1;
}

function countDirection(
  board: ConnectFourBoard,
  row: number,
  column: number,
  rowDelta: number,
  columnDelta: number,
  player: ConnectFourPlayer
): number {
  let count = 0;
  let r = row + rowDelta;
  let c = column + columnDelta;
  while (
    r >= 0 &&
    r < CONNECT_FOUR_ROWS &&
    c >= 0 &&
    c < CONNECT_FOUR_COLUMNS &&
    board[r][c] === player
  ) {
    count++;
    r += rowDelta;
    c += columnDelta;
  }
  return count;
}

export function isWinningPlacement(
  board: ConnectFourBoard,
  row: number,
  column: number,
  player: ConnectFourPlayer
): boolean {
  const directions: Array<[number, number]> = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];

  return directions.some(
    ([rowDelta, columnDelta]) =>
      1 +
        countDirection(board, row, column, rowDelta, columnDelta, player) +
        countDirection(board, row, column, -rowDelta, -columnDelta, player) >=
      4
  );
}

function statusAfterMove(
  board: ConnectFourBoard,
  row: number,
  column: number,
  player: ConnectFourPlayer
): { status: ConnectFourStatus; winner: ConnectFourPlayer | null } {
  if (isWinningPlacement(board, row, column, player)) {
    return { status: "win", winner: player };
  }
  const hasEmptyTop = board[0].some((cell) => cell === null);
  return hasEmptyTop
    ? { status: "playing", winner: null }
    : { status: "draw", winner: null };
}

export function dropDisc(
  state: ConnectFourGameState,
  column: number,
  timestamp: number
): ConnectFourGameState {
  if (state.status !== "playing") {
    throw new Error("Cannot move after the game has finished.");
  }
  if (!Number.isInteger(column) || column < 0 || column >= CONNECT_FOUR_COLUMNS) {
    throw new Error(`Column ${column + 1} is outside the board.`);
  }

  const board = cloneBoard(state.board);
  const row = findDropRow(board, column);
  if (row < 0) {
    throw new Error(`Column ${column + 1} is full.`);
  }

  const player = state.turn;
  board[row][column] = player;
  const result = statusAfterMove(board, row, column, player);
  const move: ConnectFourMove = { column };

  return {
    board,
    turn: result.status === "playing" ? otherPlayer(player) : otherPlayer(player),
    status: result.status,
    winner: result.winner,
    moveHistory: [
      ...state.moveHistory,
      {
        move,
        player,
        displayColumn: column + 1,
        boardAfter: cloneBoard(board),
        timestamp,
      },
    ],
  };
}

export function setConnectFourPaused(
  state: ConnectFourGameState,
  paused: boolean
): ConnectFourGameState {
  if (paused && state.status === "playing") return { ...state, status: "paused" };
  if (!paused && state.status === "paused") return { ...state, status: "playing" };
  return state;
}
```

- [x] **Step 5: Export Connect Four modules**

Modify `lib/games/index.ts`:

```ts
export * from "./chess/types";
export * from "./chess/engine";
export * from "./connect-four/types";
export * from "./connect-four/engine";
```

- [x] **Step 6: Run the rules test**

Run: `npx tsx lib/games/connect-four/rules-tests.mts`

Expected: all checks print `PASS`.

- [x] **Step 7: Commit Task 1**

```powershell
git add lib/games/connect-four/types.ts lib/games/connect-four/engine.ts lib/games/connect-four/rules-tests.mts lib/games/index.ts
git commit -m "Add Connect Four rules engine"
```

---

### Task 2: Connect Four AI Parsing, Prompts, Retry Helpers, And Fallback

**Files:**
- Create: `lib/games/connect-four/ai.ts`
- Create: `scripts/test-connect-four-ai.mts`

- [x] **Step 1: Write the failing AI test**

Create `scripts/test-connect-four-ai.mts`:

```ts
import {
  buildConnectFourCorrectionPrompt,
  chooseFallbackConnectFourColumn,
  formatLegalColumnList,
  getConnectFourRetryDelayMs,
  parseConnectFourAIResponse,
} from "../lib/games/connect-four/ai";
import { createInitialConnectFourState, dropDisc } from "../lib/games/connect-four/engine";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const parsed = parseConnectFourAIResponse(`{"column":4,"gesture":"confident","utterance":"Center control matters.","confidence":1.4}`);
check("parses one-based column to zero-based", parsed?.column === 3, parsed);
check("clamps confidence through interaction parser", parsed?.confidence === 1, parsed);
check("keeps valid utterance", parsed?.utterance === "Center control matters.", parsed);

check("rejects non-json response", parseConnectFourAIResponse("play column 4") === null);
check("rejects out-of-board column", parseConnectFourAIResponse(`{"column":8}`) === null);

check("formats legal columns one-based", formatLegalColumnList([0, 2, 6]) === "1, 3, 7");
const correction = buildConnectFourCorrectionPrompt("illegal", [0, 2, 6], 4);
check("correction includes rejected one-based column", correction.includes("5"), correction);
check("correction repeats legal columns", correction.includes("Legal columns: 1, 3, 7"), correction);

check("retry delay starts short", getConnectFourRetryDelayMs(0) === 250, getConnectFourRetryDelayMs(0));
check("retry delay backs off", getConnectFourRetryDelayMs(1) === 500, getConnectFourRetryDelayMs(1));

const center = chooseFallbackConnectFourColumn(createInitialConnectFourState());
check("fallback prefers center on empty board", center === 3, center);

const winNow = [0, 4, 1, 4, 2, 5].reduce((state, column) => dropDisc(state, column), createInitialConnectFourState());
check("fallback wins immediately", chooseFallbackConnectFourColumn(winNow) === 3, chooseFallbackConnectFourColumn(winNow));

const blockNow = [0, 3, 1, 3, 5, 3].reduce((state, column) => dropDisc(state, column), createInitialConnectFourState());
check("fallback blocks opponent immediate win", chooseFallbackConnectFourColumn(blockNow) === 3, chooseFallbackConnectFourColumn(blockNow));

if (failures === 0) console.log("PASS");
else console.log(`FAIL ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
```

- [x] **Step 2: Run the failing AI test**

Run: `npx tsx scripts/test-connect-four-ai.mts`

Expected: failure because `lib/games/connect-four/ai.ts` does not exist.

- [x] **Step 3: Add AI helpers and fallback**

Create `lib/games/connect-four/ai.ts` with these public exports:

```ts
import { buildGameAIInteraction, type GameAIInteractionResult } from "@/lib/games/core/ai-interactions";
import type { GameAIInteraction } from "@/lib/games/core/types";
import type { ReasoningEffort } from "@/lib/db/schema";
import { parseModelId } from "@/lib/providers/base";
import {
  getCustomModelByFullId,
  getDecryptedApiKey,
  getEnabledModels,
  getProvider,
  getProviderBaseURL,
  streamCustomChat,
} from "@/lib/client/providers";
import {
  CONNECT_FOUR_COLUMNS,
  createInitialConnectFourState,
  dropDisc,
  getLegalColumns,
  isLegalColumn,
} from "./engine";
import type {
  ConnectFourAIResponse,
  ConnectFourGameState,
} from "./types";

const MAX_CONNECT_FOUR_AI_RETRIES = 3;

export function formatLegalColumnList(columns: number[]): string {
  return columns.map((column) => String(column + 1)).join(", ");
}

export function buildConnectFourCorrectionPrompt(
  reason: "parse" | "illegal",
  legalColumns: number[],
  rejectedColumn?: number
): string {
  const legal = formatLegalColumnList(legalColumns);
  if (reason === "illegal") {
    const rejected = rejectedColumn === undefined ? "" : ` ${rejectedColumn + 1}`;
    return `Column${rejected} is not legal in the current position. Legal columns: ${legal}. Respond with ONLY valid JSON like {"column":4}.`;
  }
  return `Your response could not be parsed as valid Connect Four move JSON. Legal columns: ${legal}. Respond with ONLY valid JSON like {"column":4}.`;
}

export function getConnectFourRetryDelayMs(attempt: number): number {
  return Math.min(1_000, 250 * 2 ** Math.max(0, attempt));
}

export function parseConnectFourAIResponse(rawText: string): ConnectFourAIResponse | null {
  if (!rawText || typeof rawText !== "string") return null;
  let text = rawText.trim();
  const codeBlock = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlock) text = codeBlock[1].trim();
  const jsonMatch = text.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const displayColumn = Number(parsed.column);
    if (!Number.isInteger(displayColumn) || displayColumn < 1 || displayColumn > CONNECT_FOUR_COLUMNS) {
      return null;
    }
    const response: ConnectFourAIResponse = { column: displayColumn - 1 };
    if (typeof parsed.reasoning === "string") response.reasoning = parsed.reasoning;
    const interaction = buildGameAIInteraction("ai", parsed);
    if (interaction?.gesture) response.gesture = interaction.gesture;
    if (interaction?.utterance) response.utterance = interaction.utterance;
    if (interaction?.confidence !== undefined) response.confidence = interaction.confidence;
    if (interaction?.diagnostics) response.diagnostics = interaction.diagnostics;
    return response;
  } catch {
    return null;
  }
}

function canWinByPlaying(state: ConnectFourGameState, column: number): boolean {
  try {
    return dropDisc(state, column).status === "win";
  } catch {
    return false;
  }
}

function opponentCanWinAfter(state: ConnectFourGameState, column: number): boolean {
  try {
    const next = dropDisc(state, column);
    return getLegalColumns(next).some((reply) => canWinByPlaying(next, reply));
  } catch {
    return true;
  }
}

export function chooseFallbackConnectFourColumn(state: ConnectFourGameState): number | null {
  const legal = getLegalColumns(state);
  if (legal.length === 0) return null;

  const immediateWin = legal.find((column) => canWinByPlaying(state, column));
  if (immediateWin !== undefined) return immediateWin;

  const opponentProbe = { ...state, turn: state.turn === "red" ? "yellow" : "red" } as ConnectFourGameState;
  const immediateBlock = legal.find((column) => canWinByPlaying(opponentProbe, column));
  if (immediateBlock !== undefined) return immediateBlock;

  const centerOrder = [3, 2, 4, 1, 5, 0, 6].filter((column) => legal.includes(column));
  return centerOrder.find((column) => !opponentCanWinAfter(state, column)) ?? centerOrder[0] ?? legal[0];
}
```

- [x] **Step 4: Add prompt and provider request shell**

Extend `lib/games/connect-four/ai.ts` with:

```ts
export interface RequestConnectFourAIMoveParams {
  state: ConnectFourGameState;
  modelId: string;
  reasoningEffort: ReasoningEffort;
  apiKey: string;
  baseURL?: string;
  signal?: AbortSignal;
}

export interface ConnectFourAIMoveSuccess extends GameAIInteractionResult<number> {
  column: number;
  interaction: GameAIInteraction | null;
  reasoning?: string;
}

export type ConnectFourAIMoveResult =
  | ConnectFourAIMoveSuccess
  | { error: string };

export function buildConnectFourPrompt(
  state: ConnectFourGameState,
  legalColumns = getLegalColumns(state)
): { system: string; user: string } {
  const boardRows = state.board
    .map((row) => row.map((cell) => (cell === "red" ? "R" : cell === "yellow" ? "Y" : ".")).join(" "))
    .join("\n");
  const moves = state.moveHistory.map((record) => record.displayColumn).join(", ") || "(no moves yet)";
  return {
    system: `You are playing Connect Four. Choose one legal column. Respond with ONLY valid JSON like {"column":4,"gesture":"confident","utterance":"Center control matters.","confidence":0.74}. Columns are numbered 1 through 7.`,
    user: `Board rows from top to bottom:\n${boardRows}\n\nTurn: ${state.turn}\nMove history: ${moves}\nLegal columns: ${formatLegalColumnList(legalColumns)}\nChoose the strongest legal column and respond with JSON only.`,
  };
}
```

Then add `requestConnectFourAIMove` using the same provider streaming structure as `requestAIMove` in `lib/games/chess/ai.ts`: parse `modelId`, support custom models, stream tokens, parse response, retry parse/illegal columns with `buildConnectFourCorrectionPrompt`, retry provider errors with `getConnectFourRetryDelayMs`, and return `{ column, action: column, interaction }` on success.

- [x] **Step 5: Add model helper exports**

Add to `lib/games/connect-four/ai.ts`:

```ts
interface AvailableConnectFourModel {
  modelId: string;
  displayName: string;
  providerId: string;
}

export function getAvailableConnectFourModels(): AvailableConnectFourModel[] {
  return getEnabledModels().map((model) => ({
    modelId: `${model.providerId}:${model.id}`,
    displayName: model.name,
    providerId: model.providerId,
  }));
}

export function getConnectFourModelApiKey(modelId: string): string | null {
  const { providerId } = parseModelId(modelId);
  const customModel = getCustomModelByFullId(modelId);
  if (customModel) return customModel.apiKey || null;
  return getDecryptedApiKey(providerId);
}

export function getConnectFourModelBaseURL(modelId: string): string | undefined {
  const { providerId } = parseModelId(modelId);
  const customModel = getCustomModelByFullId(modelId);
  if (customModel) return customModel.baseURL;
  return getProviderBaseURL(providerId);
}
```

- [x] **Step 6: Run the AI test**

Run: `npx tsx scripts/test-connect-four-ai.mts`

Expected: all checks print `PASS`.

- [x] **Step 7: Commit Task 2**

```powershell
git add lib/games/connect-four/ai.ts scripts/test-connect-four-ai.mts
git commit -m "Add Connect Four AI helpers"
```

---

### Task 3: Connect Four Sessions And Export

**Files:**
- Create: `lib/games/connect-four/session.ts`
- Create: `lib/games/connect-four/export.ts`
- Create: `scripts/test-connect-four-session-export.mts`

- [x] **Step 1: Write the failing session/export test**

Create `scripts/test-connect-four-session-export.mts`:

```ts
import { createInitialConnectFourState, dropDisc } from "../lib/games/connect-four/engine";
import {
  CONNECT_FOUR_ACTIVE_SESSION_ID,
  createConnectFourSessionRecord,
  isConnectFourActiveStatus,
  parseConnectFourSessionRecord,
} from "../lib/games/connect-four/session";
import {
  exportConnectFourJson,
  exportConnectFourMoveList,
  parseConnectFourJsonExport,
} from "../lib/games/connect-four/export";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const state = dropDisc(dropDisc(createInitialConnectFourState(), 3), 2);
const snapshot = {
  gameState: state,
  gameMode: "pvai" as const,
  humanPlayer: "red" as const,
  redAI: { modelId: "openai:gpt-test", reasoningEffort: "default" },
  yellowAI: { modelId: "openai:gpt-test", reasoningEffort: "low" },
  isPaused: false,
  lastAiInteraction: null,
  aiWarning: null,
  aiError: null,
};

const record = createConnectFourSessionRecord(snapshot);
check("session id is stable", record.id === CONNECT_FOUR_ACTIVE_SESSION_ID, record.id);
check("session game id is connect-four", record.gameId === "connect-four", record.gameId);
check("playing status is active", record.status === "active", record.status);

const parsed = parseConnectFourSessionRecord(record);
check("valid session parses", parsed?.gameState.moveHistory.length === 2, parsed);
check("active statuses are recognized", isConnectFourActiveStatus("playing") && !isConnectFourActiveStatus("draw"));

const moveList = exportConnectFourMoveList(state);
check("move list is text", moveList.mimeType === "text/plain", moveList);
check("move list includes one-based columns", moveList.content.includes("1. Red: 4") && moveList.content.includes("2. Yellow: 3"), moveList.content);

const json = exportConnectFourJson(snapshot);
check("json export has stable filename", json.filename === "ai-board-connect-four.json", json.filename);
const imported = parseConnectFourJsonExport(json.content);
check("json import restores snapshot", imported.ok && imported.snapshot.gameState.moveHistory.length === 2, imported);
check("json import rejects wrong game", !parseConnectFourJsonExport(JSON.stringify({ game: "chess" })).ok);

if (failures === 0) console.log("PASS");
else console.log(`FAIL ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
```

- [x] **Step 2: Run the failing session/export test**

Run: `npx tsx scripts/test-connect-four-session-export.mts`

Expected: failure because session/export modules do not exist.

- [x] **Step 3: Implement session conversion**

Create `lib/games/connect-four/session.ts`:

```ts
import type { ReasoningEffort } from "@/lib/db/schema";
import type {
  GameAIInteraction,
  GameParticipant,
  GameSessionRecord,
  GameSessionStatus,
} from "@/lib/games/core/types";
import type {
  ConnectFourGameMode,
  ConnectFourGameState,
  ConnectFourPlayer,
  ConnectFourStatus,
} from "./types";

export const CONNECT_FOUR_ACTIVE_SESSION_ID = "connect-four-active-session";

export interface ConnectFourSessionAIConfig {
  modelId: string;
  reasoningEffort: ReasoningEffort;
}

export interface ConnectFourSessionSnapshot {
  gameState: ConnectFourGameState;
  gameMode: ConnectFourGameMode;
  humanPlayer: ConnectFourPlayer;
  redAI: ConnectFourSessionAIConfig;
  yellowAI: ConnectFourSessionAIConfig;
  isPaused: boolean;
  lastAiInteraction: GameAIInteraction | null;
  aiWarning: string | null;
  aiError: string | null;
}

export function isConnectFourActiveStatus(status: ConnectFourStatus): boolean {
  return status === "playing" || status === "paused";
}

function titleForMode(mode: ConnectFourGameMode): string {
  if (mode === "pvai") return "Connect Four: Player vs AI";
  if (mode === "aivai") return "Connect Four: AI vs AI";
  return "Connect Four: Player vs Player";
}

function participants(snapshot: ConnectFourSessionSnapshot): GameParticipant[] {
  const redIsAI = snapshot.gameMode === "aivai" || (snapshot.gameMode === "pvai" && snapshot.humanPlayer === "yellow");
  const yellowIsAI = snapshot.gameMode === "aivai" || (snapshot.gameMode === "pvai" && snapshot.humanPlayer === "red");
  return [
    {
      id: "red",
      kind: redIsAI ? "ai" : "human",
      label: redIsAI ? "Red AI" : "Red Player",
      ...(redIsAI ? { modelId: snapshot.redAI.modelId, reasoningEffort: snapshot.redAI.reasoningEffort } : {}),
    },
    {
      id: "yellow",
      kind: yellowIsAI ? "ai" : "human",
      label: yellowIsAI ? "Yellow AI" : "Yellow Player",
      ...(yellowIsAI ? { modelId: snapshot.yellowAI.modelId, reasoningEffort: snapshot.yellowAI.reasoningEffort } : {}),
    },
  ];
}

export function createConnectFourSessionRecord(
  snapshot: ConnectFourSessionSnapshot,
  now = new Date().toISOString()
): GameSessionRecord {
  return {
    id: CONNECT_FOUR_ACTIVE_SESSION_ID,
    gameId: "connect-four",
    title: titleForMode(snapshot.gameMode),
    status: snapshot.isPaused
      ? "paused"
      : isConnectFourActiveStatus(snapshot.gameState.status)
        ? "active"
        : "complete",
    participants: participants(snapshot),
    stateJson: JSON.stringify(snapshot),
    metadataJson: JSON.stringify({ moves: snapshot.gameState.moveHistory.length }),
    createdAt: now,
    updatedAt: now,
  };
}

function isPlayer(value: unknown): value is ConnectFourPlayer {
  return value === "red" || value === "yellow";
}

function isMode(value: unknown): value is ConnectFourGameMode {
  return value === "pvp" || value === "pvai" || value === "aivai";
}

export function parseConnectFourSessionRecord(
  record: GameSessionRecord
): ConnectFourSessionSnapshot | null {
  if (record.gameId !== "connect-four") return null;
  try {
    const parsed = JSON.parse(record.stateJson) as ConnectFourSessionSnapshot;
    if (!parsed || !isMode(parsed.gameMode) || !isPlayer(parsed.humanPlayer)) return null;
    if (!parsed.gameState || !Array.isArray(parsed.gameState.board) || !Array.isArray(parsed.gameState.moveHistory)) return null;
    if (!parsed.redAI || typeof parsed.redAI.modelId !== "string") return null;
    if (!parsed.yellowAI || typeof parsed.yellowAI.modelId !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}
```

`dropDisc` intentionally requires an explicit timestamp so the rules engine stays deterministic. UI/session code supplies `Date.now()` at the boundary when a real move is made.

- [x] **Step 4: Implement export/import**

Create `lib/games/connect-four/export.ts`:

```ts
import type { GameExport, GameSessionRecord } from "@/lib/games/core/types";
import {
  CONNECT_FOUR_ACTIVE_SESSION_ID,
  createConnectFourSessionRecord,
  parseConnectFourSessionRecord,
  type ConnectFourSessionSnapshot,
} from "./session";
import type { ConnectFourGameState } from "./types";

export type ConnectFourJsonImportResult =
  | { ok: true; snapshot: ConnectFourSessionSnapshot }
  | { ok: false; error: string };

export function exportConnectFourMoveList(state: ConnectFourGameState): GameExport {
  const content = state.moveHistory
    .map((record, index) => `${index + 1}. ${record.player === "red" ? "Red" : "Yellow"}: ${record.displayColumn}`)
    .join("\n");
  return {
    filename: "ai-board-connect-four-moves.txt",
    mimeType: "text/plain",
    content: content || "(no moves)",
  };
}

export function exportConnectFourJson(snapshot: ConnectFourSessionSnapshot): GameExport {
  return {
    filename: "ai-board-connect-four.json",
    mimeType: "application/json",
    content: JSON.stringify(
      {
        app: "ai-discussion-board",
        format: "game-export",
        game: "connect-four",
        version: 1,
        exportedAt: new Date().toISOString(),
        snapshot,
      },
      null,
      2
    ),
  };
}

export function parseConnectFourJsonExport(content: string): ConnectFourJsonImportResult {
  try {
    const descriptor = JSON.parse(content);
    if (descriptor?.game !== "connect-four") {
      return { ok: false, error: "The selected file is not a Connect Four export." };
    }
    if (!descriptor.snapshot) {
      return { ok: false, error: "The Connect Four export is missing its snapshot." };
    }
    const record: GameSessionRecord = {
      ...createConnectFourSessionRecord(descriptor.snapshot),
      id: CONNECT_FOUR_ACTIVE_SESSION_ID,
      stateJson: JSON.stringify(descriptor.snapshot),
    };
    const snapshot = parseConnectFourSessionRecord(record);
    return snapshot
      ? { ok: true, snapshot }
      : { ok: false, error: "The Connect Four export snapshot is incomplete or unsupported." };
  } catch {
    return { ok: false, error: "The selected file is not valid JSON." };
  }
}
```

- [x] **Step 5: Run the session/export test**

Run: `npx tsx scripts/test-connect-four-session-export.mts`

Expected: all checks print `PASS`.

- [x] **Step 6: Commit Task 3**

```powershell
git add lib/games/connect-four/session.ts lib/games/connect-four/export.ts scripts/test-connect-four-session-export.mts
git commit -m "Add Connect Four session and export helpers"
```

---

### Task 4: Game Catalog And Picker Shell

**Files:**
- Create: `lib/games/catalog.ts`
- Create: `scripts/test-games-catalog.mts`
- Create: `components/games/GamePicker.tsx`
- Create: `app/games/chess-game-client.tsx`
- Modify: `app/games/games-client.tsx`

- [x] **Step 1: Write the failing catalog test**

Create `scripts/test-games-catalog.mts`:

```ts
import { getGameCatalog, getGameDescriptor } from "../lib/games/catalog";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const catalog = getGameCatalog();
check("catalog includes chess", catalog.some((game) => game.id === "chess"), catalog);
check("catalog includes connect four", catalog.some((game) => game.id === "connect-four"), catalog);
check("connect four exposes three modes", getGameDescriptor("connect-four")?.modes.join(",") === "pvp,pvai,aivai", getGameDescriptor("connect-four"));
check("unknown descriptor is null", getGameDescriptor("missing") === null);

if (failures === 0) console.log("PASS");
else console.log(`FAIL ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
```

- [x] **Step 2: Run the failing catalog test**

Run: `npx tsx scripts/test-games-catalog.mts`

Expected: failure because `lib/games/catalog.ts` does not exist.

- [x] **Step 3: Add catalog descriptors**

Create `lib/games/catalog.ts`:

```ts
import type { GameId } from "@/lib/games/core/types";

export interface GameDescriptor {
  id: GameId;
  title: string;
  summary: string;
  status: "ready" | "coming-soon";
  accent: "amber" | "red-yellow";
  modes: Array<"pvp" | "pvai" | "aivai">;
}

const GAME_CATALOG: GameDescriptor[] = [
  {
    id: "chess",
    title: "Chess",
    summary: "Full chess board with legal moves, AI play, replay, import, and export.",
    status: "ready",
    accent: "amber",
    modes: ["pvp", "pvai", "aivai"],
  },
  {
    id: "connect-four",
    title: "Connect Four",
    summary: "Drop discs, build four in a row, and compare AI strategy in a faster game.",
    status: "ready",
    accent: "red-yellow",
    modes: ["pvp", "pvai", "aivai"],
  },
];

export function getGameCatalog(): GameDescriptor[] {
  return GAME_CATALOG.map((game) => ({ ...game, modes: [...game.modes] }));
}

export function getGameDescriptor(id: string): GameDescriptor | null {
  const game = GAME_CATALOG.find((candidate) => candidate.id === id);
  return game ? { ...game, modes: [...game.modes] } : null;
}
```

- [x] **Step 4: Run the catalog test**

Run: `npx tsx scripts/test-games-catalog.mts`

Expected: all checks print `PASS`.

- [x] **Step 5: Create the picker component**

Create `components/games/GamePicker.tsx`:

```tsx
"use client";

import type { GameDescriptor } from "@/lib/games/catalog";
import type { GameSessionRecord } from "@/lib/games/core/types";
import { cn } from "@/lib/utils";

interface GamePickerProps {
  games: GameDescriptor[];
  resumableSessions: GameSessionRecord[];
  onSelectGame: (gameId: string) => void;
}

export function GamePicker({ games, resumableSessions, onSelectGame }: GamePickerProps) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-100 via-stone-50 to-emerald-50 px-4 py-8 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950">
      <div className="mx-auto max-w-5xl">
        <div className="mb-8 text-center">
          <h1 className="text-4xl font-bold text-slate-950 dark:text-white">Games</h1>
          <p className="mt-2 text-slate-600 dark:text-slate-400">Choose a board and continue building game benchmarks.</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {games.map((game) => {
            const resumable = resumableSessions.find((session) => session.gameId === game.id);
            return (
              <button
                key={game.id}
                type="button"
                onClick={() => onSelectGame(game.id)}
                className={cn(
                  "rounded-xl border p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg",
                  "border-slate-200 bg-white/85 dark:border-slate-700 dark:bg-slate-900/80",
                  game.accent === "red-yellow" ? "hover:border-red-400" : "hover:border-amber-400"
                )}
                data-testid={`game-card-${game.id}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-xl font-semibold text-slate-950 dark:text-white">{game.title}</h2>
                    <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">{game.summary}</p>
                  </div>
                  {resumable && (
                    <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">
                      Resume
                    </span>
                  )}
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {game.modes.map((mode) => (
                    <span key={mode} className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                      {mode === "pvp" ? "PvP" : mode === "pvai" ? "PvAI" : "AIvAI"}
                    </span>
                  ))}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
```

- [x] **Step 6: Extract chess client boundary**

Copy the current full contents of `app/games/games-client.tsx` to `app/games/chess-game-client.tsx`.

In the copied file:
- Rename `export default function GamesClient()` to `export function ChessGameClient()`.
- Keep all chess behavior unchanged.

- [x] **Step 7: Replace games-client with shell**

Replace `app/games/games-client.tsx` with:

```tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { getGameCatalog } from "@/lib/games/catalog";
import type { GameSessionRecord } from "@/lib/games/core/types";
import { listGameSessions } from "@/lib/games/core/session-store";
import { GamePicker } from "@/components/games/GamePicker";
import { ChessGameClient } from "./chess-game-client";
import { ConnectFourGameClient } from "./connect-four-game-client";

type SelectedGame = "picker" | "chess" | "connect-four";

export default function GamesClient() {
  const [selectedGame, setSelectedGame] = useState<SelectedGame>("picker");
  const [sessions, setSessions] = useState<GameSessionRecord[]>([]);
  const games = useMemo(() => getGameCatalog(), []);

  useEffect(() => {
    let cancelled = false;
    void listGameSessions()
      .then((records) => {
        if (!cancelled) {
          setSessions(records.filter((record) => record.status === "active" || record.status === "paused"));
        }
      })
      .catch(() => {
        if (!cancelled) setSessions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedGame]);

  if (selectedGame === "chess") {
    return <ChessGameClient onBackToGames={() => setSelectedGame("picker")} />;
  }
  if (selectedGame === "connect-four") {
    return <ConnectFourGameClient onBackToGames={() => setSelectedGame("picker")} />;
  }
  return (
    <GamePicker
      games={games}
      resumableSessions={sessions}
      onSelectGame={(gameId) => setSelectedGame(gameId === "connect-four" ? "connect-four" : "chess")}
    />
  );
}
```

Add a temporary `app/games/connect-four-game-client.tsx`:

```tsx
"use client";

interface ConnectFourGameClientProps {
  onBackToGames?: () => void;
}

export function ConnectFourGameClient({ onBackToGames }: ConnectFourGameClientProps) {
  return (
    <div className="min-h-screen bg-slate-950 px-4 py-8 text-white">
      <div className="mx-auto max-w-3xl">
        <button type="button" onClick={onBackToGames} className="mb-6 rounded-lg border border-slate-700 px-3 py-2 text-sm">
          Back to games
        </button>
        <h1 className="text-3xl font-bold">Connect Four</h1>
        <p className="mt-2 text-slate-300">Connect Four implementation starts in the next task.</p>
      </div>
    </div>
  );
}
```

Update `ChessGameClient` signature to accept `onBackToGames?: () => void` and render a small back button near the setup and play headers.

- [x] **Step 8: Run catalog test and TypeScript**

Run:
- `npx tsx scripts/test-games-catalog.mts`
- `npx --yes tsc --noEmit`

Expected: both pass.

- [x] **Step 9: Commit Task 4**

```powershell
git add lib/games/catalog.ts scripts/test-games-catalog.mts components/games/GamePicker.tsx app/games/games-client.tsx app/games/chess-game-client.tsx app/games/connect-four-game-client.tsx
git commit -m "Add games picker shell"
```

---

### Task 5: Reusable AI UI Components

**Files:**
- Create: `components/games/GameAIConfigPanel.tsx`
- Create: `components/games/GameAIPresence.tsx`
- Modify: `components/games/chess/AIPresence.tsx`
- Modify: `app/games/chess-game-client.tsx`

- [x] **Step 1: Extract generic AI config panel**

Create `components/games/GameAIConfigPanel.tsx` by moving the existing chess `AIConfigPanel` shape into a game-neutral component:

```tsx
"use client";

import type { ReasoningEffort } from "@/lib/db/schema";
import { cn } from "@/lib/utils";

export interface GameAIModelOption {
  modelId: string;
  displayName: string;
  providerId: string;
}

export interface GameAIConfigValue {
  modelId: string;
  reasoningEffort: ReasoningEffort;
}

interface GameAIConfigPanelProps {
  title: string;
  accent: "red" | "yellow" | "white" | "black";
  config: GameAIConfigValue;
  models: GameAIModelOption[];
  onChange: (config: GameAIConfigValue) => void;
}

const REASONING_LEVELS: { value: ReasoningEffort; label: string }[] = [
  { value: "default", label: "Disabled" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
];

export function GameAIConfigPanel({ title, accent, config, models, onChange }: GameAIConfigPanelProps) {
  const reasoningIndex = REASONING_LEVELS.findIndex((level) => level.value === config.reasoningEffort);
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-white">{title}</h3>
        <span className={cn("h-3 w-3 rounded-full", accent === "red" ? "bg-red-500" : accent === "yellow" ? "bg-yellow-400" : accent === "black" ? "bg-slate-900" : "bg-white ring-1 ring-slate-300")} />
      </div>
      <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">Model</label>
      <select
        value={config.modelId}
        onChange={(event) => onChange({ ...config, modelId: event.target.value })}
        className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
      >
        {models.map((model) => (
          <option key={model.modelId} value={model.modelId}>
            {model.displayName}
          </option>
        ))}
      </select>
      <div className="mt-3">
        <div className="mb-1 flex items-center justify-between text-xs text-slate-600 dark:text-slate-400">
          <span>Reasoning</span>
          <span>{REASONING_LEVELS[reasoningIndex >= 0 ? reasoningIndex : 0].label}</span>
        </div>
        <input
          type="range"
          min={0}
          max={REASONING_LEVELS.length - 1}
          value={reasoningIndex >= 0 ? reasoningIndex : 0}
          onChange={(event) => onChange({ ...config, reasoningEffort: REASONING_LEVELS[Number(event.target.value)].value })}
          className="w-full accent-amber-500"
        />
      </div>
    </div>
  );
}
```

- [x] **Step 2: Extract generic AI presence**

Create `components/games/GameAIPresence.tsx`:

```tsx
"use client";

import { MessageSquare } from "lucide-react";
import type { GameAIInteraction } from "@/lib/games/core/types";
import { cn } from "@/lib/utils";

interface GameAIPresenceProps {
  interaction: GameAIInteraction | null;
  className?: string;
}

export function GameAIPresence({ interaction, className }: GameAIPresenceProps) {
  if (!interaction || (!interaction.utterance && (!interaction.gesture || interaction.gesture === "neutral"))) {
    return null;
  }
  return (
    <div className={cn("rounded-xl border border-violet-500/40 bg-violet-950/70 p-4 text-violet-50", className)}>
      <div className="flex items-start gap-3">
        <div className="rounded-full bg-violet-500/30 p-2">
          <MessageSquare className="h-5 w-5" />
        </div>
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-violet-200">
            {interaction.actorId} AI{interaction.gesture ? ` - ${interaction.gesture}` : ""}
          </div>
          {interaction.utterance && <div className="mt-1 text-sm">{interaction.utterance}</div>}
        </div>
      </div>
    </div>
  );
}
```

- [x] **Step 3: Adapt chess to generic AI presence/config**

Update `components/games/chess/AIPresence.tsx` to re-export or wrap `GameAIPresence`.

Update `app/games/chess-game-client.tsx` imports and `AIConfigPanel` usage to use `GameAIConfigPanel`. Keep visual behavior acceptable and do not change chess rules/state.

- [x] **Step 4: Run TypeScript**

Run: `npx --yes tsc --noEmit`

Expected: pass.

- [x] **Step 5: Commit Task 5**

```powershell
git add components/games/GameAIConfigPanel.tsx components/games/GameAIPresence.tsx components/games/chess/AIPresence.tsx app/games/chess-game-client.tsx
git commit -m "Extract reusable game AI UI"
```

---

### Task 6: Connect Four React Components

**Files:**
- Create all `components/games/connect-four/*.tsx` files listed in File Structure.

- [x] **Step 1: Create the board component**

Create `components/games/connect-four/ConnectFourBoard.tsx`:

```tsx
"use client";

import type { ConnectFourGameState } from "@/lib/games/connect-four/types";
import { CONNECT_FOUR_COLUMNS, CONNECT_FOUR_ROWS, getLegalColumns } from "@/lib/games/connect-four/engine";
import { cn } from "@/lib/utils";

interface ConnectFourBoardProps {
  state: ConnectFourGameState;
  interactive: boolean;
  onColumnClick?: (column: number) => void;
  previewColumn?: number | null;
  onPreviewColumn?: (column: number | null) => void;
}

export function ConnectFourBoard({ state, interactive, onColumnClick, previewColumn, onPreviewColumn }: ConnectFourBoardProps) {
  const legal = getLegalColumns(state);
  return (
    <div className="rounded-2xl border border-blue-950/30 bg-blue-700 p-3 shadow-2xl shadow-blue-950/30" data-testid="connect-four-board">
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${CONNECT_FOUR_COLUMNS}, minmax(0, 1fr))` }}>
        {Array.from({ length: CONNECT_FOUR_ROWS }).map((_, row) =>
          Array.from({ length: CONNECT_FOUR_COLUMNS }).map((__, column) => {
            const cell = state.board[row][column];
            const canPlay = interactive && legal.includes(column);
            return (
              <button
                key={`${row}-${column}`}
                type="button"
                disabled={!canPlay}
                onClick={() => canPlay && onColumnClick?.(column)}
                onMouseEnter={() => onPreviewColumn?.(column)}
                onMouseLeave={() => onPreviewColumn?.(null)}
                className={cn(
                  "aspect-square rounded-full border-4 border-blue-900/70 bg-blue-950/40 p-1 transition",
                  canPlay && "cursor-pointer hover:scale-105 hover:border-white/70",
                  previewColumn === column && canPlay && "ring-2 ring-white/80"
                )}
                aria-label={`Column ${column + 1}, row ${row + 1}`}
              >
                <span
                  className={cn(
                    "block h-full w-full rounded-full shadow-inner",
                    cell === "red" && "bg-gradient-to-br from-red-400 to-red-700",
                    cell === "yellow" && "bg-gradient-to-br from-yellow-200 to-yellow-500",
                    cell === null && "bg-slate-950/45"
                  )}
                />
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
```

- [x] **Step 2: Create player panel, controls, and history**

Create:
- `components/games/connect-four/ConnectFourPlayerPanel.tsx`
- `components/games/connect-four/ConnectFourControls.tsx`
- `components/games/connect-four/ConnectFourMoveHistory.tsx`

Use `ConnectFourPlayer` props, compact panels, and `data-testid` values:
- `connect-four-player-red`
- `connect-four-player-yellow`
- `connect-four-reset`
- `connect-four-pause`
- `connect-four-move-history`

- [x] **Step 3: Create import/export menus**

Create `ConnectFourExportMenu.tsx` using `exportConnectFourJson` and `exportConnectFourMoveList`.

Create `ConnectFourImportMenu.tsx` using `parseConnectFourJsonExport`.

Both components should mirror chess menu behavior: download/copy for export and file input for import.

- [x] **Step 4: Create setup component**

Create `components/games/connect-four/ConnectFourSetup.tsx` with props:

```ts
interface ConnectFourSetupProps {
  gameMode: ConnectFourGameMode;
  humanPlayer: ConnectFourPlayer;
  redAI: GameAIConfigValue;
  yellowAI: GameAIConfigValue;
  models: GameAIModelOption[];
  restoreMoves: number | null;
  onModeChange: (mode: ConnectFourGameMode) => void;
  onHumanPlayerChange: (player: ConnectFourPlayer) => void;
  onRedAIChange: (config: GameAIConfigValue) => void;
  onYellowAIChange: (config: GameAIConfigValue) => void;
  onStart: () => void;
  onResume: () => void;
  onStartNew: () => void;
  onImport: (snapshot: ConnectFourSessionSnapshot) => void;
}
```

Render mode buttons, side selection for PvAI, AI panels for AI-controlled players, start/resume buttons, and import.

- [x] **Step 5: Run TypeScript**

Run: `npx --yes tsc --noEmit`

Expected: pass.

- [x] **Step 6: Commit Task 6**

```powershell
git add components/games/connect-four
git commit -m "Add Connect Four UI components"
```

---

### Task 7: Connect Four Client Orchestration

**Files:**
- Modify: `app/games/connect-four-game-client.tsx`
- Modify: `lib/games/connect-four/engine.ts` if AI interaction metadata must be attached to moves.

- [x] **Step 1: Replace the temporary client with a stateful client**

Implement `ConnectFourGameClient` with focused local state:
- `gameStarted`
- `gameState`
- `gameMode`
- `humanPlayer`
- `redAI`, `yellowAI`
- `isPaused`
- `aiThinking`, `aiError`, `aiWarning`
- `lastAiInteraction`
- replay state: `isReplayReviewing`, `replayIndex`
- restore snapshot

Use these existing imports:

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { GameAIPresence } from "@/components/games/GameAIPresence";
import { ConnectFourBoard } from "@/components/games/connect-four/ConnectFourBoard";
import { ConnectFourControls } from "@/components/games/connect-four/ConnectFourControls";
import { ConnectFourMoveHistory } from "@/components/games/connect-four/ConnectFourMoveHistory";
import { ConnectFourPlayerPanel } from "@/components/games/connect-four/ConnectFourPlayerPanel";
import { ConnectFourSetup } from "@/components/games/connect-four/ConnectFourSetup";
import {
  createInitialConnectFourState,
  dropDisc,
  getLegalColumns,
  isLegalColumn,
  setConnectFourPaused,
} from "@/lib/games/connect-four/engine";
import {
  chooseFallbackConnectFourColumn,
  getAvailableConnectFourModels,
  getConnectFourModelApiKey,
  getConnectFourModelBaseURL,
  requestConnectFourAIMove,
} from "@/lib/games/connect-four/ai";
import {
  CONNECT_FOUR_ACTIVE_SESSION_ID,
  createConnectFourSessionRecord,
  isConnectFourActiveStatus,
  parseConnectFourSessionRecord,
  type ConnectFourSessionSnapshot,
} from "@/lib/games/connect-four/session";
import { deleteGameSession, listGameSessions, saveGameSession } from "@/lib/games/core/session-store";
```

- [x] **Step 2: Implement human moves**

Add `handleColumnClick(column)`:
- Ignore when not started, paused, replaying, AI thinking, not active, or not human turn.
- Verify `isLegalColumn(gameState, column)`.
- Apply `dropDisc`.
- Clear AI warnings/errors for successful human move.

- [x] **Step 3: Implement AI moves**

Add an effect like chess:
- When current player is AI and game is active, request move.
- Use `requestConnectFourAIMove`.
- On success, apply legal column and set `lastAiInteraction`.
- On recoverable failure in AIvAI, use `chooseFallbackConnectFourColumn`.
- On nonrecoverable failure, show `aiError`.
- Abort in-flight requests on reset, import, pause, or unmount.

Use a simple recoverability helper:

```ts
function isRecoverableConnectFourAIError(error: string): boolean {
  const normalized = error.toLowerCase();
  if (
    normalized.includes("aborted") ||
    normalized.includes("unknown provider") ||
    normalized.includes("unauthorized") ||
    normalized.includes("forbidden") ||
    normalized.includes("invalid api key") ||
    normalized.includes("quota") ||
    normalized.includes("key limit")
  ) {
    return false;
  }
  return true;
}
```

- [x] **Step 4: Implement autosave and restore**

Use `listGameSessions` to find `gameId === "connect-four"` and parse it with `parseConnectFourSessionRecord`.

Autosave active or paused games with `saveGameSession(createConnectFourSessionRecord(snapshot))`.

Delete `CONNECT_FOUR_ACTIVE_SESSION_ID` when a game reaches `win` or `draw` and the result has been handled.

- [x] **Step 5: Implement import/export and replay wiring**

Use the Connect Four import/export components. Replay displays reconstructed board state from `moveHistory[index].boardAfter`; index `-1` means initial board.

- [x] **Step 6: Run TypeScript**

Run: `npx --yes tsc --noEmit`

Expected: pass.

- [x] **Step 7: Commit Task 7**

```powershell
git add app/games/connect-four-game-client.tsx lib/games/connect-four/engine.ts
git commit -m "Wire Connect Four gameplay client"
```

---

### Task 8: Minimal Connect Four Benchmark Support

**Files:**
- Create: `lib/games/connect-four/benchmark.ts`
- Modify: `components/games/GamesBenchmark.tsx`
- Modify: `scripts/test-game-benchmark-registry.mts`

- [x] **Step 1: Add benchmark runner logic**

Create `lib/games/connect-four/benchmark.ts` with a runner that accepts red/yellow AI model ids, reasoning effort, max moves, and abort signal. It should loop until win/draw/max moves, call `requestConnectFourAIMove`, track invalid/fallback counts, and return `ConnectFourMatchRecord`.

Use `chooseFallbackConnectFourColumn` for recoverable AI failures.

- [x] **Step 2: Add UI game selector to benchmark panel**

Modify `components/games/GamesBenchmark.tsx`:
- Add a segmented selector: Chess / Connect Four.
- Keep chess behavior unchanged when Chess is selected.
- Show Connect Four configuration when Connect Four is selected.
- Display Connect Four progress: move count, current turn, result, invalid response count, fallback count.

- [x] **Step 3: Add/extend benchmark registry test**

Update `scripts/test-game-benchmark-registry.mts` by adding this Connect Four runner check after the existing registry checks:

```ts
import { registerGameBenchmark, getGameBenchmarkRunner } from "../lib/games/core/benchmark";

const unregister = registerGameBenchmark({
  gameId: "connect-four",
  label: "AI vs AI Connect Four Benchmark",
  run: async () => [{ id: "test" }],
});

if (!getGameBenchmarkRunner("connect-four")) {
  console.log("FAIL connect four runner missing");
  process.exit(1);
}
unregister();
console.log("PASS");
```

- [x] **Step 4: Run benchmark tests and TypeScript**

Run:
- `npx tsx scripts/test-game-benchmark-registry.mts`
- `npx --yes tsc --noEmit`

Expected: both pass.

- [x] **Step 5: Commit Task 8**

```powershell
git add lib/games/connect-four/benchmark.ts components/games/GamesBenchmark.tsx scripts/test-game-benchmark-registry.mts
git commit -m "Add Connect Four benchmark support"
```

---

### Task 9: Test Script Integration And Final Verification

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add Connect Four scripts to `test:games`**

Modify `package.json`:

```json
"test:games": "tsx lib/games/chess/rules-tests.mts && tsx lib/games/connect-four/rules-tests.mts && tsx scripts/test-chess-export.mts && tsx scripts/test-chess-ai-interactions.mts && tsx scripts/test-connect-four-ai.mts && tsx scripts/test-connect-four-session-export.mts && tsx scripts/test-games-catalog.mts && tsx scripts/test-game-benchmark-registry.mts && tsx scripts/test-game-session-store.mts"
```

- [ ] **Step 2: Run focused tests**

Run:
- `npx tsx lib/games/connect-four/rules-tests.mts`
- `npx tsx scripts/test-connect-four-ai.mts`
- `npx tsx scripts/test-connect-four-session-export.mts`
- `npx tsx scripts/test-games-catalog.mts`

Expected: all print final `PASS`.

- [ ] **Step 3: Run full games tests**

Run: `npm run test:games`

Expected: all game scripts pass.

- [ ] **Step 4: Run TypeScript**

Run: `npx --yes tsc --noEmit`

Expected: exit code 0.

- [ ] **Step 5: Run production build**

Run: `npm run build`

Expected: build succeeds. Existing provider `validationCandidate` lint warnings and the known multiple-lockfile warning are acceptable if unchanged.

- [ ] **Step 6: Commit Task 9**

```powershell
git add package.json package-lock.json
git commit -m "Add Connect Four tests to games suite"
```

---

### Task 10: Manual Browser Verification

**Files:**
- No source changes expected unless verification finds a bug.

- [ ] **Step 1: Start dev server**

Run: `npm run dev`

Expected: local Next server starts. If port 3000 is occupied, use the next available port from Next output.

- [ ] **Step 2: Verify game picker**

Open `/games`.

Expected:
- Chess card appears.
- Connect Four card appears.
- Selecting Chess opens existing chess setup.
- Back returns to picker.
- Selecting Connect Four opens Connect Four setup.

- [ ] **Step 3: Verify Connect Four PvP**

Start Player vs Player.

Expected:
- Red moves first.
- Clicking a column drops a red disc to the bottom.
- Yellow moves next.
- Four in a row ends game with clear winner.
- Reset starts a fresh board.

- [ ] **Step 4: Verify Connect Four import/export/replay**

Play at least four moves.

Expected:
- Move-list export contains one-based columns.
- JSON export imports back into the same position.
- Replay controls step through the position without changing the live game.

- [ ] **Step 5: Verify AI modes with configured model**

If a provider key is configured:
- Start Player vs AI and confirm AI moves.
- Start AI vs AI and confirm recoverable errors do not permanently freeze the match when fallback can continue.

If no provider key is configured:
- Confirm setup disables or explains AI start consistently with chess.

- [ ] **Step 6: Stop dev server**

Stop the dev server cleanly before running any production build again.

- [ ] **Step 7: Commit verification fixes if needed**

If source changes were required:

```powershell
git add <changed-files>
git commit -m "Fix Connect Four verification issues"
```

---

## Final Delivery

- [ ] Confirm `git status --short --branch` is clean.
- [ ] Push `codex/connect-four-game`.
- [ ] Open a PR against `main`.
- [ ] Include verification results in the PR description.
