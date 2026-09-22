# Runner V2 — Agent capability model (design)

**Status:** APPROVED SOURCE, **revision 2** (2026-09-22). Owner-approved. SOURCE for
`docs/superpowers/plans/2026-09-22-runner-v2-agent-capability-and-change-critique.md`.

**Base revision:** `6c166f97` on `main` (P6.5 merged as PR #98; lint cleared as PR #99).

**Scope change in revision 2 — owner-authorized, 2026-09-22.** Revision 1 held seven
decisions, D1–D7. Four independent planning reviews found that D4 (change critique), D5
(risk-gated review depth) and D7 (coverage review against the original request) duplicate
what P6.6 already plans: P6.6 mandates an independent source-coverage review for every plan
(T3) and one combined independent deliverable review per change with justified specialist
review (T6), and it explicitly forbids a second competing critic or coverage authority. The
owner decided to **move D4, D5 and D7 into P6.6 as an owner amendment**
(`docs/superpowers/specs/2026-09-22-runner-v2-p6-6-owner-amendment.md`) and to keep here only
what P6.6 does not cover: **D1, D2, D3 and D6.** Their text is retained below as moved
pointers so traceability is not lost. Nothing is silently dropped; the obligations change
owner, not existence.

Two owner decisions from the same session are applied here:

- **ESC-1 → option A.** One further repair cycle is granted for the worker-path recording
  failure (plan finding B-1/N-1), which had exhausted its three-cycle budget.
- **ESC-2 → option A.** An Architect-authored plan/spec change is attributed to the Architect
  **in git**. It is **not** surfaced in the audit export's accepted-change list.

---

## 1. Why this exists

P6.5 shipped ten packets. Independent review found **fifteen real defects, each after the
implementing worker had reported a fully green suite.** Roughly twelve had no acceptance
criterion able to catch them, and roughly six were only *provable* by running something —
breaking a guard and observing that zero tests failed.

Two structural facts at `6c166f97` explain the second half of that, and are what this design
fixes:

1. **Readers cannot execute.** The verifier's inspection broker admits only
   `readOnly && effect === "none"` tools and asserts it (`native-verifier-runtime.ts:884-890`,
   `assertReadOnlyInspectionDefinition`). `run_evidence_command` (`evidence-tools.ts:45`,
   `readOnly: false` at line 65) is excluded, so the verifier reads only evidence produced by
   the thing it judges. The Architect is filtered the same way for filesystem and git tools
   (`native-architect-runtime.ts:257-274`) and has no process tools at all.
   `VERIFIER_AUTHORITY_INVARIANTS` forbids *authorship and lifecycle control* — "edit files,
   create commits, integrate changes, alter the plan, review worker tasks, or complete the
   run" — not execution. The blanket read-only filter is broader than the stated intent.
2. **One role's boundary is not self-enforcing.** The Architect filters extension
   capabilities to `readOnly === true && effect === "none"` but registers **every MCP tool
   unfiltered** (`native-architect-runtime.ts:304-308`), and under `permissionProfile: "full"`
   the broker requires no approval for `effect: "external"` (`tool-broker.ts:272-280`).

The owner's position, recorded verbatim:

> "if we are giving AI agents to handle the tasks they should have the necessary tools to do
> it, unless we let other parts of our architect handle such a things and we do it for a good
> reason"

> "maybe we dont want the architect and verifier to directly write code or modify project
> files but that does not mean it should not be able to write/modify specs/plans and other
> parts or run tools"

**"Must not author project code" is a legitimate boundary. "Cannot act at all" is not.**

---

## 2. Decisions

### D1 — A failed context-manifest write is resolved by the Architect (closes OD-3)

**Problem.** `recordContextPack` (`context-manifest-store.ts`) awaits `artifacts.put` and
`store.record` with no `try`/`catch`, from **five call sites in four files**:

| File | Line |
|---|---|
| `native-architect-runtime.ts` | 175 |
| `native-plan-critic-runtime.ts` | 181 |
| `native-verifier-runtime.ts` | 378, 651 |
| `native-worker-driver.ts` | 161 |

A side-ledger write failure — a locked SQLite file, a full disk, an antivirus handle — fails
the Build step. The context manifest is audit-only; nothing reads it to decide anything. An
observability feature that can kill a build is a real cost, and P6.5 hit Windows `EPERM` on
SQLite handles twice.

**Decision.**

```
recordContextPack fails
  → bounded retry with backoff             (the common transient lock)
  → still failing
  → durable note in the SCHEDULER STORE    (a different database from the one that failed)
  → the run PAUSES; the Architect must decide
```

| Resolution | Meaning | Effect |
|---|---|---|
| `retry` | cause addressed or transient | resume; recording re-attempted within a finite budget; exhausting it re-pauses with the existing note |
| `proceed_without_manifest` | not fixable, not fatal — **rationale required** | recording is suspended for the run; the gap is attributed, never silent |
| `abort` | unrecoverable | the run fails through the existing `RunSupervisor.fail` path (`run-supervisor.ts:117`) with the reason recorded |

**Mechanism constraints, established by four review rounds and binding on the plan.**

1. **No call site is edited.** `recordContextPack` retries internally and throws a typed
   `ContextManifestRecordingError` on exhaustion.
2. **The worker path does not reach the dispatcher.** `task-scheduler.ts:227-234` turns every
   `driver.run` rejection into a failed task. Re-raising from there is also wrong: it skips
   `recordOutcome`, leaving the task `running` for the next tick to redispatch into the same
   error, and an uncaught rejection becomes `autonomous_pump_error`
   (`native-build-manager.ts:729-736`). The scheduler must instead record the **existing
   `paused` outcome** (`task-scheduler.ts:278-288`), which appends `run.paused` and returns
   without failing the task.
3. **A waiver must survive restart.** Recording suspension is a runtime switch owned by
   `context-manifest-store.ts` and **re-derived from the durable waiver event before the first
   dispatch** whenever a runtime is constructed. It serves all five call sites and edits none.

**Explicitly rejected:** silently non-gating recording (reintroduces the silent audit gap);
purely fail-closed recording (a locked file kills a long build for an audit write).

### D2 — Capability model: doers author, readers observe and execute

**Decision.** Replace the blanket read-only filter with an explicit per-role allow-list,
asserted at registration across **every broker the role uses**, failing closed.

| Role | Read project | Run commands | Author project code | Write plans/specs | Lifecycle authority |
|---|---|---|---|---|---|
| Worker | yes | yes | yes | yes | none |
| Architect | yes | **yes (new), in a disposable copy** | no | **yes (new), via D6 only** | plan, review, integrate, complete |
| Independent verifier | yes | **yes (new), in its own workspace** | no | no | typed verdict only |
| Plan critic | yes | **no** | no | no | typed findings only |

**Why the plan critic stays execution-free.** It runs during planning. P6.6 forbids
implementation tests and application execution during planning mode, and the change-review
stage that would need execution moved to P6.6 with D4.

**Why readers may execute.** Independent review without an experiment is skeptical reading.
Roughly six P6.5 defects were only provable by execution. `run_evidence_command` already
records exit code, output and revision as durable, attributable evidence.

**Why independence survives.** Reader execution runs in a disposable copy or the reader's own
workspace, never the user's project. `containedDirectory` (`evidence-tools.ts:243-255`)
already rejects an escaping `cwd`; any new confinement must account for it.

**Why the Architect still may not author code.** It is also the reviewer (`review_task`). An
Architect that writes code reviews its own code — the defect RG-6 removed one layer down.

**Unchanged for every reader:** no commits, no integration, no completing the run. The
verifier and critic additionally cannot alter the plan or review tasks. The Architect
**retains** `review_task`, `request_integration` and `complete_run`
(`architect-tools.ts:1338`, `:1482`, `:1528`) — D2 must not delete legitimate authority.

**Planning-mode note for P6.6.** Architect command execution granted here applies outside a
new-policy planning state. P6.6 T3 owns keeping new-policy planning read-only.

### D3 — MCP admission for the Architect is filtered

**Decision.** The Architect admits only MCP tools that `createMcpTools` maps to
`readOnly === true`, as a **checked class** — server-supplied names cannot be static allow-list
entries. The mapper's predicate is `readOnlyHint === true && destructiveHint === false`
(`mcp-tools.ts:156-159`), and it always sets `effect: "external"`, so
`assertReadOnlyInspectionDefinition` can never admit one; the class needs its own assert.
Verifier and critic stay at zero MCP tools, as today. MCP is not banned: read-only documentation
lookup is genuinely useful for planning.

**Explicitly rejected:** banning MCP for readers; forcing approval even under `full`.

### D4 — MOVED to P6.6

Change critique. See the P6.6 owner amendment, requirements EP36–EP38.

### D5 — MOVED to P6.6

Risk-gated review depth. See the P6.6 owner amendment, requirement EP38.

### D6 — Architect plan/spec writes are attributed in git (ESC-2 → option A)

**Decision.** The Architect writes plans and specs through a single lifecycle tool,
`write_plan_document(path, content, summary)`, admitted only for paths on the investigated
allow-list. It does **not** receive filesystem mutation tools.

**Mechanism.** The write becomes a kernel-applied task of a new kind, `architect_document`.
The runner — not a model — creates the task workspace, writes the file, commits it with an
Architect trailer through `WorkspaceManager.commitTask`, builds the ChangeSet through
`createChangeSet` with the file's content hash as its evidence, and integrates it through
`IntegrationManager.integrate` (`integration-manager.ts:474`). Applying it costs **no model
tokens**.

**Why a kernel-applied task.** Four review rounds established that every commit API in the
tree needs a task workspace, `createChangeSet` (`change-set.ts:63-100`) needs a task id, a task
commit and at least one evidence hash, and nothing on the Architect path constructs any of
them. A real task supplies all three and reuses isolation, commit, integration and handoff
unchanged. Writing into `projectRoot` instead would bypass isolation and the P6 handoff.

**Consistent with ESC-2.** `acceptedChangeSessions` (`native-build-factory.ts:2725-2743`) keeps
only worker sessions with a submitted ChangeSet. A kernel-applied task has no worker session,
so it does not appear there — exactly the owner's choice, with no change to that filter. Git
shows who wrote the plan.

**Explicitly rejected:** Architect filesystem mutation tools (no isolation, no attribution
path); plans kept only in runner-private state (splits the plan away from git).

### D7 — MOVED to P6.6

Coverage review against the original request. See the P6.6 owner amendment, EP33–EP35.

---

## 3. Honest limits

1. **Review has a ceiling.** Timing, load and real-world behaviour are findable neither by
   reading nor by a clean-room test run. That is P7.
2. **The Architect cannot repair runner-private state, and D1 does not grant it.** "Solve it"
   is realistically *retry after a transient cause passes*, *waive with a reason*, or *stop*.
3. **`architect_document` is a new task kind**, not a small edit. The owner was told ESC-2
   option A was a small change; the review rounds showed a commit path is unavoidable, and the
   kernel-applied task is the cheapest one that preserves isolation. It costs no tokens to
   apply, but it is real scheduler work.

---

## 4. Requirements

| ID | Requirement | From |
|---|---|---|
| AC-1 | A failed manifest write retries with bounded backoff before it is treated as failed. | D1 |
| AC-2 | An exhausted failure writes a durable note to the scheduler store, not the failed ledger. | D1 |
| AC-3 | An exhausted failure pauses the run with a typed Architect decision on **all four agent paths**; it never silently continues and never dies without the note. | D1 |
| AC-4 | The Architect resolves it with exactly one of `retry`, `proceed_without_manifest` (rationale required), `abort`; each durable, attributed and restart-safe. | D1 |
| AC-5 | Each role's tool surface is an explicit allow-list, asserted across every broker, failing closed. | D2 |
| AC-6 | The Architect can run commands in a disposable copy, subject to the run permission profile. | D2 |
| AC-7 | Architect document writes are refused outside the investigated plan/spec allow-list. | D2, D6 |
| AC-8 | Verifier command execution is confined to its own workspace; the plan critic has none; the user's project is never mutated by a reader. | D2 |
| AC-9a | Verifier and critic cannot commit, integrate, complete, alter the plan or review tasks. | D2 |
| AC-9b | The Architect retains `review_task`, `request_integration` and `complete_run`. | D2 |
| AC-10 | The Architect admits only MCP tools the mapper marks `readOnly`, as an asserted class. | D3 |
| AC-17 | An Architect document write lands as a kernel-applied `architect_document` task, committed with Architect attribution in git, and is **not** listed among accepted change sessions. | D6 |
| AC-18 | Runs created before this change keep current semantics and remain replayable. | compat |

AC-11..AC-16 and AC-19..AC-23 moved to P6.6 as EP33–EP38.

---

## 5. Open questions

- **OQ-2** — which paths form the Architect's document allow-list. Investigated by plan packet
  I2 against `tsconfig` includes, `next.config` and the test globs.

OQ-1, OQ-3 and OQ-4 moved to P6.6 with the decisions that raised them.
