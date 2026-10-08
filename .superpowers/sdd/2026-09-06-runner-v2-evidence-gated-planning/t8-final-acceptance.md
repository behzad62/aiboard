# T8 final acceptance — DRAFT / NOT ACCEPTED

Date: 2026-10-07
Branch: `codex/p66-t8`
Base: accepted T10 `51bf0da7395148e0c82be8e8c7aab22c7c312a17`
Status: **FROZEN FOR LAYER 4 - T8 is not accepted until the exact frozen candidate passes the required final gates.**

This is the single durable T8 evidence index. It does not replace the execution checklist and it does not claim P7/release/deployment acceptance.

## Independent source-to-delivery reconciliation

Controller: GPT-5.6 Sol, independent from Muse Spark 1.3 Contributor implementation/repair turns.

| T8 / amendment obligation | Current evidence / scheduled final gate |
|---|---|
| Original source + approved amendments reconciled before expensive suite | Controller re-read SRC-P T8, EP16/27/28/29, AR-R31 and the accepted execution checklist. Earlier packet reviews are reused when their owned code is unchanged. T8-specific gaps are tested below; final full suite is still pending. |
| Complete spec with amendment + mandatory/conditional/operational obligations | `t8-final-qualification.test.ts` A1 builds from source v1, appends the operational amendment, persists mandatory/conditional/operational requirements, resolves the conditional lifecycle and verifies the final source denominator. |
| Parallel/disjoint tasks | A1 keeps `maxConcurrency: 2` and asserts T-A/T-B dispatch before T-A correction; `task-resource-claims.test.ts` T4 also exercises real SQLite concurrent admission. |
| Shared-resource serialization | `t8-final-resource-budget.test.ts` proves two otherwise-disjoint tasks with the same normalized semantic resource conflict until the active claim is released. |
| Failing check + zero-selection check | A1 records a deliberate red evidence command and a TAP zero-selection probe, excludes the zero-selection record from accepted criterion evidence, and requires the red probe to be genuinely non-zero. |
| Corrected independent review | A1 rejects T-A attempt 1 for the missing conformance marker, sends correction guidance, accepts attempt 2 only after a fresh reviewer read/citations, then runs the independent final verifier. |
| Restart mid-validation | A1 pauses with T-A submitted before its first rejection, snapshots the paused stop with Architect notes, closes/reopens the native manager, verifies exact event replay and in-flight task state, then resumes through review and correction. |
| Evidence reuse / invalidation | AR-4 amends parent “unrelated-change reuse” to exact identity only. A1 proves identical T-B command/tree/environment reuse with the same output bytes; a related T-C content change forces a fresh execution. Semantic unrelated-change reuse remains P7. |
| Budget exhaustion | `t8-final-resource-budget.test.ts` uses production `BudgetedToolRuntime` + SQLite ledger; the second call is `budget_exhausted` before dispatch and accepted usage is durable. |
| Plan-only attempted execution | A3 proves explicit start and direct execution are refused, no worker dispatches, and the immutable plan-only snapshot contains the plan plus optional approved-spec copy. |
| Answer journeys | B1 pure question, B2 answer→build, B3 mixed request→build, B4 clarify→ask_user→triage. Existing final-suite docs/phase-C tests prove the answered path changes no project bytes. |
| Token cost per gate | A1 records `ContextManifest` for every model pass and prints a purpose→passes/tokens rollup. T10 before/after per-role P6.5.4 manifest counts are copied below. |
| C#/.NET + TRX | D1 runs a real .NET fixture through the test pipeline with failing then passing TRX. Host: .NET 10.0.100 available. |
| C/C++ + CMake/ctest JUnit | D2 executes real CMake/ctest report plumbing. CMake/ctest 4.1.2 are available; no C/C++ compiler is on PATH, so the compile-specific part is an explicit host-gated skip, never a pass. T8 fixes ctest relative-output handling so a newly planned JUnit path is absolute while reused user flags are not rewritten. |
| Python family | D3a proves detection/planning/reader/mutator behavior. Python 3.11.9 exists; live pytest is an explicit host-gated skip because pytest is not installed. |
| Unknown-language safe floor | D4 proves no invented language family and no false-green result. |
| Source→requirement→task→evidence + final conjunction | A1 walks every applicable final requirement to contributing task, accepted review, passed boundary and executed check; requires no unsatisfied review, approved final verifier and `buildCompletionReadiness(...).ready === true`. E1/E1b independently pin omitted-obligation/open-failure fail-closed behavior. |
| Explicit integration / cleanup / recovery / current identities | A1 uses real isolated Git worktrees, exact owner-start identity, integration revisions, pause/reopen recovery, final handoff and cleanup. Final tree is asserted exactly. |
| v2 final build tree | A1 final snapshot permits only product files + `STATE.md` + marked `AGENTS.md` + `CLAUDE.md` pointer; no diary/progress/evidence files and no spec copy in this run. |
| Answered run adds no project file | Existing `docs-policy-v2-handoff-gate.test.ts`, `docs-policy-v2-stop-snapshot.test.ts`, T7a source-free answer, and phase-C acceptance pin zero project mutation; included in the required final runner suite. |
| Plan-only snapshot contains plan | A3 inspects immutable snapshot `STATE.md` for plan identities and validates optional spec copy. |
| Pause snapshot contains stop + notes | A1 inspects the pause snapshot for stopKind=paused, T-A state and `T8S_NOTES`. |
| v1 docs/replay compatibility | C5 replays a recorded v1 log to an unchanged projection; full replay/legacy suites remain in the final runner suite. |
| Final full-suite / build / UI / package / platform gates | **PENDING** until the WIP is frozen to one commit. See “Layer 4” below. |

### Local layer4 follow-up — full launch held

UI prerequisite repair current state: sole Muse-owned change tests/e2e/runner-v2-final-verification.spec.ts modernizes explicit finite tmp-only Git fixture adapters, real production one-shot command graph and real ExecutionHost managed-process authority. No production change. All55 original assertions,5 test names and90/45/60/60/60second caps are AST-confirmed unchanged. Controller required visible graph/run/host cleanup errors, attempted independent owner/remaining teardown, body+teardown error aggregation and CRLF UTF8noBOM restoration; final fileSHA25659a0171eea011ea6a9b2df489a3154a1e52804532b0cc28e4221da668117fdd3. All three bounded Muse sessions ended0. Controller complete-diff review and independent fresh fixture review ACCEPT, no blockers. Owned/transitive TypeScript, lint, assertion-preservation inspection and diffcheck all trueexit0 (D:/tmp/t8-sol-ui-{types,lint,original-assertions,diffcheck}.meta.json). Actual complete five original Playwright journeys GREEN5/5,exit0,0fail/skip/interrupted,81234ms; D:/tmp/t8-sol-ui-focused-r2.{log,exit,meta.json}, logSHA256ef66cd1fd492735850df2e1143cfe569d5326f5848ad6893c2e82b5f618c6e6e. They reach exact integrated real build/test/runtime/browser/evidence/cleanup, stale/breakage negatives, real CLI stop/port reuse/reopen, durable category resume with original evidence ID and exactly one submission, and real native descendant/browser cancellation with port release. Git fixture mechanics do not certify full product Git execution; the host binding's fixture digest is a descriptor and actual Windows probes run (no injected processHostFacts). Existing baseline browser/workspace/integration cleanup catches remain scope limits, not universal cleanup proof. All56 prior frozen hashes unchanged; additive reviewed UI fixture is the57th source/test input. Combined9-test planning/steering/final-verification UI gate remains required before intended full-suite launch. No new full suite active; T8 NOT ACCEPTED; REL-1 NOT STARTED; main untouched.

Local layer4 follow-up on61029cf2769c9ae0b473b74e4391d0d32ec885f8: full lint exit0 (164 warnings/0errors), production build exit0 (21 static routes); regenerated native/WorkBench archives contain all10 changed production source files and are committed61029cf2. Verified main's active dev server has a separate physical/canonical .next output root; target had no active dev server. Three-feature Playwright gate completed trueexit1:9 tests,4pass/5fail,90722ms. All five final-verification tests stop at createFixture→captureGitBaseline with `An explicit run-owned Git runner is required`; planning1/1 and steering3/3 pass. Evidence D:/tmp/t8-sol-layer4-ui.{log,exit,meta.json}; logSHA2566f65f9d463427d68e454beceb3b22462eacaa48982f2dfa368c023e6731360db. UI fixture and Git guard/baseline files are byte-identical to1052d5b9 and acceptedT10; this is pre-existing fixture API drift, not evidence of a repair-created guard regression. No baseline source flip or new checkout was used. All56 frozen source/test hashes remain unchanged. Frozen runner-prerequisite eligibility staysYES, but the intended fresh full-suite launch is HELD until narrow Muse-only UI-fixture modernization, complete five-journey passing evidence, independent review and combined9-test UI rerun. Preserve all assertions, real process/browser/CLI/restart/cleanup journeys and existing caps; no production fallback, stubbed execution/receipts, skip or timeout inflation. T8 NOT ACCEPTED; REL-1 NOT STARTED; no full suite/writer active at diagnosis.

### Repaired-candidate linkage — 2026-10-08

Independent read-only source-to-delivery reconciliation ACCEPTS SRC-P T8/EP16/27-29 and AR-4/AR-R31 against repair delta `1052d5b9..9ba0eefd`. Complete code/test review ACCEPT. Manifest `D:/tmp/t8-sol-source-freeze.json` covers all56 changed source/test files; SHA256 `3beaf3c0122510afdf9ed748bacb8290dd696c8520db3e1f0d306d12bde72a6a`; every raw hash matches. `98ed8d38` adds only status documentation after `9ba0eefd`. Original completed full suite at1052d5b9 remains failed148/4616,exit1 and does not certify repaired code. All148 original failures have focused GREEN evidence.

Applicable mandatory obligations in the table retain unchanged accepted packet evidence or these explicit current-candidate checks: fresh root npm suite includes A1/A3/B1-B4/C5/D1-D4/E1/E1b, A2/A4 resource/budget, T4 concurrency, docs/answer/T7/handoff/replay; fresh A1 manifests supply the per-gate token rollup. Missing pytest/compiler steps remain actual host-gated skips, never passes. CMake/ctest report plumbing is not compiled-C++ proof. The root wildcard omits nested hosted qualification tests.

Frozen prerequisites: Runner/app types, changed-file lint and diff exit0; owning22/22,subsystem202/202 and complete E1-E5/V1-V3/W3 products24/24 exit0,zero fail/skip/cancel. Metadata/commands/log hashes: `D:/tmp/t8-sol-frozen-*.meta.json`. Whole triage36/36, seven selected T7b owner/source/readiness controls7/7 and actual Phase-C positive start/source/handoff1/1 now finish trueexit0,no fail/skip/cancel on docs-only7015ee67; all frozen test gates292/292, all56 source/test hashes unchanged. Fresh local full-suite eligibility YES. With those prerequisites complete, the owner's remediation request and SRC-P T8 permit one fresh exact `npm run test:runner-v2`, including all12 chained client/policy/UI/observability scripts. Local full lint/build/UI checks will run before that expensive launch. No other full run overlaps it.

Remaining feature UI command: `npm run test:e2e -- tests/e2e/runner-v2-t8-planning-journey.spec.ts tests/e2e/runner-v2-user-steering.spec.ts tests/e2e/runner-v2-final-verification.spec.ts`. Build requires no active dev server. Remaining package/platform evidence: candidate-linked archive/installed-entrypoint parity, three-host archive hashes, Node24 Windows/Linux/macOS portable/native lifecycle/readiness/recovery, Windows channel/Job, OCI and benchmark dispositions. Explicit Linux/macOS affected coverage must include execution-grants, filesystem-mutation-fence, filesystem-mutation-routing, filesystem-tools, openrouter-apply-patch-tool, tool-broker and real openrouter-apply-patch-factory files. Current portable workflow excludes these repair files; its green alone cannot qualify the changed platform branches. Record actual filesystem case behavior and legitimate Windows-only skips.

T8 remains NOT ACCEPTED pending final validation, truthful host/platform scope, exact owned-resource disposition and durable closure. REL-1 NOT STARTED. Independent reconciliation record: `D:/tmp/t8-sol-reconciliation-20261008.md`; no tests or edits during that review. Historical accepted unchanged phases and uncertainty remain preserved.

## T10 per-role prompt-token handoff (P6.5.4 ContextManifest estimator)

`ContextManifest.estimatedTokens = ceil(rendered UTF-8 bytes / 4)`. BEFORE is accepted R3; AFTER is accepted T10.

| Role | Before | After | Delta |
|---|---:|---:|---:|
| worker | 794 | 876 | +82 |
| architect docs-v2 plan_required | 975 | 1110 | +135 |
| verifier expectations | 262 | 275 | +13 |
| verifier verdict | 573 | 556 | -17 |
| plan critic | 279 | 280 | +1 |
| coverage derive | 414 | 411 | -3 |
| coverage verdict | 219 | 253 | +34 |
| answer-review findings | 221 | 255 | +34 |
| answer-review verdict | 228 | 261 | +33 |

The deliverable reviewer has no public ContextPack builder; no manifest number is invented. Full fixture/methodology remains in `prompt-review-2026-09-23.md`.


### A1 per-gate ContextManifest rollup

| Purpose | Passes | Estimated context tokens |
|---|---:|---:|
| architect:completion_decision_required | 1 | 11,419 |
| architect:final_verification_plan_required | 1 | 21,021 |
| architect:final_verification_review_required | 1 | 11,963 |
| architect:integration_approval_required | 3 | 15,069 |
| architect:plan_required | 5 | 41,378 |
| architect:review_required | 4 | 21,268 |
| coverage:derive | 1 | 577 |
| coverage:verdict | 1 | 2,230 |
| critic:plan_critique | 1 | 372 |
| delivery:findings | 4 | 7,901 |
| delivery:obligations | 2 | 392 |
| delivery:verdict | 4 | 9,797 |
| handoff_notes | 1 | 32 |
| verifier:expectations | 1 | 334 |
| verifier:verdict | 1 | 2,976 |
| worker:task | 4 | 10,474 |

These are the durable ContextManifest estimator values for the A1 synthetic qualification. Actual usage attribution is kept separate by the product usage projection; where several manifests share one session the UI intentionally reports attribution as ambiguous rather than inventing a per-pass actual-token split.
## T8 defects / fixture debt found before freeze

1. **Production:** ctest relative `--output-junit` is resolved against `--test-dir`; new plans now use an absolute owned JUnit path. Focused V3/T8 language tests cover the behavior.
2. **Production:** docs-v2 first verification may be anchored only to the **durably recorded** `delivery.test_integrity_initialized` creation baseline when no integration revision exists. `validateKernelSnapshotVerificationAdvance` now uses `projection.integrationRevision ?? projection.testIntegrity.initialRevision`; missing durable authority or any mismatched/foreign movement fails closed.
3. **Production:** project subprocesses inherited Node test-runner coordination state. `NODE_TEST_CONTEXT` and `NODE_TEST_WORKER_ID` are now stripped by the central child-environment policy; ordinary `NODE_OPTIONS` stays allowed. Focused child-environment coverage is required before freeze.
4. **Fixture debt:** planning-review, native-architect-runtime, docs-v2 stop-revision and T4 resource-claim tests were modernized to current planning-v1/docs-v2 source authority and explicit-start contracts rather than weakening production guards.
5. **T8 fixture:** scripted worker/reviewer/verifier handling was made truthful for current tool-result shapes, fresh-read citations, validation scope, final-verifier passes and restart-safe re-review.

## Current focused evidence

- Final-source A1 after all production repairs: **1/1 pass**, 0 fail/skip/cancel, 886595.5434ms test / 887449.6615ms total; this supersedes earlier A1 diagnostics.
- Controller cheap regression batch on the same source: **113/113 pass** across child environment, planning-review, native-architect, T4 resource claims and T8 budget/resource; focused ctest + docs-v2 authority batch **4/4 pass**.
- Full docs-v2 stop-revision suite after the fail-closed authority repair: **13/13 pass** (writer run; controller independently reran the three changed authority cases 3/3 inside the 4/4 focused batch).
- Feature-specific Playwright gate on the same source: **1/1 pass** in Chromium (~1.4m), proving source→plan/coverage UI→export/copy/download→stale-start negatives→exact explicit owner start→subsequent dispatch.
- `npm run typecheck:runner-v2`: exit 0. ESLint on every changed/new TS/TSX file: exit 0 (five pre-existing unused-variable warnings in `v3-language-profiles.test.ts`, no errors). `git diff --check`: exit 0.
- `npm run publish-downloads`: exit 0 and a second publication produced identical SHA-256 bytes for both tracked Runner ZIPs, proving the final generated downloads are deterministic/current for this source.
- Earlier pre-A1 combined batch (**173 pass, 2 diagnostic fail, 1 host-gated skip**) is retained only as defect-discovery history and is not acceptance evidence. Python live pytest remains an explicit host-gated skip because the module is absent; the Python family/reader/mutator path is otherwise green.

## Platform / Node scope

- Executed host: **Windows 10 Pro 64-bit 10.0.19045**.
- Executed Node: **v24.18.0**; Runner source/package contract is `>=24.0.0 <25`.
- Windows-specific process/job suites: required in final `npm run test:runner-v2`.
- Linux and macOS: **not executed on this local Windows host**. Package reproducibility/cross-host hash and platform-contract logic are modeled/tested locally; actual OS execution remains CI/remote coverage and must not be described as locally executed.
- C++ compiler: absent on PATH; C++ compile step host-gated.
- Python: 3.11.9 available; pytest missing, so live pytest step host-gated.
- .NET: 10.0.100 available.
- CMake/ctest: 4.1.2 available.

## Layer 4 — pending on one frozen commit

Required after all T8 repairs are committed and no source changes occur:

1. `npm run test:runner-v2`
2. `npm run typecheck:runner-v2`
3. `npm run lint`
4. `npm run build` (with no dev server running)
5. Feature Playwright gate: `npm run test:e2e` journeys required by T7d (source→plan→review→export→explicit-start / steering-final-verification coverage)
6. Package/source parity including `runner-v2/test/package-parity.test.ts`
7. Supported Node/platform contract checks including `runner-v2/test/node-version.test.ts` and Windows Job/process suites
8. `git diff --check` / clean frozen candidate

For every red: reproduce on the accepted T10 base when relevant, classify pre-existing vs T8-caused, repair T8-caused failures, rerun affected checks, then invalidate and rerun the full final suite if production/shared code changed.

## Acceptance

**NOT ACCEPTED YET.** Do not render the source completion string until the corrected A1 spine and layer 4 on the exact frozen commit are green (apart from explicit source-authorized host skips), with no mandatory finding or acceptance failure open.
