# Runner V2 Cleanup Coordination Redesign

## Authority and scope

The owner approved the focused architecture review's recommended redesign and
then instructed implementation on 2026-09-05. This specification records that
approved direction. It is a prerequisite correction within P6.4e / Task 8.0B3,
not a new product feature, a P6 completion, or permission to start P6.5/P7.
The portable-execution-safety and robust-build master plans remain binding.

The earlier five-round repair campaign is exhausted and remains recorded as
such. This is the explicitly authorized architectural replacement workstream,
not an unrecorded sixth attempt. Retain the five-round governed repair ceiling
for each replacement packet; escalate unresolved mandatory failures at the cap.

## Constraints retained verbatim in the implementation plan

- Node support is `>=22.13.0 <23 || >=24.0.0 <25`; no patch-version pin.
- The portable process baseline is mandatory; Windows Job Objects are optional.
- SessionAuthority remains the semantic authorization owner; backend proofs never decide project completeness.
- Reject stale or foreign ownership before effects; never weaken identity, fencing, output integrity, or isolation checks.
- Final release requires verified process quiescence, output settlement, channel cleanup, backend ownership release, and isolation release.
- Recovery never silently relaunches, adopts unrelated processes, signals by PID alone, or fabricates successful evidence.
- Preserve uncertain historical records and all unrelated staged/unstaged changes.
- The old recordless CLI process chain is excluded; its exceptional termination still requires separate owner approval.
- No benchmark, P6.5/P7 execution, provider calls, dependency upgrades, commits, staging, or publication in this workstream.
- Every new guard/regression requires observed RED, restored GREEN, and a reverted material fault proving RED again.
- Validate the exact failure first, then affected contracts; broaden only for unbounded/global impact.

## Findings and evidence boundary

The read-only architecture review observed the retained MCP backend's exact
stale-effect failure and current-fence ACKs. Source-extracted in-memory probes
demonstrated: (a) a takeover between supervisor precheck and protected effect
causes fatal supervisor exit; (b) readers observe a torn ACK/output/checkpoint
update; (c) pending/blocked/unknown adopted sessions are skipped and run close
can finish without accounting for them; (d) POSIX force-stop can kill its own
terminal-proof witness. These are mechanism proofs, not a claim that each
historical integration failure has been reproduced on a real OS.

Independent code review also found memory-only evidence continuation, loss of
typed cleanup causes, and competing outer/inner cleanup deadlines. The exact
cause of the historical persistent-output authorized-stop failure is unproven.

## Chosen architecture

Keep ExecutionHost, SessionAuthority, the existing process/channel registry,
permission profiles, and protocol-family facades. Replace the implicit
post-adoption cleanup choreography with durable progress and explicit outcomes.
Do not collapse distinct security principals into one shared writer.

### A. Portable protocol transactions

An ownership change is an expected protocol result. Under the existing exact
owned-fence lock, validate the current owner immediately before an effect.
Return an explicit stale result without performing the effect or terminating
the supervisor. Missing/corrupt authority and an indeterminate applied effect
remain distinct failures; do not blanket-catch exceptions as benign staleness.

Output readers must observe one coherent checkpoint plus retained suffix and
ACK state. Serialize bounded metadata/file snapshots with ACK retirement using
the same ownership boundary, or use a revisioned snapshot with retry on an
observed revision change. Do not hold coordination while awaiting consumers,
process exit, OS inventory, or arbitrary asynchronous work.

ACK retirement must validate identity/metadata/contiguity before deletion.
An interrupted multi-file retirement must preserve enough exact intent to
resume idempotently or report a typed blocker; never reinterpret unexplained
missing files as successful consumption. Backpressure and byte bounds remain.

### B. Durable adopted-cleanup coordinator

Each adopted session has one durable cleanup work item, owned and fenced by
SessionAuthority, with individually recorded process/output/channel/backend/
isolation progress and a sanitized categorical blocker. Repeated attempts and
restart resume this work item, not a new competing set of completion promises.
Transient callbacks may request cleanup; they do not independently certify it.

Every unreleased adopted state must receive an explicit recovery disposition:
active, stopping, input_unavailable, backend_unavailable, outcome_unknown,
cleanup_pending, and cleanup_blocked. Retry only when current authenticated
facts permit it. If recovery cannot prove safe progress, surface the exact
remaining resource and blocker. Do not silently omit non-active rows.

Run close must consume recovery results and independently verify that every
owned record reached release before reporting successful cleanup. Store closure
must not erase the ability to inspect or retry an unresolved work item.

Use one absolute deadline from the outer operation throughout nested cleanup.
On expiration persist the pending/blocked disposition and retain tracked
ownership of late effects. A timed-out wrapper must not create an untracked
settlement or publish a stale late success. A subsequent attempt cannot overlap
an existing effect merely because its caller stopped waiting.

Existing authenticated rows remain readable. Old rows without new progress
metadata are conservatively initialized under the current fence from provable
facts; never infer released subresources from the absence of metadata.

### C. Restart-safe evidence

Durably bind evidence identity/position and loss state to the session. A fresh
runtime resumes the authenticated continuation, or preserves finalized immutable
segments with a durable manifest. Replaying a consumed protocol chunk must not
redeliver it to the family, duplicate evidence, or omit earlier evidence silently.
If the pre-redesign format cannot reconstruct earlier evidence, retain artifacts
and explicitly record the bounded evidence gap rather than claim losslessness.
Protocol bytes and optional lossy diagnostic spooling remain distinct.

### D. Supervisor survives workload force-stop

On POSIX, the supervisor/control witness must not share the workload's
destructive force-stop target. Establish an independently identified workload
group and retain supervisor output/terminal observation until workload
quiescence and ACK settlement are certified. Group identity must be captured
before executable release; a recycled group or unavailable witness blocks
control rather than inviting PID-only recovery. Windows retains its existing
portable birth-checked adapter and optional Job adapter.

### E. Final proof conjunction

The coordinator records separate facts: workload quiescent; retained protocol
output settled; evidence finalized or truthfully marked lossy; channel detached;
backend authority released; isolation released. Only the complete required set
permits SessionAuthority's final release transition. Physical process absence
alone does not grant permission to delete uncertain records.

## Verification and release

Deterministic schedules cover takeover before/at/after protected effects;
checkpoint/ACK/file update boundaries; cancellation and deadline boundaries;
fresh-runtime recovery from every unreleased state; fresh real-spool continuation;
and force-stop while output remains buffered. Assertions target production
behavior, not source text or a mock's own behavior.

Then run the previously failing exact MCP and persistent-output checks, affected
runtime/store/backend/MCP/host/CLI contracts, configured Runner typecheck and lint,
followed by the bounded shared graph and the broader Runner gate where impact
cannot be proven local. Real Linux and Windows evidence must be distinguished
from modeled contracts; report macOS applicability truthfully. Owned process,
port, container, spill and temporary-root cleanup must be verified for each new
fixture. Historical uncertain residue is tracked separately, never deleted to
make an inventory green.

An independent final review and current mechanical evidence are mandatory.
The only phase exits remain:

- PHASE VERIFIED 100% COMPLETE — NEXT PHASE MAY BEGIN
- PHASE BLOCKED — GENUINE USER DECISION REQUIRED

Finishing this redesign resumes the remaining B3/P6 gates; it does not itself
unlock P6.5 or the real-world P7 build.
