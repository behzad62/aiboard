# AGENTS.md

Guidance for coding agents working in this repository.

## Commands

```bash
npm run dev
npm run build
npm run lint
npm run runner:v2 -- --project C:\project --state-dir C:\runner-state --port 8787
npm run test:runner-v2

npx tsx scripts/test-parse-action.mts
npx tsx scripts/test-edits.mts
npx tsx scripts/test-extract.ts
npx tsx scripts/test-project-fs.ts
```

Development is on Windows/PowerShell. Running `npm run build` while the dev server is active can corrupt `.next`; restart the dev server afterward.

## Architecture

AI Board is a static-export Next.js app (App Router, React 19, strict TypeScript, no API routes). Discussion modes run in the browser. Build mode requires the separate native Runner V2 process. Import alias: `@/*` points to the repository root.

### Browser store

`lib/client/store.ts` keeps one in-memory store and persists through `lib/client/storage-adapter.ts` to IndexedDB or a user-picked folder. Optional encryption uses `lib/client/crypto-box.ts`. Shared schema types are in `lib/db/schema.ts`; several array-shaped fields are stored as JSON strings.

### Engines

- `lib/client/engine.ts` runs panel, debate, and specialist discussions.
- `lib/client/native-build-engine.ts` is the only live Build adapter. It provisions and observes Runner V2 and maps durable events into the UI.
- `runner-v2/src/` owns Build scheduling, Architect and worker loops, native tools, isolated Git worktrees, task commits, evidence, skills, project memory, budgets, provider routing, integration, recovery, and explicit handoff.
- `lib/client/legacy-build-engine.benchmark.ts` exists only for certified WorkBench benchmark compatibility. Product Build mode must never import it.
- `lib/orchestrator/engine.ts` is otherwise legacy server code, but its `OrchestratorEvent` type remains live.

Runner V2 requires exactly Node.js 24.18.0 and Git. Git absence stops before model calls. Verifiers record mechanical facts and never decide completeness. The Architect is semantic authority. Final project handoff always pauses for a user choice, including under Full access.

### Providers

Browser discussion providers implement `AIProvider` from `lib/providers/base.ts`. `lib/client/providers.ts` is the live browser registry. `lib/providers/catalog.ts` is the built-in model source of truth and `lib/providers/provider-registry.ts` owns provider metadata and runtime policies.

Runner V2 provider configuration and transports live under `runner-v2/src/`. Account-backed models use the account-provider transport; the browser sends configuration to the localhost runner, which encrypts it in runner state.

### Runner V2

`runner-v2/src/cli.ts` starts the authenticated localhost control plane. Runner state must be outside the project. It captures a safe Git baseline, creates isolated task worktrees, persists every lifecycle transition, and recovers after browser or runner restarts.

`scripts/runner.mjs` and `lib/client/runner.ts` are legacy benchmark-era code. They are not packaged or used by product Build mode and must not be reintroduced into that path.

### App layer

Primary pages are the dashboard, discussion, settings, benchmark, and runner guide. The discussion route uses `?id=` because static export forbids dynamic route segments. UI primitives are under `components/ui/`.

### Legacy server-era modules

Do not extend `lib/db/index.ts`, `lib/providers/index.ts`, `lib/providers/custom.ts`, `lib/crypto/keys.ts`, `lib/attachments/storage.ts`, or `lib/orchestrator/events.ts`. Use their live browser or Runner V2 counterparts.
