# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # dev server with Turbopack (http://localhost:3000); predev copies runner.mjs to public/
npm run build    # static export to out/ (output: "export"); prebuild copies runner.mjs to public/
npm run lint     # ESLint (eslint.config.mjs, flat config, next/core-web-vitals)

# Tests — plain tsx scripts with PASS/FAIL output, no test runner:
npx tsx scripts/test-parse-action.mts   # Architect action JSON parsing
npx tsx scripts/test-edits.mts          # SEARCH/REPLACE edit application
npx tsx scripts/test-extract.ts         # file/edit block extraction from model output
npx tsx scripts/test-project-fs.ts      # File System Access path sanitization

# Build-mode upgrade suites (also in the test:benchmark:workbench group):
npx tsx scripts/test-build-worker-budgets.mts   # difficulty-scaled budgets + fix-round escalation
npx tsx scripts/test-build-split-task.mts       # split_task parse + in-place applyTaskSplit
npx tsx scripts/test-plan-critique.mts          # plan critique parser + blocking-issue gate
npx tsx scripts/test-review-diff-pack.mts       # wave-diff review pack rendering/truncation
npx tsx scripts/test-model-stats-tokens.mts     # token accumulation + tokens-per-approval KPI
npx tsx scripts/test-runner-mcp-image.mts       # MCP screenshot image passthrough (runner-lib)

# Benchmark UI cross-track suite (also in the test:benchmark:unit group):
npx tsx scripts/test-benchmark-team-lift.mts    # team-lift generalization: TeamIQ formula unchanged + WorkBench team/solo lift + null baseline + mixed-track sort

# Benchmark/certified suites run via npm groups:
npm run test:benchmark   # unit + tracks + workbench + e2e (the certified gate)

# GameIQ hardening — key standalone scripts (not all are in the npm groups):
npx tsx scripts/test-gameiq-fireworks-pack.mts        # fireworks pack completeness guard (keyed=sound / forbidden=harmful / clue-equivalence)
npx tsx scripts/test-gameiq-battleship-v2-pack.mts    # battleship v2 oracle-graded pack guard (independent enumerator; completeness, chains, floor)
npx tsx scripts/test-gameiq-chess-v2-pack.mts         # chess v2 quiet-mate prover-keyed pack guard
npx tsx scripts/test-gameiq-c4-v2-pack.mts            # connect-four v2 solver-keyed depth-pack guard
npx tsx scripts/test-gameiq-saturation.mts            # saturation registry sanity (exactly the 16-id fireworks-only survivor set, all ids resolve to registered scenarios)
npx tsx scripts/test-gameiq-replay-positional.mts     # gap/duplicate-aware legacy trace pairing
npx tsx scripts/test-gameiq-transport-containment.mts # unscored-transport math (no NaN, provider_unavailable threshold)
npx tsx scripts/test-certified-model-call-retry.mts   # transient-error retry/backoff + abort
npx tsx scripts/test-certified-run-partial-persistence.mts # finished packs survive a later fatal/budget failure
npx tsx scripts/test-certified-run-error-status.mts   # fatal provider error → provider_unavailable (not invalid_harness)
npx tsx scripts/test-recover-gameiq-run.mts           # voided-run recovery from traces (idempotent, dry-run default)
```

No app runtime env vars are needed: the app is fully client-side and provider API keys are entered at runtime on the Settings page. `.env.example` only disables Next.js telemetry for local development.

Platform: development happens on Windows / PowerShell. Gotcha: running `npm run build` while the dev server is up corrupts the dev server's `.next` (it starts returning 500s) — restart the dev server after a production build.

## Architecture

A **fully client-side** Next.js 15 app (App Router, React 19, TS strict, static export — no backend, no API routes). Several AI models discuss a topic across rounds and a judge model synthesizes the final answer; Build mode turns the judge into an Architect that plans tasks for worker models. Everything — storage, the engines, provider calls — runs in the browser tab. Import alias `@/*` → repo root.

The flow is: **page creates a `Discussion` in the client store → `runClientDiscussion` starts the in-browser engine → the engine streams provider output and `emit`s `OrchestratorEvent`s via a direct callback → React state updates render them.** No SSE, no polling, no server.

### Client store — one JSON blob in the browser
`lib/client/store.ts` loads a single JSON blob once (async) into memory, serves synchronous reads, and persists mutations debounced through a `StorageAdapter` (`lib/client/storage-adapter.ts`):
- **IndexedDB** (default) or a **user-picked local folder** via the File System Access API (desktop Chromium) — the folder variant writes `store.json` so multiple browsers or a cloud-synced folder can share state.
- Optional at-rest encryption (`lib/client/crypto-box.ts`): user passphrase → PBKDF2 (150k iters) → AES-256-GCM via Web Crypto, wrapped in an `Envelope`. Zero-knowledge, no recovery; the derived key is cached per tab session ("unlock").
- Types live in `lib/db/schema.ts` (shared, live). Array-ish fields (`Discussion.modelIds`, `attachmentIds`, `FinalResult.dissent`) are stored as **JSON strings** — parse/stringify at the boundary.
- Attachment bytes are stored base64 in the store itself (`lib/client/settings-api.ts`), not on disk.

`lib/client/api.ts` mirrors the old REST surface (createDiscussion, loadDashboard, …) as plain functions; `lib/client/settings-api.ts` does the same for Settings (keys, validation, custom models, attachments).

### Engines — run in the browser tab
- `lib/client/engine.ts` — panel / debate / specialist discussion loop: per-round parallel streaming, stagnation detection (`wordOverlapSimilarity` > 0.92), convergence voting, judge synthesis. Tuned via `EFFORT_CONFIG` in `lib/orchestrator/config.ts`.
- `lib/client/build-engine.ts` — Build mode: the Architect (judge model) plans tasks → workers implement them in parallel waves → Architect reviews/fixes/adds tasks → hand-off summary. Includes the worker scoreboard (approvals/fixes/failures + throughput-relative speed; never score by raw elapsed time), score-based auto-assignment with a persistent round-robin cursor, failed-task requeue with escalating budgets (up to `BUILD_TASK_MAX_FAILURES`=3 attempts, then `failed`), and benching of workers with 2+ attempts and zero usable output. Files go to a virtual FS (Map, downloadable as zip), and additionally to the picked project folder (`lib/client/project-fs.ts`) and/or the local runner. The Architect (plan + review, via `runArchitectInspectionLoop`) and the workers run their tool loops as **real multi-turn conversations** (`streamConversation` keeps a `ChatMessage[]`; each tool call + result is a message) — do NOT go back to accumulating tool results into one re-injected/front-truncated string (that silently dropped the newest reads and made the Architect re-read the same lines until the build failed). Robustness lives in `build.ts`: overlap-aware dedup (`createToolCallTracker`/`isRedundantToolCall` — interval coverage so nudging a line range can't evade it), forced-verdict graceful degradation (`FORCED_*_INSTRUCTION`; a stuck review defaults to approving the wave's landed work instead of throwing away the build), and `compactToolConversation`.
  - Budgets are runaway-loop stops, NOT cost controls — the USD/time budget window (checkpoint/resume; a **fresh** window per resume) is the only cost gate; effort no longer caps the workflow. Per-task worker tool budgets are difficulty-scaled with fix-round escalation (`lib/orchestrator/build-worker-budgets.ts`): tiers by declared difficulty 1-5, +1 tier per failed attempt (capped at 2), a TDD skill floors `runs` at 3. Shared phase pools are sized to never starve a wave and are drawn from by architect AND workers alike (`build.ts` runs 24/phase, 120 total; engine MCP 24/96, fetches 8/24).
  - `split_task`: a worker may **once** end its turn decomposing an oversized task into 2-4 subtasks; `applyTaskSplit` (build.ts) validates fully first (zero mutation on reject) then mutates the task array **IN PLACE**, preserving object identity — concurrent workers hold live task references, so never rewrite it into a clone-based version. Children get `splitDepth: 1` (cannot re-split).
  - Plan critique gate (`pickPlanCritic`): before wave 1 a second model (`reviewer` if distinct, else the best distinct ranked worker) attacks the plan; blocking findings trigger exactly ONE Architect revision. Best-effort — never fails the build; off under `benchmark`.
  - Diff-first review: with a runner on a git repo, the wave review gets the actual scoped `git diff` as a priority-160 context pack (24k char cap; overflow parked as a `ctx_` blob) and is told to treat it as primary evidence.
  - Workers can `fetch` public docs URLs through the runner (per-task tier budget from the shared fetch pool; same `executeFetch` path + approval semantics as the Architect).
  - Screenshot → vision review: MCP results carrying an image (Playwright `browser_take_screenshot`) become per-task acceptance screenshots (`waveScreenshots`), attached to the wave review when the review model supports images (≤4 latest via `slice(-4)`); inert under benchmark / no runner / old runner (no `image` field) / non-vision reviewer.
  - Worker token usage is attributed per worker and folded into global model stats; the Build leaderboard shows tokens-per-approved-task (`tokensPerApproval` in `lib/client/model-stats.ts`; includes failed/fix-round tokens by design).
  - Typed repo/GitHub actions run through the runner `/repo/*` endpoints (`repo_status`/`repo_diff`/`repo_branch_create`/`repo_commit`/`repo_push`/`repo_issue_*`/`repo_milestone_create`/`repo_pr_create`); raw `git commit`/`git add` shell commands are **refused** (NRW-006 → use `repo_commit`, which needs a safe feature branch + approval); PRs default to `draft`; a GitHub-completion gate defers a false "done" when the request asked for a PR.
- `lib/build-context/` — token-tiered context assembly for the Build engine: four tiers by model context window (`tiny` 12k / `standard` 48k / `large` 160k / `huge` 420k, `budgets.ts`), per-role budget splits (architect/worker/reviewer/summary), priority-scored `ContextPack`s (`scoreContextPack`) with a digest fallback when a pack overflows. Long tool results are stored as `ctx_` blobs and retrieved via a paged `context_retrieve` action (`CONTEXT_RETRIEVE_DEFAULT_TOKENS`=4k / `_MAX_TOKENS`=12k). Per-project persistent build memory (user corrections, decisions, failed approaches, fragile files, reliable commands) surfaces as ranked briefs capped per role (default 700; worker 900 / reviewer 1500 / summary 1800 tokens).
- `lib/skills/` — 22-skill registry (`registry.ts`: 4 `aiboard-core` + 11 `agent-skills` + 7 `superpowers`), phase-routed compact overlays (`selectSkills` in `router.ts`; 3-4 skills/phase, `compact` render mode). `evidence.ts` + `lib/orchestrator/build-evidence-gates.ts` are regex evidence gates that **BLOCK review approval** when required evidence is missing/violated (TDD RED/GREEN, browser acceptance, security boundary, systematic debugging). The Architect may `skill_request` (plan + review actions); workers **cannot** self-load skills (`skill_request` is not in `WORKER_NATIVE_ACTIONS`).
- The event contract is the `OrchestratorEvent` type — **defined in `lib/orchestrator/engine.ts`, which is otherwise dead server code; only the type is imported** (by `lib/client/engine.ts`, the discussion page, and `DiscussionDiagnostics`). Changing event shapes touches engine + UI.
- Shared orchestrator modules (live, used by both engines): `config.ts` (EFFORT_CONFIG, mode info, cost estimate), `prompts.ts` (all prompt construction + `DISCUSSION_TRANSCRIPT_MARKER`), `parse.ts` (judge/convergence JSON extraction), `build.ts` (Build task types, Architect action protocol + tolerant parsing, Build prompts).
- `lib/artifacts/extract.ts` parses ```lang path=...``` file blocks and SEARCH/REPLACE edit blocks from model output (any language fence whose body looks like edit ops is treated as edits).
- Conventions: answer length/conciseness is controlled via prompt instructions (verbosity/style), never by `maxTokens` truncation.

### Providers — plugin architecture (browser-side)
Each provider implements `AIProvider` from `lib/providers/base.ts` (`listModels`, `streamChat` async generator, `validateApiKey`). `lib/client/providers.ts` is the **live registry**: it resolves keys/custom models from the client store and routes `providerId` → implementation.

- **`lib/providers/catalog.ts` (`MODEL_CATALOG`) is the single source of truth** for every built-in model: API id, display name, capabilities, validation candidate. Adding/changing a model starts here.
- Model ids are namespaced **`providerId:modelId`**; always use `parseModelId` / `formatModelId` from `base.ts`. Custom (OpenAI-compatible, e.g. Ollama/LM Studio) models are `custom:<id>` resolved from the store.
- OpenAI, OpenRouter, and custom endpoints share `openai-compat.ts`; Anthropic and Google are bespoke (different SDKs).
- `provider-registry.ts` is the provider-level source of truth: provider ids, display names, setup fields, account-runner metadata, runtime behavior, and feature policies such as native web search, reasoning effort, and max-token request support.
- `runtime-behavior.ts` exposes provider-registry runtime metadata shown on the Settings page:
  - **Temperature** is sent to Google, OpenRouter, and custom endpoints; intentionally omitted for OpenAI and Anthropic (newer models reject it). OpenRouter silently drops it for models that don't support it.
  - **Prompt caching**: prompts split at `DISCUSSION_TRANSCRIPT_MARKER` so the stable prefix caches. Anthropic: `cache_control: ephemeral` — Anthropic caps a request at **4** `cache_control` breakpoints, so `anthropic.ts` marks only the first user message + the last message (`anthropicCacheBreakpointIndices`), never one-per-message (that 400s a long multi-turn Build conversation with "Found 5"). OpenAI: `prompt_cache_key` + 24h retention. OpenRouter: automatic for OpenAI/DeepSeek/Grok-style models; one explicit `cache_control` breakpoint on the last user message for `anthropic/`, `google/`, `qwen/` models.
- `capabilities.ts` gates which attachment types each model accepts; engines filter attachments per model.
- `pricing.ts` is a static reference (+ user overrides) for UI cost estimates only.
- New provider checklist: add provider metadata in `provider-registry.ts`, implement `AIProvider`, register it in `lib/client/providers.ts`, add catalog entries (and optionally pricing/context defaults). Account-backed providers are normal provider ids; the account runner is only a transport/setup mode.

### Local runner (optional, Build mode)
`scripts/runner.mjs` — zero-dependency Node 18+ HTTP server the **user** starts (`node runner.mjs <project-folder>`), bound to 127.0.0.1 with a token. Gives the Architect real file read/write/search, shell commands (per-command approval unless "Full access"), and stdio-MCP bridges (`--mcp "name=command"`), plus convenience registrations for Context7 (`--context7`, API key via `--context7-key`/`CONTEXT7_API_KEY`) and SearXNG (`--searxng --searxng-url <url>`). It is copied to `public/runner.mjs` by `predev`/`prebuild` (the copy is gitignored) so the hosted app serves it for download. Client side: `lib/client/runner.ts`.

### App layer
Static pages: dashboard `app/page.tsx`, `app/discussion/page.tsx` (id via `?id=` query param — static export forbids dynamic route segments), `app/settings/page.tsx` (Providers / Pricing / Defaults / Storage / Security tabs), and `app/benchmark/page.tsx` → `components/BenchmarkPage.tsx` (global benchmark surface, collapsed 2026-07-17 to exactly three tabs — do not reintroduce per-track tabs):
  - **Run** — `CertifiedRunPanel` (`components/benchmark/certified/`): a shared `ModelChecklist` (`components/benchmark/run/ModelChecklist.tsx`, selection persisted in localStorage) feeds a `TeamCompositionBuilder` (renders only when the active preset has a team leg) and `PresetCards` (`components/benchmark/run/PresetCards.tsx`) — three preset cards **Model IQ** (GameIQ bundle + Tool Reliability, solo), **Team benchmark** (TeamIQ compositions + solo baselines), **Full certified** (Model IQ + Team benchmark + WorkBench, WorkBench leg skipped with a visible note when no bench runner is connected) — defined declaratively in `lib/benchmark/certified/run-presets.ts` and sequenced by `runPreset()` in `lib/benchmark/certified/run-execution.ts` (one `AbortController` per preset run). Progress renders per-leg/per-model/per-pack in `RunProgressList` (`components/benchmark/run/RunProgressList.tsx`). An **Advanced** `<details>` expander keeps the original single-suite/pack picker flow (`CaseSuitePicker`, per-track dropdowns) unchanged for one-off runs.
  - **Results** — `VerdictStrip` (`components/benchmark/results/VerdictStrip.tsx`: Smartest model / Best team / Most efficient / Best value team cards) above `CertifiedBenchmarkOverview`, which renders the stat grid then `LensTabs` (`components/benchmark/results/LensTabs.tsx`) — a segmented **Solo / Teams / Roles / Live builds** control over one shared "all tracks" leaderboard: Solo filters to single-model rows; Teams shows team rows (roster chips) + `ComboMatrix` + `ParetoFrontier` (now fed by any track via `computeTeamLift` in `lib/benchmark/certified/team-lift.ts`, not just TeamIQ — the TeamIQ formula is unchanged, verbatim-extracted); Roles shows `WorkBenchRoleLeaderboards`; Live builds shows `BuildLeaderboard` with an "uncertified — live Build usage" caption. A collapsed `<details>` Analysis section at the bottom holds the head-to-head table and capability radar.
  - **Data** — `BenchmarkLab` (`components/BenchmarkLab.tsx`): run history counts, JSON/Markdown export/import, and the danger-zone bulk-delete (game match history and Build Lab stats are explicitly kept, not deleted).

Header in `app/layout.tsx`. UI uses Radix primitives + Tailwind under `components/ui/`.

### GameIQ certified benchmark (`lib/benchmark/gameiq/`)
Scenario-based game-decision benchmark; one certified attempt per pack, scored deterministically. Constants live in `gameiq/types.ts`, scoring in `scoring/gameiq.ts`, the runner in `gameiq/runner.ts`, the certified wrapper in `gameiq/certified-runner.ts`.

- **Scoring is v0.3 (`GAMEIQ_SCORING_VERSION = "certified-gameiq-v0.3"`)**: score = outcome 0.6 + moveQuality 0.4. Legality and structured-output are pass/fail GATES via `statusFromScore` (→ `failed_tool_use`), **not** score points (legality/structure weights are 0 — a model must not harvest ~31 free points for emitting valid JSON). Fireworks `actionQuality` is graded, not binary: keyed weight / forbidden 0 / dead-card clue 0.1 / other-legal 0.3; `correct` requires quality ≥ `GAMEIQ_CORRECT_QUALITY_BAR` (0.75) so the neutral floor never counts as correct.
- **Reliability**: transient provider errors retry with backoff (`callCertifiedModel`, classified by `classifyProviderFailure`); an error surviving retries is contained per-scenario as `unscored:"transport"` (excluded from metrics). Scoring proceeds on the scenarios that ran unless zero scored, or the unscored fraction exceeds `GAMEIQ_MAX_UNSCORED_RATE` (0.1) → attempt is `provider_unavailable`. Scenario calls run at **concurrency 4** (`CertifiedRunPanel.tsx`) and persist **incrementally per pack**, so a fatal/budget failure in a later pack keeps the packs that already verified. `statusForRunError` maps fatal provider errors to `provider_unavailable` (not `invalid_harness`). Traces carry `scenarioId` — map by id, not positional order; legacy pre-`scenarioId` run files use the gap/duplicate-aware positional pairing in `trace-replay.ts` (the ONE shared resolver; a divergent second copy is exactly the pairing bug the B4 review caught).
- **Tooling** (scripts): `recover-gameiq-run.mts` rebuilds voided pack scores from recorded traces (dry-run default; `--write` backs up first; idempotent). `replay-gameiq-traces.mts` re-runs traces through the real scorer. Both gracefully SKIP (console note, never throw) any trace `caseId` that no longer resolves to a registered pack — e.g. a historical run file still carrying traces for a hard-deleted v0.1 pack. `audit-gameiq-consensus.mts` is the oracle-narrowness review gate (exits non-zero on convergence flags). `classify-gameiq-consensus.mts` engine-classifies consensus-audit flags into genuine-failure vs miskey-candidate classes — only miskey candidates need human adjudication. `report-gameiq-frontier.mts` scores excluding saturated scenarios; the saturation registry (`gameiq/saturation.ts`) is regenerated by `generate-gameiq-saturation.mts` (`--prior` = evidence-cumulative pruning: fresh runs can only REMOVE saturation). The fireworks pack completeness guard (`test-gameiq-fireworks-pack.mts`) enforces keyed=engine-sound / forbidden=engine-harmful / clue-equivalence completeness. `probe-gameiq-pack.mts` is the headless live pack probe for difficulty gating (reads provider keys from a plaintext store.json, never prints secrets; `--dry-run`/`--self-test` are token-free; emits run-file-shaped JSON the audit/classify/replay tools accept).
- **Conventions**: the default GameIQ bundle is **6 packs** — every registered pack, full stop (`gameiq-v0.2-battleship`, `gameiq-v0.2-chess`, `gameiq-v0.2-connect-four`, and the three fireworks packs). The saturated `gameiq-v0.1-battleship`/`-chess`/`-connect-four` packs were HARD-DELETED 2026-07-17; **codenames was dropped from the benchmark entirely 2026-07-20** — its hand-judged v0.1 keys violated the exact-key standard, and the CSP-deduction v2 replacement (archived unmerged on branch `gameiq-codenames-deduction`) proved frontier-saturated across two live-gated difficulty iterations (GPT-5.5: 12/12 then 11/12) — bounded formal deduction cannot challenge frontier models, so running it wastes benchmark tokens. Do not re-add a codenames pack without a difficulty mechanism that beats careful enumeration. The playable game (`lib/games/codenames/`) is unaffected. The saturation registry (`gameiq/saturation.ts`) holds 16 fireworks-only ids. Historical run files with traces for any deleted pack skip them gracefully on replay/recovery instead of crashing.
- Chess v2 keys are GENERATED/proven by `chess-prover.ts` (bounded AND/OR mate search) — never hand-author chess keys.
- Connect Four v2 keys are GENERATED by `connect-four-solver.ts` (optimal-play column classification) — never hand-author Connect Four keys.
- Battleship keys are GENERATED from `battleship-oracle.ts` (placement enumeration; multiset sizes) and graded by true ratio (`gradeBattleshipAction`) — never hand-author Battleship keys/weights. `maxResponseMs` was removed (dead, never enforced); the model-call completion cap is **16384** tokens (`DEFAULT_GAMEIQ_MAX_TOKENS`) for reasoning-token headroom, never as a length control.

### Legacy server-era modules — do not extend
These compile but are **dead** (nothing live imports them; they exist from before the browser migration): `lib/db/index.ts` (fs JSON store), `lib/providers/index.ts` + `lib/providers/custom.ts` (superseded by `lib/client/providers.ts`), `lib/crypto/keys.ts` (Node AES with `ENCRYPTION_SECRET`), `lib/attachments/storage.ts` (fs attachment files), `lib/orchestrator/events.ts` (EventEmitter/SSE bridge), and everything in `lib/orchestrator/engine.ts` except the `OrchestratorEvent` type. If you touch one of these, you're probably in the wrong file — look for the `lib/client/` counterpart.
