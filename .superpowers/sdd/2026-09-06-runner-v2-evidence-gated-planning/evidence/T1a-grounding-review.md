# Independent review — commit c62847a1 "P6.6 T1a grounding corrections G-1..G-11"

Reviewed against: workspace `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6` (branch
`codex/runner-v2-p6-6`, HEAD `c62847a1`), current `runner-v2/src`, the T1a report
(`.superpowers/sdd/2026-09-06-runner-v2-evidence-gated-planning/evidence/T1a-compatibility-map.md`),
plan section 6 ledger, and `docs/superpowers/specs/2026-09-22-runner-v2-p6-6-owner-amendment.md`.

## 1. Factual accuracy of G-1..G-11

All eleven corrections were independently re-verified against current code (fresh greps/reads,
not trust of the T1a report or the commit text). All check out.

| Item | Claim | Verified |
|---|---|---|
| G-1 | `runner-capability-contract.ts` is the digest-checked extension/plugin-trust contract, unrelated to planning | `runner-capability-contract.ts:47` `RUNNER_CAPABILITY_CONTRACT_VERSION = 1`; `:98` `interface RunnerCapabilityContract`. `HostPlanningCapabilities` — zero occurrences anywhere in `runner-v2/src` (correctly new). TRUE |
| G-2 | T2 extends `reduceSchedulerEvent` in `scheduler-store.ts`, not `reducer.ts` | `scheduler-store.ts:1735 export function reduceSchedulerEvent(`; `reducer.ts:56 export function reduceRunEvent(`, `:134 export function rebuildRunProjection(` — two distinct reducers, confirmed. TRUE |
| G-3 | `buildCompletionReadiness` at `scheduler-store.ts` ~977-1043 (not 848-873); `projectDocumentationReadiness` ~1188 | `scheduler-store.ts:977 export function buildCompletionReadiness(`; `:1188 function projectDocumentationReadiness(`. Note: the *owner amendment doc itself* (`2026-09-22-runner-v2-p6-6-owner-amendment.md` OA-5) still cites `848-873` — confirms the stale citation genuinely originated upstream and G-3's fix is necessary, not invented. TRUE |
| G-4 | No "reader" role; roles are architect\|verifier\|plan-critic\|worker; "reader" = inspection-broker surface | `role-capabilities.ts:11 RoleCapabilityRole = "architect" \| "verifier" \| "plan-critic" \| "worker"`. TRUE |
| G-5 | `MAX_WORKERS` doesn't exist; only run-level `DEFAULT_REPAIR_PLAN_LIMIT=3`; `issueIds` is mechanical-failure attribution, not repair-issue identity | `grep -rn MAX_WORKERS runner-v2/src/*.ts` → zero hits. `scheduler-store.ts:493 DEFAULT_REPAIR_PLAN_LIMIT = 3`. `issueIds` ties to `type: "mechanical_failure"` (`architect-tools.ts:175`), distinct union member from any repair-budget concept. TRUE |
| G-6 | `RuntimeRouter.selectVerifier` (~178) returns `independence: "distinct_model" \| "fresh_context"` (~220) | `runtime-router.ts:178 selectVerifier(...)`; `:220 independence: distinct ? "distinct_model" : "fresh_context"`. TRUE |
| G-7 | RG-6 two-pass lives in verifier family; final-candidate gate lives in `final-verification-*.ts`; T6 extends former, T8 owns latter | `native-verifier-runtime.ts:216 class NativeVerifierRuntime`, `:666`/`:1106` "Two-pass verifier inspection requires a baseline revision." Eight `final-verification-*.ts` files confirmed to exist as a separate family. TRUE |
| G-8 | `risk-policy.ts` (`assessBuildRisk`, low/high) gates `risk_based` verifier policy; distinct from T5's `change-risk.ts` | `risk-policy.ts:1 BuildRiskLevel = "low" \| "high"`; `:169 assessBuildRisk`; consumed at `scheduler-store.ts:1146` (`if (projection.verifierPolicy?.mode === "risk_based")`) and `build-runtime.ts:1293` (`assessment: assessBuildRisk(input)`). TRUE |
| G-9 | Resolved-critique guard already enforced in `applyPlanCritiqueRequested` (~4912) | `scheduler-store.ts:4876 function applyPlanCritiqueRequested`; `:4912-4913`: `if (state.current?.status === "resolved" \|\| state.history.some((entry) => entry.status === "resolved")) { throw new Error("Plan critique is already resolved for this run."); }` — a **kernel-level** (event-reducer) guard, stronger than the caller-side `plan-critique-authority.ts:requestCritique()` check T1a's own §4 item 11 had flagged as unconfirmed. This genuinely resolves T1a's hedge, not merely restates it. TRUE |
| G-10 | mkdtemp sites: `execution-host.ts`, `native-build-factory.ts`, `runner-capability-contract.ts` (×2), `windows-process-semantic-probes.ts`; none writes a creation record | `grep -rn mkdtemp runner-v2/src/*.ts` → exactly those 5 call sites in those 4 files, none followed by a creation-record write. TRUE (see §3 below — the correction's *narrative* is accurate but the scope line was not updated to match) |
| G-11 | `submit_task` only sets `ready_for_architect_review`; `review_task`/`request_integration` are Architect-only; `IntegrationManager.integrate` is the sole integration authority | `worker-lifecycle-tools.ts:119 readiness: "ready_for_architect_review"`; `architect-tools.ts:1549 name: "review_task"`, `:1693 name: "request_integration"`, both gated by `architectOnly(context)`; `integration-manager.ts:163 class IntegrationManager`, `:490 async integrate(changeSet)`. TRUE |

No factual error found in G-1..G-11.

## 2. Scope impact on P6.6 ledger obligations (EP01–EP52) / owner amendment

G-1 through G-11 relocate *where* work happens (file targets, symbol names, line citations) — none
removes, weakens, or narrows an EP-numbered obligation's substance:
- G-1: `HostPlanningCapabilities`'s required content (line 104 of the plan, table row) is unchanged; only its destination file moves.
- G-5/G-7/G-8: correctly keep T4's `MAX_WORKERS=4`, T6's issue-level repair ceiling, and T5's `change-risk.ts` as genuinely new work — none is redefined as "already exists" to shrink scope.
- G-9: strengthens, not weakens, RG-1's guarantee (finds the real kernel enforcement point).
- Checked the owner amendment doc (`2026-09-22-runner-v2-p6-6-owner-amendment.md`) for every OA referenced by G-1..G-11 (OA-3/4/5/7/10/17): none names a specific implementation file, so none of G-1..G-11 conflicts with amendment text.

**One partial exception, not a weakening but a narrowing worth flagging:** G-7 changes T6's final-verification touch from the previous open-ended "final-verification orchestration" to "`final-verification-*.ts` only for the final-ready readiness condition (T8 owns the final-candidate gate)." This is a legitimate, code-grounded narrowing (see §3, item 1) — not a violation of item 2's "no scope changes" instruction in a harmful sense, since it resolves a genuine T6/T8 file-ownership ambiguity that existed before. Flagged as MINOR since it deviates from T1a §6's literal wording (see next section) even though it is better grounded.

## 3. Corrections T1a proposed that were not applied, or applied incorrectly

Cross-checked every item in T1a §4 (11 items) and §6 (8 supplementary findings) against G-1..G-11
and the edited T1/T6 scope lines.

**All of §4 items 1–7, 9, 10, 11 are folded into G-1..G-11** (item 9, `inspect_evidence` reuse
note, is folded into G-4's closing sentence). §4 item 8 ("no new overlap found") is confirmatory
only and needed no plan edit. §6 items 2–8 are confirmatory/informational (task-kind check,
`DiscussionMode`, M9 filesystem exclusion, `/build/audit` route, `test:runner-v2` script,
`build-observability.ts` exports) and correctly required no plan-text change.

**§6 item 1 (T6/T8 file-family split) — IMPORTANT, partially unapplied.**
T1a's report recommends: *"T6's scope/files list ... should instead read 'extend
`native-verifier-runtime.ts`, `verifier-verdict-authority.ts`, `verifier-tools.ts`,
`verifier-contracts.ts`' for the deliverable-review/repair work, **leaving the
`final-verification-*.ts` family as T8's sole scope**."*
The applied G-7 correction and the edited T6 scope line instead keep T6 touching
`final-verification-*.ts` narrowly ("only for the final-ready readiness condition"). This is a
deliberate deviation from T1a's literal recommendation, not an oversight — and it is independently
grounded: `buildCompletionReadiness` (`scheduler-store.ts:977-1043`, already inside T6's own
declared scope) already calls `validateFinalVerificationPlan` (`final-verification-contracts.ts:81`)
and `projectFinalVerificationCheck` for the run-wide completion gate, so T6's checklist item
"Final-ready requires all applicable requirements and cross-task reconciliation" (plan line 258)
genuinely needs to extend that existing call site. Rated MINOR: the controller's judgment call is
better-grounded than T1a's own supplementary suggestion, and it explicitly carves out "T8 owns the
final-candidate gate," so it does not create a new T6/T8 conflict.

**T1a §3 (T6 reuse notes) — IMPORTANT, unapplied.**
T1a's per-task notes state explicitly: *"T6's scope/files list does not currently name any of
these four files [`execution-host.ts`, `native-build-factory.ts`, `runner-capability-contract.ts`,
`windows-process-semantic-probes.ts`] and should add them as read/audit targets."* This is the
direct scope-line consequence of G-10 (same four files, same finding). **G-10 as written in
section 5.0 only narrates the finding; it does not edit T6's Scope/files line (plan line 249) to
add these four files.** T6's checklist explicitly requires this work — EP51/OA-17 (plan line 265):
*"add a creation record, written whenever the runner creates a directory or file outside the
workspace (including the OA-11 disposable copy and other `mkdtemp` sites)."* Verified directly:
none of `execution-host.ts`, `native-build-factory.ts`, `runner-capability-contract.ts`,
`windows-process-semantic-probes.ts` appears anywhere in T6's Scope/files line, and no other task's
scope line covers them either (only `native-build-factory.ts` appears elsewhere, in T3's scope —
a separate potential file-touch overlap between T3 and T6 that the plan does not call out, though T6
already runs after T3/T4/T5 per its own "serialized after T4/T5" note, so sequencing likely absorbs
it). **This is a concrete, ledger-required (EP51) file-edit target left out of the binding scope
declaration, despite T1a explicitly recommending the fix and the controller's own G-10 restating the
same fact without applying it.**

No case was found of the controller applying a T1a-proposed correction *incorrectly* (i.e., in a way
that contradicts the code) — the one gap found is an omission (a correction narrated in prose but not
carried into the scope line it was meant to fix), not a wrong application.

## 4. T6 scope-line coverage and T6/T8 conflict check

- T6's edited scope line now covers: `delivery-acceptance.ts` (new), `build-runtime.ts`,
  `scheduler-store.ts`, `architect-tools.ts`, `worker-lifecycle-tools.ts`, `worker-runtime.ts`,
  `integration-manager.ts`, the four RG-6 verifier-family files, `final-verification-*.ts` (narrow),
  and "actual P6.5 repair/replan contracts." This covers essentially all checklist bullets **except**
  the OA-17/EP51 temp-path creation-record work (§3 above) — that work's actual file targets
  (`execution-host.ts`, `native-build-factory.ts`, `runner-capability-contract.ts`,
  `windows-process-semantic-probes.ts`) are not listed, though the checklist bullet requiring them
  (line 265) is present. Process-side OA-17 (`durable-process-store.ts`, `managed-process-*`) is a
  pure-reuse target per T1a and is reasonably omitted from an "extend" list.
- No new conflict with T8's scope was introduced. T8's own Scope/files line (line 293) was not
  edited by this commit and remains file-generic ("final package/capability exposure as required
  for the new contract"); G-7's explicit "(T8 owns the final-candidate gate)" reduces ambiguity
  rather than creating overlap. `final-verification-*.ts` is not listed as T6-exclusive; the plan's
  language ("only for the final-ready readiness condition") is consistent with T8 separately owning
  the broader final-candidate gate logic in the same file family — this is a shared-file situation
  already common elsewhere in the plan (e.g. T3/T9 both write `scheduler-store.ts`) and section 4's
  serialization rules would need to cover it the same way, which this commit does not change but
  also does not break.

## Verdict

**CORRECTIONS INSUFFICIENT** — blocking condition: T6's Scope/files line (plan line 249) must be
amended to add `execution-host.ts`, `native-build-factory.ts`, `runner-capability-contract.ts`, and
`windows-process-semantic-probes.ts` (or an equivalent explicit statement covering "every `mkdtemp`
call site") so the file scope matches the EP51/OA-17 checklist obligation already in section 6.0's
own G-10 finding and T1a's explicit, unapplied recommendation. This is a completeness gap in the
grounding-correction pass, not a factual error: every one of G-1..G-11's factual claims verified
true against current code, and no correction weakens or removes an EP-numbered obligation. Once the
T6 scope line is amended, this pass is otherwise sound and would read CORRECTIONS VERIFIED.
