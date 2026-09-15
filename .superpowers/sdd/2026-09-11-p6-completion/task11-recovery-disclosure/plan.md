# Task 11 / P6.4h implementation ledger

Goal: bounded exceptional process recovery and truthful durable/API/client disclosure.
Approved spec: docs/superpowers/plans/2026-08-28-runner-v2-portable-execution-safety.md, Task 11.
Base: 284743e980514ecebc1d3143d427f4f3abf86225. Branch: codex/runner-v2-robust-build.
Task 12 remains PENDING. No push, package changes, raw-launch shortcuts or unrelated edits.
Baseline: 5,143 file hashes; empty index; 1,708 expanded unrelated dirty entries.

## Architecture
Use the approved Task-1 structured recovery actions, not arbitrary shell evaluation. A proposal carries an exact captured run/task/session/invocation, ownership/revision and backend/birth fingerprint. Model text is never execution authority. Only orphaned, identity_mismatch, backend_unavailable and outcome_unknown are eligible. Routine lifecycle modules do not depend on model/controller code.
The shared process kernel rechecks native backend identity and ownership at the effect boundary. Inspection never certifies cleanup; termination additionally needs an exact user decision and current Runner grant. Artifact removal without an independently provable ownership recipe is refused, not guessed. No model-supplied executable or boolean creates authority.
Scheduler events persist closed fingerprints/categorical summaries rather than raw rationale/arguments, and prevent effect replay and resume through unresolved recovery. Native composition/control endpoints provide explicit proposal/decision/execution operations; no automatic model cleanup. Observability projects subprocess/streaming backend, capabilities, confinement, grants/leases, loss and cleanup facts, with explicit unavailable historical data.

## Ordered work and acceptance
- [x] Verify Task 10 commit, linked worktree, empty index, no active task owner; capture protected baseline.
- [x] Core RED: closed proposal parser, routine-state rejection before generator/effects, all four exceptional states, identity/birth/run/task/call/revision/scope/expiry/capability refusal.
- [x] Implement process-recovery contracts/controller and append-only scheduler recovery transitions; SQLite restart, redaction, exact approval, execution claim, replay and unknown-outcome tests.
- [x] Kernel RED then implementation: exact attested backend/ownership, no PID-only signal, grant/expiry checks, approved termination using existing shared lifecycle and cleanup proofs.
- [x] Native factory/manager/control integration; real test-owned host plus API/auth/serialization and historical nonmutating coverage.
- [x] Disclosure RED then projection and client rendering for enforced/partial/unavailable/unverified, explicit Full bypass, output loss, cleanup and recovery states.
- [x] Audit ordinary launch/stop/cancel/timeout/restart/lease paths remain model-free.
- [x] Material routine-state and PID-only reversals: fail for the intended reason, restore exact bytes, pass again.
- [x] Independent review against original requirements; resolve verified findings with targeted tests.
- [x] Final affected graph once, TypeScript, Runner ESLint, client script and authored whitespace; clean accepted resources and protected baseline.
- [x] Task-11-only acceptance/commit and post-commit proof. Task 12 stays unstarted.
