# Runner Live Sync, Automatic Apply, and State Compaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Runner V2 the authoritative live source for Build discussion state, automatically commit successful Builds to the bound project, and reclaim redundant settled-run storage.

**Architecture:** Runner adds model-only transcript and revision-backed file projections to its authenticated control plane. The browser always reconciles to the newest project run and hydrates native transcript/files incrementally. Finalization performs a safe project commit, then compacts session checkpoints and removes owned worktrees without deleting durable audit facts.

**Tech Stack:** Node.js 24.18.0, strict TypeScript, `node:sqlite`, Git worktrees, Next.js 15/React 19, PowerShell development commands.

## Global Constraints

- Runner state must remain outside the project.
- Verifiers record mechanical facts and never decide completeness; the Architect remains semantic authority.
- Finish and Budgeted Builds automatically apply after Architect completion; Plan-only remains non-mutating.
- Automatic apply never stashes, resets, discards, or overwrites dirty user state.
- Raw transcript contains only Architect/worker/subagent textual model responses.
- Binary or oversized project files are omitted explicitly.
- Cleanup is idempotent and confined to Runner-owned paths.

---

### Task 1: Durable transcript projection and checkpoint compaction

**Files:**
- Modify: `runner-v2/src/artifact-store.ts`
- Modify: `runner-v2/src/agent-session-store.ts`
- Modify: `runner-v2/src/sqlite-agent-session-store.ts`
- Modify: `runner-v2/test/agent-session-store.test.ts`
- Modify: `runner-v2/test/artifact-store.test.ts`

**Interfaces:**
- Produces `AgentTranscriptPage`, `SqliteAgentSessionStore.transcript(runId, afterSequence)`, and `compactRun(runId)`.
- Produces `ArtifactStore.remove(hash)` for known unreachable checkpoint artifacts.

- [ ] Write failing tests with architect, worker, and subagent checkpoints containing text and tool-call blocks; assert only assistant text is returned, incremental cursor calls return only new turns, and stable ids deduplicate repeated checkpoint content.
- [ ] Run `npx tsx --test runner-v2/test/agent-session-store.test.ts` and verify failures are caused by missing transcript/compaction APIs.
- [ ] Implement transcript extraction from durable checkpoints with stable `${sessionId}:${message.id}` ids, actor metadata, checkpoint-event sequence cursor, and text-block joining.
- [ ] Write a failing compaction test with three checkpoints for one session; assert the latest full transcript remains after reopening while the first two checkpoint artifacts are absent.
- [ ] Implement transactional deletion of superseded checkpoint event rows and idempotent artifact payload/metadata removal.
- [ ] Run focused tests and commit `feat(runner): project durable model transcripts`.

### Task 2: Revision-backed file projection and owned worktree cleanup

**Files:**
- Modify: `runner-v2/src/workspace-manager.ts`
- Modify: `runner-v2/src/integration-manager.ts`
- Modify: `runner-v2/test/workspace-manager.test.ts`
- Modify: `runner-v2/test/integration-manager.test.ts`

**Interfaces:**
- Produces `WorkspaceManager.cleanup()`.
- Produces `IntegrationManager.files(source)` and `IntegrationManager.cleanup()`.
- Extends `ProjectHandoffResult` with `projectRevision?: string`.

- [ ] Write failing workspace tests proving cleanup removes all run-owned task worktrees/branches, runs worktree prune, rejects unexpected ownership, and is idempotent.
- [ ] Implement serialized cleanup using `git worktree remove --force`, verified descriptor paths/branches, task-ref deletion, and bounded directory removal.
- [ ] Write failing integration tests proving tracked UTF-8 files are returned from the integration revision, binary/over-1-MiB/over-budget files are omitted, and cleanup removes the integration worktree without deleting its audit branch.
- [ ] Implement Git-object file reads via `ls-tree`/`cat-file`/`show`, response limits, source/revision metadata, and owned integration-worktree cleanup.
- [ ] Run focused tests and commit `feat(runner): expose revision files and clean worktrees`.

### Task 3: Safe automatic project commit

**Files:**
- Modify: `runner-v2/src/integration-manager.ts`
- Modify: `runner-v2/src/native-build-manager.ts`
- Modify: `runner-v2/src/cli.ts`
- Modify: `runner-v2/test/integration-manager.test.ts`
- Modify: `runner-v2/test/native-build-manager.test.ts`

**Interfaces:**
- `IntegrationManager.applyToProject()` returns both integration and committed project revisions.
- `NativeBuildManager` automatically selects `apply_to_project` for requested Finish/Budgeted completion and invokes settled cleanup.

- [ ] Write failing Git tests proving a clean named project branch receives exactly one AIBoard commit containing the integrated diff, while dirty, detached, and apply-conflict repositories remain byte-for-byte unchanged.
- [ ] Implement clean-state/branch preflight, binary patch check/apply, isolated staging, AIBoard commit identity/trailers, project revision capture, and rollback of only the Runner patch on failure.
- [ ] Write failing manager tests proving requested handoff auto-applies once, completion is idempotent, Plan-only does not auto-apply, apply failure remains paused, and cleanup follows successful settlement.
- [ ] Implement asynchronous automatic finalization in the autonomous pump and lifecycle synchronization through the existing `onPumpResult` callback.
- [ ] Run focused tests and commit `feat(runner): automatically commit completed builds`.

### Task 4: Runner control-plane transcript and files endpoints

**Files:**
- Modify: `runner-v2/src/build-observability.ts`
- Modify: `runner-v2/src/build-runtime-registry.ts`
- Modify: `runner-v2/src/native-build-manager.ts`
- Modify: `runner-v2/src/native-build-factory.ts`
- Modify: `runner-v2/src/control-server.ts`
- Modify: `runner-v2/test/control-server.test.ts`
- Modify: `runner-v2/test/native-build-manager.test.ts`

**Interfaces:**
- Adds `GET /v2/runs/:runId/build/transcript?after=<sequence>`.
- Adds `GET /v2/runs/:runId/build/files`.

- [ ] Write failing authenticated API tests for complete/incremental transcript pages, file snapshots, invalid negative/non-integer cursors, and unknown runs.
- [ ] Thread transcript/files projections through runtime handle, registry, and manager interfaces.
- [ ] Implement authenticated routes with the existing JSON response/error conventions.
- [ ] Add startup compaction for all non-running persisted runs and record cleanup errors without aborting Runner startup.
- [ ] Run focused tests and commit `feat(runner): serve durable build transcript and files`.

### Task 5: Browser newest-run reconciliation and native panels

**Files:**
- Modify: `lib/client/runner-v2.ts`
- Modify: `lib/client/discussion-live-state.ts`
- Modify: `app/discussion/discussion-client.tsx`
- Modify: `components/ArtifactPanel.tsx`
- Modify: `components/BuildTranscriptPanel.tsx`
- Modify: `scripts/test-runner-v2-client.mts`
- Modify: `scripts/test-build-live-state.mts`
- Modify: `scripts/test-build-transcript-panel.mts`
- Create: `scripts/test-native-build-files.mts`
- Modify: `package.json`

**Interfaces:**
- Adds client types/functions `getNativeBuildTranscript` and `getNativeBuildFiles`.
- Changes latest-run resolution to always consider project references.
- Adds native transcript-to-timeline mapping and file revision/source presentation.

- [ ] Write failing client tests where the saved completed run exists but a newer running/paused run must win deterministically; cover empty references and equal timestamps.
- [ ] Implement newest-reference selection by `createdAt` then `runId`, preserving `allowMissing` only for genuinely unprovisioned follow-ups.
- [ ] Change durable reconciliation to run for every Build status, update the saved run id/status/policy/tasks/usage/activity/handoffs, and poll active runs plus one terminal refresh.
- [ ] Write failing transcript mapping tests proving only native model responses appear, incremental pages merge by stable id, and legacy Build messages are replaced after native attachment.
- [ ] Implement transcript polling keyed by cursor and native actor/runtime display names.
- [ ] Write failing file-panel tests proving revision/source labels and refreshed Runner files replace legacy cached native files.
- [ ] Implement file snapshot refresh on run/revision changes and display `Proposed integration` or `Applied project` with abbreviated revision and omitted count.
- [ ] Run all client scripts, lint, and commit `fix(build): reconcile UI from latest runner state`.

### Task 6: Migration cleanup, end-to-end verification, and delivery

**Files:**
- Modify as required by verification findings only.

**Interfaces:**
- Consumes all prior tasks; produces the deployed Runner/UI behavior.

- [ ] Run `npm run test:runner-v2` and require all Runner/client contract tests to pass.
- [ ] Run `npm run lint` and `npm run build`; stop/restart the dev server afterward because concurrent builds can corrupt `.next`.
- [ ] Merge the feature branch into `main`, push `main`, restart Runner V2 from the new main checkout, and verify `/health` reports Node 24.18.0.
- [ ] Measure `C:\Users\b_a_s\source\runner-state` before/after startup migration and confirm obsolete checkpoints and settled worktrees are reclaimed without losing the latest run transcript/evidence.
- [ ] Refresh `http://localhost:3000/discussion?id=c26f473d-cc2d-4687-8dc4-a30530ece947` and verify it attaches the newest run, shows current model-only transcript/files, and no longer presents an unnecessary successful handoff prompt.

