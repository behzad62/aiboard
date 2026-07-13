# AI Board

[AI Board](https://aiboard.me) is a local-first multi-model discussion app with a native coding-agent Build mode. Discussion modes run in the browser; Build mode runs through Runner V2, a durable local agent kernel.

## Features

- Multi-model panels, debates, specialist review, and synthesized answers.
- Browser-side IndexedDB or user-picked-folder storage with optional encryption.
- Runtime provider configuration for hosted and OpenAI-compatible models.
- Native Build orchestration with an Architect, parallel workers, isolated Git worktrees, task commits, tools, skills, project memory, evidence, budgets, and provider failover.
- Durable checkpoints that survive browser and runner restarts.
- Guarded and Full access profiles.
- Explicit user-controlled final project handoff.

## Privacy model

The static web app has no backend or account system. Discussion data and provider settings stay in browser storage or the local storage folder you choose. Provider requests go directly to the configured provider.

Runner V2 runs on your machine, binds to `127.0.0.1`, and requires a control token. It is mandatory only for Build mode. Provider configuration stored by the runner is encrypted using that token.

## Requirements

- Node.js 24.18.0 or newer.
- Git on `PATH` for Build mode. Runner V2 stops before any model call if Git is unavailable.
- Provider credentials only for the models you choose.

## Local development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), then configure providers in Settings.

## Runner V2

Build mode has no browser execution fallback. Start the native kernel with its state directory outside the project:

```bash
npm run runner:v2 -- --project C:\path\to\project --state-dir C:\path\to\aiboard-state --port 8787
```

Runner V2 prints a local URL and a new control token. Paste both into Build setup. The runner owns the Git baseline, isolated task workspaces, task-level commits, durable agent sessions, native tools, evidence, integration, and recovery.

Guarded access requires approval for destructive or external effects. Full access allows configured agents to perform destructive operations, writes outside the project, credential changes, pushes/PRs, deployments, and other external actions without per-action approval. Final project handoff always pauses for the user in both profiles.

If the project is not a Git repository, Runner V2 creates a safe local repository and baseline without requiring a global Git identity. When the Architect finishes, choose either:

- Keep the run-owned integration branch.
- Apply its binary diff to the original project after a successful `git apply --check` dry run.

A conflict leaves the original project unchanged and keeps the handoff decision open.

## Production build

```bash
npm run build
```

The app exports to `out/` for static hosting. The build publishes account-provider and benchmark transports; it does not ship a browser Build runner.

## Checks

```bash
npm run test:runner-v2
npm run lint
npm run build
```

Additional focused tests live under `runner-v2/test/` and `scripts/test-*`.

## Security

Do not put real provider keys, runner tokens, SSH keys, or private files in issues, pull requests, screenshots, or logs. See [SECURITY.md](SECURITY.md).
