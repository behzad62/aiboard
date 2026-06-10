# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Next.js dev server with Turbopack (http://localhost:3000)
npm run build    # production build
npm start        # serve production build
npm run lint     # ESLint (eslint.config.mjs, flat config, next/core-web-vitals)
```

There is **no test framework** configured — no `test` script, no test runner, no test files. Don't look for one; verify changes via `npm run lint`, `npm run build`, and running the dev server.

Environment: copy `.env.example` to `.env.local` and set `ENCRYPTION_SECRET` (without it, `lib/crypto/keys.ts` falls back to a hardcoded insecure dev secret). Provider API keys are entered at runtime via the Settings page, not env vars.

Platform note: development happens on Windows / PowerShell.

## Architecture

A local-first Next.js 15 (App Router, React 19, TS strict) app where several AI models discuss a topic across rounds and a judge model synthesizes a final answer. Import alias `@/*` → repo root.

The flow is: **API route creates a `Discussion` → SSE route starts the orchestrator → engine streams model output round-by-round → events flow back over SSE to the browser.**

### Data store — one JSON file, no database
`lib/db/index.ts` is the entire persistence layer: `data/store.json` is read and rewritten **in full on every mutation** (`mutate()` → `readStore()` → `writeStore()`). `data/` is created at runtime. `getDb()` returns write methods; top-level exports (`listDiscussions`, `getMessagesForDiscussion`, etc.) are reads. Consequences to keep in mind:
- No concurrency control or transactions — concurrent writers will clobber each other. This is intentionally a single-user local app.
- The schema (`lib/db/schema.ts`) is SQL-shaped, so **relational/array fields are stored as JSON strings inside the JSON store**: `Discussion.modelIds`, `Discussion.attachmentIds`, and `FinalResult.dissent` must be `JSON.parse`d after reading and `JSON.stringify`d before writing.
- Attachments live in two places: a record in `store.json` *and* the raw file under `data/attachments/<id>/` (see `lib/attachments/storage.ts`).

### Providers — plugin architecture
Each provider implements the `AIProvider` interface in `lib/providers/base.ts` (`listModels`, `streamChat` as an async generator of `StreamChunk`, `validateApiKey`) and is registered in the `providers` map in `lib/providers/index.ts`.

- **`lib/providers/catalog.ts` (`MODEL_CATALOG`) is the single source of truth** for every model: API id, display name, capabilities, and which model is the cheap `validationCandidate`. Provider `listModels()` implementations all read from it. Adding/changing a model starts here.
- Model ids are namespaced **`providerId:modelId`** (e.g. `anthropic:claude-opus-4-8`). Always split/join with `parseModelId` / `formatModelId` from `base.ts`, never manual string ops.
- OpenAI and OpenRouter share the OpenAI-compatible path in `openai-compat.ts` (OpenRouter only differs by `baseURL` + headers). Anthropic and Google have bespoke implementations because their SDKs differ.
- `capabilities.ts` (derived from the catalog) gates which attachment types each model accepts; the engine filters attachments per-model before sending.
- `runtime-behavior.ts` documents a deliberate quirk: **temperature is only sent to Google.** It is intentionally omitted for Anthropic and OpenAI because their newer models reject/ignore the parameter — so the `temperature` passed into the engine effectively only affects Gemini.
- Prompt caching: both Anthropic and OpenAI split the prompt at `DISCUSSION_TRANSCRIPT_MARKER` (defined in `orchestrator/prompts.ts`, imported by providers) so the stable prefix is cached and the growing transcript is not. Anthropic uses `cache_control: ephemeral`; OpenAI uses `prompt_cache_key` + 24h retention.
- `pricing.ts` is a static reference table (+ user overrides from settings) used only for cost estimation in the UI; it is not wired into billing.
- New provider checklist: implement `AIProvider`, register in `index.ts`, add its id to `PROVIDER_IDS` in `constants.ts`, add catalog entries (and optionally pricing).

### Orchestrator — the discussion engine
`lib/orchestrator/engine.ts` `runDiscussion(id, emit)` is the core loop and the most important file to read:
- An in-memory `runningDiscussions` Set dedupes concurrent runs (this is why a server restart loses "running" state).
- Each round, **all participating models stream in parallel** (`Promise.all`). The three modes (`panel` / `debate` / `specialist`) change which models speak and their system prompt — `specialist` has a lead drafter + reviewers, so its per-round participant set is conditional.
- Early stopping has two mechanisms: **stagnation detection** (`wordOverlapSimilarity` > 0.92 between consecutive rounds) and **convergence voting** (each model returns a 1–10 completeness score as JSON; the average is compared to the effort's threshold). Both are tuned via `EFFORT_CONFIG`.
- A **judge model** (`discussion.judgeModelId`, defaulting to the first model) then produces the final answer. The judge and convergence votes must return JSON — `parseJsonResponse` extracts the first `{...}` block and falls back to raw text on parse failure.
- `config.ts` holds `EFFORT_CONFIG` (low/medium/high → rounds, maxTokens, thresholds, whether to skip the convergence vote) plus mode descriptions and the cost-estimate math.
- `prompts.ts` centralizes all prompt construction.

### Streaming (SSE) bridge
The engine never talks to HTTP directly — it `emit`s `OrchestratorEvent`s. `orchestrator/events.ts` is an in-process pub/sub (a Node `EventEmitter` per `discussionId`). `GET /api/discussions/[id]/stream` subscribes and forwards each event as an SSE `data:` line, and **also kick-starts `runDiscussion` if the discussion is still `pending`**. Event types (`message_start` / `message_token` / `message_complete`, `diagnostic`, `convergence`, `final_answer`, `status`, `error`, `complete`) are the contract between engine and UI — changing them touches both sides.

### Crypto
`lib/crypto/keys.ts`: AES-256-GCM, key = SHA-256 of `ENCRYPTION_SECRET`. Provider keys are stored encrypted in `store.json` and never sent back to the browser — only a masked `keyHint`.

### App layer
App Router pages: dashboard `app/page.tsx`, `app/settings/page.tsx`, `app/discussion/[id]/page.tsx`. API routes under `app/api/` (discussions, keys, providers/validate, attachments). Routes that read the store use `export const dynamic = "force-dynamic"`. UI uses Radix primitives + Tailwind under `components/ui/`. Input is validated with Zod at the route boundary.
