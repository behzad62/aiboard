# T8 full-suite remediation — 2026-10-08

Status: DIAGNOSIS / REPAIR IN PROGRESS. T8 NOT ACCEPTED. REL-1 NOT STARTED.

Baseline: clean `codex/p66-t8`, HEAD `1052d5b98c03ac577ff284869cb35f4b3a525611`, parent `be51655a8d3852998c8f762e457925d676c71829`. Main remains untouched. Node v24.18.0. No active original suite or Muse writer found. Two surviving managed supervisors from original NativeBuildFactory fixtures were observed; PID identity alone is not cleanup authority.

Completed original suite: `npm run test:runner-v2`, exit **1**, 4616 tests, 4462 passed, 148 failed, 6 skipped, 0 cancelled. Original log `D:/tmp/t8-final-1052d5b9.log` is UTF-16LE; original exit file `D:/tmp/t8-final-1052d5b9.exit`. The chained client scripts did not run because the first command failed. Do not restart this completed run.

Full extraction: `D:/tmp/t8-failures.json` retains each of 148 test names, source locations, errors, stacks and raw failure blocks; `D:/tmp/t8-failures-summary.txt` and `D:/tmp/t8-failure-groups.json` are readable/numbered indexes. Parser: `D:/tmp/t8-parse-failures.cjs`.

Repository [original148-test inventory](t8-failure-inventory.md) maps every name and source to its group and focused verification state.

## Initial diagnostic clusters

These are investigation assignments, not final causal claims. Every original failure is assigned once; downstream errors may split into more than one cause after reproduction.

| Cluster | Failures | Current evidence |
|---|---:|---|
| Scripted model / tool protocol | 62 | W1 and IV-2 scripts match pretty JSON; T10 intentionally compacts JSON. Product worker pauses include undefined `.id`; inspect original tool errors before attributing to providers. |
| Planning checkpoint / readiness / explicit owner start | 45 | Removed checkpoint tool, timestamp mismatch, missing explicit start, old checkpoint coverage assumptions; review tests against T2/T3/T6 current contracts before any source change. |
| Factory provisioning / recovery | 17 | Empty scheduler reconstruction, pending guidance/question during evidence-policy activation, planning-policy downgrade in pre-seeded fixtures. Distinguish production recovery defects from invalid fixture prefixes. |
| Handoff spec-copy / case-collision | 11 | Most actual file lists add the permitted approved-source spec copy; one colliding docs/Docs layout fails to hand off and needs behavioral diagnosis. |
| Stop snapshot fixture | 4 | Provisioning key/version assumptions and build-step/start flow differ from current accepted contracts. |
| Runtime selection offer identity | 6 | Tests omit new requiredSequence or compare offers without it; preserve stale-offer fencing. |
| Filesystem inventory / Windows cleanup / PATH | 3 | New filesystem owner absent from audit; one EPERM cleanup; child resolves runner-only tsx unexpectedly. Investigate individually. |

No broad timeout/concurrency symptom dominates the log. W1 exact-repeat reproduces alone, proving this cluster is not full-suite resource contention. The scheduler EPERM remains environment-sensitive until reproduced. Native supervisor survivors remain an unresolved lifecycle observation; do not silently kill them.

### Controller diagnostic follow-up

- Fresh legacy factory MCP composition reproduces alone: empty-log projection read in `native-build-factory.ts` occurs before legacy BuildRuntime initialization. This is a production initialization-order regression, not a provider issue. Unconditional recovered evidence-policy activation also conflicts with correct pending-guidance/question gates.
- Planning initial three selected failures reproduce in isolation (3 tests / 3 failures). Current code removes model checkpoint tool authority, binds full reads to the exact current manifest, stamps kernel-owned submission timestamps, and requires explicit current owner start. Fixtures must preserve these rules.
- Scheduler EPERM is **reproducible**, not random host contention: the test selects an Architect handoff without its required offer sequence, throws before closing the reopened SQLite store, and its finally-delete masks the selection failure. Repair offer identity and unconditional store release; do not add retries/timeouts to hide it. Reassign original failure 93 from the miscellaneous cluster to selection identity (selection 7, miscellaneous 2).
- V1 PATH test is environment-dependent: direct `node --import tsx` passes (1/1, exit 0), while `npx tsx` reproduces original failure (1/1, exit 1). npm adds ancestor package tooling paths in addition to the runner installation path; inspect whether this is fixture assumption or production environment ownership before repair.
- Handoff parity fixture controller source trace: manager arm constructs BuildRuntime without `artifacts`, while direct arm supplies the approved source ArtifactStore. They do not have equivalent inputs; the latter can copy the approved source and the former reports missing bytes. Correct parity setup must supply the same artifact/evidence inputs, not remove the parity assertion or suppress default spec copying.

Controller diagnostic logs: `D:/tmp/t8-red-planning.log` (exit1,3/3 fail); `D:/tmp/t8-red-factory-mcp.log` (exit1,1/1 fail); `D:/tmp/t8-red-selection-cleanup.log` (exit1,1/1 fail); `D:/tmp/t8-red-v1-direct.log` (exit0,1/1 pass); `D:/tmp/t8-red-v1-npx.log` (exit1,1/1 fail). Each has an `.exit` companion. `t8-red-factory.log` was a mistaken name-pattern with zero matching subtests and is **not** qualifying evidence.

Tracked implementer sessions, each with exclusive file ownership: protocol `D:/tmp/t8-muse-group1.jsonl`; factory initializer/new dedicated regression `D:/tmp/t8-muse-group2.jsonl`; planning fixtures `D:/tmp/t8-muse-group3.jsonl`. No duplicate repair for the same file/cause; controller owns this report/status and performs independent reviews before commits.

### Protocol repair checkpoint (uncommitted, source unchanged)

Muse repaired whitespace-sensitive scripted JSON parsing. Controller independently inspected W1 and IV-2 kernel diffs: only whitespace-tolerant exact `id`/`severity` parsing changes, retaining non-claim exclusion, blocking classification, prior-finding checks and kernel validation. No review-policy source, assertion, skip or timeout changes. Bounded review: no findings on these two files.

- `node --import tsx --test --test-reporter=tap runner-v2/test/w1-review-economics.test.ts`: **31/31 pass**, exit0, no skip/cancel, 36216.8742ms. `D:/tmp/t8-g1-w1-file.log` / `.exit`. Covers original failures 131–146 (16).
- `node --import tsx --test --test-reporter=tap runner-v2/test/iv2-selected-kernel.test.ts`: **20/20 pass**, exit0, no skip/cancel, 51184.2115ms. `D:/tmp/t8-g1-iv2kernel-file.log` / `.exit`. Covers original failures 45–62 (18), including the intended negative recomputation/selection checks previously masked by review suspension.
- **34/148 original failures currently have affected-file GREEN evidence**. This is focused evidence only, not full-suite qualification or complete-changeset review. Remaining 114 original failures still require verification; product/factory/planning work remains active.

### Controller-reviewed C4 repair commit

`17aabf4a` — `test(runner-v2): bind planning resume fixtures to durable reads` (two test files only). Muse group3 ended with diagnosis but no edits after its step cap and CRLF matching failure; it is complete, not a live duplicate. Sequential focused group3a implemented the two C4 fixtures and ended exit0. Controller review **ACCEPT**, no findings: all prior source reads/checkpoints remain present as negative authority controls, amended-manifest reads must be real and exact, and a fabricated checkpoint advertising unread s2 is rejected without changing resumed coverage. Production source unchanged.

`npx tsx --test --test-concurrency=1 runner-v2/test/planning-projection.test.ts runner-v2/test/planning-state.test.ts`: **41/41 pass**, exit0, no skip/cancel, 3008.0485ms. `D:/tmp/t8-g3a-both-files.log` / `.exit`; individual selected projection/state logs and exits also pass. Changed-file ESLint and staged diffcheck exit0. Closes originals 75 and 76.

Additional protocol GREENs: IV-2 actual product journey **1/1 pass**, exit0, 306016.8908ms (`D:/tmp/t8-g1-iv2product-file.log` / `.exit`, original44); T7a actual unseeded opt-in product **1/1 pass**, exit0, 211363.9852ms (`D:/tmp/t8-g1-t7a-product.log` / `.exit`, original119). Whole T7a related-file coverage completed: **23/23 pass**, exit0, no skip/cancel, 216218.3399ms (`D:/tmp/t8-g1-t7a-file.log` / `.exit`).

Factory implementation remains uncommitted/pending final controller review. New actual-factory policy regressions **5/5 pass**, exit0, no skip/cancel, 113664.416ms (`D:/tmp/t8-g2-new.log` / `.exit`). Runner typecheck exit0. Correctly matched original MCP composition passes **1/1**, exit0, 81566.866ms (`D:/tmp/t8-g2-mcp.log` / `.exit`, original63); original pending-guidance stop-note journey **1/1**, exit0, 136291.2677ms (`D:/tmp/t8-g2-stopnotes-guidance.log` / `.exit`, original12). An earlier quoted `cmd /c` pattern accidentally matched zero tests; Muse recognized the `1..0` header and reran with correct quoting. Only the corrected subtest-bearing log qualifies.

Original blocking-question stop-note journey also passes **1/1**, exit0, 133371.5475ms (`D:/tmp/t8-g2-stopnotes-question.log` / `.exit`, original13). Factory source/new test ESLint exit0. Group2 ended exit0; sequential group2b owns only the new factory regression file to cover the crash between evidence activation and integrity initialization and run the related capabilities file.

Current verified original failures: **41/148**, remaining **107** still require repair/verification. No full-suite eligibility or T8 acceptance yet. New focused planning-tools session `D:/tmp/t8-muse-group3b.jsonl` exclusively owns that fixture file.

## Evidence and review

- RED: `node --import tsx --test --test-reporter=tap --test-name-pattern='W1 exact repeat' runner-v2/test/w1-review-economics.test.ts`: exit 1, 1 test / 0 pass / 1 fail / 0 skip / 0 cancel. `D:/tmp/t8-red-w1.log`, `.exit`. Reproduces `delivery_review_suspended:turn_limit`.
- Implementation is assigned to Muse Spark 1.3 Contributor, max; controller independently reviews each focused changeset and verifies affected coverage. No production/test repairs made at initial diagnosis.
- Full-suite eligibility: **NO**. Focused failures and independent complete-changeset review remain outstanding. New full qualification may run only after those prerequisites; never overlap full runs and never start REL-1.

### Controller-reviewed protocol repair commit

`7de0d741` — `test(runner-v2): align scripted delivery fixtures with current contracts` (five fixture files, +14/−8). Controller **ACCEPT**: exact whitespace-tolerant IDs preserve non-claim exclusion, prior finding checks, blocking severity and mutation-survivor assertions. W3 adds a truthful submission scope: actual two changed modules, actual two selected/passing tests, bounded not-run explanation; original unverified-claim and read-authorized override guards remain. W3 RED identifies the first `submit_task` rejection (missing validationScope), proving the downstream `.id` error is a script failure, not provider availability. W3 whole-file **1/1 pass**, exit0, 212046.4006ms (`D:/tmp/t8-g1-w3-green.log` / `.exit`), original148.

Controller cleared Muse's concurrent-factory concern: fresh explicit-policy construction at the three-event prefix executes the same evidence/integrity stamping logic before and after the factory repair; T7a/W3 opt-in product semantics are unchanged. Their logs include the provisional source fix and qualify jointly with it after final review/commit. Controller changed-file ESLint exit0 (seven existing unused-argument warnings in W1, no errors); diffcheck clean. No assertions weakened. Group1 ended exit0; bounded group1b now owns only the remaining25 protocol product failures.

Current verified original failures **42/148**, remaining **106**. Source edits outside factory remain prohibited except a newly confirmed handoff collision regression assigned exclusively to group5. Collision RED: direct one matched test fails, exit1, 79715.2054ms (`D:/tmp/t8-red-docs-collision.log` / `.exit`). Group4 owns selection fixtures; group3b planning-tools; group2b new factory crash test.

### Controller-reviewed factory initializer commit

`ac611b89` — `fix(runner-v2): initialize factory policies without restamping recovery`. Controller **ACCEPT**: fresh legacy prefix preserves the existing docs1 → initialized order/objective; new opt-in construction still activates all six guards and evidence/integrity stamps before source consumers; only an exact construction prefix or evidence-only crash prefix may receive missing stamps. Real recovered guidance/question histories are preserved, not restamped. Existing reducer advancement/ownership/downgrade gates remain intact. Added real-factory regression covers seq4→5 recovery and exact idempotent recreation.

- Isolated crash: `node --import tsx --test --test-reporter=tap --test-name-pattern='crash between evidence activation' runner-v2/test/native-build-policy-recovery.test.ts`, **1/1**, exit0, 36478.9302ms (`D:/tmp/t8-g2b-crash.log` / `.exit`).
- Whole new recovery file: `node --import tsx --test --test-reporter=tap runner-v2/test/native-build-policy-recovery.test.ts`, **6/6**, exit0, 139384.3527ms (`D:/tmp/t8-g2b-recovery-file.log` / `.exit`).
- Whole related capabilities file: `node --import tsx --test --test-reporter=tap runner-v2/test/native-build-capabilities.test.ts`, **39/39**, exit0, 200901.1581ms (`D:/tmp/t8-g2b-capabilities-file.log` / `.exit`). Covers originals63–69; original63 was already counted. Group2b ended exit0; owned-file ESLint/diffcheck exit0.

Selection fixture originals40,41,74,93,127–129 each pass in isolation (seven1/1 logs `D:/tmp/t8-g4-*<id>.log`, exit companions record exact commands). Original39 docs-v2 re-request also passes1/1, exit0, 173138.3725ms (`t8-g4-handoff-39.log` / `.exit`), jointly exercising the factory fix. Selection changes remain uncommitted pending whole-file evidence/final review; current exact-offer assertions and unconditional reopened-store release independently inspected without findings.

Current focused GREEN originals **56/148**, remaining **92**. Planning-tools repair is not accepted yet: whole-file evidence still has a related plan_only failure, and controller found its new artifact-authority helper silently accepts missing/unknown manifests. Require a fail-closed correction and retain both direct plan_only refusal and zero-dispatch/restart controls. Admission-order source repair in group7 is separately active; final review must check it jointly.

All remaining originals have bounded owners: group1b protocol25; group3b planning-tools13; group5 handoff11; group6 T6 repair23; group7 request-triage3; group8 opt-in/stop/T7/handoff fixtures13; group9 audit/PATH2. Controller is running original native final-verification/verifier factory cases70/71. These are assignments, not completion claims. Temporary diagnostic scripts must be removed before final commit.

### Reviewed fixture checkpoints and reopened filesystem defect

Current focused GREEN originals: **76/148**, remaining **72** require completed focused verification. GREEN reports test evidence; collision source review and triage factory proof remain pending. No fresh full suite has started. T8 NOT ACCEPTED; REL-1 NOT STARTED.

- `350b9051` selection identity fixtures: controller ACCEPT. Exact displayed durable offer sequences are asserted and supplied; same product key is scoped to both offers, replay deduplication and forbidden generic resume remain. SQLite closes unconditionally. Whole files: verifier-contracts 41/41, plan-critique-runtime 12/12, scheduler-store 31/31, handoff-rerequest 7/7; all exit0, no skips/cancels. Exact commands and counts in `D:/tmp/t8-g4-*-file.exit` and corresponding TAP logs. Final confirmation logs also pass. Covers seven originals already counted.
- `689ca63e` planning tools fixtures: controller ACCEPT after rejecting permissive unknown-manifest artifact authority and broadened plan_only refusal. Corrected helper checks known actual fixture bytes against digest and byte length and throws on absent/unknown sources. Direct plan_only refusal remains exact; zero allocation/dispatch and restart negatives remain. Omitted model-owned timestamps are stamped by the kernel, stored revision digests drive coverage, owner start is current and invalidated after amendment. Whole file 36/36, exit0, no skips/cancels, 8538.5431ms (`D:/tmp/t8-g3c-full.log` / `.exit`); focused corrections `t8-g3c-selected.log` / `.exit`. Closes originals77–89.
- Controller factory verification: `node --import tsx --test --test-reporter=tap --test-concurrency=1 runner-v2/test/native-final-verification-factory.test.ts runner-v2/test/native-verifier-factory.test.ts`, 6/6, exit0, no skips/cancels, 210936.4621ms (`D:/tmp/t8-controller-factory-final-verifier-files.log` / `.exit`). Selected originals70/71 also 2/2, exit0, 196128.5243ms (`t8-controller-factory-final-verifier-selected`).
- `06e8309f` hermetic PATH fixture: controller ACCEPT. Unique binary under the attested default runner bin resolves before scrub, is absent from project and retained PATH, then actual native child fails17 after scrub. System Node/Git controls, credential redaction, exact environment identity and reopened durable records remain. No policy or PATH ownership changes. Original123 selected direct1/1 and npx1/1, exit0; full V1 command-identity file8/8, exit0, no skips/cancels, 24021.4664ms. `D:/tmp/t8-g9-123-{direct,npx}.log` and `t8-g9-v1identity-file.log` with exit companions.
- Controller lint over selection/planning-tools/triage/source seven files exit0; diffcheck clean (`D:/tmp/t8-controller-reviewed-batches-lint.log` / `.exit`). V1/audit changed-file ESLint exit0 (`t8-g9-lint`).

Triage source fix remains uncommitted: direct admission now checks task existence and semantic admission before explicit-start/source verification, so absent planning cannot mask the correct refusal with TypeError. Actual admissible tasks still require exact owner authorization and real artifact verification. Whole request-triage file36/36, exit0, 10020.389ms (`D:/tmp/t8-g7-triage-file-final.log` / `.exit`), originals90–92; selected T7b owner/source negative controls also pass. Current independent source/test review finds no weakened gates, but a real NativeBuildFactory/step proof is still required before source acceptance. Group7 temporarily stashed only its own source to prove RED while other sessions could read it; it restored the source. That isolation method is disallowed going forward; final source-dependent joint verification must occur after writers freeze.

Filesystem audit original38 remains RED. Reviewed private `command-evidence-identity.ts` owns separate temporary Git indices outside project and never owner staging; precise owner addition is justified. `test-report-readers.ts` uses only `openSync(path, "r")` for confined report reads and needs a read-handle-only classification, never mutation-owner admission. The audit exposed a genuine live OpenRouter workspace-tool mutation bypass: its raw mkdir/write/rename/rm calls do not use the trusted mutation fence. Model-invisible metadata does not make it private. Bounded native-filesystem invariant is reopened; Muse group10 exclusively owns openrouter-apply-patch-tool.ts, tool-broker.ts, filesystem-mutation-fence.ts and dedicated patch regressions. Exact original grant identity, pre-approval target capture, stale/cancel/alias/hardlink refusal, no authority adoption and portable normal operations must be proved before accepting this source repair or audit.

Other active tracked sessions: group1b protocol25; group5 handoff11 (collision selectedGREEN, first parity subtest only so far is not a completed suite); group6 T6 repair23 (related files currently failing; synthetic artifact records are a review blocker); group8 remaining native/stop/T7 fixtures13. Group3c/4/7/9 implementer sessions ended exit0; no duplicate file owner. Existing sessions exceeded the execution document's two-writer limit; no further writer starts until at most one remains, then maintain at most two. File ownership stayed exclusive; this does not substitute for a frozen-source joint verification.