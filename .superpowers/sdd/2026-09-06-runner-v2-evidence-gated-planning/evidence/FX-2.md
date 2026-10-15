# FX-2 — repeatable handoff request and verifier re-selection (CR-1, N1)

Base: `2658c8b5` (`codex/runner-v2-p6-6`). Lane A implementation worker.
No commits, stages, stashes, pushes, or PRs; all changes uncommitted.

## Defects and root causes

CR-1 (HIGH, pre-existing, confirmed by the FX-1 review): `completeRunTool`
(`runner-v2/src/architect-tools.ts`, old :2399) appended
`project.handoff_requested` with the FIXED idempotency key
`project-handoff-requested`. Guidance withdraws a requested handoff into
`projectHandoffHistory` (`runner-v2/src/scheduler-store.ts:4515-4530`) and the
reducer accepts a second request after a withdrawal (`:5058`, guarded only on
`current.projectHandoff`), but the store dedupes before the reducer runs
(`runner-v2/src/sqlite-scheduler-store.ts:108-129`). A repeated
`complete_run` after a withdrawal therefore either deduped to the stale stop-1
event (same summary + actor: success with no new event, `projectHandoff`
stays empty) or threw `Scheduler idempotency conflict for
project-handoff-requested` (different summary); either way the runtime threw
`Architect returned from completion_decision_required without a typed action.`
(`runner-v2/src/build-runtime.ts:1406-1410`), each resume cost an Architect
turn and paused again with `autonomous_pump_error`, and the owner's selection
was refused. A run whose handoff was withdrawn could never complete (v1 and
docs v2).

N1 (pre-existing, confirmed by the FX-1 review): the verifier-selection pause
(`runner-v2/src/build-runtime.ts`, old :1862) was keyed
`verifier-selection:${targetRevision}:${reason}`. After the owner selected a
verifier, the same reason at the same revision deduped the append: `step()`
returned `paused/verifier_selection_required` while the projection stayed
`running` with selection `selected`, and under the manager the run sat
`running` with no prompt. The plan-critique selection pause (old :3697,
`verifier-selection:plan-critique:${planRevision}:${reason}`) is the same
class: an owner selection followed by another unavailability dedupes.

## Fixes

CR-1 — `runner-v2/src/architect-tools.ts:2394-2409`: the request is keyed by
the withdrawals it follows, `projectHandoffHistory.length` (durable,
history-only-grows, stable on replay):

```ts
const handoffRequests = projection.projectHandoffHistory?.length ?? 0;
const handoffRequestKey = handoffRequests === 0
  ? "project-handoff-requested"
  : `project-handoff-requested:${handoffRequests}`;
```

The first request keeps the old key shape, so old logs replay unchanged; a
repeated `complete_run` after a withdrawal appends a new request, while a
replay of the same step (same history) still dedupes. The reducer never
inspects the key. C2a/C2b behavior built on the request is untouched:
`requestedSequence` is still the event sequence, the v2 snapshot gate still
binds to the latest request (`handoffSnapshotAtCurrentStop`), and
withdrawn-stop history records still reconcile as history (proven by the
docs-v2 regression: 2 snapshots, second `parent` = first `commit`).

N1 — `runner-v2/src/build-runtime.ts:1854-1874` (final-verification path),
`:3713-3728` (plan-critique path), helper `:1890-1896`: a new selection
requirement is keyed by the owner selection it follows, the recorded
`verifier.selection_selected` count (durable log state, stable on replay):

```ts
const verifierSelectionKey = verifierSelections === 0
  ? `verifier-selection:${targetRevision}:${reason}`
  : `verifier-selection:${targetRevision}:${reason}:sel-${verifierSelections}`;
```

Zero selections keeps the old key shape, so old logs and in-flight
unselected requirements replay unchanged; after an owner selection the same
reason records a NEW requirement and the owner is prompted again. Replays of
the same step (same count) still dedupe; restarts record nothing new. The
reducer never inspects the key. No `scheduler-store.ts` change was needed
(the reducer already accepts re-requests and re-requirements); no
`native-build-manager.ts` change was needed (a recorded requirement surfaces
the prompt through the unchanged paused/required projection).

## Other fixed or revision-only idempotency keys checked

Guidance (`no_plan_change`) invalidates exactly FV current, buildRisk
current, and verifier current review; withdrawals move the handoff to
history. Every other key was audited against a repeat (second guidance,
second owner action at the same revision):

- `final-verification-plan:<rev><suffix>` (`architect-tools.ts:1861`):
  SAFE — suffix derives from history length, fresh per generation.
- All `${generationId}:...` keys (FV checks, submission, cleanup,
  review-request, `final-verification-review:`, repairs, flaky reruns):
  SAFE — fresh per FV generation.
- `verifier:review/expectations/verdict:<reviewId>`: SAFE — review ids are
  generation-scoped in production.
- `plan-critique:skip:<rev>:<reason>`, `plan-critique:risk:<rev>`,
  `plan-critique:resolve:<critiqueId>`, `plan-critique:request/submit`:
  SAFE — plan-critique state is not invalidated by guidance.
- `repair-cycle-limit:<rev>:<used>:<ext>`: SAFE — counter-scoped.
  `repair-issue:<issueId>`, `repair-blocker:<issueId>`: SAFE — single
  record per issue; a same-key retry is the idempotent case.
  `repair-approach:…:<repeat|new>:…`, `repair-cycle:…`: SAFE — scoped by
  approach/attempt/evidence.
- `acceptance-contract-upgrade:<rev>`: SAFE — per-revision one-shot;
  guidance does not reset the contract status (a plan change advances the
  plan revision instead).
- `plan:<rev>`, `task-revision:<rev>:<task>`, `plan-reconciliation:<rev>:<hash>`,
  `delivery-acceptance/boundary`, `phase-acceptance:`, `delivery-review:`,
  `coverage-*:…:<occurrence>`, `answer-*:…`, `request-triaged/answered/converted:<lastSequence>`:
  SAFE — revision/occurrence/sequence-scoped.
- `integration:<changeSetId>:<status>`, `retry:<id>:<attempt>`: SAFE —
  change-set/attempt-scoped.
- `handoff-snapshot:<stopSequence>`,
  `handoff-snapshot-failed:<stop>:<lastSequence>`: SAFE — a re-request is a
  new stop with a new sequence.
- `run-initialized`, `run-policy-configured`, `verifier-policy-configured`,
  `repair-policy`, `plan-critique-policy`, `project-docs-policy`,
  `acceptance-contract-upgrade-required`: SAFE — run-scoped one-shots; the
  reducer refuses reconfiguration through its own branches.
- `context-recording-*:…:<sequence>`, `architect-pause:<lastSequence>`,
  `architect-handoff:<length+1>`, `architect-question:<version>:<id>`,
  `user-guidance-ack:<id>:<version>`, `guidance-*:…`, `coverage-paused`,
  `answer-paused`, `delivery-paused`, `repair-issue-paused`,
  `worker-pause`, `assignment-claim-error`, `t4-claim/release`,
  `budget:*`, `worker-runtime:*:*:*`, `provider-health:*`: SAFE —
  sequence/version/attempt/reservation-scoped, or caller-supplied.
- No source or test file parses the `project-handoff-requested` or
  `verifier-selection:` prefixes (grep of `runner-v2/src` and
  `runner-v2/test`); only the new regression asserts the new shapes.
- Fixed: the two `verifier-selection` sites and the one `complete_run`
  site above. No other fixed or revision-only key sits on a path that
  guidance or an owner action can repeat.

## Changed files (sha256)

- `runner-v2/src/architect-tools.ts` (CRLF preserved, as in HEAD)
  `90db7f438ad12aeaab17237034c700a2c496a50f9246faf41681990816b3c163`
- `runner-v2/src/build-runtime.ts`
  `121c886210fa712510281b14c3fcdb2cd7292ea0c7a0f6d29afc8d84ff3300aa`
- `runner-v2/test/handoff-rerequest.test.ts` (new, 6 tests)
  `683921bc321fb839efa4df8d9bcb9af1c94c55d6bd05ce649360ef913ac297bc`
- `runner-v2/test/build-risk-reassessment.test.ts`
  `049a1fd573e59c26914ef0e939832113a51e6caa3f9fcd482a576a7b8a6bc419`
- `runner-v2/test/docs-policy-v2-handoff.test.ts`
  `d4ef2abd2058e1fb776acd59cdfa1e9692fae77b9e0c70ef27a18831ee5c8c5e`

Encodings: `architect-tools.ts` fully CRLF (as committed in HEAD —
preserved, 0 mixed); all other changed files LF-only; no BOM, no trailing
whitespace, all end in LF; `git diff --check -- runner-v2` clean.

C2b/FX-1 tests: `build-risk-reassessment.test.ts` (two-turn Architect, the
three `handoff-2` seeds removed) and `docs-policy-v2-handoff.test.ts`
G2-prod/G3 (the `handoff-2` seeds removed; `architect.calls()` 1 → 2)
complete through the Architect's real second `complete_run` now. Reducer-level
unit seeds (`C2a M1`, probe F, hand-edit, G2) still seed `handoff-2` directly
and are untouched — they test gate mechanics, not the re-request path.

## Suites (NODE_TEST_CONTEXT cleared, --test-concurrency=1)

- handoff-rerequest (new): 6 pass — CR-1 v1 finish, CR-1 docs-v2 finish
  (factory port), CR-1 restart, CR-1 old-key replay, probe D, N1 probe F.
- build-risk-reassessment: 4 pass, 0 fail (full file, real second
  `complete_run` in v1/docs-v2/restart).
- docs-policy-v2-handoff: 44 pass, 0 fail (full file, incl. G2-prod + G3
  through the real second `complete_run`).
- build-runtime + scheduler-store + verifier-contracts + native-build-manager:
  158 pass, 0 fail.
- Importers of the changed files: architect-tools, request-triage,
  change-risk, planning-tools, user-steering-runtime,
  final-verification-completion, plan-critique-runtime, repair-cycles,
  native-verifier-factory: 136 pass, 0 fail. final-verification-repair +
  guidance-review (the only other architect-tools importers referencing
  `complete_run`): 26 pass, 0 fail. Every test file constructing an
  independent verifier (the only way to reach the changed selection lines)
  is in the green set above: build-risk-reassessment, docs-policy-v2-handoff,
  handoff-rerequest, native-verifier-factory, plan-critique-runtime. The
  remaining importers construct no independent verifier and reference no
  `complete_run` (verified by grep), so the changed lines cannot execute
  there.
- replay-compatibility, git/lsp/mcp-caller-audit,
  one-shot-command-routing-static, static-adapter-policy: 42 pass, 0 fail.
- native-delivery-factory: 17 pass, 0 fail (full file, on the final
  bytes).
- runner tsc (`tsc -p runner-v2/tsconfig.json --noEmit`): exit 0.
- eslint on the five changed files: exit 0. `git diff --check`: clean.

## Prove-red

- Fixed bytes sha256: architect-tools.ts `90db7f43…c163`,
  build-runtime.ts `121c8862…00aa` (above).
- (1) Reverted only the `complete_run` key line to
  `idempotencyKey: "project-handoff-requested"` (sha256
  `afb2dc25ba3d9d63580ef3fd102664ba224da931965cb736da912198c34dda2d`).
  `FX-2 CR-1 v1 finish` regression: RED (0 pass / 1 fail — the production
  symptom: `Architect returned from completion_decision_required without a
  typed action.`; both turns use the same summary, i.e. the stale-dedupe
  path). Restored from backup: sha256 back to `90db7f43…c163`
  (byte-exact restore verified by hash).
- (2) Reverted only the final-verification `verifier-selection` key line to
  `` `verifier-selection:${targetRevision}:${reason}` `` (sha256
  `4b0177f81806c85f26a4810f8a5852f398645600ee424d9b128d95b1ce2ef018`).
  `FX-2 N1 probe F` regression: RED (0 pass / 1 fail — 1 selection
  requirement instead of 2, i.e. the dedupe). Restored from backup:
  sha256 back to `121c8862…00aa` (byte-exact restore verified by hash).

## Not done / limits

- The worktree also holds concurrent controller bookkeeping this worker did
  not make and did not touch: `progress.md` (1 line) and
  `docs/.../2026-09-27-runner-v2-p6-6-architecture-correction.md` (FX-2
  section, 8 lines). The evidence sha256 list covers only the five worker
  files above.
- The `architect-tools.ts` edit was applied byte-precisely (one single-line
  `muse.edit_file` plus a CRLF-preserving script) because the file is
  committed CRLF and the editor matches LF; verified 0 mixed endings.
- The plan-critique `verifier-selection` site shares the new helper and is
  covered by plan-critique-runtime (green); its prove-red is via the shared
  main-path probe F revert only.
- The docs-v2 regressions and G2-prod/G3 each take ~100s (factory setup);
  the new v1/restart/old-key/probe tests take ~1s each.
- C2a M1, C2b probe F / hand-edit / G2 keep their direct `handoff-2` seeds
  (reducer-level gate tests, untouched by design).

## Repair cycle 1 (review FX-2-review-r1.md: B1 blocking, M1, M2, N1-N3)

Base still `2658c8b5`. No commits, stages, stashes, pushes, or PRs; all
changes uncommitted. Writable set respected: source change only in
`runner-v2/src/build-runtime.ts` (selection key scoping); no UI/client
(`app/`, `lib/`, `components/`), prompt, planning-tool, docs-policy, or
package changes. `native-architect-runtime.ts`, `scheduler-store.ts`, and
`native-build-manager.ts` needed no change (reasons below).

### B1 (blocking): owner's re-answer deduped into the first selection

Root cause: the product answers a verifier prompt with one client key per
runtime (`verifier-handoff:<run>:<runtime>`, built at
`app/discussion/discussion-client.tsx:1354` and passed through unchanged by
`lib/client/runner-v2.ts:1725`, `control-server.ts:634-638`, and
`native-build-manager.ts:482-493`). `BuildRuntime.selectVerifierRuntime`
stored the caller's key verbatim, so after FX-2 recorded a new requirement
(`...:sel-1`) the owner's answer with the same runtime deduped into the
first `verifier.selection_selected` event: success reported, projection
unchanged, selection `required`, verify never re-run. One candidate runtime
(a single `verifierRuntimeIds` entry) means a permanently stuck run.

Fix (`runner-v2/src/build-runtime.ts:874-900`, helpers `:901-915`): the
stored key is scoped to the requirement the answer belongs to -- the
recorded `verifier.selection_required` count (durable log state):

```ts
const verifierRequirements = this.recordedVerifierRequirements();
const storedVerifierKey = verifierRequirements <= 1
  ? idempotencyKey
  : `${idempotencyKey}:req-${verifierRequirements}`;
```

The first requirement keeps the bare caller key, so pre-fix logs and
in-flight runs behave as before. Selections never record requirements, so
the count is stable across the answer itself: a replay of the same answer
computes the same stored key and dedupes, a new requirement increments it,
and a restart records nothing new. The reducer never inspects the key
(verified: no source or test parses these prefixes). The same stale-click
trade-off the reviewer named applies: a stale retry of an earlier prompt's
click answers the CURRENT prompt (it recomputes the current count), which is
the only answer the kernel can attribute without a UI change.

Regression (`runner-v2/test/handoff-rerequest.test.ts`, "FX-2 B1 (N1 probe
F)"): through the production `NativeBuildManager` with real SQLite and an
advancing clock -- owner selects with the product key shape
`verifier-handoff:<run>:rev:reviewer` -> verifier unavailable again with the
same reason -> new requirement (`...:sel-1`) -> the owner re-answers with
the SAME key -> a second selection records (`<key>:req-2`) and the run
continues: the third verify submits a satisfied single-pass verdict
(exact criteria, independent model identity, session binding -- the shapes
the reducer enforces), the Architect's real `complete_run` requests the
handoff, the manager auto-applies it, status `completed`
(`apply_to_project`); a replay of the exact second answer dedupes (2
selections, still `selected`). Counters: assess 1, verify 3, Architect 1,
2 requirements / 2 selections at the end.

### M2: Architect-handoff selection, same class

Root cause: same shape -- client key `architect-handoff:<run>:<runtime>`
(`discussion-client.tsx:1330`), stored verbatim by
`BuildRuntime.selectArchitectHandoff`, so a second offer answered with the
same runtime deduped and the run stayed paused.

Fix (`runner-v2/src/build-runtime.ts:842-870`, helper `:912-915`):
identical requirement-count scoping over `architect.handoff_required`
events (`<caller key>:req-<count>`, bare for the first requirement).

`native-architect-runtime.ts` needed no change: its requirement key
`architect-handoff:<log length+1>` (`:569`, written synchronously by
`requireHandoff` at `:550-576` from the two failure sites `:202` and
`:424`) is already unique per requirement -- the log only grows, so the
length at append time strictly increases between requirements, and a replay
of the same step sees the same length and still dedupes. No reducer change
was needed (it already accepts re-selections); no manager change was needed
(the recorded selection surfaces through the unchanged projection).

Regression ("FX-2 M2" in the same file): both selections through the
manager with the product key shape; the two requirements are seeded
runner-authored events (same style as `finishSeed`) because the native
architect router failure path is not under test -- the fixed selection path
is. Second answer records (`<key>:req-2`); replay dedupes.

### M1: test-file header corrected

The header no longer claims every test drives the manager. It now states:
CR-1 v1/restart, probe D, and B1 drive `NativeBuildManager` end to end;
CR-1 docs-v2 does the same through a factory-built docs port; the M2 test
drives both selections through the manager with seeded runner-authored
requirements; the old-key test uses no runtime (closed-log replay through a
reopened store). `BuildRuntime` is constructed only inside the
manager-handle factory and is never stepped or selected directly (verified
by grep: one construction site, the factory).

### N1: EOF blank line removed

`runner-v2/test/handoff-rerequest.test.ts` ended `});\n\n`; now ends
`});\n`. Verified: `git diff --no-index --check NUL <file>` prints no
whitespace errors (exit 1 is the expected NUL-vs-file content difference),
`git diff --check` clean, file LF-only with 0 mixed endings.

### N2: architect-tools.ts line-ending wording corrected

The FX-2 wording "fully CRLF (as committed in HEAD)" was wrong. The HEAD
blob is LF (`git ls-files --eol`: `i/lf w/crlf`); the working copy is CRLF
from the `core.autocrlf=true` checkout, like most src files. Keeping CRLF
in the working tree was and is correct (3188 CRLF, 0 bare LF, 0 lone CR).
Repair-1 touched neither the encoding nor the bytes of that file.

### N3: six complete_run suites noted

The reviewer ran architect-lifecycle-surface, extension-runtime,
native-verifier-runtime, plugin-loader, project-doc-commit, and
planning-review: 112 pass, 1 macOS-only skip. Re-run here on the repair-1
bytes: 113 tests, 112 pass, 0 fail, 1 skipped -- the skip is
`plugin-loader.test.ts:430-432` (`process.platform !== "darwin"`).

### Changed files (sha256, final bytes)

- `runner-v2/src/build-runtime.ts` (LF-only, 0 mixed)
  `ed9ac9e1397ce71da8925638440fc3f6fb5ff569b5cd4cefd9130049c92dccaf`
- `runner-v2/test/handoff-rerequest.test.ts` (new file updated: 7 tests,
  LF-only, 0 mixed, ends `});\n`)
  `ffa29cf8261ba12833fb74f83a155cdc28302010fee55c597f93b997ec62183c`
- `evidence/FX-2.md` (this appendix; N2/N3 corrections above).
- Untouched by repair-1: `architect-tools.ts`, `build-risk-reassessment.test.ts`,
  `docs-policy-v2-handoff.test.ts` (hashes unchanged from the FX-2 section).

### Suites (NODE_TEST_CONTEXT cleared, --test-concurrency=1, final bytes)

- handoff-rerequest: 7 pass, 0 fail (CR-1 v1, CR-1 docs-v2 factory port,
  CR-1 restart, CR-1 old-key replay, probe D, B1, M2).
- build-risk-reassessment + verifier-contracts + plan-critique-runtime +
  runtime-router + handoff-snapshot: 121 pass, 0 fail.
- scheduler-store: 31 pass, 0 fail. build-runtime: 28 pass, 0 fail.
- native-build-manager + native-architect-runtime + native-verifier-factory:
  82 pass, 0 fail. control-server: 14 pass, 0 fail.
- replay-compatibility + git/lsp/mcp-caller-audit +
  one-shot-command-routing-static + static-adapter-policy: 42 pass, 0 fail.
- docs-policy-v2-handoff: 44 pass, 0 fail.
- N3 six-pack (complete_run importers): 113 tests, 112 pass, 0 fail,
  1 skipped (macOS-only plugin alias, see above).
- native-delivery-factory: exit 0 on the final bytes (17 top-level tests,
  0 fail).
- runner tsc (`tsc -p runner-v2/tsconfig.json --noEmit`): exit 0.
- eslint on both changed files: exit 0. `git diff --check`: clean.
  Untracked-file check (`git diff --no-index --check NUL <file>`): no
  whitespace errors.
- Not run: nothing in the brief's validation list was skipped. Suites that
  import `build-runtime.ts` but never record a selection cannot reach the
  changed lines (the change only executes inside the two select methods);
  every suite that references `selectVerifierRuntime`,
  `selectArchitectHandoff`, `selection_required`, or `handoff_required`
  (control-server, handoff-rerequest, handoff-snapshot,
  native-build-manager, plan-critique-runtime, runtime-router,
  scheduler-store, verifier-contracts) is in the green set above.

### Prove-red (sha256 before/after, byte-exact restore)

- Fixed bytes sha256: build-runtime.ts `ed9ac9e1…ccaf` (above).
- B1: reverted only the verifier scoping to
  `const storedVerifierKey = idempotencyKey;` (sha256
  `5bfc434efc3f20db6b8ec297b06b5ba1e4df80767f7e0a8c33804e8c4d17ff79`).
  `FX-2 B1` regression: RED (0 pass / 1 fail --
  `the re-answer records a new selection: 1 !== 2`, i.e. the second answer
  deduped into the first selection, the production symptom). Restored via
  script: sha256 back to `ed9ac9e1…ccaf`, byte-identical to the pre-revert
  backup (verified by comparison).
- M2: reverted only the architect scoping to
  `const storedArchitectKey = idempotencyKey;` (sha256
  `cfd19871473e9a77589373854a86a097c16952cb0448cf4f28070ea02f74eb11`).
  `FX-2 M2` regression: RED (0 pass / 1 fail -- `1 !== 2` at the
  re-answer assertion, same dedupe symptom). Restored the same way:
  sha256 back to `ed9ac9e1…ccaf`, byte-identical.

### Not done / limits

- The plan-critique `verifier-selection` requirement path shares the FX-2
  helper and is covered by plan-critique-runtime (green); the B1 answer
  scoping applies to it automatically since both paths record
  `verifier.selection_required` and answer through `selectVerifierRuntime`.
- No UI/client change: a stale retry of an earlier prompt's click answers
  the current prompt (see B1 trade-off above); per-prompt client keys would
  be a controller/UI decision outside this packet's writable set.
- The worktree still holds concurrent controller bookkeeping this worker
  did not make and did not touch: `progress.md` and
  `docs/.../2026-09-27-runner-v2-p6-6-architecture-correction.md`.

## Acceptance (controller)

Review r2 (`FX-2-review-r2.md`): **ACCEPT, 0 blocking.** B1 and M2 fixed end to end through NativeBuildManager with the product keys; round-1 probes P1-P9 pass 9/9. Follow-up F1 goes to T7b: at the API, a late duplicate answer to an earlier selection prompt can win over the owner's different choice for the new prompt (in the product it needs a parked double-click). The client must name the requirement it answers and the kernel must refuse an answer to a stale requirement; that needs the client change T7b owns.
