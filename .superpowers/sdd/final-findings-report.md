# Final Whole-Branch Findings Report

## Scope

This follow-up fixes the release-blocking findings from the final whole-branch review on AIBoard `main`. It does not inspect or modify AIPaintball, does not use browser control, and does not push.

## Root causes

1. Verification facts were scoped only by task, wave, action, and broad source. A worker command could pass before a later patch or final file block landed, and the fact had no exact command identity or causal content generation.
2. `phaseSpec.verification` and `requiredEvidence` made a tool-policy plan structurally admissible but were not compiled into approval-time objective obligations. Approval could therefore pass with no fact for those declarations.
3. Both initial and review-created plans were validated as complete graphs and then silently sliced to `BUILD_TASKS_PER_WAVE` before scheduler state was created.
4. `MODEL_CONTEXT_PROFILES` retained three `chatgpt:gpt-5.6*` profiles after those account-runner models were removed from `MODEL_CATALOG`.

## Strict TDD RED evidence

Tests were changed before production code and run to observe the intended failures.

### Causal verification and objective requirements

`npx tsx scripts/test-build-review-evidence.mts` failed on:

- run before a landed patch;
- run before final file output;
- unrelated successful command (`echo ok` versus `npm test`);
- successful verifier with incomplete declared-path coverage;
- phase verification with zero fact;
- required evidence with zero fact;
- a legacy fact without landed generation;
- missing live-engine generation/identity wiring.

A second RED cycle added an explicit accepted-project-verifier input. The test failed because `projectVerifier: "npm test"` with no fact incorrectly permitted approval.

### Full validated task graphs

`npx tsx scripts/test-build-task-scheduling.mts` proved that pure allocation retained nine tasks and remapped a dependency from task nine to task one, then failed because live engine source still sliced both initial and review-created graphs to eight tasks.

### Stale provider context

`npx tsx scripts/test-provider-registry.mts` failed with exactly these stale keys:

- `chatgpt:gpt-5.6`
- `chatgpt:gpt-5.6-pro`
- `chatgpt:gpt-5.6-mini`

## Implemented behavior

### Causally current facts

- `BuildTask.writeGeneration` is an optional, checkpoint-compatible monotonic landed-content generation. Legacy tasks normalize to generation zero.
- Every successful worker patch, append, pre-tool file output, or final file output advances the task generation immediately.
- Worker command/tool facts capture the generation at the instant the action executes, so a later action in the same batch cannot retroactively refresh an earlier verifier.
- `BuildTaskVerificationFact.writeGeneration` and `verifierIdentity` are optional for checkpoint readability. Approval fails closed when either is absent.
- Worker `run` facts preserve the exact command; MCP facts preserve the exact `server.tool` identity; project-verifier facts preserve the accepted exact command.
- Approval requires the current task generation, exact identity, trusted provenance, current wave, successful status, and coverage of every declared source/test output path.
- The accepted project verifier is supplied explicitly to the validator, so a missing fact cannot make the obligation disappear.

### Objective declarations

- One shared objective-requirement compiler is used by plan validation, worker fact production, and approval validation.
- Tool-policy phase verification is compiled into exact approval requirements. Required-evidence prose becomes objective only when it contains a backticked identity or is itself an exact typed tool identity.
- Ordinary semantic RED/GREEN prose remains Architect review context; the engine does not reinterpret it as a command or invent a pass verdict.
- A bare `run` action without a concrete identity from the accepted project verifier, phase verification, or explicitly structured required evidence is a structural contract error returned through the bounded Architect revision gate.
- A fact is produced only by an actual worker tool/command or project-verifier execution. The engine does not create a semantic pass verdict for prose-only declarations; such requirements fail closed until exact objective evidence exists or the Architect revises the contract.
- Arbitrary worker command/MCP actions claim action execution but no file-path coverage. Full declared source/test-path coverage is attached only to an accepted concrete verifier scope: the project verifier or an exact phase command. Typed MCP actions alone cannot satisfy path coverage.
- Runtime-state materialization preserves `writeGeneration`, so plan/review revisions cannot reset the monotonic causal clock.
- The existing exactly-two Architect review-contract revision gate is unchanged.

### Full graph retention

- Initial validated plans now pass all tasks to incremental ID allocation.
- Review-created validated graphs now pass all new tasks to incremental ID allocation.
- `BUILD_TASKS_PER_WAVE` remains the scheduler dispatch-batch limit and review prompt budget; it no longer truncates semantic scheduler state.

### Provider cleanup

- Removed the three stale ChatGPT 5.6 context profiles.
- Added drift coverage alongside the account-runner catalog exclusion.

## Verification

After both remediation/re-review rounds, the complete focused regression sequence was rerun on the final code tree and passed from the beginning:

```powershell
npx tsx scripts/test-build-plan-contract.mts
npx tsx scripts/test-build-plan-revision.mts
npx tsx scripts/test-build-review-evidence.mts
npx tsx scripts/test-build-task-contracts.mts
npx tsx scripts/test-build-task-scheduling.mts
npx tsx scripts/test-parse-action.mts
npx tsx scripts/test-plan-critique.mts
npx tsx scripts/test-build-progress.mts
npx tsx scripts/test-build-checkpoint.mts
npx tsx scripts/test-build-live-checkpoint.mts
npx tsx scripts/test-build-quality-gates.mts
npx tsx scripts/test-provider-registry.mts
npx tsc --noEmit
npm run lint
npm run build
```

All scripts printed PASS and exited zero. TypeScript and ESLint emitted no errors. Next.js compiled, type-checked, and generated 14/14 static pages. The AIBoard development server was restarted after the production build; `http://localhost:3000/` returned HTTP 200.

## Compatibility and remaining concerns

- New checkpoint fields are optional. Legacy facts load but cannot satisfy approval because they lack causal generation/identity.
- Prose-only required-evidence declarations remain Architect context. Phase verification is an explicit verifier declaration and therefore requires an exact matching fact; missing prose-like phase checks fail closed and must be revised by the Architect rather than guessed by the engine.
- Dispatch batching remains capped; only semantic task-state truncation was removed.
- No push, browser control, AIPaintball access, or live paintball acceptance was performed.

## Review and commits

The first independent read-only review found three Critical, two Important, and two Minor issues:

- bare `run` could not match real command identities;
- semantic RED/GREEN prose was compiled as an impossible executable;
- phase/evidence MCP requirements could execute without producing facts;
- plan materialization could reset `writeGeneration`;
- worker actions overstated full path coverage;
- tests used unrealistic `"run"` identities;
- this report overstated the initial implementation.

Each issue received a targeted regression and remediation described above, followed by the first re-review summarized next.

The first re-review found two remaining gaps: exact/backticked `run` could disguise the unresolved action class, and path-owning phase/MCP-only contracts could omit full path coverage. Both now have RED regressions. Standalone/backticked `run` is always rejected and must be replaced by the concrete command identity; full normalized path coverage is an explicit compiled obligation supplied only by the accepted project verifier or exact phase command. Arbitrary typed actions remain zero-coverage.

The final independent re-review for the original blockers found no Critical or Important issues. Its two Minor report corrections were incorporated before commit `3cc13c71`.

A subsequent whole-branch review found two additional Minor issues: verifier-specific approval errors were deduplicated by generic action name, and this review chronology still used stale “pending” wording. The follow-up commit adds exact verifier/source/mismatch details to deterministic issue keys and messages, preserves distinct issues for commands such as `npm test` and `npm run lint`, retains true-duplicate collapse, and corrects this chronology.
