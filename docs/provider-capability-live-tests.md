# Provider capability runtime tests

AI Board has two provider-runtime test layers.

## Credential-free regression suite

Run:

```powershell
npm run test:provider-runtime
```

This suite uses mocks/fixtures and does **not** require paid provider credentials. It covers the canonical capability/transport contracts, layered evidence resolution, call planning and preflight, generic tool loading, hosted-event/artifact normalization, provider serializers, runner capability handshakes, model-discovery separation, custom endpoint overrides, the four-state capability UI, Build/local-tool isolation, and removal of the legacy provider support matrix.

This is the suite intended for normal development and CI.

## Opt-in live drift suite

Live calls are disabled by default. To opt in:

```powershell
$env:AIBOARD_PROVIDER_RUNTIME_LIVE="1"
npm run test:provider-runtime:live
```

The harness runs only live probes that already have usable credentials/account state. Missing credentials are skipped before the provider-specific script starts. Every `RUN`/`SKIP` line records the provider, model(s), and transport so drift results are attributable.

Current live probe groups:

- **OpenRouter** — uses `OPENROUTER_API_KEY`, or else the OpenRouter key saved in the AIBoard home (`~/.aiboard`, or `AIBOARD_HOME`; save it with `aiboard keys set openrouter` or in Settings), with the home's OpenRouter base URL. Keys are no longer read from a browser store. `OPENROUTER_LIVE_MODELS` can override the small default model list. `npx tsx scripts/test-openrouter-structured-output-live.mts --dry-run` reports where the key was found and calls nothing; `AIBOARD_PROVIDER_RUNTIME_LIVE_DRY_RUN=1` does the same for the whole harness.
- **GitHub Copilot account runner** — uses the existing local account-runner login in `~/.aiboard-account-provider-runner.json`. If no Copilot token is present, the probe skips.

The Copilot live requests use the same canonical `toolIntents` wire contract as the current runner; they do not rely on removed legacy `webSearch` flags.

The live harness is deliberately separate from capability persistence. A live auth, network, rate-limit, or provider outage therefore cannot write permanent `unsupported` capability evidence. Runtime capability persistence continues to use the scoped evidence/probe rules in the application itself.

Live checks may consume provider quota. Run them only when intentionally validating provider drift.
