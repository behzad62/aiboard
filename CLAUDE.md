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
- `lib/client/build-engine.ts` — Build mode: the Architect (judge model) plans tasks → workers implement them in parallel waves → Architect reviews/fixes/adds tasks → hand-off summary. Includes the worker scoreboard (approvals/fixes/failures + throughput-relative speed; never score by raw elapsed time), score-based auto-assignment with a persistent round-robin cursor, failed-task requeue (one retry), and benching of workers with 2+ attempts and zero usable output. Files go to a virtual FS (Map, downloadable as zip), and additionally to the picked project folder (`lib/client/project-fs.ts`) and/or the local runner. The Architect (plan + review, via `runArchitectInspectionLoop`) and the workers run their tool loops as **real multi-turn conversations** (`streamConversation` keeps a `ChatMessage[]`; each tool call + result is a message) — do NOT go back to accumulating tool results into one re-injected/front-truncated string (that silently dropped the newest reads and made the Architect re-read the same lines until the build failed). Robustness lives in `build.ts`: overlap-aware dedup (`createToolCallTracker`/`isRedundantToolCall` — interval coverage so nudging a line range can't evade it), forced-verdict graceful degradation (`FORCED_*_INSTRUCTION`; a stuck review defaults to approving the wave's landed work instead of throwing away the build), and `compactToolConversation`.
- The event contract is the `OrchestratorEvent` type — **defined in `lib/orchestrator/engine.ts`, which is otherwise dead server code; only the type is imported** (by `lib/client/engine.ts`, the discussion page, and `DiscussionDiagnostics`). Changing event shapes touches engine + UI.
- Shared orchestrator modules (live, used by both engines): `config.ts` (EFFORT_CONFIG, mode info, cost estimate), `prompts.ts` (all prompt construction + `DISCUSSION_TRANSCRIPT_MARKER`), `parse.ts` (judge/convergence JSON extraction), `build.ts` (Build task types, Architect action protocol + tolerant parsing, Build prompts).
- `lib/artifacts/extract.ts` parses ```lang path=...``` file blocks and SEARCH/REPLACE edit blocks from model output (any language fence whose body looks like edit ops is treated as edits).
- Conventions: answer length/conciseness is controlled via prompt instructions (verbosity/style), never by `maxTokens` truncation.

### Providers — plugin architecture (browser-side)
Each provider implements `AIProvider` from `lib/providers/base.ts` (`listModels`, `streamChat` async generator, `validateApiKey`). `lib/client/providers.ts` is the **live registry**: it resolves keys/custom models from the client store and routes `providerId` → implementation.

- **`lib/providers/catalog.ts` (`MODEL_CATALOG`) is the single source of truth** for every built-in model: API id, display name, capabilities, validation candidate. Adding/changing a model starts here.
- Model ids are namespaced **`providerId:modelId`**; always use `parseModelId` / `formatModelId` from `base.ts`. Custom (OpenAI-compatible, e.g. Ollama/LM Studio) models are `custom:<id>` resolved from the store.
- OpenAI, OpenRouter, and custom endpoints share `openai-compat.ts`; Anthropic and Google are bespoke (different SDKs).
- `runtime-behavior.ts` documents deliberate quirks shown on the Settings page — keep it in sync with the code:
  - **Temperature** is sent to Google, OpenRouter, and custom endpoints; intentionally omitted for OpenAI and Anthropic (newer models reject it). OpenRouter silently drops it for models that don't support it.
  - **Prompt caching**: prompts split at `DISCUSSION_TRANSCRIPT_MARKER` so the stable prefix caches. Anthropic: `cache_control: ephemeral` — Anthropic caps a request at **4** `cache_control` breakpoints, so `anthropic.ts` marks only the first user message + the last message (`anthropicCacheBreakpointIndices`), never one-per-message (that 400s a long multi-turn Build conversation with "Found 5"). OpenAI: `prompt_cache_key` + 24h retention. OpenRouter: automatic for OpenAI/DeepSeek/Grok-style models; one explicit `cache_control` breakpoint on the last user message for `anthropic/`, `google/`, `qwen/` models.
- `capabilities.ts` gates which attachment types each model accepts; engines filter attachments per model.
- `pricing.ts` is a static reference (+ user overrides) for UI cost estimates only.
- New provider checklist: implement `AIProvider`, register it in `lib/client/providers.ts`, add its id to `PROVIDER_IDS` in `constants.ts`, add catalog entries (and optionally pricing + runtime-behavior copy).

### Local runner (optional, Build mode)
`scripts/runner.mjs` — zero-dependency Node 18+ HTTP server the **user** starts (`node runner.mjs <project-folder>`), bound to 127.0.0.1 with a token. Gives the Architect real file read/write/search, shell commands (per-command approval unless "Full access"), and stdio-MCP bridges (`--mcp "name=command"`), plus convenience registrations for Context7 (`--context7`, API key via `--context7-key`/`CONTEXT7_API_KEY`) and SearXNG (`--searxng --searxng-url <url>`). It is copied to `public/runner.mjs` by `predev`/`prebuild` (the copy is gitignored) so the hosted app serves it for download. Client side: `lib/client/runner.ts`.

### App layer
Static pages: dashboard `app/page.tsx`, `app/discussion/page.tsx` (id via `?id=` query param — static export forbids dynamic route segments), `app/settings/page.tsx` (Providers / Pricing / Defaults / Storage / Security tabs), and `app/benchmark/page.tsx` (global Build-mode model leaderboard — detailed/sortable view backed by `lib/client/model-stats.ts` over `getModelStats()`). Header in `app/layout.tsx`. UI uses Radix primitives + Tailwind under `components/ui/`.

### Legacy server-era modules — do not extend
These compile but are **dead** (nothing live imports them; they exist from before the browser migration): `lib/db/index.ts` (fs JSON store), `lib/providers/index.ts` + `lib/providers/custom.ts` (superseded by `lib/client/providers.ts`), `lib/crypto/keys.ts` (Node AES with `ENCRYPTION_SECRET`), `lib/attachments/storage.ts` (fs attachment files), `lib/orchestrator/events.ts` (EventEmitter/SSE bridge), and everything in `lib/orchestrator/engine.ts` except the `OrchestratorEvent` type. If you touch one of these, you're probably in the wrong file — look for the `lib/client/` counterpart.
