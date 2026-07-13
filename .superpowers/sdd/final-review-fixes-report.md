# Final whole-branch review fixes report

Base: `75c2a75b`

Branch: `codex/runner-v2-stats-policy`

Date: 2026-07-13

## Outcome

All nine review sections and the three coverage notes were implemented test-first. The final Runner V2 aggregate suite passes with 203 Runner tests plus every bundled client contract. Runner and root TypeScript checks, touched-file ESLint, and `git diff --check` are clean.

## 1. Plan-only mechanical capability boundary

- Threaded the durable run policy from the build spec/factory into `NativeArchitectRuntime`.
- Added `PlanOnlyInspectionRuntime`, which exposes only explicitly read-only, non-workspace inspection definitions and enforces the same allowlist again at invocation.
- Audited browser metadata: navigation/open/snapshot/screenshot/events are read-only; click/fill/close are mutating.
- Audited MCP metadata conservatively: a tool is read-only only when `readOnlyHint === true` and `destructiveHint === false`; anything else is treated as destructive.
- Preserved Architect lifecycle tools outside the optional inspection-tool layer.

RED:

```text
npx -y node@24.18.0 node_modules/tsx/dist/cli.mjs --test runner-v2/test/native-architect-runtime.test.ts runner-v2/test/browser-tools.test.ts runner-v2/test/mcp-tools.test.ts
```

The adversarial test failed because the Plan-only wrapper did not exist and mutating browser/MCP definitions remained callable.

GREEN: the focused suite passed 9/9. The test proves mutating definitions are absent, forged hidden calls return `plan_only_tool_denied`, and neither mutating backend executes even under Full access.

## 2. Reject unenforceable USD-only Budgeted runs

- Added shared pure validation in `runner-v2/src/budget-enforceability.ts`, re-exported for the browser.
- Dashboard setup now blocks USD-only Budgeted starts when any selected runtime is account-backed or lacks normal input/output pricing and tells the user to add a time limit or select priced APIs.
- Runner factory repeats validation after loading/selecting provider configs, before model calls.
- Explicit zero rates remain known pricing.
- `providerCostEstimator()` now returns no estimator for account/unpriced transports instead of manufacturing a zero-priced estimate; a separate explicit cost-basis snapshot remains truthful.

RED:

```text
npx -y node@24.18.0 node_modules/tsx/dist/cli.mjs scripts/test-native-build-policy.mts
npx -y node@24.18.0 node_modules/tsx/dist/cli.mjs --test runner-v2/test/provider-transport.test.ts
```

The helper export and Runner provisioning rejection were missing.

GREEN: browser policy contract passed; provider transport/factory contract passed 13/13. Coverage includes account, unknown API, mixed, fully priced zero-rate API, time-only, and USD+time cases.

## 3. Legacy spec migration and durable policy

- Genuine pre-policy specs migrate durably to `finish` with `budgetLimits: {}`.
- `SqliteBuildSpecStore` performs an explicit transactional migration on open; scheduler/event rows are untouched.
- Strict validation remains in place for newly supplied specs.
- Runner policy is present in the safe client projection, synchronized into the live discussion record on every poll, and used with a compatibility fallback only for older runners.

RED: the reopened legacy fixture retained Budgeted/hidden ceilings and the browser lacked the durable Runner policy mapping.

GREEN:

```text
npx -y node@24.18.0 node_modules/tsx/dist/cli.mjs --test runner-v2/test/build-spec-store.test.ts
npx -y node@24.18.0 node_modules/tsx/dist/cli.mjs scripts/test-build-live-state.mts
```

Build spec store passed 3/3; live state passed. The test inspects raw persisted JSON after reopen and verifies `finish` plus an empty limits object.

## 4. Bounded automatic pump yields

- `runUntilBlocked()` now returns progressed/`step_allowance_yielded` after its bounded allowance instead of appending a `build_step_budget` pause.
- `NativeBuildManager` yields to the event loop and continues pumping while the durable projection remains running.
- Durable user/provider/guidance/budget/handoff pauses are unchanged.

RED: the >100-step runtime durably paused and the manager did not schedule the next bounded invocation.

GREEN:

```text
npx -y node@24.18.0 node_modules/tsx/dist/cli.mjs --test runner-v2/test/build-runtime.test.ts runner-v2/test/native-build-manager.test.ts
```

The focused suite passed 20/20, including automatic continuation with no Resume and no `build_step_budget` event.

## 5. Current Budgeted window versus lifetime usage

- Resume renews a budget window only for Budgeted runs; Finish and Plan-only do not create artificial windows.
- The safe client contract retains separate `effective`, `lifetime`, and `window` data.
- Budget progress reads current-window effective cost/active time; model rows are explicitly labeled as lifetime usage.

RED: Resume renewed every policy and the stats card compared lifetime row cost with a renewed window limit.

GREEN:

```text
npx -y node@24.18.0 node_modules/tsx/dist/cli.mjs --test runner-v2/test/build-runtime.test.ts runner-v2/test/budget-ledger.test.ts
npx -y node@24.18.0 node_modules/tsx/dist/cli.mjs scripts/test-build-run-stats.mts
```

Coverage proves a Budgeted renewal resets displayed progress while lifetime model totals remain, and Finish/Plan-only Resume does not renew.

## 6. Suppress legacy preview for any attributed reservation

- Runner usage now exposes `attributedModelReservationCount`, counting attributed model reservations in every state, including reserved/orphaned/in-flight.
- Browser mapping suppresses legacy allowance allocation whenever the count is non-zero, even if settled native calls are zero.

RED: an attributed reserved row with conservative aggregate allowance produced legacy preview calls.

GREEN:

```text
npx -y node@24.18.0 node_modules/tsx/dist/cli.mjs scripts/test-native-model-usage.mts
```

The mapping contract passed and the attributed reserved fixture retained zero native calls.

## 7. Immutable settlement cost projection

- New model reservations and settlements persist an immutable cost basis: full API rate snapshot, account-not-metered, or unknown.
- Architect, worker, and subagent budget wrappers receive the selected runtime's snapshot.
- Model projection sums each settled `actual.estimatedCostMicros`; it never reprices historical calls from current config and never aggregate-rounds them.
- Store validation rejects a changed snapshot at settlement.
- Legacy calls lacking a snapshot remain readable and project unknown cost.

RED:

```text
npx -y node@24.18.0 node_modules/tsx/dist/cli.mjs --test runner-v2/test/model-usage-projection.test.ts
```

The pricing-change/per-call-rounding fixture returned 198/current-rate recomputation instead of the two one-micro settlements.

GREEN: model usage projection passed 9/9. Reopen/config-change coverage returns exactly 2 micros; legacy snapshot-less data returns unknown.

## 8. Provider-boundary missing-input estimates

- Extended model usage with `inputTokenSource` (`reported` or `estimated`).
- Account, OpenAI Chat/Responses, Anthropic, and Google transports serialize the exact body once, send that string, and estimate missing input from its byte length.
- Account image attachments are included after base64 expansion before estimation.
- Provider values, including explicit zero, remain reported.
- `BudgetedAgentModel` consumes transport-resolved input/provenance and no longer estimates missing input from the pre-adapter request; output fallback still uses actual returned blocks.

RED:

```text
npx -y node@24.18.0 node_modules/tsx/dist/cli.mjs --test runner-v2/test/provider-transport.test.ts
npx -y node@24.18.0 node_modules/tsx/dist/cli.mjs --test runner-v2/test/budgeted-model.test.ts
```

The image response had no input usage, reported values had no source, and a transport-estimated input was incorrectly recorded as reported.

GREEN: provider plus budgeted-model focused suite passed 19/19. The image assertion matches the delivered serialized body, and OpenAI-reported input `0` remains `0`/reported.

## 9. Safe operational metadata

- Added optional provider/model display names through browser config, encrypted Runner config, safe usage projection, client mapping, and UI.
- Added cooldown deadline, failure code, and curated summary mapped only from `ProviderFailureKind`.
- Raw provider `failureMessage` is never forwarded; the projection test explicitly rejects the raw fixture string.
- UI displays the safe summary and UTC retry deadline while older projections remain compatible.

RED: model projection lacked the optional fields and the stats UI omitted operational context.

GREEN:

```text
npx -y node@24.18.0 node_modules/tsx/dist/cli.mjs --test runner-v2/test/model-usage-projection.test.ts
npx -y node@24.18.0 node_modules/tsx/dist/cli.mjs scripts/test-build-run-stats.mts
```

Both contracts pass with sanitized `Rate limited.` copy and no raw `slow down` text.

## Coverage notes

- Provider-reported zero: OpenAI Chat fixture asserts input `0` with `inputTokenSource: reported`.
- Direct attribution: dedicated Architect and worker tests assert role, runtime/provider/model, session, and worker task identity from the exact helpers used to construct budget reservations. Existing subagent durable-ledger coverage remains green.
- Mismatched recovered policy: constructing a Budgeted runtime over a durable Finish scheduler now rejects with `already configured as finish`.

## Final verification

```text
npm run test:runner-v2
```

PASS: 203 Runner tests, then all client contracts:

- runner-v2 client
- native Build policy and policy UI
- native Build cutover and pause gates
- native Build model usage mapping
- Build live discussion state
- Build run stats render contract
- Runner V2 observability panel

```text
npm run typecheck:runner-v2
npx tsc --noEmit
```

PASS: Runner and root TypeScript checks.

```text
$files = git diff --name-only --diff-filter=ACM | Where-Object { $_ -match '\.(ts|tsx|mts)$' }; npx eslint $files
git diff --check
```

PASS: touched-file ESLint and whitespace validation. `npm run build` was intentionally not run, per repository instructions.

## Self-review

- Reviewed the complete diff against all nine brief sections and coverage notes.
- Compatibility fields are optional on the browser/client boundary; legacy reservations/specs are explicitly migrated or conservatively classified.
- No raw provider error text, secrets, credentials, or cost configuration secrets are added to safe projections.
- No product Build path imports benchmark-era or legacy server engines.
- No known unresolved correctness concern remains.
