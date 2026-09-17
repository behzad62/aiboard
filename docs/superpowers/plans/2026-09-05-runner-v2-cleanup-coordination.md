# Runner V2 Cleanup Coordination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Implement the approved cleanup coordination redesign without weakening portable execution safety.

**Architecture:** Preserve ExecutionHost and SessionAuthority. Give adopted cleanup durable per-resource progress, consistent portable protocol snapshots, restart-safe evidence, one propagated deadline, and a POSIX witness outside the workload kill group.

**Tech Stack:** Maintained Node.js LTS, TypeScript ESM, node:test/tsx, authenticated SQLite state, bounded filesystem output, existing OS adapters.

**Spec:** `docs/superpowers/specs/2026-09-05-runner-v2-cleanup-coordination-design.md`

## Global Constraints

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

## Master queue and ownership

**Current accepted outcome, 2026-09-11: PHASE VERIFIED 100% COMPLETE — NEXT PHASE MAY BEGIN.**

C1–C5 cleanup coordination is verified on the final accepted source. The complete
configured Runner graph passed: 152 files, 2,264 passing tests, zero failures,
one Windows POSIX-only skip covered by the exact actual-Linux test, followed by
all 12 configured client commands. Actual Linux validation passed 21/21; Runner
typecheck and full Runner source/test lint passed. All 361 source inputs remained
unchanged, and the final owner-authorized self-review accepted C's requirements.
No independent review/provider gate remains.

The accepted run has 1,855 exact Windows acquisitions: 1,800 absent and 55
intentionally retained non-native recovery diagnostics with closed handles;
no retained native fixture roots. Earlier failed diagnostics, including the
pre-closure CLI's noncanonical coordination record, remain explicitly preserved
and are not falsely declared recovered or clean.

Evidence and self-review:
`.superpowers/sdd/2026-09-05-runner-v2-cleanup-coordination/closure-2026-09-11/phase-c-final-report.md`
and `closure-acceptance-proof.json` in that directory.

**C-specific lock cleared; remaining Task 8.0B3/P6.4e handback may resume.**
This does not certify B3/P6 completion or unlock P6.5/P6.6/P7. No next-phase
implementation, commit, staging or publication was performed. All older status
paragraphs below are preserved chronology, not the current C gate.

**Latest owner instruction and self-review, 2026-09-11: C acceptance remains blocked.**

The user explicitly replaced independent review with controller self-review and
authorized the four additional capability/manager finalizer fixes. Those four
are fixed: final36/36 behavioral/policy checks and4/4 native checks pass, with
material reversal/restoration proof. Review-provider availability is no longer
a blocker. No production code changed in correction10.

Current self-review ran the shared664-check graph and six native integration
selections: five pass, CLI startup-cleanup fails with retained unreleased live
ownership. Remaining Windows fallback finalizers, two-run failure-diagnostic
retention and unavailable Docker/OCI validation prevent complete acceptance.
No full-suite pass or next-phase unlock is issued. Exact findings/evidence:
`.superpowers/sdd/2026-09-05-runner-v2-cleanup-coordination/task-5-2026-09-11-self-review-disposition.md`.
Earlier review-provider requirements are superseded by the owner instruction;
earlier successes/failures and all other safety/acceptance constraints remain.
The paragraphs below are preserved chronology, not the latest authority/gate.

**Latest disposition, 2026-09-08: PHASE BLOCKED — GENUINE USER DECISION REQUIRED.**

The approved continuation reached its governed boundary. C2eleventh is scoped
approved; C5eighth has two open review findings and its exact native late-birth
gate failed0/1 with evidence retained. A separate source-supported P1 late-lease
ownership race and the eight inherited affected failures remain open; diagnostic
MCP1/1 non-reproduction does not prove the earlier intermittent failure fixed.
All327 source hashes match and all command handles are terminal. Current outcome,
evidence index and named next budget/scope decision are in
`.superpowers/sdd/2026-09-05-runner-v2-cleanup-coordination/task-5-approved-continuation-disposition.md`.
No Cphase/B3/P6 completion or later phase unlock. The authority and gate records
below are preserved chronology, not current acceptance.

**Latest authority: bounded continuation approved, 2026-09-08.**

The user's "ok just do it efficiently" approves the three items recorded in
task-5-finish-disposition.md: one exact sanitized MCP diagnostic, C2eleventh
same-time history repair, and C5eighth test-only safety/accounting packet.
Existing counters, guards and retained evidence remain. Diagnostic/restore
precedes source repairs; independent read-only preparation may overlap. No
speculative MCP repair, unbounded future-family rewrite or phase green is implied.
The blocked outcome below is preserved history, not the latest authority state.

**Final finish-attempt disposition: PHASE BLOCKED — GENUINE USER DECISION REQUIRED.**

Independent blocker triage confirms the same-time C2 history defect, inherited
C5 broad-fixture safety defect, and separate failed native MCP output-settlement
gate. task-5-finish-disposition.md in the cleanup SDD packet owns the bounded
approval request and current evidence index. No additional repair or later phase
is authorized. All321 candidate hashes and29 executor evidence artifacts match;
all command handles are terminal. Remaining verification/final audit stay locked.

**Latest gate, 2026-09-08 finish attempt: exact oversized MCP native failure; no source change.**

Persistent-output/spill PASS1/1; oversized MCP FAIL0/1 after release observation
failed. Authenticated diagnosis proves workload quiescence but cannot certify
retained-output settlement; release remains blocked. Current failed fixture
roots are preserved. Typecheck/lint pass. Broader Runner is held before execution
because a late-birth test fallback has PID-only cleanup/evidence removal and CLI
child root accounting is incomplete. Independent read-only blocker triage is
active; final acceptance remains ineligible. See task-5-finish-verification-report.md,
task-5-finish-blocker-review-brief.md and progress.md in the cleanup SDD packet.
No additional repair round, Cphase/B3/P6 exit or later-phase unlock is inferred.

**Preserved prior gate:**

**Current gate, 2026-09-08: owner-directed test-timeout adjustment accepted; native crash check passes.**

First crash recovery15s→60s, outer watchdog210s→255s; all assertions and product
deadlines unchanged. Native1/1PASS22.874s with exact root absent/321 hashes
unchanged. Scoped review and static checks pass. This is the user's explicitly
directed seventh C5 test-only adjustment, not a counter reset or another C2 fix.
Evidence supports enough time for this case, not universal delay-only behavior.
Next: remaining affected/shared/broader Runner and final C5 gates. Separate
timestamp liveness finding remains unwaived; no C5/B3/P6/later-phase exit.

**Preserved prior gate: PHASE BLOCKED — GENUINE USER DECISION REQUIRED.**

C2 correction10 and C5 test-only correction6 independently passed. Fresh exact
native crash verification FAILED0/1; first recovery did not succeed within its
15s budget, although later cleanup achieved authenticated release. KN4Dtb is
retained diagnostic evidence, all321 source/test hashes unchanged. Source
triage cannot identify the precise native wait from existing evidence. Owner
decision is a bounded diagnostic capture before any new repair; no timeout
increase, eleventh C2, seventh C5 or counter reset. See cleanup ledger and
task-5-round6-native-failure.md. C5/B3/P6 and later phases remain locked.

**Preserved pre-native checkpoint:**

The user explicitly approved both bounded follow-ups without resetting either
counter. C2 correction10 passed scoped re-review (task-2-round10-review.md);
task-5-round6-brief.md is now implementation-eligible. The unchanged timestamp
liveness limitation remains for final C5 triage. Native work stays gated by C5's
fixture review. No eleventh C2 or seventh C5
correction, historical cleanup or later-phase execution is authorized.

**Preserved ninth-round review blocker:**

Independent review found an uncovered original-acquire/cancellation-detach overlap
in the new bootstrap path. The implementer confirms it;55 focused and17 affected
passes do not cover that live-open schedule. `task-2-round9-review.md` and the
cleanup ledger record the frozen candidate, exact finding and next decision:
one bounded tenth C2 correction. C5 separately needs a sixth test-only correction
for its crash launcher/recovery-owner failure path; its5/5 budget is exhausted.
Neither repair is authorized by the ninth-round approval. No native/broad gate
or later phase is eligible, and no correction counter is reset.

**Preserved ninth-round approval entry:**

C1's terminal-dispatch prerequisite, C3's fourth correction and C4 retain their
recorded scoped verification. C2's eighth close-conjunction delta passed narrow
independent review, with its execution/provenance qualifications preserved.
C5 has seven recorded native successes out of eight and has used all five
test-repair rounds. Its remaining crash case exposed the C2-owned legal
begin_channel-before-checkpoint recovery gap, with necessary C3 atomic storage
support. The user explicitly approved one ninth C2 correction, not a reset.
`task-2-round9-brief.md` and the cleanup `progress.md` own current boundaries,
causal proof, required interface dependency and later review/native gates.
No C5/B3/P6 exit or P6.5/P6.6/P7 unlock is implied.

**Preserved previous gate: C1 prerequisite independently accepted; C5 fourth MCP fixture correction active.**

Scoped acceptance is recorded in `task-1-cap-review.md`: the shared dispatcher
addresses the output-error interaction with no remaining delta finding. Both
portable files remain frozen while the worker completes only mcp-tools.test.ts.
Native timing/close remains the subsequent C5 validation gate, after C5 review
and stable sources. No C5/B3/P6 exit. The cleanup ledger owns exact current proof.

**Preserved cap-ruling entry:**

C1 fifth review addressed the prior finding but exposed unique subscription
wrappers reentering live-Set output-error delivery. The cap is exhausted; the
parent load-bearing ruling in `task-1-cap-ruling-terminal-dispatch.md` carries one
additional C1 correction into the next C5 fourth dispatch without resetting or
relabelling either history. Both terminal notification paths must share one
private snapshot/lifetime dispatcher. Source review and stable candidate gates
remain before native work; C1/C5/B3/P6 are not accepted. The cleanup ledger owns
the exact ruling, baseline, stage freeze/review and subsequent verification.

**Preserved fifth-round entry:**

Independent review of the fourth-round delta found one Important delivery-loop
issue: callback A can unsubscribe B or detach, yet copied callback B still runs.
Actual-channel proof fails both schedules. The fresh stronger fifth worker owns
the narrow two-file fix and focused proof in `task-1-round5-brief.md`; scoped
re-review gates the next native attempt. Fourth-round async/fence/output proof
is preserved. C2 seven, C3 four verified, C4 two, C5 three; no phase exit.

**Preserved fourth-round entry:**

Independent ownership ruling assigns the suspected terminal-observer/native
birth-inspection liveness risk to C1, whose verified history is3/5. A fresh
stronger executor must establish actual-channel causal RED before selecting a
minimal fourth correction, preserving all terminal/identity/fence/ACK checks.
The exact pure C3 artifact/spool/runtime diagnostic remains healthy within21ms;
native timing supports but does not alone prove polling starvation. C2 stays
seven, C3 four verified, C4 two, C5 three; no counter reset. Full details and
four-file before snapshot are in the cleanup packet's C1 round4 brief/ruling.

**Preserved C3 acceptance and C5 diagnosis entry:**

C3 review approved the frozen six-file correction, 440/440 unrestricted affected
checks and preserved generic terminal policy. The exact retained OLD6z fixture
then recovered to released with all six facts verified and its original manifest
preserved. The fresh persistent fixture failed its first readiness wait but fully
released all resources; its exact ez2LIl root is retained for primary diagnostics.
Source classification precedes any new correction or counter decision. C5 remains
three of five; prepared MCP finalizer round4 has not started. Cleanup progress
records full result/handle/hash/ownership evidence. No C5/B3/P6 exit is claimed.

**Preserved C3 round4 implementation/verification provenance:**

The affected graph's four inherited failures are obsolete runtime fixture
expectations, reproduced against the frozen pre-round4 production baseline.
They are reconciled inside the already assigned round4 test surface with causal
ordering and safety assertions preserved. No new C2/C5 round or production
policy correction is needed; complete proof and independent review still gate
native execution. The cleanup ledger records the corrected classification.
Independent specification adjudication found the old current-task terminal row
requires C3 to observe an already finalized authenticated manifest. Existing C2
generic finalization retry refusal remains correct and unchanged. Task3's existing
scope and remaining fourth round of five authorize the narrow observation-only
transition; no eighth C2 round or new user approval is required. Full rationale,
scope, six-file baseline, guard/fault and review gates are in the cleanup packet's
`task-3-round4-ownership-ruling.md` and `task-3-round4-brief.md`.
C5 round3 readiness repair passed scoped independent review after report-only
command provenance was added; its third counter is unchanged. Native retries and
later packets remain gated until C3 round4 independently passes.

**Preserved C5 readiness entry:**
C3's six-line absent-root correction passed actual-spool/runtime RED, material
reversal and unsafe broad-ENOENT fault, restored GREEN, 156 affected checks and
static checks; independent review returned compliant/approved without findings.
Its next exact persistent native test failed the first deliverOutput assertion,
but authenticated state verifies all six cleanup facts and session release.
The fixture used durable accepted count as readiness before async evidence was
ready. Independent source review confirmed facade.waitForOutput is the correct
contract. C5 third test-repair round of five now proves and fixes that test-only
readiness race before a native retry. See `task-5-round3-brief.md` and ledger.

**Preserved C3 round3 entry:**
C2 round7 is independently verified. Its next exact oversized-line MCP run passed
1/1 on Windows with complete terminal evidence and both exact roots removed.
The separate persistent-output run failed 0/1 and preserved its root. Read-only
authenticated state verifies quiescence/output but blocks evidence after a lossy
continuation finalized. Independent source diagnosis locates shared-spool cleanup:
replacement finalization removes the empty owned root before old live-spool
cleanup revalidates it. This is Task 3/spec C/E ownership. Its third round of
five requires real-spool/runtime RED, strict ownership refusal, material fault
proof, affected checks and independent review; see `task-3-round3-brief.md` in
the cleanup ledger directory. No native retry until that correction is verified.
C5 remains two of five test repairs; C2 seven total and C4 two of five.

**Preserved C2 round7 verification:**
Independent scoped review returned SPEC COMPLIANT / QUALITY APPROVED with no
findings; both final hashes match the recorded RED/fault/restored-GREEN,
38/38 affected checks and static evidence. `task-2-round7-report.md` and
`task-2-round7-review.md` in the cleanup ledger directory record that exit.
Seven total rounds used, no reset. That exit unlocked the two native results
above; broader work remains dependent on the existing queue.

**Round7 authority provenance:** The
user's 2026-09-06 `resume the work` replied to the explicit seventh-round
approval question. `task-2-round7-brief.md` in the cleanup ledger directory
defines its two-file correction, fault proof and independent review. Six earlier
rounds remain consumed, with no counter reset. C5 stays at 2/5 and cannot resume
until C2's verified exit is restored. P6 has no verified exit.

**Historical authority stop before that reply:** C5's third
oversized-line attempt retained an authenticated cleanup blocker. Independent
read-only review identified a C2-owned quiescence/output-reader cycle; its prior
verified exit is reopened. C2's six approved rounds are exhausted and no seventh
is authorized. C5 is frozen at two test-repair cycles of five; those cannot fund
a C2 production correction. The exact finding, read-only liveness/evidence facts
and bounded proposed correction are recorded in `task-5-report.md` and
`progress.md` under `.superpowers/sdd/2026-09-05-runner-v2-cleanup-coordination/`.
No implementation packet is eligible until the owner decides.

C1, C3 and C4 retain their prior scoped verification. C4 passed original
and two scoped repair reviews, current targeted/static checks, one actual Linux
descendant/force/output-settlement fixture and the smallest affected Windows live
selection. Exact final hashes, requirement audit and retained outer verification
artifact accounting are in `task-4-report.md` and `progress.md` under
`.superpowers/sdd/2026-09-05-runner-v2-cleanup-coordination/`. No macOS run is
claimed. C4 used two rounds of five and C3 used two. No counter is reset and
parent B3/P6/P6.5/P6.6/P7 remain gated. Historical records preserve provenance.

| Packet | Purpose / priority | Dependencies | Sole requirements owned |
| --- | --- | --- | --- |
| C1 | Coherent portable protocol / highest | Approved spec | A: stale-effect classification; coherent retained snapshots; interruption-safe ACK retirement |
| C2 | Durable cleanup and recovery / highest | C1 | B: resource ledger, typed blockers, all-state recovery, truthful run close, shared deadline and late-effect ownership; E: final proof conjunction |
| C3 | Evidence continuity / high | C2 | C: durable evidence identity/position/loss, fresh-runtime continuation and legacy truthful loss |
| C4 | POSIX witness separation / high | C1–C3 | D: independently identified workload group, supervisor-surviving force-stop, portable adapter contracts |
| C5 | Integrated proof / mandatory | C1–C4 | Verification section: exact failures, impacted graph, cross-platform evidence, residue, independent final audit |

Each packet applies PREPARE → one coherent implementation step → narrow impact
validation → requirement audit → repair and rerun failed/affected checks → final
adversarial audit. No packet has a successful exit while a mandatory requirement
remains unverified. After five repair rounds escalate rather than silently widen
or restart the repair counter. Critical discoveries interrupt; unrelated findings
go to their existing future owner (including Task12 root/app type configuration).

### Task 1: C1 — Coherent portable protocol

**Current, 2026-09-06:** Reopened evidence-first fourth packet for the native
terminal-observer liveness hypothesis discovered by C5 readiness. The prior
verified exit used3/5 governed repairs; retain that history. Actual-channel
causal RED gates a correction, then fault/restored/affected/static proof and
independent review gate C5. `task-1-polling-ownership-ruling.md` and
`task-1-round4-brief.md` in the cleanup packet own the exact scope; no C2/C3
policy change, timeout increase or missing-supervisor detection regression.

**Verified 2026-09-05:** 20 protocol, 17 channel, 4 focused owned-fence checks
and one authorized live takeover passed; 11 reverted-fault proofs; independent
spec/quality review clear. Exact source and proof record:
`.superpowers/sdd/2026-09-05-runner-v2-cleanup-coordination/task-1-report.md`.
All work items below are satisfied; C2 is unlocked, not parent B3/P6.

**Entry:** Existing dirty source preserved; exact reviewed functions and retained
failure read. No old residue touched.

**Files:** `runner-v2/src/portable-process-supervisor.mjs`,
`portable-process-channel.ts`, `native-process-backend.ts`; small shared portable
protocol module and declarations only if needed; `runner-v2/test/portable-process-channel.test.ts`
and a focused deterministic portable protocol test/support fixture.

**Interfaces:** Keep `backpressuredChannelProvider().acquire/reattach` and its
returned channel contract. Any new snapshot helper is backend-internal; do not
expose an unguarded channel or add new public family operations.

- [x] PREPARE: identify all supervisor effect callers and ACK/checkpoint readers; record current source hashes for the task diff.
- [x] Add deterministic tests of actual production behavior for stale-before-read, takeover-at-effect, and current-owner continuation. Before repair, the takeover-at-effect case must demonstrate the fatal-path failure.
- [x] Introduce explicit applied/stale/unavailable effect classification. Guard the actual operation under the existing exact lock; a stale no-op does not advance applied command state or terminate the supervisor.
- [x] Run the new exact tests, then existing published-input/output-ACK/force-control ownership tests.
- [x] Add schedules between output unlink and checkpoint publication, and between filename listing and checkpoint read. Assert exact retained suffix, not false corruption or missing bytes.
- [x] Implement coherent bounded snapshots and interruption-safe ACK retirement with prevalidated metadata and authenticated recoverable intent where multi-file updates cannot be atomic.
- [x] Test interrupted retirement before/after each durable mutation; only exact recorded intent is resumable. Corrupt or missing unexplained records remain blocked.
- [x] Remove each material new guard under an isolated fault, observe the corresponding test RED, restore, and rerun exact plus affected tests.
- [x] Run configured Runner typecheck, scoped lint, portable channel/owned-fence contracts; request independent scoped review with before/after diff and proof ledger.

**Acceptance/DoD:** Stale effects never execute and do not kill the current
supervisor; coherent snapshots preserve ordering/digests/capacity; interrupted
ACK retirement is resumable or explicitly blocked without silent loss. All
guards have fault proofs, tests and review are current.

**Exclusions:** No POSIX grouping change, adopted-session state redesign, MCP
protocol change, timeout increase, historical recovery, or broader source cleanup.
**Rollback/recovery:** Revert only this packet's recorded diff if requested;
retain uncertain transaction intent and old authenticated state. Never remove
fixture authority until exact cleanup passes. Green exit unlocks C2.

### Task 2: C2 — Durable adopted cleanup coordinator

**Current: tenth correction explicitly approved and active.** The confirmed
original-acquire/cancellation-detach finding is the sole correction scope;
live-open causal RED and scoped re-review are mandatory. No budget reset.

**Preserved ninth correction review:** Original
live-open acquisition/cancellation-detach ownership is not joined before the new
bootstrap preparation. Exact source-supported finding and implementer confirmation
are in task-2-round9-review.md; tenth-round authority is required before correction.

**Preserved ninth-round preparation:** The exact
precheckpoint capability gap and atomic cleanup-owned bootstrap constraints are
recorded in the current brief and ledger. Missing, corrupt, foreign or unexplained
prior evidence must remain blocked. Synthetic fault proof and independent review
precede parent-owned native verification; the ninth approval authorizes no tenth
round. The accepted eighth close predicate is not reopened by this correction.

**Preserved seventh-round entry: verified after the seventh bounded correction.** Independent C5 dependency
review found the live-family branch can stop its delivery pump before cleanup,
skip evidence-only intake before quiescence, and wait for ACK-dependent exit
until its deadline. This violates C2's existing Host split/ordering requirement.
The user's 2026-09-06 reply authorizes the proposed seventh bounded correction;
preserve the prior six-round history, all deadlines, resource order, fences and
backend proofs. The current brief is `task-2-round7-brief.md` in the cleanup
ledger directory. No later repair round is authorized by this resumption.

**Historical round-5 verified checkpoint:**245 focused checks passed, nineteen round5 material faults
proved RED/restored GREEN, configured Runner typecheck/scoped lint/diff checks
green, independent spec/quality review approved all14 final hashes. Exact proof:
`.superpowers/sdd/2026-09-05-runner-v2-cleanup-coordination/task-2-report.md` and
`task-2-review-round5.md`. Seven accounted non-live synthetic fixtures are retained
as diagnostic evidence in the ledger; no historical process cleanup was done.
The subsequent owner-authorized sixth repair and independent re-review are
recorded in `task-2-round6-report.md` and the SDD ledger. Six total rounds were
used, with no seventh authorized; the counter was not reset. Its then-verified
exit is now reopened by the finding above; parent B3/P6/P6.5/P7 never had an exit.

**Entry:** C1 gate green. **Files:** streaming-session-store.ts,
session-authority.ts, streaming-process-session-runtime.ts,
execution-host-streaming.ts, execution-host.ts, execution-host-mcp-transport.ts;
dedicated cleanup coordinator module if needed; corresponding store/runtime/host/MCP tests.

**Interfaces:** Extend the authenticated adopted cleanup effect with a versioned
progress record: resource identity, pending/verified/blocked state, categorical
blocker, and evidence reference. Keep existing family authorization envelopes.
Nested backend cleanup receives an absolute deadline rather than a fresh budget.

- [x] Add a fresh-runtime matrix for every unreleased adopted state; assert one explicit disposition per row and no relaunch. Add run-close failure when any owned row remains unreleased.
- [x] Prove those guards RED before changing filtering or coordinator behavior.
- [x] Implement versioned, validated durable progress and conservative legacy initialization; add SQLite reopen, stale-writer and malformed-record tests.
- [x] Route adopted stop/recovery through one fenced coordinator, reconstituting exact capabilities from durable bindings without requiring a prior in-memory attachment.
- [x] Record resource progress before and after effects, and preserve a sanitized typed blocker when progress cannot be proved. Never convert ambiguous effects to success.
- [x] Implement all-state recovery and consume its results in run close. Do not close away inspection/retry authority while owned records remain unresolved.
- [x] Add controlled deadline-edge and late-completion tests. Propagate one absolute deadline; retain ownership of unfinished effects and fence late outcomes; forbid duplicate overlapping cleanup.
- [x] Exercise repeated same-runtime and fresh-runtime retries after every resource boundary, including missing/corrupt evidence and expired ownership.
- [x] Prove mandatory guards RED under reverted faults, rerun affected store/authority/runtime/host/MCP contracts, typecheck/lint, and independent review.

**Acceptance/DoD:** No unreleased row silently omitted; safe retries survive
restart; no false run-close success; one owned in-flight effect per resource;
typed durable blocker; all required resource facts precede final release.
**Exclusions:** Evidence-spool reconstruction (C3), POSIX spawn grouping (C4),
new public MCP tools/restart policies. **Recovery:** Preserve old rows; prove
schema compatibility and deny stale late effects. Green exit unlocks C3.

### Task 3: C3 — Durable evidence continuation

**Round4 active 2026-09-06:** C3 reopens for the finalized-manifest observation
omission described above, within existing Task3/spec authority and fourth of five
repairs. Keep C2 generic terminal retry/attempt policy unchanged; no repeated
finalization. Parent owns native fixture recovery after independent review.

**Prior round3 verified checkpoint 2026-09-06:** Independent scoped review approved the narrow
absent-root guard and its causal/fault/static proof with no findings. Parent
matched frozen hashes; C3 used three of five rounds. The current next C5 fixture
readiness correction is test-only and does not reopen C3's verified exit.

**Historical reopened checkpoint 2026-09-06:** Round3 was dispatched for shared-spool cleanup after lossy
continuation finalization. Prior scoped proofs remain provenance; no current C3
exit is asserted until round3 independent verification. Parent preserved the
three-file before manifest and bounded brief in the cleanup packet.

**Prior verified checkpoint 2026-09-06:** Two governed repairs used; original and scoped independent
reviews have no open findings. Parent corroborated the frozen round-2 candidate
with 59/59 focused checks and 41/41 exact temporary roots removed. The complete
continuation, SQLite, loss, material-fault and impact-reuse evidence is in
`task-3-report.md`; the final independent verdict is `task-3-round2-review.md`.
This verified exit unlocked C4, not parent B3/P6.

**Entry:** C2 durable progress contract green. **Files:** bounded-output-spool.ts,
protocol-evidence-tee.ts, streaming-output-controller.ts,
streaming-process-session-runtime.ts, streaming-session-store.ts, execution-host.ts;
spool/checkpoint/runtime and real-streaming tests.

**Interfaces:** Session-owned authenticated evidence continuation identifies
immutable segments or a resumable spool, committed byte/sequence position, and
explicit evidence-loss state. Existing finalized artifact and family-delivery
interfaces remain compatible.

- [x] Add a real-spool test: persist output, consume/ACK, dispose the runtime, open a fresh runtime/store/spool, append output, finalize; assert exact original-plus-new evidence with no duplicate family delivery.
- [x] Observe RED against memory-only continuation before implementing changes.
- [x] Bind evidence identity/commit position/loss to durable session progress; implement authenticated reopen or immutable-segment manifest continuation.
- [x] Cover crashes at spool write, evidence commit, protocol consumption, backend ACK and finalization; verify exact bytes or explicit loss, never silent omission.
- [x] Preserve legacy artifacts; when old metadata cannot reconstruct evidence, persist a truthful gap/loss marker. Never call missing evidence lossless.
- [x] Re-prove earlier spill-failure/protocol-privacy/same-runtime retry behavior; mutate new guards RED, restore GREEN; run focused static/type and independent review.

**Acceptance/DoD:** Fresh restart preserves continuous evidence or explicitly
accounts for an unrecoverable legacy gap; no protocol redelivery, duplication,
cross-session evidence or secret exposure. **Exclusions:** Broader artifact
architecture and retention policy. **Recovery:** Never delete original segments
before durable manifest/final artifact ownership is verified. Unlocks C4.

### Task 4: C4 — POSIX workload/witness separation

**Entry:** C1–C3 green. **Files:** portable-process-supervisor.mjs,
portable-process-child.mjs, portable-process-posix-control.mjs and declarations,
native-process-backend.ts, posix-process-backend.ts, POSIX/portable integration tests.

**Interfaces:** A versioned backend-owned workload group identity distinct from
supervisor identity; process/channel registry contracts and Windows behavior stay intact.

- [x] Add a deterministic force-stop case proving the control witness remains alive until workload and retained output settle. Observe RED against supervisor-group targeting.
- [x] Capture exact workload group identity behind the existing launch barrier before releasing the executable; persist its binding to supervisor/backend identity.
- [x] Route graceful/force control to that group while the supervisor retains pipes, acknowledgements and terminal proof. Deny uncertain/recycled identities and retain explicit unsupported crash capabilities.
- [x] Test launcher exit with descendants, forced stop with buffered output, expired fences, missing witness, PID/group reuse, and interrupted launch; preserve Windows portable/optional Job contracts.
- [x] Run the focused real Linux fixture in the existing available isolated environment with exact cleanup; report macOS execution applicability separately.
- [x] Prove guard faults RED/reverted/GREEN, run affected native/process/channel contracts and type/lint, and independent scoped review.

**Acceptance/DoD:** Force-stopping the workload does not kill its witness; durable
terminal proof and output settlement remain obtainable without weakened release.
**Exclusions:** Platform-specific product requirements or arbitrary dynamic AI
process commands. **Recovery:** Old backend versions stay conservative; no unsafe
reinterpretation of historical group identity. Unlocks C5.

### Task 5: C5 — Integrated verification and B3 handback

**Entry:** C1–C4 green. **Files:** focused integration tests and proof reports;
change production only through the owning packet's repair loop.

- [x] Run exact prior failures: post-ready oversized MCP cleanup and real persistent-output stop/spill; require current release and evidence checks, not merely child absence.
- [x] Run CLI startup-failure cleanup, strict OCI public MCP, persistent trees, two-run isolation, and crash/restart scenarios on stable sources.
- [x] Run affected store/output/authority/runtime/backend/host/MCP/CLI graph, configured Runner typecheck and lint; then broader Runner gate because shared lifecycle impact crosses families.
- [x] Verify every new fixture's owned processes, ports, containers, spill/state roots and final artifact ownership. Keep historical uncertain residue separate and untouched.
- [x] Run final adversarial requirement-by-requirement review with C1–C4 fault evidence, schema compatibility, portability and all deferred findings visible.
- [x] Record the exact phase outcome and remaining B3/P6 queue. No P6.5/P7 unlock unless the original master gates are actually satisfied.

**Acceptance/DoD:** All specification requirements have one owning packet and
current proof; no open mandatory finding; no new unverified residue; truthful
platform applicability and no reused green for affected code. **Recovery:** Safe
identity-backed cleanup only; historical recordless termination remains a
separate owner decision. Failed integration routes to its owner and consumes the
governed repair budget, never earns a prose-only completion.
