# Task 8.2 MCP — approved P6 continuation

Authority: owner requested P6 task-by-task completion, waived independent review, and requested continuation after MCP reconnection. Task8.1 is committed at8ef74b46; postcommit source verification367/367, protected222/222 and fresh typecheck/caller audit passed. The prior false final response and precommit-verifier HEAD failure are corrected in ../resume-2026-09-12/postcommit-verification.json.

Canonical requirements: Family packet8.2 in .superpowers/sdd/2026-08-28-runner-v2-portable-execution-safety/task-8-brief.md and the approved portable-execution plan. This is execution of that design, not a new architecture approval or independent-review requirement.

## Ordered tasks / Definition of Done
1. [x] Closed configuration: fixed path/network/credential envelope, default no extra authority; portable exact argv parsing; typed refusal instead of any shell fallback; config/executable re-attestation and digest tests.
2. [x] Exact session request operation: the first adopted request uses the retained launch claims once; later requests consume their exact fresh ToolBroker grant; composite request write/delivery rechecks the same request authorization, with no global or reusable write permission and no other operation weakening.
3. [x] Bounded JSON-RPC protocol: strict byte/ID/schema framing, partial/coalesced reads, bounded write/backpressure/request timeout, cancellation and unknown-after-write classification; no replay of external calls; request/error/artifact compatibility.
4. [x] Lazy manager: discovery advertises ready/tools without live child; scoped by real run/actor/agent session/server/fixed envelope; exact current executable/schema check before start/restart; bounded restart/session counts, no launch without fresh grant, invalid ownership closes affected child.
5. [x] Host/factory/agent wiring: per-run ephemeral discovery unchanged in purpose, live creation only from actual calls; agent/run termination closes exact owners; graceful stdin shutdown then shared escalation, verified cleanup and retained failure evidence; recovery observes/cleans but never relaunches without new grant.
6. [x] TDD/material faults, current affected graph, real native integration plus eligible strict OCI check, configured typecheck/lint, controller requirement review and exact resource ledger. Do not label earlier subset evidence a complete family result.

No Task8.3+ migration, Task9 hardening, product model invocation, broad historical cleanup, alternate account/tool setup, dependencies/Node policy changes, remote push or publication. Preserve existing unrelated package/ZIP/benchmark changes. Use Windows MCP for all repository/tool/test/evidence operations. Retain exact failed roots; no PID-only fallback. Native tests require safety preflight. Full whole-P6 suite stays at its final exit gate; use impact-based tests here. Record each source change and test receipt; do not reset prior C/B3/8.1 histories.

## Implementation refinement
Use the approved run-owned streaming/session authority, not a new process manager. Add the request-level composite seam missing from the existing write-only/family-delivery facade so one real call authorizes its bounded request+response without minting internal grants. Keep the existing write and family_delivery entry points strict for other families. Run-local manager serialization bounds requests and prevents external-call replay. Existing config/handshake/discovery evidence is the base for lazy live reuse; no silent union of access or stateless fallback.


Acceptance: task8-2-gate.json and report.md, 2026-09-12. All original obligations reviewed; next packet8.3 remains unstarted.
