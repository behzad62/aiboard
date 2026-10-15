# T6b evidence — repair budgets, repair-approach decisions, flaky isolation, defect classes, leftover cleanup

Base: `7d21be0bc897b84b8b80aa44299080be2f86c9a3`.
Status: T6b implementation complete; independent review remains outstanding. All changes are uncommitted.

## Requirement coverage

- Repair budgets (durable per-issue counting, default limit 3, fourth cycle refused; run-level `repair.policy_configured` cap pauses dispatch with `repair_cycle_limit_reached`; stricter caps win over issue credits).
- RepairApproachDecision (architect records `repair.approach_decided` before dispatch; a failed approach cannot be relabelled/resubmitted without explicit repeat; repeats require evidence NEW to the diagnostic set; diagnostic sets are immutable until failure; replaying reused evidence is refused).
- Flaky isolation (failing tests with `failingTestIds` get one filtered rerun; pass-on-rerun charges nothing but still blocks acceptance; fail-again charges exactly one cycle; unsupported reruns charge the cycle with the recorded reason; diagnostics charge zero).
- Defect classes (findings carry a short defect class; per-(class, review, finding) sources with recomputed counts; top five injected into briefs within the recorded cap; per-model review outcomes recorded).
- Leftover cleanup OA-17 (owned temp creations recorded in a central registry; post-attempt search cleans proven-owned leftovers, retains foreign/uncertain ones; processes stopped only on proven ownership).
- Legacy runs are unchanged: T6b charging, dispatch gates and cleanup search apply only when `planningPolicyVersion === 1`.

## Implementation

- `runner-v2/src/repair-budget-contracts.ts` (new): issue identity (`repairIssueIdentity`), budget/dispatch gates, charge decision.
- `runner-v2/src/repair-approach-contracts.ts` (new): `RepairApproachDecision` validation.
- `runner-v2/src/flaky-rerun.ts` (new): `narrowNodeTestCommand` (only direct `node --test` filterable).
- `runner-v2/src/cleanup-ownership.ts` (new): temp-creation central registry, owned search/cleanup, owned-process search.
- `runner-v2/src/defect-history.ts` (new): defect-class normalization/identity, top-class selection.
- `runner-v2/src/scheduler-store.ts`: `repair.issue_recorded/cycle_recorded/approach_decided/external_blocker_recorded/flaky_isolated/cycle_limit_reached` reducers and projections.
- `runner-v2/src/build-runtime.ts`: failing-check charge gate, repair dispatch gate (`prepareRepairDispatch`), cleanup search hookup, per-model outcome recording; dispatch resolves the same `final-verification:<category>` issue identity the charge path records while keeping architect-facing `failedCategories` bare.
- `runner-v2/src/delivery-acceptance.ts`: `beforeRepairDecisionDispatch`, `failingCheckRepairChargeDecision`, optional-defect-class compat.
- `runner-v2/src/architect-tools.ts`, `runner-v2/src/role-capabilities.ts`: `record_repair_approach_decision` + `record_external_blocker` architect tools and allow-listing (lifecycle tools via the architect driver, not the inspection broker).
- `runner-v2/src/native-build-factory.ts`: production `flakyIsolation` (real filtered rerun), `cleanupAfterAttempt` (real owned search), `reviewOutcomeRecorder`, defect-class brief injection.
- `runner-v2/src/agent-prompts.ts`, `runner-v2/src/native-deliverable-review.ts`, `runner-v2/src/native-worker-driver.ts`, `runner-v2/src/native-architect-runtime.ts`: brief injection, finding class recording, defect recorder plumbing.
- `runner-v2/src/sqlite-project-memory.ts`: defect-class and per-model outcome tables.
- `runner-v2/src/execution-host.ts`, `runner-v2/src/runner-capability-contract.ts`, `runner-v2/src/windows-process-semantic-probes.ts`: temp-creation ownership records.
- `runner-v2/src/delivery-execution.ts`, `runner-v2/src/final-verification-runtime.ts`: `failingTestIds` plumbing.

## Design choices

- Issue identity is `hash(projectId + normalized rootCause)`; related symptoms and renamed tasks share the issue and cannot reset its count. Failing-check root causes are namespaced `final-verification:<category>` / `verifier:<task>:<criterion>`; dispatch maps bare FV categories to the same namespace internally.
- Defect storage lives in `SqliteProjectMemoryStore` (new tables, source-deduped counts); temp-creation central registry defaults outside the recorded path.
- Cleanup ownership proof: only proven-owned processes are stopped and only own-run/project temp records are cleaned; everything else is retained and reported.

## Validation

- `t6b-repair-budget.test.ts`: 8 tests, 8 passed, 0 failed.
- `t6b-defect-cleanup.test.ts`: 7 tests, 7 passed, 0 failed.
- `t6b-repair-runtime.test.ts`: 11 tests, 11 passed, 0 failed (real SQLite scheduler/evidence stores, real `ArtifactStore`, advancing clock, real pump; legacy replay included).
- `t6b-repair-factory.test.ts`: 1 test, 1 passed, 0 failed (runtime built through `NativeBuildFactory` with a real execution host, real git baseline, real failing `node --test` check, real cleanup receipt validation).
- T6a kernel `delivery-acceptance.test.ts`: 29 tests, 29 passed, 0 failed.
- Affected-suite batches: batch 1 (delivery-acceptance, repair-cycles, final-verification-repair, scheduler-store, architect-tools, project-memory, role-capabilities, runner-capability-contract, build-runtime): 147 tests, 146 passed, 0 failed, 1 skipped. Batch 2 (final-verification-runtime, native-worker-driver, native-architect-runtime, task-scheduler): 54 tests, 54 passed, 0 failed.
- Runner typecheck (`tsc -p runner-v2/tsconfig.json --noEmit`): passed.
- ESLint on all touched source/test files: passed, 0 errors, 0 warnings.
- No `child_process` in new production code (tests only).

## Prove-red

Each injection disabled one guard, observed RED because the forbidden action succeeded, restored the file byte-for-byte, and matched SHA-256 before/after.

1. Fourth cycle refused (`scheduler-store.ts` issue-budget check) — RED: "Missing expected rejection" (`/Issue repair budget is exhausted/`); the 4th cycle was accepted. Restored SHA-256 `6fb478d7eaab52b0e694dd2d4acecfcca40542fa5040dbe41bafcf3a16f85e4a`.
2. Stricter run cap (`repairCyclesExhausted`) — RED: dispatch proceeded to `final_verification_repair_plan_required` instead of pausing with `repair_cycle_limit_reached`. Restored same SHA-256.
3. Repeated approach (`beforeRepairDecisionDispatch` approach validation) — RED: expected `/explicit repeat|NEW/`, got architect-no-action (repeat passed the gate). Restored SHA-256 `50e8e8259f59b2648649542509510693b590d5b96d130c3b4d2b192a9aed1be3`.
4. Flaky charge (failing-check `cycle_recorded` append) — RED: `0 !== 1` cycles on "flaky fail-again charges exactly one cycle". Restored SHA-256 `0add286603c7c23490557733253f50cb1206eb768c569f6ef67f5c9a60e9fa32`.
5. Ownership proof (`searchRecordedTempPaths` owner check) — RED: `3 !== 2`, the foreign record was processed. Restored SHA-256 `df9301d4dab9fa8e384c92966de79369b9089bb501be66f1354d1c4ea273298d`.

## Changed-file SHA-256

- `runner-v2/src/agent-prompts.ts`: `58887794a6a8e1fa5a11daf7e2d330fe96eb78bfc9ec9a347cf2221e3801275a`
- `runner-v2/src/architect-tools.ts`: `0d9445c20a2e482317907b32ce32979362cbb3066cb6332b071a101e132b4747`
- `runner-v2/src/build-runtime.ts`: `ddffbefece3c6b86aa588ad373896f405fdc19154a49b91954e8a6671dcabc3e`
- `runner-v2/src/cleanup-ownership.ts`: `df9301d4dab9fa8e384c92966de79369b9089bb501be66f1354d1c4ea273298d`
- `runner-v2/src/defect-history.ts`: `b13db5226ca26855fe2932dac8f031d17143f50ccec14ef569646744c1b74261`
- `runner-v2/src/delivery-acceptance.ts`: `50e8e8259f59b2648649542509510693b590d5b96d130c3b4d2b192a9aed1be3`
- `runner-v2/src/delivery-execution.ts`: `183a0a6f87e0d7727f2d3fa644bae080ef09f1ed2f138a456e74a9cc38be52d6`
- `runner-v2/src/execution-host.ts`: `bd1a82356a8ebf5f2717e745f3be6414b1d974248a5317ce5558bcd0d82198b2`
- `runner-v2/src/final-verification-runtime.ts`: `2ca2d2aa2db05608f6cefbc3ed1442ee93134242c02f44eb30646cf4bf709660`
- `runner-v2/src/flaky-rerun.ts`: `22a6ef8bfb1ce4ebd12be4b571bfe4256132e168bdb49c236600984a846ff334`
- `runner-v2/src/native-architect-runtime.ts`: `af65525a9f8018bf44fc80fe596554a671af7b5ee1a3bea9cfd6babc6ccc3466`
- `runner-v2/src/native-build-factory.ts`: `8e726b2911d07d1aec47b49a65d88d7d254ae7d8a612ec8fe5fdd48e4a725e94`
- `runner-v2/src/native-deliverable-review.ts`: `22f58c8196a0368768cf6ca08acc5ca9a27dc98086c2344385ce22d2d177ec91`
- `runner-v2/src/native-worker-driver.ts`: `b080f69e63fd6b35ff2294600f748078288f0ffee7e13ae41aa21c93d3eafeed`
- `runner-v2/src/repair-approach-contracts.ts`: `f901109597aaaa4076b4592d110ef55e126b4ab6067aa2301cd8962946516a3dc`
- `runner-v2/src/repair-budget-contracts.ts`: `150cef7a435b04ac38eaf9bba0872da57a55e573fa5d301328e8802d96385b69`
- `runner-v2/src/role-capabilities.ts`: `7c0481aa5a1952f37c3785d988210f38fb0379fac10d6e82c2281b718428dc7b`
- `runner-v2/src/runner-capability-contract.ts`: `6177158d5fd818e5047834fceaaa9d7bf76068c9088d1815389f050cae49960f`
- `runner-v2/src/scheduler-store.ts`: `6fb478d7eaab52b0e694dd2d4acecfcca40542fa5040dbe41bafcf3a16f85e4a`
- `runner-v2/src/sqlite-project-memory.ts`: `b8bf4b45b551ad60b5c6cd1c1b80253738f5922ade5392bde0a0bc435c6cc945`
- `runner-v2/src/windows-process-semantic-probes.ts`: `01e36e3ed0c82b2b9deff4c9abcc42913484e8e89507a9c162ae1752c0832819`
- `runner-v2/src/worker-lifecycle-tools.ts`: `5fd28985ed6ec28b0b1acd13905361aea31fdc78762923d3434bd9b0430393d3` (empty `git diff`: stat-only change from line-ending normalization, no content edit)
- `runner-v2/src/worker-runtime.ts`: `09df9bbd2725d2177b5f14dfbce99d98cec6fa970d04927ce5f589a1ada6b295` (empty `git diff`: stat-only change from line-ending normalization, no content edit)
- `runner-v2/test/build-runtime.test.ts`: `7190ce43d09889962dec8ac4f3499fa3b0fc53f50e47f1320ba7d393dd2557e6`
- `runner-v2/test/delivery-acceptance.test.ts`: `eac6d197a363396bffaf0724ee6d8e1a11b7aea5e67f9802ab3bb9546a69de48`
- `runner-v2/test/role-capabilities.test.ts`: `642057590987351ce955e4dbbe7ea6ffc952f23d1c3cdfc4b64177e846fa7b16`
- `runner-v2/test/t6b-defect-cleanup.test.ts`: `ec7cd711edaf84407031ce5ef410785bdba0d4cac145cb627c651fb6ded17318`
- `runner-v2/test/t6b-repair-budget.test.ts`: `37b4ae68b04dcb6b21803016920a2d1242fb6306700245e885e466cc79842da2`
- `runner-v2/test/t6b-repair-factory.test.ts`: `b0abf101c5b82a2b673b3d27cd5ab1446663854e5194e10cfe94c5f2dfbb666c`
- `runner-v2/test/t6b-repair-runtime.test.ts`: `92d34fcaa8cf86e5501a439c9fa41b1c5f9660b1c6439d8af275d661bdd7b1c7`

## Not done / limits

- Independent reviewer review is not done; this evidence does not self-accept T6b.
- Full `npm run test:runner-v2` was not run. Importer suites not run: the remaining ~70 `runner-v2/test` suites that import changed modules but cover unrelated areas (execution/mcp/lsp/git/cli/control-server/process-recovery/managed/native-build matrix/browser suites); the `native-delivery-factory` suite result is recorded separately below.
- `native-delivery-factory.test.ts`: 17 tests, 17 passed, 0 failed.
- Finding (needs a dedicated final-verification investigation, not a T6b defect): under the managed execution host, a fixture `test` script invoking bare `node --test` against a present failing file reported exit 0 (the identical command fails in an interactive shell, and the absolute binary `process.execPath` fails correctly in the same workspace). The T6b factory test therefore invokes the absolute node binary. Bare-`node` resolution inside npm scripts under the sanitized environment should be investigated separately.
- `runner-v2/src/worker-lifecycle-tools.ts` and `runner-v2/src/worker-runtime.ts` show as modified but have empty `git diff` (stat-only change from line-ending normalization); no behavioral edit.
- Non-ASCII bytes are preserved (only the pre-existing em-dash in touched sources); new test files are LF, matching blob convention.

## Repair cycle 1 (2026-09-26, uncommitted)

Fixed B6 first, then B1, B3, B4, B5, B2, B7, plus the importer greens the
controller flagged (architect lifecycle surface, filesystem-mutation
routing). Order of discovery below is finding -> change (file:line) ->
test -> prove-red. Line numbers are repair-cycle-1 working-copy lines.

### B6 safety (done first)

- Finding: cleanup ownership lived outside Runner-private state; a forged
  creation record outside runner roots could delete a user folder.
- Change: SQLite-backed ownership with root containment and lstat semantics
  that never follow symlinks (`runner-v2/src/cleanup-ownership.ts:121`);
  execution-host records the transient root and always removes it
  (`runner-v2/src/execution-host.ts:304`, `:343`).
- Test: `t6b-defect-cleanup.test.ts` probe F
  ("a forged record outside runner roots never deletes a user folder").
- Prove-red PR2: root gate neutralized -> suite 7/9 RED (probe F fails);
  restored, hash verified.

### B1 execution host (regression + pin)

- Finding: the historical-Git-query transient root leaked on the failure
  path (the `readdir(state)` assertions cannot see the system-temp root).
- Change: failure path removes the root and clears the record
  (`runner-v2/src/execution-host.ts:343`); fixture strips
  NODE_TEST_CONTEXT from the ambient snapshot (N1,
  `runner-v2/test/t6b-repair-factory.test.ts:140`).
- Test: new pinning assertion in `git-bootstrap.test.ts:108` (no
  `aiboard-git-inspection-*` roots survive a failed query).
- Prove-red PR8: rm neutralized -> suite 5/6 RED; restored, hash verified,
  leaked root cleaned.
- Correction to the prior "bare node" note: the exit-0-with-failing-file
  cause was the NODE_TEST_CONTEXT leak (stripped in the fixture and in
  every final-verification child), not bare-`node` resolution.

### B3 deadlock (pause, never throw)

- Finding: repair refusals threw (budget exhausted, failed approach),
  stalling the pump and the Architect turn.
- Change: `pauseOnRepairIssue` / `prepareRepairDispatch`
  (`runner-v2/src/build-runtime.ts:3071`, `:3110`); exhausted issues,
  blockers, and caps pause with `repair_issue_paused` + durable cause.
- Test: "an exhausted issue pauses repair dispatch through the real pump",
  "three dispatched corrections" pump tests (12/12 runtime suite).
- Prove-red PR6: pause replaced with throw -> suite 10/12 RED; restored.

### B4 approach decision (usable + enforced)

- Finding: the kernel synthesized decisions; the decision tool ended the
  Architect turn; evidence ids were unenforced.
- Change: non-terminal `record_repair_approach_decision`
  (`runner-v2/src/architect-tools.ts:968`); dispatch requires a live
  decision (`:910`, `:734`); new tools registered in
  ARCHITECT_LIFECYCLE_SURFACE (`runner-v2/src/build-runtime.ts:3449`).
- Test: "a failed approach gives the Architect a turn; a new approach
  dispatches and charges" (importer surface suite 71/71 green).

### B5 cycle counting (dispatch-time, per root cause)

- Finding: the check site charged cycles (including a fourth fix and
  zero-execution reruns); charge key was not per root cause.
- Change: check opens the issue but never charges
  (`runner-v2/src/build-runtime.ts:3314`); one charge per dispatched
  correction (`runner-v2/src/architect-tools.ts:937`); reducer backstop
  (`runner-v2/src/scheduler-store.ts:3869`); pure contract
  (`runner-v2/src/repair-budget-contracts.ts:71`).
- Test: budget "three substantive cycles charge and a fourth is refused";
  runtime third-correction dispatch test.
- Prove-red PR1a: pure-contract limit neutralized -> budget 8/9 RED;
  restored. PR1 (reducer guard): neutralizing it leaves the budget suite
  green — that suite pins the pure contract; the reducer guard is
  defense-in-depth behind the tool check and the pump pause.

### B2 flaky isolation (production rerun + real counts)

- Finding: rerun "green" came from the injected driver's flag; a rerun
  with zero executed counted as flaky; junit plumbing never produced a
  report in production (three compounding defects found by the new
  integration test): (1) the summary regex only matched
  `tests=`/`failures=` attributes, but node 24 emits bare `<testsuites>`
  with `<!-- tests N -->` comments; (2) the junit destination used
  backslashes, which NODE_OPTIONS unescapes, so the file was never
  written; (3) the `--test-name-pattern` flag was appended after the
  positional test path, which node ignores.
- Change: shared verdict `judgeFlakyRerun`
  (`runner-v2/src/flaky-rerun.ts:83`, used by the factory at
  `runner-v2/src/native-build-factory.ts:1527`); comment-tolerant totals
  (`runner-v2/src/final-verification-runtime.ts:1574`); forward-slash
  destination (`:1547`); pre-positional flag
  (`runner-v2/src/flaky-rerun.ts:59`); single-pattern case parser (no
  cross-tag swallow); ambient NODE_OPTIONS threaded from the factory
  snapshot instead of `process.env` (`:185`, `:369`, `:1553`,
  factory `:1519`+); no-ids `not_performed` record
  (`runner-v2/src/build-runtime.ts:3306`, reducer allowance
  `:3896`).
- Test: new `t6b-flaky-rerun.test.ts` (5/5): pure verdict traps plus a
  really-flaky fixture through the real FinalVerificationRuntime (full
  run red with NODE_TEST_CONTEXT forcibly leaked, narrowed rerun green
  with executed 1, empty-pattern green with executed 0 judged not
  flaky); factory test asserts the npm-shape `not_performed` path.
- Prove-red PR3: verdict weakened -> 2/5 RED; PR4: case parser broken ->
  4/5 RED (integration); both restored, hashes verified.

### B7 per-model outcome (history, sticky)

- Finding: only the accepting review's author was recorded, erasing
  earlier rounds and misattributing defects.
- Change: `reviewOutcomeByAuthor`
  (`runner-v2/src/delivery-acceptance.ts:379`), called before the
  acceptance event (`runner-v2/src/build-runtime.ts:3347`); store keeps
  defect_found sticky per (model, task).
- Test: new B7 unit test in `delivery-acceptance.test.ts`
  ("keeps the first review's defect on its original author"); store
  stickiness in `t6b-defect-cleanup.test.ts`.
- Prove-red PR7: last-review-only aggregation -> suite 29/30 RED;
  restored, hash verified.

### Importer greens fixed during the cycle

- `git-caller-audit`: `process.env.NODE_OPTIONS` read in
  final-verification-runtime.ts replaced with factory-threaded ambient
  (see B2); suite green.
- `one-shot-command-routing-static`: regex `.exec()` loop replaced with
  `String.matchAll`; suite green.

### Suites (repo root, NODE_TEST_CONTEXT cleared; counts observed)

- t6b-repair-runtime 12/12; t6b-flaky-rerun 5/5; t6b-repair-budget 9/9;
  t6b-defect-cleanup 9/9; t6b-repair-factory 1/1; git-bootstrap 6/6;
  delivery-acceptance 30/30.
- architect-lifecycle-surface + filesystem-mutation-routing + fence 71/71.
- Batch A1 (architect/build/context/delivery/role/planning/memory/
  scheduler/repair/acceptance/task-scheduler/worker/test-report) 207/207.
- Final-verification suites (15 files) 129/129.
- Batch A3 (execution-host/credentials/cli/lsp/mcp/architect-runtime/
  worker-driver/capabilities/triage/reviews) 301 pass, 0 fail of 302
  (1 skipped).
- control-server/cli/project-docs/lsp-real-host/fv-b1 37/37.
- Static audits + replay + native-final-verification-factory green
  (git-caller 14/14, one-shot 2/2 after the two fixes above).
- Heavy matrix (git-indirect/git-production-managers/git-integration/
  managed-shared/managed-strict-oci/mcp-lazy) 23/23.
- native-delivery-factory 17/17 on final code (a type-only unused-import
  removal in native-deliverable-review.ts landed mid-run; `import type`
  is compile-erased, tsc+eslint clean, zero runtime delta).
- `tsc -p runner-v2` clean; root `tsc` clean; `eslint .` 0 errors
  (14 pre-existing unused-var warnings); `git diff --check` clean; no
  mixed line endings or BOM in changed files (tracked sources uniform
  CRLF per checkout convention).

### File hashes (sha256, working copy)

- a1c74e4dd4c00b5a48bc9e8472a056a8394a8f126ed4c2f6f53bcec957e6351f runner-v2/src/agent-prompts.ts
- 34e3d4f31ddf38603de1e5636ef9edfaa03be18142a74e6bef7879631e51e229 runner-v2/src/architect-tools.ts
- b8cce8ca846dfc271747b05489b34d4591e485628da52708aed1e41651c0ebd3 runner-v2/src/build-runtime.ts
- d4ad5027e593666368277233570352c58fbc8566c2b1306b05e40775cf64fa7a runner-v2/src/cleanup-ownership.ts
- f0bc24b2376a667603c8ae3896c20b94f657090070fb8ad94cf7225773d515bd runner-v2/src/defect-history.ts
- 9532c129f1e2889a55b704206439f75bbe9a0e1ce7a8817e011ec04684d4d11c runner-v2/src/delivery-acceptance.ts
- 6b859f1ebe493b4da9c9952052b6edddfeda8d544ad32826a45871764744cec8 runner-v2/src/delivery-execution.ts
- a2b20879ca6ac892329cc4358b3b03dd8c083209bec293a305f56eb0309353d9 runner-v2/src/execution-host.ts
- c13a41a668866acac374c8e023f4d8b1f51303e445f520ad1ef3a3c7f70b2991 runner-v2/src/final-verification-runtime.ts
- 19c70ba3c0b0fdd6b84b0d34b1a9e5f8d6c19a8d8eef703e42faa7c47f9ca029 runner-v2/src/flaky-rerun.ts
- 4639d0580c3013ef0846b29e77f3509c69291a668412f1afb42c49a4b5a0b94f runner-v2/src/native-architect-runtime.ts
- 653bea52f06195066189297f9a299ff9a1a6bfd9e971c825a8e832e4684c0158 runner-v2/src/native-build-factory.ts
- c8a6a55e30b5cf0b7eef1aeeb27b109994eb33cbda98765fe741d06048ff9f2a runner-v2/src/native-deliverable-review.ts
- 7d5d4b5eace74c9aca280102e8906d48cdf52fe1da81e808ab0dcd605af829c4 runner-v2/src/native-worker-driver.ts
- a62d904b94818ca2834c771f1f0f964374ce77ab14efa855d85d466bd19ce8da runner-v2/src/repair-approach-contracts.ts
- 2f51d12d989197dfe97fd79e7c4bff375f79be3ce757fa219fc1f424406fc5a8 runner-v2/src/repair-budget-contracts.ts
- 781ea4c2e7d47a80b544dd215a326b24632ff00d06023d1837e5d7df7a6123d8 runner-v2/src/role-capabilities.ts
- abeafb2477e8be0f1fbc4e6fe9a733ca6f36c37b59fd71f01d20c52a44c8db93 runner-v2/src/runner-capability-contract.ts
- 9dbf1472824dc874dd5b1f6f3778cbefd5d094eb1a02276afed4e21e0078aac5 runner-v2/src/scheduler-store.ts
- 4e3d7804e33b8c797d85b1949431ec33ba6c25c77620e4e0e8e9f81ca41eff3c runner-v2/src/sqlite-project-memory.ts
- 4b0e455cb231008d582e999f3515a00b1fca1f139ca9ad55c39f7accf660f82a runner-v2/src/windows-process-semantic-probes.ts
- 7190ce43d09889962dec8ac4f3499fa3b0fc53f50e47f1320ba7d393dd2557e6 runner-v2/test/build-runtime.test.ts
- 72e5e1093ecec2d0f519b835c91ca8a9dedd5ffc9c51bcc2037e6e0c9b310719 runner-v2/test/delivery-acceptance.test.ts
- a9374323dd7c4393a647c9522ad43765b8a668a5f61533101f3637e74d4f45e1 runner-v2/test/git-bootstrap.test.ts
- 642057590987351ce955e4dbbe7ea6ffc952f23d1c3cdfc4b64177e846fa7b16 runner-v2/test/role-capabilities.test.ts
- ecf3428c8ed8f85c16f3026142efaa4405311ed8c930cbb3ea829cec12b24d50 runner-v2/test/t6b-defect-cleanup.test.ts
- c32224f3415efe65f3fd0be92cd2b85ec904f01d8ae907d960b867697420691b runner-v2/test/t6b-flaky-rerun.test.ts
- 2436e4edbbdbd1820954f9e1d0937d3a93fb081a43bbf397db6e9f78442dce5d runner-v2/test/t6b-repair-budget.test.ts
- 010654066ba12e93be43a3f5a3881d7b7939e8d09e62cbdc963f11595bf29fad runner-v2/test/t6b-repair-factory.test.ts
- a724885ab6ac33608745570556e3c9de4abaab6b9b277283d42a5ea893e1c562 runner-v2/test/t6b-repair-runtime.test.ts

## Not done / limits (repair cycle 1)

- Independent reviewer review is not done; this evidence does not self-accept T6b.
- Full `npm run test:runner-v2` was not run; remaining unrun suites are
  those covering areas untouched by this cycle (planning/budget/artifact/
  browser/extended MCP-LSP matrix/qualification scenarios).
- A full three-round worker loop (repair submit -> delivery review ->
  boundary -> re-verify) is not covered in the unit harness: it needs the
  deliverable reviewer drivers. Dispatch charging (rounds 1 and 3),
  reducer/tool/pure-contract guards, and the exhausted pause are each
  proven through the real pump; the composition across worker-completed
  rounds is verified only in production.
- Prove-reds mutate and restore: all 8 mutated files hash-verified back
  to the values above after their red run.
- Changes are uncommitted in the `runner-v2-p6-6` worktree, as instructed.

## Repair cycle 2a (controller, after review r2: B6 + B4)

Scope (coordinator, binding): only R2-B6 and R2-B4. R2-B1, R2-B2, R2-B3,
R2-B5 and the non-blocking items are NOT done here; a worker does them
next. `repair-approach-contracts.ts`, `architect-tools.ts` and
`scheduler-store.ts` were not touched.

### R2-B6 cleanup safety

- (a) Production roots. `nativeBuildCleanupRoots(stateDirectory, runId)`
  (runner-v2/src/native-build-factory.ts:3733) returns only the six exact
  disposable workspace paths of this run (verification, independent
  verifier, architect-commands, delivery-review, delivery-boundary,
  baseline), computed by the same `VerificationWorkspaceManager` path
  rule. `cleanupAfterAttempt` (native-build-factory.ts:1621-1633) now
  passes these roots. `tmpdir()`, the Runner state directory and the run
  root are never roots.
  Test: `probe F2 (R2-B6)` in runner-v2/test/t6b-defect-cleanup.test.ts
  (the reviewer's PROBE-F2 inverted, with the production root builder):
  `%TEMP%/someone-elses-folder-*/user-data`, `<state>/credentials-dir`
  and a run-root folder all survive and are reported retained; a
  recorded junit report inside the verification workspace is deleted.
- (b) Creation records. `cleanupAfterAttempt` records each of the six
  workspaces that exists as `retained: true` (git worktrees are removed
  only by their manager). `FinalVerificationRuntime` has a new
  `tempRecorders` option (final-verification-runtime.ts:199, record at
  :688); every junit report file (direct `node --test` and package
  `run test`, check and flaky rerun) is recorded as a non-retained file
  before the command runs. The factory passes the sink only for
  new-policy runs (`policyTempRecorders`, native-build-factory.ts:1420).
  Test: both factory scenarios assert 2 report records, both files gone
  after the search, a `cleaned` temp_path finding for them, and a
  retained verification-workspace record.
- (c) Searches. `recordCleanupSearch("verification")` now also runs after
  the independent verifier returns (build-runtime.ts:1683), after the
  delivery review (success :2343 and exception :2338), and after the
  delivery boundary (recorded :2469 and exception :2445). The flaky rerun
  was already followed by the search in `applyFailingCheckRepairCharge`.
  No new event type; the search is a no-op for legacy runs.
- Residual (not run-scoped, documented, not wired): execution-host
  historical git inspection copies, plugin/capability extension staging,
  the historical SQLite snapshot mkdtemp, and the Windows probe roots.
  They are runner-global or self-cleaned inside one operation and have no
  run owner to record against.

### R2-B4 npm failing ids and flaky rerun by real counts

- FV capture. For a `tests` command that is not direct `node --test` and
  does not already set NODE_OPTIONS, `FinalVerificationRuntime` now plans
  the report with the reviewed T6a `planTestReport` (dynamic import;
  delivery-execution imports this module) and runs the planned command
  (final-verification-runtime.ts:667). A caller that sets NODE_OPTIONS
  (the T6a delivery boundary) keeps its own reporter and report path.
- Parser (N-8). `readJUnitTestReport` (final-verification-runtime.ts:1622)
  now uses the T6a `nodeJunitOutcome`: file-level entries, skipped tests
  and suites never count. `executed = passed + failed`; a filtered run
  with no real test gives executed 0, which `judgeFlakyRerun` never
  accepts. The old private parser (`junitTotals`) is removed.
- Rerun narrowing. `isPackageRunTestCommand` (flaky-rerun.ts:33). The
  factory flaky driver keeps the package command and passes
  `testNamePattern = flakyRerunPattern(ids)` (native-build-factory.ts:1495);
  `nodeOptionsWithTestNamePattern` (final-verification-runtime.ts:1649)
  adds `--test-name-pattern="..."` (backslashes and quotes escaped) to
  NODE_OPTIONS, and the planner then marks the run filtered.
- Tests (runner-v2/test/t6b-repair-factory.test.ts, real factory, real
  `npm run test`, script `node --test ...` with normal node resolution):
  - fail-again: failing id `["t6b red"]` captured; rerun recorded
    `consistent failure`, rerunGreen false, rerun evidence present; issue
    open with used 0 (charge happens at dispatch; this architect never
    dispatches, so the "charged once at dispatch" half stays with B5).
  - really-flaky: fails first run, passes later. The other test fails
    whenever the marker exists, so only a rerun narrowed to exactly
    "t6b red" is green. Recorded `flaky: ... still requires a clean run`,
    rerunGreen true, used 0, run not completed.

### Prove-reds (sha256 before / injected / restored; restored = before)

- PR-B6: native-build-factory.ts `nativeBuildCleanupRoots` returns
  `[tmpdir(), stateDirectory, ...]` (the old wholesale roots).
  bfb4af3f...95f5 / f6e91869...655c / bfb4af3f...95f5. `probe F2` red
  (1 fail).
- PR-B4: final-verification-runtime.ts npm planning branch disabled
  (`&& false`). b91ef850...ca06 / ec6f658b...3f764 / b91ef850...ca06.
  Both factory scenarios red (2 fail).

### Validation (NODE_TEST_CONTEXT cleared, repo root)

- One run over: t6b-*.test.ts, final-verification-*.test.ts,
  native-final-verification-factory, native-delivery-factory,
  native-verifier-factory, native-verifier-runtime, delivery-acceptance,
  git-bootstrap, build-runtime, filesystem-mutation-fence,
  one-shot-command-routing-static, replay-compatibility,
  architect-lifecycle-surface: tests 357, pass 356, fail 1, skipped 0.
- The 1 fail is `finish-policy architect registration stays inside the
  lifecycle surface`: it sees `record_external_blocker` and
  `record_repair_approach_decision` from the earlier T6b work in
  architect-tools.ts (not touched here; open for the worker's B1/B2 pass).
- A first run found a real regression of this cycle: the npm planning
  re-planned the delivery boundary's own command and moved its report
  (10 native-delivery-factory failures). Fixed by the NODE_OPTIONS
  ownership rule above; the rerun is the 357-test result.
- runner tsc 0, root tsc 0, eslint on changed files 0 problems,
  `git diff --check` clean. Encodings: no BOM, no U+FFFD, uniform line
  endings (CRLF: native-build-factory, final-verification-runtime,
  build-runtime; LF: flaky-rerun, both test files).

### sha256 of changed files (final)

- runner-v2/src/native-build-factory.ts bfb4af3fbfda7324b32c59a3cfde601eb86b33ed7d8920a0c691628061fd95f5
- runner-v2/src/final-verification-runtime.ts b91ef850cedf91ede80678a7214b6525e35483d99030336bdcd76d0df9ffca06
- runner-v2/src/flaky-rerun.ts 098257f90e301384e1e089a83edbc96b707f85a6e8bc99d74d4a75d9bc705da9
- runner-v2/src/build-runtime.ts 249fa4836160eec369a0eac50a1d8aa02240ba2d7268e6cd014a10e44efc23c2
- runner-v2/test/t6b-repair-factory.test.ts 6ec7cce7ae9fdff83da96608e8c61b788d784f60f0563a946abd41654817c3a8
- runner-v2/test/t6b-defect-cleanup.test.ts 30a01447f5a783b7d2bb8d42d3901e4567a2963feb0c258b7cf04d95c6a78221

Uncommitted, as instructed.

## Repair cycle 2b (worker: R2-B1, R2-B2, R2-B3, R2-B5, lifecycle surface, N-items)

Scope (binding): the four easier blockers from review r2 plus the
non-blocking items. Repair cycle 2a (controller: R2-B6 + R2-B4) is NOT
changed by this pass: its cleanup roots, junit capture, rerun narrowing
and parser stay as committed in that section. Two 2a-owned files gained
additive-only wiring later in this pass (noted below); no 2a semantics
were altered and the 2a tests are green untouched.

### R2-B1 pause idempotency + resume durability

- `pauseOnRepairIssue` (runner-v2/src/build-runtime.ts:3102) keys the
  pause event `repair-issue-paused:<issue>:<cause>:<used>/<limit>:<sequence>`
  (:3114), so a pause after an owner extension is a new occurrence and a
  generic owner resume re-pauses durably instead of throwing an
  idempotency conflict or leaving a phantom running run.
- Tests (runner-v2/test/t6b-repair-runtime.test.ts): "an owner extension
  lets the next exhaustion pause again instead of throwing" and "a
  generic owner resume re-pauses durably instead of leaving a phantom
  running run".

### R2-B3 empty-evidence relabel refusal

- `validateRepairApproachDecision`
  (runner-v2/src/repair-approach-contracts.ts:50-92): with prior
  approaches a decision needs NON-EMPTY evidence outside every prior
  excluded set (empty never passes), and a new id reusing a failed
  approach's hypothesis + diagnostic set is a relabel refusal. The
  reducer applies the same rule to its draft (runner-v2/src/scheduler-store.ts:3809+).
- The decision tool additionally refuses fabricated ids against the
  store, now for BOTH sets: unknown `evidenceIds` via knownEvidenceIds
  in the contract, unknown `diagnosticSet` ids via the `unknown_evidence`
  gate (runner-v2/src/architect-tools.ts:1004). This closes N-3 too.
- Tests: the R2-B3 relabel test now mints a REAL evidence id and pins
  the refusal code `invalid_repair_approach_decision` (not the
  unknown-evidence gate); new N-3 test "a repair approach citing unknown
  diagnostic evidence is refused and charges nothing" pins
  `unknown_evidence` with used 0 and no recorded approach.

### R2-B5 review-round charging + final-verification identity

- `chargeReviewFixRound` (runner-v2/src/build-runtime.ts:3210): a
  blocking review fix round opens and charges a
  `delivery-review:<task>:<criterion|finding-class>` issue through the
  real pump (three fixes charge three cycles; the fourth pauses
  durably). CORRECTION (R3 N-5): the factory fail-again test asserts
  used 1 with one `dispatched` cycle at dispatch
  (runner-v2/test/t6b-repair-factory.test.ts:275-283) — the "used 0
  pre-dispatch" wording above was stale; the test was always right.
- Final-verification identity is category + sorted failing check/test
  ids + affected obligation, not the category alone
  (runner-v2/src/repair-budget-contracts.ts `repairRootCauseForCheck`;
  three-fixes test charges once per distinct failing test then pauses).
- Tests: "blocking review fix rounds charge the review issue budget and
  the fourth round pauses", "three real fixes on the same failing test
  charge once each, then the fourth round pauses".

### R2-B2 boundary issue opening + tool path

- `advanceDeliveryAcceptance` (runner-v2/src/build-runtime.ts:2415)
  opens the member `delivery-boundary:<check>` issues via
  `prepareRepairDispatch` BEFORE `runArchitect`, pausing on exhaustion;
  the tools resolve them at the integration turn
  (`resolve_delivery_boundary_failure`, runner-v2/src/architect-tools.ts:1348+).
- Test: "a failed delivery boundary opens repair issues so the
  Architect resolves through the tools" plus the tool-path unit test.

### Lifecycle surface + factory charged-once

- `record_repair_approach_decision` and `record_external_blocker` are
  registered finish-policy lifecycle tools
  (runner-v2/src/architect-tools.ts:575). This also clears the 2a
  validation failure ("finish-policy architect registration stays inside
  the lifecycle surface", runner-v2/test/architect-lifecycle-surface.test.ts).
- `renderRepairIssues` (runner-v2/src/agent-prompts.ts:648) renders
  `failureEvidence=` per approach (N-2), covered by the context-assembler
  failure-evidence test (pack.text assertion; IncludedContextSection
  carries no content field).
- Factory charged-once extension (runner-v2/test/t6b-repair-factory.test.ts):
  the third correction dispatches and charges through the real pump
  ("the third correction dispatches and charges through the real pump",
  t6b-repair-runtime).

### Non-blocking items

- N-1 (pending-at-dispatch): `repair.cycle_recorded` marks
  `approach.failed = outcome !== "resolved" && outcome !== "dispatched"`
  (runner-v2/src/scheduler-store.ts); a dispatched approach stays live
  until its validation records. Covered by the dispatch-then-resolve
  runtime tests.
- N-2: failureEvidenceIds rendered (agent-prompts.ts:648, above).
- N-3: diagnosticSet validated against the evidence store (above + test).
- N-4 (run id in the outcome key): `model_review_outcomes` is keyed
  (project_id, run_id, model_id, task_id)
  (runner-v2/src/sqlite-project-memory.ts: MODEL_REVIEW_OUTCOMES_DDL;
  pre-N4 tables are rebuilt, legacy rows keep the '' run bucket);
  `recordModelReviewOutcome` takes optional runId, `modelReviewOutcomes`
  filters by run; the review snapshot is scoped to the requesting run
  (runner-v2/src/native-deliverable-review.ts:285) and the recorder
  stamps the run (runner-v2/src/build-runtime.ts:3441,
  runner-v2/src/native-build-factory.ts:1641). The 2a defect-cleanup
  test is untouched (legacy '' bucket preserves its assertions). New
  test: "model review outcomes are isolated per run and legacy tables
  migrate" (t6b-repair-runtime).
- N-5 (per-request defect classes): the worker driver and the review
  runtime resolve `defectClassesFor` fresh on every turn instead of the
  construction snapshot
  (runner-v2/src/native-worker-driver.ts:136,532;
  runner-v2/src/native-deliverable-review.ts:644,332; factory closures at
  runner-v2/src/native-build-factory.ts:948,1341). Asserted on real
  `AgentModelRequest` messages: worker test
  (runner-v2/test/native-worker-driver.test.ts, finding recorded AFTER
  driver construction appears in the captured request) and reviewer test
  (runner-v2/test/delivery-acceptance.test.ts, class provided after
  harness construction appears in the captured pass texts).
- N-6 (attempt-scoped process search): `searchOwnedProcesses` takes an
  optional `{ sessionIds }` scope
  (runner-v2/src/cleanup-ownership.ts:232); scoped searches stop only
  in-scope processes via the new narrow `stopProcesses`
  (runner-v2/src/managed-process.ts:171) and report out-of-scope live
  processes retained; unscoped calls keep the legacy run-wide stopRun.
  The attempt path threads tick-window worker sessions
  (`workerSessionIdsSince`, runner-v2/src/build-runtime.ts:3417, wired
  at :1248 and forwarded by the factory closure at
  runner-v2/src/native-build-factory.ts:1615); verification phase
  boundaries keep the run-wide search (documented residual: no worker
  attempt is active there). New tests:
  runner-v2/test/cleanup-ownership.test.ts (scoped stop + legacy stop).
- N-7: done in 2a (normal node resolution in the factory test).
- N-8: done in 2a (T6a nodeJunitOutcome parser).
- N-9: `beforeRepairDecisionDispatch` is gone from the tree (deleted;
  the gate lives in the tools + `prepareRepairDispatch`).

### Prove-reds (sha256 before / injected / restored; restored = before)

- PR-B1: build-runtime.ts pause key without generation/sequence
  (`repair-issue-paused:<issue>:<cause>`).
  b99e64fb...1fac8a / 5c36aa1f...7301773f532 / b99e64fb...1fac8a.
  "owner extension" red: `Scheduler idempotency conflict for
  repair-issue-paused:...:budget_exhausted`.
- PR-B2: build-runtime.ts boundary member categories `? []`.
  b99e64fb...1fac8a / c1b1f3f0...1e2854986 / b99e64fb...1fac8a.
  Red: "the boundary turn sees the opened
  delivery-boundary:tests issue".
- PR-B3: repair-approach-contracts.ts `priors.length > 0 && false`.
  002e3667...2b2019d6ace8b2 / b61fda27...9226827cc51 /
  002e3667...2b2019d6ace8b2. Red: `mechanical_transition_rejected`
  where `invalid_repair_approach_decision` is expected (tool gate
  bypassed, reducer backstop fires: defense in depth holds).
- PR-B5: build-runtime.ts `members.size >= 0` early return.
  b99e64fb...1fac8a / 8002d354...1a961951b42 / b99e64fb...1fac8a.
  Red: review issue used `undefined` instead of 1.

### Validation (NODE_TEST_CONTEXT cleared, repo root)

- Batch 2: native-delivery-factory, build-runtime, native-worker-driver,
  context-assembler, role-capabilities, git-bootstrap: tests 85, pass 85,
  fail 0. (native-worker-driver re-ran 12/12 after a line-ending
  normalization of its test file.)
- Batch 1: t6b-repair-budget, t6b-flaky-rerun, cleanup-ownership,
  architect-tools, architect-lifecycle-surface, replay-compatibility:
  tests 27, pass 27, fail 0.
- Batch 3a: t6b-repair-runtime, t6b-repair-factory, t6b-defect-cleanup,
  managed-process, managed-record-compatibility, worker-runtime,
  project-memory: tests 53, pass 53, fail 0.
- Batch 3b: native-build-capabilities, native-architect-runtime,
  native-verifier-runtime, native-verifier-factory, change-risk,
  planning-tools, request-triage: tests 161, pass 161, fail 0.
- Batch 3c: native-final-verification-factory,
  final-verification-orchestration, final-verification-review,
  final-verification-runtime-b1, final-verification-managed-authority,
  execution-host, runner-capability-contract,
  process-host-semantic-probes: tests 80, pass 79, fail 0, skipped 1
  (pre-existing skip, none added).
- Batch 3d: delivery-acceptance, managed-backend-boundary,
  managed-shared-facade, managed-tool-await, filesystem-mutation-fence,
  one-shot-command-routing-static: tests 110, pass 110, fail 0.
- managed-strict-oci: tests 1, pass 1, fail 0.
- Prove-red isolated reruns (each 1 test red, then restored green via
  batch 3a for the runtime file).
- runner tsc 0, root tsc 0, eslint on all changed files 0 problems,
  `git diff --check` clean. Encodings: uniform per file (CRLF:
  build-runtime, native-build-factory, native-deliverable-review,
  native-worker-driver, managed-process, sqlite-project-memory,
  t6b-repair-runtime, delivery-acceptance, native-worker-driver test;
  LF: defect-history, cleanup-ownership src+test, flaky-rerun,
  repair-approach-contracts, repair-budget-contracts); no BOM, no U+FFFD.

### sha256 of all uncommitted files (2a + 2b final state)

The 2a table above is superseded for files this pass also modified
(build-runtime, native-build-factory, t6b-repair-factory); final hashes:

- runner-v2/src/agent-prompts.ts 3a333cadc2bb5a5bf80a79fa315eee422513b8c2a6db6e270692e3cd5d6808ae
- runner-v2/src/architect-tools.ts 52c45c9e86b761003c7ecc6921d79a4a0b3aa52cc5433420e7c4559d51a0db47
- runner-v2/src/build-runtime.ts b99e64fb0aa98fd9b82319449312ea3919c6c10fd0427e8524bfe3a1a31fac8a
- runner-v2/src/cleanup-ownership.ts 8a899aa7e362b0bf9fba3a5710f0ec6cd76214f706aa1d2fe3791da4f979485b
- runner-v2/src/defect-history.ts 169c86a6a6df450de284e9f2e9cfe87c3bb8026572ed0e3afc24fe1957043e60
- runner-v2/src/delivery-acceptance.ts e6e50d8fb7202bf954e891859aa53da87c0e024fc809324f048be93b0bd1f5c1
- runner-v2/src/delivery-execution.ts 6b859f1ebe493b4da9c9952052b6edddfeda8d544ad32826a45871764744cec8
- runner-v2/src/execution-host.ts a2b20879ca6ac892329cc4358b3b03dd8c083209bec293a305f56eb0309353d9
- runner-v2/src/managed-process.ts a6b74fda84798dbbbb52d654eb440fe84d4ef62995ee9180764e23a09413d473
- runner-v2/src/native-build-factory.ts 22e51d4a23eaf3add20a7378c7725013fc0cd0a8ff8ae3ba0de8665501f3db81
- runner-v2/src/native-deliverable-review.ts 2c95012eb0be358a0b74556d801f8c277b77c97b10bf35cf88829be3d77ca0d2
- runner-v2/src/native-worker-driver.ts 20f25160e9b0656438f97865017a6e3b6f37d2fe6798769c0d93e3545d6d30e7
- runner-v2/src/repair-approach-contracts.ts 002e36679ce6b16632d2808b4f2b1e55f3566fc660d13ecc1e2b2019d6ace8b2
- runner-v2/src/repair-budget-contracts.ts f2073e174aa8db5019b08486af8a202fbbfb3f02699fcd7b27510060d9f07f9c
- runner-v2/src/flaky-rerun.ts 098257f90e301384e1e089a83edbc96b707f85a6e8bc99d74d4a75d9bc705da9
- runner-v2/src/final-verification-runtime.ts b91ef850cedf91ede80678a7214b6525e35483d99030336bdcd76d0df9ffca06
- runner-v2/src/native-architect-runtime.ts 4639d0580c3013ef0846b29e77f3509c69291a668412f1afb42c49a4b5a0b94f
- runner-v2/src/role-capabilities.ts 781ea4c2e7d47a80b544dd215a326b24632ff00d06023d1837e5d7df7a6123d8
- runner-v2/src/runner-capability-contract.ts abeafb2477e8be0f1fbc4e6fe9a733ca6f36c37b59fd71f01d20c52a44c8db93
- runner-v2/src/scheduler-store.ts 478f6530b64982f58a77181a72a0630d4600b67da6ca04fd9bd115d0fea4b283
- runner-v2/src/sqlite-project-memory.ts be82efe52b1167ce5e90a61283530231c51368c4dd77ea150f64a8ee2c92cee5
- runner-v2/src/windows-process-semantic-probes.ts 4b0e455cb231008d582e999f3515a00b1fca1f139ca9ad55c39f7accf660f82a
- runner-v2/test/t6b-repair-runtime.test.ts 0fb4f0facf657529dcc3572f8b09649c1cebe6774dbe909dbb4dc0966d85ad2f
- runner-v2/test/t6b-repair-factory.test.ts 081e2070bababd28ef9bbcbe83ff28fbbcb370e82e0c30a6a7493f1661249fbe
- runner-v2/test/t6b-repair-budget.test.ts 255c56858fdbd093c8198f114243c3538065b5d86c0c03550c73efa4b7aaf5d4
- runner-v2/test/t6b-defect-cleanup.test.ts 30a01447f5a783b7d2bb8d42d3901e4567a2963feb0c258b7cf04d95c6a78221
- runner-v2/test/t6b-flaky-rerun.test.ts c32224f3415efe65f3fd0be92cd2b85ec904f01d8ae907d960b867697420691b
- runner-v2/test/cleanup-ownership.test.ts 11326c5943d70510d486744b82015f7171b7385492c4d3c9171bb5648e4e461d
- runner-v2/test/architect-lifecycle-surface.test.ts 6ad5f1d861199f6d584311f46ea0c3d96fd9baf53eac325148d48697e808e840
- runner-v2/test/build-runtime.test.ts 7190ce43d09889962dec8ac4f3499fa3b0fc53f50e47f1320ba7d393dd2557e6
- runner-v2/test/context-assembler.test.ts d1a2f95da9e9c76c52b9e2e60bfb770a2b8cfed93a29af74d89f9c91dd1dd5c5
- runner-v2/test/delivery-acceptance.test.ts 4ff097e5f3bbff2f6a1cd425aeb54494de396bb997f200237e10a5ffae047598
- runner-v2/test/native-worker-driver.test.ts 2052fa5c57bb249fca8da5d74b6573e5d468a6dc2fad68123bd10d6586ac9241
- runner-v2/test/git-bootstrap.test.ts a9374323dd7c4393a647c9522ad43765b8a668a5f61533101f3637e74d4f45e1
- runner-v2/test/role-capabilities.test.ts 642057590987351ce955e4dbbe7ea6ffc952f23d1c3cdfc4b64177e846fa7b16
- runner-v2/test/support/delivery-seed.ts 22bcf96cb7dcb809d715564b0ec69995b8d54952bef9a3415e5d7635a9e4ef4e

Uncommitted, as instructed.

### Not done / limits (repair cycle 2b)

- Verification-boundary cleanup searches stay run-wide (N-6 residual):
  phase boundaries run with worker attempts idle, so the legacy stopRun
  is completeness, not over-coverage, there; a live concurrent worker
  overlapping a verification search is still swept. Scoping those
  triggers needs the review/verifier session plumbed through
  recordCleanupSearch.
- `modelReviewOutcomes` without a run filter still merges runs at read
  time (kept for the 2a test + any legacy caller); production always
  passes the run id.
- The `ReviewOutcomeRecorder` stub in t6b-repair-runtime keeps its own
  inline type (no runId): it typechecks structurally and is unaffected.
- No new tests for N-1/N-2 lineage rendering beyond the existing
  dispatch/resolve runtime coverage; N-7/N-8/N-9 verified by 2a tests,
  untouched.

## Repair cycle 3 (worker)

Scope (binding): the two review-r3 blockers (R3-B1, R3-B2) plus the five
cheap non-blocking items named in the brief (N-1, N-2, N-3, N-5, N-6).
N-4 needs no code (r3: documenting is acceptable; no startup sweep added).
All six round-2 blockers stay fixed: the committed R2 suites below are
green untouched except where the new identity required an update. Nothing
committed, staged, stashed or pushed.

### R3-B1 delivery-boundary issue identity is per task and per failing check

- Finding: `delivery-boundary:<check>` (category alone) shared one
  3-cycle budget across unrelated tasks — after T1, T2, T3 each failed
  once, T4's FIRST boundary failure paused as exhausted. Approach
  lineage leaked across tasks the same way.
- Change: new shared helper `deliveryBoundaryRootCause({taskId,
  checkId, failingIds})`
  (runner-v2/src/repair-budget-contracts.ts) builds
  `delivery-boundary:<taskId>:<checkId>` plus the sorted failing test
  ids (`report.failingTestIds`) when known. Both producers use it and
  nothing else: the kernel dispatch gate
  (runner-v2/src/build-runtime.ts:2419-2428) and the Architect resolve
  tool (runner-v2/src/architect-tools.ts:1357-1359). The
  `repairRootCauseForCategory` delivery-boundary passthrough is
  unchanged, so the longer keys flow through `repairMemberIssues`
  untouched.
- Tests: new runner-v2/test/t6b-repair-boundary.test.ts (inverted from
  r3 PROBE-J3, same real stores/kernel/tools/pump): four tasks fail
  once each and are fixed — all four accepted, every issue
  `delivery-boundary:<task>:<check>` used exactly 1, no category-only
  key remains; plus one task failing repeatedly with a fresh decision
  per round — 3 charges then the 4th pauses on its own
  `delivery-boundary:T1:*` issue. The committed boundary test now pins
  the per-task identity (`delivery-boundary:T1:tests`,
  runner-v2/test/t6b-repair-runtime.test.ts:1277-1334).

### R3-B2 one decision authorizes exactly one dispatch

- Finding: a dispatched approach stayed live (`approach.failed =
  outcome !== "resolved" && outcome !== "dispatched"`), so the r3
  PROBE-LIVE loop dispatched rounds 2 and 3 with a decision recorded
  only in round 1 — no new decision, no repeat, no new evidence.
- Change: the `dispatched` flag is marked on the approach by its
  `repair.cycle_recorded` in the kernel
  (runner-v2/src/scheduler-store.ts:3898-3903) and a consumed approach
  is no longer live (`liveRepairApproach`,
  runner-v2/src/architect-tools.ts:904-908); context/display still show
  it pending (`failed=false`, now with `dispatched=` rendered in
  runner-v2/src/agent-prompts.ts:648). When that dispatched repair's
  next mechanical validation fails, the kernel durably fails the
  approach with a new `repair.approach_failed` event (no charge, no
  absorbed failure evidence — the next decision still cites fresh
  evidence), appended by `markDispatchedApproachesFailed`
  (runner-v2/src/build-runtime.ts:3223, new-policy only). A further
  dispatch needs a NEW decision; a repeat of the same approach still
  needs evidence NEW to its sets (unchanged R2-B3 gates).
- Tests: new "a decision recorded only in round 1 refuses the round-2
  dispatch until a new decision is recorded"
  (runner-v2/test/t6b-repair-runtime.test.ts): round 1 dispatches
  (used 1, `dispatched=true`); round 2 with no new decision is refused
  with `repair_approach_decision_required` (used stays 1, no repair
  tasks); one `repair.approach_failed` marks `r3b2-a1` failed; a new
  decision dispatches exactly once (used 2). The existing "three real
  fixes" test (new decision per round: 3 charges, 4th pauses) is green
  unchanged.

### Non-blocking

- N-1 (runner-v2/src/build-runtime.ts:3280-3297): a review fix round
  with no evidence now charges against the durable delivery review
  record id, or pauses (`approach_failed` with an owner-visible
  detail) when no review record exists either — never silently
  uncharged. No pump-level test: link-less rejection is kernel-invalid
  (submission requires per-criterion links,
  `assertDurableEvidence`), so the branch is defensive-only; the
  existing review-round charging tests cover the path.
- N-2 (runner-v2/src/sqlite-project-memory.ts:190-213): the pre-N4
  `model_review_outcomes` rebuild runs under `BEGIN IMMEDIATE` /
  `COMMIT` with best-effort `ROLLBACK`. Covered by the existing
  migration test in t6b-repair-runtime (green).
- N-3 (runner-v2/src/cleanup-ownership.ts:172-191): the
  already-recorded check compares `retained` — identical records are a
  no-op, a retained record is never downgraded, and only a retained
  upgrade falls through on its own `:retained` idempotency key (the
  reducer merges retained upward). New test in
  runner-v2/test/t6b-defect-cleanup.test.ts (upgrade sticks, downgrade
  refused, no throw).
- N-6 (runner-v2/src/native-build-factory.ts:736-745): the six
  disposable verification roots are creation-recorded (retained) when
  the build is created — the search-time loop is removed (the search
  only reads records now). Same six paths via
  `nativeBuildCleanupRoots`; re-creation stays an idempotent no-op via
  the N-3 check. Covered by the factory tests (retained
  verification-workspace records asserted, junit reports still
  cleaned).
- N-5: the stale 2b wording is corrected inline above (R2-B5
  section): the factory fail-again test asserts used 1 with one
  `dispatched` cycle at dispatch.

### Prove-reds (sha256 before / injected / restored; restored = before)

- PR-R3-B1: `deliveryBoundaryRootCause` forced back to the
  category-only key (`delivery-boundary:<checkId>`).
  repair-budget-contracts.ts
  7ff48bf3e6d880e41d138870401d4beaee0cfb9004932f564380d073523f125b
  / 5e383138b79226695b6ba5138755ce696f0777d1f0b661cfeab47ae1be31a5ba
  / 7ff48bf3e6d880e41d138870401d4beaee0cfb9004932f564380d073523f125b.
  Red: "no false exhaustion pause" fails — `Run paused
  (repair_issue_paused:...) before the condition`, action trail ending
  `delivery_boundary_checked,repair_issue_paused`; T1-T4 never all
  accept.
- PR-R3-B2: pre-fix behavior restored (consumed gate removed from
  `liveRepairApproach` AND the failed-marking hook disabled).
  architect-tools.ts
  efc70e697d1fbf6beeb85a684aee43fc84f6affb847ded9d4a7e2a4da008a69f
  / d503b6e712583a8b2ff90808099a52e23a20f8e7e73c0fdbfc39795cfd645f9c
  / efc70e697d1fbf6beeb85a684aee43fc84f6affb847ded9d4a7e2a4da008a69f;
  build-runtime.ts mutated 564eb8268b7da167de959d32ee707367a023b1d013e0c4b58b456367f9e7c337,
  restored 8f0c42b08c0b944999fd7232db2c2b9b8bd0eec07f9b3b173dc8e9ce8638cd15
  (single-line symmetric removal, zero `PROVE-RED` remnants, green
  re-run). Red: "decision recorded only in round 1" fails with
  `Missing expected rejection` — the round-2 dispatch is allowed with
  no new decision. (Gate-only removal stays green: the failed-marking
  is defense in depth behind the same refusal.)
- Every mutation was restored byte-exact (hash equality for the
  backed-up files; symmetric-inverse removal verified for
  build-runtime) before any green suite ran.

### Validation (NODE_TEST_CONTEXT cleared, repo root, concurrency 1)

- T6b budget/flaky/cleanup-ownership/architect-tools/lifecycle-surface/replay-compatibility/context-assembler:
  tests 35, pass 35, fail 0.
- project-memory + scheduler-store: tests 36, pass 36, fail 0.
- t6b-repair-runtime (incl. new R3-B2 test + per-task boundary
  identity): tests 21, pass 21, fail 0.
- t6b-defect-cleanup + build-runtime (incl. new N-3 test): tests 39,
  pass 39, fail 0.
- delivery-acceptance (T6a): tests 31, pass 31, fail 0.
- t6b-repair-factory (real npm runs): tests 2, pass 2, fail 0.
- t6b-repair-boundary (new R3-B1 file): tests 2, pass 2, fail 0.
- final-verification-repair + final-verification-execution +
  repair-cycles + verifier-contracts + role-capabilities: tests 92,
  pass 92, fail 0.
- request-triage: tests 35, pass 35, fail 0.
- native-worker-driver: tests 12, pass 12, fail 0.
- native-delivery-factory (T6a): tests 17, pass 17, fail 0.
- runner tsc: 0 errors. eslint on all changed files: 0 problems.
  `git diff --check`: clean. Encodings: every touched file uniform
  (CRLF: build-runtime, architect-tools, scheduler-store,
  agent-prompts, sqlite-project-memory, native-build-factory,
  t6b-repair-runtime; LF: repair-budget-contracts, cleanup-ownership,
  t6b-defect-cleanup, t6b-repair-boundary, T6b.md); no BOM, no U+FFFD.

### sha256 of every changed file (repair cycle 3 final state)

- runner-v2/src/agent-prompts.ts bad20d7b48ed0b97697dc08bcca84014db7a6718b30e73204c7017ae2c22ea12
- runner-v2/src/architect-tools.ts efc70e697d1fbf6beeb85a684aee43fc84f6affb847ded9d4a7e2a4da008a69f
- runner-v2/src/build-runtime.ts 8f0c42b08c0b944999fd7232db2c2b9b8bd0eec07f9b3b173dc8e9ce8638cd15
- runner-v2/src/cleanup-ownership.ts 074e79a25498d120826d8fc23ce25afed48f703e18334e176c129777fab9fd4c
- runner-v2/src/native-build-factory.ts 23f954da4e4005ab3fbec33437d853686ff0e9721275c15f70d727b7d8da10fd
- runner-v2/src/repair-budget-contracts.ts 7ff48bf3e6d880e41d138870401d4beaee0cfb9004932f564380d073523f125b
- runner-v2/src/scheduler-store.ts b4611fc22e5ea97c1546fbd2a4619639bdb41b1c28f45ebfef1ff281eae78999
- runner-v2/src/sqlite-project-memory.ts a4a88c08c1283daf22fe08fa5f46dbc853bb763ab904825a03cea0f259f2fa30
- runner-v2/test/t6b-repair-boundary.test.ts 70c0458f148d9950acfec4bfe54bface0975d08048741e3858f5fbbaa83d38a8
- runner-v2/test/t6b-repair-runtime.test.ts 6cfb6e10fda1582f75f4dcab6edcb66686ccea701317562859411d4a1a793305
- runner-v2/test/t6b-defect-cleanup.test.ts 75078b08e9fd4b6891b17057a0aa8261c80ac8534b9e637d8d54604faeecdcca

Uncommitted, as instructed.

### Not done / limits (repair cycle 3)

- N-4 (runner-global temp sites) is unchanged: self-cleaned, no
  durable record, outside the six roots; a crash leftover is neither
  cleaned nor reported (r3: documenting remains acceptable).
- The N-1 no-evidence branch is defensive-only (kernel-invalid via the
  pump); no test constructs it.
- `isPathUnderAnyRoot` still treats a record equal to a root as under
  it (noted in r3 N-3); no production site records a non-retained root
  today, and retained records are never candidates — left as is per the
  brief's fix scope.
- All listed suites green; nothing pending.

## Repair cycle 4 (worker)

Fixed review-r4 B-1 (partial per-member charge + one-shot decisions =
permanent multi-member dispatch deadlock, new in cycle 3) plus NB-1 and
the boundary/verifier `repair.approach_failed` gap. Nothing committed,
staged, stashed or pushed. Line numbers are cycle-4 working-copy lines.

### Change (file:line)

- `runner-v2/src/architect-tools.ts:726` (final-verification loop),
  `:1235` (verifier loop), `:1371-1416` (boundary loop): validate EVERY
  member first (external blocker, budget, live decision, evidence — and
  for the boundary path the resolution itself via a new
  `stale_delivery_boundary_resolution` pre-check at `:1371-1388`
  replicating the `deliveryBoundaryFailureResolved` kernel guards, which
  also fixes NB-1: a resolve after the boundary was already resolved now
  refuses with nothing charged), and only then charge all members. The
  store has no multi-event transaction, so all validations run before any
  append.
- `runner-v2/src/architect-tools.ts:64`: import `boundaryNeedsArchitect`
  for the pre-check.
- `runner-v2/src/architect-tools.ts:963`: the charge key now includes the
  approach id
  (`repair-cycle:<issue>:<dispatchKey>:<approachId>`), so a retry after a
  new decision never collides with an old charge key; an identical retry
  stays idempotent (same key, same payload).
- `runner-v2/src/build-runtime.ts:3255`
  (`markDispatchedApproachesFailedForMembers`; `:3244` keeps the existing
  final-verification call delegating to it): `repair.approach_failed` is
  now also recorded on the boundary path (`:2435-2441`, keyed
  `boundary:<boundaryId>`) and the verifier path (`:1648-1653`, keyed by
  review id) when that repair's next validation fails — no charge, next
  dispatch needs a new decision. Repeats are idempotent on the failure
  key; members with no dispatched live approach are skipped.
- `runner-v2/test/t6b-repair-boundary.test.ts:534`: committed
  PROBE-R4-PARTIAL as `R4-B1` (two failed checks; decision for build only
  -> refused with used 0/0; decide tests -> dispatch succeeds, each used
  1, `T1-fix` created; fresh build decision + retry -> no idempotency
  conflict). Real SQLite stores, real kernel/tools/pump.

### Test

- New `R4-B1` test: red on cycle-3 code (deadlock: `Architect returned
  from delivery_boundary_failed without a typed action`), green after the
  fix (1/1).
- Encoding note: `architect-tools.ts`/`build-runtime.ts` are CRLF in the
  worktree; multi-line edits were made via a temporary LF normalization
  and converted back — final files are uniformly CRLF (0 bare LFs),
  `git diff --check` clean, and the prove-red restore hash below proves
  byte-exactness.

### Prove-red (sha256 before/after, byte-exact restore)

- Baseline (cycle-3) `architect-tools.ts`
  `efc70e697d1fbf6beeb85a684aee43fc84f6affb847ded9d4a7e2a4da008a69f`:
  new test red (deadlock above).
- Post-fix `architect-tools.ts`
  `73dbe31c4e366267585e63db3112ef1458b924a9e2e1d959d535b7e0bc56fe69`:
  test green.
- Mutation (boundary loop only restored to charge-before-validate):
  `65be28d9b84ad57319a1a0201048617876fbbabc67df4476de7fdaae4929774f`
  -> test red (`refused dispatch charges build nothing`: 1 !== 0, the
  partial charge).
- Restored: `73dbe31c…bc56fe69` again (equal to post-fix: byte-exact),
  test green again.

### sha256 of changed files (repair cycle 4 final state)

- `runner-v2/src/architect-tools.ts`: `73dbe31c4e366267585e63db3112ef1458b924a9e2e1d959d535b7e0bc56fe69`
- `runner-v2/src/build-runtime.ts`: `691ce5bd6407aed130290cf600bb3bf86663c214fc58476866454e40b42fb3d1`
- `runner-v2/test/t6b-repair-boundary.test.ts`: `7744e68557883df12c57b5c3950787800cc6513cb29cb0c1cdd858bf0cb7796f`
- All other cycle-3 files unchanged (hashes as in the cycle-3 list).

### Counts (NODE_TEST_CONTEXT cleared, repo root, concurrency 1)

- `t6b-repair-boundary` (incl. new R4-B1): tests 3, pass 3, fail 0.
- `t6b-repair-runtime`: tests 21, pass 21, fail 0.
- `t6b-repair-budget` + `t6b-defect-cleanup` + `t6b-flaky-rerun` +
  `cleanup-ownership`: tests 28, pass 28, fail 0.
- `t6b-repair-factory` (real npm runs): tests 2, pass 2, fail 0.
- `delivery-acceptance` (T6a) + `native-delivery-factory` (T6a):
  tests 48, pass 48, fail 0.
- `architect-tools` + `architect-lifecycle-surface` +
  `replay-compatibility`: tests 10, pass 10, fail 0.
- Importers batch 1 (`build-runtime`, `final-verification-repair`,
  `repair-cycles`, `scheduler-store`): tests 88, pass 88, fail 0.
- Importers batch 2 (`native-architect-runtime`, `verifier-contracts`,
  `final-verification-review`, `final-verification-execution`):
  tests 77, pass 77, fail 0.
- Importers batch 3 (`native-worker-driver`, `role-capabilities`,
  `runner-capability-contract`, `project-memory`): tests 41, pass 40,
  fail 0, skipped 1 (pre-existing skip, same as cycle 1).
- Runner tsc: 0 errors. ESLint on the three changed files: 0 problems.
  `git diff --check`: clean.

Uncommitted, as instructed.


## Owner decision: run repair limit scales with tasks (worker)

Owner decision 2026-09-26 ("Scale with tasks"): the whole-run repair-plan
limit grows with the ready plan instead of a flat 3. New-policy runs without
an explicit cap run with `3 + (tasks in the current ready plan)`; an explicit
`repairPlanLimit` option / project policy wins; legacy runs keep
`DEFAULT_REPAIR_PLAN_LIMIT = 3`. The per-issue 3-cycle budget is unchanged.

Change (all reads derive from durable state, so replay is deterministic; a
later plan revision that adds tasks grows the limit; it never drops below
`used`):
- runner-v2/src/scheduler-store.ts:652 (`RepairCyclesProjection.explicitLimit`)
- runner-v2/src/scheduler-store.ts:949 (`readyPlanTaskCount`), :960
  (`repairPlanLimitScales`), :978 (`effectiveRepairPlanLimit`), :985
  (`repairCyclesExhausted` now reads the effective cap), :1569
  (`consumeRepairCycle` enforces the effective cap)
- runner-v2/src/scheduler-store.ts:3851 (`repair.policy_configured` stores the
  explicit flag), :4148 (`repair_cycle_limit` pause reason carries
  `used/effective` plus the scaling basis; new-policy only, legacy rows keep
  the bare reason for replay-compatibility), :4173 (extension preserves the flag)
- runner-v2/src/build-runtime.ts:464 (`explicitRepairPlanLimit`), :2658
  (policy event carries `explicit`), :3107 (limit-reached event uses the
  effective cap), :3193 (T6b dispatch gate reads the effective cap), :3222
  (run-exhausted pause detail shows `used/effective`)
- runner-v2/src/agent-prompts.ts:645 (`renderRunRepairBudget`: effective run
  limit + usage ride the Architect repair-issues status), :656
  (`repairBudgetStatus`), :866 (`repairBudget` in planning-status JSON)
- runner-v2/test/repair-cycles.test.ts:437 (runtime-configured policy row now
  records `explicitLimit: true`; behavior assertions unchanged)
- runner-v2/test/t6b-repair-scaled-limit.test.ts (new): 7 tests on real SQLite
  stores with the real kernel reducer and the real pump:
  6-task plan scales to 9; 4th unrelated repair plan allowed (distinct
  `final-verification:tests:["t-n"]` root causes, per-issue budgets fresh);
  keeps-failing stops at 9 (`9 of 9` throw); explicit `repairPlanLimit=3`
  stops at 3; legacy flat 3; pause reason shows `used 0 of 0`; first repair
  dispatches end-to-end through record/plan tools (`used` 0→1, cap still 9).

Tests (NODE_TEST_CONTEXT cleared; counts pass/fail):
- t6b-repair-scaled-limit: 7/0 (new)
- t6b-repair-budget + t6b-repair-factory: 12/0
- t6b-repair-runtime: 21/0
- t6b-repair-boundary: 3/0
- t6b-flaky-rerun + t6b-defect-cleanup: 16/0
- repair-cycles: 16/0
- scheduler-store: 31/0
- build-runtime: 28/0
- replay-compatibility: 3/0
- architect-tools + context-assembler: 9/0
- delivery-acceptance: 31/0
- planning-review: 53/0
- control-server: 14/0
- runner tsc: clean; eslint (5 touched files): clean; `git diff --check`: clean

Prove-red: reverted `effectiveRepairPlanLimit` to the flat stored limit →
`allows a 4th unrelated repair plan` goes red (`3 !== 9`,
t6b-repair-scaled-limit.test.ts:331) and the suite exits 1 (4th consume would
throw `Repair plan limit reached: 3 of 3`). Restored byte-exact: sha256 after
restore equals the pre-revert hash.

sha256 (final):
- 2192a30bfdc4da3031cf3ae161d99ec685f0ebb15ad14e5496d1ea7aee17442e  runner-v2/src/scheduler-store.ts
- 56907376c0c5f6269a215626f39934c958c6df8f4e352cc565a8572a03ee76c5  runner-v2/src/build-runtime.ts
- b73f318940d716228ffb47c4e0dfc31064d1976e069e78a7ef3d2af47a726524  runner-v2/src/agent-prompts.ts
- 439ac824ba2e72c16245f08f57ce676a173ea573a3f9d3262e4784dceb647cd5  runner-v2/test/t6b-repair-scaled-limit.test.ts
- 7039f334fed1890aba0f8bac8a860f0d5c7078e6c376c340778f53358efea1ad  runner-v2/test/repair-cycles.test.ts

Notes: modified tracked sources kept CRLF (no LF-only lines introduced);
`repair.policy_configured` rows written before the flag keep working via
inference (stored limit other than 3 counts as explicit); nothing committed,
staged, stashed, pushed, or PR-opened.

## Controller fix after review r5 (2026-09-27)

Review r5 (evidence/T6b-review-r5.md) confirmed repair cycle 4 and found two blockers in the scaled run limit, both from `repairPlanLimitScales` inferring "not explicit" for policy rows without the `explicitLimit` flag (every row written before this change): B-1 replay of a HEAD-era `repair.cycle_limit_reached {used 3, limit 3}` crashed; B-2 an owner extension on such a row shrank the effective limit below `used`. Controller applied exactly the reviewer's minimal fix (validated by the reviewer in scratch): scale only when `explicitLimit === false` (runner-v2/src/scheduler-store.ts `repairPlanLimitScales`); rows without the flag keep their stored flat limit; an extension on a scaling row preserves the flag and grows the limit.
Regression test: runner-v2/test/t6b-repair-scaled-limit-replay.test.ts (adapted from the reviewer's probe; the EXTEND case now uses a valid flat-3 premise — pause at 3/3, extend by 1 → limit 4 > used 3).
Validation (repo root, NODE_TEST_CONTEXT cleared): t6b-repair-scaled-limit-replay + t6b-repair-scaled-limit 10/10; with repair-cycles, replay-compatibility and scheduler-store 59/60 before the EXTEND premise correction (the failing case asserted the pre-fix scaling premise), 10/10 on the two scaled-limit files after; runner tsc 0; eslint 0 errors; git diff --check clean. Prove-red: the reviewer's run of the same probe on the pre-fix code failed OLDROW and EXTEND (review r5 "probe-r5-scaled", 1 pass / 2 fail).
sha256: 687d4c03d51d32948728ad61c8b0517a4e2e69aad18e757acd9cbf93b1eb913f runner-v2/src/scheduler-store.ts; d75954157413d4df1abe0e171d1c114cb4e56f4423e553de81422ec7010fcbd0 runner-v2/test/t6b-repair-scaled-limit-replay.test.ts
