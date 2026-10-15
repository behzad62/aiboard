# T2 independent review: authoritative planning state, resume and reconciliation

Reviewer: fresh-context independent reviewer (Claude Opus 5.5). Read-only; no repository file was edited, staged or committed.
Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, branch `codex/runner-v2-p6-6`, HEAD `21c44efb`, T2 uncommitted.
Probe scripts (outside the repo): `C:\Users\b_a_s\AppData\Local\Temp\claude\D--repos-ai-discussion-board\c3a6c726-b6f1-47ec-bea6-214ebdabe566\scratchpad\t2probe\probe.mts`, `probe2.mts`, `probe4.mts`. They drive the real `reduceSchedulerEvent`, so they cover both direct append and replay, over the repo's T1 fixture.

**Verdict: REPAIR REQUIRED.** There is 1 BLOCKING finding, 7 IMPORTANT and 5 MINOR.

---

## Step 1: what T2 must deliver (formed before reading the worker's claims)

From plan §2, §3, §5.0 (G-2, G-11), §7, the T2 contract, ledger rows EP01–EP04, EP09 and EP10, and the brief:

1. **Typed, role-checked planning events in the scheduler reducer.** Per G-2 this is `reduceSchedulerEvent` in `scheduler-store.ts`, so direct append and replay apply the same rules. There must be exact transition and actor tables. Events are needed for: source registered and amended, the skeleton ledger persisted, the planning checkpoint, plan drafted and revised, assignment claimed and released, and acceptance recorded and reopened. T1 validators run on every payload. The reducer stays pure.
2. **`planning-projection.ts`.** It holds the source and plan digests, requirement and phase ownership, the current plan revision, and a checkpoint/resume index: covered sections, what remains, and the exact next action. Acceptance, applicability, gate and evidence references are stored **once**, and exports are derived views. There is one authority per fact (EP09, §2.6).
3. **The skeleton ledger comes before task generation, and obligations are preserved.** A requirement cannot disappear (EP02, EP04, §3 SourceRequirement). An amendment preserves prior obligations. A scope change is explicit, owner-authorized history. Task cancellation is separate from requirement retirement.
4. **Recovery from events plus actual worktree, commit and evidence identity.** An interrupted validation stays interrupted or unknown until an actual result is reconciled (EP10, §7). A lost workspace or evidence drift blocks advancement.
5. **Persistence.** `planningPolicy` round-trips through `sqlite-build-spec-store.ts`. A duplicate event or a WAL reopen preserves ids, counts and status. Memory and reopened SQLite give the same projection.
6. **Legacy.** Runs without the planning policy replay exactly as before, and `replay-compatibility.test.ts` passes unchanged. New-policy behavior is selected at run creation, and "absence never upgrades a run" (§1). Mechanical checks apply to direct event and tool paths (§2.8).
7. **Negative proofs.** Each of these must be refused: a worker self-accepting or rewriting the ledger, a forged role, a stale revision, a changed artifact, an interrupted command, a cancelled task that orphans a requirement, and a lost workspace. Resume after the ledger and after one section must continue from the exact next section, must not infer readiness, and must not repeat accepted work. An unrelated resume must not rerun accepted work. There must be crash-before and crash-after append cases, and every DB closed.
8. **Carried-forward items.**
   - R-1: an amendment lists the sections and requirements it adds or retires, and a disposition that cites an amendment which does not cover that section or requirement is rejected.
   - R-2: `amendmentRef` resolves across the whole amendment chain.
   - R-4: `coverageReviewHoldsReadiness(null)` and `assertClaimReassignable(null, …)` fail closed without throwing, and `validateRepairApproachDecision` rejects null arrays.
9. **Three prove-red records** (self-accept, stale revision, interrupted-not-passed) that really disable the guard.

---

## What I ran

| Command | Result |
|---|---|
| `tsx --test --test-concurrency=1` on planning-state, planning-projection and replay-compatibility | 24 tests, 24 pass, 0 fail |
| `tsx --test --test-concurrency=1` on planning-contracts, source-manifest, scheduler-store and build-spec-store | 87 tests, 87 pass, 0 fail |
| `tsc -p runner-v2/tsconfig.json --noEmit` | no diagnostics |
| `eslint` on the 6 changed or new files | clean |
| `sha256sum` on the 6 files | all match the evidence table |
| `replay-compatibility.test.ts` | unmodified (`git diff` empty); passes |

---

## Findings

### BLOCKING

**B1: the persisted ledger does not bind the plan, so a ledger obligation can silently disappear in the first draft, and the ledger becomes a stale second authority.**
`planning-projection.ts:524-545` persists the ledger write-once (`"The initial planning ledger is already persisted."`). `planning.plan_drafted` (`:556-582`) validates the revision against the manifest. `assertRevisionAmendmentScope` (`:318-328`) compares against the *prior plan revision* only, and never against the ledger.

- **Probe P1.** The ledger holds `REQ-COMPAT`. The first draft omits it and moves its section `s3` onto `REQ-MANDATORY`. It is accepted with no retirement record: the ledger lists 7 requirements and the plan lists 6.
- **Two copies with no consistency check.** After this, the projection holds two requirement sets. `derivePlanningOwnershipView` (`:363-376`) reads the *ledger*, so the ownership view disagrees with the current plan revision.
- **The ledger cannot be updated after an amendment.** It is write-once for every role, so it goes stale by construction.

This breaks EP02/EP04 ("applicable obligations cannot disappear"; skeleton first, then tasks) and EP09/§2.6 (one authority per fact). The kernel guard that exists between revisions is simply absent at the ledger-to-draft step.

**Fix:**
- Treat the ledger as the obligation baseline. Every draft or revision must contain each ledger requirement, or carry an in-scope `retiredRequirementIds` record, using the same `assertRetirementScope` check.
- Either allow an architect `ledger_revised` or amendment path that preserves history, or derive the ledger view from the current revision.
- Make `derivePlanningOwnershipView` read one authority.
- Add a named test: a ledger requirement dropped in the draft is refused.

### IMPORTANT

**I1: resume right after ledger creation gives a wrong next action. The required "interrupt after ledger" case is not tested, and "does not infer readiness" is never asserted.**
`planning-projection.ts:343-357`: with no checkpoint, `nextAction` falls back to `"Persist the requirement ledger before planning continues."` and `outstandingWork` is `[]`, even when the ledger exists (probe Q1). Following that action throws, because the ledger is already persisted.

The test `T2 interrupted planning resumes the exact next source section…` (`planning-state.test.ts:585`) interrupts only *after the checkpoint* (inputs `slice(0,5)` include both the ledger and the checkpoint). It never interrupts after the ledger alone, and never asserts `readiness === "not_ready"`.

**Fix:** derive the default next action from the state (ledger present, no checkpoint means "cover section `<first>`"). Add both interruption points and assert readiness.

**I2: checkpoint coverage is not bound to a manifest identity, so an amendment does not invalidate it.**
`PlanningCheckpoint` has no manifest id or digest, and `resumeIndex` (`:343-357`) takes covered ids from the latest checkpoint as-is. Probe P9: sections s1–s7 are checkpointed against the base manifest, then the source is amended. The artifact digest changes, yet all 7 sections are still "covered" and resume jumps to s8. A section whose bytes changed under the same id would be skipped on resume.

This conflicts with "changed artifact… prevents unsupported advancement" and "changing source/plan invalidates affected verdicts".

**Fix:** record the manifest id and digest (or per-section digests) on each checkpoint in the projection. In `resumeIndex`, count coverage only against sections whose identity is unchanged, and treat amended sections as uncovered.

**I3: `planning.acceptance_recorded` is not bound to the facts the projection already holds, and the phase-acceptance path is broken.**
`planning-projection.ts:787-847`:

- **A failed validation does not block acceptance** (probe P3). Only planned, interrupted and unknown block. The worker's transition table says "terminal validations", but a failed required check is still accepted.
- **Zero validations still accept** (probe P4).
- **The references in the `TaskAcceptance` record are never resolved.** In P3 and P4, `requiredChecks[].refId = "fabricated-obs"` and `reviewId = "fabricated-review"` were accepted.
- **A task id absent from the plan revision accepts** (probe P8). `assignment_claimed` also accepts any `packetId`.
- **Phase acceptance requires an assignment whose `packetId` equals the phase id** (`:793`, probe P7), so it is effectively unreachable. No test covers the phase path.

**Fix:**
- Require the task to exist in the current revision.
- Require each `requiredChecks` / `reviewId` ref to resolve to a projection record with a matching outcome.
- Refuse acceptance on a failed required validation.
- Skip the assignment check for `kind: "phase"`, and instead require accepted task acceptances for the phase's contributing tasks.
- Add tests for each of these.

**I4: `payload.references` is merged into the canonical references without validation and can overwrite stored references. This disables evidence-drift detection.**
`planning-projection.ts:858-862` casts `event.payload.references` unchecked. Probe P6: an Architect acceptance event rewrote `evidence-1` from `{kind:"evidence", digest:<sha>}` to `{kind:"gate", id:"whatever", digest:42}` and inserted the non-record `"junk"`. `reconcilePlanningProjection` (`:400-409`) only checks `kind === "evidence"`, so the overwritten evidence is no longer drift-checked at all. This contradicts "references stored once" and is a type hole.

**Fix:** validate each entry (a closed kind set, non-empty id, string digest). Refuse any key that already exists with a different value (write-once). Do not let acceptance events write evidence refs.

**I5: a worker's validation observation is not bound to the claim owner.**
`planning.validation_observed` accepts `worker` (`:85`). The reducer (`:713-756`) never compares `event.actor.id` with the claimed assignment's `workerOrSessionId`, and never checks that the assignment is still `claimed`. Probe P5: `some-other-worker` recorded a `passed` observation on worker-T1's claim, and the validation became `passed`.

**Fix:** for the worker role, require `actor.id === claim.workerOrSessionId` of the live claim for that `taskId`.

**I6: planning events are admitted on runs with no planning policy, including legacy runs.**
The planning branch in `scheduler-store.ts` (~1904-1919) only refuses terminal runs. Probes P2 and P16: a legacy `plan_only` run started with `run.policy_configured` + `plan.created` accepts `planning.source_registered` and gains a `planning` projection.

§1 says new-policy behavior is selected at run creation and its absence never upgrades a run, and §2.8 says mechanical checks apply to direct event paths. There is no scheduler-side policy stamp, analogous to `project_docs.policy_configured`, to gate on.

**Fix:** add a runner-only planning-policy stamp event at run start, or carry the policy on `run.policy_configured`. Refuse planning events on runs without it, and add a legacy-refusal test.

**I7: R-1 is enforced only on the plan draft/revise path, not on the ledger or in the contract validators.**
`assertRetirementScope` lives only in the projection's `plan_drafted` / `plan_revised` handling. Probe P13: `planning.ledger_persisted` with the security requirement set `not_applicable`, citing `amend-1` (whose recorded impact retires only s7 and `REQ-RETIRED`), is accepted into the ledger authority.

In `planning-contracts.ts` the change is plumbing only. `validateRequirementLedger`, `validateNotApplicableDisposition`, `computePlanReadiness` and `validatePhaseAcceptance` still accept any resolvable amendment id, and `recordedImpact` is optional (`source-manifest.ts:60`). The brief asked for dispositions that cite an out-of-scope amendment to be rejected.

**Fix:** apply the scope check in `ledger_persisted`. Preferably move it into the T1 validators, taking the amendment history with impacts, so every caller gets it.

### MINOR

**M1: `assertClaimReassignable` now has a mixed contract** (`planning-contracts.ts:2019-2037`). It returns `false` for null, throws for other invalid input, and returns `true` on success. The only caller (`planning-projection.ts:630`) ignores the return value, so a `false` would be treated as a pass. There is no live bypass, because claims are validated first. **Fix:** throw a descriptive error, or rename it to a predicate and check the result at the call site.

**M2: two of the three prove-red records are red only because the error message changed; the refusal itself survived the mutation.**
- **Self-accept:** the mutation disabled only the special-message branch. The worker was still refused by the actor table: the evidence's own recorded input reads "Role worker cannot append planning.acceptance_recorded". The real guard (`PLANNING_EVENT_ACTOR_ROLES`) was never disabled, so "disabled exactly one guard" overstates what was shown.
- **Interrupted:** the test scenario never reconciles recovery, so with the rule disabled, acceptance is still refused by the ownership guard. I confirmed the rule works when isolated (probe R3: interrupted plus verified recovery gives "Interrupted or unknown validation prevents planning advancement").

**Fix:** add a verified recovery to the interrupted test, and prove-red the actor-table entry for self-acceptance.

**M3: several tests are weaker than their names.**
- The "crash before durable append" test is a *validation rejection*, not a crash.
- The "unrelated resume does not rerun accepted work" test appends a checkpoint with no accepted work present. A second `acceptance_recorded` refusal after reopen would be the real proof.
- The resume test's assertion `remainingSourceSectionIds.includes("requirement-ledger") === false` is vacuous.

**M4: staleness gaps across revisions** (P11, P12).
- An acceptance bound to `revision_1` stays `accepted` after `plan_revised`, with no invalidation or marking.
- Reopen is impossible until the plan is ready again.
- `checkpoint_recorded` after `plan_ready` silently resets readiness to `not_ready`.

These may belong to T6, but the behavior should be documented or bound.

**M5: small robustness points.**
- `planning-projection.ts:499` (`event.runId !== event.runId.trim()`) is a no-op-quality check.
- `recoveryStatus: "verified"` is never re-bound to a sequence or time, so a workspace lost after verification still permits acceptance until someone appends another reconciliation.
- Nothing yet collects the actual worktree and evidence facts. This is disclosed as a limit and is acceptable for a pure reducer, but the resume procedure depends on a later caller.
- The 43-file importer matrix for `scheduler-store` was not run here or by the worker (disclosed as "run by controller").

**Scope:**
- Only writable files were changed.
- The edits to `planning-contracts.ts` and `source-manifest.ts` are limited to R-1, R-2 and R-4 plumbing.
- `build-spec.ts`, `build-runtime.ts`, `architect-tools.ts`, `task-scheduler.ts`, the UI, package files and the lockfile are untouched.
- `sqlite-build-spec-store.ts` is unchanged; T1's existing I1 round-trip test covers `planningPolicy`.

**Purity:** the reducer is pure (structuredClone, and task statuses passed in as context). **G-2:** satisfied, because the rules run inside `reduceSchedulerEvent`, so direct append and replay share them.

---

## Worker claim verification (evidence/T2.md)

| Claim | Status | Basis |
|---|---|---|
| Base `21c44efb`; no commit, stage or stash | verified | `git log`, `git status` |
| File SHA-256 table (6 files) | verified | `sha256sum` matches all 6 |
| Forbidden files untouched; `sqlite-build-spec-store` needed no change; the I1 round-trip test exists and passes | verified | `git diff --stat`; test at build-spec-store.test.ts:365, passed |
| Focused matrix 111/111 pass | verified | 24 + 87 = 111 |
| Typecheck exit 0; eslint clean | verified | re-run |
| EP01: amendment impact history, drift refusal | partially verified | digest drift is refused on draft (test passes); checkpoint coverage survives an amendment (I2) |
| EP02: references "persisted once"; exports derived | **false** | references can be overwritten (I4); ledger and plan are two requirement authorities (B1) |
| EP03: ownership derived from the canonical ledger | verified as stated, but **unsound** | it derives from a ledger that diverges from the plan (B1) |
| EP04: amendment scope binding, prior-obligation preservation, cancelled-task orphan refusal | partially verified | the orphan refusal works (tested via injected context; the scheduler path passes real task statuses). The ledger-to-draft drop is not refused (B1), and the ledger path skips the R-1 scope check (I7) |
| EP09: role-checked tables, skeleton first, exact next action | partially verified | actor tables are enforced on both paths (probe P10). The next action is wrong after the ledger (I1). Observations are not bound to the owning worker (I5) |
| EP10: reconciliation, interrupted state, crash tests, WAL parity, no repeated accepted work | partially verified | WAL/memory parity, duplicate idempotency and the interrupted rule hold (R3). The crash test is a rejection proxy, and the "no repeated work" test has no accepted work (M3) |
| R-1 done | partially verified | enforced on draft/revise only (I7) |
| R-2 done | verified | the event path resolves `amend-1` after `amend-2` is registered (probe Q2) |
| R-4 done | verified, with a contract caveat | the null cases no longer throw; the arrays are rejected; M1 |
| Prove-red: self-accept | **unverified as a guard proof** | red by message only; the refusal survived via the actor table (M2) |
| Prove-red: stale revision | verified | disabling the comparison lets `revision_3` through: "Missing expected exception" |
| Prove-red: interrupted-not-passed | **unverified as a guard proof** | red by message only; acceptance was still refused by the ownership guard (M2) |
| Legacy fixtures replay unchanged; replay-compatibility unchanged | verified | test passes; file untouched. But planning events are still *admitted* on legacy runs (I6) |
| Every fixture DB closed | verified | `finally { store?.close(); rmSync }` in every SQLite test |

## Verdict

**REPAIR REQUIRED.** B1 must be fixed: ledger obligations need to bind the plan, with one requirement authority. I1–I7 should be fixed in the same repair cycle, each with a named negative test, and the two prove-red records should be redone against the real guards (M2).
