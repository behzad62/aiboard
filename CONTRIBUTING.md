# Contributing

Issues and focused pull requests are welcome.

## Before opening an issue

- Check whether the behavior reproduces on the latest `main`.
- Include browser and operating system details.
- For provider issues, include the provider and model name, but do not include API keys.
- For local runner issues, include the command flags used and whether MCP tools were enabled.

Never paste real provider keys, runner tokens, SSH keys, private prompts, private files, or unredacted screenshots into public issues.

## Development

```bash
npm install
npm run dev
```

The app is fully client-side. Provider keys are entered at runtime in Settings; no app runtime environment variables are required.

## Useful checks

```bash
npm run build
npx tsx scripts/test-parse-action.mts
npx tsx scripts/test-edits.mts
npx tsx scripts/test-extract.ts
npx tsx scripts/test-project-fs.ts
npx tsx scripts/test-runner-searxng-shortcut.mts
npx tsx scripts/test-seo-pages.mts
```

Run the checks that match the files you changed. For shared engine, runner, provider, or build-mode changes, run the nearest focused script and `npm run build`.

## Repository / GitHub workflow in Build mode

Repo operations in Build mode are **app-led and approval-gated**, not raw shell commands. The runner (`scripts/runner.mjs`) exposes typed `/repo/*` endpoints (status, diff, branch-create, commit, issue-read, push, pr-create), and the Architect drives them through typed JSON actions (`repo_status`, `repo_diff`, `repo_branch_create`, `repo_commit`, `repo_issue_read`, `repo_push`, `repo_pr_create`) defined in `lib/orchestrator/build.ts` and dispatched in `lib/client/build-engine.ts`. Mutating actions (branch/commit/push/PR) go through the in-app approval gate; the GitHub actions are advertised only when the runner reports an installed and authenticated GitHub CLI. Prefer extending these typed actions over reaching for raw `git`/`gh` commands. The focused tests for this area are `scripts/test-build-repo-workflow.mts`, `scripts/test-github-workflow.mts`, `scripts/test-runner-github-workflow.mts`, and `scripts/test-runner-repo-commit.mts`.

## Pull requests

- Keep changes scoped.
- Follow the existing architecture and client-side boundaries.
- Add or update focused tests when changing parsing, runner behavior, provider routing, storage, or build-mode orchestration.
- Update public docs when user-visible behavior changes.
