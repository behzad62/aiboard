# Connect Four Game Design

## Goal

Add Connect Four as the second game in the Games section while improving the games architecture for future games. The first version supports Player vs Player, Player vs AI, and AI vs AI; it does not include chess-style clocks or time controls.

The implementation must keep game-specific concerns isolated. Shared code should stay small and justified by real reuse between Chess and Connect Four.

## User Experience

The `/games` page opens with a compact game picker instead of launching Chess directly. The picker shows cards for Chess and Connect Four, and can surface resume status for each game when an unfinished session exists.

Selecting Chess opens the existing chess experience behind a dedicated Chess client boundary. Selecting Connect Four opens the Connect Four setup screen.

Connect Four setup includes:
- Game mode: Player vs Player, Player vs AI, AI vs AI.
- Human side selection for Player vs AI.
- AI model and reasoning effort selectors for AI-controlled players.
- Resume unfinished game when one exists.
- Import JSON game option.

Connect Four play screen includes:
- A polished 7-column by 6-row board.
- Clearly labeled Red and Yellow players.
- Current-turn indication.
- Clickable columns for human moves.
- AI presence/gesture display using the existing game AI interaction vocabulary.
- Move history by column.
- Reset, pause/resume, export, import, and replay controls.

No game clocks are shown. Benchmark timing records AI response duration as a metric.

## Architecture

### Games Page Shell

`app/games/games-client.tsx` should stop being a chess-only top-level surface. It should become a small shell responsible for:
- Loading available game cards.
- Showing the picker.
- Opening the selected game.
- Checking generic session records for resumable sessions.

The shell must not contain Connect Four rules, AI logic, or detailed chess state.

Create a clear `ChessGameClient` boundary and keep existing chess behavior unchanged inside that component.

### Connect Four Domain Modules

Add a dedicated module family under `lib/games/connect-four/`:

- `types.ts`: board, piece color, move, move record, game state, game mode, match record, AI response types.
- `engine.ts`: pure rules and state transitions.
- `ai.ts`: prompt construction, response parsing, provider request/retry handling, and deterministic fallback move.
- `session.ts`: active session snapshot, generic `GameSessionRecord` conversion, validation/parsing.
- `export.ts`: JSON export/import and a simple text move-list export.
- `rules-tests.mts`: pure rules regression checks.

Rules must be deterministic and UI-independent:
- Board is 7 columns by 6 rows.
- Legal moves are non-full columns.
- A move drops to the lowest available row.
- Win detection covers horizontal, vertical, and both diagonals.
- Draw is all columns full with no winner.
- Move history stores column, color, resulting board state, timestamp, and optional AI interaction metadata.

### Connect Four AI Protocol

Connect Four uses the same game AI interaction metadata shape as Chess, but the move payload is game-specific:

```json
{
  "column": 3,
  "gesture": "confident",
  "utterance": "I am building pressure in the center.",
  "confidence": 0.74
}
```

Prompt rules:
- Columns shown to models are 1-7.
- The model must choose one legal column.
- The response must be JSON only.
- Correction prompts repeat the legal columns when parsing fails or the model chooses a full/invalid column.

Provider/API failures should retry with the same short backoff pattern used for Chess AI. Bad JSON or invalid columns should retry with a correction prompt. In AI vs AI, recoverable failures may use a deterministic fallback move so the match can continue.

Fallback move selection should be simple and Connect Four-specific:
- Win immediately if possible.
- Block opponent immediate win.
- Prefer center columns.
- Avoid obviously losing moves when a one-ply check is cheap.
- Otherwise choose the best legal column by center weighting.

### React Components

Add components under `components/games/connect-four/`:

- `ConnectFourBoard.tsx`: visual board and column input.
- `ConnectFourSetup.tsx`: setup mode/player controls.
- `ConnectFourPlayerPanel.tsx`: player identity, AI model, reasoning effort, current turn.
- `ConnectFourControls.tsx`: reset, pause/resume, replay controls.
- `ConnectFourMoveHistory.tsx`: compact move list.
- `ConnectFourExportMenu.tsx` and `ConnectFourImportMenu.tsx`: import/export affordances.

Reusable UI should only be extracted when it serves both games cleanly. Good candidates:
- A compact game picker card.
- AI model/reasoning selector if it can be made game-neutral without leaking chess names.
- AI presence display if the current chess component can be generalized without changing behavior.

Avoid a large generic game runtime abstraction in this version.

## Persistence And Export

Use the existing generic game session store. Connect Four should have its own active session id, for example `connect-four-active-session`.

Autosave should preserve:
- Game state.
- Mode and player side.
- AI config for each side.
- Pause/replay state if needed to resume correctly.
- Last AI interaction and warning/error state.

Export should include:
- JSON export suitable for full import/restore.
- Text move list suitable for quick sharing.

Importing a Connect Four JSON file replaces the current Connect Four board after confirmation when a game is active.

## Benchmark Support

Add minimal AI vs AI benchmark support for Connect Four in the existing games benchmark area. This is not the final comprehensive metrics system.

Initial metrics:
- Winner: red, yellow, or draw.
- Move count.
- Total duration.
- Average AI response duration.
- Invalid/bad response count when available.
- Fallback count when recoverable AI failures are handled by fallback.

The benchmark implementation should be isolated enough to be replaced or expanded by the later comprehensive cross-game metrics plan.

## Testing

Use test-first implementation for new behavior.

Required script coverage:
- Connect Four rules: legal columns, drop behavior, horizontal/vertical/diagonal wins, draw, illegal full column.
- Connect Four AI parsing and correction prompt behavior.
- Connect Four fallback move priority: immediate win, immediate block, center preference.
- Connect Four session parsing rejects malformed records and accepts valid snapshots.
- Connect Four export/import round trip.
- Game picker lists Chess and Connect Four.
- Benchmark registry includes Connect Four runner after registration.

Final verification:
- Connect Four focused scripts.
- Existing games tests.
- `npx --yes tsc --noEmit`.
- `npm run build`.

## Non-Goals

- No chess-style clocks or time controls for Connect Four.
- No comprehensive cross-game benchmark dashboard in this change.
- No generic game runtime framework unless a small interface is clearly needed.
- No changes to provider settings or model catalog.
- No visual redesign of Chess beyond the extraction needed to place it behind the game picker.

## Open Decisions Resolved

- Connect Four has three modes: Player vs Player, Player vs AI, AI vs AI.
- AI move protocol uses JSON with `column` plus optional interaction metadata.
- The Games page starts with a compact game picker.
- Minimal Connect Four benchmark support is included now; richer cross-game metrics come later.
