# Codenames Game Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a full two-team Codenames game to the existing Games section with human and AI roles, private spymaster views, structured AI output, export/import, and session persistence.

**Architecture:** Follow the existing game module pattern: pure game rules in `lib/games/codenames/engine.ts`, type contracts in `types.ts`, AI parsing/request code in `ai.ts`, persistence/export helpers in `session.ts` and `export.ts`, and focused React components under `components/games/codenames/`. The app-level client coordinates mode, role ownership, AI turns, handoffs, and persistence without embedding game-rule logic.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript strict, Tailwind, client-side provider registry, plain `tsx` script tests.

---

### Task 1: Codenames Rules Engine

**Files:**
- Create: `lib/games/codenames/types.ts`
- Create: `lib/games/codenames/engine.ts`
- Create: `lib/games/codenames/rules-tests.mts`
- Modify: `lib/games/index.ts`

- [ ] Write failing rules tests covering 5x5 board generation, 9/8/7/1 role distribution, clue validation, public/spymaster views, valid guesses, reveal outcomes, team switching, win, assassin loss, and pause/resume.
- [ ] Run `npx tsx lib\games\codenames\rules-tests.mts` and confirm it fails because the module is missing.
- [ ] Implement pure engine functions: `createInitialCodenamesState`, `createCodenamesStateFromBoard`, `validateCodenamesClue`, `submitCodenamesClue`, `submitCodenamesGuesses`, `getCodenamesPublicBoard`, `getCodenamesSpymasterBoard`, `setCodenamesPaused`.
- [ ] Export Codenames types/engine from `lib/games/index.ts`.
- [ ] Run the rules tests and `npx --yes tsc --noEmit --pretty false`.

### Task 2: Codenames AI Protocol

**Files:**
- Create: `lib/games/codenames/ai.ts`
- Create: `scripts/test-codenames-ai.mts`
- Modify: `package.json`

- [ ] Write failing tests for spymaster response parsing, invalid board-word clue rejection, multi-word clue rejection, guesser response parsing, duplicate/revealed guesses rejection, structured output schemas, and prompt hiding of roles from guesser.
- [ ] Run `npx tsx scripts\test-codenames-ai.mts` and confirm it fails because the AI module is missing.
- [ ] Implement JSON parsing, compact diagnostics, response schemas, prompts, and `requestCodenamesSpymasterMove` / `requestCodenamesGuesserMove` using existing provider helpers.
- [ ] Add the Codenames AI test script to `npm run test:games`.
- [ ] Run `npx tsx scripts\test-codenames-ai.mts` and `npm run test:games`.

### Task 3: Codenames Export And Session Persistence

**Files:**
- Create: `lib/games/codenames/export.ts`
- Create: `lib/games/codenames/session.ts`
- Create: `scripts/test-codenames-session-export.mts`
- Modify: `package.json`

- [ ] Write failing tests for move-list export, JSON export/import, active session record creation, snapshot parsing, and rejection of wrong-game JSON.
- [ ] Run `npx tsx scripts\test-codenames-session-export.mts` and confirm it fails because export/session modules are missing.
- [ ] Implement export descriptors and session record helpers using the shared `GameExportDescriptor` and `GameSessionRecord` patterns.
- [ ] Add the Codenames session/export test to `npm run test:games`.
- [ ] Run Codenames session/export tests and `npm run test:games`.

### Task 4: Codenames UI Components

**Files:**
- Create: `components/games/codenames/CodenamesBoard.tsx`
- Create: `components/games/codenames/CodenamesSetup.tsx`
- Create: `components/games/codenames/CodenamesHandoff.tsx`
- Create: `components/games/codenames/CodenamesCluePanel.tsx`
- Create: `components/games/codenames/CodenamesMoveHistory.tsx`
- Create: `components/games/codenames/CodenamesExportMenu.tsx`
- Create: `components/games/codenames/CodenamesImportMenu.tsx`

- [ ] Build focused components with prop-driven behavior and no game-rule logic.
- [ ] Keep spymaster role colors visible only in spymaster board mode.
- [ ] Use existing `GameAIConfigPanel` and `GameAIPresence` where possible.
- [ ] Ensure clue and guess controls are stable, accessible, and do not resize the board.

### Task 5: Codenames App Client And Catalog Wiring

**Files:**
- Create: `app/games/codenames-game-client.tsx`
- Modify: `app/games/games-client.tsx`
- Modify: `lib/games/catalog.ts`
- Modify: `components/games/GamePicker.tsx`
- Modify: `scripts/test-games-catalog.mts`

- [ ] Add Codenames to the game catalog and Games picker.
- [ ] Add `CodenamesGameClient` with modes: Player vs Player, Player vs AI, AI vs AI.
- [ ] Implement local privacy handoffs for same-screen spymaster/operative transitions.
- [ ] Implement AI seat assignment, AI clue generation, AI guessing, raw diagnostics, and recoverable error display.
- [ ] Implement autosave, resume, reset, import, and export using the session/export helpers.
- [ ] Run catalog tests, full game tests, typecheck, build, and browser verification at `/games`.

### Task 6: Final Review And Publish Branch

**Files:**
- All Codenames files and catalog wiring.

- [ ] Run `npx --yes tsc --noEmit --pretty false`.
- [ ] Run `npm run test:games`.
- [ ] Run `npm run build`.
- [ ] Restart the dev server on port 3000 and verify `/games` loads.
- [ ] Commit and push `codex/codenames-game`.
