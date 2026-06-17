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

AI Board is a static, client-side app. There is no application backend, account system, hosted database, or server-side key storage.

- Provider API keys are entered at runtime in the browser Settings page.
- Discussions, settings, and attachments are stored in browser storage or a local folder selected by the user.
- Optional passphrase encryption is zero-knowledge; lost passphrases cannot be recovered.
- The optional local runner is started by the user, binds to `127.0.0.1`, and requires a token.
- MCP tools and SearXNG search are user-configured integrations. Treat their endpoints and tool outputs as external input.

## Out of scope

These are generally not security vulnerabilities in AI Board itself:

- Provider billing from a user entering their own API key into their own browser.
- Model hallucinations or incorrect model output.
- Issues in third-party AI providers, custom OpenAI-compatible endpoints, MCP servers, browser extensions, or SearXNG instances.
- Local runner actions approved by the user on their own machine.
