# Security Policy

## Supported version

Security fixes target the latest version on `main` and the hosted static site at [aiboard.me](https://aiboard.me).

## Reporting a vulnerability

Email reports to [mail@aiboard.me](mailto:mail@aiboard.me).

Please include:

- A clear description of the issue.
- Steps to reproduce it.
- The browser, operating system, and deployment context.
- Whether the local runner, MCP tools, or a custom provider endpoint were involved.

Do not include real API keys, runner tokens, SSH keys, private prompts, or private files in the report. Redact secrets from screenshots and logs.

## Security model

The AI Board web app is a static site with no application backend, hosted database, or server-side key storage. It works with the AI Board Runner, which the user starts on their own computer. The optional AIBoard Remote service (mcp.aiboard.me) is a separate service with its own accounts for pairing devices; provider keys never go to it.

- Provider API keys and settings live in the AIBoard home (`~/.aiboard`, or `AIBOARD_HOME`). `config.json` holds settings and no secret. `credentials.json` holds the keys, encrypted (AES-256-GCM) with a per-user home key kept outside the home, so a copied or synced home carries no usable keys. Any process running as the user can read the home and its key; there is no passphrase.
- Keys are entered in Settings, which saves them through the local Runner, or with `aiboard keys set` in a terminal. The browser never stores them.
- Browser model calls go through the Runner's model proxy on `127.0.0.1`. The page holds only a proxy token: it lasts at most 12 hours, is replaced on renewal, and is good only for allow-listed provider paths under the upstream fixed by the home. The proxy adds the key; it never returns it.
- The Runner binds to `127.0.0.1` and requires a token or a paired local session. Its tool brokers deny the home's keys to every actor and refuse writes to its settings file.
- Discussions and attachments are stored in browser storage or a local folder selected by the user.
- MCP tools and SearXNG search are user-configured integrations. Treat their endpoints and tool outputs as external input.

## Out of scope

These are generally not security vulnerabilities in AI Board itself:

- Provider billing from a user entering their own API key into their own browser.
- Model hallucinations or incorrect model output.
- Issues in third-party AI providers, custom OpenAI-compatible endpoints, MCP servers, browser extensions, or SearXNG instances.
- Local runner actions approved by the user on their own machine.
