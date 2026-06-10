# Build Mode & Discussion-Quality Improvements — Design

Date: 2026-06-10
Status: Approved (proceeding to implementation)

## Goal

One combined effort covering: discussion correctness fixes, a prompt-driven
conciseness/detail control, a new collaborative **Build** mode that produces
downloadable project files, a tabbed Settings page, and main-page polish.

## Guiding constraints (from the user)

1. **Conciseness is prompt-driven, never truncation.** Token ceilings stay
   generous so answers always complete; "how concise" is an instruction the
   models comply with.
2. **File output is client-side.** Files are parsed from model output in the
   browser and downloaded (per-file or as a `.zip`). No server filesystem writes.
3. **Deferred:** a later effort turns the whole app browser-side (WASM,
   BYO-key, minimal server). This plan keeps the current server engine and only
   makes the *new* file feature client-side. Do NOT migrate storage/orchestration
   here.

## 1 · Correctness fixes

- **Generous token ceilings.** `EFFORT_CONFIG` round budgets and judge budgets
  raised so nothing truncates. Verbosity never lowers these.
- **Gemini short-answer fix.** Gemini 2.5/3.x Flash spend hidden "thinking"
  tokens against `maxOutputTokens`; the 800-token cap starved the visible
  answer. Fix: large `maxOutputTokens` + a `thinkingConfig` budget in
  `lib/providers/google.ts` (cast if the pinned SDK lacks the type). Intent:
  Gemini answers complete fully.
- **Specialist role bug.** `buildRoundSystemPrompt` never receives the *current*
  model's index, and `isLead = leadIndex !== undefined` is always true, so every
  model (including reviewers) is told "you are the lead." Pass the current
  model's role so reviewers get the reviewer prompt.
- **Real within-round discussion.** Today a round runs all models in parallel
  against a transcript frozen before the round — they answer blind to each other.
  Change the round loop to run **sequentially within a round**, appending each
  completed contribution to a working transcript so later speakers see earlier
  ones. Models stream one-at-a-time (accepted trade-off).
- **Judge output format.** Stop forcing a giant escaped-JSON envelope (the cause
  of truncation). The judge writes **clean markdown** followed by a small,
  parseable metadata footer:

  ```
  <full markdown answer>

  ---
  <!--meta
  confidence: 8
  dissent:
  - point one
  - point two
  -->
  ```

  `extractJudgeResult` evolves to parse this footer, still falling back to the
  legacy JSON envelope and to raw text.

## 2 · Conciseness / detail control

- **Data:** `verbosity: "brief" | "balanced" | "comprehensive" | "exhaustive"`
  and `styleNote: string` added to `UserSettings` (defaults) and `Discussion`
  (per-run).
- **Prompt:** `buildVerbosityInstruction(verbosity, styleNote)` injected into
  every system prompt (rounds, judge, build). Mapping:
  - brief — shortest text that fully answers; lead with the answer; tight
    bullets; no preamble.
  - balanced — clear and reasonably thorough, no padding. (default)
  - comprehensive — cover reasoning, alternatives, caveats, examples.
  - exhaustive — rigorous: edge cases, trade-offs, deep justification.
  - `styleNote` appended verbatim as extra guidance.
  - In Build mode, verbosity governs prose (plans/notes); **code is always
    complete**.
- **UI:** `DetailControl` component (segmented presets + optional textarea) on
  the main page (per-run) and Settings → Defaults (global default).

## 3 · Build mode (collaborate to build a project + files)

- New `DiscussionMode = "build"`.
- **Round flow:** architecture/plan → implement & critique → integrator.
  The judge role becomes the **integrator**: assembles the consolidated,
  coherent fileset and a short build summary (how to run, decisions, TODOs).
- **File convention (models → files).** Each file is a fenced block whose info
  string carries the path:

  ````
  ```ts path=src/index.ts
  ...content...
  ```
  ````

  Tolerant parser also accepts `title="..."`/`file=...` attrs, a preceding
  `**File: `path`**` / heading line, or a first-line `// path:`/`# file:`
  comment. Paths normalized (strip `./`, backslashes → `/`). Dedup by path,
  **last occurrence in document order wins** (integrator output appended last).
  Fences with no resolvable path render as ordinary code, not files.
- **Client-side extraction.** `lib/artifacts/extract.ts` parses assistant text
  into `{ path, language, content }[]`. Pure, unit-testable, browser-safe.
- **Artifact panel UI.** File list/tree, per-file **Download**, **Download all
  (.zip)** via `jszip` (client-side). Extraction runs on any mode's output, but
  Build is the mode prompted to produce a coherent project.
- **Result rendering.** Build shows a **Project summary** (markdown) + the
  artifact panel instead of the prose "Verdict."

## 4 · Settings → tabs

- Add `components/ui/tabs.tsx` (Radix `@radix-ui/react-tabs`, already a dep).
- Tabs: **Providers** (keys/enable/test/default model + runtime behavior) ·
  **Pricing** (pricing moved here, all models in one place) · **Defaults**
  (mode/effort/judge + verbosity/styleNote) · **Security**.

## 5 · Main-page polish

- Add `DetailControl`; surface the 4th (Build) mode card; tighten the
  readiness/model-selection layout; align headings with the editorial type from
  the discussion page. Focused improvements, not a teardown.

## 6 · Data model

- `UserSettings` += `verbosity`, `styleNote`.
- `Discussion` += `verbosity`, `styleNote`; `mode` union gains `"build"`.
- No new server file storage (files are client-only).

## New dependencies

- `jszip` — client-side zip of generated files.

## Implementation phases

A. Data model + config + prompt engine (verbosity, ceilings, Gemini, specialist,
   sequential rounds, judge footer, build prompts/roles).
B. Client artifact extraction (`lib/artifacts/extract.ts`) + tests.
C. Build mode end-to-end (schema, create flow, engine, validation).
D. Artifact panel + JSZip + Build result rendering.
E. `DetailControl` + main-page integration + settings default.
F. Settings tabs refactor (`ui/tabs.tsx`, Providers/Pricing/Defaults/Security).
G. Main-page polish.

Verify with `tsc`, lint, and the browser after each major phase.

## Deferred (separate spec later)

Browser-side/WASM migration: move key storage + orchestration into the browser,
replace shared `data/store.json` with per-browser storage, multi-user isolation.

## Risks

- `@google/generative-ai@0.21.0` may not type `thinkingConfig` → cast or rely on
  a large `maxOutputTokens`.
- Sequential-within-round increases wall-clock and changes streaming UX (one
  model at a time) — accepted.
- Model adherence to the file-fence convention varies → parser must be tolerant
  and the artifact panel must show what was detected (no silent drops).
