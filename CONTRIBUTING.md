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

## Pull requests

- Keep changes scoped.
- Follow the existing architecture and client-side boundaries.
- Add or update focused tests when changing parsing, runner behavior, provider routing, storage, or build-mode orchestration.
- Update public docs when user-visible behavior changes.
