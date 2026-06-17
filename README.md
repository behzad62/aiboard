# AI Board

[AI Board](https://aiboard.me) is a local-first web app where multiple AI models discuss a question, critique each other over structured rounds, and produce one synthesized final answer. It also includes Build mode, where an architect model plans coding work and worker models implement tasks in parallel.

The app is a static Next.js export. There is no backend service, no API routes, and no account system.

## Features

- Multi-model discussions across OpenAI, Anthropic, Google Gemini, OpenRouter, and custom OpenAI-compatible endpoints such as Ollama or LM Studio.
- Discussion modes for collaborative panels, debates, specialist review, and Build mode.
- Judge synthesis with confidence and dissent notes.
- Browser-side storage using IndexedDB or a user-picked local folder.
- Optional passphrase encryption for local stored data.
- Runtime provider keys entered in the Settings page, not compiled into the app.
- Optional local runner for Build mode file access, shell commands, and MCP tools.
- Optional SearXNG MCP shortcut for web search through a user-provided SearXNG instance.

## Privacy model

AI Board runs in your browser tab. API keys, discussions, attachments, and settings stay in browser storage or in a local folder you choose. The app calls AI providers directly from the browser using the keys you enter.

The hosted site at `aiboard.me` serves static files only. It does not receive your provider keys, prompts, files, attachments, or discussion history.

If you enable the local runner, it runs on your own machine, binds to `127.0.0.1`, and requires a token. Runner file, shell, and MCP access are opt-in.

## Requirements

- Node.js 20+ for local development.
- Provider API keys only if you want hosted AI models. Local models through Ollama or LM Studio can be used without provider keys.

No app runtime environment variables are required.

## Local development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), go to Settings, and add the providers or custom endpoints you want to use.

## Production build

```bash
npm run build
```

The app is exported to `out/` and can be hosted by any static web server. The build also copies `scripts/runner.mjs` to `public/runner.mjs` so the hosted app can offer the optional runner download.

## Local runner

Build mode works without the runner by keeping generated files in a virtual workspace that can be downloaded as a zip. For real project folder access, start the runner yourself:

```bash
node runner.mjs <project-folder>
```

The runner supports file read/write/search, approved shell commands, and stdio MCP bridges:

```bash
node runner.mjs <project-folder> --mcp "docs=npx -y @upstash/context7-mcp"
```

For SearXNG-backed web search, point the runner at your own SearXNG instance:

```bash
node runner.mjs <project-folder> --searxng --searxng-url http://127.0.0.1:8080
```

## Checks

There is no bundled test runner. The repository uses focused `tsx` scripts with PASS/FAIL output:

```bash
npm run build
npx tsx scripts/test-parse-action.mts
npx tsx scripts/test-edits.mts
npx tsx scripts/test-extract.ts
npx tsx scripts/test-project-fs.ts
npx tsx scripts/test-runner-file-tools.mts
npx tsx scripts/test-runner-background.mts
npx tsx scripts/test-runner-searxng-shortcut.mts
npx tsx scripts/test-seo-pages.mts
```

Additional focused tests live in `scripts/test-*.mts` and `scripts/test-*.ts`.

## Security

Do not put real provider keys, runner tokens, SSH keys, or private files in issues, pull requests, screenshots, or logs. See [SECURITY.md](SECURITY.md) for reporting guidance.

## Support

Feedback and security reports: [mail@aiboard.me](mailto:mail@aiboard.me)

Optional donations: [paypal.me/behzadashams](https://paypal.me/behzadashams)

## License

MIT. See [LICENSE](LICENSE).
