# Runner V2 Task 12 — Bounded-Gate Implementation Plan

> **Agent mandate:** This document is the authoritative execution plan for the remainder of Runner V2 Task 12 / P6 acceptance. Execute gates in order. Do not replace this with ad-hoc CI repair.

## Goal

Bring Runner V2 to final Task-12/P6 acceptance by closing each remaining safety and cross-platform invariant independently, with targeted evidence and review at every gate.

## Core rule

Task 12 is not "make CI green." Each gate must prove a bounded property. A gate is incomplete until implementation, targeted tests, evidence, and independent review all pass.

## Global constraints

1. Preserve Runner V2's fail-closed safety model.
2. Never perform destructive process control from PID/PGID identity alone when ownership continuity is uncertain.
3. Never allow a stale owner or fencing token to renew/control a replacement session.
4. Workload quiescence, supervisor termination, output settlement, evidence durability, and resource release are distinct states.
5. Configuration trust boundaries are based on canonical target identity, not lexical paths alone.
6. Do not obtain green CI by skipping affected portable tests, weakening assertions, converting failures to warnings, swallowing `outcome_unknown`, or broad timeout inflation.
7. During Gates A-F, run targeted affected tests only; reserve the full integrated matrix for Gate G.
8. Do not rerun accepted Tasks 8-11 unless a concrete Task-12 regression requires it.
9. Every gate gets a small reviewable commit/series and an independent invariant-focused review.
10. Do not merge PR #94 or any successor acceptance PR until Gate G passes.
## Task 12-0 — Controlled repair baseline

**Purpose:** remove repository-state ambiguity before more fixes.

Required actions:
- Record current HEAD, parent/base, intended Task-12 ancestry, and changed-file count.
- Inventory Task-12-only fixes that exist outside the clean intended history.
- Extract only legitimate Runner V2 hunks; never cherry-pick giant checkpoint/generated-evidence commits wholesale.
- Exclude benchmark outputs, calibration artifacts, generated evidence, and unrelated dirty work.
- Resolve/isolate concurrent edits before touching the same files.
- Start implementation only from a clean, reviewable state.

Known local fixes that must not be lost if still applicable:
- POSIX stale-PGID re-attestation after anchor exit.
- POSIX malformed/nonpositive membership parsing fail-closed behavior.
- Canonical capabilities-config confinement against parent alias bypass.
- Their deterministic regression tests.

**DoD:** clean status; exact baseline recorded; no unrelated giant checkpoint in repair history; no concurrent writer on the same files; reviewer can understand Task-12 history without generated noise.

---

## Gate A — Exact ownership, authorization, and fencing

**Invariant:** a caller may stop, renew, or destructively control a session only while the exact ownership/fencing authority that was authorized is still current. A stale caller must never adopt a newer owner's fence.
Current defect class to eliminate:
- authorization is validated, then lease renewal rereads the current session and may use its current owner/fence/revision;
- a takeover between those steps can let a stale caller act using the replacement authority.

Implementation requirements:
- carry the already-authorized expected session/owner/fencing token through renewal and `begin_stopping`;
- never obtain authority by rereading and adopting the current fence;
- prefer an atomic verify+renew+begin-stopping boundary where the store supports it;
- otherwise chain exact expected owner/fence and returned revision so any intervening takeover fails closed.

Required deterministic tests:
- takeover between authorization and renewal: stale A cannot renew or stop B;
- takeover between renewal and `begin_stopping`: stale transition rejected;
- expired stale authority cannot exploit renewal to regain control;
- normal legitimate owner stop succeeds;
- same textual owner with a new fencing token still rejects the stale token.

Targeted validation: session authorization, lease/fencing, streaming-session stop, and directly affected execution-host tests.

**DoD:** no stop path adopts authority from a reread; deterministic takeover tests pass; legitimate stop still works; independent reviewer traces exact fence continuity through durable stopping.

---

## Gate B — POSIX ownership and destructive control

**Invariant:** Runner V2 must never signal a POSIX process/group after ownership continuity can no longer be proven. A numeric PGID alone is not proof.
Implementation requirements:
- after anchor/launcher exit, re-attest surviving owned descendants before any group signal;
- verify continuity using recorded member identity plus the strongest available birth/identity witness;
- classify results as owned+ready, owned+empty, temporarily unprovable, or identity mismatch/reuse;
- signal only owned+ready; empty is a no-op; unprovable/mismatch never permits blind signal;
- audit every negative-PGID/group-control call for the same proof chain.

Membership parsing requirements:
- malformed or nonpositive rows fail closed;
- positive PID with PGID 0 may be handled only as the known legitimate exception;
- PID 0 with positive PGID, negatives, malformed numbers, and structurally invalid rows must not be silently discarded as if the group were empty.

Required tests:
- anchor exited + cannot re-attest => no signal;
- recycled PGID now owned by unrelated group => no signal;
- exact owned descendants re-attest => signal allowed;
- formerly owned group now empty => no destructive syscall;
- transient inspection failure => bounded retry/uncertain, never blind kill;
- parser cases for PID0/PGID+, PID+/PGID0, negative, nonnumeric, and malformed rows.

Targeted validation: POSIX backend, portable supervisor POSIX tests, launcher-exit descendant fixtures, focused Linux/macOS native fixtures.

**DoD:** no stale-PGID kill path; every group signal has fresh ownership proof; malformed evidence cannot become false empty-group evidence; reviewer searches all group-signal sites and confirms the proof chain.

---

## Gate C — Windows native ownership and cleanup

**Invariant:** Job/process ownership remains exact through startup, descendant containment, stop, cleanup, evidence settlement, and release.
Current failure classes include cleanup verification, exact ownership loss, fence-lock contention, EBUSY/coordination failures, descendant cleanup uncertainty, destructive-control watchdog settlement, and supervisor readiness.

Implementation requirements:
- independently review any current coordination-retry patch before accepting it;
- distinguish transient coordination failures from terminal authority/identity failures;
- retry transient fence/SQLite/sidecar coordination only inside a bounded real wall-clock deadline;
- never retry stale fence/identity mismatch into renewed authority;
- do not report release when cleanup cannot be verified;
- preserve exact Job containment for descendants that survive the launcher.

Required tests:
- transient fence coordination contention resolves and settlement succeeds;
- persistent coordination contention reaches bounded failure/unknown, not infinite retry;
- stale fence resembling lock contention fails closed;
- descendant survives launcher and remains exactly Job-owned;
- unverifiable cleanup is not reported as release success;
- supervisor readiness distinguishes genuinely slow startup from a broken ownership protocol.

Targeted validation: Windows native adapter tests, portable channel tests, Job/descendant cleanup fixtures, managed native portable-contract tests.

**DoD:** Windows ownership/cleanup failures are fixed behaviorally; retryable coordination does not poison a healthy channel; stale authority remains terminal; wall-clock settlement is bounded; no broad timeout increase is the fix.

---

## Gate D — macOS canonical paths and configuration trust

**Invariant:** trusted configuration/state cannot enter the project through user-controlled aliases, while legitimate host-native canonical aliases continue to work.
Implementation requirements:
- capabilities-config confinement checks the canonical target, not only the lexical spelling;
- reject outside-looking paths whose parent symlink/junction resolves inside the project;
- treat macOS host-native aliases such as `/var -> /private/var` narrowly as canonical host aliases, not as permission to allow arbitrary symlinks;
- preserve equivalent safety on Windows aliases/junctions;
- keep strict symbolic-component rejection for user-created indirection where the contract requires it.

Required tests:
- lexical config path outside project, parent alias points inside => reject;
- true canonical target outside project => accept;
- macOS `/var` versus `/private/var` host alias => accepted where allowed;
- user-created lookalike alias => reject;
- Windows alias/junction confinement equivalent;
- extension/state directory validation accepts host-native canonical aliases without allowing arbitrary symlinks.

Targeted validation: capabilities-config tests, capability-contract tests, CLI config tests, macOS path fixtures.

**DoD:** canonical project confinement is proven; parent-alias bypass is impossible; macOS native aliases work; arbitrary symlink policy stays strict; Windows canonicalization remains safe.

---

## Gate E — Lifecycle settlement and real Docker/OCI

**Invariant:** workload stopped, destructive-control settlement, supervisor terminal state, output settlement, evidence durability, and resource release are separate conditions. `reconcile: exited` must never imply all of them automatically.

Required actions:
- audit every caller that consumes workload reconciliation/exited state;
- preserve later output/supervisor/evidence/release checks even when workload retirement is durable;
- verify real Docker lifecycle semantics rather than container-exit alone;
- preserve diagnostic evidence when a terminal supervisor witness remains unexpectedly alive.
Required tests:
- workload exits while supervisor remains alive for valid settlement work => workload may reconcile exited, final release does not;
- output unsettled after workload exit => caller waits/fails according to output contract;
- unexpected live terminal supervisor witness => release blocked with diagnostic evidence;
- normal lifecycle progresses in order: workload exit -> control settlement -> output settlement -> supervisor settlement -> evidence durability -> release;
- crash/recovery during settlement reconstructs state without false release.

Targeted validation: reconciliation/lifecycle tests, output settlement tests, release tests, then real Docker OCI integration.

**DoD:** no caller conflates workload quiescence with complete release; Docker lifecycle passes; retained output/evidence ordering is explicit; release cannot precede required settlement.

---

## Gate F — Certified benchmark and performance classification

**Purpose:** restore performance acceptance without treating benchmark failures as generic lifecycle failures.

Rules:
- reproduce the failing certified preset narrowly before editing benchmark thresholds;
- capture timing, process lifecycle, state transitions, and Runner V2 state at failure;
- compare with an appropriate known-good baseline under comparable host conditions;
- eliminate unrelated host contention before attributing a regression;
- if Runner V2 caused it, add a correctness regression and fix Runner V2;
- if benchmark infrastructure caused it, repair the benchmark separately;
- never increase thresholds merely to recover green CI.

A threshold change requires evidence that semantics are unchanged, the old threshold measured host noise rather than a regression, and the new threshold still detects the intended performance failure.

**DoD:** current benchmark failure has an evidenced root cause; correctness and performance are separated; certified benchmark passes under controlled conditions; no unexplained regression is hidden by timeout/threshold inflation.

---

## Gate G — Final Task-12 / P6 integrated acceptance

Gate G contains validation, not exploratory development. A newly discovered architectural defect returns to its owning earlier gate.
Precondition: Gates A-F independently accepted.

Final matrix must cover:
- package parity on supported OS/Node combinations;
- cross-host package reproducibility;
- portable contracts on Windows/Linux/macOS and supported Node versions;
- native adapters on Windows/Linux/macOS and supported Node versions;
- ownership/fencing and stale-authority safety;
- POSIX PID/PGID reuse safety and process containment;
- Windows cleanup/containment;
- output settlement, crash/recovery, and resource release;
- configuration confinement and macOS host aliases;
- real Docker/OCI lifecycle;
- certified benchmark checks;
- the broader/full P6 regression suite required for final acceptance.

Final review maps each invariant to implementation commit, regression test, platform evidence, and PASS/FAIL status.

**DoD:** intended CI matrix green; no affected portable tests skipped for convenience; no unsafe timeout inflation; no known `outcome_unknown` treated as success; no dirty implementation required to pass; accepted fixes are reviewable commits; final worktree clean; independent reviewer confirms all Task-12/P6 invariants; PR contains only intended changes.

---

## Strict execution order

`T12-0 -> A Fencing -> B POSIX -> C Windows -> D macOS/config -> E Lifecycle/Docker -> F Benchmark -> G Final acceptance`

A-D close core correctness. E proves cross-component lifecycle. F keeps performance diagnosis separate. G should be predominantly validation.

## Per-gate agent operating model

1. Read this plan and the original Runner V2/P6 requirements.
2. Inspect current implementation before editing.
3. Write the smallest deterministic failing regression for the gate invariant.
4. Prove it fails for the intended reason.5. Implement the minimum correct fix.
6. Run only directly affected tests.
7. Inspect the diff for accidental weakening or unrelated changes.
8. Run the gate's bounded validation set.
9. Commit only the gate's files.
10. Hand the commit to an independent reviewer.
11. Reviewer checks the invariant and tests against original requirements, not just CI color.
12. Repair findings inside the same gate, record evidence, then proceed.

Do not let a worker opportunistically fix later-gate failures unless they are a direct dependency. Record them under `Known later-gate issues` instead.

## Durable progress state

Maintain `docs/runner-v2/task-12-status.md` as the authoritative continuation point after context loss. Every agent must update it when a gate changes state.

Required fields:

```text
Gate 0 baseline: PASS/FAIL/IN_PROGRESS
Gate A fencing: PASS/FAIL/IN_PROGRESS
Gate B POSIX: PASS/FAIL/IN_PROGRESS
Gate C Windows: PASS/FAIL/IN_PROGRESS
Gate D macOS/config: PASS/FAIL/IN_PROGRESS
Gate E lifecycle/Docker: PASS/FAIL/IN_PROGRESS
Gate F benchmark: PASS/FAIL/IN_PROGRESS
Gate G final acceptance: PASS/FAIL/IN_PROGRESS

Current gate:
Current commit:
Failing invariant:
Targeted tests/evidence:
Reviewer status:
Known later-gate issues:
```

Chat summaries are not proof of completion; repository state, tests, and recorded evidence are.
## Stop conditions

Do not advance to the next gate when:
- the current invariant cannot be proven;
- a targeted regression still fails;
- the proposed fix weakens ownership/safety semantics;
- the worktree contains unexplained concurrent modifications;
- required platform evidence is unavailable;
- independent review finds an unresolved safety gap.

A failing gate is an acceptable intermediate state. An incorrectly declared complete gate is not.

## Expected execution behavior

The development loop is now:

> prove one bounded property, preserve its evidence, obtain review, then move to the next property.

It is explicitly **not**:

> keep changing unrelated code until the entire CI matrix happens to turn green.

Any agent beginning or continuing Runner V2 Task 12 must read this file first, inspect `task-12-status.md`, and continue from the recorded gate rather than inventing a new repair strategy.