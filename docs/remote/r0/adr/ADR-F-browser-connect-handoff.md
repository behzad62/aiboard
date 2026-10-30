# ADR-F: Browser connection handoff

## Status

Proposed.

## Context

Runner V2 listens on `127.0.0.1`, authenticates control requests with a bearer token and currently allows any loopback browser origin in addition to configured origins (`runner-v2/src/control-server.ts:297`, `runner-v2/src/control-server.ts:345`, `runner-v2/src/control-server.ts:1600`). Its startup JSON contains the token, and setup currently asks the user to paste it (`runner-v2/src/cli.ts:352`, `runner-v2/src/cli.ts:364`, `components/RunnerSetup.tsx:122`). Account, legacy and bench runners have different token and Origin handling (`lib/account-provider-runner.mjs:142`, `scripts/runner.mjs:2198`, `scripts/bench-runner.mjs:88`).

## Decision

Use `https://aiboard.me/connect#pair=<one-time-code>&runners=<port-list>`. The code is a 256-bit random secret encoded with a version and anchor-instance identifier, valid at most 120 seconds, bound to that runner instance and consumed atomically once. Ports are decimal loopback ports only, bounded in count; the first is the anchor. No reusable bearer token is ever placed in a URL, process arguments, ordinary logs or browser history.

| Step | Contract |
| --- | --- |
| Launch | For each requested runner, start or reuse the verified same-user instance. Establish a private launcher-to-runner channel using inherited anonymous pipes/OS-protected IPC, never a token in argv. Register a separately generated, single-use instance-bound ticket with each selected runner. For a combination, the launcher privately gives the anchor the other tickets, their ports, kinds and instance IDs; no runner receives another runner's control token. |
| Navigate | Open one tab using the OS opener. Capture and validate the fragment in memory, immediately call `history.replaceState` to remove it, and do not load third-party scripts or log the fragment. Validate the exact port list; never scan or accept hostnames from it. |
| Exchange | `POST http://127.0.0.1:<anchor-port>/v1/local-pair/exchange` with JSON `{version:1, code}` and `X-AIBoard-Pair-Version: 1`; omit cookies and ambient credentials. The anchor checks exact Origin, numeric Host/port, content type, code hash, instance, expiry and one-time state before consuming the code and returning `Cache-Control: no-store` JSON `{version, instanceId, kind, port, sessionToken, peers:[{instanceId, kind, port, code}]}`. Errors are generic, bounded and never echo secrets. The response instance and port must match the fragment and registered launch. |
| Combined launch | For every peer listed in the anchor response, verify its port was in the original list, then POST its distinct ticket to that peer's same endpoint. Each peer consumes its own ticket and returns only its own instance identity and session token, with no further peers. The browser checks the expected identity and records each connection under its runner kind. No peer is reachable via the relay unless it is Runner V2. |
| Use/revoke | Issue a fresh browser-session credential separate from storage keys. The app uses the existing runner-specific authorization headers; pairing grants no additional tool privileges. Keep the connection in tab session storage/in-memory, wire it into the corresponding current app surfaces, show connection health and provide explicit revoke. A second browser requires a new user-initiated CLI pairing/approval. Invalidate active session credentials when the associated process stops or the user revokes them. |

The exchange handler accepts **only** `Origin: https://aiboard.me` in production, requires `Host: 127.0.0.1:<actual-port>`, rejects absent/null/other Origins, wrong Host, wrong method/content type, cross-origin form posts, duplicate/expired/used tickets and excessive attempts. Do not inherit the broader developer `--allow-origin` setting on this route. Apply equivalent Host, Origin, CSRF and authentication checks to all unified-launch runner endpoints; in particular, replace the account runner's wildcard CORS fallback (`lib/account-provider-runner.mjs:144`). A separately enabled development-only origin must never ship enabled by default. Rate-limit failures and prevent caching.

For cross-origin `OPTIONS`, return `Access-Control-Allow-Origin: https://aiboard.me`, `Vary: Origin`, `Access-Control-Allow-Methods: POST, OPTIONS`, and `Access-Control-Allow-Headers: Content-Type, X-AIBoard-Pair-Version` only for an allowed Origin/Host/path. If the browser sends `Access-Control-Request-Private-Network: true`, also return `Access-Control-Allow-Private-Network: true` for that validated preflight; return the exact CORS origin on the actual response. Existing authenticated routes need their own restricted preflight for `Authorization` or `X-Runner-Token`. No wildcard origin or credentialed cookies. [Chrome's PNA preflight description](https://developer.chrome.com/blog/private-network-access-preflight) specifies those opt-in headers; [Chrome's Local Network Access guidance](https://developer.chrome.com/blog/local-network-access) says its newer permission model also covers loopback, so the page must handle an OS/browser permission prompt or denial. Headers do not override a denied permission or browser policy; qualify supported browsers with live tests.

If an opener is unavailable, print the code and port list to the initiating terminal for the user to paste into the connect page's manual form; never print a reusable token. Expired/consumed code, lost exchange response, port conflict, mismatched instance, unavailable runner or blocked local access gets a clear per-runner status and a new user-initiated code; do not replay a consumed code or start an unrequested instance. If local-network permission is denied, instruct the user to allow it or use a supported browser; manual paste alone cannot bypass the restriction. A refresh keeps the tab's already exchanged credentials and strips stale fragments; a Runner restart invalidates old session credentials and requires a new CLI pairing. A repeated `aiboard` invocation reuses a healthy running instance and mints a new pairing code, rather than rotating that process's credentials underneath existing tabs.

The legacy V2 encrypted provider and extension stores both use the current control token (`runner-v2/src/cli.ts:168`, `runner-v2/src/cli.ts:175`, `runner-v2/src/extension-credentials.ts:29`). Introduce a stable per-user/per-project protected storage key, separate from short-lived session tokens. For existing state, obtain the old token through a trusted local prompt/channel, decrypt both stores, stage and verify new envelopes under a recovery journal and atomically commit their common version pointer. Keep protected rollback data, make the previous release safely read/write compatible as required by ADR-E, and fail closed without overwriting on missing/wrong token or interrupted migration. Account-runner stored identity must likewise survive its session-token changes (`lib/account-provider-runner.mjs:48`). Rebind launcher-managed account-provider connections after restart through the protected channel; do not overwrite unrelated manually configured providers or leave a stale browser-session token as durable provider authentication. Do not pass any token through child argv or print startup secrets in unified mode; this includes replacing bench's current managed-Runner `--token` argument (`scripts/bench-runner.mjs:1419`).

Adopt Milestone A2/A3's per-user/project state, instance reuse, one-time consent, manual fallback, refresh/restart clarity and Origin/DNS-rebinding/CSRF defenses. The current L1/L2 packets replace A2/A3 sequencing; opening the browser is the normal owner-selected flow, with explicit headless mode. The historical plan requires a fresh approval for a second browser and no bearer token in fragments (`D:/repos/ai-discussion-board/docs/plans/aiboard-unified-cloud-desktop-agent-platform-2026-10-15.md:145`, `D:/repos/ai-discussion-board/docs/plans/aiboard-unified-cloud-desktop-agent-platform-2026-10-15.md:151`, branch `plan/aiboard-platform-a0`).

L1 file touchpoints (proposed names only):

- `app/connect/page.tsx`
- `components/RunnerSetup.tsx`
- `components/DashboardPage.tsx`
- `components/ApiKeyForm.tsx`
- `components/benchmark/workbench/WorkBenchRunnerStatus.tsx`
- `app/discussion/discussion-client.tsx`
- `lib/client/local-runner-handoff.ts`
- `lib/client/runner-v2.ts`
- `lib/client/runner.ts`
- `lib/client/bench-runner.ts`
- `lib/client/settings-api.ts`
- `runner-v2/src/launcher.ts`
- `runner-v2/src/cli.ts`
- `runner-v2/src/control-server.ts`
- `runner-v2/src/encrypted-provider-config-store.ts`
- `runner-v2/src/extension-credentials.ts`
- `lib/account-provider-runner.mjs`
- `scripts/runner.mjs`
- `scripts/runner-panel.html`
- `scripts/bench-runner.mjs`

## Consequences

Each local runner needs a pairing endpoint and secure IPC; existing one-token equality gates cannot simply be wrapped by a URL redirect. Session storage survives refresh in the same tab but is not a durable credential vault. A partial combined launch may leave some runners connected and must show each result independently.

## Alternatives rejected

- Reusable `port:token` pairs in the fragment expose a bearer credential to URL handling and conflict with the architect decision.
- A single reusable coordinator token granting every child access collapses runner boundaries and cannot enforce per-instance, single-use exchange.
- Wildcard CORS or permissive loopback origins for pairing would allow unsolicited websites to try obtaining a session credential.

## Open questions

- Which OS secret-store implementation will hold the stable project storage key where a desktop keychain is unavailable?

## Plan corrections

L1 specifies `#runners=<port:token,...>` and T12 says the token is in a fragment (`docs/plans/2026-10-27-aiboard-remote.md:147`, `docs/plans/2026-10-27-aiboard-remote.md:306`). Replace both with the architect's single-use-code exchange and assert that no reusable token appears in any URL. The existing legacy panel also accepts `#token=...` (`scripts/runner-panel.html:227`); remove that bearer-fragment path as part of L1 while retaining manual pairing. L1's fresh-token instruction also needs the encrypted-store migration above; current code ties both encrypted stores to the Runner token.

## Evidence

Inspected AIBoard `d7ed04d2505869f5d52ac17bfd1dfe92259b112f`; Milestone A is from `plan/aiboard-platform-a0` at `47d94d13185e216574157b29d4813981246d0433`.

- `runner-v2/src/control-server.ts:297`; `runner-v2/src/control-server.ts:329`; `runner-v2/src/control-server.ts:1575`; `runner-v2/src/control-server.ts:1600`.
- `runner-v2/src/cli.ts:168`; `runner-v2/src/cli.ts:175`; `runner-v2/src/cli.ts:352`; `runner-v2/src/encrypted-provider-config-store.ts:50`.
- `components/RunnerSetup.tsx:122`; `app/discussion/discussion-client.tsx:1024`; `components/ApiKeyForm.tsx:540`; `components/benchmark/workbench/WorkBenchRunnerStatus.tsx:81`.
- `lib/account-provider-runner.mjs:48`; `lib/account-provider-runner.mjs:142`; `scripts/runner.mjs:2198`; `scripts/runner-panel.html:227`; `scripts/bench-runner.mjs:88`; `scripts/bench-runner.mjs:1419`.
