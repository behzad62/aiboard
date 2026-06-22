# Games Platform and Chess Gameplay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the current chess prototype into a durable first game in a reusable Games platform, with refresh-safe game state, move export, stronger chess gameplay, and reusable AI interaction primitives for future games.

**Architecture:** Add a small generic `lib/games/core` layer for persisted sessions, game exports, match records, and AI interaction metadata. Keep chess-specific rules/UI under `lib/games/chess`, `components/games`, and `app/games`, but make chess use the generic session and AI interaction services so later games can plug into the same storage, benchmark, and AI surfaces.

**Tech Stack:** Next.js App Router static export, React client components, TypeScript strict mode, existing client store in `lib/client/store.ts`, Playwright E2E, plain `tsx` unit scripts.

---

## File Structure

- Create `lib/games/core/types.ts`
  - Generic game ids, participants, sessions, actions, match records, exports, and AI interaction metadata.
- Create `lib/games/core/session-store.ts`
  - Browser/client-store backed save/load/delete/list APIs for active game sessions and match records.
- Create `lib/games/core/export.ts`
  - Shared download/clipboard helpers for text and JSON game exports.
- Create `lib/games/core/ai-interactions.ts`
  - Shared AI response metadata: optional gesture, short utterance, confidence, and diagnostics.
- Modify `lib/db/schema.ts`
  - Add generic persisted game record types.
- Modify `lib/client/store.ts`
  - Add `gameSessions` and `gameMatchRecords` arrays to `ClientStore` and default store.
- Modify `lib/games/stats.ts`
  - Move from direct `localStorage` to the new core match-record store, with one-time legacy import from `aiboard-game-stats`.
- Create `lib/games/chess/session.ts`
  - Chess-specific session serialization, restoration, active-state detection, and autosave payload normalization.
- Create `lib/games/chess/export.ts`
  - Chess export as PGN-like text, FEN list, compact JSON, and plain move list.
- Create `lib/games/chess/rules-tests.mts`
  - Regression tests for check continuation, checkmate, stalemate, castling, en passant, promotion, repetition, and halfmove draw.
- Modify `lib/games/chess/ai.ts`
  - Return optional AI interaction metadata in addition to a validated move.
- Modify `app/games/games-client.tsx`
  - Split gameplay concerns into focused hooks/components, restore autosaved chess sessions, fix check-state gameplay, cancel stale AI requests, add promotion picker, add export controls.
- Create `components/games/chess/PromotionDialog.tsx`
  - Human promotion selection UI.
- Create `components/games/chess/ExportGameMenu.tsx`
  - Export/download/copy controls.
- Create `components/games/chess/AIPresence.tsx`
  - Optional AI gesture/utterance display for chess and future games.
- Modify `components/games/ChessBoard.tsx`
  - Add drag/drop, touch-friendly move targeting, keyboard square navigation, and orientation toggle support.
- Modify `components/games/chess/ChessClock.tsx`
  - Support time-control presets, increment, timeout status, and active `"check"` state.
- Modify `components/games/GamesBenchmark.tsx`
  - Read/write generic match records while keeping chess-specific benchmark labels.
- Modify `tests/e2e/chess-game.spec.ts`
  - Extend E2E coverage for refresh restore, promotion, export, check-state continuation, timeout, and AI stale-response cancellation.
- Create `scripts/test-game-session-store.mts`
  - Unit coverage for generic game session persistence and legacy stats migration.
- Create `scripts/test-chess-export.mts`
  - Unit coverage for PGN/FEN/JSON exports.

---

## Task 1: Generic Game Persistence Types

**Files:**
- Modify: `lib/db/schema.ts`
- Create: `lib/games/core/types.ts`

- [ ] Add generic persisted game types.

`lib/games/core/types.ts` should define:

```ts
export type GameId = "chess" | (string & {});
export type GameSessionStatus = "setup" | "active" | "paused" | "complete" | "abandoned";

export interface GameParticipant {
  id: string;
  kind: "human" | "ai";
  label: string;
  modelId?: string;
  reasoningEffort?: string;
}

export interface GameAIInteraction {
  actorId: string;
  gesture?: "thinking" | "confident" | "confused" | "celebrating" | "apologetic" | "neutral";
  utterance?: string;
  confidence?: number;
  diagnostics?: string;
}

export interface GameSessionRecord {
  id: string;
  gameId: GameId;
  title: string;
  status: GameSessionStatus;
  participants: GameParticipant[];
  stateJson: string;
  metadataJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface GenericGameMatchRecord {
  id: string;
  gameId: GameId;
  timestamp: string;
  participants: GameParticipant[];
  resultJson: string;
  statsJson: string;
}

export interface GameExport {
  filename: string;
  mimeType: "text/plain" | "application/json";
  content: string;
}
```

- [ ] Re-export or import these types from `lib/db/schema.ts` so `ClientStore` can persist them without game-specific imports.

- [ ] Run `npx --yes tsc --noEmit`.
  Expected: compile succeeds or only reports files that still need Task 2 wiring.

- [ ] Commit:

```bash
git add lib/db/schema.ts lib/games/core/types.ts
git commit -m "feat: add generic game persistence types"
```

---

## Task 2: Store Game Sessions in the Existing Client Store

**Files:**
- Modify: `lib/client/store.ts`
- Create: `lib/games/core/session-store.ts`
- Test: `scripts/test-game-session-store.mts`

- [ ] Extend `ClientStore` with:

```ts
gameSessions: GameSessionRecord[];
gameMatchRecords: GenericGameMatchRecord[];
```

Initialize both arrays in `DEFAULT_STORE`.

- [ ] Add read/write helpers in `lib/client/store.ts`:

```ts
export function getGameSessions(): GameSessionRecord[] {
  return store().gameSessions;
}

export function upsertGameSession(record: GameSessionRecord): void {
  const list = store().gameSessions;
  const i = list.findIndex((s) => s.id === record.id);
  if (i >= 0) list[i] = record;
  else list.push(record);
  schedulePersist();
}

export function deleteGameSession(id: string): void {
  store().gameSessions = store().gameSessions.filter((s) => s.id !== id);
  schedulePersist();
}

export function getGenericGameMatchRecords(): GenericGameMatchRecord[] {
  return store().gameMatchRecords;
}

export function saveGenericGameMatchRecord(record: GenericGameMatchRecord): void {
  store().gameMatchRecords.push(record);
  schedulePersist();
}
```

- [ ] Implement `lib/games/core/session-store.ts` as a thin browser-safe wrapper that calls `ensureReady()` before store reads/writes and returns empty lists when storage is locked.

- [ ] Write `scripts/test-game-session-store.mts` to verify:
  - A session can be saved and listed.
  - Saving the same id updates instead of duplicating.
  - Deleting removes only that session.
  - Match records are append-only.

- [ ] Run:

```bash
npx tsx scripts/test-game-session-store.mts
npx --yes tsc --noEmit
```

Expected: test prints `PASS`; TypeScript passes.

- [ ] Commit:

```bash
git add lib/client/store.ts lib/games/core/session-store.ts scripts/test-game-session-store.mts
git commit -m "feat: persist generic game sessions"
```

---

## Task 3: Migrate Game Stats to Generic Match Records

**Files:**
- Modify: `lib/games/stats.ts`
- Test: `scripts/test-game-session-store.mts`

- [ ] Keep public APIs such as `saveMatchRecord`, `getAIvsAIMatches`, and `getAIvsAIModelStats`, but back them with `GenericGameMatchRecord`.

- [ ] Add one-time legacy import from `localStorage["aiboard-game-stats"]`:
  - Import only when generic match records are empty.
  - Convert each chess `GameMatchRecord` into a generic record with `gameId: "chess"`.
  - Preserve the legacy key after import for safety; do not delete user data.

- [ ] Add a test that seeds legacy localStorage, calls `getMatchRecords()`, and verifies records are returned through the new path.

- [ ] Run:

```bash
npx tsx scripts/test-game-session-store.mts
npx --yes tsc --noEmit
```

- [ ] Commit:

```bash
git add lib/games/stats.ts scripts/test-game-session-store.mts
git commit -m "refactor: store game stats in client store"
```

---

## Task 4: Chess Session Serialization and Refresh Restore

**Files:**
- Create: `lib/games/chess/session.ts`
- Modify: `app/games/games-client.tsx`
- Test: `tests/e2e/chess-game.spec.ts`

- [ ] Create a `ChessSessionSnapshot` type containing:
  - `gameMode`
  - `humanColor`
  - `whiteAI`
  - `blackAI`
  - `gameState`
  - `whiteTimeMs`
  - `blackTimeMs`
  - `gameStartTime`
  - `isPaused`
  - `lastAiInteraction`

- [ ] Implement:

```ts
export function createChessSessionRecord(snapshot: ChessSessionSnapshot): GameSessionRecord;
export function parseChessSessionRecord(record: GameSessionRecord): ChessSessionSnapshot | null;
export function isChessActiveStatus(status: GameStatus): boolean;
```

`isChessActiveStatus` must return `true` for `"playing"` and `"check"`.

- [ ] In `GamesClient`, autosave active games with a short debounce after every meaningful state change.

- [ ] On `/games` load, if an incomplete chess session exists, show a compact restore banner:
  - `Resume game`
  - `Start new`

- [ ] When the game ends or the user resets, mark the session `complete` or delete the active session.

- [ ] Add E2E:
  - Start PvP.
  - Move e2-e4.
  - Reload page.
  - Click `Resume game`.
  - Assert the move history still includes `e4` and clocks are non-empty.

- [ ] Run:

```bash
npm run test:e2e
npm run build
```

- [ ] Commit:

```bash
git add lib/games/chess/session.ts app/games/games-client.tsx tests/e2e/chess-game.spec.ts
git commit -m "feat: restore chess games after refresh"
```

---

## Task 5: Fix Active Check State Everywhere

**Files:**
- Modify: `app/games/games-client.tsx`
- Modify: `components/games/chess/ChessClock.tsx`
- Test: `lib/games/chess/rules-tests.mts`

- [ ] Replace checks like:

```ts
gameState.status !== "playing"
```

with:

```ts
!isChessActiveStatus(gameState.status)
```

in the timer effect, AI effect, and human click handler.

- [ ] Make clock active for `"playing"` and `"check"` positions.

- [ ] Add a chess regression test that creates a check position and verifies a legal response move can still be made.

- [ ] Run:

```bash
npx tsx lib/games/chess/rules-tests.mts
npm run test:e2e
```

- [ ] Commit:

```bash
git add app/games/games-client.tsx components/games/chess/ChessClock.tsx lib/games/chess/rules-tests.mts
git commit -m "fix: keep chess playable while in check"
```

---

## Task 6: Cancel Stale AI Requests

**Files:**
- Modify: `app/games/games-client.tsx`
- Modify: `lib/games/chess/ai.ts`
- Test: `tests/e2e/chess-game.spec.ts`

- [ ] Add `sessionVersionRef` or `requestIdRef` in `GamesClient`.

- [ ] Increment it on reset, pause, resume, game mode changes, and every new game.

- [ ] Capture the current request id before calling `requestAIMove`.

- [ ] After the AI response returns, apply the move only when the current request id still matches.

- [ ] Extend `requestAIMove` to accept optional `AbortSignal`. For providers that do not support abort, still ignore stale results in the caller.

- [ ] Add E2E or unit harness for reset-during-AI:
  - Start AI mode with a stubbed delayed AI provider.
  - Reset before the response resolves.
  - Assert the old AI move is not applied.

- [ ] Commit:

```bash
git add app/games/games-client.tsx lib/games/chess/ai.ts tests/e2e/chess-game.spec.ts
git commit -m "fix: ignore stale chess AI responses"
```

---

## Task 7: Promotion Picker

**Files:**
- Create: `components/games/chess/PromotionDialog.tsx`
- Modify: `app/games/games-client.tsx`
- Test: `tests/e2e/chess-game.spec.ts`

- [ ] Add pending promotion state:

```ts
const [pendingPromotion, setPendingPromotion] = useState<{ from: Square; to: Square } | null>(null);
```

- [ ] When a human pawn reaches the last rank, open `PromotionDialog` instead of auto-promoting to queen.

- [ ] `PromotionDialog` must offer Queen, Rook, Bishop, Knight and be keyboard accessible.

- [ ] On selection, call `makeMove` with the selected promotion.

- [ ] Add E2E using a test-only FEN/session helper or unit test to verify all four promotion choices are accepted.

- [ ] Commit:

```bash
git add components/games/chess/PromotionDialog.tsx app/games/games-client.tsx tests/e2e/chess-game.spec.ts
git commit -m "feat: add chess promotion picker"
```

---

## Task 8: Move Export

**Files:**
- Create: `lib/games/chess/export.ts`
- Create: `lib/games/core/export.ts`
- Create: `components/games/chess/ExportGameMenu.tsx`
- Modify: `app/games/games-client.tsx`
- Test: `scripts/test-chess-export.mts`

- [ ] Implement chess exports:
  - `exportChessMoveList(state): GameExport`
  - `exportChessFenList(state): GameExport`
  - `exportChessJson(snapshot): GameExport`
  - `exportChessPgnLike(state, metadata): GameExport`

- [ ] PGN-like output must include tags:

```text
[Event "AI Board Chess"]
[Site "AI Board"]
[Date "YYYY.MM.DD"]
[Result "1-0|0-1|1/2-1/2|*"]
```

- [ ] Add shared browser helpers:
  - `downloadGameExport(exportData)`
  - `copyGameExportToClipboard(exportData)`

- [ ] Add an export menu beside Reset/Pause:
  - Copy PGN
  - Download PGN
  - Download JSON
  - Copy FEN

- [ ] Test:

```bash
npx tsx scripts/test-chess-export.mts
npm run test:e2e
```

- [ ] Commit:

```bash
git add lib/games/chess/export.ts lib/games/core/export.ts components/games/chess/ExportGameMenu.tsx app/games/games-client.tsx scripts/test-chess-export.mts
git commit -m "feat: export chess moves"
```

---

## Task 9: Stronger Chess Rule Regression Coverage

**Files:**
- Create/modify: `lib/games/chess/rules-tests.mts`
- Modify: `package.json`

- [ ] Add `test:games` script:

```json
"test:games": "tsx lib/games/chess/rules-tests.mts && tsx scripts/test-chess-export.mts && tsx scripts/test-game-session-store.mts"
```

- [ ] Add tests for:
  - Castling blocked by check.
  - En passant capture.
  - Pawn promotion.
  - Checkmate detection.
  - Stalemate detection.
  - Threefold repetition.
  - Fifty-move draw.
  - Legal move generation does not allow leaving own king in check.

- [ ] If any test exposes a rules bug, fix the custom engine in `lib/games/chess/engine.ts`.

- [ ] If three or more rule fixes become broad rewrites, stop and create a separate `chess.js` migration plan behind `lib/games/chess/adapter.ts`.

- [ ] Commit:

```bash
git add package.json lib/games/chess/rules-tests.mts lib/games/chess/engine.ts
git commit -m "test: harden chess rules"
```

---

## Task 10: Board Interaction Upgrade

**Files:**
- Modify: `components/games/ChessBoard.tsx`
- Modify: `app/games/games-client.tsx`
- Test: `tests/e2e/chess-game.spec.ts`

- [ ] Add pointer drag:
  - Mouse drag from piece square to target square.
  - Touch drag using pointer events.
  - Keep click-to-move behavior.

- [ ] Add keyboard navigation:
  - Arrow keys move focused square.
  - Enter/Space selects or moves.
  - Escape clears selection.

- [ ] Add orientation toggle in game controls:
  - `White view`
  - `Black view`
  - `Auto`

- [ ] Improve target indicators:
  - Empty legal move: dot.
  - Capture legal move: ring.
  - Last move: from/to highlight.
  - King in check: danger outline.

- [ ] Run:

```bash
npm run test:e2e
```

- [ ] Commit:

```bash
git add components/games/ChessBoard.tsx app/games/games-client.tsx tests/e2e/chess-game.spec.ts
git commit -m "feat: improve chess board interactions"
```

---

## Task 11: Real Chess Clocks

**Files:**
- Modify: `components/games/chess/ChessClock.tsx`
- Modify: `components/games/chess/GameControls.tsx`
- Modify: `app/games/games-client.tsx`
- Test: `tests/e2e/chess-game.spec.ts`

- [ ] Add setup controls for time modes:
  - Untimed
  - 5+0 blitz
  - 10+0 rapid
  - 15+10 rapid
  - Custom minutes and increment

- [ ] Store remaining time instead of only elapsed time when a timed mode is active.

- [ ] On every completed move, add increment to the player who moved.

- [ ] If a clock reaches zero, set game result to timeout and save match record.

- [ ] Save time-control settings in the chess session snapshot so refresh restore is exact.

- [ ] Add E2E for a short test clock using a test-only 3-second custom control.

- [ ] Commit:

```bash
git add components/games/chess/ChessClock.tsx components/games/chess/GameControls.tsx app/games/games-client.tsx tests/e2e/chess-game.spec.ts
git commit -m "feat: add chess time controls"
```

---

## Task 12: AI Interaction Metadata for Future Games

**Files:**
- Create: `lib/games/core/ai-interactions.ts`
- Modify: `lib/games/chess/ai.ts`
- Create: `components/games/chess/AIPresence.tsx`
- Modify: `app/games/games-client.tsx`

- [ ] Define a reusable interaction payload:

```ts
export interface GameAIInteractionResult<TAction> {
  action: TAction;
  gesture?: GameAIInteraction["gesture"];
  utterance?: string;
  confidence?: number;
  diagnostics?: string;
}
```

- [ ] Update the chess AI JSON protocol to allow optional fields:

```json
{
  "from": "e2",
  "to": "e4",
  "promotion": "queen",
  "gesture": "confident",
  "utterance": "I like the central control here.",
  "confidence": 0.72
}
```

- [ ] Keep chess quiet by default:
  - Show an AI presence chip only when an AI returns `utterance` or non-neutral `gesture`.
  - Limit utterances to one short sentence.
  - Never block gameplay on missing interaction metadata.

- [ ] Future games can reuse the same structure for gestures, taunts, hints, or animations.

- [ ] Commit:

```bash
git add lib/games/core/ai-interactions.ts lib/games/chess/ai.ts components/games/chess/AIPresence.tsx app/games/games-client.tsx
git commit -m "feat: add reusable AI interaction metadata"
```

---

## Task 13: Generic Games Benchmark Foundation

**Files:**
- Create: `lib/games/core/benchmark.ts`
- Modify: `components/games/GamesBenchmark.tsx`
- Modify: `lib/games/stats.ts`

- [ ] Add generic benchmark interfaces:

```ts
export interface GameBenchmarkRunner<TConfig, TResult> {
  gameId: GameId;
  run(config: TConfig, signal: AbortSignal): Promise<TResult>;
}
```

- [ ] Keep the current chess benchmark UI, but make its storage and aggregate calculations consume generic records filtered by `gameId: "chess"`.

- [ ] Add a placeholder-free extension point for future games:
  - `registerGameBenchmark(runner)`
  - `listGameBenchmarkRunners()`

- [ ] Commit:

```bash
git add lib/games/core/benchmark.ts components/games/GamesBenchmark.tsx lib/games/stats.ts
git commit -m "refactor: prepare game benchmarks for multiple games"
```

---

## Task 14: Final Verification and PR

**Files:**
- Modify: PR body only.

- [ ] Run full verification:

```bash
git diff --check
npx --yes tsc --noEmit
npm run lint
npm run test:games
npm run test:e2e
npm run build
```

- [ ] Review browser manually:
  - `/games`: restore banner, setup modes, board interaction, export menu.
  - `/benchmark`: chess benchmark section with no models, one model, and two configured models.

- [ ] Update PR description with:
  - Gameplay correctness fixes.
  - Refresh-safe sessions.
  - Export support.
  - Generic games services.
  - AI interaction metadata.
  - Validation commands and results.

- [ ] Commit any final docs/test updates:

```bash
git add docs tests package.json package-lock.json
git commit -m "docs: summarize games platform improvements"
```

---

## Self-Review

- Spec coverage: The plan covers check-state gameplay, stale AI cancellation, promotion, stronger rule tests, board interactions, real clocks, game-end/export UX, refresh-safe storage, reusable game services, generic benchmark foundation, and AI interaction metadata for future games.
- Placeholder scan: No task contains unresolved placeholders. The only conditional branch is explicit: if custom chess rules require broad rewrites, stop and create a separate `chess.js` migration plan.
- Type consistency: Generic session and match record types are defined first, then used by storage, stats, chess session serialization, benchmark, and exports.
