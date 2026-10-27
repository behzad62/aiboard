# AI Board Paid Remote Device Tools & Autonomous Jobs — Implementation Plan
Date: 2026-10-27
Status: PROPOSED, AUDIT-GROUNDED; implementation, paid-provider calls, deployment, purchase processing, and push are NOT authorized by this document.
Primary repository: D:\repos\ai-discussion-board (inspected clean at b4ed26bd, 2026-10-27).
Existing transport prototype: D:\repos\aiboard-tunnel (inspected clean at 69dc065, 2026-10-27).
Owners: AIBoard product/Runner V2/local desktop agent/hosted relay & identity.
Audience: independent implementation agents, Architect, Reviewer and Verifier.

## 0. Agent execution instructions and source precedence
1. Read this entire file, the current AGENTS.md in BOTH repositories, docs/runner-v2/architecture.md, docs/runner-v2/security.md, docs/runner-v2/guide.md, docs/plans/2026-10-26-native-tools-and-extension-management-status.md, and docs/plans/aiboard-unified-cloud-desktop-agent-platform-2026-10-15.md. Read docs/runner-v2/task-12-bounded-gates.md if touching Task 12/P6 acceptance.
2. Recheck checkout, branches, uncommitted changes, published artifact, current code and test coverage before executing packets. This snapshot is not a future-state certification. Current verified behavior wins over stale plan descriptions.
3. Preserve AIBoard's Runner V2 as the ONLY execution/grant/recovery authority. Never create a second ungoverned remote shell, direct file writer, GUI-control server or process host. AIBoard Tunnel is transport/prototype, not a reason to fork the tool engine. Comply with the audited subprocess boundary and fail-closed isolation rules.
4. Use separate, named worktrees/branches per coherent independently reviewable packet. Respect other agents' worktrees and uncommitted work. A docs-only commit of this file may be needed before a new worktree can see it; do not assume untracked docs appear across worktrees. Do not modify main or production as a side effect of reading this spec. No push/deploy without explicit owner approval: pushing main can trigger aiboard.me deployment.
5. Implement vertical slices in dependency order. Every packet: grounded baseline + ADR as needed -> contracts/safety -> code -> focused deterministic tests -> typecheck/lint -> independent review -> update implementation ledger with commit and command evidence. Broader Runner matrix only at planned gates.
6. Model/tool/provider limits are real: never defeat vendor rate limits, plan quotas, CAPTCHA, login, secure desktops, or billing checks through automation. Continue by using AIBoard-owned durable work and authorized alternate providers only, not by spoofing user messages in someone else's chat UI.
7. Do not confuse tests passing with production readiness. Separate: implemented; deterministic test passed; live end-to-end; deployed; production-qualified. No unsupported security or reliability claims.

## 1. Product direction, explicit decisions
The paid offering is **AIBoard Remote Device & Autonomous Work**. A user can securely pair a Windows computer to an AIBoard account, access its authorized tools from the AIBoard UI or supported third-party MCP clients, and let work continue on the machine when the remote chat/browser disconnects or an individual model session ends. No inbound port on the desktop. The local Runner is the authority; the hosted service brokers and meters access without needing source code or provider credentials.

The service has THREE separate product surfaces:
- **AIBoard remote control**: owned Build/job/task status, pause/resume, evidence, approvals, tools, constrained file/process operations, and optional Windows desktop interaction.
- **Standards-based remote MCP**: supported external agents can discover/call approved tools; long-running work immediately returns a durable job ID and is polled/subscribed. Never assume a ChatGPT/Claude user's plan enables custom MCP write actions.
- **Autonomous Work**: a durable, server-side orchestrator advances AIBoard-owned task plans through bounded model invocations, checkpoints, verification and safe resumptions, independent of client chat session lifetime. Provider limitations cause explicit pause or authorized failover.

The core is not a generic remote desktop/video/RDP implementation. Default workspace mode is project-scoped. Optional whole-desktop control is a separately permitted HIGH-RISK paid capability.

Design decisions: retain current Next.js static-export browser app; paid account/auth/billing/relay APIs run as a separate HTTPS backend. Existing Runner-local mode stays functional without subscription; paid entitlements guard remote service benefits, not local open-source/source-available capabilities retroactively. Provider API/model usage is billed by the user's configured provider unless a future separate prepaid model-credit product is deliberately introduced. Remote tunnel seat/device/usage billing is NOT a model token budget.

## 2. Evidence inventory: DO NOT rebuild what already exists

### 2.1 Primary repo: code audit on 2026-10-27
| Capability | Actual AIBoard implementation | Reuse / genuine gap |
| --- | --- | --- |
| Safe scoped text file reads, stat, listing | runner-v2/src/filesystem-tools.ts: fs.read, fs.stat, fs.list | REUSE; implement remote authorization bridge; evaluate binary/batch convenience |
| Content search | fs.search with bounded continuation cursor, glob/context options; 2026-10-26 status doc | REUSE; no second search daemon |
| Create/replace/patch/move/delete | fs.write, fs.patch (atomic multi-edit, revisions), fs.move, fs.delete | REUSE; remote writes need exact scope, nonce, consent, audit |
| Git | git.status, diff, log, show, remotes, commit and guarded push in git-tools.ts | REUSE, preserve worktree/role restrictions |
| Code navigation | code.workspace_symbols, definition, references, diagnostics; repo.manifest/map | REUSE, language dependent |
| One-shot governed commands | process.run in process-tools.ts, owned ExecutionHost | REUSE, no raw ambient OS execution |
| Background/interactive process | process.start/poll/list/signal/write_stdin/read_output; managed-process.ts and output journal/cursors | REUSE; stdin is pipe, not true PTY; list/signal only OWNED processes |
| Process input deduplication | durable writeId acknowledgement/outcome_unknown journal; 2026-10-26 status | REUSE; extend to remote job identity, don't blindly replay uncertain commands |
| Browser automation | browser.open/navigate/snapshot/click/fill/wheel/drag/screenshot/events/close via Playwright | REUSE for browser; does NOT equal native Windows desktop automation |
| Image inspection | image.inspect (PNG/JPEG/WebP) with bounded artifact + provider visual continuation | REUSE |
| Artifact/evidence | artifact.read range, streaming bounded process output, evidence tools | REUSE; remote binary chunking needed |
| MCP client integrations | managed local stdio, remote Streamable HTTP, skills/plugin/install UI; extension-management-service.ts, mcp-remote.ts, mcp-tools.ts | REUSE, do not build another local MCP installer; INBOUND remote MCP endpoint still needed |
| Chat tools | chat-agent-session.ts single-model Runner Chat with dynamic MCP generation | REUSE for simple chat; restart currently fails in-flight turn, no autonomous continuation |
| Durable Build | NativeBuildManager.recover(), supervised run pause/resume, agent-session checkpoints, event/usage/budget ledgers | REUSE as autonomous job foundation; add remote ingress/jobs/identity |
| Identity, execution fencing | session-authority, tool-broker, execution-grants, runtime-router, strict provider checks; docs/runner-v2/security.md | NON-NEGOTIABLE reuse. Full/native is NOT isolation |
| Benchmark coverage | ToolBench, Runner targeted tests, process/browser negative controls; docs/plans/2026-10-26-native-tools-and-extension-management-status.md | Extend capability/failure tests, don't duplicate many equivalent benchmarks |

The repository currently exposes no completed remote AIBoard Tunnel integration in live Runner/Build code (git-grep found only the older proposed unified platform plan). Treat wiring and packaging as unimplemented. Some native-tools follow-up work may be ahead of older status paragraphs; re-run focused proofs before claiming availability on a specific deployment.

### 2.2 Tunnel repo: actual v1 transport
| Implemented | Details / limitation |
| --- | --- |
| Outbound WebSocket connector, HTTP JSON-RPC relay, client SDK | packages/connector, relay, client; routes /connect and /v1/devices/:id/mcp |
| Basic device auth | 256-bit tokens, hashed records, scoped client credentials, 10-min one-time pairing codes, revoke |
| Concurrency/connection | correlation IDs, request timeout, pings/pongs, capped reconnect; deterministic e2e incl. 10 parallel calls |
| Storage | single JSON store; no multi-tenant accounts/billing, shared routing, durable remote jobs |
| Local tool hosting | one directly spawned stdio MCP child; not using AIBoard Runner authority and not multi-server |
| Protocol | internal custom JSON-RPC-over-HTTP, NOT a standard public remote MCP server |
| Crash recovery | WebSocket reconnect YES, local MCP child restart NO; crash only logs in connector.ts |
| Cancel | removes pending frame but does not cancel underlying MCP work; uncertainty and retry semantics unsafe |
| Payload | 4 MiB frames/HTTP; local MCP stdout may accept 8 MiB line; no chunk protocol |
| Hosting/security | plaintext HTTP on loopback by default; TLS left to proxy; WebSocket accepts query bearer fallback; Windows owner-only secret ACL not implemented |
| Current test evidence | 181 tests recorded in handoff; separate source review and full npm test previously passed; NOT WAN/production/operational qualification |

AIBoard should import/use the useful relay components AFTER hardening, while replacing the prototype's standalone arbitrary tool-process owner with a Runner-bound dispatcher. Keep transport/dispatch separated in modules so Linux/macOS later use the same gateway.

### 2.3 Gaps against Desktop Commander + Windows MCP
Legend: EXISTS = production-source feature, not a paid live remote proof; PARTIAL = capability differs, separate bridge or policy required; MISSING = no equivalent native source capability found.

| Reference capability | AIBoard existing? | Requirement |
| --- | --- | --- |
| File read/list/search/write/rename/precise edit | EXISTS | Remote wrappers over existing tools; avoid duplicate tool names |
| Bulk multi-file read | PARTIAL | Add batching/pagination ONLY if workload justifies; may compose existing fs.read |
| PDF read/create/edit | MISSING as dedicated native tools | Optional document MCP adapter and artifact pipeline; controlled inputs/outputs |
| DOCX and XLSX native read/edit | MISSING as dedicated native tools | Adapters with structure-preserving edits and regression fixtures |
| Shell and interactive REPL | PARTIAL | Managed stdin/output already exists; add PTY only if truly needed with tested lifecycle |
| Long-running commands and sessions | EXISTS locally | Durable remote handles/status/idempotent retry; distinguish process ID from OS PID |
| Inspect/kill arbitrary host process | PARTIAL | Owned process management exists; global OS PID visibility/actions require separate elevated-grant design; off by default |
| Native Windows screenshot and visual mouse/keyboard | MISSING (browser screenshot != desktop) | Windows interactive-session adapter; consent + session lock |
| Accessibility/UI Automation tree & element actions | MISSING | Prefer UIA selectors/element IDs over blind coordinates; verified focus/foreground |
| Window/app enumerate/focus/launch/close | MISSING as governed desktop APIs | Native Windows adapter |
| Clipboard, notification | MISSING as governed Windows APIs | Opt-in sensitive clipboard; notifications bounded |
| Registry | MISSING as governed API | Read-only allowlist first; writes disabled or explicit high-risk approval |
| Windows multi-select / multi-edit | PARTIAL | fs.patch handles file edits; native UI multi-control actions need transaction/verification |
| Remote account/device dashboard | MISSING | Paid account registry, health, sessions, grants, revoke, audit |
| True remotely discoverable standards MCP | MISSING | Hosted MCP compatibility + OAuth + asynchronous job tools |
| Local MCP install/update by agents | EXISTS | Reuse Extension Management; do not fork it |

## 3. Architecture and authority
~~~
External MCP clients   Hosted AIBoard web client   Native AIBoard agents
          \                    |                      /
           \---- HTTPS OAuth/session + entitlements --/
                                |
             [Account + Billing/Entitlements backend]
                                |
             [Authenticated Remote MCP / Device API]
                                |
                  [Stateless/HA Relay Router]
                  {device lease, route, limits, audit}
                                |
               outbound WSS + mTLS/device proof
                                |
               [Local AIBoard Desktop Agent]
               {tray, pairing, updates, supervisor}
                                |
                   [Runner V2 adapter/authority]
       {grant, role, exact roots, evidence, recovery, tool broker}
                  /           |             \
         Native tools    Managed MCP       UIA desktop
          + Build        providers          companion
~~~
- Hosted relay is NEVER a shell/file/GUI execution authority. It routes requests into the correct local Runner after independent account, device, project, capability and consent decisions.
- Local Runner maps each remote request to a canonical actor/run/session and independently REAUTHORIZES the operation. Remote OAuth scope cannot grant more than local policy; no bypass by calling a generic MCP tool alias.
- The local connector must not start a second unmanaged Desktop Commander MCP process directly for privileged operations. Installed MCP tools use the Runner's existing Extension Management and governed ExecutionHost. Use Desktop Commander's permissively licensed local tool code only after dependency/license review and ONLY behind those guards.
- Distinct trust planes: account entitlement (commercial access); remote client authorization (who); device/project scope (where); Runner grant (what); task/agent role (when); per-action consent (high risk). All MUST pass.
- Data at rest by default stays on device: Git repositories, transcripts, user provider credentials, execution evidence, sensitive desktop screenshots. Relay keeps minimal device/session/job indexes, metering and redacted audit. Websocket TLS protects transit, but DO NOT market end-to-end encryption unless independently implemented and audited.
- Separate local control plane from Session 0 GUI helper. Windows interactive session helper acts only while a consenting unlocked user session exists. Windows service/tray must not pretend to click across secure desktop or UAC.
- The site remains Next static export; introduce separate authenticated backend for user/account/device/checkout/webhook APIs. Never embed payment provider keys or token minting in browser JS.

## 4. Shared contracts BEFORE features
Define a versioned transport envelope with {protocolVersion,requestId,callerAccountId,clientId,deviceId,projectId,runId?,sessionId?,toolId,operationClass,exactScope,permissionIntent,capabilityDigest,issuedAt,expiresAt,nonce,idempotencyKey,payloadDigest,traceId}. Treat claims as untrusted until verified. Authenticate every hop; never accept permissions from free-text AI arguments. Define response as {requestId,admitted,jobId?,status,outputRef?,errorCode?,uncertainty?,traceId}. Include compatibility negotiation and typed unsupported/version errors.

Job status machine: queued -> awaiting_device | awaiting_approval | running -> verifying | completed | failed | cancelled | outcome_unknown | blocked_policy | paused_provider | paused_budget. A timed-out HTTP request NEVER implies a failed underlying job. Invariant: same idempotency key + same principal/scope/payload digest references ONE admitted operation; changed content returns conflict; ambiguous side effects become outcome_unknown and require reconciliation, never automatic destructive replay. Implement idempotency at local authoritative Runner with durable commit-before-dispatch, not merely volatile relay memory. Use monotonic event sequences and cursor-based progress polling.

Ownership: remote job links to actual Runner-owned build/task/process/session and exact evidence refs; no change to existing Runner task submission/review gates. Job cancellations are best-effort for already-started effects; separately report cancel_requested, stopped, and effect_outcome_unknown when necessary. A revoked token blocks future calls instantly; reconcile already admitted effects according to explicit policy.

Security: enforce least privilege, per-user project roots, Windows canonical path + junction/ADS/symlink protection, command allow policies, explicit full-access opt-in, UI action consent, device owner lock, concurrency quotas, out-of-band admin recovery. No private network fetch SSRF or credential query params; origin/CSRF checks and short-lived pairing codes. Never place long-lived secrets in argv or global service logs.

## 5. Executable packet plan and dependencies

### Phase 0 — Reconciling current work / baseline (must go first)
**R0 — Audit/ADR/manifest** (depends on none; docs/contracts only)
- Reconcile this document against the latest HEAD of BOTH repositories, their AGENTS.md, the native-tools implementation status, current Task 12 gate, download artifacts and user-owned worktrees.
- Generate a machine-readable catalog of ACTUAL Runner tool schemas with role/tool readOnly/effect/permission mapping; record owned-process vs arbitrary-host-process and browser vs desktop distinctions. Map Desktop Commander + Windows MCP operations to already-native / external MCP bridge / implement; never duplicate equivalents.
- Make design ADRs for repo ownership: (A) tunnel becomes workspace/companion service with a narrow Runner adapter; (B) account API and billing backend separate from static export; (C) local GUI companion isolation; (D) job ID/lease model and cancellation uncertainty; (E) per-device/project/tool entitlement boundary.
- Baseline commands and known failures in a durable ledger; no spent provider/model calls; no regression suite yet.
- **DoD:** traceability table and API fixture definitions approved; no feature-code changes; all existing ownership and release boundaries explicitly preserved.

### Phase 1 — Safe execution transport; no UI paid access yet

**R1 — Runner-controlled tunnel integration** (R0)
- Implement a local transport adapter INSIDE the Runner's lifecycle graph and integrate the useful tunnel client/relay libraries. The connector receives remote job dispatches and obtains Runner-issued SessionAuthority/ToolBroker grants for an approved project/tool. No direct spawn of arbitrary stdio MCP from the tunnel on the paid path.
- Use shared tool descriptors already produced by Runner. Dispatch to native tools and installed local MCP servers through their existing broker. No arbitrary "execute_command" escape hatch. Avoid name collision and keep per-role tool restrictions.
- Explicit lifecycle ownership for connector transport, remote dispatcher, leases, ManagedProcess, MCP sessions, UIA companion, shutdown/restart and cleanup. On Runner startup reconcile transport and effects BEFORE advertising tool readiness; failure fails closed.
- Connection state: disconnected, authenticating, connected-but-degraded, tool-ready, suspended, revoked; heartbeat alone is NOT tool-ready. MCP child crash/relaunch uses existing lifecycle authority, bounded exponential supervised restart and readiness/initialize/tools-list after restart.
- **DoD:** fake relay -> authenticated Runner bridge -> EXISTING fs.read + owned process read + installed MCP tool passes; wrong scope denied before dispatch; deliberate MCP crash recovers tool-ready or reports degraded; no tool call bypasses exact grants; no orphan processes after stop.

**R2 — Durable requests, cancellation and flow control** (R1)
- Implement record-before-dispatch idempotency in Runner state (transactional store), monotonic event journal, device/connection epoch fencing and explicit outcome_unknown. Include remote caller, grant fingerprint, tool identity, input digest and receipt.
- Enforce limits on remote in-flight operations, per-device calls, independent browser UIA lease, queue depth, deadlines and fair scheduling. Propagate HTTP disconnect as ONLY cancellation of HTTP wait unless the remote user explicitly requested job cancellation. Track late completions safely.
- For cancellable operations use AbortSignal + MCP cancellation notifications when supported, and Runner process-control semantics. If the tool has no assured cancellation, mark uncertain until observed; never imply cancellation guarantees.
- Do not automatically retry side-effecting calls across reconnect unless they have proven idempotent semantics; replay safe reads only behind freshness/grant checks. Provide job.get/status/events/result/cancel primitives with cursors and result TTL.
- **DoD:** 100 repeated same-key requests -> single execution; dropped response after dispatch -> one authoritative job; conflict key rejected; kill/restart relay and Runner -> reconcile with no duplicate filesystem/process effects; cancellation of a blocked tool reports true status not fabricated success.

**R3 — Large artifacts, screenshots and logs** (R1; R2 for job refs)
- Fix tunnel's 4 MiB frame / 8 MiB child line mismatch: set one negotiated per-frame maximum with smaller control frames and explicit chunked binary data-plane. Images, PDF/DOCX/XLSX, terminal logs are content-addressed artifacts, not base64 embedded in text tool output.
- Add chunk ID, offset/length, SHA-256, transfer resume, ACK, checksum, backpressure and per-account/device quotas. Use Runner ArtifactStore/managed output spool for owned evidence, streaming redaction and loss reporting. Avoid storing sensitive payloads at relay; if encrypted relay buffering is ever added document operator access and retention.
- When an output prefix is missing on Windows or private spool cannot be attested, return a truthful gap/partial result; don't claim full logs. Bound media decoding and screenshot derivation, default screenshot retention short and no accidental full desktop image in audit.
- **DoD:** 20/100 MiB binary artifact survives disconnection/resume byte-exact; oversized frames rejected without killing healthy sessions; bounded RAM/disk under slow receiver; binary/text and UTF-8 offset parity; quota exceeded explicit; screenshot payload never leaks to debug logs.

**R4 — Transport hardening and operational durability** (R1-R3)
- Public ingress must require HTTPS/WSS; reject plaintext off loopback; remove device-token query fallback; validate host/origin and authenticated HTTP/WebSocket handshakes; use bounded ping/pong, connection leases and fencing epochs.
- Stop relying on a single JSON file for concurrently updated tenants/devices/entitlements/idempotent jobs. Introduce transactional database with migrations, rollback/backup/restore and indexes; in-memory socket registry may remain for a single relay but HA requires shared discovery/routes and single-active-device epoch semantics.
- Separate liveness from readiness; health endpoints with dependency checks; per-tenant/device quotas and rate limits; audit tracing, telemetry and structured redaction. Revoke, renew and rotate credentials without losing unrelated long jobs. Windows client secrets stored via appropriate DPAPI/Credential Manager/per-user ACL, not merely POSIX modes.
- Add supply-chain pinning, signed versioned connector update and rollback, operator emergency revoke/disable, least-privileged VPS service, tested restart on reboot. Do not hardcode mcp.aiboard.me as deployed until DNS/config proven.
- **DoD:** cross-account denial, replay/race, token leakage, origin, mixed-content, SQL-store atomicity, failed upgrade/migration, 24 h soak with network flaps and relay restarts, injected resource starvation, and signed-update tampering tests pass.

### Phase 2 — Paid accounts, standards-compatible remote MCP, and product API

**P1 — Account/organization/device model** (R1; can overlap R2)
- Create a minimal hosted identity backend with a trusted OIDC provider (no custom passwords). Canonical Account/User/Org (if needed), Device, PairingAttempt, ClientGrant, ProjectGrant, DeviceSession, JobIndex, Activity/Audit entities. Protect migrations, privacy and deletion lifecycle.
- Pair using authenticated user session + short-lived device code + confirmation shown locally; bind device public key and proof-of-possession where feasible. Pairing device names can be changed without rotating identity. Device transfer requires revocation/re-pair.
- Device admin UI/API: list, rename, lastSeen/lastToolReady, revoke/reconnect/status, current tools/capability digest, active jobs, allowed projects, sessions, log/diagnostic counters. No "online" indicator based solely on WebSocket presence.
- **DoD:** two real accounts on separate browsers can't enumerate or call each other's devices, even with guessed IDs; revoke while connected takes effect immediately; stale project grant invalidated before next call.

**P2 — Commercial entitlement and usage ledger** (P1, R2)
- Product SKU design must stay configurable: Remote Access, Remote Device Tools/GUI, Autonomous Jobs; optional device seats and included metered relay usage. Decide actual pricing/limits with owner in a separate non-code configuration decision; don't hardcode speculative prices. Free/local Runner Build functionality is not disabled.
- Implement EntitlementDecision(accountId,deviceId,feature,operationClass,period,policyVersion) server-side and revalidate during remote admission at both relay AND local grant side (local checks signed, short-lived entitlement claims and revocation epoch; offline cached access expires). Do not send payment access secrets to the model.
- Billing via a reputable checkout provider with hosted checkout/customer portal; use verified signed webhook events and idempotent processing to activate, renew, downgrade and refund. Browser redirect never provisions entitlement. Payment details remain with provider.
- Authoritative usage: metered calls/active connection-minute or device-days/bytes/job slots as determined by SKU; store account/device/client/operationId, quantity, event time, retention, dedupe key and adjustment semantics. Provider token/cost budgets tracked separately by Runner and not marked as AIBoard revenue. Explicit overage/limit handling, spend guard, grace periods, refund and chargeback transitions.
- Security: tenant isolation, ledger atomicity, webhook signature + replay, price ID allowlist, accounting corrections, no unmetered bypass through direct MCP/raw API, avoid long-running jobs abruptly losing their already-approved effects on expiry; define grandfathering/finish policy explicitly.
- **DoD:** duplicate/out-of-order/webhook-retry tests, two-tenant overage isolation, downgrade/revoke on next admission, honest user-visible usage, refund/chargeback reconciliation, full payment test mode and reconciliation export. Do not go live until legal/privacy/tax/provider policies are confirmed.

**P3 — Hosted standards MCP gateway** (P1-P2, R2)
- Implement a tested current-spec Streamable HTTP MCP facade, protocol negotiation, secure OAuth/OIDC protected-resource metadata and OAuth audience/scope mapping, proper tool discovery, structured errors, session lifecycle, input validation and response limits. Adopt a maintained MCP SDK where appropriate; do not expose the existing custom /v1/devices/:id/mcp directly as the public standards endpoint.
- Tool names should be few and coherent: aiboard.devices/list; aiboard.projects/list; aiboard.jobs/start,status,events,result,cancel; aiboard.builds/start,status,pause,resume,evidence,approvals; aiboard.tools/list,call only for grants/capability-approved tools. Actual legal identifier syntax chosen by MCP adapter; names here are conceptual. Do not flood each model's context with hundreds of dynamic tool definitions; allow filtered discovery.
- For external chat clients: a long action returns quickly with jobId and a follow-up polling/subscription interface. MCP sessions are NOT durable job ownership; jobs persist even if the host model/chat disconnects. Host limits (ChatGPT, Claude, etc.) remain outside AIBoard's control.
- Map read-only and destructive annotations truthfully. Revoke OAuth scope, account entitlement or local device grant independently. Do not let ChatGPT-specific OAuth quirks become the core AIBoard protocol.
- **DoD:** MCP inspector/conformance, two heterogeneous external test clients, read-only from ChatGPT-compatible host if available, user-approved write, host disconnect + recovery by jobId, unknown method/version/required auth refusals; no tool works after OAuth scope removal.

### Phase 3 — Native Windows capability parity and local client packaging

**W1 — Tool parity adapter/capability registry** (R1, R2)
- Produce a generated matrix from DC/Windows MCP tool descriptions and Runner schemas showing exact semantic equivalence. Promote native fs/process/git/browser/image/artifact capabilities through one capability broker (not copy-pasted wrappers). For third-party local tools, prefer approved managed MCP Extension Management integrations pinned by package digest and trust policy. Never install code automatically due only to model suggestions.
- Add selected missing document operations via dedicated local MCPs or governed native adapters: PDF structured extraction/create/annotate, DOCX outline and structure-preserving patch, XLSX workbook/range read/write, safe image/batch reads. Use actual file-format parsers, preserve unknown document data, create new artifact by default; don't promise support for every document type.
- Process parity: optional FULL/explicit-grant host process enumeration with PID + start-time identity; terminate ONLY after user approval and revalidation. Existing owned-process tools remain default. Optionally add PTY as a separate owned adapter with lifecycle/interactive tests; never label current stdin pipe a PTY.
- **DoD:** capability inventory shows source, version, status, owner, risk, evidence; editable DOCX/XLSX fixtures preserve unrelated content; refusal on wrong roots/protected files; external MCP crash recovery; no duplicate version-conflicting tool names.

**W2 — Windows GUI computer-use subsystem** (R1, R2, P1; release separately)
- Native interactive-session companion with IDesktopAutomationProvider (native Windows first); option to initially compose trusted Windows MCP instead of rebuilding. Distinct provider capabilities: screen(s), active window, windows list, application open/focus/close, accessibility/UIA snapshot and stable element handles, click, double click, right click, type, key chords, scroll, drag, wait-for-element, multi-action guarded batch, screenshots and window crop.
- Prefer UI Automation selectors and verified target window identity; use coordinate actions only against captured monitor geometry, DPI transform and screenshot epoch, with focus/window revalidation immediately before action. One input lease per desktop/user session, fairness and cancellation; no mixed-agent mouse/keyboard races. Screen capture supports multiple monitors and masked sensitive areas.
- Clipboard, notifications and registry are separate capabilities: clipboard read/write defaults OFF and ephemeral/redacted; notifications are low risk but consented; registry read allowlist first, registry writes strongly restricted and separately approved. No UAC bypass, password capture, keylogging, secure desktop/lockscreen or service Session 0 control.
- Permissions: explicit enable-local-UI, visible tray status/control indicator, pausable hardware kill-switch, foreground unlocked-session checks, user-approved window/app scope (and time lease), session owner binding, action audit (metadata not text/screens by default). GUI capability failure reports locked/unavailable/needs-approval, not silent retry.
- **DoD:** real Win11 interactive desktop tests at 100%/150% DPI, dual monitor, app focus change, UIA stale element, screenshot redaction, deliberate competing agents, lock/logout/UAC prompt, sleep/wake and revoked consent; all cross-session/exclusive-owner violations fail closed.

**W3 — Windows distribution and dashboard** (R4, P1, W1; W2 can follow)
- Ship signed per-user installer for local agent/Runner/connector with one supported guided command or download, automatic update with checksum/publisher verification, rollback, uninstall, log collection and doctor. Avoid requiring repository checkout/Node/npm for ordinary users; preserve developer CLI.
- Windows background supervisor for connector + Runner service continuity, user-session tray app for approvals/GUI control; use SCM/task scheduler/installer appropriately without unnecessary elevation. Start after login and optionally headless at boot (headless cannot drive UI). State survives update and restart; never leak secrets into environment/argv.
- AIBoard dashboard: Devices, Tools, Jobs, Audit/Usage, Settings/Billing; show real online vs tool-ready vs degraded, version update, connection diagnostics, allowed projects, active Run/Build ownership, per-tool access, exact approvals, account/device revoke, tool call metering. Chat/Build launch UX should not conflict with current Settings -> Extensions.
- **DoD:** fresh Windows non-admin VM installs/pairs, offline/online/restart, version rollback, browser session refresh and second computer browser, no tokens in installer logs or URLs; manual local-only Runner still works; deterministic accessible UI tests.


### Phase 4 — Autonomous Work without chat-session dependence (core differentiator)

**A1 — Durable user intent and goal completion controller** (R2; reuse Build lifecycle)
- Existing Build is already the authoritative multi-step engine. Introduce a server-side AutonomousWork controller that starts/resumes a NativeBuild run or a specifically scoped task plan; persist objective, immutable user constraints, desired definition-of-done, latest plan revision, task graph, evidence, worktree/commit refs, provider role configuration, approvals, budgets and completion gate. Do NOT implement another Architect/Worker/Reviewer loop.
- Distinguish modes: (a) ordinary Chat = finite interactive turn, (b) Autonomous Work = deliberately user-started durable job, (c) existing Build = independent Runner-managed development workflow. Route long software changes to the existing Build runtime and expose through the new remote job API rather than shuttling prompts back into Chat.
- After a tool/model turn, atomically checkpoint intent/accepted result/tool call IDs/current role/cost and replay safety BEFORE scheduling the next turn. Persist goal+evidence as canonical artifacts; a new model invocation uses a context assembler summary plus source/evidence references, not a fabricated original model memory. Validate all summaries against durable state before relying on them.
- Require explicit terminal definition-of-done, independent review/verification as policy dictates, and handoff/approval for integrating into main. Do not extend workflow forever solely because model says "continue." The owner's existing final handoff pause remains mandatory.
- **DoD:** close browser, restart UI, reconnect another device, restart Runner/relay mid-task -> same Build/job/evidence with no replan hallucination/duplicate commit. Submitted changes pass independent gates; incomplete task stays pending with honest reason.

**A2 — Model context, budget and provider-quota orchestration** (A1)
- Reuse ContextAssembler/working set compaction and BudgetLedger/SqliteBudgetLedger/model-usage provenance. Add per-task context watermarking and preemptive checkpoint/compaction before likely context-window exhaustion. Summaries link to immutable artifacts, code revision and decisions; retain critical unresolved findings and the exact user objective.
- Track independently: model context-window cap, max turn/model calls, provider rate limit (429/retry-after), provider account credit/plan exhaustion, model token/cost budget, autonomous-job subscription allowance, desktop/relay bandwidth quota, wall-clock/safety deadlines. Each has a distinct pause/error state and UI explanation.
- On context exhaustion: finish current safe boundary, summarize verified state, release old model invocation and create the NEXT authorized invocation with bounded context; do not claim to expand a single model's hard context window. On AIBoard per-message turn limit: AutonomousWork uses bounded chained invocations through the server controller, not an artificial user "continue" message.
- On provider temporary throttle: use exact retry-after/backoff with jitter, circuit breaker, global fairness and persisted nextEligibleAt; don't aggressively retry or rotate unauthorized credentials. On provider subscription exhaustion or auth failure: pause_provider with actionable instruction; optionally choose another user-CONFIGURED/APPROVED provider/model that satisfies task capabilities, privacy, cost and role policy. Keep evidence of which provider continued.
- On AIBoard/model spending budget: never silently lift hard caps. Only renew a bounded budget window under an explicit standing policy set by the user (e.g., maximum total USD, time, model calls, target goal, allowed hours, permitted tasks). On insufficient entitlement/billing: stop NEW remote dispatch; preserve recoverable local state. No autonomous spending without a user's explicit budget authorization.
- Persist provider call attempts with idempotency/uncertainty distinctions: interrupted inference may have incurred cost or produced no observable output; account honestly, do not fabricate success. No auto-resubmission of a tool that might already have changed state.
- **DoD:** simulate context exhaustion, 40-turn Chat cap, process restart during model stream, 429+retry-after, expired API key, exhausted paid account plan, fixed user spending budget, provider switch, duplicate model response, stale checkpoint; no infinite loops, inaccurate token cost, unauthorized money spend or duplicate action.

**A3 — Runtime watchdog, lease renewal, resource reservations** (A1-A2, R2)
- Scheduler owned by the Runner, not the browser tab or hosted MCP HTTP request. Durable runnable queue and per-job lease/fencing, resource caps, health heartbeat, suspension policies and a deterministic state machine. Prevent competing browser/agent workers from advancing the same task. Bound concurrency by role/project/account and risk.
- Detect real progress (new accepted task evidence, commit, passing test, approved plan) rather than raw model tokens/tool-call count. After N ineffective iterations, issue one bounded corrective pass, then park for review; no endless model self-talk or repeated identical tests. Monitor stale live processes and orphaned UIA leases.
- Every reactivation verifies worktree Git HEAD/diff identity, Runner runtime version, bound tool capability generation, grants, credential availability, expected branch/ref and previously observed effect state. Preserve Runner recovery graph and tool generation pins. No unsolicited rebase, merge, push or deletion.
- Standalone background processes belong to the existing managed-process service and may continue while a model is paused; owner policy controls stop/cleanup. Suspend memory-costly invocations when model unavailable and retain only bounded logs/evidence/artifacts.
- **DoD:** 8+ hour synthetic job (fake model) spans simulated browser closure, network flap, service restart, model throttle, agent re-selection and repeated resume; resource count, journal and final effects are stable. Fair scheduling with two paid accounts, two devices and competing agents. No duplicate user message or background ChatGPT UI automation.

**A4 — Autonomous UX and user agency** (A1-A3, P2, W3)
- Clear run states: Working, Waiting for Provider, Waiting for Budget Approval, Waiting for User, Waiting for Device, Waiting for Review, Recovering, Completed, Failed, Cancelled, Unknown Outcome. Show latest accepted checkpoint, what happened, next step, model used and cost, remaining approved budget, and explicit evidence.
- User actions: Start Autonomous, pause, resume, stop, approve exact new budget/capability/command, switch provider (if allowed), modify constraints with versioned guidance, export handoff, audit/replay status. Notifications are opt-in and actionable; no claims of hidden background work when device is offline.
- Include "keep going until goal complete" UX only with safeguards: explicit scope, definition-of-done, hard money/usage ceiling, maximum time, high-risk action review, provider and available device. Defaults conservative. Allow AIBoard to run headless source builds; GUI jobs require the actual logged-in unlocked session.
- Show the crucial difference: automatic AIBoard workflow continuation DOES NOT renew ChatGPT/Claude plan entitlements, extend their per-conversation platform limit, or create more upstream tokens. ChatGPT MCP client may disappear while AIBoard-controlled Build continues locally under the user's own configured provider capabilities/credits.
- **DoD:** user can start remote Build from browser, close browser/ChatGPT, later open AIBoard and inspect actual task revisions, logs and status; after provider cap hit, sees truthful pause or an authorized next model, never ghost progress or hidden overspend.

### Phase 5 — Operational, pricing, security and product certification

**Q1 — Cross-layer security qualification** (R4,P2,P3,W2,A1)
- Threat-model: cross-tenant/cross-device leak, stolen but expired token, OAuth audience confusion, ACL/junction traversal, malicious MCP descriptor, model-generated "approve" text, hostile webpages, prompt injection via file/tool, relayed shell escalation, clipboard/screenshot sensitive content, cross-user GUI targeting, abandoned agent jobs.
- Security tests must include authorization at EACH hop; no single bearer token grants implicit Full access. Negative tests for revocation while job waiting/active, wrong project, stale tool generation, repeated nonce, entitlement expired/revoked, fake positive payment redirect, replayed webhook, malicious ZIP/plugin and forbidden OS command.
- Validate release binary provenance, dependencies and notices. Confirm AIBoard community source license, third-party Desktop Commander MIT modules and any Windows MCP dependency license, plus relevant binary redistributions. Verify privacy/security policy and data retention for commercialization.
- **DoD:** independent reviewer signs off matrix with executed evidence; every unsupported condition fails closed; privacy/financial obligations reviewed before accepting payments.

**Q2 — Reliability, performance and failure-injection qualification** (R4,A3,W3)
- Real machine tests: Win11 nonadmin install, desktop locked/unlocked, 2 monitors/DPI, sleep/wake, NIC flap, reverse proxy restart, VPS reboot, Windows user logout/login, Runner crash, MCP child crash, GUI helper crash, relay instance replacement, local process survives only according to ownership policy.
- Protocol/path: duplicate tool call, lost ACK after side effect, cancelled but still running, read during artifact transfer, corrupt chunk, malicious oversized frame, 100 MiB transfer, many idle devices, active long jobs. Mandatory measurable memory/CPU/backpressure and no secret capture.
- SLO proposals for owner approval (targets, not claimed facts): 99.9% monthly reachable relay API when healthy infrastructure; detect device disconnect/degradation within 45-90 s; admit read-only tools under 2 s p95 excluding offline/device/tool time; safe jobs survive planned relay restart without duplicate effect. Define error budget, synthetic probes, measured baseline and alert ownership before advertising these.
- Build-specific: retain all existing Runner role-boundary, task-cohesion, independent-review, Run/Task 12, output provenance, managed-process cleanup and strict isolation invariants. Dedicated remote/tool tests are additional; never weaken old suites to obtain green.
- **DoD:** measured report with exact commands, tested revisions/versions, failures, 24h soak traces, resource and latency graphs, no unsupported SLA claim.

**Q3 — Staged paid launch** (P2,Q1,Q2)
- Stage 0 internal dogfood: existing one-owner device and self-hosted relay; read-only access; Windows MCP companion optionally for GUI; 100% metering but billing sandbox only.
- Stage 1 closed beta: a few real users; limited device seats, explicit Full-profile opt-in, priced or free beta entitlement through secure backend, read-only default. Audit/usage and support tools.
- Stage 2 paid release: hosted checkout/webhooks, account portal, scoped writes and Build job APIs only after external penetration/security review and recovery pass. Publish actual pricing, privacy, refund terms, usage accounting and support policy.
- Stage 3 GUI and optional heavy document/PTY/global-process feature launch individually after their own safety/privacy/Windows test gates. Other OSes only after parity and platform-specific keychain/permissions proof.
- Rollback by feature flag/entitlement/route without deleting jobs: new paid remote actions disabled; running local builds preserved; users can export evidence and revoke devices. No DNS, billing, push, prod migration or deployments without fresh owner permission.

## 6. Workstream dependency map and team division
~~~
R0 audit/contracts
  |-> R1 Runner-bound transport -> R2 durable jobs -> A1 -> A2 -> A3 -> A4
  |                         |            |               |
  |                         |-> R3 data   |-> P1 account -> P2 billing -> P3 hosted MCP
  |                         |            |                     |
  |                         +-> R4 hardening                   W3 client/dashboard
  |                                       |
  +-------------------------------> W1 tool parity -> W2 Windows UIA
                                         |                |
                                  Q1 security <- P2/P3/A1/W2/R4
                                  Q2 reliability <- R4/A3/W3
                                          |
                                      Q3 launch
~~~
Suggested non-overlapping agents/worktrees:
- Agent Core: R0,R1,R2 contracts/integration; owns shared API and Runner authority binding.
- Agent Relay: R3,R4 transport/data plane; owns aiboard-tunnel package and relay reliability.
- Agent Commercial: P1,P2 hosted account/entitlement/billing backend; no changes to Runner execution controls.
- Agent MCP/UI: P3,W3 hosted MCP and dashboard; coordinate versioned contracts, no private auth shortcuts.
- Agent Windows: W1,W2 native/managed MCP parity and interactive user session helper; isolated behind adapter interfaces.
- Agent Autonomous: A1-A4 Runner durable continuation/orchestrator; MUST depend on R2 job model, no bespoke model loops.
- Independent Review/Verifier: security/behavior/gate parity per submitted coherent packet; Q1/Q2 integrated evidence.

Parallelism rules: R2 protocol schema must be merged/versioned before P3/A1; entitlement policy design must be agreed before product UI; Windows W2 can prototype against a local fake Runner port but cannot ship without auth/grant integration. Avoid overlapping edits to runner-v2/src/cli.ts, native-build-factory.ts, control-server.ts or role-capabilities.ts: designate an integration owner and stack small reviewed interface PRs.

## 7. Objective acceptance matrix (one executable proof per distinctive risk)
| ID | Test target / failure injection | Pass criterion |
| --- | --- | --- |
| T01 | tool parity catalog and route | Existing fs.patch, process.write_stdin, image.inspect, browser.screenshot offered from same actual Runner definitions with unchanged role restrictions |
| T02 | wrong account/device/project | 401/403 with no local tool start; all audit identities correct |
| T03 | lost reply after mutating command | exactly one effect, result eventually recoverable by durable job ID OR explicit outcome_unknown |
| T04 | remote timeout/disconnect | no implicit cancellation; job state truthful; attached command not accidentally replayed |
| T05 | MCP child crash | degraded readiness, supervised restart, no abandoned job or phantom ready |
| T06 | relay restart/device reconnect | socket epoch fencing, no old-epoch ghost responses or duplicate side effects |
| T07 | Runner restart with active Build | resume at accepted checkpoint after ownership reconciliation; no unapproved integration/push |
| T08 | provider 429, expired key, plan cap, context limit | accurate typed pause/backoff/authorized handoff; no quota circumvention or budget reset |
| T09 | user hard spend/budget ceiling | no future model call after ceiling without standing-rule authorization or explicit user approval |
| T10 | Chat 40-turn cap / browser close | user-started AutonomousWork continues in Runner-owned bounded invocations and can be observed later |
| T11 | live remote interactive process | writeId exactly once, stdin EOF distinct from signal, ranged output recoverable/gaps truthful |
| T12 | artifact 100 MiB over weak network | resume and verify SHA-256, bounded memory and no 4MiB frame crash |
| T13 | desktop lock, wrong focus, DPI change | refuse or re-observe; never type into unknown window; one GUI lease at a time |
| T14 | clipboard/registry/global PID | blocked by default; explicit high-risk approval and exact process identity required |
| T15 | billing webhooks duplicate/out-of-order | single entitlement transition & usage record, signed webhook required, no redirect privilege |
| T16 | expired subscription and offline client | no new paid remote call after effective revocation; local completed work/evidence remains accessible under local policy |
| T17 | external MCP client protocol | correct Streamable HTTP/session negotiation, read-only first, scoped writes and durable job tracking |
| T18 | tenant/data/screenshot confidentiality | no secret tokens in logs/URL/corrupt artifacts; data confined by actual protection boundary |
| T19 | fresh Windows install/update/uninstall | works as standard user; signed/pinned updates, rollback, no lost local provider credentials |
| T20 | full Runner regressions | existing strict isolation, cleanup, grants, reviewer independence and Build completion remain valid |

## 8. Non-goals, known risks and explicit product tradeoffs
- No promise that AIBoard can evade ChatGPT request/session/message caps or obtain more credits when a user reaches an external subscription's limits. AIBoard can do server-owned work with other independently entitled configured models or await valid resets.
- No hidden Chrome extension that spams "continue"; the existing user extension may be retained as their local convenience, but it is not a backend reliability mechanism or part of this product.
- No agent-generated checkout charges, account changes, software installs, arbitrary registry writes, remote UAC elevation, login/lock screen bypass, or unrestricted global shell by default.
- No claim every Desktop Commander function maps one-to-one: remote tool methods and semantics must be compared; single cohesive capability with a reliable contract is better than ten nearly duplicate tools.
- No blanket promise of Windows GUI control while machine is locked or logged out. Source builds/tests can continue headlessly; clicks and screenshots may not.
- No guaranteed exactly-once EXTERNAL effect for arbitrary executables or third-party MCP servers. Provide exactly-once admission and idempotent application only where enforceable; otherwise surface uncertain outcome and reconcile using actual evidence.
- No unbounded model contexts, test loops, output streams, storage, service resource use or budgets. No auto-acceptance of self-reported success.
- No production billing provider, exact pricing, VAT/sales tax approach, refund/terms, region support or SLO finalized by this technical plan. These are owner/commercial/legal decisions before live release.
- Avoid full heavy file/document processing on the tiny VPS: dispatch to local tool providers, bound payloads, verify quotas. Keep source/credentials local.
- Cross-platform beyond Windows not assumed; keep protocol portable and platform capability negotiation honest.


## 9. Acceptance process, checkpoints and documentation ownership
Every work packet produces an implementer summary with: requirement IDs; exact edited paths; permission/security implications; test commands and observed results; commit hash; API/protocol changes; known limitations; owner decision needed; next safe packet. All claims must be tied to observed evidence. "Verified" is reserved for executed tests against a declared revision/environment; no screenshots-only proof of backend reliability.

Maintain a separate implementation ledger in docs/plans/2026-10-27-paid-remote-device-tools-STATUS.md once feature coding starts, initially with all R0..Q3 listed as NOT STARTED and today's audit verified as DOCUMENTED ONLY. Each agent updates its owned packet atomically. Reviewer independently checks contract/permission coverage, negative tests, evidence, task cohesion and no covert new process authority. The final release reviewer must additionally reconcile installed binaries and live hosted config to tested SHA/version.

Recommended targeted command families (inspect current exact scripts at execution time):
- AIBoard: targeted tsx --test runner-v2/test/[selected].test.ts; npm run typecheck:runner-v2; focused scripts/test-native-build-*; npm run test:runner-v2 only at deliberate integrated gate. Avoid npm run build concurrently with the Next development server (per AGENTS.md).
- Native tools: runner-v2/test/filesystem-tools.test.ts, managed-interactive* / managed-process* / browser* / mcp* / tool-broker*; use current actual filenames rather than assuming spellings.
- AIBoard tunnel: npm ci; npm run build; npm test; add tests in packages/e2e for Runner bridge, authenticated scopes, crash recovery, idempotency, chunking and long jobs. The existing demo fake MCP is a transport fixture, NOT a security certification for actual local OS tools.
- UI: component and browser/Playwright flows for account/device/approval/billing, local vs remote operations, privacy and accessibility.
- Operations: fresh Windows 11 standard-user VM, two separate OIDC identities, real owner-approved VPS staging, real Relay -> Runner -> tool flows, no production credentials in test reports.

Security review cannot be waived for: changed runner process creation, privilege routing, global PID operations, untrusted external MCP code, Windows UI inputs, tenancy/billing, token storage and state migration. Model review is NOT a substitute for OS-level conformance or penetration tests. For regression cost, run focused suites per packet and the full matrix at Q2 only; no fake model charges during ordinary test cycles.

## 10. First packet to hand to a coding agent NOW

**Start R0 first and STOP after its reviewable deliverables.** Before code:
1. Read the required documents listed in §0.
2. Inspect the current native Runner tool broker / role allowlists / MCP Extension Manager, and the tunnel's relay, connector, JSON-RPC, auth, stores, tests. Reproduce the baseline using permitted local deterministic tests.
3. Create a versioned machine-readable capability parity manifest with evidence pointers and explicit support level for Desktop Commander and Windows MCP operations. Verify the "MISSING/PARTIAL" entries in §2 against the *current* code; correct the plan if an intervening commit added support.
4. Author the transport-to-Runner ADR and trust/permission matrix; decide package boundary without changing source behavior. Specify idempotency/job envelope and event journal interfaces with schema fixtures, including cancellation uncertainty and exact grant flow.
5. Open a separate implementation-status ledger (packet NOT STARTED/ACTIVE/BLOCKED/REVIEWED/ACCEPTED), anchored to your inspected Git revisions. Commit docs/contracts only in a separate worktree after independent reviewer acceptance. No production mutation, no paid calls, no broad suite.
6. Provide the next agent with R1 implementation entrypoints, compile/test commands, minimal fake-relay scenario and mandatory negative checks. Begin R1 implementation only after R0 contracts are accepted.

Example initial agent instruction:
> Implement packet R0 of D:\repos\ai-discussion-board\docs\plans\2026-10-27-paid-remote-device-tools-and-autonomous-jobs.md. Review both repositories and required AGENTS docs. Verify the existing native tool inventory and differences from Desktop Commander and Windows MCP. Produce capability matrix, versioned contracts/ADR, ledger and deterministic baseline evidence only. Preserve original main and other worktrees; do not deploy, push, use paid models, or run broad gates. Independently review these artifacts and return the exact commit/revision and R1 handoff.

## 11. References in current local repositories
- D:\repos\ai-discussion-board\AGENTS.md
- D:\repos\ai-discussion-board\docs\runner-v2\architecture.md
- D:\repos\ai-discussion-board\docs\runner-v2\security.md
- D:\repos\ai-discussion-board\docs\plans\2026-10-26-native-tools-and-extension-management.md
- D:\repos\ai-discussion-board\docs\plans\2026-10-26-native-tools-and-extension-management-status.md
- D:\repos\ai-discussion-board\docs\plans\aiboard-unified-cloud-desktop-agent-platform-2026-10-15.md
- D:\repos\ai-discussion-board\runner-v2\src\filesystem-tools.ts
- D:\repos\ai-discussion-board\runner-v2\src\managed-process-tools.ts
- D:\repos\ai-discussion-board\runner-v2\src\browser-tools.ts
- D:\repos\ai-discussion-board\runner-v2\src\role-capabilities.ts
- D:\repos\ai-discussion-board\runner-v2\src\extension-management-service.ts
- D:\repos\ai-discussion-board\runner-v2\src\mcp-remote.ts
- D:\repos\ai-discussion-board\runner-v2\src\agent-loop.ts
- D:\repos\ai-discussion-board\runner-v2\src\chat-agent-session.ts
- D:\repos\ai-discussion-board\runner-v2\src\native-build-manager.ts
- D:\repos\ai-discussion-board\runner-v2\src\budgeted-model.ts
- D:\repos\aiboard-tunnel\README.md
- D:\repos\aiboard-tunnel\packages\connector\src\connector.ts
- D:\repos\aiboard-tunnel\packages\connector\src\mcp-stdio.ts
- D:\repos\aiboard-tunnel\packages\relay\src\server.ts
- D:\repos\aiboard-tunnel\packages\relay\src\registry.ts

This specification SUPPLEMENTS the 2026-10-15 unified-platform plan with a current actual code audit and PAID remote/autonomous scope. In any overlap, preserve the invariant that Runner V2 remains local authority. An earlier plan's proposed implementation or historical status is NOT proof that a later packet was built.
