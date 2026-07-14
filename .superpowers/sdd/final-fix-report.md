# Final fix report

## Scope

Implemented the final review brief for crash-safe automatic project apply and efficient durable Build attachment reconciliation.

## RED evidence

- Added a post-ref/pre-checkout crash-state reproduction using a fresh `IntegrationManager`. Before the fix, retry failed at the ordinary dirty-worktree preflight.
- Added journal mismatch and post-crash user-edit cases. Before the fix, both surfaced only the generic dirty-worktree rejection and had no exact recovery path.
- Changed the live-state contract to require paused reconciliation to stop. Before the fix, `nextNativeBuildPoll` returned `poll` for paused runs.
- Added keyed file-loader contract coverage. Before the fix, no keyed loader existed and the discussion client fetched the full file snapshot on every interval.

## Implementation

### Crash-safe automatic apply

- Writes an atomic per-run apply journal before the branch compare-and-swap.
- Records the run, integration revision, project identity, named ref, expected parent, and target commit.
- Recovers before ordinary clean-state preflight.
- Repairs only the exact state where the named ref is at the journaled target while index and worktree still exactly match the expected parent.
- Recognizes already-complete journaled checkout state, clears the journal, and returns idempotently.
- Rejects detached/different branches, moved refs, mismatched commit ancestry/trailers, malformed identity, untracked files, staged changes, and worktree edits without mutation.
- Keeps the existing CAS and rollback behavior and clears the journal only after verified success or verified rollback.

### Poll and file efficiency

- An initially paused run reconciles once and stops scheduling.
- A running-to-paused transition applies that paused snapshot as the final reconciliation and stops.
- New running observers begin polling normally, so Resume creates a fresh active poller.
- File snapshots are cached by `(runId, source, revision)` and invalidated on any component change.
- Scheduler projections now expose the exact latest integration revision in event order, avoiding ambiguous task-map ordering when concurrent tasks integrate.
- Stale old-run pollers remain cancellation-protected by the existing attachment poller lifecycle.

### Minor cleanup

- Removed surplus blank lines at EOF from the feature design and implementation plan.
- Regenerated the published Runner V2 download during the production build.

## GREEN evidence

- Apply recovery focused tests: 4/4 passed.
- Latest-integration-revision scheduler test: 1/1 passed.
- `npx tsx scripts/test-build-live-state.mts`: passed.
- `npx tsc -p runner-v2/tsconfig.json --noEmit`: passed.
- `npx tsc --noEmit`: passed.
- `npm run test:runner-v2`: full Runner/client contract suite passed after all changes (298/298 tests plus every client contract script).
- `npm run lint`: passed.
- `npm run build`: passed and generated all 14 static pages.
- `git diff --check`: passed.

## Final verification

All required verification completed successfully after the final source change: 298 Runner tests, all client contract scripts, both TypeScript projects, ESLint, production static build, and `git diff --check`.

## Final-review blocker follow-up

### RED evidence

- The real automatic-apply path ignored an injected termination immediately after its successful `update-ref`; the new regression failed with `Missing expected rejection`.
- Recovery considered an ignored `secret.txt` clean because `ls-files --others --exclude-standard` hid it.
- Two manager instances shared patch, index, and journal paths; the concurrent regression observed only one journal and could not retain the winning crash record.
- The discussion attachment effect was recreated by status, policy, provenance, and run-ID updates. The stable-controller contract initially failed because no controller/wake API existed.
- An in-flight discovery response could still complete after an explicit Resume wake and overwrite the newer attachment; RED produced `[run_new, run_old]` instead of only `run_new`.
- A file created after the first checkout preflight was overwritten; the live-race regression failed with `Missing expected rejection`.

### Implementation

- Every automatic-apply transition now owns unique patch, temporary index, and journal paths. A loser clears only its own journal; the branch CAS remains authoritative.
- The journal is durably visible before the real branch CAS. An injected post-CAS termination bypasses rollback to reproduce actual process-death state, and a fresh manager completes the exact journaled checkout.
- Recovery enumerates all untracked files, including ignored files, and refuses any non-exact project state. Checkout collision checks run both before the CAS and immediately before `read-tree`, so ignored target files created in the race window are preserved and the ref is rolled back.
- The native Build UI now owns one attachment controller for each discussion/Runner configuration. Mutable status, policy, requested provenance, and authoritative run ID no longer recreate it.
- A settled controller performs lightweight run discovery without reloading the same snapshot. A new authoritative run loads once; explicit same-run Resume wakes the existing controller. The revision-keyed file loader remains alive for the controller lifetime.
- Controller generations invalidate every pre-wake and pre-cancel async response, so stale discovery or snapshot work cannot apply or schedule another loop.

### Focused GREEN evidence

- `runner-v2/test/integration-manager.test.ts`: 24/24 passed before the final live-race addition; all focused crash, ignored-file, and concurrency regressions passed.
- `scripts/test-build-live-state.mts`: passed.
- Runner V2 and root TypeScript checks: passed after the controller refactor.

### Fresh final verification

- Full Runner unit suite, serialized to avoid unrelated Windows temporary-directory handle races: **302/302 passed**.
- All 11 Runner/client contract scripts passed.
- `npm run build`: passed, generated all 14 static pages, and refreshed `public/aiboard-runner-v2.zip`.
- Runner V2 TypeScript, root TypeScript, ESLint, and `git diff --check`: passed.
- The default concurrent full-suite command was also run twice. Its product assertions passed, but Windows intermittently returned `EPERM` while test cleanup deleted temporary directories (`recovery-smoke` once, then `managed-process` plus `recovery-smoke`). Each affected test passed in isolation, and the complete 302-test serialized run passed without failures.
