# Runner V2 Context, Skills, Memory, Budgets, and Evidence Plan

**Goal:** Give the native Runner V2 kernel Codex/Claude-Code-class project understanding and disciplined execution without reintroducing semantic gates or browser-owned state.

**Architecture:** The runner discovers project-local instructions and skills with provenance, stores only project/run-scoped memory, assembles bounded role-specific context, accounts for model/tool/cost budgets in an append-only ledger, and captures command/tool evidence as immutable facts. Workers may recall memory and propose learnings; only the Architect may promote durable project memory. Evidence never approves, rejects, or completes work.

**Runtime:** Node.js 24.18.0, TypeScript 6, `node:sqlite`, native Runner V2 tools. No paid provider calls in tests.

## Invariants

- No global memory. Memory is scoped to the canonical project identity and optionally the run/task.
- Project instructions and skills always carry source path, digest, scope, and load reason.
- Skill text is context, not kernel authority; it cannot raise permissions or mutate lifecycle state.
- Context budgets protect system invariants, current task intent, pending tool results, and fresh guidance before optional history.
- Hard budgets block only mechanically measurable excess: model calls, tool calls, input/output tokens, estimated cost, elapsed active time, and artifact bytes.
- Evidence records commands, arguments, cwd, timestamps, exit/signal, stdout/stderr artifacts, and repository revision. It never records a semantic verdict.
- Architect owns memory promotion, review meaning, and completion.

## Task 1: Project instruction and skill discovery

Create `project-context.ts`, `skill-catalog.ts`, `skill-tools.ts`, and tests. Discover `AGENTS.md`, `CLAUDE.md`, and project-local `SKILL.md` files without leaving the repository or following escaping symlinks. Parse concise skill metadata, hash source bytes, expose `list_skills`/`read_skill`, and cap individual/aggregate content mechanically.

## Task 2: Project-scoped memory store and lifecycle tools

Create `project-memory.ts`, `sqlite-project-memory.ts`, `memory-tools.ts`, and tests. Store append-only observations/proposals/promotions keyed by canonical project identity. Workers can recall and propose; only Architect tools can promote, supersede, or archive. Retrieval uses deterministic lexical ranking plus explicit concept tags; no global database or cross-project fallback.

## Task 3: Deterministic context assembler

Create `context-assembler.ts`, `agent-prompts.ts`, and tests. Build Architect and worker context packs from protected invariants, task graph, current guidance/review state, project instructions, selected skills, project memory, repository snapshot, evidence, and recent messages. Apply ordered byte/token budgets with explicit omissions and artifact references rather than silent truncation.

## Task 4: Durable budget accounting

Create `budget-ledger.ts`, `sqlite-budget-ledger.ts`, `budget-policy.ts`, and tests. Reserve/settle model calls and tool calls atomically, persist usage/cost/active-time counters, recover reservations after restart, and return typed budget-exhausted results. Provider failures and waiting-for-user/guidance time do not burn active-time budget.

## Task 5: Factual evidence capture

Create `evidence-store.ts`, `evidence-tools.ts`, and tests. Capture foreground/background process facts, Git revision/status/diff references, and artifact hashes into immutable evidence bundles. Expose evidence collection to workers and inspection to Architect. Never translate exit codes, output text, coverage, or verifier labels into approval/completion.

## Task 6: Native role runtime integration

Create `native-architect-runtime.ts`, `native-worker-driver.ts`, and a restart/fault test. Compose skills, memory, context, budgets, provider routing, durable sessions, tools, evidence, workspace commits, and scheduler outcomes. Prove context and tool calls resume without duplication; worker failover retains checkpoint/context; Architect provider loss pauses for user selection; only typed Architect lifecycle actions complete.

## Completion gate

A scripted native Architect and two native workers must discover project instructions, load a relevant local skill, recall project memory, inspect/edit/test in isolated workspaces, attach factual evidence, survive provider failure and runner restart, integrate serialized change sets, and complete only through `complete_run`. Budget exhaustion must pause before an excess call, and evidence text must be unable to approve or complete anything.
