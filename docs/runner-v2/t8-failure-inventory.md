# T8 original failure inventory

Original completed qualification: `1052d5b9`, exit1; 148 failures. Exact error/stack/raw records: `D:/tmp/t8-failures.json`, extracted from original UTF-16LE `D:/tmp/t8-final-1052d5b9.log`. Grouping below is provisional causal assignment; targeted diagnoses refine it in [remediation report](t8-failure-remediation.md). Focused GREEN is not T8 acceptance.

| ID | Source | Test | Investigation group | Focused verification |
|---:|---|---|---|---|
| 1 | `runner-v2/test/docs-policy-v2-handoff-parity.test.ts:91:1` | parity: a normal handoff agrees between the full manager and the harness | handoff spec-copy/case-collision | Pending |
| 2 | `runner-v2/test/docs-policy-v2-handoff-parity.test.ts:136:1` | parity: a reuse after a failed read agrees between the full manager and the harness | handoff spec-copy/case-collision | Pending |
| 3 | `runner-v2/test/docs-policy-v2-handoff-project-links.test.ts:440:1` | C2c repair M-1/probe D1: a junction above a redirect target refuses the redirect and writes nothing outside | handoff spec-copy/case-collision | Pending |
| 4 | `runner-v2/test/docs-policy-v2-handoff-project-links.test.ts:874:1` | C2d/probe DOCS-dir: a regular capital Docs directory hands off through the index spelling | handoff spec-copy/case-collision | Pending |
| 5 | `runner-v2/test/docs-policy-v2-handoff-project-links.test.ts:927:1` | C2d/probe D-walk-projdir: a regular docs/Project directory hands off through the index spelling | handoff spec-copy/case-collision | Pending |
| 6 | `runner-v2/test/docs-policy-v2-handoff-project-links.test.ts:1119:1` | C2e/probe F-state-dir: a tracked directory at docs/project/STATE.md skips STATE.md and still hands off | handoff spec-copy/case-collision | Pending |
| 7 | `runner-v2/test/docs-policy-v2-handoff-project-links.test.ts:1217:1` | C2e repair cycle 1/probe F7: a submodule entry at docs/project/STATE.md skips STATE.md and still hands off | handoff spec-copy/case-collision | Pending |
| 8 | `runner-v2/test/docs-policy-v2-handoff-project-links.test.ts:1405:1` | C2d repair cycle 1/escalation C-1: colliding docs/ and Docs/ directories skip STATE.md and still hand off | handoff spec-copy/case-collision | GREEN: collision selected; source review pending |
| 9 | `runner-v2/test/docs-policy-v2-handoff-retry.test.ts:141:1` | C2a B4: commit lands, the read fails, retry reuses the commit and records its tree | handoff spec-copy/case-collision | Pending |
| 10 | `runner-v2/test/docs-policy-v2-handoff-retry.test.ts:856:1` | C2c repair cycle 2/probe B2: a reused AGENTS.md-into-CLAUDE.md commit completes after resume | handoff spec-copy/case-collision | Pending |
| 11 | `runner-v2/test/docs-policy-v2-handoff-retry.test.ts:936:1` | C2c repair cycle 2/probe S1-reuse: a reused STATE.md-link commit completes after resume | handoff spec-copy/case-collision | Pending |
| 12 | `runner-v2/test/docs-policy-v2-stop-notes.test.ts:1080:1` | C3b: pending user guidance still records eligible user-pause stop notes with one call | factory provisioning/recovery | GREEN: Factory guidance |
| 13 | `runner-v2/test/docs-policy-v2-stop-notes.test.ts:1148:1` | C3b: an open blocking Architect question still records eligible user-pause stop notes with one call | factory provisioning/recovery | GREEN: Factory question |
| 14 | `runner-v2/test/docs-policy-v2-stop-snapshot.test.ts:233:1` | C3a/CD-9: pause during triage, then answer, leaves the project tree hash unchanged | stop snapshot fixture | Pending |
| 15 | `runner-v2/test/docs-policy-v2-stop-snapshot.test.ts:467:1` | C3a/CD-7/B-1/M-5c: factory runtime plus manager snapshots an owner pause with no step, then handoff completes | factory provisioning/recovery | Pending |
| 16 | `runner-v2/test/docs-policy-v2-stop-snapshot.test.ts:621:1` | C3a/B-1/M-2: an in-step verifier pause snapshots the new stop with no extra step | stop snapshot fixture | Pending |
| 17 | `runner-v2/test/docs-policy-v2-stop-snapshot.test.ts:998:1` | C3a/R2-1: an owner pause during a blocked step on a docs-v1 run returns promptly and writes nothing | stop snapshot fixture | Pending |
| 18 | `runner-v2/test/docs-policy-v2-stop-snapshot.test.ts:1086:1` | C3a/R2-1c: a step that ends progressed after a mid-step owner pause still snapshots at that step's end | stop snapshot fixture | Pending |
| 19 | `runner-v2/test/e1-product-test-integrity.test.ts:318:3` | E1 product: real factory test integrity unchanged | scripted model/tool protocol | Pending |
| 20 | `runner-v2/test/e1-product-test-integrity.test.ts:318:3` | E1 product: real factory test integrity narrowed_script | scripted model/tool protocol | Pending |
| 21 | `runner-v2/test/e1-product-test-integrity.test.ts:318:3` | E1 product: real factory test integrity deleted_test | scripted model/tool protocol | Pending |
| 22 | `runner-v2/test/e1-product-test-integrity.test.ts:318:3` | E1 product: real factory test integrity reviewed_consolidation | scripted model/tool protocol | Pending |
| 23 | `runner-v2/test/e1-product-test-integrity.test.ts:318:3` | E1 product: real factory test integrity bootstrap | scripted model/tool protocol | Pending |
| 24 | `runner-v2/test/e1-product-test-integrity.test.ts:318:3` | E1 product: real factory test integrity architect_reason | scripted model/tool protocol | Pending |
| 25 | `runner-v2/test/e2-product-submission-guard.test.ts:294:5` | E2 product: real factory submission guard clean | scripted model/tool protocol | Pending |
| 26 | `runner-v2/test/e2-product-submission-guard.test.ts:294:5` | E2 product: real factory submission guard scope_blocked | scripted model/tool protocol | Pending |
| 27 | `runner-v2/test/e2-product-submission-guard.test.ts:294:5` | E2 product: real factory submission guard scope_reconciled | scripted model/tool protocol | Pending |
| 28 | `runner-v2/test/e2-product-submission-guard.test.ts:294:5` | E2 product: real factory submission guard secret | scripted model/tool protocol | Pending |
| 29 | `runner-v2/test/e3-product-review-integrity.test.ts:296:5` | E3 product: real factory review integrity clean | scripted model/tool protocol | Pending |
| 30 | `runner-v2/test/e3-product-review-integrity.test.ts:296:5` | E3 product: real factory review integrity unreferenced | scripted model/tool protocol | Pending |
| 31 | `runner-v2/test/e3-product-review-integrity.test.ts:296:5` | E3 product: real factory review integrity test_only | scripted model/tool protocol | Pending |
| 32 | `runner-v2/test/e3-product-review-integrity.test.ts:296:5` | E3 product: real factory review integrity failover | scripted model/tool protocol | Pending |
| 33 | `runner-v2/test/e4-product-encoding-safety.test.ts:295:5` | E4 product: real factory encoding safety clean | scripted model/tool protocol | Pending |
| 34 | `runner-v2/test/e4-product-encoding-safety.test.ts:295:5` | E4 product: real factory encoding safety mojibake | scripted model/tool protocol | Pending |
| 35 | `runner-v2/test/e4-product-encoding-safety.test.ts:295:5` | E4 product: real factory encoding safety lineflip | scripted model/tool protocol | Pending |
| 36 | `runner-v2/test/e4-product-encoding-safety.test.ts:295:5` | E4 product: real factory encoding safety invalid | scripted model/tool protocol | Pending |
| 37 | `runner-v2/test/e5-product-review-evidence.test.ts:300:5` | E5 product: real factory review evidence cited | scripted model/tool protocol | Pending |
| 38 | `runner-v2/test/filesystem-mutation-routing.test.ts:27:1` | native filesystem mutation-capable imports have a closed reviewed ownership boundary | filesystem inventory/Windows cleanup/PATH | Pending |
| 39 | `runner-v2/test/handoff-rerequest.test.ts:970:1` | FX-2 CR-1 docs-v2 finish: the re-request carries a new snapshot for the new stop | factory provisioning/recovery | GREEN: Factory docs-v2 re-request selected |
| 40 | `runner-v2/test/handoff-rerequest.test.ts:1347:1` | FX-2 B1 (N1 probe F): the owner's re-answer with the same product key records a new selection and the run completes | runtime selection offer identity | GREEN: Selection selected; related files/review pending |
| 41 | `runner-v2/test/handoff-rerequest.test.ts:1476:1` | FX-2 M2: an Architect-handoff re-offer answered with the same product key records a new selection | runtime selection offer identity | GREEN: Selection selected; related files/review pending |
| 42 | `runner-v2/test/handoff-snapshot.test.ts:1450:1` | C1 adapter real store: blocking findings from delivery-seed name their task | planning checkpoint/readiness/start | Pending |
| 43 | `runner-v2/test/iv1-product-journey.test.ts:389:1` | IV-1 product: worker scope -> durable submission -> reviewer and Architect see it | scripted model/tool protocol | Pending |
| 44 | `runner-v2/test/iv2-product-journey.test.ts:269:1` | IV-2 product journey: a high-tier workspaces change runs selected at depth and boundary | scripted model/tool protocol | GREEN: IV-2 product file |
| 45 | `runner-v2/test/iv2-selected-kernel.test.ts:485:3` | IV-2 kernel rejects tampered selected boundary: full_suite rung with selected scope | scripted model/tool protocol | GREEN: IV-2 kernel file |
| 46 | `runner-v2/test/iv2-selected-kernel.test.ts:485:3` | IV-2 kernel rejects tampered selected boundary: empty selectedTests with selected scope | scripted model/tool protocol | GREEN: IV-2 kernel file |
| 47 | `runner-v2/test/iv2-selected-kernel.test.ts:485:3` | IV-2 kernel rejects tampered selected boundary: executed argv not naming the selected tests | scripted model/tool protocol | GREEN: IV-2 kernel file |
| 48 | `runner-v2/test/iv2-selected-kernel.test.ts:485:3` | IV-2 kernel rejects tampered selected boundary: widened selection with selected scope | scripted model/tool protocol | GREEN: IV-2 kernel file |
| 49 | `runner-v2/test/iv2-selected-kernel.test.ts:485:3` | IV-2 kernel rejects tampered selected boundary: unknown scope value | scripted model/tool protocol | GREEN: IV-2 kernel file |
| 50 | `runner-v2/test/iv2-selected-kernel.test.ts:496:1` | IV-2 kernel accepts a coherent selected boundary through the pump | scripted model/tool protocol | GREEN: IV-2 kernel file |
| 51 | `runner-v2/test/iv2-selected-kernel.test.ts:518:1` | IV-2 legacy full_test_script records without widening fields replay unchanged | scripted model/tool protocol | GREEN: IV-2 kernel file |
| 52 | `runner-v2/test/iv2-selected-kernel.test.ts:579:1` | IV-2 kernel accepts coherent selected depth evidence (high tier) | scripted model/tool protocol | GREEN: IV-2 kernel file |
| 53 | `runner-v2/test/iv2-selected-kernel.test.ts:598:1` | IV-2 kernel refuses selected boundary argv that the cited command evidence did not run (F2) | scripted model/tool protocol | GREEN: IV-2 kernel file |
| 54 | `runner-v2/test/iv2-selected-kernel.test.ts:659:1` | IV-2 default packet acceptance never forces the full suite while final stays pending | scripted model/tool protocol | GREEN: IV-2 kernel file |
| 55 | `runner-v2/test/iv2-selected-kernel.test.ts:671:1` | IV-2 explicit full-suite-now mandate forces full execution | scripted model/tool protocol | GREEN: IV-2 kernel file |
| 56 | `runner-v2/test/iv2-selected-kernel.test.ts:688:1` | IV-2 final-scoped full-suite mandate stays deferred for packets | scripted model/tool protocol | GREEN: IV-2 kernel file |
| 57 | `runner-v2/test/iv2-selected-kernel.test.ts:705:1` | IV-2 conflicting mandates fail closed instead of picking a scope | scripted model/tool protocol | GREEN: IV-2 kernel file |
| 58 | `runner-v2/test/iv2-selected-kernel.test.ts:795:1` | IV-2 kernel: intentional selected execution is not flagged as suite_shrank | scripted model/tool protocol | GREEN: IV-2 kernel file |
| 59 | `runner-v2/test/iv2-selected-kernel.test.ts:811:1` | IV-2 kernel: a genuine full-script shrink with a passing guard is refused | scripted model/tool protocol | GREEN: IV-2 kernel file |
| 60 | `runner-v2/test/iv2-selected-kernel.test.ts:822:1` | IV-2 kernel: a genuine full-script shrink with a failing guard blocks acceptance | scripted model/tool protocol | GREEN: IV-2 kernel file |
| 61 | `runner-v2/test/iv2-selected-kernel.test.ts:843:1` | IV-2 kernel: an ordinary task stays selected but the task closing its phase runs full (F4) | scripted model/tool protocol | GREEN: IV-2 kernel file |
| 62 | `runner-v2/test/iv2-selected-kernel.test.ts:882:1` | IV-2 kernel: a selected acceptance preserves the trusted full-suite baseline (F3) | scripted model/tool protocol | GREEN: IV-2 kernel file |
| 63 | `runner-v2/test/native-build-capabilities.test.ts:63:1` | production composition settles its owned MCP and run binding while retaining history and isolating another run | factory provisioning/recovery | GREEN: Factory MCP |
| 64 | `runner-v2/test/native-build-capabilities.test.ts:258:1` | NativeBuildFactory loads configured capabilities and reports provider audit metadata | factory provisioning/recovery | GREEN: Factory capabilities file |
| 65 | `runner-v2/test/native-build-capabilities.test.ts:785:1` | NativeBuildFactory loads an extension snapshot after source replacement following validation | factory provisioning/recovery | GREEN: Factory capabilities file |
| 66 | `runner-v2/test/native-build-capabilities.test.ts:824:1` | NativeBuildFactory snapshot preserves attribution for a live extension tool call | factory provisioning/recovery | GREEN: Factory capabilities file |
| 67 | `runner-v2/test/native-build-capabilities.test.ts:882:1` | NativeBuildFactory closes extension language providers before their extension instance | factory provisioning/recovery | GREEN: Factory capabilities file |
| 68 | `runner-v2/test/native-build-capabilities.test.ts:994:1` | NativeBuildFactory reverses every acquired runtime resource after construction faults | factory provisioning/recovery | GREEN: Factory capabilities file |
| 69 | `runner-v2/test/native-build-capabilities.test.ts:1090:1` | NativeBuildFactory handle close releases owned stores while retaining recovery worktrees | factory provisioning/recovery | GREEN: Factory capabilities file |
| 70 | `runner-v2/test/native-final-verification-factory.test.ts:22:1` | NativeBuildFactory executes all four bound categories from clean integration state while user checkout is dirty | factory provisioning/recovery | GREEN: Factory related 6/6 |
| 71 | `runner-v2/test/native-verifier-factory.test.ts:197:1` | a submitted critique leaves no verifier-workspaces/<run> directory | factory provisioning/recovery | GREEN: Factory related 6/6 |
| 72 | `runner-v2/test/phase-c-acceptance.test.ts:443:1` | PHASE-C-EXIT: seeded new-policy factory run pauses/resumes to explicit owner handoff with only intended files | factory provisioning/recovery | Pending |
| 73 | `runner-v2/test/phase-c-acceptance.test.ts:839:1` | PHASE-C-EXIT: answered run through real triage/answer tools writes nothing | factory provisioning/recovery | Pending |
| 74 | `runner-v2/test/plan-critique-runtime.test.ts:165:1` | an unavailable critic pauses for verifier selection | runtime selection offer identity | GREEN: Selection selected; related files/review pending |
| 75 | `runner-v2/test/planning-projection.test.ts:170:1` | planning checkpoint coverage is invalidated when an amendment changes a section digest | planning checkpoint/readiness/start | GREEN: C4 projection file |
| 76 | `runner-v2/test/planning-state.test.ts:1403:1` | T2 interrupt after one covered section resumes the exact next section without repeating accepted work | planning checkpoint/readiness/start | GREEN: C4 state file |
| 77 | `runner-v2/test/planning-tools.test.ts:457:1` | T3a unread section is never counted as covered | planning checkpoint/readiness/start | GREEN: planning-tools 36/36; reviewed 689ca63e |
| 78 | `runner-v2/test/planning-tools.test.ts:494:1` | T3a oversized section is refused, never truncated, and never counted | planning checkpoint/readiness/start | GREEN: planning-tools 36/36; reviewed 689ca63e |
| 79 | `runner-v2/test/planning-tools.test.ts:591:1` | T3a draft before the ledger is refused; ledger then draft then revise succeed | planning checkpoint/readiness/start | GREEN: planning-tools 36/36; reviewed 689ca63e |
| 80 | `runner-v2/test/planning-tools.test.ts:643:1` | T3a invalid ledger and stale revise base are refused | planning checkpoint/readiness/start | GREEN: planning-tools 36/36; reviewed 689ca63e |
| 81 | `runner-v2/test/planning-tools.test.ts:686:1` | T3a checkpoint and resume through the tools, including after restart | planning checkpoint/readiness/start | GREEN: planning-tools 36/36; reviewed 689ca63e |
| 82 | `runner-v2/test/planning-tools.test.ts:1363:1` | T3a plan_only new-policy run dispatches zero workers, including after restart | planning checkpoint/readiness/start | GREEN: planning-tools 36/36; reviewed 689ca63e |
| 83 | `runner-v2/test/planning-tools.test.ts:1515:1` | T3a worker admission refused until ready, blocked again after a source change | planning checkpoint/readiness/start | GREEN: planning-tools 36/36; reviewed 689ca63e |
| 84 | `runner-v2/test/planning-tools.test.ts:1612:1` | T3a worker admission blocked again after a plan change, with a ready control | planning checkpoint/readiness/start | GREEN: planning-tools 36/36; reviewed 689ca63e |
| 85 | `runner-v2/test/planning-tools.test.ts:2039:1` | T3a repair B1: no task outside the ready plan is ever dispatched | planning checkpoint/readiness/start | GREEN: planning-tools 36/36; reviewed 689ca63e |
| 86 | `runner-v2/test/planning-tools.test.ts:2155:1` | T3a repair N3: a source change during workspace allocation cannot dispatch | planning checkpoint/readiness/start | GREEN: planning-tools 36/36; reviewed 689ca63e |
| 87 | `runner-v2/test/planning-tools.test.ts:2309:1` | T3a repair B2: re-readiness rebinds tasks so they dispatch again (probe B) | planning checkpoint/readiness/start | GREEN: planning-tools 36/36; reviewed 689ca63e |
| 88 | `runner-v2/test/planning-tools.test.ts:2791:1` | T3a repair B3: verifier repair tasks are bound to the ready plan and dispatched by tick | planning checkpoint/readiness/start | GREEN: planning-tools 36/36; reviewed 689ca63e |
| 89 | `runner-v2/test/planning-tools.test.ts:2934:1` | T3a repair B3: final-verification repair tasks are bound to the ready plan and dispatched by tick | planning checkpoint/readiness/start | GREEN: planning-tools 36/36; reviewed 689ca63e |
| 90 | `runner-v2/test/request-triage.test.ts:597:1` | T9 answer-path mutation attempts are refused at every layer, never applied silently | planning checkpoint/readiness/start | GREEN: triage 36/36; factory proof pending |
| 91 | `runner-v2/test/request-triage.test.ts:2737:1` | T9 repair B3: user guidance on a planning-state run routes without planRevision | planning checkpoint/readiness/start | GREEN: triage 36/36; factory proof pending |
| 92 | `runner-v2/test/request-triage.test.ts:4156:1` | T9 repair B4-r3: the folded rule covers the re-planning window after a ready plan drops to not-ready | planning checkpoint/readiness/start | GREEN: triage 36/36; factory proof pending |
| 93 | `runner-v2/test/scheduler-store.test.ts:1326:1` | runtime assignments, provider cooldown, and Architect handoff recover durably | runtime selection offer identity / store release | GREEN: Selection selected; related files/review pending |
| 94 | `runner-v2/test/t6b-repair-boundary.test.ts:412:1` | R3-B1: unrelated tasks' boundary failures charge per-task issues; no false exhaustion pause | planning checkpoint/readiness/start | Pending |
| 95 | `runner-v2/test/t6b-repair-boundary.test.ts:463:1` | R3-B1: one task's repeated boundary failures charge its own issue; the fourth pauses | planning checkpoint/readiness/start | Pending |
| 96 | `runner-v2/test/t6b-repair-boundary.test.ts:534:1` | R4-B1: partial member decisions refuse without charging; full decisions dispatch once; retry has no idempotency conflict | planning checkpoint/readiness/start | Pending |
| 97 | `runner-v2/test/t6b-repair-factory.test.ts:330:1` | T6b factory run: a consistently failing npm tests check reruns only its failing test and records a consistent failure | factory provisioning/recovery | Pending |
| 98 | `runner-v2/test/t6b-repair-factory.test.ts:334:1` | T6b factory run: a really flaky npm test passes its narrowed rerun, is recorded flaky with no charge, and still needs a clean run | factory provisioning/recovery | Pending |
| 99 | `runner-v2/test/t6b-repair-runtime.test.ts:300:1` | a failing check opens the issue without charging and searches cleanup | planning checkpoint/readiness/start | Pending |
| 100 | `runner-v2/test/t6b-repair-runtime.test.ts:336:1` | seeded cycles survive the check and the fourth correction pauses through the real pump | planning checkpoint/readiness/start | Pending |
| 101 | `runner-v2/test/t6b-repair-runtime.test.ts:371:1` | flaky pass-on-rerun charges nothing but still blocks acceptance | planning checkpoint/readiness/start | Pending |
| 102 | `runner-v2/test/t6b-repair-runtime.test.ts:403:1` | flaky fail-again records a consistent failure and charges nothing at the check | planning checkpoint/readiness/start | Pending |
| 103 | `runner-v2/test/t6b-repair-runtime.test.ts:427:1` | an unsupported rerun records not_performed with its reason and charges nothing at the check | planning checkpoint/readiness/start | Pending |
| 104 | `runner-v2/test/t6b-repair-runtime.test.ts:452:1` | a proven external blocker consumes no charge and still blocks | planning checkpoint/readiness/start | Pending |
| 105 | `runner-v2/test/t6b-repair-runtime.test.ts:519:1` | an exhausted issue pauses repair dispatch through the real pump | planning checkpoint/readiness/start | Pending |
| 106 | `runner-v2/test/t6b-repair-runtime.test.ts:561:1` | a failed approach gives the Architect a turn; a new approach dispatches and charges | planning checkpoint/readiness/start | Pending |
| 107 | `runner-v2/test/t6b-repair-runtime.test.ts:611:1` | a stricter run cap pauses dispatch although the issue has credits | planning checkpoint/readiness/start | Pending |
| 108 | `runner-v2/test/t6b-repair-runtime.test.ts:715:1` | an owner extension lets the next exhaustion pause again instead of throwing | planning checkpoint/readiness/start | Pending |
| 109 | `runner-v2/test/t6b-repair-runtime.test.ts:758:1` | a generic owner resume re-pauses durably instead of leaving a phantom running run | planning checkpoint/readiness/start | Pending |
| 110 | `runner-v2/test/t6b-repair-runtime.test.ts:789:1` | a failed approach relabelled with no evidence is refused and charges nothing | planning checkpoint/readiness/start | Pending |
| 111 | `runner-v2/test/t6b-repair-runtime.test.ts:856:1` | a repair approach citing unknown diagnostic evidence is refused and charges nothing | planning checkpoint/readiness/start | Pending |
| 112 | `runner-v2/test/t6b-repair-runtime.test.ts:943:1` | blocking review fix rounds charge the review issue budget and the fourth round pauses | planning checkpoint/readiness/start | Pending |
| 113 | `runner-v2/test/t6b-repair-runtime.test.ts:1033:1` | three real fixes on the same failing test charge once each, then the fourth round pauses | planning checkpoint/readiness/start | Pending |
| 114 | `runner-v2/test/t6b-repair-runtime.test.ts:1184:1` | a failed delivery boundary opens repair issues so the Architect resolves through the tools | planning checkpoint/readiness/start | Pending |
| 115 | `runner-v2/test/t6b-repair-runtime.test.ts:1349:1` | a decision recorded only in round 1 refuses the round-2 dispatch until a new decision is recorded | planning checkpoint/readiness/start | Pending |
| 116 | `runner-v2/test/t6b-repair-runtime.test.ts:1523:1` | the third correction dispatches and charges through the real pump | planning checkpoint/readiness/start | Pending |
| 117 | `runner-v2/test/t6b-repair-scaled-limit.test.ts:422:1` | the run-limit pause reason carries the effective limit and usage | planning checkpoint/readiness/start | Pending |
| 118 | `runner-v2/test/t6b-repair-scaled-limit.test.ts:442:1` | a scaled run dispatches its first repair through the real pump | planning checkpoint/readiness/start | Pending |
| 119 | `runner-v2/test/t7a-planning-provisioning.test.ts:1621:1` | T7a product: unseeded opt-in provisioning plans, covers, builds, and accepts through the real factory | scripted model/tool protocol | GREEN: T7a file |
| 120 | `runner-v2/test/t7b-planning-controls.test.ts:286:1` | T7b product: unseeded opt-in provisioning plans, covers, builds, and accepts through the real factory | planning checkpoint/readiness/start | Pending |
| 121 | `runner-v2/test/t7c-planning-ui.test.ts:290:1` | T7c product: unseeded opt-in provisioning plans, covers, builds, and accepts through the real factory | planning checkpoint/readiness/start | Pending |
| 122 | `runner-v2/test/t7d-planning-export.test.ts:292:1` | T7d product: real factory planning and delivery export canonical C1 state, references and copy-ready cards | planning checkpoint/readiness/start | Pending |
| 123 | `runner-v2/test/v1-command-identity.test.ts:131:1` | V1 actual native project child cannot resolve runner-only tsx while system Node/Git paths remain | filesystem inventory/Windows cleanup/PATH | GREEN: V1 direct+npx and file 8/8 |
| 124 | `runner-v2/test/v1-product-command-identity.test.ts:308:1` | V1 unseeded authenticated factory SQLite Git stale evidence journey | scripted model/tool protocol | Pending |
| 125 | `runner-v2/test/v2-product-evidence.test.ts:314:1` | V2 unseeded authenticated factory SQLite Git exact reuse and changed argv journey | scripted model/tool protocol | Pending |
| 126 | `runner-v2/test/v3-product-language.test.ts:347:1` | V3 product: real factory dotnet journey with TRX pass and fail counts | scripted model/tool protocol | Pending |
| 127 | `runner-v2/test/verifier-contracts.test.ts:746:1` | unavailable independent verification creates a typed user-selection pause | runtime selection offer identity | GREEN: Selection selected; related files/review pending |
| 128 | `runner-v2/test/verifier-contracts.test.ts:777:1` | verifier budget exhaustion creates a typed user-selection pause | runtime selection offer identity | GREEN: Selection selected; related files/review pending |
| 129 | `runner-v2/test/verifier-contracts.test.ts:913:1` | typed verifier selection resumes with the selected runtime | runtime selection offer identity | GREEN: Selection selected; related files/review pending |
| 130 | `runner-v2/test/w1-product-review.test.ts:541:1` | W1 product: interrupted review reopens at its missing stage, substantive repair accepts | scripted model/tool protocol | Pending |
| 131 | `runner-v2/test/w1-review-economics.test.ts:795:1` | W1 exact repeat: prior verdict returns with no model/depth/workspace work and no new review or cycle | scripted model/tool protocol | GREEN: W1 file |
| 132 | `runner-v2/test/w1-review-economics.test.ts:838:1` | W1 oscillation: identical repair with new evidence is a blocking finding | scripted model/tool protocol | GREEN: W1 file |
| 133 | `runner-v2/test/w1-review-economics.test.ts:871:1` | W1 oscillation: reversed repair is blocked, unrelated repair is clean | scripted model/tool protocol | GREEN: W1 file |
| 134 | `runner-v2/test/w1-review-economics.test.ts:925:1` | W1 missing evidence cannot reuse: tampered artifacts force a fresh review | scripted model/tool protocol | GREEN: W1 file |
| 135 | `runner-v2/test/w1-review-economics.test.ts:952:1` | W1 key drift: a changed worker summary opens a fresh review, never a reuse | scripted model/tool protocol | GREEN: W1 file |
| 136 | `runner-v2/test/w1-review-economics.test.ts:977:1` | W1 unknown tree: an unresolvable actual base tree is a conservative miss with lineage intact | scripted model/tool protocol | GREEN: W1 file |
| 137 | `runner-v2/test/w1-review-economics.test.ts:1004:1` | W1 resume: the same reviewer continues at the first missing durable stage | scripted model/tool protocol | GREEN: W1 file |
| 138 | `runner-v2/test/w1-review-economics.test.ts:1025:1` | W1 resume: SQLite close/reopen keeps the first missing stage for the same runtime | scripted model/tool protocol | GREEN: W1 file |
| 139 | `runner-v2/test/w1-review-economics.test.ts:1049:1` | W1 resume: a changed reviewer model restarts at the first pass | scripted model/tool protocol | GREEN: W1 file |
| 140 | `runner-v2/test/w1-review-economics.test.ts:1087:1` | W1 resume: a partial missing-stage session is retried fresh, never borrowed | scripted model/tool protocol | GREEN: W1 file |
| 141 | `runner-v2/test/w1-review-economics.test.ts:1201:1` | W1 replay: same-submission replay costs nothing, the original rejection still charges once | scripted model/tool protocol | GREEN: W1 file |
| 142 | `runner-v2/test/w1-review-economics.test.ts:1269:1` | W1 immutable diff: the product loader and review refuse a tampered diff artifact | scripted model/tool protocol | GREEN: W1 file |
| 143 | `runner-v2/test/w1-review-economics.test.ts:1325:1` | W1 resume: partial findings after real reads keep completed obligations and retry fresh | scripted model/tool protocol | GREEN: W1 file |
| 144 | `runner-v2/test/w1-review-economics.test.ts:1354:1` | W1 resume: an unknown prior key restarts at the first stage | scripted model/tool protocol | GREEN: W1 file |
| 145 | `runner-v2/test/w1-review-economics.test.ts:1381:1` | W1 resume: a changed reviewer runtime restarts at the first pass | scripted model/tool protocol | GREEN: W1 file |
| 146 | `runner-v2/test/w1-review-economics.test.ts:1418:1` | W1 resume: lifecycle-durable stages with open sessions reconcile without rerunning | scripted model/tool protocol | GREEN: W1 file |
| 147 | `runner-v2/test/w2-product-correction.test.ts:491:1` | W2 product: delta-first re-review with bounded late findings accepts | scripted model/tool protocol | Pending |
| 148 | `runner-v2/test/w3-product-disposition.test.ts:400:1` | W3 product: reviewer verdict -> Architect prefill -> confirm, with a read-authorized override | scripted model/tool protocol | GREEN: W3 product file |
