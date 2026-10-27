# AIBoard Remote — Implementation Status

Plan: ./2026-10-27-aiboard-remote.md | ai-discussion-board `d7ed04d2` (branch docs/aiboard-remote-plan; R0 work on remote/r0-audit) | aiboard-tunnel `69dc065`

NOT STARTED · ACTIVE · BLOCKED · REVIEWED · ACCEPTED

| Packet | Title | Depends on | Status | Owner (delegate) | Evidence / commit |
| --- | --- | --- | --- | --- | --- |
| R0 | Audit, ADRs, contracts | — | ACCEPTED (architect review; owner OK 2026-10-27) | architect; codex (T1 catalog, T2 ADR-A/C/D, T3 ADR-B/E/F/G, T4 contracts, T6 D17 revision, T7 hand-off), muse (T5 ledger); agy T2 attempt hit quota | docs/remote/r0/; commit on remote/r0-audit (see Log) |
| L1 | `aiboard` CLI | R0 | ACTIVE (L1a) | codex | — |
| L2 | Installers and updates | L1 | NOT STARTED | — | — |
| R1 | Connector inside Runner V2 | R0 | ACTIVE — R1a + R1b + R1c REVIEWED (architect) | codex, muse-wonder (R1c fix) | R1a: remote-actor-binding + broker/roles/grants/managed-process/permission/ledger/streaming suites 154/154, typecheck:runner-v2 0, eslint 0; R1b: remote-admission + remote-actor-binding 16/16, typecheck 0, eslint 0 (2026-10-27); R1c: remote-extension-policy + extension-mcp(-remote) + mcp-tools + extension-management/contracts/runtime/plugin + chat-agent-extensions + remote-actor-binding + remote-admission 120/120, both typechecks 0, eslint 0. Original same-reply install-and-use test byte-identical to HEAD (a first delegate pass had weakened it; rejected). Architect added: explicit denies carry across re-review of a changed inventory (red/green verified) |
| S1 | Whole-machine remote scope | R1 | NOT STARTED | — | — |
| R2 | Durable jobs, idempotency, cancellation, flow control | R1 | NOT STARTED | — | — |
| R3 | Large outputs and artifacts | R1, R2 | NOT STARTED | — | — |
| R4 | Transport hardening for a single VPS | R1, R2, R3 | NOT STARTED | — | — |
| P1 | Identity, devices, pairing | R1 | NOT STARTED | — | — |
| P2 | Standards MCP gateway + OAuth authorization server | P1, R2 | NOT STARTED | — | — |
| P3 | Usage metering and Paddle billing | P1, P2 | NOT STARTED | — | — |
| P4 | Dashboard at mcp.aiboard.me | P1, P2, P3 | NOT STARTED | — | — |
| Q1 | Security qualification | R4, S1, P2, P3 | NOT STARTED | — | — |
| Q2 | Reliability qualification | R4, R2, L2 | NOT STARTED | — | — |
| Q3 | Staged launch | Stage-gated (Stage 0: L1, R1, S1, R2, P1, P2; Stage 1: R3, R4, P4, Q1; Stage 2: P3, Q1, Q2) | NOT STARTED | — | — |
| X1 | Plugin catalog incl. desktop GUI control | R1, P4; after Stage 2 | NOT STARTED | — | — |
| S2 | Optional OS sandbox "safe mode" | S1; post-launch | NOT STARTED | — | — |
| X3 | Build-level remote tools | P2, R2; post-launch | NOT STARTED | — | — |
| X2 | Optional extras | — (each extra gated separately) | NOT STARTED | — | — |

## Owner prerequisites

- [x] VPS disk freed (done 2026-10-27, root 37% used)
- [x] Google + GitHub OAuth apps (done)
- [x] Paddle sandbox account (done)
- [ ] Cloudflare `mcp` A record → 178.79.134.104 proxied (pending, needed before Stage 0)

## Log

- 2026-10-27: Plan settled with owner decisions D1–D14; R0 started in worktree D:\repos\ai-discussion-board-r0.
- 2026-10-27: Owner decisions D15 (low-level remote tools first), D16 (2026-10-15 plan superseded except Milestone B; C1 folded into L1; P7 superseded), D17 (Desktop Commander-style freedom by default, opt-in controls, S2 sandbox post-launch), D18 (GitHub Releases + CI signing in a protected environment). Architect decisions in plan §1.2.
- 2026-10-27: R0 baseline (architect; Windows 10, Node 24.18.0): `npm run typecheck:runner-v2` exit 0 (14 s) on d7ed04d2 code; aiboard-tunnel `npm test` exit 0 (14 s) at 69dc065.
- 2026-10-27: R0 verification (architect): 511 `path:line` citations in docs/remote/r0 resolve to existing files/lines (one intentional branch-only reference); catalog 107 tools, 0 duplicates, every id found at its cited line; 7 JSON Schemas compile under Ajv 8.17.1 strict + ajv-formats 3.0.1, and all 80 fixtures behave as expected (valid pass; invalid fail; 6 documented contextual negatives pass schema by design). Error-code alias `conflict_idempotency` removed before release.

## Open items carried from R0

- Windows-MCP release pin and tool keys (X1); VPS device/concurrency ceiling (R4 measurement); git_commit remote task context (R1/R2); artifact-to-principal authorization (R2/R3); S2 per-OS confinement providers.

## Audit status

2026-10-27 code audit: DOCUMENTED ONLY (not a test certification).
