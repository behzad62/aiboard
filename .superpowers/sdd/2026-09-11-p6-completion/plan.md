# P6 completion — ordered continuation, 2026-09-11

Owner instruction: "ok finish P6 task by task" following the explicit remaining queue and C commit7f6fbcb15c67dfe87984131c1d208636056611e9. This resumes the approved P6 architecture/requirements; no repeat approval of known steps or repair-count reset. Controller self-review follows the owner's preceding review instruction. No product-model calls, unrelated benchmark changes, destructive historical cleanup, push/publication or P6.5/P6.6/P7 execution. No new dependency/Node-policy changes unless an actual approved task requires one. Existing package/ZIP/benchmark edits remain preserved.

Canonical sources: docs/superpowers/plans/2026-08-26-runner-v2-robust-build-improvements.md (HVI-6A.4-HVI-6A.8); docs/superpowers/plans/2026-08-28-runner-v2-portable-execution-safety.md; .superpowers/sdd/2026-08-28-runner-v2-portable-execution-safety/task-8-brief.md; task-8.0b3-brief.md. C acceptance supplies hash-bound inherited evidence, not automatic parent-phase completion.

| Step | Purpose / Definition of Done | State |
| --- | --- | --- |
| B3 close-out | Audit original B3.1-B3.4 and exact accepted source/real integration; preserve historical exclusions; explicit8.0B exit unlocks8.1 | VERIFIED at7f6fbcb1; b3-closeout-proof.json |
| 8.1 Git | Explicit injected runtime-backed Git runner, exact run/call/grant scope, binary/typed/error compatibility, no ambient/global/raw fallback; all production owners wired and focused tests/faults | VERIFIED:605/605 Windows affected checks;91/91 actual Linux contracts;15 material guards; Task8.2 eligible |
| 8.2 MCP | Attested lazy exact-agent/run/envelope sessions, bounded protocol, fresh per-call authority/restart limits, discovery and cleanup; compatibility tests/faults | VERIFIED: final503/503 Windows;132/132 Linux;16 material guards; Task8.3 eligible; historical exclusions preserved |
| 8.3 LSP | Shared session lifecycle; exact authority from code/filesystem diagnostics; framing/restart/attestation/cancellation preserved; focused tests/faults | PENDING |
| 8.4 managed | Portable shared-session facade; extracted Job host cannot depend on facade; distinct start/stop/poll cancellation; durable compatibility and cleanup tests | PENDING |
| 8.5 launch audit | Negative local-provider inventory or actual migration; precise adapter allowlist and aliased/dynamic/shell/ambient bypass mutations; Task8 exit | PENDING |
| 9 Git hardening | Central safe environment/config/indirect execution policy; hostile hook/filter/helper/etc fixtures remain inert; typed refusal and exact grant/cleanup | PENDING |
| 10 filesystem fence | Sole revalidated mutation seam, expected revision, create-only/move/delete identity and alias/hardlink checks; documented non-CAS external race | PENDING |
| 11 recovery/disclosure | Narrow exceptional proposals with identity/authority/expiry validation and durable redacted audit; routine lifecycle model-free; truthful API/client projection | PENDING |
| 12 package/platform/P6 gate | Reverse cleanup, reproducible archives, package smoke, maintained Node22/24 and Windows/Linux/macOS CI, full suite, resource accounting and final requirement audit | PENDING |

Verification: test-first causal RED, minimal implementation, material fault RED/restored GREEN; exact failed checks then affected graph. Full configured suite reserved for stable whole-P6 acceptance. Source hashes bind evidence; do not rerun unchanged checks just for ceremony. CI definition is not actual CI success. External CI results/publication permissions are checked when the final platform gate is reached; do not preemptively stop useful local work.

Environment: existing Windows linked worktree on codex/runner-v2-robust-build, Node24.18.0 as observed evidence (not product pin), installed dependencies and existing Docker engine/cached images. All Windows/repo/build/test/evidence work through Windows MCP. Failures/uncertain roots are retained and never relabeled cleaned by PID absence. Use exact retained capabilities only for cleanup.

## Reconnected checkpoint â€” 2026-09-11

Windows Snapshot, PowerShell and direct file reads are available. The previous host-integration patch was already applied, with a genuine missing-host-Git RED recorded; do not apply it again. Host wiring and the binary output path now pass the real integration test. Final current graph95/95, typecheck/lint0, eight material faults detected/restored. See reconnected-final-verification.json and reconnected-progress.md. Some long PowerShell calls timed out while their owned processes completed; terminal receipts, not those transport timeout messages, determine test outcomes. No caller migration, new commit, publication or next-family completion is implied.

## Task8.1 accepted — 2026-09-11

Foundation committed first as7e814765. Caller migration is verified; see task8-1-final/report.md and task8-1-gate.json. Next is8.2 MCP, not P6.5. P6 remains in progress. Controller self-review accepted the original8.1 requirements; independent external review is not required. Source367/367, Windows605/605, Linux91/91, static checks0, no accepted-run native resource retained. One closed no-launch diagnostic is preserved with empty process/session tables. Protected222 unrelated files remain unchanged.


## Task8.2 accepted — 2026-09-12

Task8.2 implementation and original family requirements are self-reviewed and verified; see task8-2-mcp/report.md, task8-2-gate.json and input/evidence manifests. Final Windows503/503, Linux132/132 including native POSIX descendant lifecycle, sixteen material reversals detected, TypeScript/ESLint0. Final accepted Windows acquisitions518/518 removed by verified owners. Earlier failed/synthetic diagnostics and three older cleanup-blocked native records remain explicit historical exclusions, never relabeled released. Protected222 files unchanged. Next is8.3 LSP; P6 remains incomplete and P6.5 locked. No later task started or remote publication.
