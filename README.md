# AI Board

[AI Board](https://aiboard.me) is a local-first multi-model discussion app with a native coding-agent Build mode. It runs on your computer: Runner V2, a durable local agent kernel, keeps your settings and keys in the AIBoard home, makes every model call, and runs Build mode; the browser is its window, where discussions run and are kept.

## Features

- Multi-model panels, debates, specialist review, and synthesized answers.
- Settings and keys in the AIBoard home (`~/.aiboard`), shared by Settings in the browser and the `aiboard config`, `aiboard keys` and `aiboard models` commands.
- Discussion history in the browser's IndexedDB or a folder you pick.
- Provider configuration for hosted and OpenAI-compatible models, in Settings or from the terminal.
- Native Build orchestration with an Architect, parallel workers, isolated Git worktrees, task commits, tools, skills, project memory, evidence, budgets, and provider failover.
- Durable checkpoints that survive browser and runner restarts.
- Guarded, Project and Full permission profiles.
- Final project handoff as a user choice, or automatic when a finished `finish` or `budgeted` run asked for a project handoff and has no known defects.

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

The static web app has no backend or account system. Discussion data stays in browser storage or the local storage folder you choose. Provider settings and keys live in the AIBoard home on your computer, never in the browser. Model calls from the page go through Runner V2's model proxy on `127.0.0.1`, which adds the key from the home and forwards the call to the configured provider; ChatGPT and GitHub Copilot go through the local account runner.

Runner V2 runs on your machine, binds to `127.0.0.1`, and requires a control token. Every model call needs it: Chat, Build and account providers. The AIBoard home is `~/.aiboard` (or `AIBOARD_HOME`): `config.json` holds settings and no secret, and `credentials.json` holds the keys, encrypted with a per-user home key kept in the user data folder, outside the home, so a copied or synced home carries no usable keys. Any program running as your user can read them, as with other command-line tools that keep keys in your user folder; there is no passphrase. Extension credentials stored by the runner are encrypted under a per-state storage key (`state/storage-key`, from which each store's key is derived), not the control token.

## Requirements

- Git on `PATH` for Build mode. Without Git the Runner still starts, with Chat and account providers only.
- Provider credentials only for the models you choose.
- Node.js 24.x only for local development; the installed Runner includes its own Node.js.

## Local development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Model calls need a connected Runner (below); configure providers in Settings or with `aiboard keys set <provider>`.

## Runner V2

Build mode has no browser execution fallback. Install the Runner once (per user, no admin rights; the release is signed and verified before anything runs):

```powershell
irm https://aiboard.me/install.ps1 | iex          # Windows (PowerShell)
```

```bash
curl -fsSL https://aiboard.me/install.sh | sh     # macOS / Linux
```

Then open a new terminal in your project folder and run `aiboard`. It opens AI Board in the browser already connected, and also starts the account runner for ChatGPT, GitHub Copilot and NVIDIA. `aiboard config`, `aiboard keys` and `aiboard models` show and edit your settings, keys and enabled models in the AIBoard home without starting a Runner (`aiboard keys set` asks for the key with your typing hidden, or reads it from a pipe with `--stdin`). `aiboard remote` lets ChatGPT or Claude use this computer, `aiboard update` installs the newest signed release, and `aiboard --help` lists every option.

From a repository checkout, contributors can run the source copy instead: `npm run runner:v2 -- --project C:\path\to\project --state-dir C:\path\to\aiboard-state --port 8787` prints a local URL and a new control token to paste into Build setup (`--allow-origin https://aiboard.me` permits a hosted UI; `npm run runner:v2 -- --help` lists the arguments).

The Runner owns the Git baseline, isolated task workspaces, task-level commits, durable agent sessions, native tools, evidence, integration, and recovery.

Execution safety, capability selection, cleanup, OCI configuration, and platform limitations are documented in the [Runner V2 execution safety guide](docs/runner-v2/guide.md), with separate [architecture](docs/runner-v2/architecture.md) and [security](docs/runner-v2/security.md) notes.

The proposed [Unified Cloud↔Desktop and Agent-Harness implementation plan](docs/plans/aiboard-unified-cloud-desktop-agent-platform-2026-10-15.md) covers simplified installation, pluggable coding harnesses, bidirectional MCP, remote device access, and optional GUI control. It is a roadmap, not implemented functionality.

Guarded access asks for approval before any action with an effect, such as a file write or a command. Project access runs work inside the project without prompts, but asks before writes outside the project and before destructive, network, credential-changing or other external actions. Full access allows configured agents to perform destructive operations, writes outside the project, credential changes, pushes/PRs, deployments, and other external actions without per-action approval. A Build's final project handoff pauses for a user choice unless the run's policy is `finish` or `budgeted`, a project handoff was requested, and no known defects are recorded; a failed automatic apply pauses for the user. This holds in every profile, Full included. In every profile the Runner's tools are refused the AIBoard home's keys and cannot change its settings; a command that runs unconfined, as Full's do, runs as your user and can read them.

If the project is not a Git repository, Runner V2 creates a safe local repository and baseline without requiring a global Git identity. When the Architect finishes and the handoff pauses for you, choose either:

- Keep the run-owned integration branch.
- Apply its binary diff to the original project after a successful `git apply --check` dry run. The apply needs a named branch and a clean worktree and index in the project, and it lands as a commit on that branch.

A conflict leaves the original project unchanged and keeps the handoff decision open. An automatic apply makes the same checks; if it fails, the run pauses for your choice.

## Production build

```bash
npm run build
```

The app exports to `out/` for static hosting. The build publishes account-provider and benchmark transports; it does not ship a browser Build runner.

## Checks

```bash
npx tsx --test --test-concurrency=1 runner-v2/test/<file>.test.ts   # the Runner V2 tests a change affects
npm run typecheck:runner-v2
npm run lint
npm run build
```

The full Runner V2 suite, `npm run test:runner-v2`, takes hours; CI or the owner runs it, not each change. Other focused tests live under `runner-v2/test/` and `scripts/test-*`.

## Security

Do not put real provider keys, runner tokens, SSH keys, or private files in issues, pull requests, screenshots, or logs. See [SECURITY.md](SECURITY.md).
