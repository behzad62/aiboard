# AGENTS.md

Guidance for coding agents working in this repository.

## Commands

```bash
npm run dev
npm run build
npm run lint
npm run runner:v2 -- --project C:\project --state-dir C:\runner-state --port 8787
npm run typecheck:runner-v2
npx tsx --test --test-concurrency=1 runner-v2/test/<file>.test.ts

npx tsx scripts/test-parse-action.mts
npx tsx scripts/test-edits.mts
npx tsx scripts/test-extract.ts
npx tsx scripts/test-project-fs.ts
```

For a Runner V2 change, run the affected test files and `npm run typecheck:runner-v2`. `npm run test:runner-v2` is the full suite and takes hours: CI or the owner runs it, never as a routine check.

Development is on Windows/PowerShell. Running `npm run build` while the dev server is active can corrupt `.next`; restart the dev server afterward.

## Runner V2 standing rules

Task 12 / P6 acceptance is closed: T8 and Gate G were accepted on 2026-10-15. `docs/runner-v2/task-12-status.md`, `docs/runner-v2/task-12-bounded-gates.md` and `docs/runner-v2/t8-handoff.md` are history; do not resume them or follow their gate order. Their standing rules still apply to every Runner V2 change: never inflate timeouts to get green CI, never weaken fail-closed process ownership or fencing semantics, keep the affected portable coverage, verify with targeted tests plus `npm run typecheck:runner-v2`, and leave the full suite to CI or the owner. A change to process ownership or fencing also gets an independent review.

## Architecture

AI Board is a static-export Next.js app (App Router, React 19, strict TypeScript, no API routes) that works with the local AIBoard Runner (Runner V2). Discussion engines run in the browser, Build mode runs in the Runner, and every model call goes through the Runner: keyed providers and custom models through its model proxy, which adds the key from the AIBoard home, and ChatGPT and Copilot through the launcher's account peer. Import alias: `@/*` points to the repository root.

### Browser store

`lib/client/store.ts` keeps one in-memory store and persists through `lib/client/storage-adapter.ts` to IndexedDB or a user-picked folder. Settings and keys are not part of it: they live in the AIBoard home (`~/.aiboard`, or `AIBOARD_HOME`), which `lib/client/home-client.ts` reads and writes through the Runner's `/v2/home` routes; the store shows a mirror of the home that is never persisted. There is no passphrase encryption; a store encrypted by an older version opens once with its passphrase (`lib/client/crypto-box.ts`) and is written only after the user saves it without encryption or declines. Shared schema types are in `lib/db/schema.ts`; several array-shaped fields are stored as JSON strings.

### Engines

- `lib/client/engine.ts` runs panel, debate, and specialist discussions.
- `lib/client/native-build-engine.ts` is the only live Build adapter. It provisions and observes Runner V2 and maps durable events into the UI.
- `runner-v2/src/` owns Build scheduling, Architect and worker loops, native tools, isolated Git worktrees, task commits, evidence, skills, project memory, budgets, provider routing, integration, recovery, and project handoff.
- `lib/client/legacy-build-engine.benchmark.ts` exists only for certified WorkBench benchmark compatibility. Product Build mode must never import it.
- `lib/orchestrator/engine.ts` is otherwise legacy server code, but its `OrchestratorEvent` type remains live.

Runner V2 requires the certified Node.js 24.x LTS release line and Git. Git absence stops before model calls. Verifiers record mechanical facts and never decide completeness. The Architect is semantic authority. A Build's final project handoff pauses for a user choice unless the run's policy is `finish` or `budgeted`, a project handoff was requested, and no known defects are recorded; a failed automatic apply pauses for the user.

Final checks follow `docs/plans/2026-11-13-build-verification.md`: the Runner suggests checks, runs them and records the results, and never decides. The Architect keeps, changes or adds checks and may skip a suggested one with a reason. Only `aiboard-validation.json` (version 2 `checks`) marks a check `mandatory`, and the Architect can never skip or change one. Declared checks are the whole suggestion list; detection is the fallback for a project that declares none. A check whose tool is missing is `not_run: tool_missing`, never a failure or a repair. A Build stops for its checks only when a mandatory check's tool is missing (one pause before planning), when `aiboard-validation.json` is malformed or unreadable (fix it and start a new Build), or when a mandatory check fails at its repair limit. A non-mandatory failure at the limit becomes a known defect. The handoff's Not verified section lists not-run checks, skips, known defects, overrides without Runner evidence and the Architect's `leftToVerify`. This repository's own checks are in `aiboard-validation.json`.

Builds browse through the Playwright CLI bundled with the Runner: workers, the Architect and the verifiers run `playwright-cli`, with one browser session per agent session, stopped with it. New runs have no `browser.*` tools. A browser is downloaded only on the owner's action (`aiboard browser install` or Settings > Tools), never by a Build.

### Providers

Browser discussion providers implement `AIProvider` from `lib/providers/base.ts`. `lib/client/providers.ts` is the live browser registry. `lib/providers/catalog.ts` is the built-in model source of truth and `lib/providers/provider-registry.ts` owns provider metadata and runtime policies.

Runner V2 provider configuration and transports live under `runner-v2/src/`. Keys and provider settings come from the AIBoard home (`runner-v2/src/aiboard-home-store.ts`): `config.json` without secrets, and `credentials.json` encrypted with a home key kept in the user data root. The web edits the home through the Runner's `/v2/home` routes, and the `aiboard config`, `aiboard keys` and `aiboard models` commands edit it from a terminal (`runner-v2/src/home-cli.ts`). The browser pushes secretless provider configs to the Runner, which resolves the key from the home. Account-backed models use the account-provider transport and never have a key in the home. Runner code never imports from `lib/`: the model knowledge it needs is a generated snapshot (`runner-v2/src/generated/model-catalog.ts`) under `scripts/test-runner-model-catalog-parity.mts`.

### Runner V2

`runner-v2/src/cli.ts` starts the authenticated localhost control plane. Runner state must be outside the project. It captures a safe Git baseline, creates isolated task worktrees, persists every lifecycle transition, and recovers after browser or runner restarts.

#### Filesystem write ownership (keep the audit list current)

`runner-v2/test/filesystem-mutation-routing.test.ts` is a closed audit list of every `runner-v2/src/` module allowed to import a mutation-capable `node:fs` / `node:fs/promises` API (`writeFile`, `rename`, `rm`, `unlink`, `mkdir`, `open`, `link`, `chmod`, …). It is a review tripwire, not a sandbox, and it fails on every OS when a module is missing.

- When you add or change a Runner V2 module so that it imports one of those APIs, update the list **in the same change**. Use `privateOwners` for Runner-private targets (state dir, SQLite, artifacts, install/extension home, run-owned worktrees) and `readHandleOwners` for read-only `open`/`openSync` imports. Give every entry a trailing comment saying what it writes and where.
- Never add a module whose targets can be model-chosen or inside the user's project. Native model-selected writes go through `filesystem-mutation-fence.ts`. Runner code that must touch project paths (such as cleanup of its own residue) confines them canonically: `realpath` the parent and check it is inside the real checkout, because a symlink or junction makes a lexical `relative()` check pass for an outside file.
- Never bulk-allowlist to turn the test green. Read each call site, and record the review (module, APIs, targets, evidence) in `docs/runner-v2/filesystem-owner-review-*.md`.
- Known, deliberate exceptions to project confinement, which this list does not govern: provider-native tools run by the provider bypass the fence, and Remote agents connected through the relay may act outside the project unless the user limits them to a folder. Do not widen either one implicitly.

`scripts/runner.mjs` and `lib/client/runner.ts` are legacy benchmark-era code. They are not packaged or used by product Build mode and must not be reintroduced into that path.

### App layer

Primary pages are the dashboard, discussion, settings, benchmark, and runner guide. The discussion route uses `?id=` because static export forbids dynamic route segments. UI primitives are under `components/ui/`.

### Legacy server-era modules

Do not extend `lib/db/index.ts`, `lib/providers/index.ts`, `lib/providers/custom.ts`, `lib/crypto/keys.ts`, `lib/attachments/storage.ts`, or `lib/orchestrator/events.ts`. Use their live browser or Runner V2 counterparts.
