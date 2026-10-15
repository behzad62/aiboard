# AIBoard — Unified Cloud↔Desktop and Agent-Harness Implementation Plan
**Date:** 2026-10-15  
**Status:** Proposed implementation specification; not yet implemented or accepted.  
**Repository:** D:\repos\ai-discussion-board  
**Scope:** Simple install/launch + durable agent-provider roles + bidirectional MCP + secure cloud-to-desktop connection + optional GUI control.  
**Decision:** Preserve existing Runner V2 authority and existing static aiboard.me UI. Make the VPS relay the independent default remote route; OpenAI Secure MCP Tunnel is an optional OpenAI-specific transport, not a dependency.

## 0. Instructions to the implementation agent
1. Read this entire specification, README.md, AGENTS.md, docs/runner-v2/architecture.md, guide.md, security.md, docs/runner-v2/task-12-status.md, docs/plans/runner-v2-p6-6-EXECUTION.md, and current release runbook BEFORE work.
2. Check current branch/worktree, uncommitted changes, tests, shipped ZIPs, deployment behavior, and any newer owner instructions. Source code/current behavior takes precedence over path guesses in this plan.
3. Work in an isolated, named Git worktree/branch. This plan may initially exist as an UNTRACKED file in the owner's main checkout: read it from the absolute path first and copy it into the new worktree's docs/plans before executing packets, or incorporate it through an owner-approved docs-only commit. Do not assume an untracked file appears automatically in Git worktrees. Never overwrite another agent's files, delete unrelated worktrees, edit the owner's untracked files, or blindly merge. Do not push or deploy without explicit owner authorization; a push to main can deploy aiboard.me.
4. Record baseline and requirement IDs, task status, decisions, hazards, acceptance evidence, and unresolved problems in a durable implementation ledger under docs/plans. Do not claim test or deployment success without executed evidence.
5. Complete tasks in dependency order. For each task: implement, focused tests, targeted lint/typecheck, independent review against requirements, record actual evidence, then move on. Defer broad regression suite to the documented final qualification gate unless an existing higher-priority gate demands it. Never weaken existing Runner V2 ownership, grant, isolation, lifecycle, or recovery tests.
6. External coding CLIs and remote tools MUST enter via audited Runner-managed execution/process boundaries. Do not spawn subprocesses from unowned ad hoc child_process calls.
7. The architecture below is a target, not an assertion that features already exist.

## 1. Product goals, explicit requirements and exclusions

| ID | Requirement / definition of success |
|---|---|
| G-01 | Install on Windows with a single verified official command; no manual git clone/npm install/browser setup for normal end users. Later macOS/Linux. |
| G-02 | From a project folder, "aiboard" starts a persistent local Runner and opens the hosted AIBoard UI, selecting project/state securely by default; advanced flags remain. |
| G-03 | Local browser connection is paired without user copying raw URL/token. Stable per-install identity and encrypted provider configuration survive restarts/upgrades. |
| G-04 | AIBoard retains authoritative requirement → plan → task DAG → DoD → evidence → independent review → integration → handoff state even when provider sessions disappear. |
| G-05 | Planner, Worker, Reviewer are roles distinct from execution providers; one provider can fill any compatible role under policy. |
| G-06 | First-class direct-model, Codex CLI, Claude Code CLI adapters; capability discovery, sessions, resume/cancel, streaming, usage provenance, bounded timeouts, normalized results. |
| G-07 | External Codex/Claude/other tools can invoke AIBoard over inbound MCP (stdio locally; authenticated remote HTTP through a bridge). |
| G-08 | AIBoard can invoke external harnesses via outbound provider adapters. Recursion/cycle and authority-confusion prevention required. |
| G-09 | User can access paired Windows workstation from a cloud AI assistant with remote project/build/status/evidence operations through outbound-only desktop connection. |
| G-10 | Optional desktop tooling exposes scoped files/terminal and, later, guarded GUI screenshot/click/type/scroll/keyboard actions, comparable in function to Desktop Commander and computer-use assistants. |
| G-11 | AIBoard's own low-resource VPS relay remains independent of OpenAI and supports standards-based authenticated MCP clients. |
| G-12 | OpenAI Secure MCP Tunnel can be configured as an OPTIONAL route if user's Platform/ChatGPT workspace permissions allow. |
| G-13 | Full audit, device revocation, short-lived scoped tokens, exact project grants, idempotent command handling, replay protection, backpressure, disconnect/reconnect and fail-closed recovery. |
| G-14 | Preserve existing desktop/local Build flow, static site, license, task integrity, provider settings and production deployments. |

**Not v1:** remote desktop video streaming; replacing RDP; own general-purpose shell without permissions; hosting arbitrary code execution on the VPS; migrating all Runner state to cloud; billing/multi-tenant SaaS commercialization; circumventing OS lock/UAC; guaranteeing ChatGPT plan capabilities not enabled in the owner's workspace.

## 2. Grounding: current AIBoard (verified 2026-10-15)
- Root package is a private Node 24 / Next.js 16 static-export frontend (next.config.ts, output: export); its site is independent of a local Build backend.
- runner-v2/src/cli.ts is Runner V2's composition root; local control server, state and project paths, port and token already exist. Port 0 is supported. Current CLI REQUIRES explicit --project and --state-dir.
- runner-v2/bin/aiboard-runner-v2.mjs imports the TS CLI via tsx; runner-v2/package.json declares a bin entry, but normal users currently receive source distribution.
- scripts/publish-downloads.mjs produces public/aiboard-runner-v2.zip with TypeScript, runtime packages and instructions: npm install; npm run setup:browser; npm start with project/state/port flags.
- components/RunnerSetup.tsx asks for localhost URL/control token manually. lib/client/native-build-engine.ts calls the local runner. Runner V2's token is also used to derive encryption key for provider-configs.enc; regenerating it for the same state makes saved configurations unreadable.
- ControlServer recognizes aiboard.me / www.aiboard.me as allowed remote browser origins. Never interpret CORS approval as authentication.
- docs/runner-v2/architecture.md: CLI owns runtime/managed-process execution, grants, isolation and resource cleanup. Preserve exact preflight/recovery, do not create alternate process authority.
- docs/plans/runner-v2-p6-6-EXECUTION.md (as inspected) says T8 locally merged/accepted; REL-1 prepared but NOT started, and main push triggers production deployment. Reconfirm current facts at implementation start.
- An untracked tests/e2e/zz-workspace-shots.spec.ts was observed. Do not change or delete it.
- Existing README's license is AIBoard Community Source License, not OSI open-source; package/runtime distribution must include the applicable notices/license and avoid promising third-party unrestricted redistribution.

**External reference facts (verify again at implementation time):**
- Remote Desktop Commander: publicly documented model is AI client → hosted OAuth MCP endpoint → paired desktop agent over outbound connection; local agent executes and returns results; published hosted-service repository contains docs/manifests, NOT hosted service source.
- OpenAI Secure MCP Tunnel: OpenAI-managed endpoint and outbound local tunnel-client via HTTPS, for private MCP server access in supported OpenAI products. Not a universal third-party relay or a public plugin distribution path; requires Platform tunnel credentials and appropriate workspace authorization.
- ChatGPT custom MCP full write/modify actions are gated by account/workspace entitlements. A public endpoint or tunnel alone does not grant permission or enable tools on any plan.
- MCP HTTP transport and auth evolve; implement with version negotiation and published SDK support (2026-07-28 stateless MCP spec, where applicable), rather than hard-coding legacy SSE/session assumptions.
- Codex "codex exec" supports JSONL, schema-driven results and resume; Claude Code "claude -p" supports stream-json and resume. Verify installed CLI versions and exact switch behavior.

References:
- https://github.com/desktop-commander/remote-desktop-commander/blob/main/README.md
- https://github.com/desktop-commander/remote-desktop-commander/blob/main/docs/SETUP.md
- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- https://github.com/openai/tunnel-client
- https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt
- https://modelcontextprotocol.io/specification/2026-07-28
- https://learn.chatgpt.com/docs/cli/reference
- https://code.claude.com/docs/en/cli-reference

## 3. Target architecture and boundaries

~~~
 ChatGPT / other MCP clients / remote browser           Local Codex / Claude
       |                     |                               |
       +---------- HTTPS OAuth MCP ----------+                | stdio MCP
                                            |                |
                           [AIBoard gateway/relay on VPS]     |
                            - OAuth, device registry         |
                            - minimal request correlation    |
                            - scoped routing; no code state  |
                                            |                |
                               outbound desktop bridge       |
                                WSS/TLS + mutual identity    |
                                            |                |
    +---------------------------------------+----------------+-------+
    |                    Desktop AIBoard Agent                       |
    |  install/launcher + pairing + local MCP ingress + gateway      |
    |  optional OpenAI tunnel-client (independent transport)         |
    |                           |                                    |
    |                    Runner V2 AUTHORITY                         |
    |    Durable plan/DAG/evidence/reviews/permissions/recovery      |
    |                 Role execution coordinator                     |
    |                       |       |        |                       |
    |               Direct Model    Codex CLI   Claude Code CLI     |
    |                       |       |        |                       |
    |        Owned task worktrees / process supervisor / grants      |
    |                                                               |
    |      Optional device tool adapters: scoped files/shell/GUI     |
    +---------------------------------------------------------------+
~~~

- **Control plane**: account/device registry, pair/revoke, online status, OAuth auth and request routing. VPS is not responsible for build planning, file writes, model credentials or Git ownership.
- **Execution plane**: Runner V2 on authorized desktop owns workflows, tasks, worktrees, commands, approvals, verification and recovery. Cloud models send intent, not unbounded authority.
- **Data plane**: source code, tokens, provider secrets, state DB and full build evidence live locally by default. Relay may see command/result payloads in transit; explicitly do NOT claim end-to-end secrecy from VPS operator without a separately implemented and tested E2E crypto envelope. Minimize/log-redact and support client-level encryption as a later enhancement.
- **Two complementary entry points**: inbound MCP calls AIBoard; outbound AgentProvider calls Codex/Claude/model. Neither bypasses Runner permissions or bypasses workflow authority.
- **Two remote transport adapters**: self-hosted VPS broker (cross-vendor; preferred for product), OpenAI tunnel-client (optional quick private integration). Never expose Runner V2 localhost token/service directly to public Internet.
- **UI**: existing static website continues for discussion; local or remote Build setup talks to authenticated gateway/agent. Any new server-only functionality lives behind separate authenticated backend rather than introducing accidental Next.js API routes into static export.

## 4. Stable contracts to implement first

### 4.1 Providers vs roles
- IAgentProvider: discover() → capabilities, start(roleInvocation), send(session, message), resume(session, checkpoint), cancel(session), streamEvents(session), settle(session).
- IRoleStrategy: execute(workflow/task context, IAgentProvider) → validated role result. Planner, Worker, Reviewer are role policies and result validators; provider choice is independent.
- Provider contract includes provider-id/version, auth availability, session-id, canonical worktree and lease, capabilities, permission profile, effective isolation, cancel/resume support, timeout budget, cost/usage provenance, streaming support, MCP access and structured-output support.
- DirectModelAdapter wraps existing AIBoard LLM transport. CodexCliAdapter and ClaudeCodeCliAdapter use supervised CLI invocations and tested noninteractive output. No simulated capabilities.
- Planner receives repository read scope; Worker receives only its assigned worktree write scope; Reviewer receives read-only code and diff access unless a separately approved repair task is delegated.
- A provider cannot grant itself new workspace roots or overwrite the authoritative plan/evidence store.

### 4.2 Normalized events/results (versioned, typed, stored)
- AgentEventV1: sessionStarted, statusChanged, message, commandStarted, commandCompleted, fileChanged, evidenceProduced, usageUpdated, needsInput, completed, failed, cancelled. Every event carries workflowId, taskId, sessionId, invocationId, sequence, timestamp, origin, provenance. Unknown versions fail or are explicitly isolated.
- PlanningResultV1: requirements, decisions, risks, task DAG, dependencies, acceptance criteria, plan revision.
- WorkResultV1: taskId, base revision, changed paths, actual commits, test commands/results, referenced evidence, unresolvedIssues. Validate against observed Git/evidence: provider self-report is not proof.
- ReviewResultV1: subject revision, verdict (pass/rework/block), requirement coverage, findings/severity, evidence refs, requested rework and independent reviewer identity. A reviewer cannot silently resolve its own findings.
- Persist provider-session mapping, attempt IDs and agent event projections. AIBoard remains source of truth across provider session expiration/disconnect and context loss.
- Cycle prevention: request ancestry (instanceId, workflowId, providerInvocationId), max delegation depth (default 3), duplicate-instance rejection, maximum tool/harness recursion, budgets and cancellation propagation.
- Avoid infinite loops where Codex → AIBoard MCP → Codex provider → AIBoard MCP.

### 4.3 Remote typed command envelope
RemoteRequestV1 fields: id, userId/tenantId, deviceId, originClient, nonce, issuedAt, deadline, commandType, projectId, exact scope, permission intent, idempotencyKey, optional parent/ancestry, payload hash.
RemoteResponseV1: request id, accepted/rejected, durable jobId OR bounded result, timestamps, grants/approval state, error class, evidence refs. No unbounded raw output.
- Separate read-only tools from state-changing tools. Always validate device ownership, project grant, payload schema, nonce freshness, scope and version.
- Long-running call returns durable jobId quickly. Separate status/events/result/cancel/approval tools; no multi-hour open HTTP request.
- Reconnect semantics: ack offsets, at-least-once delivery with exactly-once EFFECT via idempotent job creation, duplicate rejection, persistence and deduplication; never guess that an interrupted command completed.
- Permission requests are displayed and approved through the local trusted UI (or authenticated exact-action remote approval policy). "Full" is never inferred from cloud authentication.

## 5. Implementation sequence — task packets and objective DoD

### Milestone A: Foundation and user-friendly local distribution
**A0 — Audit and protect current release** (dependency none)
- Create architecture decision records, requirement matrix, source and branch snapshot, affected test inventory, current packaging contract and threat model; check REL-1 state.
- DoD: no code-change deployment, no missing current files, current baseline/known failures accurately recorded.

**A1 — Installer & reliable package** (A0)
- Build a versioned installable distribution from the existing published Runner V2, first Windows. Compile/ship JS and runtime dependencies; choose prepackaged Node 24 runtime or carefully tested installer prerequisite strategy. Include license/NOTICE and hashes/signatures for release artifacts.
- Host audited install.ps1 on official aiboard.me origin and verify pinned manifest, SHA256 + trusted publisher signature if provided. Never execute a mutable unsigned remote payload with inherited elevated privileges. Install to per-user location; install/uninstall/update rollback; no admin normally.
- DoD: fresh Windows standard-user VM runs ONE official installation command; no developer checkout/npm commands; installed command works offline after first install subject to required provider/browser resources; tampered payload is rejected; update failure rolls back without modifying state.

**A2 — aiboard CLI and defaults** (A1)
- Implement aiboard [start|stop|status|doctor|update|uninstall|providers], aiboard --project PATH, and aiboard --version. Default project = current Git root if safe, otherwise current directory with explicit confirmation for Git/bootstrap changes.
- State = OS app-data directory (per user AND project identity), always outside project; stable token encrypted with DPAPI/OS keychain/file ACL, no plaintext stdout for ordinary starts. Reserve or discover local endpoint; detect/reuse existing instance; shutdown cleanly; handle multiple projects and processes.
- Browser opening and setup are explicit opt-in flags for headless environments. Browser automation installs optional Chromium on first actual browser need with progress and cancellation.
- DoD: start twice → reuse same identity/state; 2 projects isolated; no token loss/decryption break; existing flags and old CLI remain compatible; git missing yields actionable error.

**A3 — Local browser pairing UX** (A2)
- Replace copy/paste setup with a consented, short-lived one-time pairing handshake. Do not place bearer tokens in URL/query/fragment. Handle fixed discovery endpoint or explicit local launcher-to-browser handoff; CORS/Origin/DNS rebinding/CSRF protection and no wildcard origins.
- Provide Manual/Advanced connection fallback and user-visible device/project health.
- DoD: authenticated browser pairs with intended local project, refresh/restart preserves connection, unsolicited website can't pair, a second browser requires user approval, revocation works.

### Milestone B: Agent-harness mixer (outbound)
**B1 — Interfaces and durable normalized events/results** (A0)
- Add versioned IAgentProvider/IRoleStrategy and capabilities table to Runner V2, wrapping current direct-model path with behavior parity. Add recorded session mapping, event normalization, cancellation and plan/result validation.
- DoD: direct model old workflows maintain equivalent results; fake model/event adapters pass contract tests; invalid structured result cannot advance authoritative state.

**B2 — Codex CLI provider** (B1)
- Discover installed CLI/auth/version/capabilities. Use codex exec, JSONL event parsing, structured output, exact worktree, controlled sandbox/access flags, resume by saved session ID; only Runner-owned process launch.
- DoD: Planner/Worker/Reviewer role fixtures, resume after interruption, nonzero exit/error, cancellation settles owned child process, malformed JSONL handled, no unauthorized file writes.

**B3 — Claude Code provider** (B1)
- Discover installed CLI/auth/version/capabilities; use claude -p with supported stream-json, resume, per-invocation permissions/tools, exact worktree, bounded context and process-owned lifecycle.
- DoD: same B2 fixture categories with truthful feature capability mapping; user not logged in gets actionable diagnosis.

**B4 — Role orchestration/presets** (B2,B3)
- UI/config selects provider per role, separately from selected model. Add roles planner, worker, reviewer; capability gating, independent review policy, provider cost/usage provenance and fallback rules.
- Prototype example: Claude Code planner → inexpensive direct-model worker → Codex CLI reviewer; reviewer finding triggers new worker attempt. Runner owns DoD and evidence, not CLI prose.
- DoD: end-to-end fixture produces grounded plan/task/review/evidence ledger; CLI can disappear and workflow still resumes safely; reviewer does not self-approve.

### Milestone C: Bidirectional MCP gateway and remote-safe commands
**C1 — Local inbound MCP server** (B1; A2 preferred)
- Implement a separate MCP ingress adapter (stdio first, HTTP loopback optional), backed by the existing control plane and authenticated scoped API. Tool names should be stable, versioned, small and discoverable.
- MVP: list_projects, select_project, inspect_project, list_workflows, create_plan, start_build, get_job_status, get_job_events, list_tasks, get_task_evidence, request_review, resume_build, cancel_build, get_pending_approvals. Mutating commands carry explicit grant/approval intent.
- DoD: works from local Codex/Claude MCP client; unauthorized/unknown project refused; legacy Runner endpoint still works; MCP cannot bypass existing grant rules; recursion checks pass.

**C2 — Optional scoped developer/device tools** (C1)
- Reuse existing Runner-owned file/process tools and any explicitly installed external MCP for developer workflows rather than duplicating unsafe direct shell APIs. Version tools: read_file/list/search, write_patch, run_supervised_command, read_process_output. Require project-level roots and permission gates, not unrestricted user-home filesystem exposure.
- Add bounded response sizes/pagination, secret redaction, file conflict detection, read/write logs, timeouts. Clearly separate read-only diagnostics from build actions.
- DoD: can inspect and repair permitted repo, cannot access other projects/user secrets or run arbitrary privileged effects without user authorization.

### Milestone D: Independent VPS relay and paired desktop
**D1 — Threat model/protocol spike** (A0,C1)
- Choose minimal Node 24 TypeScript relay service on existing VPS, e.g. low-memory HTTP MCP gateway + persistent outbound WebSocket device channel, or a proven standards-conforming alternative. Validate memory/CPU/connections before committing to a permanent stack: user's VPS also runs other services; keep it lean.
- Prove cloud MCP request → OAuth authenticated gateway → outbound connected device → local MCP → bounded response. Test offline device and reconnect.
- DoD: real end-to-end read-only tool call with no inbound desktop port, no local control token exposed to relay user, typed request routing and no unintended open proxy.

**D2 — Device pairing, identity and transport** (D1)
- Add account sign-in for remote management (trusted OIDC provider; do not design passwords). Use OAuth device authorization/one-time code pairing, device identity key and rotating short-lived scoped service credentials; explicit code confirmation on paired machine.
- Registry: account ↔ device ↔ allowed projects ↔ scopes ↔ expiry; revoke one/all, online/offline, last-seen, renewal/rotation; rate limits. TLS/WSS, authenticated routing, per-client OAuth for MCP; no query-token credentials.
- Provision DNS/HTTPS under a distinct subdomain such as mcp.aiboard.me through existing Nginx/Cloudflare Full(strict); exact domain remains a deployment decision. Never repurpose public FunBoard ports or expose local Runner. Use dedicated service user/systemd, health/readiness and resource budgets.
- DoD: unauthorized tenant/device cannot route; revoke immediately blocks new work; disconnect/reconnect recovers queue ids safely; replayed pairing code or stolen expired token rejected; VPS reboot self-recovers.

**D3 — Cloud MCP and durable remote jobs** (D2,C1)
- Expose OAuth-protected standards-based Streamable HTTP MCP endpoint on VPS. Forward only selected typed MCP tools; do not let relay evaluate process commands directly. Maintain bounded request correlation, version handshake, async job handles, status/progress/review approvals.
- Local Runner stays authoritative for job lifecycle and evidence; cloud relay stores minimal metadata/ack state and no repository contents by default. Define retention, log scrubbing and manual cleanup, and no work when desktop offline (queue only safe signed intents if explicitly enabled).
- DoD: external MCP client can start, inspect, pause/resume or cancel permitted Build; later poll after HTTP timeout/browser close; no duplicate mutation after retry; audit trail connects remote request to local job/actor/approval.

**D4 — Remote AIBoard Build dashboard** (D3)
- Keep static aiboard.me as client shell. Authenticated remote-only device/project picker, status, progress, logs/evidence review, approvals, disconnect/revoke; clean offline and recovery messages. The authenticated backend resides with relay. Keep existing local-only flow available.
- DoD: another computer can operate connected Build with no access to unpaired machine; browser refresh does not erase server-owned build; approvals show exact command/project/diff/scope.

### Milestone E: Optional OpenAI route and desktop GUI
**E1 — Secure MCP Tunnel adapter & docs** (C1)
- Integrate existing official OpenAI tunnel-client as OPTIONAL external process/service configuration pointing at local MCP. Provide aiboard tunnel openai init/doctor/start/status/stop (wrapping supported official binary without reimplementing its transport).
- Onboarding requires OpenAI Platform tunnel_id and scoped key/permissions; ChatGPT developer/custom plugin connection depends on plan/workspace and must be stated truthfully. The option must not be exposed as general cross-vendor SaaS relay.
- DoD: when a compatible OpenAI workspace is available, tests show read/write actions allowed by workspace from the official tunnel; without access, graceful "not entitled/not configured" with no silent fallback; tunnel stop does not interrupt local builds.

**E2 — GUI computer-use provider (opt-in, later)** (D3,C2)
- Define IDesktopAutomationProvider for Windows only initially. Prefer connecting an existing authorized Windows MCP/computer-use companion through capability discovery to avoid maintaining a second screen-control engine. Support screenshot/snapshot, click, type, scroll, keyboard, window/app discovery as capabilities, not assumed defaults.
- Enforce foreground unlocked interactive session; no bypass of Windows secure desktop, UAC, OS login lock or permission prompts; visible on-device control indicator; explicit per-action consent or carefully scoped user grants; screenshot-sensitive-content warnings; bounded frame sizes and ephemeral retention.
- DoD: cloud agent can take a screenshot and click/type only when user has enabled GUI control and approved the scope; pause/revoke halts controls; unattended/locked-session tests fail safely; no secret images dumped in logs.

**E3 — Release qualification & docs** (A3,B4,C2,D4,E1; E2 can ship later)
- Matrix: fresh Win11 standard user; restart/recovery; two projects; Windows + Linux/macOS once supported; live desktop ↔ VPS ↔ ChatGPT-compatible test client; Codex/Claude CLI auth/versions; protocol compatibility; revoked device; dropped network; model failure; browser disconnect; failed native test; child process cleanup.
- Run packet tests per change; full qualified existing runner suite only at agreed final gate, with explicit baseline outcomes. Archive/package parity, source-license display, signatures, SBOM/dependency review, external independent requirements review, security audit and rollback demonstration.
- DoD: every G-01..G-14 mapped to executed test evidence, documented caveats and owner signoff; no claim production complete merely because UI shows connection; production deployment only with separate permission.

## 6. Suggested local CLI and MCP API surface (target, not implemented)

~~~
# User terminal:
irm https://aiboard.me/install.ps1 | iex
cd D:\repos\FunBoard
aiboard
aiboard status
aiboard providers
aiboard connect          # optional own-VPS pairing
aiboard tunnel openai doctor
aiboard update
aiboard doctor

# Local external CLI registration: aiboard mcp serve --stdio
# Remote MCP: https://mcp.aiboard.me/mcp (PROPOSED endpoint only)
# Remote tools: aiboard_list_devices, aiboard_list_projects,
#               aiboard_start_build, aiboard_get_job_status,
#               aiboard_get_job_events, aiboard_get_evidence,
#               aiboard_request_review, aiboard_cancel_build
~~~

**Key difference from Desktop Commander:** preferred MCP actions are AIBoard-semantic BUILD operations (start task, get evidence, request review) rather than only low-level shell/file commands. Optional scoped file/GUI tools exist when a cloud agent needs direct inspection or intervention.

## 7. Security-critical test matrix (never waive)
- S-01 Wrong account, wrong device, cross-project path alias, junction/symlink escape, nonce replay, expired token, OAuth audience confusion: denied before side effect.
- S-02 A web page from an unexpected origin cannot discover/pair/control localhost runner; DNS rebinding and CSRF attack attempts fail.
- S-03 Remote user/device grant does not automatically equal Runner Full access. Existing exact grant/isolation and project/scope checks apply equally to MCP ingress and all AgentProviders.
- S-04 Gateway never accepts direct OS shell/opaque code as a substitute for typed Runner policy; no direct VPS code execution to touch user's local PC.
- S-05 Reviewer is independent when policy requires; cannot write or approve its own change; self-report does not bypass actual test/commit/evidence verification.
- S-06 Missing/malformed CLI stream event, killed process, network outage, expired task, queued duplicate: durable recorded failure/unknown, never fabricated PASS or duplicate destructive effects.
- S-07 Revocation stops future instructions, cancels in-flight where policy requires, and records uncertainty if a side effect finished just before revoke.
- S-08 Output/log/screenshot/token privacy: size limits, redaction, bounded retention, never URL query tokens. Explicitly document whether relay can inspect forwarded content.
- S-09 Owned process/spill/OCI/worktree teardown and recovery remain as certified; no new raw launch or cleanup paths.
- S-10 Installer signed manifest tampering, incomplete update, untrusted PATH, malicious current directory, dependent Node/browser not available, upgrade/rollback against encrypted provider config: bounded and diagnosed, no corruption.

## 8. Operational details / rollout
1. **Deliver first:** A1-A3 local single-command launch. This gives user benefit without cloud infrastructure and tests credential/state migration.
2. **Next:** B1-B4 agent mixer with direct-model parity first, then Codex and Claude. This can be tested independently of VPS.
3. **Then:** C1-C2 local inbound MCP. Establish typed semantics before connecting any WAN tunnel.
4. **Then:** D1-D4 outbound VPS bridge. Start with single owner/device, read-only external tools, enable mutating Build actions after authorization/replay/recovery gates.
5. **Optional parallel trial after C1:** E1 OpenAI Secure MCP Tunnel, if account/workspace actually permits custom write actions. E1 is not required for D.
6. **Last:** E2 GUI control, separately consented; E3 release qualification after the selected release scope stabilizes.

Suggested backend economics: minimal database entries for identity/device/job indexes; no source-code storage; bounded event/result payloads, concurrency, heartbeats and memory; reserve headroom on existing 1-vCPU ~2-GiB VPS. Measure before colocating anything heavy with FunBoard/voice/MySQL.

Suggested versioning: AgentEventV1, PlanningResultV1, WorkResultV1, ReviewResultV1, RemoteRequestV1; contract tests generated from public schema fixtures. Feature flags: localLauncher, roleProviders, inboundMcp, remoteRelay, openAiTunnel, remoteGui.

## 9. Completion report format for every task
- Packet ID and linked requirements; base SHA/worktree; changed files and migration notes.
- Implemented behavior vs previously existing behavior; assumptions validated.
- Executed targeted tests with full command, exit code, counts, skipped/failed details, test artifacts; independent reviewer verdict and exact revision.
- Negative/security scenarios run; output/cleanup/resource observations; no vague "all good".
- Unresolved risks, next dependency, any owner actions needed. Never push main automatically.

## 10. Handoff prompt to executing agent
> Implement this plan in order from section 5, starting with A0 and A1. First inspect the repo and current release state; do not make assumptions based on old checkpoints. Preserve Runner V2's existing authority/safety/lifecycle boundaries and existing product behavior. Use isolated worktrees, focused tests per packet, independent requirement-based review, durable status, and no unauthorized merges/pushes/deployment. Do not attempt the entire roadmap as one uncontrolled change. Record evidence and move to the next dependency-complete packet only after objective acceptance. The source plan is docs/plans/aiboard-unified-cloud-desktop-agent-platform-2026-10-15.md.
