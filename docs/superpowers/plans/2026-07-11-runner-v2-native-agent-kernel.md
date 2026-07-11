# Runner V2 Native Agent Kernel Plan

**Goal:** Add a provider-neutral, durable coding-agent loop that uses native structured tools inside isolated task workspaces and cannot mistake prose or stream termination for task completion.

**Architecture:** Model transports implement one typed `AgentModel` interface and return assistant text plus native tool-call blocks. A deterministic kernel validates tool names/arguments, routes calls through a permission-aware broker, stores large results as artifacts, and feeds structured results back to the model. Lifecycle changes happen only through native lifecycle tools. Core filesystem, shell/process, and Git tools operate inside a task workspace; the Architect and scheduler are layered on afterward.

**Runtime:** Node.js 24.18.0, no paid provider calls in tests.

## Invariants

- No JSON tool protocol embedded in model prose.
- Unknown/malformed tool calls consume no external side effect and return one structured error.
- Every tool call has a call ID, idempotency key, actor, workspace revision, timing, result/error, and artifact references.
- Model EOF, malformed assistant prose, or provider failure never marks a task complete.
- Only typed lifecycle tools can submit work, wait for guidance, or request replanning.
- Tool/permission mechanics never reinterpret task intent or evidence quality.
- Project-autonomous workers can act freely inside their task workspace; outside-project/external effects remain broker decisions until Full Access is wired.

## Task 1: Native model and tool contracts

Create `agent-contracts.ts`, `tool-registry.ts`, and contract tests. Define structured messages, assistant text/tool-call blocks, tool definitions, results, actor/session identity, stop reasons, and JSON-schema argument validation. Reject duplicate call IDs and unknown tools mechanically.

## Task 2: Deterministic agent loop

Create `agent-loop.ts` and scripted-model tests. Implement iterative model calls, native tool execution, parallelization only for explicitly read-only calls, bounded turns, cancellation, provider-error suspension, and typed lifecycle outcomes. Prove that prose saying “done” and model EOF do not complete a task.

## Task 3: Tool broker and permission envelope

Create `tool-broker.ts` with workspace containment, capability metadata, approval decisions, call idempotency, output caps, cancellation, and immutable audit records. Add path traversal, symlink escape, duplicate side-effect, timeout, and permission-profile tests.

## Task 4: Filesystem/search/edit tools

Create native read, metadata, glob/list, ripgrep search, patch, create, move, and delete tools. Writes are atomic where possible and revision-aware. Tests cover binary files, encodings, CRLF, large-output artifacts, concurrent edit leases, and workspace escape attempts.

## Task 5: Shell/process tools

Create foreground/background command execution with argument arrays or explicitly selected shell, streamed output artifacts, environment redaction, timeouts, signals, process ownership, and restart reconciliation. Never infer success from text; record command, exit code, signal, and environment facts.

## Task 6: Git tools

Expose status, diff, log, show, branch, commit, and task-safe history tools through the broker. Remote/push/PR actions are declared external effects and remain profile-governed. Workers cannot update canonical integration refs.

## Task 7: Durable execution and recovery

Extend events/projections for model turns, tool calls, lifecycle submissions, provider suspension, and context snapshots. Store model/tool payloads in the artifact store. Fault-inject runner death before/after tool execution and prove replay does not duplicate writes, commands, commits, or external effects.

## Completion gate

A scripted worker must inspect a repository, search/read files, edit, run tests, inspect Git diff, and submit a typed change set through native tool calls. Killing/restarting during the sequence must resume without duplicated side effects. Prose-only completion must remain non-terminal.
