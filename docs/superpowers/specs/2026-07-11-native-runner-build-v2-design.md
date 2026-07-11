# Native Runner Build V2 Design

## Status

Approved direction. This design replaces the browser-owned Build engine with a mandatory local runner. The AIBoard web application remains a disposable control and observability client.

## Objective

Build V2 must provide a Claude Code/Codex-class coding-agent runtime: persistent tool-using agents, strong repository and shell access, skills, project memory, multi-agent delegation, isolated workspaces, durable recovery, clear semantic authority, and efficient model usage.

The primary implementation is AIBoard's provider-neutral native agent kernel. A later pluggable runtime may delegate compatible tasks to installed coding agents such as Claude Code or Codex through the same task, evidence, permission, and event contracts.

## Core principles

1. The runner, never a browser tab, owns execution and durable state.
2. The Architect owns intent and semantic judgment.
3. The kernel enforces mechanics and permissions, not meaning.
4. Evidence collectors report immutable observations; they do not issue verdicts.
5. Workers have broad freedom inside isolated, accountable task workspaces.
6. Git is mandatory and provides project history, isolation, integration, and rollback.
7. Every important action is an append-only event with provenance and idempotency.
8. Context is assembled from relevant state, skills, memories, and artifacts rather than replaying a giant transcript.
9. Provider, process, UI, or runner failure must not lose completed work or replay external effects.
10. Hard budget limits always pause for a user decision.

## Non-goals

- No browser-owned or browser-only Build execution.
- No mutable checkpoint blob as an authority.
- No kernel heuristic that decides task quality or project completion.
- No keyword-based skill or evidence verdicts.
- No global cross-project memory.
- No bundled Git runtime; the runner requires compatible system Git.
- No automatic Architect replacement.
- No rigid predeclared file whitelist for workers.
- No JSON tool protocol embedded in model prose.

## System architecture

```text
AIBoard web UI
    | authenticated localhost API + event stream
    v
Runner control plane
    |-- run supervisor
    |-- persistent Architect session
    |-- scheduler and resource manager
    |-- native agent kernel
    |-- tool and permission broker
    |-- Git workspace/integration manager
    |-- skills registry
    |-- project memory service
    |-- provider gateway
    |-- evidence/artifact service
    `-- event store and projections
            |
            v
Canonical Git repository + isolated task workspaces
```

The runner exposes a versioned localhost HTTP/WebSocket API authenticated with a runner token. The UI may connect, disconnect, refresh, or be replaced without changing execution. A second UI observes the same runner state rather than becoming another writer.

The native runner targets Node.js **24.18.0** exactly for the initial implementation. Startup rejects older or different major/minor runtime lines until that compatibility policy is deliberately revised and certified.

### Durable stores

- **Git** is the canonical project state and records baseline, task, integration, and delivery commits.
- **SQLite in WAL mode** stores append-only run events and rebuildable projections for runs, tasks, agents, budgets, permissions, guidance, memory metadata, tool calls, evidence, and external effects.
- **Content-addressed artifacts** store command output, screenshots, patches, model responses, context snapshots, logs, and other large payloads. Events reference hashes instead of duplicating payloads.

Cached projections and snapshots may accelerate startup but are disposable. Recovery always derives authority from Git, the event log, and the external-effect ledger.

## Git bootstrap and workspace isolation

Git is checked before run creation. If it is missing or incompatible, the runner pauses before spending model tokens and provides operating-system-specific installation instructions plus a recheck action.

If the project is not a repository, the runner initializes it and creates an internal baseline commit after applying default exclusions for credentials, generated dependencies, caches, and oversized binaries. Existing repositories are never history-rewritten. Existing dirty state is captured exactly as the Build baseline without discarding or stashing the user's changes.

Each modification task gets an isolated workspace:

- Git worktree and task branch when practical.
- Runner-managed copy-on-write overlay when the repository state prevents a normal worktree.
- A stable baseline revision and task identifier.
- Real filesystem and process access inside the sandbox.
- Internal edit leases between sibling subagents.

Workers submit a typed change set. It includes the complete diff, created/deleted files, task commits, baseline revision, tool and test evidence, external effects, guidance, memories, and unresolved concerns. Rejected work never contaminates the canonical project.

Approved changes enter a serialized integration queue. The runner applies or rebases them onto the latest canonical revision. Mechanical conflicts create an Architect-owned integration-resolution task. Relevant checks then run against canonical integrated state. Task-level integration commits are the default; optional final squashing never removes internal provenance.

## Agent authority and roles

### Architect

The Architect is one persistent semantic authority for a run. It owns:

- Specification, architecture, constraints, and acceptance expectations.
- Task objectives, dependencies, priority, and replanning.
- Guidance answers and task-scope changes.
- Semantic review of worker submissions and integrated outcomes.
- Memory promotion and supersession.
- Final completion or explicit waiver decisions.

The kernel never issues or overrides these verdicts. If the Architect provider is unavailable, Architect-only operations pause. Already-authorized workers may finish their current task, but guidance, new planning, semantic review, integration approval, and completion wait. The UI offers retry, wait, or an explicit user-selected Architect handoff. A handoff package contains the spec, decisions, task graph, evidence index, unresolved questions, project memories, and current Git state rather than the raw transcript.

### Workers

Workers receive objectives, constraints, relevant context, acceptance expectations, budget, and binding Architect decisions. They do not receive a rigid file whitelist. Within the task sandbox and permission ceiling they may inspect or edit needed files, run tools and services, activate skills, retrieve memory, research, add tests, ask guidance, challenge guidance with new evidence, or propose replanning.

Workers finish only through typed lifecycle tools. Stream termination, malformed prose, or provider failure does not change task completion state.

Confirmed worker provider outages trigger automatic capability-compatible failover. The replacement resumes from the same task sandbox and event-derived handoff. Failed providers enter cooldown and do not reclaim old tasks unexpectedly.

### Worker-created subagents

Workers may spawn bounded subagents by default. Subagents share the task objective and sandbox but receive a narrow assignment, budget, depth, concurrency slot, and permission ceiling. The parent remains accountable. Subagents cannot approve, integrate, commit to the canonical branch, or declare the parent task complete. Findings return as structured artifacts.

### Evidence collectors and advisors

Evidence collectors execute Architect-defined recipes and record observations such as command, arguments, exit code, stdout/stderr artifact, environment, timestamps, workspace revision, browser trace, screenshot, console output, and network failures. They never return semantic pass/fail, task approval, or project completion.

Visual or domain specialists may provide advisory interpretations. Their assessments are evidence presented to the Architect, not kernel verdicts.

## Guidance and challenge protocol

Workers use a native `ask_architect` tool containing the question, ambiguity, evidence references, options, recommendation, and blocking/advisory urgency.

A blocking request durably suspends only that task, releases its execution slot, and retains task workspace ownership. An advisory request permits only work safe under every plausible answer. Architect responses clarify a task. Changes to dependencies, permissions, acceptance, or task scope require typed `revise_task` or `replan` operations.

A worker may challenge one guidance version only when it has newer concrete evidence. The challenge references the contradiction and proposed correction. The kernel checks freshness and the one-challenge budget, not semantic merit. The Architect's response ends that challenge.

## Native agent kernel

Every agent session durably records role/model identity, capabilities, current task, sandbox, permission ceiling, budget, activated skills, retrieved memories, Architect guidance, working context, and artifact references.

The model loop uses provider-native structured tools. Independent tool calls may run concurrently. Results are stored as artifacts and returned through compact references and summaries. An agent session ends only through a typed lifecycle tool such as `submit_task`, `report_blocked`, `request_replan`, or `complete_build`.

### Tool families

- Filesystem: read, search, patch, create, move, delete, metadata.
- Shell/process: run, stream, background services, signals, process inspection.
- Git: status, diff, log, branch, worktree, commit, merge, rebase, remote operations.
- Browser: runner-managed Playwright sessions, interaction, screenshots, console, network, DOM, and canvas evidence.
- Research: fetch, documentation, code intelligence, and permitted web search.
- MCP: dynamically registered external tools.
- Memory: search, inspect, add, supersede, and link evidence.
- Skills: discover, load, activate, and inspect requirements.
- Coordination: Architect guidance, challenge, subagent delegation, parent/sibling messaging.
- Lifecycle: submit, block, revise, replan, integrate, complete.
- External actions: deployments, remotes, issues/PRs, cloud services, and messaging according to permission mode.

The tool broker validates schemas, capabilities, permissions, and idempotency; it does not interpret task semantics.

## Context management

Each call receives a constructed working set:

- Stable role and run policy.
- Current task and Architect decisions.
- Relevant repository/tree/diff state.
- Selected project memories.
- Activated skill instructions.
- Recent turns and pending tool results.
- Relevant summaries and artifact references.
- Remaining budget and deadlines.

Compaction never destroys raw history. Older exchanges become attributable summaries with links to original events and artifacts. Agents may search their own history and reopen any artifact. Stable context segments are hashed for provider prompt caching.

## Skills

Built-in, user-installed, and project-local skill packages are versioned and indexed by purpose, supported tools, applicability, and context requirements. Skills can supply instructions, context hooks, tool recipes, and evidence recipes but cannot raise permissions.

The Architect may assign skills; workers and subagents may autonomously activate any installed skill within their permission ceiling. Activation and effects are logged. The kernel does not keyword-match a skill report or block for "missing skill evidence"; the Architect judges adequacy from actual actions and evidence.

## Project memory

There is no global memory.

- **Run memory** contains detailed temporary observations, hypotheses, failures, and unresolved questions.
- **Project memory** contains promoted durable decisions, conventions, commands, architecture, environment facts, accepted preferences, and recurring pitfalls.

Project memory entries include scope, provenance, author, workspace revision, confidence, evidence, and supersession links. Architect decisions outrank worker observations. Conflicts are surfaced. Secrets, credentials, large raw outputs, and transient provider errors are excluded. Retrieval is relevance-based and task-scoped.

## Mechanical validation versus semantic judgment

The kernel has three responses:

1. **Normalize safely:** canonical IDs, path separators, typed tool names, empty pseudo paths on explicitly evidence-only tasks.
2. **Block mechanically impossible execution:** malformed native call, dependency cycle, missing dependency, unavailable required capability, conflicting active lease, or permission violation.
3. **Report advisory concerns without blocking:** likely broad task, weak tests, suspicious duplication, questionable scope, or potentially incomplete acceptance.

The Architect may acknowledge or override advisory findings. Mechanical errors are returned once as typed compile facts; the kernel does not invent semantic repairs or spend repeated model calls asking for a predetermined rewrite.

## Task and run state machines

Tasks use explicit states:

```text
proposed -> ready -> running -> submitted -> architect_review
                    |             |
                    v             v
            awaiting_guidance   revision_requested -> running
                    |
                    v
                 blocked

architect_review -> approved -> integrating -> integrated
integration conflict -> integration_resolution -> integrating
```

Only typed events move states. The run supervisor independently tracks bootstrap, planning, execution, Architect wait, budget pause, permission pause, integration, completion, user stop, and failure recovery.

## Permissions and credentials

The tool broker enforces three profiles:

- **Guarded:** configured writes, commands, network, Git, and external actions require approval.
- **Project autonomous:** unrestricted project operations; sensitive outside-project or external effects require approval.
- **Full access:** all broker capabilities execute without per-action approval, including destructive operations, outside-project writes, credential changes, pushes/PRs, deployments, and external systems.

Full Access removes interruptions, not auditing. Upgrades require explicit user action. Downgrades prevent new privileged calls and surface already-running processes. Skills, MCP servers, subagents, and failover workers cannot exceed the run profile.

Runner-owned credentials are encrypted locally and never placed in model context unless a specific tool performs an authorized operation. Credential-bearing tools expose opaque handles.

## Budgets and provider reliability

Runs have optional hard token, cost, and elapsed-time limits. The Architect may allocate the remaining envelope among tasks but cannot extend it. Hitting any hard limit pauses all new model work for a user decision.

Actual provider usage, tool calls, retries, external effects, and cache hits are visible. Provider failures preserve the exact session position. Confirmed unavailable workers fail over automatically; the Architect never fails over without user selection. Identical safe reads may use revision-aware caching. There are no hidden protocol-repair turns.

## UI and human control

The web UI provides run setup, tasks, agents/subagents, tool calls, processes, Git graph, integration queue, evidence, guidance, memory, provider health, permissions, budgets, event search, audit export, pause/resume/stop, and Architect handoff.

User instructions normally go to the Architect as high-priority events. Advanced direct worker messages exist but are recorded as non-binding guidance and are visible to the Architect.

## Testing strategy

The native kernel must be testable without live models:

- Pure state-machine and event-reducer tests.
- Tool-schema, permission, idempotency, and path-boundary tests.
- Git bootstrap/worktree/integration/conflict tests in temporary repositories.
- Deterministic scripted-provider agent-loop tests.
- Context selection, compaction, memory, and skill-loading tests.
- Fault injection at every event/tool/process/external-action boundary.
- Crash/restart replay and in-flight reconciliation tests.
- Multi-agent concurrency, lease, failover, and budget tests.
- Runner API compatibility and UI reconnect tests.
- Opt-in certified live-provider suites for representative coding tasks.

No CI test should require paid provider access.

## Delivery phases

1. Runner service foundation: versioned API, SQLite event store, artifact store, projections, lifecycle.
2. Git bootstrap and isolated workspace/integration manager.
3. Provider-neutral native agent loop and core filesystem/shell/Git tools.
4. Persistent Architect, task scheduler, workers, guidance, and lifecycle tools.
5. Skills, project memory, context assembly, compaction, and prompt caching.
6. Subagents, worker failover, capability routing, budgets, and permissions.
7. Evidence collectors, managed browser tools, integration review, and completion.
8. Thin Build V2 web UI and removal of browser execution ownership.
9. Fault-injection hardening, certified task suites, migration, and legacy Build removal.
10. Optional external coding-agent adapters through the stable runtime-driver interface.

## Success criteria

- A run continues and recovers with every browser closed.
- A runner restart reconstructs the exact run without duplicated tools or external actions.
- Multiple workers operate concurrently without contaminating canonical files.
- Workers use native tools, skills, memory, guidance, and subagents without prose protocols.
- Provider outages preserve progress; worker failover is automatic and Architect handoff is user-controlled.
- Evidence is fresh, attributable, and revision-bound; only the Architect issues semantic verdicts.
- Full Access completes authorized external workflows without permission interruptions.
- Hard budgets pause exactly at the configured boundary.
- A representative repository task completes with materially fewer wasted calls than legacy Build and produces a clear Git/evidence audit trail.
