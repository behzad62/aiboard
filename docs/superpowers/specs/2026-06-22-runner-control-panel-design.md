# Runner Control Panel, Network Access, and Self-Update Design

## Status

Approved design direction from the user on 2026-06-22. This spec is for planning implementation; it does not prescribe a final code order. It supersedes the relevant assumptions corrected by the 2026-06-22 verification pass (Local Network Access, self-signed TLS, tunnel SSE support, and SHA-256-vs-signature trust).

## Problem

`scripts/runner.mjs` is a zero-dependency Node 18+ HTTP server the user starts in a terminal (`node runner.mjs <folder> [flags]`), pointed at a project folder. It already grants the browser app file read/write/search, shell, typed git/`gh` repo actions, and stdio-MCP bridges, authenticated by an `x-runner-token` header on a `127.0.0.1` bind.

But it is operated entirely through the CLI: you pick the folder with a positional arg, watch progress as raw stdout, and configure MCP bridges with `--mcp` flags decided up front. There is no way to see whether MCP servers are connected, add one mid-session, change the folder, or read the logs except in the terminal. The runner is also distributed as a downloaded file with a monotonic `VERSION` (currently `8`); a user who downloaded it once and never updated runs stale code with no signal, and the app's download button shows no version.

We want to turn the runner into a self-managing local daemon with a browser control panel — usable locally by default and, when the user opts in, remotely so the hosted app can drive a build on another machine — while preserving the single-file, zero-dependency distribution model.

## Goals

- Serve a web **control panel** from the runner: pick the folder, read live logs, see and manage MCP servers (status, add, remove, enable/disable), see the token/URL and connection state, toggle access level.
- Keep the runner a **single zero-dependency `runner.mjs`**; author the panel and help guide in the Next app and **inline them at build time** (no runtime fetch of the UI).
- Replace folder selection from a fixed CLI arg with a **runner-driven directory browser** that works whether the runner is local or remote.
- Make the runner **reachable over the network** when the user opts in (`--host`), via a browser-trusted tunnel, so the hosted https app can build remotely.
- Make the runner **version-aware and self-updating**: show its version on the download button, surface "update available," and let the user apply a cryptographically verified update on prompt.
- **Harden** the runner against the new exposure: defeat DNS-rebinding/CSRF, fail closed on network binds, and confine all filesystem access.

## Non-goals (out of scope for v1)

- Runner-terminated TLS (`--tls`). Remote uses a tunnel for browser-trusted https in v1; runner-served TLS is deferred (self-signed certs silently fail the app's `fetch()`, and a locally-trusted CA via mkcert breaks the zero-dependency ethos).
- UNC / network-share project roots. The folder browser rejects `\\` UNC prefixes when a root is set.
- HTTP/2. The runner stays HTTP/1.1; the panel uses at most one SSE stream per origin.
- A double-click / tray launcher. v1 is still terminal-started.
- Silent (non-prompt) auto-update.

## Architecture overview

Three pieces, one source of truth per concern:

- **Runner (`scripts/runner.mjs`)** — gains: an unauthenticated static shell route, a token-gated `/api/*` surface, a request guard (Host/Origin) ahead of auth, a directory-browser + re-root, structured logging with an SSE + poll feed, runtime MCP lifecycle, a `--host` bind, and a signed self-update path. Stays a single file.
- **Panel + help source** — authored in the Next app (reusing its styling), built to static strings, and **injected into `runner.mjs` at build time** by extending the existing `copy-runner` npm step. The same help content is also rendered as an app page.
- **Release manifest** — the build emits `public/runner-manifest.json` (`{ version, sha256, sig, url }`) and stamps `RUNNER_VERSION` into the app bundle, so the download button and "update available" nudge have a single source of truth.

## Runner HTTP surface

### Unauthenticated static shell

- **`GET /`** serves the inlined panel shell (HTML/JS/CSS) plus the inlined help content and the runner's own version. It contains **no secrets and performs no side effects**, so it is served *before* the auth gate.
- The shell response sets defensive headers: `Content-Security-Policy: default-src 'self'`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.

### Token-gated API

- All data and actions live under **`/api/*`** and require the `x-runner-token` header. Existing endpoints (`/health`, `/ls`, `/read`, `/write`, `/run`, `/repo/*`, `/mcp/*`, etc.) are aliased under `/api/*` while keeping their current paths working so the app's existing client (`lib/client/runner.ts`, `lib/client/repo-runner.ts`) is not broken.
- New endpoints:
  - `GET /api/fs/list?path=` — list subdirectories of `path` (directory browser). On Windows, the synthetic top level is a drive picker.
  - `POST /api/fs/root` — set the active working folder to a browsed path; persist it; re-root. Rejected while a build is in progress.
  - `GET /api/logs/stream` — Server-Sent Events log feed (authenticated by a single-use nonce, see Security).
  - `GET /api/logs?since=<seq>` — short-poll fallback over the ring buffer (degrades gracefully over a buffering tunnel).
  - `POST /api/mcp` (add), `DELETE /api/mcp/:name` (remove), `POST /api/mcp/:name/enable` (toggle enabled).
  - `POST /api/update/check` (compare to manifest), `POST /api/update/apply` (run the signed self-update).
  - `GET /api/status` (version, bound host/port, access level, connection/last-request info), `POST /api/access` (Ask ↔ Full).

### Request guard (runs before auth)

On **every** request, before the token check:

- **Host-header allowlist:** accept only `127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>`, and — when `--host` is set — the exact configured host:port. Anything else → `403`. This defeats DNS-rebinding (a malicious page rebinding a hostname to the runner's address sends a foreign `Host`). Applies to every request, including the shell.
- **Origin allowlist:** when an `Origin` header is present, accept only the runner's own origin and the app's known origins — `https://aiboard.me` plus local-dev origins (`http://localhost:<port>`, `http://127.0.0.1:<port>`) — extendable with `--app-origin <origin>` for self-hosters; reject any other origin. A request with **no** `Origin` (a top-level navigation to the shell, or a same-origin request) passes the Origin check but is still Host-gated. CORS `Access-Control-Allow-Origin` is reflected from this allowlist instead of `*`, and the OPTIONS `Access-Control-Max-Age` is shortened.
- Then, for `/api/*`, the existing token check, upgraded to `crypto.timingSafeEqual`.

## Web control panel

A single page served by the shell route:

- **Header:** runner version, connection indicator (is the app currently talking to the runner; last-request time), Ask/Full access toggle, and an "update available" badge when the runner is behind the manifest.
- **Folder browser:** breadcrumb + subdirectory list with a "Use this folder" action; navigation is bounded by the runner's root (see Folder selection).
- **Live log pane:** streamed structured logs with level and category filters.
- **MCP table:** one row per bridged server — name, health (handshake ok / tool count / last error), an **enable checkbox**, and add/remove controls.
- **Help tab:** the inlined usage guide.
- On load, the panel pre-checks the Chrome **Local Network Access** permission (`navigator.permissions.query`) and renders remediation copy if it is `prompt`/`denied`, rather than failing opaquely.

## Folder selection & confinement

### Root and default

- `node runner.mjs [root] [flags]`: the optional positional is the **root** — both the initial working folder and the outer boundary of the directory browser.
- **Omitted → root = `process.cwd()`** (the folder the runner was launched from). This matches today's default (`positional[0] ?? "."` resolves to `cwd`), reflects the user's intentional location, and bounds the browser to that subtree instead of exposing the whole disk.
- To deliberately browse the whole machine, the user passes an explicit root such as `/` (POSIX) or a drive root (Windows). The directory browser navigates and picks the active working folder *within* the root; it cannot escape above it.
- Re-rooting at runtime (`POST /api/fs/root`) is bounded by the startup root, requires explicit confirmation, and is refused while a build is in progress.

### Directory enumeration (zero-dependency, cross-platform)

- POSIX top level is `/`. **Windows has no single root**: enumerate drive letters by probing `A:`–`Z:` in parallel with `opendir('X:\\')` and `Promise.allSettled`, with a short per-drive timeout so disconnected/removable drives never stall the browser. Do **not** shell to `wmic` (removed in Windows 11 25H2).
- A bare drive letter (`d:`) is **not** the root — it resolves to the per-drive current directory. Always append the separator (`d:\\`).

### Confinement (single chokepoint)

- A single `confine(root, target)` helper is the only way file paths are resolved. It does `path.resolve()` **then** `fs.realpath()` (to resolve symlinks/junctions before the boundary test), then accepts only if `realPath === root || realPath.startsWith(root + path.sep)`. The trailing `path.sep` is load-bearing (otherwise `/srv/rootEVIL` passes a `/srv/root` check).
- `confine` is applied to **every** filesystem operation (browse, read, write, patch, append, and the re-root target), not just at folder-selection time, to prevent symlink/TOCTOU escapes and a re-root pivot.
- For browsing to a not-yet-existing path, walk up to the nearest existing ancestor, confine that, re-append the tail, and re-validate after any `mkdir`.
- Pre-resolve rejects: null bytes and reserved device names (`CON`, `PRN`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`). When a root is set, also reject UNC (`\\…`) and drive-relative/absolute targets that leave the root; normalize drive-letter case before the `startsWith` comparison on Windows. The existing `toSegments()` semantics in `lib/client/project-fs.ts` are reused for the relative tail, with server-side `realpath` layered on top. Persisted root and chosen folder are stored as already-`realpath`'d canonical strings.

## Structured logging

- Internally emit log **events** (`{ ts, level, category, msg, ...fields }`) fanned to three sinks: an in-memory **ring buffer**, the **SSE stream**, and a **console formatter that reproduces today's exact stdout strings** so the terminal experience is unchanged.
- The panel renders events richly (level colors, category filters, grouping). The `GET /api/logs?since=` poll reads the ring buffer for tunnel/fallback cases.
- Migration: existing `console.log/console.error` call sites move to the event sink; the high-value categories (repo actions, MCP, `/run`, auth failures, re-root, self-update) are structured first.
- Auth failures, re-roots, MCP spawns, and self-updates are always logged (stdout + ring buffer) for after-the-fact visibility.

## MCP management

- Status already exists (`GET /api/mcp/servers`). Add runtime lifecycle:
  - **Add** (`POST /api/mcp`): parse `name=command` like the startup `--mcp` path, spawn the stdio bridge (reusing the existing spawn logic), register it so `/api/mcp/call` routing finds it, and persist to the config file.
  - **Remove** (`DELETE /api/mcp/:name`): kill the child and deregister.
  - **Enable/disable** (`POST /api/mcp/:name/enable`): config entries carry an `enabled` flag; toggling spawns or kills the child without losing the entry. Status reports `enabled` plus health (handshake ok, tool count, last error).
- Adding an MCP server is arbitrary process spawn (the same trust class as `/run`); it is token-gated, logged, and — when `--host` is set — subject to the same network hardening as every other action.

## Network mode (opt-in)

- Default bind stays `127.0.0.1` over plain http. Loopback is a "potentially trustworthy" secure context, so the hosted https app can fetch `http://127.0.0.1` with **no TLS and no mixed-content block** — this is why the runner works today and needs no change for the local case.
- `--host <addr>` exposes the runner beyond loopback and **fails closed**: it refuses to bind a non-loopback address unless a strong token (≥128 bits) is set, and it warns loudly that traffic is plaintext on a non-loopback interface and the token is the only protection.
- **Remote reachability = a browser-trusted tunnel.** The help guide documents tunnels ordered by SSE-safety (our log stream is SSE-over-GET):
  1. **ngrok** — best SSE support and, as of 2026, a stable free dev domain. `ngrok config add-authtoken <t>` then `ngrok http <runner-port>`. Note the free caps (≈20k req/mo, 100 TCP conn/min, 1 GB/mo); a long-lived SSE stream holds a connection slot.
  2. **Tailscale Funnel** — stable `*.ts.net` URL, expected SSE-OK. `tailscale funnel <runner-port>`; the public listener is restricted to ports 443/8443/10000 (the local runner port is unrestricted); requires the daemon, MagicDNS, and a `funnel` ACL attribute.
  3. **Cloudflare *named* tunnel only** (own domain), with an explicit "verify the live-log panel streams, don't assume SSE works" note.
  - **Explicit ban:** never use a Cloudflare Quick Tunnel (`trycloudflare`). It buffers SSE-over-GET until the connection closes (open bug cloudflared #1449), which freezes the live-log panel.
- **Local Network Access (LNA):** the old Private Network Access preflight (`Access-Control-Allow-Private-Network`) is obsolete as of Chrome 142 (Oct 2025); reaching a local runner from a public https origin is gated by a **user permission prompt**, not a server header. The connect UX surfaces "Chrome will ask permission to reach your local runner — click Allow." The panel/app query both `loopback-network` and `local-network` permission names (the latter as alias), set `targetAddressSpace: 'loopback'` (or `'local'`) on fetches, and feature-detect rather than UA-sniff so Firefox (experimental) and Safari (loopback works via the mixed-content exemption, no Chromium prompt) degrade gracefully.

## Security model

The runner is an RCE-capable daemon; opening a panel and a network bind widens its surface, so these are hard requirements, not options.

- **DNS-rebinding / CSRF defense (highest priority):** the Host + Origin allowlist guard above, on every request before auth. Auth stays header-based (never a cookie) so a CORS preflight is always forced; the preflight is restricted to the Origin allowlist. This mirrors the fix shipped for the MCP-SDK rebinding advisory (GHSA-89vp-x53w-74fx).
- **Token handling:** the token travels only in the `x-runner-token` header — never in a URL path or query. The panel receives it via the **URL fragment** of a deep-link (`http://127.0.0.1:<port>/#token=…`), reads `location.hash`, immediately scrubs it with `history.replaceState`, and holds it in `sessionStorage`. `?token=` query delivery is rejected. The default token is ≥128 bits; a low-entropy `--token` is rejected at startup when `--host` is set; comparison is constant-time; repeated auth failures get per-source backoff.
- **SSE authentication:** `EventSource` cannot send custom headers, so the log stream is *not* opened with the raw token. The panel first mints a **short-lived, single-use nonce** via an authenticated POST, then opens the SSE with that nonce as a query parameter.
- **Self-update authenticity:** see below — Ed25519 signature verification, not hash-only.
- **Clickjacking / framing:** shell sets `X-Frame-Options: DENY` and a restrictive CSP.
- **Connection budget:** the panel opens at most one `EventSource` per runner origin (Node `https`/`http` is HTTP/1.1, ≈6 connections per origin); document the limit.

## Version awareness & self-update

### Versioning and the download button

- `RUNNER_VERSION` (bumped from `8`) is the single source of truth; the build stamps it into the app and the manifest. The download button renders `Download runner.mjs (v<n>)`. When a runner is connected, the app/panel compare its `/health` version to the manifest and show an "update available" nudge.

### Self-update (prompt-only, signed)

- Triggered only by explicit user action in the panel. Refused if a build is in progress or the runner is running from a non-writable location.
- Ordered sequence (verified against Node 18+/Windows behavior — Node does not lock its own running `.mjs`):
  1. `selfPath = process.argv[1]`; confirm its directory is writable.
  2. `fetch(manifest.url)`; stream `res.body` via `Readable.fromWeb` → `pipeline` → `runner.mjs.download` in the **same directory** (same volume, so the later rename is atomic).
  3. On finish, `fsync` then close the file descriptor.
  4. Re-read the **on-disk** temp file: **verify the Ed25519 signature against a public key pinned in the shipped runner, then verify the SHA-256** against the manifest. Any failure → unlink the temp file and abort with no change.
  5. Copy current `runner.mjs` → `runner.mjs.bak` (rollback).
  6. `rename` temp over `selfPath`, with retry-on-`EPERM`/`EACCES`/`EBUSY` backoff (≈10 tries, 100 ms × attempt) for transient Windows Defender/indexer/editor locks.
  7. Teardown: kill MCP children and background processes (the existing SIGINT path); `server.close()` to release the port.
  8. `spawn(process.execPath, [selfPath, ...preservedArgv], { stdio: 'inherit', cwd, env: { ...process.env } })`, where `preservedArgv` is **rebuilt from parsed values** and always emits the resolved `--port` and `--token` (even if originally omitted), the root, and every `--mcp`/`--context7`/`--searxng` flag. On the `spawn` event, `process.exit(0)`; on spawn error, restore `.bak` and do not exit.
- Health-gate: the new process must answer `/health` with the new version; otherwise surface failure and keep `.bak` available.
- **Authenticity note:** SHA-256 alone is integrity, not authenticity — it does not survive a compromised release host republishing a matching hash. The pinned-key Ed25519 signature is what makes the update channel safe; the signing key lives only in the release pipeline.

## Help / usage guide

- Authored once in the app and rendered two ways: an **app page linked from the "Connect your project — local runner" section** (the runner-setup card in `components/RunnerSetup.tsx`), and **inlined into the panel's Help tab** for offline/local reading.
- Covers: install + Node requirement, flags, the folder/root rule, MCP management, network mode and the tunnel recipes (ngrok-first; `trycloudflare` banned), the LNA "click Allow" note, and self-update.

## Build & packaging

- Extend the existing `copy-runner` npm step (run by `predev`/`prebuild`) to also inject the built panel and help strings into the copied `runner.mjs`, and to emit `public/runner-manifest.json` (`{ version, sha256, sig, url }`) and stamp `RUNNER_VERSION` into the app.
- The result remains one downloadable file with no runtime fetch of its UI. `public/runner.mjs` and the manifest stay gitignored build artifacts (the source of truth is `scripts/runner.mjs` plus the panel source in the app), served by the static export exactly like `runner.mjs` is today.

## Testing & acceptance

- **Unit (tsx, PASS/FAIL like the existing suite):**
  - `confine()` — escape attempts, symlink/junction resolution, trailing-`path.sep` boundary, Windows drive-letter casing, UNC rejection when a root is set, reserved device names, no-root vs rooted behavior. Extend `scripts/test-project-fs.ts`.
  - Manifest verification — Ed25519 signature accept/reject + SHA-256 match/mismatch, including a tampered binary with a valid hash but bad signature.
  - `preservedArgv` reconstruction — token/port survive when originally omitted; all MCP/context7/searxng flags reproduced.
  - Request guard — Host/Origin allow/deny matrix.
- **Manual / integration:** panel folder-pick within a root; live logs over loopback **and** over a real tunnel; MCP add/enable/remove reflected in status; a real signed self-update round-trip (download → verify → swap → re-exec → new `/health` version) with a `.bak` rollback on forced failure; `--host` fail-closed on a weak token; the LNA prompt path.

## Key references

- Local Network Access (Chrome 142/145, `targetAddressSpace`, permission split): developer.chrome.com/blog/local-network-access; MDN Local Network Access.
- DNS-rebinding fix pattern (Host-allowlist): GHSA-89vp-x53w-74fx.
- Cloudflare Quick Tunnel SSE-over-GET buffering: cloudflared issue #1449.
- Tunnel docs: ngrok free-plan limits; Tailscale Funnel; Cloudflare named tunnels.
- Trusted local certs (deferred `--tls`): FiloSottile/mkcert.
- Current runner behavior: `scripts/runner.mjs` (auth/CORS `:143-157`, shell/health `:1681-1704`, MCP/spawn `:476`/`:559`, teardown `:1668-1678`, bind `:2213`); `components/RunnerSetup.tsx:118` (download button); `lib/client/runner.ts:32` (`/health`).
