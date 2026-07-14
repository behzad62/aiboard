# Task 4 Report: Runner transcript/files control plane and startup compaction

## Delivered

- Added authenticated `GET /v2/runs/:runId/build/transcript?after=<sequence>` and `GET /v2/runs/:runId/build/files` routes.
- Threaded durable transcript and revision-file projections through `BuildControlPlane`, `NativeBuildManager`, and `NativeBuildRuntimeHandle`.
- Served only the durable assistant text projection produced by `SqliteAgentSessionStore`, retaining stable ids, actor metadata, event sequence, and cursor.
- Served integration files while a Build is in progress and the exact immutable stored project commit after automatic apply. The endpoint never relabels integration content as project content and never follows a later mutable project HEAD.
- Rejected negative, fractional, non-numeric, and repeated transcript cursors with `400 invalid_after`; unknown Build runtimes remain `404 build_runtime_not_found`.
- Added quiescent startup compaction for all non-running persisted Builds. Active Builds are not compacted; completed Builds also receive owned workspace/integration cleanup.
- Added conservative, batch-oriented global artifact reachability:
  - the first compaction pass enqueues superseded checkpoint tombstones without deleting;
  - one schema-aware scan indexes durable SQLite/opaque state and excludes only non-live session cleanup/idempotency tables;
  - reachable artifact payloads are traversed transitively for nested diff/evidence/effect and other artifact hashes;
  - a second compaction pass drains candidates in O(1) per hash from the one prepared index;
  - live cleanup cannot delete physical artifacts because deletion is enabled only inside quiescent startup;
  - corrupt/unreadable/over-limit scans retain all candidates, emit a recoverable cleanup warning, and do not abort startup;
  - WAL/SHM bytes count toward the bound, while orphan companion files are scanned conservatively.
- Settled cleanup now attempts checkpoint compaction, task-worktree cleanup, and integration-worktree cleanup independently and aggregates failures for retry.

## Test-first evidence

Observed RED before implementation:

- transcript/files API assertions returned 404;
- recovery made zero non-running compaction calls;
- artifact reachability module was missing;
- corrupt SQLite scan did not report its failed proof;
- orphan WAL reference was skipped;
- project file projection followed later HEAD instead of the stored applied revision.

GREEN verification:

- Focused Runner tests: 50/50 passed for reachability, control server, native manager, and integration manager.
- Full `npm run test:runner-v2`: 280/280 Runner tests plus all nine client/contract scripts passed.
- `npx tsc -p runner-v2/tsconfig.json --noEmit`: passed.
- `npx tsc --noEmit`: passed.
- Targeted ESLint for every changed source/test file: passed with zero warnings.
- `git diff --check`: passed.

## Safety notes / remaining concerns

- The reachability scan intentionally favors retention. Any incomplete proof, scan error, bound overflow, live execution, or unknown orphan state prevents deletion and leaves durable tombstones for a later startup retry.
- The scan bounds are 250,000 durable files and 2 GiB across durable state plus traversed live artifact payloads. Reaching either bound records a warning and performs no physical deletion.
- Runner-owned `integration/` and `workspaces/` are excluded as non-durable copies; all other state roots are scanned. The content-addressed `artifacts/` tree is not treated as self-rooting, but payloads reachable from durable roots are traversed transitively.
