# Runner V2 lifecycle contract migration plan

Planning only. The architecture decision is a recommendation, not an amendment already applied to the product. Use Cursor CLI for implementation; Codex owns planning, review, assignments, integration, and acceptance. This preserves the user's chosen execution method.

## Source and authority

- The complete request is preserved in [SOURCE.md](SOURCE.md), SHA-256 `56AE7ECF33689E4EB9BF3E7001F3B520915CC0DD56694D078DD4B49CE489713B`.
- Additional user instruction: use Cursor CLI for agentic coding and Codex as orchestrator, reviewer, and planner; minimize token use.
- Reviewed worktree: `D:/repos/ai-discussion-board/.worktrees/runner-v2-task12-bounded`, branch `codex/runner-v2-task12-bounded`, HEAD `6e33354e7e3bed9e16ad9cb0416ef5e9f4b75940`. Main is a different implementation and must not be used as the migration base.
- [Baseline](evidence/baseline.json) identifies project instructions, current gate plan/status/security documentation, and all nine pre-existing dirty files. Preserve those files until each hunk has an explicit disposition.
- Existing Task 12 gates remain authoritative until the decision's proposed amendment is adopted. Reopen only affected B/E/G acceptance; do not erase the A/C/D/F obligations or infer they all passed from the attachment.
- Supplemental constraints inspected: `docs/superpowers/plans/2026-08-28-runner-v2-portable-execution-safety.md` (doctrine, Tasks 5/12); canonical `2026-08-26-runner-v2-robust-build-improvements.md` (HVI-6A.4–8/P6); `docs/superpowers/specs/2026-09-05-runner-v2-cleanup-coordination-design.md` (retained constraints). Their source identity is recorded in evidence/baseline.json. This reassessment does not reopen unrelated phases or inherit stale historical checkpoints as current status.
- The original optional-Job/mandatory-baseline requirement needs an explicit availability amendment if no non-Job Windows provider meets the scoped contract. No OS-name hard gate or global Job dependency may replace capability selection.
- The supplied repository instructions require Node **24.18.0**; the Task 12 worktree and workflows say **24.x**. Use 24.18.0 for local evidence and resolve this release-policy discrepancy explicitly in M0. No incidental runtime or dependency upgrade.
- [DECISION.md](DECISION.md) is the proposed architecture. No source-code change, test run, CI dispatch, commit, or deployment is authorized by plan readiness alone.

## Requirement ledger

Every acceptance result lives in its packet evidence file; this table defines ownership, not completion. `M0`–`M4` are packets; `P0`–`P4` are their respective phases. All implementation acceptance starts `PLANNED`.

| ID | Source / purpose and observable outcome | Accountable phase; packet | Acceptance gate and evidence |
|---|---|---|---|
| R01 | §§1–2,17–18: compare simplification and real containment independently; finish without a rewrite | P0; M0 | Adopted decision explains both alternatives, exclusions, and requirement amendment |
| R02 | §§2–3,13: preserve deterministic PR versus real-host qualification distinction | P4; M4 | Workflow/test inventory maps every mandatory case to a lane; no silent deletion |
| R03 | §§4–7,12 A–D: scope lifecycle capabilities honestly; POSIX never promises detached-descendant containment | P2; M1,M2 | Selection/serialization tests reject strict requests on group-only providers; M2 limitation proofs complete acceptance |
| R04 | §§6,10,12 B,H: classify common, buggy, recovery, security, and pathological workloads by actual permission profile | P1; M1 | Profile × execution-family table and negative launch tests agree with decision |
| R05 | §§8–9,12 E–G: retain Job/OCI; Linux cgroup optional; macOS fails honestly without required provider | P3; M3 | Advertisements match measured boundary and unavailable-provider behavior |
| R06 | §11 crash/restart,12 J: exact durable identity and safe recovery; never kill a recycled PID/PGID | P2; M2 | Anchor loss/reuse/unknown-birth negative proofs preserve no-signal invariant |
| R07 | §11 stale control: fencing, exact grant ownership and takeover protection remain | P3; M1–M3 | Existing takeover/fence regressions plus native and strong-provider boundary cases; final acceptance at M3 |
| R08 | §11 duplicate effects: uncertain operations are never automatically replayed | P3; M2,M3 | Restart/ack ambiguity tests show no repeated destructive or launch effect in native and isolated paths |
| R09 | §11 output: retained output, bounds, settlement and delivery remain correct | P3; M2,M3 | Fence-only output poll, inherited writer, crash/spool/ack checks including provider retirement ordering |
| R10 | §11 exact ownership/cleanup honesty;12 I: explicit release, blocked and unknown semantics | P3; M2,M3 | State-transition proofs distinguish observed empty group from containment and known escape in both paths |
| R11 | §12 J: retain useful state/grants/Job/OCI/recovery; remove only unjustified ancestry machinery | P2; M2 | Hunk disposition and independent diff review; no blanket reset of dirty work |
| R12 | §13: adversarial escape tests gate only providers claiming containment, at the claimed ownership scope | P3; M3 | Positive strict-provider escape tests and group limitation/diagnostic tests |
| R13 | §§3 B–D,14: separate harness guards, fixture repairs, host contention from product deadlines | P4; M4 | Guard budgets have a derivation; durable SQLite authority fixtures; isolated/serial native resources |
| R14 | §§14,18: bound retries/repairs and stop reconstructing missing OS primitives | P4; M4 | Repair ledger, unchanged product bounds, complexity rules applied to final blockers |
| R15 | §15: disposition of uncommitted experiment preserves unrelated good fixes | P0; M0,M2 | Baseline identities and reviewed per-hunk keep/remove record |
| R16 | §16: deliver all fourteen requested decision sections and ordered, small migration steps | P0; M0 | Fresh-source coverage review of decision and packet contracts |
| R17 | §§2,16: close G only after platform, recovery, output, security, package and required full P6 evidence | P4; M4 | Final source reconciliation and exact-candidate evidence matrix; no convenience skips |
| R18 | User workflow and project rules: Cursor implements, Codex reviews; retain native Build path, state outside project, explicit final handoff | P4; M0–M4 | Ownership ledger and final diff review; handoff still requires the existing user choice |
| R19 | Original portable-plan optional Job/mandatory baseline and HVI-6A.5; proposed DECISION §5 amendment: never silently remove baseline availability or overclaim enumeration | P1; M0,M1 | M0 records explicit adoption of scoped availability: native managed lifecycle requires a qualifying semantic provider, not a named OS primitive; M1 proves no Job/no qualifying provider rejects honestly and configured alternatives remain selectable |

Conditional R05/R12: cgroup implementation is deferred, not silently counted as delivered. Its tests become mandatory only if the provider is added and advertised. Existing supported Job/OCI obligations remain mandatory. A strict operation lacking a provider must reject before launch.

## Execution structure

One Cursor lane is sufficient: contracts, consumers, recovery and tests overlap. Do not pay for parallel agents on these shared surfaces. Dependency graph: `M0 → M1 → M2 → M3 → M4`. Phase exit accepts only its owned requirements; later combined checks remain explicit.

The controller serializes exclusive claims in STATE.json, records Cursor session ID, worktree, required base and writable paths, and verifies a prior writer has stopped before reassignment. This is a **procedural** gate, not an atomic lock supplied by the app. Git worktrees and Cursor CLI are available; isolated Linux/macOS hosts, Docker availability and CI permissions must be established at execution time. No such evidence was generated in this review.

Each packet uses the same loop: reconcile baseline → meaningful failing/negative case → smallest coherent change → targeted and affected checks → Codex independent review of actual diff/evidence → scoped repair → integration checks → controller acceptance. Cursor never self-accepts. No new test orchestration framework.

Shared contracts, workflow files, schema migration, package manifests and STATE.json are serialized. No worker may change unrelated benchmark/game code, credentials, legacy product Build routing, generated downloads, accepted evidence, or another lane's files. Tests use independent state roots outside projects, unique identities/ports and disposable owned resources.

## Packet contracts

### M0 / P0 — Adopt the amendment and establish the migration baseline

Outcome: an explicit, reviewable change of contract and an uncontaminated implementation base. Owns R01/R15/R16; supplies R19's adopted amendment prerequisite. R15 accepts the hunk-disposition decision here; R11 accepts its implemented preservation/removal in M2. Entry: user adoption of DECISION.md; original sources, baseline and independent planning review available. Scope: this packet, `docs/runner-v2/task-12-bounded-gates.md`, `task-12-status.md`, `security.md`; no product edits yet.

- [ ] Reconcile HEAD, nine dirty-file hashes and active writers against baseline. Preserve current dirty content as a reviewed patch/snapshot before removing any hunk. Do not reset or cherry-pick unrelated work.
- [ ] Record adopted scope semantics, legacy-record treatment, Windows non-Job fallback compatibility impact, and exact Node release-policy resolution. Without a Node amendment, use 24.18.0 for claimed release evidence.
- [ ] Inventory dirty hunks: escape machinery → remove in M2; existing group continuity → retain; fixture/CI repairs → review in M4. A helper extraction such as deferred-inspection accounting may remain only if independently useful without escape scanning.
- [ ] Amend B/E/G contracts and identify invalidated claims/evidence; retain the unresolved Darwin follow-up and unaffected requirements. Keep prior results historical rather than deleting them.
- [ ] Carry Task 12's original final acceptance inventory forward: targeted lint/typecheck, full Runner/client gate, twice-built archive manifests/hashes, installed smoke, real cross-platform CI/OCI, Git/state preflight and residue inspection; retain required controlled fault proofs for archive omission, raw spawn, false capability, spill/container leak and legacy active-contract acceptance. Preserve existing exhausted repair counts; this new plan does not restart earlier campaigns.
- [ ] Create an isolated implementation worktree from the recorded Task 12 candidate and apply only reviewed required hunks. The Codex managed-worktree tool does not copy uncommitted edits; record their inclusion explicitly.

Exit/DoD: user adoption is recorded, original-to-amended acceptance map reviewed, exact base and retained patch identities recorded, one exclusive Cursor claim exists. Documentation inspection and diff checks are appropriate; no artificial red test for this documentation/baseline packet. Controller owns integration; `evidence/M0.md` unlocks M1. Rollback means abandon the proposed amendment and retain the original dirty tree/snapshot, not destructive cleanup.

### M1 / P1 — Version the lifecycle contract and make policy coherent

Outcome: every invocation asks for a precise supported scope; old saved requests cannot silently lose guarantees. Owns R04/R19; contributes R03/R07 for later phase acceptance. Requires accepted M0 and its exact base. Writable: `execution-safety-contracts.ts`, `process-backend.ts`, `execution-isolation-provider.ts`, `execution-grants.ts`, `durable-process-store.ts`, `process-recovery-contracts.ts`, `runner-capability-contract.ts`, `subprocess-runtime.ts`, backend advertisement files, the four `*-executor`/`*-transport` consumers named below, `runner-internal-process-kernel.ts`, `lib/client/runner-v2.ts`, native smoke/client/observability scripts and directly corresponding tests. All Runner source paths are under `runner-v2/src/` unless stated otherwise. A new `execution-lifecycle-policy.ts` may centralize the policy; no unrelated provider refactor.

Input/output contract: v2 attestation uses the descriptor in DECISION §4; `requiredLifecycleScope` is bound into `ExecutionInvocationIntent` and durable launch authority. Export one `resolveRequiredLifecycleScope` policy accepting trusted profile/complete-cleanup/known-detachment requirements: non-full or explicit complete cleanup or unavoidable detachment → `contained_workload`; ordinary full → `process_group`. A contained provider satisfies a group request; the reverse never does. `write_confinement` remains independent. Unknown/unsupported versions fail closed; v1 readers preserve original records and cannot upgrade group evidence to containment.

- [ ] Pin parser/serializer, selection and authority-binding red cases in `execution-safety-contracts.test.ts`, `process-backend-contract.test.ts`, `execution-isolation-provider.test.ts`, `execution-grants.test.ts`, `durable-process-store.test.ts`.
- [ ] Implement v2 parsing/projection and the centralized selection policy. Record exact workload boundary versus host attach-process binding separately using existing ownership records; do not add a second competing journal.
- [ ] Replace requests in `one-shot-command-executor.ts`, `execution-host-managed-transport.ts`, `execution-host-mcp-transport.ts`, `execution-host-lsp-transport.ts`, `runner-internal-process-kernel.ts`; update full-mode isolation's unconditional bypass so an explicitly configured compatible contained route can be selected when requested.
- [ ] Update advertisements and semantic probes coherently. POSIX cannot satisfy containment; sampled Windows tree enumeration cannot satisfy containment; Job/OCI claims require current attestation. Audit `process-recovery.ts` and all consumers found by searching old capability names.
- [ ] Update durable/client projections and round trips, package smoke expectations, and security disclosure. Legacy strict requests without explicit scope remain conservative; test no launch replay and no capability fallback.

Acceptance: all four families plus internal invocation policy agree; guarded/project reject without confinement; full strict rejects without configured containment; expired/forged evidence and stale grants cannot pass; old records remain inspectable; unknown records neither kill nor relaunch. For R19, supported Windows execution succeeds with a qualifying provider; no Job and no qualifying configured alternative yields capability unavailable before launch; an explicitly configured compatible alternative remains selectable; enumeration is never treated as Job-equivalent. M0's explicit availability amendment is a prerequisite, not implied by a passing test.

Validation: targeted contract/grant/store/selection files above, `one-shot-command-executor.test.ts`, `one-shot-command-family-production-matrix.test.ts`, `managed-backend-boundary.test.ts`, `mcp-transport-authority.test.ts`, `lsp-transport-authority.test.ts`; `scripts/test-runner-v2-client.mts`, `scripts/test-runner-v2-observability.mts` and `npm run typecheck:runner-v2`. Justification: shared persisted schema and all live consumers change. Reviewer checks actual old-name callsites, identity binding and no security downgrade. `evidence/M1.md` plus integrated parser/client evidence unlocks M2. Rollback: revert this packet before any new-format runs, or refuse old executable access to new records; never down-convert ambiguous live ownership.

### M2 / P2 — Remove escape reconstruction while preserving safe native lifecycle

Outcome: bounded group control, explicit limitations, correct output/recovery. Owns R03/R06/R11; contributes R07–R10 for P3 acceptance. Requires accepted M1. Writable: `portable-process-posix-control.mjs`/`.d.mts`, `portable-process-supervisor.mjs`, `native-process-backend.ts`, `process-recovery.ts`, `process-recovery-contracts.ts`, `durable-process-store.ts` only for necessary evidence fields, `execution-host-streaming.ts` and existing streaming release consumers if scope projection requires it; scoped POSIX/native/recovery/output tests. Forbidden: Job/OCI semantics, product deadline inflation, workflow changes.

- [ ] Add negative cases: group emptiness never produces contained-workload proof; known escaped helper blocks affected-resource reuse; unseen theoretical escape does not block scoped release; old ambiguous identity does not authorize a signal/replay; output poll uncertainty alone does not invalidate the durable fence.
- [ ] Remove exactly the experimental symbols/branches in DECISION §10. Keep group member parsing, authenticated anchor, post-anchor recorded-witness re-attestation and bounded control retry semantics.
- [ ] Define and persist a minimal attributed escape diagnostic/blocker in the existing lifecycle evidence when existing observations actually identify one. No periodic PPID census, kill-by-name, or new per-PID escape control. Do not claim universal detection.
- [ ] Preserve independent control/output/supervisor/evidence/release transitions. Test an inherited stdout writer prevents unsupported settlement; keep bounded loss reporting and retained ACK behavior.
- [ ] Exercise anchor loss/reuse and malformed/unknown identity negatives. On macOS, a coarse timestamp without continuity must fail closed. If current code cannot establish the effect-boundary proof, capture that exact case in a bounded investigation with deliverable = owned/unprovable decision; no new helper or deadline change without a separate design decision.

Acceptance: no arbitrary-descendant scan participates in POSIX control/release; ordinary children still stop; stale authority and reused PID/PGID never signal; no new witnesses after anchor loss; known escape cannot become clean release; current release/output/replay obligations remain. Linux/macOS real anchor-loss evidence is a final release gate and stays pending until M4; deterministic safety proofs are mandatory here.

Validation: `posix-process-backend.test.ts`, affected `portable-process-channel.test.ts` cases, `process-recovery.test.ts`, `process-recovery-control.test.ts`, `process-recovery-streaming.test.ts`, `durable-process-store.test.ts`, `bounded-output-observation.test.ts`, `streaming-process-session-runtime.test.ts`, and targeted `owned-fence-lock.test.ts`/`session-authority.test.ts` coverage where callers changed. Run native POSIX cases on a POSIX host, never count Windows host skips as passes. Review both remaining negative-PGID effect sites and native release's evidence scope. Record `evidence/M2.md`; M3 consumes that accepted interface. Restore a packet only through reviewed hunks and preserve durable diagnostics on interruption.

### M3 / P3 — Prove the existing strict-provider composition

Outcome: containment claims concern the actual owned workload, with honest automatic crash semantics. Owns R05/R07–R10/R12. Requires accepted M2. Writable: `windows-process-backend.ts`, `windows-job-process-host.ts`, `windows-job-process-channel.ts`, `oci-execution-isolation-provider.ts`, `execution-isolation-provider.ts`, `execution-host-streaming.ts`, `streaming-process-session-runtime.ts`, `one-shot-command-executor.ts`, directly affected strong-provider/MCP/LSP tests and provider docs. Cgroup/VM implementation and shared-container pooling excluded.

- [ ] Retain per-invocation OCI lease/container and exclusive session transfer. Establish negative evidence that stopping the host attach process alone cannot complete container cleanup.
- [ ] Trace cancellation, timeout, protocol failure and restart through whole-container release/recovery. Exact container/provider/image/lease identity must be verified; foreign identity must block removal. Exercise late container allocation and cleanup acknowledgement failure.
- [ ] Verify that quiescence/output settlement cannot form a cycle that prevents eventual owned container retirement. If a cycle exists, move only the required retirement step earlier while retaining output evidence and final lease-release ordering.
- [ ] Validate Job assignment before workload execution, disabled breakaway, protected exact handle and active-membership query; attribute crash cleanup only to its actual trigger. Keep non-Job enumeration out of containment selection.
- [ ] Run detached/session-changing helper cases against the actual provider boundary. A runner merely hosted inside Docker is a native backend test unless the invocation itself acquires OCI isolation.

Acceptance: Job/OCI satisfy their scoped containment tests, attach loss does not leak the container, a foreign/mismatched resource is never removed, release waits for all obligations, a missing provider rejects before launch. Cgroup remains explicitly deferred. Review does not equate lifecycle containment to filesystem/network sandboxing.

Validation: `windows-process-backend.test.ts`, `windows-job-process-channel.test.ts`, `oci-execution-isolation-provider.test.ts`, `managed-strict-oci.test.ts`, `mcp-tools.test.ts`, `streaming-late-isolation-cleanup.test.ts`, `lsp-transport-authority.test.ts`, `lsp-descendant-fixture.test.ts`, `lsp-real-host.test.ts`. Run Docker cases with `RUNNER_V2_REQUIRE_DOCKER=1`; missing Docker is blocked evidence, not a passing skip. Real provider qualification may be recorded at M4, but deterministic identity/cancellation regressions must pass now. Reuse valid existing Gate C/E results only with a scope/impact rationale. `evidence/M3.md` unlocks M4; on failure retain exact leases and diagnostics, never delete state to make cleanup appear successful.

### M4 / P4 — Qualify and close the amended Gate G

Outcome: complete release evidence, not selected green tests. Owns R02/R13/R14/R17/R18. Requires accepted M3; all earlier required evidence and independent reviews; Darwin follow-up remains a named pending criterion. Writable: the two Runner workflows, affected test/fixture files from the nine-file baseline, `portable-execution-workflow.test.ts`, Task 12 gate/status docs and this plan's evidence/state. Product defects return to their owning packet.

- [ ] Map every existing test obligation to deterministic PR, native qualification or strict-provider qualification as in DECISION §9. Restore any displaced cross-platform configuration coverage explicitly.
- [ ] Review each independent fixture/CI hunk, retaining diagnostic/startup cleanup fixes; derive outer guards; use the real durable authority fixture; retain separate unchanged product-deadline assertions. Serialize shared host/Docker resources.
- [ ] Independently reconcile original source plus adopted amendment against the integrated candidate before full validation. Resolve omissions narrowly; don't repeat unchanged packet reviews.
- [ ] Run required Windows/Linux/macOS deterministic/package/reproducibility matrix and serial real-host qualification, exact current Node policy recorded in M0, real configured OCI, managed/MCP/LSP and recovery; resolve the named Darwin configuration follow-up.
- [ ] Run `npm run test:runner-v2`, `npm run typecheck:runner-v2`, `npm run test:certified`, targeted ESLint for changed source/client files, twice-built archive reproducibility and installed-package smoke, Git/state preflight and native/Docker residue inspection. Preserve original controlled fault proofs (archive omission/raw spawn/false capability/leaked spill or container/legacy active contract); existing valid evidence may be reused only with an impact rationale. Use isolated disposable fixtures; revert faults and confirm green. Do not unlock or count P6.5/P6.6/P7 as completed by this migration.
- [ ] Record candidate revision/diff identity, selected/pass/fail/skip counts, provider configuration, host/Node, logs and scope of reused evidence; independent final review confirms every applicable requirement. Keep final project handoff as the existing explicit user choice.

Exit/DoD: DECISION §13 and every applicable ledger condition has accepted evidence; final intended worktree is clean/reviewable; no unreviewed experiment, unexplained failure/skip, unsafe timeout increase or uncertain cleanup relabelled success. Controller marks G accepted only then. No merge or publication is authorized by this plan. `evidence/M4.md` is the final evidence index.

## Launch and resume cards

**Controller card:** Read STATE.json → SOURCE.md → DECISION.md → PLAN.md → evidence/baseline.json and planning review. Confirm amendment adoption and actual base, preserve dirty work, establish a separate implementation worktree and serialized exclusive claim. Assign one eligible packet to Cursor with its exact writable/forbidden surfaces and required base. Review actual diff and evidence; integrate only accepted changes; checkpoint assignments, blockers, evidence links and next action. Preserve the chosen Cursor workflow and three-cycle repair budget. No execution is started by this card.

**Cursor lane card:** Read STATE.json, lane-cursor-state.md and only the assigned packet/source sections and its inputs. Verify exclusive claim, required base, isolated resources and active writer status. Use the already configured Cursor account/model; do not spawn more agents. Implement the eligible packet and targeted/affected checks, write evidence/MN.md and lane handoff, then submit to Codex for independent review. Continue through assigned eligible packets after review/integration without routine permission stops; never self-accept or bypass a dependency. No edits outside claimed surfaces; preserve user changes. On interruption, persist exact last completed evidence and next action.

**Resume-planning card:** Read STATE.json and evidence/planning-review.md. Verify source/baseline hashes; inspect only unresolved review corrections and changed requirements. Do not reopen accepted inspections without impact. Finish the outstanding planning condition and update its single authoritative record. Plan readiness never starts Cursor implementation.

## Evidence, resume and final acceptance

Use `evidence/M0.md` through `evidence/M4.md` as the authoritative later acceptance records, following [evidence/TEMPLATE.md](evidence/TEMPLATE.md). STATE.json owns assignments and summary status; [lane-cursor-state.md](lane-cursor-state.md) owns the worker handoff. The lane must reference acceptance results rather than duplicate them.

On resume read STATE, this plan's assigned packet, relevant source/decision sections and evidence; inspect actual HEAD/diff/worktrees, active Cursor process, relevant native resources and CI candidate; reconcile discrepancies before claiming the next packet. An interrupted command has no result until checked. Reuse unchanged valid evidence and review findings with an impact rationale; context loss never restarts accepted work.

Track each blocking issue by ID, invariant, hypothesis, attempted correction, validation result, evidence link and remaining attempts. Three evidence-backed repair cycles per root cause across all sessions/agents. Exhaustion requires an explicit architectural/requirement decision, not another renamed retry. Environmental failures are diagnosed; they are not automatic waivers or product changes.

Before the final expensive suite, independently reconcile original SOURCE, adopted amendments and integrated behavior. Run full required checks once on the integrated candidate; subsequent repairs rerun failed/affected checks, receive review and repeat invalidated final gates. No empty selection, unexplained skip, inherited unexplained failure or prose-only claim proves acceptance. Required Gate G scope is unchanged except the explicit adopted lifecycle-contract amendment.

## Planning readiness

Independent original-source coverage review and scoped correction review are complete: [findings and dispositions](evidence/planning-review.md). All three findings are closed. Implementation acceptance is still PLANNED; user adoption of the explicit lifecycle and Windows availability amendments remains a launch prerequisite.

PLAN READY — SOURCE COVERAGE VERIFIED; EXECUTION NOT STARTED
