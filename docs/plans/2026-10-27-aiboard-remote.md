# AIBoard Remote — One-Line Local Runner, Paid Cloud Relay & Durable Jobs — Implementation Plan
Date: 2026-10-27 (owner decisions recorded 2026-10-27, see §1.1)
Status: PROPOSED, AUDIT-GROUNDED, OWNER DECISIONS SETTLED. Implementation, paid-provider calls, VPS deployment, DNS changes, payment processing and push are NOT authorized by this document; each needs fresh owner approval.
Primary repository: D:\repos\ai-discussion-board (audited at b4ed26bd; re-verified at 769a3f7f, 2026-10-27).
Relay/backend repository: D:\repos\aiboard-tunnel (audited clean at 69dc065, 2026-10-27).
Hosting target: the existing aiboard.me VPS (Ubuntu 26.04, 1 vCPU, 1.9 GiB RAM, Nginx + Certbot + Docker, also hosts funboard.app; inspected read-only 2026-10-27).
Audience: implementation agents, Architect, Reviewer and Verifier.

## 0. Agent execution instructions and source precedence
1. Read this entire file, AGENTS.md/CLAUDE.md in BOTH repositories, docs/runner-v2/architecture.md, docs/runner-v2/security.md, docs/runner-v2/guide.md, docs/runner-v2/extensions.md, docs/plans/2026-10-26-native-tools-and-extension-management-status.md and docs/plans/aiboard-unified-cloud-desktop-agent-platform-2026-10-15.md. Read docs/runner-v2/task-12-bounded-gates.md and task-12-status.md if touching Task 12/P6 acceptance or release packaging (REL-1 is recorded as NOT STARTED with push held; do not collide with its release preparation).
2. Recheck checkout, branches, uncommitted changes, current code and test coverage before executing packets. This snapshot is not a future-state certification. Current verified behavior wins over stale plan descriptions.
3. Runner V2 is the ONLY execution/grant/recovery authority reachable from the cloud. Never create a second ungoverned remote shell, file writer, GUI-control server or process host. The tunnel repo is transport, not a reason to fork the tool engine.
4. Use separate, named worktrees/branches per independently reviewable packet. Respect other agents' worktrees and uncommitted work. A docs-only commit of this file may be needed before a new worktree can see it. No push/deploy without explicit owner approval: pushing ai-discussion-board main deploys aiboard.me.
5. Implement vertical slices in dependency order. Every packet: grounded baseline + ADR as needed -> contracts/safety -> code -> focused deterministic tests -> typecheck/lint -> independent review -> ledger update with commit and command evidence. Broad Runner matrix only at planned gates (per owner rule: targeted tests per change, full suite once at the end).
6. Never defeat vendor rate limits, plan quotas, CAPTCHA, login, secure desktops, or billing checks through automation.
7. Do not confuse tests passing with production readiness. Separate: implemented; deterministic test passed; live end-to-end; deployed; production-qualified.
8. Precedence (owner decision D16): THIS plan supersedes the 2026-10-15 unified plan's Milestones A (A1–A3), C2, D (D1–D4) and E (E1–E3), including its tool names, and the P7 charter (branch plan/aiboard-platform-a0; both P7 attempts paused at baseline with no launcher code). Milestone B (Codex/Claude CLIs as Build role providers) stays in that plan as separate future work. Its C1 (local stdio MCP) is adopted here as part of L1. E1 (OpenAI Secure MCP Tunnel) is dropped. Valid requirements carried over from A1–A3 are recorded in ADR-E/ADR-F. The Runner-is-authority invariant stays.

## 1. Product definition
**AIBoard Remote** lets cloud agents (ChatGPT, Claude, any MCP client) work on the user's own computer through a hosted relay at `mcp.aiboard.me`. Building happens locally on the user's device; the cloud agent is the brain.

- **AIBoard itself is free**: the web app, Runner V2, local Build/Chat, the one-line installer and all local capabilities stay free. Only cloud use through the AIBoard relay is metered and paid.
- **The cloud agent is the only reasoning loop.** AIBoard does not run its own model loop on behalf of a remote session, does not use account-backed providers (subscription CLIs) in remote mode, and never "continues" a chat. What survives a chat disconnect is *work already started*: processes, tests, builds and transfers, tracked as durable jobs the agent (or the user in the dashboard) can query later.
- **Work runs on the user's PC and stops when the PC is off or asleep.** This is intentional; the dashboard says so truthfully.
- **Cross-platform from the start**: Windows, macOS and Linux (x64 + arm64) for install, CLI, local runner and remote. Per-OS capability differences are surfaced honestly.
- **Reference UX**: Desktop Commander Remote (`npx @wonderwhy-er/desktop-commander@latest remote`; dashboard with Devices / Usage / Plan & billing / Settings and "Where you use it": ChatGPT, Claude, any MCP client). AIBoard matches that simplicity with stronger governance (Runner grants, durable jobs, audit).
- Desktop GUI control is NOT built in; it arrives after launch through a curated plugin catalog (§5, X1).

### 1.1 Owner decisions (2026-10-27)
| # | Topic | Decision |
| --- | --- | --- |
| D1 | Reasoning loop | Cloud agent only. Original Phase 4 (AIBoard-owned model orchestration, provider failover, context compaction) is REMOVED; durable jobs remain (R2). |
| D2 | Backend home | aiboard-tunnel monorepo: harden `packages/relay`, add account/billing/dashboard packages. Runner-side connector lives in ai-discussion-board/runner-v2 and shares only protocol types. |
| D3 | Hosting | Single relay process on the existing aiboard.me VPS. No HA. SQLite (`node:sqlite`) store. Nginx vhost + Certbot. |
| D4 | Sign-in | Self-hosted and free. Google + GitHub login following FunBoard's server-redirect pattern (`jose` ID-token validation, cookie sessions). The relay is also the MCP OAuth authorization server (via the official MCP TypeScript SDK auth helpers). No paid auth vendor. |
| D5 | Payments | Paddle (merchant of record: VAT/sales tax, refunds, chargebacks). |
| D6 | Pricing | Mirror Desktop Commander: Free = 10,000 tool calls per calendar month; Pro = $20/month for more. Every `tools/call` counts (including job status calls). Limits/prices are configuration, not code. |
| D7 | Distribution | No ZIP for users. One-line install: `irm https://aiboard.me/install.ps1 \| iex` (Windows) and `curl -fsSL https://aiboard.me/install.sh \| sh` (macOS/Linux). |
| D8 | CLI | One `aiboard` command with runner selection: `aiboard` = Runner V2 in the current folder; `aiboard accounts`, `aiboard legacy`, `aiboard bench` individually; combinations (`aiboard runner accounts`) and `aiboard all`; `aiboard remote` = Runner V2 + relay. The current folder is the project; the browser opens with connection details pre-filled. |
| D9 | Remote reach | Whole machine (like Desktop Commander), current folder as default working directory. Remote mode exposes ONLY Runner V2; account/legacy/bench runners are never reachable through the relay. |
| D10 | Platforms | Windows, macOS, Linux as first-class targets. |
| D11 | GUI control | After launch, via plugins (e.g. Windows-MCP on Windows, Playwright MCP/browser everywhere, equivalents on macOS/Linux) with easy enable/disable. Not built natively. |
| D12 | Domain | `mcp.aiboard.me`: MCP endpoint `/mcp`, dashboard at `/` served by the relay (same-origin cookies); aiboard.me links to it. |
| D13 | Directory listing | Submit to the ChatGPT app directory and Claude connector directory as a post-beta milestone; paid launch does not block on approval. |
| D14 | Test environments | This Windows 10 PC (+ WSL2 Ubuntu) for live tests; GitHub Actions hosted runners (windows/macos/ubuntu) for the cross-OS matrix. Live macOS acceptance is labeled CI-only until a real Mac is available. |
| D15 | Remote tool style | Low-level Desktop Commander-style tools first (files/process/git/jobs/browser); a few Build-level tools (X3) after launch. |
| D16 | 2026-10-15 plan | Superseded except Milestone B (agent mixer, separate future work); its C1 local stdio MCP folds into L1; E1 OpenAI tunnel dropped; P7 charter superseded. |
| D17 | Remote freedom | Desktop Commander-style freedom by default: shell/process tools on, no per-action approval, audit on, one-time notice. Opt-in per device: per-command approval, read-only, cwd-only, shell off; OS sandbox safe mode (S2) later. File-tool denylist stays as a guardrail, never claimed to bind shell commands. |
| D18 | Releases | install.ps1/install.sh and the signed release manifest are served from aiboard.me; the six platform bundles are attached to GitHub Releases of behzad62/aiboard. Signing happens in a manual-dispatch release workflow whose key lives in a protected GitHub `release` environment requiring owner approval; an offline encrypted backup of the key is kept by the owner. |

## 2. Evidence inventory: DO NOT rebuild what already exists

### 1.2 Architect decisions on R0 open questions (2026-10-27)
| Question (source) | Decision |
| --- | --- |
| win-arm64 Windows helper not yet qualified (ADR-E) | Ship win-arm64 labeled preview until the helper is qualified on arm64 hardware/CI; other five targets are GA candidates. |
| Signature verification on minimal Linux (ADR-E) | install.sh requires `openssl` (or LibreSSL on macOS) and fails with an actionable message if absent; no unverified fallback. |
| Storage key where no OS keychain exists (ADR-F) | Linux headless / no Secret Service: 0600 key file in the per-user state dir, disclosed in `aiboard doctor`. |
| cwd contains AIBoard state, e.g. home folder (ADR-D) | Allowed; the state directory is an always-excluded protected subtree (S1). |
| Consent UI when no browser is connected (ADR-A) | Only relevant when a device enables approvals (D17): answer in the `aiboard remote` terminal or the dashboard (signed, job-bound). |
| Windows-MCP release pin, VPS device ceiling, git_commit task context, artifact-to-principal binding | Deferred to X1, R4 measurement, R1/R2 design respectively; tracked as open in the STATUS ledger. |

### 2.1 Primary repo (audited 2026-10-27)
| Capability | Actual implementation | Reuse / genuine gap |
| --- | --- | --- |
| Scoped file read/stat/list | runner-v2/src/filesystem-tools.ts: fs.read, fs.stat, fs.list | REUSE; remote authorization bridge needed |
| Content search | fs.search with bounded continuation cursor | REUSE |
| Create/replace/patch/move/delete | fs.write, fs.patch (atomic multi-edit, revisions), fs.move, fs.delete | REUSE; remote writes need scope, nonce, audit |
| Git | git.status/diff/log/show/remotes/commit and guarded git.push (git-tools.ts) | REUSE, preserve role restrictions |
| Code navigation | code.workspace_symbols/definition/references/diagnostics; repo.manifest/map | REUSE |
| Governed commands | process.run (process-tools.ts); `process.execute` / `process.shell` are its input-dependent access capabilities, not separate tools; owned ExecutionHost. Full-grant execution is explicitly unconfined (execution-isolation-provider.ts:347) | REUSE; remote exposure gated by S1 (see remote-tool-surface.md) |
| Background/interactive process | process.start/poll/list/signal/write_stdin/read_output (managed-process*.ts, output journal/cursors); `process.recovery` is an internal grant binding, not a tool | REUSE; stdin is a pipe, not a PTY; list/signal act only on OWNED processes |
| Input dedup | durable writeId acknowledgement / outcome_unknown journal | REUSE; extend to remote job identity |
| Browser automation | browser.open/navigate/snapshot/click/fill/wheel/drag/screenshot/events/close (Playwright) | REUSE; not desktop GUI |
| Image inspection | image.inspect (PNG/JPEG/WebP) | REUSE |
| Artifacts/evidence | artifact.read ranges, ArtifactStore, `run_evidence_command` (capability `evidence.command`) | REUSE; remote chunking and artifact-to-principal authorization needed |
| MCP extensions | ExtensionManagementService, extension-mcp.ts, mcp-remote.ts, mcp-tools.ts; Settings → Extensions UI | REUSE for the plugin catalog. GAP: only `toolApproval: "non_destructive" \| "all"` exists; no per-tool allow/deny or remote-exposure flag |
| Durable storage | `node:sqlite` stores (event, evidence, budget, permission, process, session) | REUSE pattern; relay uses `node:sqlite` too (no native deps) |
| Identity/fencing | session-authority.ts, tool-broker.ts, execution-grants.ts (has a `"full"` grant), runtime-router.ts | NON-NEGOTIABLE reuse |
| CLI | runner-v2/bin/aiboard-runner-v2.mjs → `tsx` → src/cli.ts; flags `--project --state-dir --token --port --allow-origin --mcp --extensions-home --capabilities-config` | GAP: runs TypeScript via tsx at runtime (needs prebuilt bundle for install); single `--project` root (whole-machine is a new grant profile); no browser auto-open; token is pasted manually |
| Distribution | Runner V2 ZIP from /runner-guide; bench runner ZIP; account runner (lib/account-provider-runner.mjs); legacy scripts/runner.mjs | REPLACE user path with installer; ZIP pipeline may remain the internal payload |
| Single-model Runner Chat | chat-agent-session.ts (`MAX_TURNS_PER_MESSAGE = 40`, restart fails the in-flight reply) | Not part of remote scope (D1) |

No remote tunnel integration exists in live code (every "tunnel" hit is a comment about a "tunnel run").

### 2.2 Tunnel repo: actual v1 transport (verified)
| Implemented | Details / limitation |
| --- | --- |
| Outbound WebSocket connector, HTTP JSON-RPC relay, client SDK | packages/connector, relay, client, shared, e2e; routes /connect and /v1/devices/:id/mcp |
| Device auth | 256-bit tokens, hashed records, scoped client credentials, 10-min one-time pairing codes, revoke |
| Concurrency | correlation IDs, request timeout, ping/pong, capped reconnect; e2e incl. 10 parallel calls |
| Storage | single JSON store; no accounts/billing/durable jobs |
| Local tool hosting | one directly spawned stdio MCP child; NOT Runner-governed |
| Protocol | custom JSON-RPC over HTTP, not standard remote MCP |
| Crash recovery | WebSocket reconnect yes; MCP child restart no |
| Cancel | `cancel` frame drops the pending entry (connector.ts:207); underlying work not cancelled |
| Payload | 4 MiB frames/HTTP (tunnel.ts:29, server.ts:64) vs 8 MiB child stdout line (mcp-stdio.ts:40); no chunking |
| Security | plaintext HTTP default; query-string token fallback (server.ts:522); no Windows/macOS secret store |
| Tests | 181 tests (unit + e2e); not WAN/production qualified |

Reuse the useful relay/client pieces after hardening; replace the stdio-child owner with a Runner-bound dispatcher.

### 2.3 VPS facts (read-only, 2026-10-27)
Ubuntu 26.04 x86_64, 1 vCPU, 1.9 GiB RAM (~840 MiB available), root disk 89% used (5.3 GB free), Nginx active (sites: aiboard.me, funboard.app, voice.funboard.app, pixelmaster-dev, …), Docker active, MySQL on loopback, Node NOT installed, SSH on port 3192. Existing deploy workflows pin host/port/user. Implications: the relay must be lean (target < 256 MiB RSS), never store artifacts/screenshots, and disk cleanup is an owner prerequisite before staging.

### 2.4 Reference products (researched 2026-10-27)
- Desktop Commander Remote: files, terminal/processes, search, edit_block; NO GUI control; Windows/macOS/Linux; free 10k tool calls/month then paid.
- Claude computer use: desktop app on macOS + Windows, CLI macOS only, no Linux; per-session app approval, app tiers (browsers view-only, terminals/IDEs click-only), single-session lock, other apps hidden, Esc kill switch, own terminal excluded from screenshots.
- ChatGPT/Codex desktop computer use: plugin in the desktop app; macOS (background) + Windows (foreground takeover); no Linux.
- Windows-MCP: Python 3.14+/uv, MIT, UI Automation tree + input + screenshots; also ships PowerShell/Registry/Clipboard/FileSystem tools.
- No major vendor exposes desktop GUI through a remote MCP relay; GUI lives in local apps. This supports D11 (plugins, post-launch).

## 3. Architecture and authority
~~~
ChatGPT / Claude / any MCP client        Browser (dashboard)
            \                                   |
             \-- HTTPS: OAuth 2.1 + MCP --------+
                                |
         mcp.aiboard.me  (Nginx TLS -> one Node relay process, Docker)
         {OAuth AS, Google/GitHub login, devices, usage, Paddle webhooks,
          MCP gateway, job index, redacted audit; SQLite}
                                |
           outbound WSS, device key proof-of-possession, epoch fencing
                                |
     `aiboard remote` on the user's PC (Windows/macOS/Linux)
       [connector inside Runner V2 lifecycle]
                                |
       [Runner V2 authority: grants, roots/denylist, broker, journal]
                 /              |               \
         Native tools     Managed MCP plugins   Owned processes / jobs
~~~
- The relay is NEVER an execution authority. It routes after independent account, device, entitlement and consent decisions.
- The local Runner independently REAUTHORIZES every remote request. Remote OAuth scope can never grant more than local policy.
- Trust planes, all must pass: entitlement (paid/free allowance) → client authorization (OAuth token, audience, scope) → device ownership → Runner grant (what, where) → device policy (D17: defaults open; per-action consent only where the user enabled approvals).
- Data stays on the device: repositories, provider credentials, evidence, screenshots. The relay keeps device/session/job indexes, usage counters and redacted audit only. Do not market end-to-end encryption unless separately implemented and audited.
- Device authentication: an Ed25519 device key generated at pairing, stored in the OS secret store, used for proof-of-possession on every WSS handshake. (Supersedes the earlier "mTLS" wording.)
- The aiboard.me site stays a Next static export. Relay, auth, dashboard and webhooks live only at mcp.aiboard.me. Never embed payment or token-minting secrets in browser JS.

## 4. Shared contracts BEFORE features
Versioned transport envelope: {protocolVersion, requestId, accountId, clientId, deviceId, deviceEpoch, toolId, operationClass, scopeRef, issuedAt, expiresAt, nonce, idempotencyKey, payloadDigest, traceId}. Claims are untrusted until verified; every hop authenticates; permissions never come from free-text model arguments. Response: {requestId, admitted, jobId?, status, outputRef?, errorCode?, uncertainty?, traceId}. Typed unsupported/version errors.

Job status machine: queued → awaiting_device | awaiting_approval | running → completed | failed | cancelled | outcome_unknown | blocked_policy | blocked_quota. A timed-out HTTP request never implies a failed job. Same idempotency key + principal + payload digest = ONE admitted operation; changed content = conflict; ambiguous side effects = outcome_unknown, never automatic destructive replay. Idempotency is committed in the local Runner before dispatch, not in relay memory. Monotonic event sequences with cursor-based polling.

Cancellation: report cancel_requested, stopped and effect_outcome_unknown separately. Revocation blocks new calls immediately; admitted effects reconcile by explicit policy.

Security baseline: canonical paths with junction/symlink/ADS protection on every OS, whole-machine denylist (§5 S1), command policy, device owner lock, concurrency quotas, no SSRF to private networks, origin/CSRF checks, short-lived pairing, no long-lived secrets in argv, URLs or logs.

## 5. Packet plan

### Phase 0 — Baseline
**R0 — Audit, ADRs, contracts** (no code changes)
- Reconcile this plan against HEAD of both repos.
- Machine-readable catalog of actual Runner tool schemas (readOnly/effect/permission per tool) and the proposed remote MCP tool surface (see P2). Decide which of process.run/execute/shell are remote-exposed.
- ADRs: (A) connector inside Runner lifecycle + tunnel package boundary; (B) relay/account/billing/dashboard package layout in aiboard-tunnel; (C) job/lease/cancellation model; (D) whole-machine grant profile + denylist on top of execution-grants' `"full"` grant; (E) CLI packaging: prebuilt JS bundle (no runtime tsx) + bundled official Node 24 per platform; reuse/extend scripts/build-runner.mjs and runner-v2-package-hashes.mjs; (F) browser handoff via URL fragment; (G) per-tool extension filters + remote-exposure flag.
- Envelope/job/event JSON schema fixtures. Baseline commands and known failures in the ledger. No paid calls, no broad suites.
- **DoD:** catalog, ADRs, fixtures and ledger approved by an independent reviewer.

### Phase 1 — One-line install and unified local CLI (free; ships independently of the relay)
**L1 — `aiboard` CLI** (R0)
- Single entry with runner selection per D8; default Runner V2 with `--project` = current working directory and state under the per-user AIBoard data dir.
- Binds 127.0.0.1 and opens `https://aiboard.me/connect#pair=<one-time code>&runners=<port list>` with the OS opener (`start` / `open` / `xdg-open`; prints code + ports for manual paste when no opener exists). Per ADR-F the code is single-use, ≤ 120 s, instance-bound, and exchanged by the page via POST to 127.0.0.1 with strict Origin/Host checks for a browser-session credential; the page strips the fragment with `history.replaceState`. No reusable bearer token ever appears in a URL, argv or log.
- Stable per-user+project identity and a protected storage key separate from session credentials (today both encrypted stores are keyed by the control token: cli.ts:168/175), with a journaled migration of existing provider/extension credentials (ADR-E/ADR-F). Instance reuse per project, `aiboard status`, `aiboard stop`, headless `--no-open`.
- Local stdio MCP (`aiboard mcp serve --stdio`, adopted from the 2026-10-15 plan's C1): local Codex/Claude CLIs can call the same tool surface as P2, through the same Runner authority; recursion/ancestry limits apply.
- One browser tab connects to every runner started in that invocation. Remote mode never exposes account/legacy/bench runners (D9).
- `aiboard --help`, `aiboard version`, `aiboard doctor` (ports, Node, Playwright browsers, secret store, relay reachability).
- **DoD:** on all three OSes (CI): start in a temp folder → page receives the fragment → Runner V2 project root equals cwd; combined start connects both runners; token absent from process list/argv of children, logs and history; existing developer flags keep working.

**L2 — Installers and updates** (L1)
- `install.ps1` (Windows PowerShell 5.1+ and pwsh) and `install.sh` (macOS/Linux, POSIX sh), served from aiboard.me static export.
- Per-user install (`%LOCALAPPDATA%\AIBoard`, `~/.aiboard` or XDG equivalent), adds `aiboard` to the user PATH, no admin/sudo.
- Downloads a versioned bundle for the detected OS/arch (win/darwin/linux × x64/arm64) containing prebuilt Runner + official Node 24; verifies SHA-256 against a signed release manifest before activating; atomic switch with rollback to the previous version.
- `aiboard update`, `aiboard uninstall` (keeps or removes state on prompt), offline-friendly error messages. The installer script stays short and readable (it is piped to a shell).
- Runner guide page switches from ZIP download to the one-liners; ZIP links remain only for legacy users.
- **DoD:** CI matrix installs as a standard user on windows/macos/ubuntu runners, runs `aiboard doctor` and a smoke start, updates, rolls back and uninstalls; checksum tamper test fails closed; no secrets in installer output.

### Phase 2 — Runner-bound remote transport
**R1 — Connector inside Runner V2** (R0)
- `aiboard remote` starts Runner V2 plus a connector in the Runner's lifecycle graph. The connector obtains Runner-issued grants and dispatches only through ToolBroker / Extension Management. No direct stdio MCP spawn, no generic execute escape hatch.
- Connection states: disconnected, authenticating, connected-degraded, tool-ready, suspended, revoked. Heartbeat alone is not tool-ready. On startup reconcile transport and effects before advertising readiness; failures fail closed.
- Terminal UX like Desktop Commander: first run opens browser login and pairing; later runs restore the saved device session; prints device name, account, version and "return to ChatGPT/Claude; keep this running; Ctrl+C to disconnect"; `aiboard remote --logout`.
- **DoD:** fake relay → Runner bridge → fs.read, owned process read and an installed MCP plugin tool pass; wrong scope denied before dispatch; MCP crash recovers or reports degraded; no orphan processes after Ctrl+C; on all three OSes in CI.

**S1 — Whole-machine remote scope** (R1)
- Remote grant profile per D9: any path the OS user can access, cwd as default working directory, Runner role restrictions intact.
- Always-denied paths (not overridable remotely): AIBoard's own state/token/device-key store, OS credential stores, `~/.ssh`, browser profile directories, cloud CLI credential files, the installer's bin directory. Canonicalization defeats symlinks/junctions/8.3 names/ADS/case tricks per OS.
- The denylist is enforced for Runner file tools (fs.*, artifact/image reads, listings). It is NOT claimed to stop shell/process commands, which run as the OS user (D17); the one-time notice and dashboard say so plainly.
- Remote device policy (D17), stored locally and shown in the dashboard: defaults = shell/process ON, no per-action approval, audit ON. Opt-in controls: per-command approval, read-only mode, `--only-here` (cwd only), shell OFF. Narrowing can be requested from the dashboard; only the local user can broaden it again. Approvals, when enabled, are answerable in the `aiboard remote` terminal and in the dashboard (account-authenticated, signed approval bound to the job).
- First `aiboard remote` run shows a one-time notice: agents can run commands as you and read anything you can; how to restrict; how to disconnect/revoke.
- cwd may contain AIBoard's per-user state (e.g. running in the home folder): the state directory becomes an always-excluded protected subtree instead of a startup refusal (ADR-D open question, architect decision).
- **DoD:** traversal suite per OS (symlink, junction, `..`, UNC, case, 8.3, ADS) cannot reach denied paths through file tools; denied attempts audited; cwd default verified; each opt-in control (approval, read-only, only-here, shell off) blocks the right tools locally and remotely; home-folder start works with state excluded.

**R2 — Durable jobs, idempotency, cancellation, flow control** (R1)
- Record-before-dispatch idempotency in Runner SQLite, monotonic event journal, device/connection epoch fencing, explicit outcome_unknown.
- Limits: in-flight remote ops, per-device calls, queue depth, deadlines, fair scheduling. HTTP disconnect cancels only the HTTP wait unless the user/agent explicitly cancels the job.
- Cancellation via AbortSignal, MCP cancellation notifications, Runner process control; uncertain until observed.
- No automatic retry of side-effecting calls across reconnect; safe reads may replay behind freshness/grant checks.
- Job tools: start/status/events/result/cancel with cursors and result TTL. Jobs persist when the cloud chat disconnects and stop truthfully when the PC sleeps or shuts down (reported as awaiting_device / outcome_unknown on return).
- **DoD:** 100 same-key requests → one execution; dropped response after dispatch → one authoritative job; conflicting key rejected; relay and Runner restart → no duplicate effects; cancelling a blocked tool reports true status; PC sleep/resume simulation reports truthfully.

**R3 — Large outputs and artifacts** (R1; R2 for job refs)
- One negotiated frame maximum; small control frames; chunked binary data plane (chunk ID, offset/length, SHA-256, resume, ACK, backpressure). Fixes the 4 MiB / 8 MiB mismatch.
- Artifacts are content-addressed and streamed through the relay without being stored (VPS disk/RAM limits). Per-account transfer quotas.
- Truthful gap/partial results; bounded screenshot/media handling; no image payloads in logs or audit.
- **DoD:** 100 MiB artifact survives disconnect/resume byte-exact; relay RSS stays bounded under a slow receiver; oversized frames rejected without killing healthy sessions; quota exceeded is explicit.

**R4 — Transport hardening for a single VPS** (R1–R3)
- HTTPS/WSS only off loopback; remove the query-token fallback; validate host/origin; bounded ping/pong, leases, fencing epochs.
- Replace the JSON store with `node:sqlite` + migrations, backup (nightly copy off-box as owner decides) and restore drill. Single relay; no shared routing/HA.
- Liveness vs readiness endpoints; per-account/device rate limits; structured redacted logs; credential rotate/revoke without losing unrelated jobs.
- Device secrets in Windows DPAPI/Credential Manager, macOS Keychain, Linux libsecret with a 0600-file fallback.
- Pinned dependencies, signed release manifest for connector updates, operator emergency revoke/disable, least-privileged container user, restart on reboot.
- **DoD:** cross-account denial, replay/race, token leakage, origin, SQLite atomicity, failed migration rollback, 24 h soak with network flaps and relay restarts on a staging vhost, resource-starvation and update-tamper tests pass.

### Phase 3 — Accounts, MCP gateway, billing, dashboard (aiboard-tunnel)
**P1 — Identity, devices, pairing** (R1; can overlap R2)
- Google (openid profile email) and GitHub login using FunBoard's server-redirect pattern (D:\repos\FunBoard lib/server/oauth-*.ts, `jose` ID-token validation incl. issuer/audience/nonce). Separate local and production OAuth clients. Google app must be published (brand verification) before more than 100 users; GitHub has no such cap.
- Entities: Account, Identity, Device, DeviceKey, PairingAttempt, OAuthClient, OAuthGrant, Session, JobIndex, UsageCounter, Audit.
- Pairing: `aiboard remote` shows a short code + opens the browser; the signed-in user confirms the device name; device public key bound. Rename without re-keying; transfer requires revoke + re-pair.
- **DoD:** two accounts in separate browsers cannot enumerate or call each other's devices even with guessed IDs; revoke while connected takes effect immediately.

**P2 — Standards MCP gateway + OAuth authorization server** (P1, R2)
- Streamable HTTP MCP at `https://mcp.aiboard.me/mcp` using the official MCP TypeScript SDK, including its auth helpers: protected-resource and authorization-server metadata, dynamic client registration, authorization code + PKCE, consent screen ("Allow <client> to use your devices"), refresh tokens, revocation, audience/scope checks.
- Tool surface (owner decision D15: low-level first): the 25 fixed tools in docs/remote/r0/remote-tool-surface.md — devices_list; files_read/list/search/write/patch/move/delete; process_start/run/read_output/write_stdin/signal/list; git_status/diff/log/commit; jobs_status/events/result/cancel; artifact_read; image_inspect; browser — plus remote-enabled plugin tools named `plugin_<server>_<tool>_<digest8>`. `deviceId` is optional when exactly one device is online. Truthful readOnly/destructive/idempotent/openWorld annotations. Gating from R0: process tools need S1's process policy; git_commit needs a governed task context; artifact/image-by-hash need artifact-to-principal authorization. Build-level tools follow post-launch (X3).
- Long actions return a jobId quickly; MCP sessions are not job ownership.
- **DoD:** MCP inspector/conformance; ChatGPT custom connector and Claude custom connector both connect, list tools, read, perform a user-approved write, survive host disconnect and recover by jobId; unknown method/version and missing auth refused; nothing works after token revocation or device revoke.

**P3 — Usage metering and Paddle billing** (P1, P2)
- Metering per D6: every `tools/call` that reaches admission is one tool call (initialize/list/ping are free); monthly calendar reset (UTC); dedupe by requestId; counters per account and device.
- Plans as configuration: Free (10,000 calls/month) and Pro ($20/month, limit configurable). At the limit: typed MCP error with upgrade link; warning event at 80%.
- Paddle hosted checkout + customer portal; signed webhook verification, idempotent processing, out-of-order handling, price-ID allowlist; browser redirect never grants entitlement. Cancellation/downgrade applies at period end; refunds/chargebacks revoke per policy without destroying local work.
- Entitlement is checked at relay admission; the local Runner trusts only short-lived signed entitlement claims (offline cache expires).
- **DoD:** duplicate/out-of-order/replayed webhooks → single transition; two-tenant isolation; limit hit blocks the next call with the right error; Paddle sandbox end-to-end; reconciliation export. No live payments until owner confirms terms/privacy/refund policy.

**P4 — Dashboard at mcp.aiboard.me** (P1–P3)
- Pages: Devices (online / tool-ready / degraded, version, last seen, revoke, revoke all, allowed scope), Usage (calls this month vs limit, reset date, per device), Plan & billing (Paddle portal), Settings (connected MCP clients with revoke, plugin remote exposure, data/delete account), and "Where you use it" (ChatGPT, Claude, any MCP client endpoint with copyable URL and setup steps).
- "Online" never means just "socket open"; offline/asleep devices are labeled so.
- Accessible, works at phone width, links back to aiboard.me; aiboard.me header links to it.
- **DoD:** Playwright flows for login, pairing, revoke, usage display, upgrade (sandbox), client revoke; no tokens in URLs or logs.

### Phase 4 — Launch
**Q1 — Security qualification** (R4, S1, P2, P3)
- Threat model: cross-tenant leak, stolen/expired token, OAuth audience confusion, DCR abuse, path traversal per OS, malicious plugin descriptors, prompt injection via files/tools/web, model-generated "approve" text, webhook forgery, fake payment redirect, relay compromise blast radius.
- Negative tests at every hop. License/provenance check of bundled Node, dependencies and any plugin defaults. Privacy policy and retention for the relay.
- **DoD:** independent reviewer signs off the matrix with executed evidence; unsupported conditions fail closed.

**Q2 — Reliability qualification** (R4, R2, L2)
- This PC + WSL2 live; CI matrix for macOS/Linux/Windows. Sleep/wake, network flap, relay restart, VPS reboot, Runner crash, plugin crash, lost ACK after side effect, corrupt chunk, oversized frame, 100 MiB transfer, many idle devices.
- Memory/CPU on the 1 vCPU VPS measured with realistic idle device counts; documented capacity ceiling before opening beta.
- SLOs are proposals for owner approval, never advertised before measured.
- **DoD:** measured report with commands, revisions, failures, soak traces and resource graphs.

**Q3 — Staged launch** (gates listed per stage)
- Stage 0 — owner dogfood (after L1, R1, S1, R2, P1, P2): owner's own device, staging vhost, no billing, Paddle sandbox only.
- Stage 1 — closed beta (after R3, R4, P4, Q1 in progress): invited users, free entitlement, custom-connector URL setup, metering on.
- Stage 2 — paid launch (after P3 live config, Q1, Q2): Paddle live, published pricing/terms/privacy/refunds. Directory submissions (D13) prepared during Stage 1 and submitted after beta; approval does not block Stage 2.
- Rollback by feature flag/entitlement without deleting jobs; users can export audit and revoke devices. No DNS, Paddle live mode, deploy or push without fresh owner approval.

### Post-launch
**X1 — Plugin catalog incl. desktop GUI control** (R1, P4; after Stage 2)
- Curated, per-OS catalog in Settings → Extensions (and dashboard): one-click enable/disable using existing Extension Management (pinned package versions/digests, trust policy, supervised restart). Candidates: Windows-MCP (Windows), Playwright MCP / Playwright browser (all), vetted macOS and Linux X11 GUI servers. Models use plugins only when enabled.
- Add per-tool allow/deny to extension contracts (gap from §2.1). Catalog entries ship safe defaults, e.g. Windows-MCP: GUI tools on; PowerShell, Registry, Clipboard, FileSystem, Process off (they bypass Runner tools).
- Per-plugin "available remotely" switch (default off for GUI plugins) and risk label; remote GUI calls require a visible local indicator and one GUI session lock. Borrow Claude's safeguards where the plugin allows (per-app approval, Esc/kill switch).
- Never auto-install because a model suggested it.
- **DoD:** enable/disable round-trip on each OS in CI where the plugin supports it; denied tools invisible locally and remotely; remote exposure off → tool absent from MCP listing.

**S2 — Optional OS sandbox "safe mode"** (S1; post-launch): per-OS enforcement for process tools so the denylist and `--only-here` also bind commands and their descendants (Windows restricted token/AppContainer-style, macOS Seatbelt, Linux bubblewrap/Landlock; evaluate Apache-2.0 Codex sandbox code before writing new). Opt-in device setting; may become the default later only by owner decision. Unsupported platforms say so and keep D17 defaults.

**X3 — Build-level remote tools** (P2, R2; owner decision D15): a few AIBoard-semantic tools (e.g. build_start, build_status, build_evidence) so a cloud agent can hand a whole Build to the local Runner, which then runs with the user's configured providers; the cloud agent remains the user-facing brain.

**X2 — Optional extras** (each its own gated packet): document plugins (PDF/DOCX/XLSX) via the same catalog; PTY adapter (never label the stdin pipe a PTY); global host process listing/kill behind explicit approval with PID + start-time identity.

## 6. Dependency map and team division
~~~
R0 ──┬─> L1 ──> L2 ───────────────────────────────┐
     │                                            │
     └─> R1 ──┬─> S1 ─────────────┐               │
              ├─> R2 ──┬─> R3 ──> R4 ──────────┐  │
              │        │                      │  │
              └─> P1 ──┴─> P2 ──> P3 ──> P4   │  │
                                   │     │    │  │
                         Q1 <── R4,S1,P2,P3   │  │
                         Q2 <── R4,R2,L2 <────┴──┘
                                   │
                    Q3: Stage 0 <── L1,R1,S1,R2,P1,P2
                        Stage 1 <── R3,R4,P4,(Q1)
                        Stage 2 <── P3,Q1,Q2
                                   │
                        X1, X2 (post-launch)
~~~
Suggested non-overlapping agents/worktrees:
- Agent Local: L1, L2 (ai-discussion-board; CLI, packaging, installers, connect page).
- Agent Core: R0, R1, S1, R2 (Runner authority binding, contracts).
- Agent Relay: R3, R4 (aiboard-tunnel transport, VPS deployment workflow).
- Agent Cloud: P1–P4 (aiboard-tunnel identity, MCP gateway, billing, dashboard).
- Independent Reviewer/Verifier per packet; Q1/Q2 integrated evidence.

Rules: R2 schemas merged before P2. Avoid overlapping edits to runner-v2/src/cli.ts, control-server.ts, native-build-factory.ts and role-capabilities.ts; L1 and R1 both touch cli.ts, so stack small interface PRs with one integration owner.

## 7. Deployment on the aiboard.me VPS (R4/Q3)
- Owner prerequisites (status 2026-10-27): VPS disk freed — DONE (root 37% used, 30 GB free; ~858 MiB RAM available). Google + GitHub OAuth apps — CREATED by owner. Paddle sandbox account — CREATED by owner. Cloudflare `mcp` DNS record — PENDING, needed only before Stage 0 staging deploy.
- OAuth callback paths: production `https://mcp.aiboard.me/auth/google/callback` and `/auth/github/callback`; local development `http://localhost:8788/auth/{google,github}/callback`. GitHub OAuth apps allow one callback each, so local and production use separate GitHub apps (FunBoard pattern). Client secrets and Paddle keys live only in the VPS env file and an untracked local `.env`, never in chat, the repo or images.
- Relay runs as one Docker container (Node 24, non-root, memory limit ~256–384 MiB) with the SQLite DB on a named volume; no Node install on the host.
- Nginx vhost `mcp.aiboard.me` (and a separate staging vhost) with Certbot, HTTP→HTTPS, WebSocket upgrade, request size limits; DNS A record added by the owner.
- DNS: Cloudflare, `mcp` A record → 178.79.134.104, proxied (orange cloud), matching aiboard.me. Consequences the relay must handle:
  - Cloudflare SSL mode Full (strict) with a valid origin certificate (Certbot or Cloudflare origin cert).
  - WAF/Bot Fight Mode must not challenge server-to-server traffic: add a skip rule for `mcp.aiboard.me` paths `/mcp`, `/.well-known/*`, OAuth endpoints, `/connect` (device WSS) and the Paddle webhook path, or ChatGPT/Claude/Paddle requests get blocked by challenges.
  - Cache bypass rule for the whole host (dashboard and API responses are per-user).
  - Proxied HTTP responses time out after ~100 s without bytes: Streamable HTTP streams send keepalives well under that, and long tool calls return a jobId (R2) instead of holding the request.
  - Proxied WebSockets can be dropped during Cloudflare maintenance: connector reconnect + epoch fencing (R1/R4) treat this as normal.
  - Request bodies are capped (100 MB on Free): R3 chunks stay far below it.
  - Rate limits and audit use the real client IP from `CF-Connecting-IP`, trusted only from Cloudflare's published IP ranges (Nginx `real_ip`); the origin firewall should accept 80/443 only from Cloudflare ranges once stable.
- Secrets (Google/GitHub client secrets, OAuth signing keys, Paddle API key + webhook secret) in a root-owned 0600 env file, never in the repo or image.
- GitHub Actions workflow in aiboard-tunnel: manual dispatch only, pinned host/port/user check (as the FunBoard workflows do), image digest verification, health check, automatic rollback to the previous image. Never triggered by push.

## 8. Acceptance matrix
| ID | Target / failure injection | Pass criterion |
| --- | --- | --- |
| T01 | Tool catalog and remote route | fs.patch, process.write_stdin, image.inspect, browser.screenshot served from the same Runner definitions with unchanged role restrictions |
| T02 | Wrong account/device | 401/403, no local tool start, audit identities correct |
| T03 | Lost reply after mutating command | exactly one effect; result recoverable by jobId or explicit outcome_unknown |
| T04 | Remote timeout/disconnect | no implicit cancellation; truthful job state; no replay |
| T05 | Plugin/MCP crash | degraded readiness, supervised restart, no phantom ready |
| T06 | Relay restart/device reconnect | epoch fencing, no ghost responses or duplicate effects |
| T07 | PC sleep/shutdown mid-job | job reported awaiting_device/outcome_unknown truthfully on return; no silent replay |
| T08 | Whole-machine denylist | Through Runner file tools, AIBoard secrets, ~/.ssh, credential stores and browser profiles are unreachable via any path trick on each OS; shell commands are out of scope by D17 (S2 covers them) and the notice says so |
| T09 | Interactive process | writeId exactly once, EOF distinct from signal, gaps reported truthfully |
| T10 | 100 MiB artifact over weak network | resume + SHA-256 verify, bounded relay memory, no frame crash |
| T11 | One-line install on each OS | standard user, checksum verified, update/rollback/uninstall, PATH correct |
| T12 | CLI browser handoff | only a single-use ≤120 s pairing code appears in the fragment; replayed/expired/wrong-Origin exchange refused; no reusable token in any URL, argv, log or Referer; saved provider keys still decrypt after restart |
| T13 | Remote runner exposure | account/legacy/bench runners never reachable through the relay |
| T14 | OAuth/DCR | PKCE enforced, audience checked, revoked client loses access immediately |
| T15 | Paddle webhooks duplicate/out-of-order/forged | single transition, signature required, redirect grants nothing |
| T16 | Free limit reached | call 10,001 refused with typed error + upgrade link; counter accurate after restarts |
| T17 | ChatGPT + Claude custom connectors | connect, read, approved write, disconnect + recover by jobId |
| T18 | Confidentiality | no tokens/screenshots/file contents in relay logs or audit |
| T19 | Plugin remote exposure (X1) | disabled/denied tools absent locally and remotely |
| T20 | Runner regressions | existing isolation, cleanup, grants, reviewer independence and Build completion remain valid |

## 9. Non-goals and explicit tradeoffs
- No AIBoard-owned model loop for remote sessions, no account-backed providers in remote mode, no "continue" automation in third-party chat UIs, no circumvention of ChatGPT/Claude plan limits.
- No work while the PC is off or asleep; no cloud execution of user code.
- No built-in desktop GUI engine; GUI only through vetted plugins after launch. No UAC/lock-screen bypass, keylogging or password capture.
- No exactly-once guarantee for arbitrary external effects; exactly-once admission plus truthful uncertainty instead.
- No HA relay, no multi-region, no SLA claims until measured and approved.
- No storage of user files, artifacts or screenshots on the relay.
- Exact Pro limit, refund terms, tax handling details (Paddle as merchant of record), privacy policy text and support policy are owner/legal decisions before Stage 2.

## 10. Acceptance process and documentation
Every packet produces an implementer summary: requirement IDs, edited paths, security implications, test commands and observed results, commit hash, protocol changes, known limitations, owner decisions needed, next packet. "Verified" is reserved for executed tests against a declared revision/environment.

Ledger: docs/plans/2026-10-27-aiboard-remote-STATUS.md, created by R0 with every packet NOT STARTED and this audit as DOCUMENTED ONLY. States: NOT STARTED / ACTIVE / BLOCKED / REVIEWED / ACCEPTED.

Command families (confirm exact names at execution time):
- AIBoard: targeted `npx tsx --test runner-v2/test/<selected>.test.ts`; `npm run typecheck:runner-v2`; `npm run lint`; full Runner suite only at deliberate gates. Never run `npm run build` while the dev server is up.
- Tunnel: `npm ci`, `npm run build`, `npm test`; new e2e for Runner bridge, scopes, crash recovery, idempotency, chunking, OAuth and billing webhooks.
- Cross-OS: GitHub Actions matrix (windows-latest, macos-latest, ubuntu-latest) for installer/CLI/connector; WSL2 Ubuntu locally.
- Live: this PC → staging vhost on the VPS → ChatGPT/Claude custom connectors, with owner approval for each deployment.

Security review cannot be waived for: Runner process creation or grant changes, whole-machine scope, plugin tool exposure, OAuth/token handling, billing/entitlements, secret storage, installer/update integrity and state migrations.

## 11. First packet to hand to a coding agent
Start R0 and STOP after its reviewable deliverables:
1. Read the documents in §0.
2. Inspect Runner tool broker, role allowlists, execution-grants (`"full"`), Extension Management contracts, cli.ts startup, packaging scripts (scripts/build-runner.mjs, runner-v2-package-hashes.mjs), and the tunnel's relay/connector/auth/stores/tests. Reproduce the baseline with permitted deterministic tests.
3. Produce the tool catalog, the remote MCP tool surface proposal, and ADRs A–G (§5 R0).
4. Specify envelope/job/event schemas with fixtures, including cancellation uncertainty and grant flow.
5. Create the STATUS ledger anchored to inspected revisions. Commit docs/contracts only in a separate worktree after independent review. No production mutation, paid calls or broad suites.
6. Hand off L1 and R1 entrypoints, commands, a minimal fake-relay scenario and mandatory negative checks.

> Implement packet R0 of D:\repos\ai-discussion-board\docs\plans\2026-10-27-aiboard-remote.md. Review both repositories and the required docs. Produce the tool catalog, remote tool surface proposal, ADRs A–G, versioned contracts with fixtures, the STATUS ledger and deterministic baseline evidence only. Preserve main and other worktrees; do not deploy, push, use paid models or run broad gates. Get independent review and return the exact commit and the L1/R1 handoff.

## 12. References
- D:\repos\ai-discussion-board\AGENTS.md, CLAUDE.md
- D:\repos\ai-discussion-board\docs\runner-v2\architecture.md, security.md, guide.md, extensions.md, task-12-status.md
- D:\repos\ai-discussion-board\docs\plans\2026-10-26-native-tools-and-extension-management.md (+ -status.md)
- D:\repos\ai-discussion-board\docs\plans\aiboard-unified-cloud-desktop-agent-platform-2026-10-15.md
- D:\repos\ai-discussion-board\runner-v2\bin\aiboard-runner-v2.mjs, runner-v2\src\cli.ts, control-server.ts
- D:\repos\ai-discussion-board\runner-v2\src\filesystem-tools.ts, process-tools.ts, managed-process-tools.ts, managed-process.ts, git-tools.ts, browser-tools.ts
- D:\repos\ai-discussion-board\runner-v2\src\session-authority.ts, tool-broker.ts, execution-grants.ts, runtime-router.ts, role-capabilities.ts
- D:\repos\ai-discussion-board\runner-v2\src\extension-management-service.ts, extension-management-contracts.ts, extension-mcp.ts, mcp-remote.ts, mcp-tools.ts
- D:\repos\ai-discussion-board\scripts\build-runner.mjs, runner-v2-package-hashes.mjs, bench-runner.mjs, runner.mjs; lib\account-provider-runner.mjs
- D:\repos\ai-discussion-board\.github\workflows\deploy-aiboard.yml, funboard-*-vps.yml (host pinning pattern)
- D:\repos\FunBoard\lib\server\oauth-google.ts, oauth-providers.ts, docs\operations\oauth-operations.md
- D:\repos\aiboard-tunnel\README.md, AGENTS.md, packages\connector\src\connector.ts, tunnel.ts, mcp-stdio.ts, packages\relay\src\server.ts, registry.ts
- External: Desktop Commander README (github.com/wonderwhy-er/DesktopCommanderMCP); Claude Code computer use docs (code.claude.com/docs/en/computer-use); Windows-MCP (github.com/CursorTouch/Windows-MCP); WorkOS pricing (considered, not chosen).

This plan supersedes Milestones A, C2, D and E of the 2026-10-15 unified plan and the P7 charter (D16); Milestone B remains there. An earlier plan's proposal or status is not proof that a later packet was built.
