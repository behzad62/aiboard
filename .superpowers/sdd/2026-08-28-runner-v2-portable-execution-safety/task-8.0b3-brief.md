# Task 8.0B3 Brief — Strict OCI, ExecutionHost Construction, and Real Integration

## Authority and entry

- Canonical authority: `docs/superpowers/plans/2026-08-28-runner-v2-portable-execution-safety.md` and `task-8.0b-brief.md`.
- Entry revision: `4bf64cf398a2f8d57b464182efbc2aa492dee78d`.
- B1 and B2 are independently verified with zero Critical/Important findings.
- Node support remains exactly `>=22.13.0 <23 || >=24.0.0 <25`; B3 must not introduce a patch-version pin.
- The portable process baseline remains mandatory. Windows Job Objects remain an optional current-host adapter, never a product requirement.

## Purpose and exit

B3 closes packet 8.0B by proving strict interactive OCI execution, creating one CLI-owned host composition root with isolated per-run authority, closing internal pre-run/discovery principals, and exercising the resulting graph with adversarial integration fixtures.

The only successful exit is:

`PACKET 8.0B VERIFIED 100% COMPLETE — FAMILY PACKET 8.1 GIT MAY BEGIN`

That exit requires current evidence, empty owned residue, and an independent review with zero Critical/Important findings.

## Explicit exclusions

- No 8.1 full Git runner or Git hardening.
- No 8.2 richer lazy/live MCP protocol, external-endpoint implementation, restart-policy, public tool model, or manager-close redesign beyond the owner-authorized ownership/status rule below.
- No 8.3 LSP protocol/lifecycle migration.
- No 8.4 managed-process behavior migration.
- No Task 10, 11, 12, P6 benchmark, or P7 real-world build.
- No host executable mount, native fallback, or weakened claim while strict OCI confinement is requested.
- No mandatory Windows-only branch and no universal hard-coded short process deadline.

## Requirement ownership

Each mandatory B3 requirement has exactly one owner below.

### B3.1 — Strict OCI interactive attach

Owns:

- A separately attested `interactiveAttach` capability.
- Strict duplex planning with `create --interactive` and exact `start --attach --interactive <identity>`.
- Typed failure before container creation when interactive attach is unavailable or the requested executable is absent from the image.
- Proof that strict execution never mounts a host executable and never falls back to native while claiming confinement.
- Fake-CLI and configured real-Docker duplex, cancellation/disappearance, cleanup, and zero-container evidence.

Expected surfaces: OCI provider, isolation contracts/selector, OCI tests, strict streaming composition seam.

### B3.2 — One host kernel and isolated run bindings

Owns:

- One CLI-owned `ExecutionHost`, created only after validated roots/config and state/artifact roots.
- Host ownership of the filtered ambient environment source, backend/channel registries and optional low-level Job host, output factory, host-control durable kernel, and streaming runtime.
- Per-run bindings that add only the run permission profile, capability contract, grant authority, isolation selector, and `SessionAuthority`.
- Isolation of grants, writers, queues, sessions, leases, outputs, channels, and cleanup effects between runs.
- Bounded/nonblocking recovery that never relaunches and yields exact reattach or typed unavailable/unknown.

Expected surfaces: new host/run-binding module(s), CLI construction seam, native factory composition, resource cleanup, streaming/subprocess construction tests.

### B3.3 — Closed internal principals and construction order

Owns:

- `RunnerInternalExecutionContext` with distinct closed principals, call identities, least envelopes, purpose-specific bounds, and verified cleanup; no fabricated architect/worker identity.
- Pre-run Git preflight as the sole pre-run child purpose.
- Nonspawning MCP/LSP configuration and executable attestation.
- A per-run ephemeral `McpDiscoveryExecutor` that performs only initialize, initialized notification, and `tools/list`; records exact schema/config/executable digests; performs protocol close and verified cleanup; cannot call tools, expose a channel, return a live manager, persist, or reuse a session.
- Production construction order: validate roots/config; create one host; bounded Git preflight; nonspawning MCP/LSP attestation; bind host per run; nonblocking recovery; bounded discovery; per-run public facades; architect/worker/subagent registries and models last.
- Behavior-neutral relocation for LSP/managed construction and all MCP protocol behavior except the owner-authorized ownership/status rule recorded 2026-09-01: Runner-launched command-based stdio MCP servers are owned per Build and completely cleaned with that run; idle configured servers report `stopped`; active runs project actual manager status; Runner never discovers, adopts, signals, restarts, or terminates a similar pre-existing OS process. Future external endpoint support is connect/disconnect-only. Task 8.2 still owns the richer protocol, external-endpoint implementation, restart policy, public tool model, and manager-close redesign.

Expected surfaces: Git preflight context seam, MCP discovery/attestation module, CLI/control-server/native-factory constructors, dependency-graph and ordering tests.

### B3.4 — Real integration, adversarial audit, and closure

Owns:

- Runner host crash after isolation/host launch and before transfer acknowledgement: exactly one cleanup transition and no process, lease, endpoint, or fabricated adopted session.
- Persistent child output beyond the memory tail between ToolBroker calls while family delivery/writes remain unauthorized; spill failure preserves protocol bytes.
- Two concurrent runs with no cross-run authority or data effects.
- Configured strict interactive Docker fixture, or truthful Docker-unavailable evidence without production weakening.
- Task 7, 8.0A, B1, B2, focused B3, static/type/lint/diff, and owned process/port/supervisor/spill/state/endpoint/container residue gates.
- Final adversarial mutations, documentation evidence, rollback readiness, and independent review.

Expected surfaces: focused integration fixtures/tests, B3 report, existing residue support, no unrelated production expansion.

## Execution queue

For every packet:

1. PREPARE the exact impacted contract and current baseline.
2. Add one focused guard/regression test and prove it RED for the intended reason.
3. Revert/disable the guard only as needed to prove the pre-change baseline, then restore it.
4. Implement the smallest coherent production change.
5. Run the exact failed check, then affected files/modules/contracts.
6. Audit every requirement owned by that packet and automatically repair deterministic failures.
7. Prove a material guard fault RED, restore, and prove GREEN.
8. Expand validation only when impact cannot be safely bounded.
9. Clean owned residue and record current evidence.

Initial eligible packet: **B3.1 strict OCI interactive-attach attestation and fail-before-create planning**.

## Acceptance and recovery rules

- Every durable effect is attributable to one host/run/principal/call identity.
- Recovery observes or adopts existing durable identity; it never silently relaunches.
- Cleanup is idempotent, bounded by semantic state rather than host speed, and never deletes uncertain/historical residue.
- A failed construction closes only resources acquired by that construction, in reverse order.
- Public family behavior stays unchanged unless the canonical B3 prerequisite explicitly owns it.
- Rollback is the packet's coherent source/test diff plus owned fixture state; durable schema changes, if any, require backward-safe parsing or explicit migration proof.

## Definition of Done

- B3.1–B3.4 requirements are each proven by focused current evidence.
- Every new guard/regression has recorded RED/reverted/GREEN proof.
- Exact failed checks and affected gates are green; broader gates are current where impact is global.
- Docker applicability is reported truthfully.
- Owned residue is empty and uncertain residue is preserved.
- Independent review reports zero Critical/Important findings.
