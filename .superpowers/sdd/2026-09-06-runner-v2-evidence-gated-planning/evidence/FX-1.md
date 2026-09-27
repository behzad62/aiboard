# FX-1 — build-risk re-assessment after guidance (NF-6)

Base: `6e8c7ef4` (`codex/runner-v2-p6-6`). Lane A implementation worker.
No commits, stages, stashes, pushes, or PRs; all changes uncommitted.

## Defect and root cause

Pre-existing livelock (C2b review r3, NF-6, probe RA): after a finish run
reaches the handoff, user guidance with `no_plan_change` invalidates the
build-risk assessment without moving the integration revision, and the green
final-verification re-run lands on the SAME revision. The runtime then calls
`assessRisk` every step, but the assessment was keyed
`build-risk:${targetRevision}` (`runner-v2/src/build-runtime.ts`, old :1724),
so the store deduped the identical key + payload + actor into the one old
event and nothing new was ever recorded, while the guidance invalidation
(`runner-v2/src/scheduler-store.ts:9828-9840`, risk moved to history with
`state: "invalidated"`, `invalidatedByGuidanceId`) kept the assessment "not
current". Result: 20 `assessRisk` calls in 20 steps, one risk event, the
Architect never re-invoked, `runUntilBlocked` returns
`step_allowance_yielded`. Affects every finish run with the independent
verifier, legacy runs included. Store dedupe:
`runner-v2/src/sqlite-scheduler-store.ts:108-129`.

## Fix

`runner-v2/src/build-runtime.ts:1733` — key the assessment by what makes it
current, the target revision plus the final-verification generation it
qualifies:

```ts
idempotencyKey: `build-risk:${targetRevision}:${finalVerification.generationId}`,
```

Why this key: after guidance the FV current is gone, so a re-assessment
requires a freshly planned green generation, and generation ids advance on
every re-run (`final-verification-generation-<rev>-<n>` in production via
`architect-tools.ts:1852-1864`; history only grows, so the key is durable
log state — no timestamps, no restart-resetting counters). Replays of the
same step carry the same revision + generation, so they still dedupe to one
event; restarts record nothing new because the current assessment is valid.

Replay compatibility: the reducer (`recordBuildRiskAssessment`,
`scheduler-store.ts:5458-5530`) never inspects the idempotency key, so old
`build-risk:<revision>` events replay unchanged; no event type or reducer
branch was added, removed, or altered.

C2b tests: `runner-v2/test/docs-policy-v2-handoff.test.ts` G2-prod and G3
no longer seed the fresh-key workaround (`risk:rerun-low` removed). Both now
run a production-shaped independent verifier (the real
`deriveNativeVerifierRiskInput`) in the harness runtime and reach completion
through the runtime's own re-assessment, asserted by key
(`build-risk:<rev>:generation-c2a-finish-rerun`) and bounded assessRisk
counts. The stop-1 `risk:baseline-low` seed remains (pre-existing pattern,
out of scope). The low-risk seed comment was corrected (was NF-7).

## Other revision-scoped keys checked

Guidance invalidates exactly three projections (`invalidateFinalVerificationForGuidance`,
`scheduler-store.ts:9810-9854`): final-verification current, buildRisk
current, verifier current review. Every other idempotency key was audited:

- `final-verification-plan:<rev><suffix>` (`architect-tools.ts:1861`):
  SAFE — suffix derives from history length, fresh per generation (the
  pattern the fix mirrors).
- All `${generationId}:...` keys (FV checks, submission, cleanup,
  review-request, `final-verification-review:`, repairs, flaky reruns):
  SAFE — fresh per FV generation.
- `verifier:review/expectations/verdict:<reviewId>`: SAFE — review ids are
  generation-scoped in production.
- `verifier-selection:<targetRevision>:<reason>` (`build-runtime.ts:1853`):
  SAFE — verifier selection is not invalidated by guidance; a same-key
  re-append returns the existing user-selection pause (idempotent pause,
  not a spin).
- `plan-critique:*`, `repair-cycle-limit:<rev>:<used>:<ext>`,
  `integration:`, `retry:`, `phase-acceptance:`, `delivery-*`,
  planning/coverage/answer keys: SAFE — plan critique, repair cycles,
  integration, delivery, and planning state are not invalidated by guidance.
- Fixed key `project-handoff-requested` (`architect-tools.ts:2399`,
  complete_run tool): NOT SAFE in the same class but NOT FIXED here —
  `architect-tools.ts` is outside this packet's writable set. A second
  complete_run after a withdrawal either dedupes to the stale stop-1 event
  (same summary + actor: success with no new event) or throws an
  idempotency conflict (different summary), so production cannot re-request
  the handoff through the tool today (store-level probe `/tmp/fx1-probe.ts`,
  uncommitted scratch: same key + payload dedupes to the same eventId with
  no new row; different payload throws `Scheduler idempotency conflict`).
  The regression tests and the updated
  C2b tests simulate the Architect re-request with a fresh-key
  `project.handoff_requested` seed (as G2-prod always did). Recommend a
  follow-up packet (e.g. key by user-guidance version). No other
  revision-only key for guidance-invalidated state was found.

## Changed files (sha256)

- `runner-v2/src/build-runtime.ts`
  `81ae3dc1aa25fc5b6692e400e6761680ee1b97749685a60e01e5e10bd83c744a`
- `runner-v2/test/build-risk-reassessment.test.ts` (new)
  `4cf15b6851a6602a504338221caaa75407cd267368a5339e7f1277f47da2a30f`
- `runner-v2/test/docs-policy-v2-handoff.test.ts`
  `d8b29fbea622a0d34662945d8c189dd7b642180d3888d4fdcd618649fcb55e7c`

Encodings: LF-only, no BOM, no mixed endings in all three files
(`git diff --check` clean). No timestamps, no child_process, real SQLite
with an advancing clock in the new tests.

## Suites (NODE_TEST_CONTEXT cleared, --test-concurrency=1)

- build-risk-reassessment (new): 4 pass — v1 finish RA regression,
  docs-v2 finish RA regression (factory port), restart replay, old-key
  replay.
- docs-policy-v2-handoff: 44 pass, 0 fail (full file, incl. updated
  G2-prod + G3 through the real re-assessment).
- build-runtime: 28 pass. scheduler-store + verifier-contracts: 72 pass.
  native-build-manager: 58 pass.
- replay-compatibility, git/lsp/mcp-caller-audit,
  one-shot-command-routing-static, static-adapter-policy: 42 pass, 0 fail.
- runner tsc (`tsc -p runner-v2/tsconfig.json --noEmit`): exit 0.
- eslint on the three changed files: exit 0. `git diff --check`: clean.
- native-delivery-factory: 17 pass, 0 fail (full file, on the final
  bytes).

## Prove-red

- Fixed bytes sha256 (build-runtime.ts): `81ae3dc1…c744a` (above).
- Reverted the single key line to `build-risk:${targetRevision}`
  (sha256 `1307829855ac8563db4e0aeb5a8f599c3b1335c04b67cacb53741663c6cef154`).
- `FX-1 v1 finish` regression: RED (0 pass / 1 fail — stop-1 key assertion
  shows the revision-only key; the re-assessment never records).
- Restored the fix: sha256 back to `81ae3dc1…c744a` (byte-exact restore,
  hashes match); v1/restart/old-key tests green again.

## Not done / limits

- `complete_run`'s fixed `project-handoff-requested` key (architect-tools,
  out of scope) means production still cannot re-request a withdrawn
  handoff through the tool; tests seed the re-request with a fresh key.
- The C2b stop-1 `risk:baseline-low` seed remains hand-seeded (pre-existing,
  non-production key); only the post-guidance assessment is production-real.
- The docs-v2 regression and G2-prod/G3 each take ~100s (factory setup);
  the new v1/restart/old-key tests take ~1s each.

## Acceptance (controller)

Review r1 (`FX-1-review-r1.md`): **ACCEPT, 0 blocking.** The reviewer ran seven importer suites the worker had not run (N2): 100/100 pass. Follow-ups: N1 (`verifier-selection:<rev>:<reason>` dedupes a repeated reason after an owner selection; pre-existing) and CR-1 (`complete_run`'s fixed key `project-handoff-requested`: a run whose handoff guidance withdrew can never complete; confirmed HIGH on v1 and docs v2, pre-existing) go to packet FX-2. N3 (tests reach completion through a seeded re-request) is closed by FX-2; N4 (one wrong line reference) noted.
