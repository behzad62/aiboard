# FX-2 - independent code re-review r2 (repair cycle 1)

Reviewer: fresh-context independent re-reviewer. I did not write this code. Date: 2026-09-28.
Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, branch `codex/runner-v2-p6-6`, HEAD `2658c8b5`. FX-2 is uncommitted.
Inputs: `FX-2-review-r1.md` (B1, M1, M2, N1-N3, probe P8), the repair brief `fx2-repair1-muse.txt`, the original brief `fx2-brief-muse.txt`, and `evidence/FX-2.md` ("Repair cycle 1").

The sha256 of every changed file matches the evidence, both before and after my probes:
- `build-runtime.ts ed9ac9e1…ccaf`
- `handoff-rerequest.test.ts ffa29cf8…183c`
- `architect-tools.ts 90db7f43…c163` (unchanged since r1)
- `build-risk-reassessment.test.ts 049a1fd5…c419` (unchanged since r1)
- `docs-policy-v2-handoff.test.ts d4ef2abd…c5e` (unchanged since r1)

My probes ran from two temporary files under `runner-v2/test/`, which I have deleted. The first was the r1 probe file, re-run unchanged. The second holds my new probes; a copy is in my scratchpad as `zz-fx2-r2-probe.test.ts`. `git status` is back to the worker's set.

**Verdict: ACCEPT**

B1 and M2 are resolved end to end through the production `NativeBuildManager`, using the product's own key shapes. The requirement count is read from the durable log at the time of the call: a replay of an answer dedupes, and a restart cannot shift the count. CR-1 and the C2a/C2b invariants still hold.

The declared trade-off is real and bounded. It is recorded as F1, a non-blocking finding that needs a follow-up; see section 3 for why it does not block, and for the one reading of the brief's rule under which it would.

## Resolution table

| r1 item | Status | Evidence |
|---|---|---|
| B1 (blocking) | **Resolved** | `build-runtime.ts:870-897` stores `<caller key>:req-<n>`, where n is the number of `verifier.selection_required` events at call time (bare key when n ≤ 1). **r1 probe P8 re-run, unchanged**, through the manager with `verifier-handoff:<run>:rev:reviewer`. Before: s3 showed 1 selection and verify stuck at 2. Now s3 records `…:rev:reviewer:req-2`, verify runs a third time, and the next unavailability records `…:sel-2`. Restart (s2r): nothing new. The worker's manager-level B1 regression drives the run to `completed`. |
| M2 | **Resolved** | `build-runtime.ts:842-867` applies the same scoping over `architect.handoff_required`. Q4 (manager, production requirement key `architect-handoff:<log length+1>`, restart): the second offer answered with the product key records `architect-handoff:<run>:arch:standby:req-2`. Replays dedupe, including after a restart. A stray answer with no offer pending is refused. |
| M1 | **Resolved** | The header (`handoff-rerequest.test.ts:70-80`) is accurate: `BuildRuntime` is built only by `buildHarnessRuntime` inside `createRuntime` factories (6 sites), with no direct `step` or `select` on a runtime. The M2 test seeds its requirements into the store, as the header says. B1 now runs through the manager. |
| N1 | **Resolved** | The file ends `});\n` (a single LF). `git diff --no-index --check /dev/null <file>` reports no whitespace errors. It is LF only, with no BOM and 0 trailing whitespace. |
| N2 | **Resolved** | The evidence wording is corrected. `git ls-files --eol` gives `architect-tools.ts i/lf w/crlf` and `build-runtime.ts i/lf w/lf`. `build-runtime.ts` has no BOM, 0 CRLF and 0 lone CR, and its non-ASCII count equals HEAD. |
| N3 | **Resolved** | The six-pack is recorded in the evidence (113 tests, 112 pass, 1 skip on macOS only). |
| CR-1 regression | **Holds** | All r1 probes P1-P9 were re-run on the repair bytes: **9/9 pass**, with the same keys and sequences as r1 (details under Probes). |
| C2a/C2b | **Hold** | P9 (docs-v2, factory-built port) matches r1 exactly (details under Probes). |

## 1. B1 and M2 end to end

- **Verifier (B1).** This is the r1 P8 re-run, and B1 is fixed:
  - s1: one requirement (bare).
  - s2: the owner selects with `verifier-handoff:run-fx2r-p8:rev:reviewer`, then the requirement `…:sel-1` is recorded.
  - s2r (after restart): identical to s2.
  - Second answer with the **same product key**: `running`/`selected`.
  - s3: selected `[<key>, <key>:req-2]`, verify 3, requirement `…:sel-2`.
  - s4 (distinct key): `<key>:distinct-2:req-3`.
  - `pumpErrors` is empty.

  The worker's regression goes further: the third verify submits a real single-pass verdict, the real `complete_run` requests the handoff, and the manager auto-applies it (`completed`/`apply_to_project`, 2 requirements and 2 selections).
- **Architect (M2), Q4.** The run pauses on `architect-handoff:18`. Then:
  - The owner selects with the product key (bare); the Architect runtime becomes `arch:standby`.
  - Restart, then a replay: deduped, log length 19 → 19.
  - The second offer is `architect-handoff:20`. The owner answers with the same product key: `…:req-2` is recorded and the run is `running`. A replay dedupes.
  - A stray `arch:architect` answer is refused ("not an offered Architect handoff").
- **Product flow.** After an Architect selection the UI resumes with the occurrence-scoped key `resume:explicit:<lastSequence+1>`, so M2 does not hit a second dedupe. The WorkBench adapter's automatic Architect handoff (`workbench-architect-handoff:<run>:<runtime>`, `native-runner-adapter.ts:309`) had the same stuck shape and is also fixed by M2. Before the repair, its loop would `continue` with no wait on every deduped answer.

## 2. Is the count durable, replay-stable and restart-stable?

Yes.
- `recordedVerifierRequirements` and `recordedArchitectHandoffRequirements` (`build-runtime.ts:900-916`) filter `this.store.readRun(runId)`. That is a fresh SQLite read of the whole log on every call, with no cache and no process state, and the read and the append happen in the same synchronous block.
- The reducer lets requirements and selections only alternate:
  - A selection is accepted only while the selection is `required` and the runtime is a candidate (`scheduler-store.ts:3868-3887`; for the Architect, only while a handoff is pending, `:5244-5256`).
  - `verifierSelection` is written only by these two events and is never cleared.

  So a selection can never change the count, and each requirement accepts exactly one selection.
- **Q1** (one candidate, product key, gated verifier, pump running):
  - A restart at requirement 1 and at requirement 2 records nothing (log length 19 → 19, 21 → 21).
  - The answer after the restart still gets `:req-2`.
  - A replay while the answered requirement is still the latest dedupes, both while verify #2 and verify #3 were in flight (selection counts 1 and 2).
- **Old logs.**
  - Replay never calls the select methods, and the reducer ignores keys, so replay is unaffected.
  - For in-flight runs, the bare key is kept for n ≤ 1.
  - A pre-fix run that is stuck on a second requirement (including the pre-existing case of a plan-critique answer followed by a final-verification (FV) requirement) is unstuck by the owner's next click.

## 3. The declared trade-off: can a stale answer land on a newer prompt?

**Mechanism.** The kernel cannot tell a fresh click from a replay: the product sends byte-identical requests for both (same key, same runtime). So a request with key K is recorded as the answer to whichever requirement is current and unanswered.

**What holds:**
- A stale answer can never override a recorded answer. Q3: while prompt 2 was answered with B, a duplicate of the prompt-1 answer (A) was refused ("Runtime rev:reviewer is not an offered verifier selection.").
- It can only select a runtime from the policy's candidate list. Verifier candidates always equal the configured policy (`scheduler-store.ts:3840-3847`), and independence is still enforced on the verdict.
- A prompt is never lost. If the re-applied runtime fails again, a new prompt is recorded:
  - Q1 `stale`: a replay after requirement 3 recorded `<key>:req-3`, and requirement 4 followed.
  - Q2: prompt 3 appeared, and the owner's B landed there.

**What does not hold at the kernel/API level:**
- **Q2.** Owner picks A for prompt 1, A is unavailable, prompt 2 is recorded. A duplicate of the prompt-1 answer is delivered late and records `<keyA>:req-2`. The owner's B for prompt 2 is then refused, and verify #3 runs with `preferredRuntimeId` A (`preferred: [null, A, A]`). That is a runtime other than the one the owner chose for the new prompt.
- **Q3.** After the owner switched to B at prompt 2, a late duplicate of the prompt-1 answer (A) lands on prompt 3, and verify #4 runs with A.

Before the repair, both duplicates deduped as no-ops.

**Can the product produce that late duplicate?**
- The only verifier client is `discussion-client.tsx:1343-1366`. `request()` (`lib/client/runner-v2.ts:1819`) has no retry.
- The choice buttons (`:2272-2281`) have no pending or disabled state, so a double-click sends two POSTs a few milliseconds apart. The server handles each on arrival; manager selections are not serialized, only counted.
- So in practice the second click either dedupes, or it lands on the immediately following requirement with **the runtime the owner just clicked**. That only re-applies the same owner's choice of the same runtime. At worst it answers one identical re-prompt early, and that prompt returns if the runtime fails again.
- The different-runtime outcome needs the duplicate to be processed **after** the owner has seen and answered the next prompt. The one product path I found:
  - The duplicate POST is parked behind the manager's runtime-activity gate (`native-build-manager.ts:911-1000`).
  - That gate closes only during live compaction triggered by **another** run's handoff or completion.
  - Meanwhile the un-gated projection GET keeps serving, so the owner sees prompt 2 and clicks B, and B queues behind the parked duplicate.

  That takes two runs on one runner, a double-click, and a compaction window longer than a human reaction.

**Consequence if it happens:** one verification attempt by a policy candidate the owner chose for this same verification seconds earlier. The owner's click gets a visible (generic HTTP 500) error, and there is a fresh prompt if that runtime fails.

**Judgment:** through the product it only re-applies the owner's own choice of the same runtime. I rate the different-runtime case non-blocking (F1). If the controller reads the brief's rule as applying to raw API callers, Q2 is the case that makes it blocking.

No kernel-only fix can satisfy both B1 and the stricter reading, because the requests are identical. Occurrence-scoped client keys alone would not fix it either: a stale request carrying an old occurrence would still be a new key. The fix needs the client to name the prompt and the kernel to refuse a mismatch.

## 4. New findings and follow-ups

| # | Severity | Finding | Follow-up |
|---|---|---|---|
| F1 | MINOR, non-blocking (route to controller) | A late duplicate of an earlier owner answer is recorded as the answer to the current unanswered requirement. This can pre-empt the owner's different answer (Q2) or land on a later prompt after the owner switched runtimes (Q3). It applies to both the verifier and the Architect handoff. It is reachable in the product only through the cross-run activity-gate race above. | (a) Expose the open requirement's event sequence in the projection (like `projectHandoff.requestedSequence`). Have the UI send it with the answer, and have the kernel refuse an answer whose sequence is not the open requirement. (b) Disable the choice buttons while a selection is pending, which removes the double-click source. Both are UI or API changes outside FX-2's writable set. |
| F2 | NIT | A replayed answer now gets HTTP 500 ("The runner could not complete the request.") instead of an idempotent 200 in two cases: its requirement was already answered with a different runtime (Q3 `dupAon2`), or it is a pre-fix answer to a second requirement replayed across the upgrade. There is no state change. The generic 500 mapping of "not an offered … selection" is pre-existing (`control-server.ts:1248-1274`). | Optionally map this refusal to 409 when F1 is done. |
| F3 | NIT | The M2 regression seeds its requirements with a non-production key (`fx2-archb1:req-N`) instead of driving the native Architect router. This is acceptable because the requirement-key code is unchanged, and Q4 re-checked it with the production shape `architect-handoff:<len+1>`. | None required. |

## Probes

All probes use real SQLite, real git and an advancing clock. Every selection goes through the production `NativeBuildManager` (`activate` and `awaitIdle` pumps, `close`/`recover` restarts), and every selection key uses the product shape.

| Probe | Setup | Result |
|---|---|---|
| r1 P1 (re-run) | v1, two withdrawals, owner UI key | Keys `[bare@19, :1@34, :2@49]`, `completed`, `requestedSequence` 49, history `[withdrawn 19 g-1, withdrawn 34 g-2]`, 3 Architect calls |
| r1 P2-P6 (re-run) | Back-to-back guidances, restart, replay/conflict, crash after or before the append | All `completed` with keys `[bare, :1]`. P4: same sequence 34 on replay, "Scheduler idempotency conflict for project-handoff-requested:1." on a changed summary. P5 and P6 as in r1. |
| r1 P7 (re-run) | Tool-level stale or duplicate `complete_run` | Every stale or duplicate call records 0 events (dedupe, conflict or `completion_not_ready`) |
| **r1 P8 (re-run)** | Verifier re-selection with the product key and a restart | **B1 fixed**: `<key>:req-2` recorded, verify 3, `:sel-2`; restart records nothing; no pump errors |
| r1 P9 (re-run) | docs-v2 factory port, two withdrawals, restart | Chain 17→33→50, tip = stop-50 commit, history `[[17,g-1],[33,g-2]]`, stop 1 refused by the manager pre-check, `completed` (128 s) |
| Q1 | One candidate, gated verify, restarts at requirements 1 and 2, replays in flight, replay after requirement 3 | Restarts: log unchanged (19, 21). Replays in flight dedupe (1, 2 selections). Post-restart answer: `:req-2`. Replay after requirement 3: `<key>:req-3` (same runtime), then requirement 4 |
| Q2 | Candidates A and B; owner A; prompt 2; late duplicate A; owner B | Duplicate recorded `<keyA>:req-2`. **Owner B refused** ("Runtime rev:backup is not an offered verifier selection."). Verify #3 used A. Prompt 3: owner B recorded `<keyB>:req-3`, verify #4 used B |
| Q3 | Candidates A and B; owner A, then B for prompt 2; late duplicate A on prompts 2 and 3 | On prompt 2: refused, B kept. On prompt 3: recorded `<keyA>:req-3`, verify #4 used A |
| Q4 | Architect handoff, production requirement keys, restart | `req-1` = `architect-handoff:18`, bare answer; post-restart replay dedupes; `req-2` = `architect-handoff:20`, answer `…:req-2`; replay dedupes; stray refused |

## Suites (NODE_TEST_CONTEXT cleared, `--test-concurrency=1`)

- Run by me:
  - The r1 probe file: 9 pass, 0 fail (140 s).
  - The r2 probe file (Q1-Q4): 4 pass, 0 fail (7 s).
- Not re-run: the worker ran these green on byte-identical files (hashes verified above), and the no-duplicate-runs rule applies:
  - handoff-rerequest (7), build-risk-reassessment and its group (121), scheduler-store (31), build-runtime (28);
  - native-build-manager, native-architect-runtime and native-verifier-factory (82), control-server (14), docs-policy-v2-handoff (44);
  - replay-compatibility with the audits (42), and the N3 six-pack (112 pass, 1 skip);
  - native-delivery-factory (17), runner `tsc` and eslint.

  Every runner-v2 test that references the changed select paths is in that set. `final-verification-completion` matches only `project.handoff_selected`, so the changed code does not reach it.
- `git diff --check -- runner-v2` is clean, and the untracked-file check is clean.
