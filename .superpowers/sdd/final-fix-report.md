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
