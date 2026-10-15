# T6a independent review — r4

Reviewer: independent (Opus). Repair cycle 3 was written by the controller, not by me. I have no memory of r1–r3 or of the controller session. I did not edit any source or test file in the worktree and committed nothing. The only file I wrote in the worktree is this review.

Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, HEAD `6286a9ee`, T6a uncommitted (25 files).

Scratch folder: `C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch-t6a-r4\`
- `notes.md` is the running log.
- `copy\runner-v2\{src,test,tsconfig.json,package.json}` is a byte-identical copy. All 211 `src` files were verified identical by sha256 before and after. `copy\node_modules` is a junction to the worktree's `node_modules`.
- The probes are `copy\runner-v2\test\probe-r4-boundary.test.ts`, `probe-r4-factory.test.ts` and `probe-r4-phase.test.ts`.
- The raw logs are `run-probe-*.txt` and `pr-*.txt`. `prove-red.sh` is the injection script.

## Scope

**Read:**
- The brief `t6a-brief.txt`, and `T6a-review-r3.md` (plus r1 and r2 by reference).
- `evidence/T6a.md` "Repair cycle 3 (controller)", including its limits.
- The OA-4, OA-11, OA-12 and OA-13 text in `docs/superpowers/specs/2026-09-22-runner-v2-p6-6-owner-amendment.md`.
- The full new files `delivery-acceptance.ts`, `delivery-execution.ts` and `native-deliverable-review.ts`.
- The full diffs of `build-runtime.ts`, `native-build-factory.ts`, `architect-tools.ts`, `git-run-context.ts`, `native-architect-runtime.ts`, `user-steering-contracts.ts`, `task-contracts.ts`, `sqlite-scheduler-store.ts`, `agent-prompts.ts`, `agent-contracts.ts`, `agent-loop.ts` and `native-verifier-runtime.ts`.
- The whole T6a kernel section of `scheduler-store.ts` (`reduceDeliveryEvent` … `deliveryPhaseAccepted`, `validateDeliveryCommandEvidence`, the reason match/applicability for `delivery_boundary_failed`, `deliveryCompletionIssues`).
- The tests `delivery-acceptance.test.ts`, `native-delivery-factory.test.ts` and `support/delivery-seed.ts`.
- The relevant parts of `final-verification-runtime.ts` (`runCategory`, `authoritativeExecutionInput`, `sameCommands`, `recordEvidence`), `sqlite-evidence-store.ts` (idempotency), `verification-workspace.ts` (`safeName`) and `mutation-probe.ts` (restore in `finally`).

**Probes** run on production pieces:
- The real `NativeBuildFactory` with a real `ExecutionHost`.
- Real `createDeliveryBoundaryDriver` and `createDeliveryDepthRunner`.
- The real `FinalVerificationRuntime` and the production one-shot executor fixture.
- Real git checkouts made by `VerificationWorkspaceManager`, constructed exactly as the factory's `deliveryWorkspaceFor`.
- Real SQLite scheduler, evidence and session stores, an advancing clock, and the real pump.

**Tree integrity:** I ran sha256 on the 25 files in `git status --short`, excluding `progress.md`, at the start and at the end.
- The two lists are **identical**.
- They also equal the 25 hashes listed in `evidence/T6a.md` "SHA-256 of every file in the T6a diff" (compared mechanically).

## Verification of the r3 blockers

| r3 blocker | r4 status | Evidence |
|---|---|---|
| **B1** fake inputs | **Met** | `durableSubmission` (factory) reads the session change set, which must equal `task.changeSetId`. `loadDeliverableReviewInputs` reads the diff bytes by `diffArtifactHash`. The summary is the worker's own `submit_task` summary from its checkpoint. Claims come one per criterion from the worker's `criterionEvidenceLinks`, plus the summary. `assertInputs` refuses empty diffs and missing summaries or criteria, and the run pauses `delivery_inputs_unavailable` with no review record. Factory B9 asserts that the summary claim is the worker's text. The risk input comes from the real changed paths and diff line counts. (`acceptedFailuresUsed` is hard-coded `false`; see NOTE.) |
| **B2** depth performed | **Met for low/medium and test-only projects. Broken for any project with a build command** | The medium inspection count comes from the runtime's `InspectionCountingRuntime` and is kernel-enforced (`>=1`). At high tier the runtime runs the project test command through `FinalVerificationRuntime` and the audited executor, reads OA-13 reports if produced, and runs the OA-11 probe through `commandExecution.execute(runnerInternal)`. Every id is kernel-resolved to command evidence, with the exit code matched. **But** the high-tier depth runner throws on every project whose execution profile has a `build` command. See **R4-B1**. |
| **B3** boundary performed | **Met only for projects without a build command** | Factory B9 is real: `npm run test` runs on a clean checkout of the integration revision and passes with evidence. **With a `build` script the boundary driver throws before running anything, every time.** See **R4-B1**. |
| **B4** crash-loop | **Met** | There is no illegal transition. The boundary is generation-scoped; `deliveryBoundaryAction` and the kernel refuse a re-run on the same revision without a recheck grant. `delivery_boundary_failed` brings one Architect turn, whose legal responses are `recheck` (once per revision) or `repair_planned`. The named B3/B4 tests pass per the controller, and PR-BOUNDARY is reproduced below. Remaining dead ends are NON-BLOCKING **N-R4-2**. |
| **B5** tool session | **Met** | Each pass is a `runAgentLoop` with a broker. Tool results are fed back. The loop has provider retry, budgets, checkpoints and context manifests. |
| **B6** one-model | **Met** | The kernel refuses a `distinct_model` reviewer whose runtime or model identity matches any author or the Architect. `fresh_context` is allowed only with never-reused session ids. A new session is opened per pass. PR-SELF-REVIEW is reproduced below. |
| **B7** claim disposition | **Met** | `applyDeliveryDispositions` treats findings and claims independently. `review_required` carries `delivery{reviewId, openFindingIds, unverifiedClaimIds}`. |
| **B8** tier on request | **Met** | `delivery.review_requested` records the tier, digest and T5 inputs, and the kernel recomputes the tier. High-tier diff delivery is refused before obligations, and the stages are strictly ordered. |
| **B9** factory E2E | **Met, but narrow** | `native-delivery-factory.test.ts` builds through `NativeBuildFactory`. PR-FACTORY is reproduced (red). Its fixture has only `scripts.test`, which is why R4-B1 escaped. |
| **B10** false evidence | **Mostly met; two claims are untrue** | The corrections section is accurate. However:<br>• "project `build` (when detected) and `tests` commands through `FinalVerificationRuntime`" was never exercised with a build command, and does not work (R4-B1).<br>• "other words block phase acceptance with a visible issue" is untrue: the issue is computed and discarded (R4-B2). |

Other checks requested:

| Check | Result |
|---|---|
| Three kernel-ordered passes, each in a fresh session with real tools | **Met.** The obligations pass has only the lifecycle tool. Findings use `verifier:delivery`, or `delivery_commands` at high tier. The verdict pass uses `verifier:delivery`. The session id is a digest of (run, review generation, pass, runtime, independence), and the kernel refuses reuse. |
| High tier: audited commands, OA-11 probe, OA-13 recorded truthfully | **Truthful when it runs.** `report.status:"unknown"` is recorded with a reason when no JUnit/TRX is produced. It does not run for build projects (R4-B1). The affected-test command is the full test script; see N-R4-1. |
| Kernel rejects nonexistent evidence ids and wrong tiers | **Met** (the B2 invented-id test and the B8 tier test, which the controller ran green). |
| Architect disposes of findings and claims independently | **Met** (B7). |
| Boundary on merged code | **Met for test-only projects.** It uses a checkout pinned at `projection.integrationRevision`, and the kernel requires the current revision. |
| Failed boundary → integrated-not-accepted, one Architect turn, legal responses, no crash loop | **Met for a failed or unknown outcome.** A driver *exception* (R4-B1) instead pauses `delivery_boundary_unavailable` on every resume, with no Architect route. |
| Phase acceptance tied to plan revision | **Met.** It is keyed by `<planRevisionId>:<phaseId>`, the kernel re-evaluates it, and it is bound to the current ready revision. |
| Final-ready reachable | **Only for test-only projects whose phase validations use the 9 fixed words** (R4-B1, R4-B2). |
| Factory E2E red when wiring is removed | **Met** (PR-FACTORY below). |
| `git-run-context.ts` safe | **Met.** It adds exactly two sibling roots: `verifier-workspaces/<safeName(run)>-<safeName("delivery-review")>` and `…-<safeName("delivery-boundary")>`. `suffixSegment` mirrors `verification-workspace.ts safeName` byte for byte (slug of 12 characters plus 10 hex of sha256). No parent directory and no other workspace kind is granted, so git is not widened beyond the two runner-owned checkouts. |
| Legacy runs unchanged | **Met by inspection.** Every reducer path starts with `reduceDeliveryEvent` refusing `planningPolicyVersion !== 1`. Pump branches are gated on `=== 1`. `review_required.delivery` is optional in the parser. `applyDeliveryDispositions` is a no-op without dispositions. `assertContractTaskRevisionAllowed` needs a plan contract, which only new-policy plans have. The controller ran `replay-compatibility` green in its focused matrix; I did not re-run it. |
| Idempotency keys deterministic | **Met.** Every key is built from durable ids: `delivery-review:<reviewId>:<stage>`, `delivery-boundary:<boundaryId>`, `delivery-acceptance:<task>:<boundaryId>`, `phase-acceptance:<rev>:<phase>`, `delivery-probe:<reviewId>:<n>`, and a pause key with `lastSequence`. None carries a timestamp in the key. One interaction with `FinalVerificationRuntime` keys on an interrupted boundary: N-R4-3. |

## Prove-red records

Method:
1. Use the byte-identical copy.
2. Take sha256 before; it equals the worktree's.
3. Change exactly one guard with `sed`; the injected sha differs.
4. Run the named test on the copy.
5. Restore by `cp` from the worktree.
6. Take sha256 after; it matches.

The controller's green run on the identical bytes is the baseline, and I did not re-run it (owner rule).

| Target | Injection (copy) | sha before = after | sha injected | Result |
|---|---|---|---|---|
| PR-BOUNDARY | `scheduler-store.ts` `deliveryTaskAccepted`: `!boundary \|\| !boundary.passed \|\|` → `!boundary \|\|` | `d209abfad1ef65b75f09e90cdcbb5bef2b1cc3592e64df19326d2a1a22cf02fb` | `e7baa8073471358c99d97dff58f197425f6a7dcb00d99726dbcc58fc9abbaf71` | **RED** `B3/B4: an unknown boundary is never accepted…`: `Missing expected exception.` The forged acceptance on an unknown boundary succeeded. |
| PR-FACTORY | `native-build-factory.ts`: deleted `deliveryReview: deliveryReviewDriver,` and `deliveryBoundary: deliveryBoundaryDriver,` | `9eab8eee30c005df7b61af576f1c8065116246e9f580f732d17159febac60cb7` | `417a4743e46203146f01b4707f4cc464d0c1ca9ff2afcdbf9f9eeb8d5457c87f` | **RED** `B9: NativeBuildFactory wires…`: `New-policy task review requires the mandatory deliverable reviewer.` |
| PR-SELF-REVIEW | `scheduler-store.ts`: `if (independence === "distinct_model") {` → `if (false as boolean) {` | `d209abfa…` (full sha as above) | `4fc3c4434a7d4417945fb53e105fc0bd694d8959d0bd2c7d551c029e027eff6a` | **RED** `B6: the kernel refuses a distinct_model reviewer…`: `Missing expected exception.` |

All three restores printed MATCH, and the full `src` tree of the copy re-verified identical to the worktree afterwards.

## Findings

### BLOCKING

**R4-B1: The boundary check and the high-tier depth throw for every project whose execution profile has a `build` command. The run then pauses on every resume, and the task can never be accepted.**

Location: `delivery-execution.ts:243-248` (`runDeliveryCategory`), reached from `:513-527` (boundary) and `:335` (depth).

Cause:
- `runDeliveryCategory` passes `commands: { [input.category]: commands }`, which is only the one category, together with the full inspected profile.
- `FinalVerificationRuntime.authoritativeExecutionInput` (`final-verification-runtime.ts:1357-1360`) compares every category, and `sameCommands(undefined, profile.commands.build)` is `false`.
- So `runCategory` throws `Final verification tests runtime commands conflict with the execution profile.` for the boundary (and `…build runtime commands…` for the depth).
- Every npm project with `scripts.build` has a build command (`final-verification-profile.ts:237-239`). That is most TypeScript projects.

What happens:
- **Boundary:** `advanceDeliveryAcceptance` catches the exception and pauses `delivery_boundary_unavailable`. Each owner resume recomputes the same generation, and the same exception pauses the run again. The Architect is never involved.
- **High tier:** the review returns `delivery_depth_unavailable` after the obligations pass has already spent a model call. Each resume opens a new generation and spends another obligations pass.

Probes:
- `probe-r4-boundary.test.ts` R4-BUILD and R4-DEPTH (real driver, real FVR, production executor, real git): both attempts `THREW …runtime commands conflict with the execution profile`.
- `probe-r4-factory.test.ts` is the controller's factory E2E with the fixture changed only to `scripts: { build: "node -e 0", test: "node --test" }`, run through `NativeBuildFactory` with two owner resumes.
  - Medium: actions `…integration_integrated,delivery_boundary_unavailable,delivery_boundary_unavailable,delivery_boundary_unavailable`, detail `Final verification tests runtime commands conflict with the execution profile.`
  - High: `workers_advanced,delivery_depth_unavailable×3`, and reviewer passes `delivery-obligations-system×3`.

This is B2/B3 not met on realistic projects, and the evidence line claiming the build command runs was never exercised (B10 class).

Minimal fix:
- Pass the profile's full `commands` map (both categories) to `runCategory`, and select the category only via the plan and the `category` argument.
- Add the factory E2E variant with a `build` script, asserting that the `build` and `tests` checks both pass, and a high-tier run on it.

**R4-B2: A phase whose `requiredCombinedValidation` uses any word outside the 9-word vocabulary can never be accepted. The reason is invisible, and there is no legal route, so final-ready is silently unreachable.**

Locations: `delivery-acceptance.ts:460-479` (vocabulary) and `build-runtime.ts:2354` (`if (!evaluation.ready) continue;` discards the issues).

Why it matters:
- `requiredCombinedValidation` is free non-blank text (`planning-contracts.ts:1045`).
- No prompt, tool schema or plan-ready check tells the Architect about the vocabulary.
- Realistic plan wording such as `"unit tests"`, `"lint"`, `"npm test"` or `"integration tests"` maps to nothing.

Probe `probe-r4-phase.test.ts` R4-PHASE (the real pump and kernel, with the fixture's BP1 validations set to `["typecheck","unit tests"]`):
- All 6 tasks are accepted, and a passed `build+tests` boundary exists at the current revision.
- **BP1 is never accepted.** The pump moves straight on to `final_verification_plan_required`.
- `buildCompletionReadiness` shows only `Phase BP1 lacks durable acceptance for plan revision revision_1.`
- `renderPlanningStatus` does not mention the unmapped word.
- No Architect tool can dispose of a phase exit check.

The controller's limit says these words "block phase acceptance with a visible issue". They block it, but the issue is not visible.

Minimal fix (either option):
- (a) In the kernel, refuse a policy-v1 `planning.plan_ready` (or plan draft/revise) whose phase validations fall outside the mechanical vocabulary, with a message naming the allowed words, so the Architect corrects it while planning.
- (b) Surface `evaluatePhaseAcceptance` issues in the planning status and completion readiness, and give the Architect a kernel-validated disposition. Option (a) is smaller.

### NON-BLOCKING

**N-R4-1: The OA-4 high-tier command and the boundary run the full project test script, not the OA-12 selection, and the recorded `rung` describes the selection, not what ran** (`delivery-execution.ts:349`, `:540`).

- The full suite is OA-12 rung 4, the "safe floor". It is mechanically derived, not arbitrary, so I accept it as satisfying OA-4's "affected-test command" (it is a superset, and `echo ok` cannot be substituted by a model).
- But the record says `rung: "module_graph"` (for example) while the full suite ran. Record an `executedRung`/`executedScope: "full_suite"` beside the selection.
- At the boundary, running the full suite also makes acceptance hostage to **unrelated pre-existing failures**. The brief says "affected boundaries", and P6.6 says affected checks precede the final suite. Such a failure has only a repair route (see N-R4-2).
- Also, `outcome` is exit-status-derived and the kernel *forces* `outcome` to equal the exit mapping (`scheduler-store.ts:6200-6204`). The boundary `tests` check is "passed" on exit 0 with no OA-13 read at all. OA-13 says exit status alone is not proof that a test ran. The high-tier record is truthful because `report.status` is `unknown` with a reason, but the boundary check carries no report status.
- Owner decision recommended: either apply OA-13 at the boundary (for example, request a JUnit reporter where the ecosystem supports one), or record the check as `exit_status_only`.

**N-R4-2: Boundary dead ends with no Architect route** (`delivery-acceptance.ts:450-456`).

- After `repair_planned`, the task sits in `wait` until the integration revision changes.
- If the Architect later cancels a failed repair task, or the failure cannot be repaired within the parent contract (an environment problem, or a pre-existing failing test, see N-R4-1), nothing ever re-routes the task. The recheck is used up, and `delivery_boundary_failed` is no longer applicable because a resolution exists.
- Final verification can still start, because the task is `integrated`, but completion is impossible.
- There is no crash loop, but it is a silent stall. T6b owns the repair budget; T6a should at least re-raise `delivery_boundary_failed` when every repair task of a `repair_planned` resolution is terminal without a revision change.

**N-R4-3: An interrupted boundary retry reuses the same `boundaryId`** (generation = recorded count + 1).

- The retry therefore reuses the same FVR evidence and process-invocation keys, whose payloads carry timestamps.
- Probe R4-IDEM (test-only project; runner "dies" after the commands ran and before `delivery.boundary_checked`): the retry did **not** throw. It returned `tests: unknown` with `Dependency provisioning could not start: Process idempotency conflict for inv-…`.
- That records a spurious `unknown`, which costs the Architect turn and the per-revision recheck (the recheck then passes on generation 2).
- For a profile without a provisioning step, the evidence-key conflict (`sqlite-evidence-store.ts:162`) would throw instead and pause-loop like R4-B1. I did not prove that variant.
- Fix: scope the boundary's FVR `generationId` by an attempt nonce that is durably recorded before the run (a `delivery.boundary_started` event), or record the boundary before the commands run.

### NOTE

- `acceptedFailuresUsed` is hard-coded `false` at the request (`native-deliverable-review.ts:280`), and the kernel does not derive it. That is correct for a first submission. For a fix re-review, a prior attempt's Architect `acceptedFailures` waiver is ignored as an OA-4 signal.
- The kernel verifies that boundary and depth evidence ids are command facts of this run with a matching final exit code. It does not bind them to `integrationRevision`/`targetRevision` or to a `delivery:<task>` evidence task. The runner is the only writer, so this is not exploitable by a model.
- `readProducedTestReport` would read a committed, stale `junit.xml`/`test-results.xml` as if the command had produced it. Check the file's mtime or clear the path before the run.
- `inspectionToolCalls` is attached by the runtime closure and the kernel trusts the number. There is no cross-check against the tool ledger.
- The kernel accepts `fresh_context` even when a distinct model was available. The routing choice is the runtime's.

**The 23 parallel full-suite failures** (affected-tests, mcp-lazy-native, portable-process-protocol, posix-process-backend, process-tools, subprocess-runtime, windows-process-backend, lsp-language-provider):
- Seven of the 8 files import no T6a-changed module except `agent-contracts.ts`, which gained one union member (process-tools).
- `affected-tests` NB3 depends on the cwd, as the controller notes.
- `mcp-lazy-native` imports `native-build-factory.ts`. The T6a change there is construction-only, plus two extra workspace cleanups at close. The `createDeliveryWorkspaceSlot.cleanup` path builds a manager and runs its cleanup even when the slot was never used, which adds git work at close. That can lengthen a timing-sensitive real-host test under parallel load, but it does not change behavior.
- The `git-run-context.ts` change only adds two exact roots and cannot make an existing git call fail.
- I judge none of the 23 T6a-caused, and consistent with the controller's serial re-runs passing. I did not re-run them (owner rule).

## Commands and counts

| Command | Tests | Pass | Fail |
|---|---|---|---|
| sha256 of 25 changed files, start vs end vs the evidence list | — | 25/25 identical | — |
| Scratch copy `src` (211 files), identity to the worktree before and after | — | identical | — |
| `probe-r4-boundary.test.ts` (R4-BUILD, R4-DEPTH, R4-IDEM) | 3 | 2 | 1 |
| `probe-r4-factory.test.ts` (factory E2E with `scripts.build`, medium and high) | 2 | 0 | 2 |
| `probe-r4-phase.test.ts --test-name-pattern=R4-PHASE` | 1 | 1 | 0 |
| PR-BOUNDARY (injected copy, named test) | 1 | 0 | 1 |
| PR-FACTORY (injected copy, named test) | 1 | 0 | 1 |
| PR-SELF-REVIEW (injected copy, named test) | 1 | 0 | 1 |

In the probes, "fail" is the observed defect, not a harness failure:
- R4-BUILD and R4-DEPTH pass by asserting the exception.
- R4-IDEM failed its throw-expectation and showed the `unknown` result instead (N-R4-3).
- The factory probe fails because the run pauses (R4-B1).
- The prove-reds are red as intended.

I did not re-run any suite the controller reported green (owner rule).

`T6a REVIEW r4 — REPAIR REQUIRED — 2 blocking`
