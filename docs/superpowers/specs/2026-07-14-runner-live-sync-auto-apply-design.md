# Runner Live Synchronization, Automatic Apply, and State Compaction

## Problem

Build discussion pages currently trust browser-persisted `nativeBuildRunId`, messages, and build files. A newer Runner V2 run created or recovered outside that browser record remains invisible whenever the saved run still exists, and completed discussions skip durable reconciliation entirely. The Raw transcript and Project files panels therefore display legacy browser data instead of Runner-owned state.

Runner completion also stops at a mandatory project-handoff choice even when the integrated result can be safely committed to the current project checkout. Settled runs leave task and integration worktrees on disk. Agent checkpoints store the full session after nearly every turn; superseded checkpoints account for about 1.74 GB of the current 1.79 GB AIPaintball state directory.

## Product Behavior

### Latest run is authoritative

Every Build discussion page load queries Runner V2 for all builds whose `projectId` is the discussion id. The newest build by `createdAt`, with `runId` as a deterministic tie-breaker, is authoritative even when the browser's saved run still exists or is completed. The page persists the corrected `nativeBuildRunId` and hydrates status, policy, tasks, usage, activity, handoff/error state, transcript, and files from that run.

The page continues polling while the run is active and performs a final reconciliation when it pauses, fails, stops, or completes. A transient Runner failure retains the last durable UI snapshot and retries; it never rewrites Runner state from stale browser data.

### Raw transcript is Runner-owned

Runner exposes a durable transcript feed containing only textual assistant responses produced by Architect, worker, and subagent sessions. System prompts, user/context messages, tool calls, and tool results are excluded. Each turn has a stable id, session id, actor, optional runtime id, text, and durable ordering cursor.

The initial request returns the complete retained model-response transcript. Incremental requests return only turns added after the supplied cursor. The browser replaces legacy Build transcript presentation with this feed for native runs and merges incremental turns by stable id.

### Project files are revision-backed

Runner exposes a bounded text-file snapshot for the current Build result. During work and before final settlement it reads the integration revision; after automatic apply it reads the committed project revision. The response identifies the revision, source (`integration` or `project`), applied state, omitted file count, and tracked text files. Binary files, individual files over 1 MiB, and content beyond a 10 MiB response budget are omitted explicitly.

The UI labels the source and abbreviated revision and refreshes only when the revision changes. It never presents browser-cached legacy build files as the authoritative native result.

### Successful Builds apply automatically

When the Architect declares a Finish or Budgeted Build complete, Runner automatically applies the integrated diff to the bound project checkout and creates one project commit on its currently checked-out branch. The project checkout must be a Git repository with a named branch and a clean index/worktree. Runner stages only its applied result, commits with the AIBoard integrator identity, and records both the integration revision and resulting project revision.

If the project is dirty, detached, moved incompatibly, or the patch cannot apply cleanly, Runner leaves the project untouched and pauses with an explicit recoverable final-apply blocker. It does not partially apply, reset, stash, discard, or reinterpret user changes. Plan-only runs retain explicit handoff because they do not implement project changes.

No successful automatic apply requires an Apply/Keep prompt. Legacy runs already waiting at handoff remain selectable and recoverable.

### Settled state is compacted

After a run completes successfully, Runner:

1. Removes all Runner-owned task worktrees for that run and prunes their task branches.
2. Removes the Runner-owned integration worktree while retaining its integration ref for audit/history.
3. Compacts each agent session to its latest checkpoint and deletes superseded checkpoint payloads and metadata.
4. Preserves the latest full checkpoint, model-response transcript, evidence artifacts, submitted change sets, scheduler/run events, usage, provider health, build specification, and integration history.

Startup also compacts non-running historical runs so existing installations reclaim redundant checkpoint storage. Cleanup is idempotent, confined to normalized Runner-owned paths, and records failures without failing an already-applied Build.

## Architecture

- `SqliteAgentSessionStore` owns transcript projection and session checkpoint compaction because it owns checkpoint ordering and references.
- `ArtifactStore` provides idempotent deletion of known superseded checkpoint artifacts.
- `WorkspaceManager` and `IntegrationManager` own cleanup of their respective Git worktrees.
- `NativeBuildRuntimeHandle` exposes transcript, files, automatic finalization, and cleanup through `NativeBuildManager`/`BuildControlPlane`.
- The control server provides authenticated transcript and files endpoints.
- The browser Runner client maps those endpoints into UI-safe types.
- Discussion reconciliation selects the newest project run for every Build status and hydrates Runner-owned panels on load and during progress.

## Error Handling and Safety

- Latest-run discovery returns the saved id only when no project references exist; it never silently picks among different projects.
- Transcript cursors are monotonic session-event sequences; invalid cursors return HTTP 400.
- File paths come only from `git ls-tree`, and file content comes from `git show <revision>:<path>` without shell interpolation.
- Automatic project commit is transactional at the Git level: preflight clean state and `git apply --check` precede mutation; a commit failure restores only the Runner-applied patch and leaves pre-existing state unchanged (which was verified clean).
- Cleanup never follows arbitrary paths and only removes worktrees whose Git root and expected branch match Runner descriptors.

## Verification

- Client tests prove a newer run replaces an existing completed saved run and all statuses reconcile.
- Runner tests prove transcript filtering, stable incremental cursors, and recovery after checkpoint compaction.
- Control-server tests cover authenticated transcript/files routes and invalid cursors.
- Git integration tests prove clean automatic apply creates a project commit and dirty/conflicting projects remain untouched.
- Workspace/integration tests prove settled cleanup removes only owned worktrees and is idempotent.
- A compaction test creates multiple large checkpoints, compacts them, verifies the full final transcript remains, and verifies superseded artifact files are deleted.
- UI contract tests prove refresh attaches the newest run and displays Runner transcript/file revisions.
