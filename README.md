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

## License and contributions

AI Board is **source-available** under the [AIBoard Community Source License v1.0](LICENSE).
Copyright (C) 2026 Behzad Shams. You may study the code, run it locally,
and fork it on GitHub to propose changes to the official project.
**Independent releases, redistribution, and public hosting of modified copies
require written permission** from the author. This is not an OSI-approved
open-source license.

Contributions to the official repository are welcome; read
[CONTRIBUTING.md](CONTRIBUTING.md) and the
[Contributor License Agreement](CONTRIBUTOR_LICENSE_AGREEMENT.md).
The name and logo are subject to the [trademark policy](TRADEMARKS.md).
Earlier copies obtained under AGPL-3.0-only retain those earlier license
rights; this license change does not revoke them.

## Privacy model

The static web app has no backend or account system. Discussion data and provider settings stay in browser storage or the local storage folder you choose. Provider requests go directly to the configured provider.

Runner V2 runs on your machine, binds to `127.0.0.1`, and requires a control token. It is mandatory only for Build mode. Provider configuration stored by the runner is encrypted using that token.

## Requirements

- Git on `PATH` for Build mode. Without Git the Runner still starts, with Chat and account providers only.
- Provider credentials only for the models you choose.
- Node.js 24.x only for local development; the installed Runner includes its own Node.js.

## Local development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), then configure providers in Settings.

## Runner V2

Build mode has no browser execution fallback. Install the Runner once (per user, no admin rights; the release is signed and verified before anything runs):

```powershell
irm https://aiboard.me/install.ps1 | iex          # Windows (PowerShell)
```

```bash
curl -fsSL https://aiboard.me/install.sh | sh     # macOS / Linux
```

Then open a new terminal in your project folder and run `aiboard`. It opens AI Board in the browser already connected, and also starts the account runner for ChatGPT, GitHub Copilot and NVIDIA. `aiboard remote` lets ChatGPT or Claude use this computer, `aiboard update` installs the newest signed release, and `aiboard --help` lists every option.

From a repository checkout, contributors can run the source copy instead: `npm run runner:v2 -- --project C:\path\to\project --state-dir C:\path\to\aiboard-state --port 8787` prints a local URL and a new control token to paste into Build setup (`--allow-origin https://aiboard.me` permits a hosted UI; `npm run runner:v2 -- --help` lists the arguments).

The Runner owns the Git baseline, isolated task workspaces, task-level commits, durable agent sessions, native tools, evidence, integration, and recovery.

Execution safety, capability selection, cleanup, OCI configuration, and platform limitations are documented in the [Runner V2 execution safety guide](docs/runner-v2/guide.md), with separate [architecture](docs/runner-v2/architecture.md) and [security](docs/runner-v2/security.md) notes.

The proposed [Unified Cloud↔Desktop and Agent-Harness implementation plan](docs/plans/aiboard-unified-cloud-desktop-agent-platform-2026-10-15.md) covers simplified installation, pluggable coding harnesses, bidirectional MCP, remote device access, and optional GUI control. It is a roadmap, not implemented functionality.

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
