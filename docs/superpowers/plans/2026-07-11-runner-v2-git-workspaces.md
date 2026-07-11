# Runner V2 Git Workspace and Integration Plan

**Goal:** Make Git the mandatory, non-destructive project authority and give every modification task an isolated workspace with attributable task commits and serialized integration.

**Architecture:** The runner uses argument-array Git processes only. A temporary index captures the exact non-ignored working tree without changing an existing repository's branch, index, or files. Each run owns internal baseline and integration refs plus runner-managed worktrees. Workers commit only inside task worktrees. Integration is serialized through one integration workspace; conflicts become typed mechanical results for the Architect rather than kernel verdicts.

**Runtime:** Node.js 24.18.0 exactly, system Git 2.39.0 or newer, built-in Node test runner.

## Constraints

- Never stash, reset, clean, checkout, or rewrite the user's existing repository workspace.
- Existing dirty staged, unstaged, and non-ignored untracked content is captured in the run baseline without mutating it.
- Existing ignored files and runner default secret/dependency/cache exclusions are not captured.
- A newly initialized repository gets a real initial baseline commit; an existing repository gets internal `refs/aiboard/...` refs only.
- All Git invocations use executable plus argument arrays, bounded output, explicit cwd, and no shell.
- Task workspaces cannot commit to the canonical integration ref directly.
- Integration conflicts are recorded mechanically and left for an Architect-owned resolution task.
- Every operation is idempotent and safe to reconcile after a runner crash.

## Task 1: Safe Git process boundary and repository inspection

**Files:**
- Create `runner-v2/src/git-command.ts`
- Create `runner-v2/src/git-repository.ts`
- Create `runner-v2/test/git-repository.test.ts`

Write failing tests for argument-array execution, output caps, repository/non-repository detection, current HEAD/ref detection, dirty state classification, and paths containing spaces. Implement typed `GitCommand`, `GitCommandError`, and `inspectRepository`. Verify on temporary repositories.

## Task 2: Non-destructive baseline capture

**Files:**
- Create `runner-v2/src/git-baseline.ts`
- Create `runner-v2/test/git-baseline.test.ts`

Write failing tests proving that staged, unstaged, and non-ignored untracked files appear in the baseline commit while the original branch, HEAD, index, status, and file bytes remain unchanged. Use a temporary `GIT_INDEX_FILE`, `read-tree`, `add -A`, `write-tree`, `commit-tree`, and `update-ref`. Add the internal ref `refs/aiboard/runs/<run>/baseline` idempotently. For non-repositories, initialize Git, add safe default exclusions, create the initial baseline commit, and leave a clean repository without requiring global Git identity.

## Task 3: Isolated task workspaces and task commits

**Files:**
- Create `runner-v2/src/workspace-manager.ts`
- Create `runner-v2/test/workspace-manager.test.ts`

Write failing tests for two concurrent task worktrees created from the same immutable baseline, branch/ref name sanitization, path containment, independent edits, task-level commits, unchanged canonical files, and idempotent reopen. Task commit metadata must include run/task identity and use runner-local author environment without changing user Git config.

## Task 4: Typed change sets and serialized integration

**Files:**
- Create `runner-v2/src/change-set.ts`
- Create `runner-v2/src/integration-manager.ts`
- Create `runner-v2/test/integration-manager.test.ts`

Define a change set containing baseline revision, task revision/commits, changed paths, complete diff artifact reference, evidence references, external effects, guidance references, memories, and unresolved concerns. Write tests for ordered cherry-pick integration, idempotent retry, stale-base rebasing, and two conflicting task commits. Successful integration advances only the internal integration ref. Conflict returns paths and operation state, aborts the partial cherry-pick, and does not reinterpret intent.

## Task 5: Overlay fallback and recovery reconciliation

**Files:**
- Create `runner-v2/src/workspace-overlay.ts`
- Create `runner-v2/test/workspace-recovery.test.ts`

Add a runner-managed copy-on-write fallback for worktree-ineligible repositories. Record workspace metadata atomically in the run state directory. On restart, reconcile metadata against Git refs/worktrees, recover valid workspaces, quarantine path/ref mismatches, and never delete unknown user directories.

## Task 6: Durable API integration

**Files:**
- Extend `runner-v2/src/contracts.ts`
- Extend `runner-v2/src/control-server.ts`
- Extend `runner-v2/src/cli.ts`
- Create `runner-v2/test/git-workspace-api.test.ts`

Add mechanical workspace/change-set/integration events and authenticated endpoints. Run creation performs Git bootstrap and stores the immutable baseline revision before any model use. Add a process-restart smoke test that creates two task workspaces, commits changes, kills the runner, resumes, and integrates without duplicate commits.

## Completion gate

Run all Runner V2 tests under Node.js 24.18.0, both TypeScript checks, ESLint, and `git diff --check`. The phase is complete only when an existing dirty repository is byte/status/index-identical after baseline capture, two workers edit concurrently without cross-contamination, integration is deterministic, and crash recovery creates no duplicate refs or commits.
