# Runner V2 — Agent capability model (design)

**Status:** APPROVED SOURCE, **revision 4** (2026-09-23). Owner-approved. SOURCE for
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

**Revision 3 — owner decisions later the same day.**

- **ESC-3 → option A, both.** One further repair cycle each for the `abort` resolution (plan
  finding B-1) and for applying `architect_document` (plan finding A5). The fifth review found
  both mechanisms named correctly but unreachable from the files the plan let a packet write.
  Revision 3 states the reachable mechanism in D1 constraint 4 and in D6.
- **Revision 4 (2026-09-23) — D6 redesigned by the owner (closes ESC-4).** The sixth review
  found the `architect_document` task still unreachable, with its last repair cycle spent. The
  owner replaced the mechanism rather than repairing it: the Architect gets real write access to
  one project documentation folder, `docs/project/**`, plus a marked section of `AGENTS.md` and
  `CLAUDE.md`; there is no new task kind. Owner, verbatim: "we could simple give hte architect
  the full access to the docs folder and cut the crap. with correct instructions how to
  use/update the ddocuments in agents.md file then every AI harness tool can properly work on the
  projects" — and, on a completion check: "A ofcourse. the whole point of p6.6 is forgetting
  things and missing things."
- **D8 added — reviewer independence, the same rule everywhere.** Owner, verbatim: "in the case
  that user had no access to many models that fit as reviewer they might use the same model for
  different tasks. we should not enfore different model in that case but instead use a clear
  context one to make sure it has not prior context" — and then "A, same rule everywhere".

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
4. **`abort` is terminal in both stores, and the runner reaches the supervisor.** The live
   `RunSupervisor` exists only in `cli.ts` (the fifth review traced this). So `abort` is made
   terminal in two steps. First, the durable abort resolution sets the **scheduler** run to
   `failed`, which the scheduler already declares but never sets; a failed scheduler run never
   dispatches and refuses `run.resumed`. Second, the runner carries that to the supervisor
   through a lifecycle hook that `cli.ts` installs, exactly as it already installs the pump
   result hook: at the moment of abort, on a pump step that reports `failed`, and at startup
   recovery for a run whose scheduler state is `failed` but whose supervisor state is not. A
   crash between the two steps therefore cannot redispatch: the scheduler step is first and is
   durable.

**Explicitly rejected:** silently non-gating recording (reintroduces the silent audit gap);
purely fail-closed recording (a locked file kills a long build for an audit write).

### D2 — Capability model: doers author, readers observe and execute

**Decision.** Replace the blanket read-only filter with an explicit per-role allow-list,
asserted at registration across **every broker the role uses**, failing closed.

| Role | Read project | Run commands | Author project code | Write plans/specs | Lifecycle authority |
|---|---|---|---|---|---|
| Worker | yes | yes | yes | yes | none |
| Architect | yes | **yes (new), in a disposable copy** | no | **yes (new): `docs/project/**` and the marked `AGENTS.md`/`CLAUDE.md` sections, via D6** | plan, review, integrate, complete |
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

### D6 — The Architect maintains the project documentation folder (revision 4)

**Goal.** Any AI tool — this runner, Claude Code, Codex, Cursor, anything that reads
`AGENTS.md` — can pick up a project and find its spec, plan, decisions and state. Today a
runner Build keeps those only in its private database, so a different tool starts blind.

**Decision.**

1. **One folder.** The Architect has real write access to `docs/project/**`, through one
   lifecycle tool, `write_project_doc(path, content, summary)`. Nothing outside that folder,
   except (2). The runner enforces the path: `..`, absolute paths, links and anything outside
   the folder are refused, in the tool **and** at the durable append boundary.
2. **The entry point.** The same tool may write the Architect's **marked section** of
   `AGENTS.md` (created if absent) and a one-line marked pointer in `CLAUDE.md` to `AGENTS.md`.
   The runner splices only between its markers; text outside the markers is never changed. The
   section says what the folder holds, how to read it first, and how to update it.
3. **Default layout**, shipped as a template the Architect fills and keeps current:
   `docs/project/README.md` (how the system works, rules for any agent), `STATE.md` (where
   things stand, next action), `specs/`, `plans/`, `decisions.md`, `evidence/`.
4. **Where the write lands.** The runner commits the file **on its integration branch**, with an
   Architect author and trailer, not into the user's working folder. Two reasons, both checked in
   the code: automatic handoff requires a clean project worktree and index
   (`integration-manager.ts:603-611`), so writing into the project during a run would break it;
   and documents should travel with the code they describe. The documents reach the project at
   handoff, together with that code. At the next build the Architect reads them from the project.
   No task, change set or worker session is created; applying a write costs no model call.
5. **One owner.** Workers do not write `docs/project/**`. A worker change set that touches it is
   refused at integration through the existing conflict path, naming the paths.
6. **The database stays the truth for gates.** A document saying "tests passed" approves
   nothing; acceptance still needs recorded evidence. Documents guide models; they cannot fake a
   result.
7. **Completion check (hard).** A new run cannot complete until the Architect has written
   `docs/project/STATE.md` **after** the run's latest integrated change. Runs created before this
   change are exempt.

**Why the old limit does not apply here.** The Architect must not author project code because it
also reviews code. Documentation is not code under review. The isolation reason is met by (4).

**Explicitly rejected:** the `architect_document` task kind (revisions 2–3: unreachable twice,
and heavy for a document write); writing into the user's working folder during a run (breaks
handoff); runner-generated exports as the only documentation (an Architect that forgets to
document is exactly what P6.6 exists to prevent — the completion check covers it).

### D7 — MOVED to P6.6

Coverage review against the original request. See the P6.6 owner amendment, EP33–EP35.

### D8 — Reviewer independence: a distinct model is preferred, a fresh context is required

**Problem.** `RuntimeRouter.selectVerifier` (`runtime-router.ts:174-222`) excludes the
Architect's model identity and every accepted change author's, and returns `unavailable` when
nothing else is left. Both the independent verifier (`native-verifier-runtime.ts:244`) and the
plan critic (`native-plan-critic-runtime.ts:129`) then pause the run for a user selection
(`build-runtime.ts:1266`, `:1724`). A user who has one suitable model can never pass either
gate.

**Decision.** The same rule for every reviewer role — independent verifier, plan critic, and
(in P6.6) the deliverable reviewer and the coverage reviewer:

1. **Prefer a distinct model.** If an eligible candidate exists whose model identity differs
   from the Architect's and from every change author's, choose it. This is today's rule.
2. **Otherwise fall back to a fresh context.** Choose an eligible candidate even if it shares a
   model identity, and run it in a **new session whose event list is empty** when it starts:
   no messages, tool results or context from any other session. Existing exclusions that are
   not about model identity — for example a runtime excluded after a provider error — still
   apply.
3. **Record which one happened.** The review request records `independence: "distinct_model"`
   or `"fresh_context"`, durably, and the UI shows it. Legacy events without the field replay as
   `distinct_model`, because the old rule enforced it.
4. **Pause only when no eligible candidate exists at all** (no healthy runtime with the required
   capability), as today.

**Why a fresh context is enough.** The bias the rule guards against is anchoring: a reviewer
that already holds the author's reasoning tends to confirm it. A model reading the change
cold, with no prior conversation, does not hold that reasoning. A distinct model adds a second
kind of independence — different training — which is why it is still preferred.

**Explicitly rejected:** requiring a distinct model always (blocks single-model users);
silently reusing an existing session (that is the anchoring the rule exists to remove).

---

## 3. Honest limits

1. **Review has a ceiling.** Timing, load and real-world behaviour are findable neither by
   reading nor by a clean-room test run. That is P7.
2. **The Architect cannot repair runner-private state, and D1 does not grant it.** "Solve it"
   is realistically *retry after a transient cause passes*, *waive with a reason*, or *stop*.
3. **Documents reach the user's working folder at handoff, not live.** During a run they live
   on the runner's integration branch, beside the code they describe. A run that is never handed
   off delivers neither its code nor its documents.

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
| AC-7 | Architect document writes are refused outside `docs/project/**` and the marked `AGENTS.md`/`CLAUDE.md` sections, in the tool and at the durable append boundary. | D2, D6 |
| AC-8 | Verifier command execution is confined to its own workspace; the plan critic has none; the user's project is never mutated by a reader. | D2 |
| AC-9a | Verifier and critic cannot commit, integrate, complete, alter the plan or review tasks. | D2 |
| AC-9b | The Architect retains `review_task`, `request_integration` and `complete_run`. | D2 |
| AC-10 | The Architect admits only MCP tools the mapper marks `readOnly`, as an asserted class. | D3 |
| AC-17 | An Architect document write is committed on the integration branch with Architect attribution, with no task, change set, worker session or model call; the `AGENTS.md`/`CLAUDE.md` splice changes only the marked section; a worker change touching `docs/project/**` is refused at integration. | D6 |
| AC-25 | A new run cannot complete until `docs/project/STATE.md` was written after its latest integrated change; legacy runs are exempt. | D6 |
| AC-18 | Runs created before this change keep current semantics and remain replayable. | compat |
| AC-24 | Verifier and plan-critic selection prefer a distinct model and otherwise fall back to the same model in a fresh session with an empty event list; the choice is recorded as `distinct_model` or `fresh_context` and shown; the run pauses only when no eligible candidate exists. | D8 |

AC-11..AC-16 and AC-19..AC-23 moved to P6.6 as EP33–EP38.

---

## 5. Open questions

- **OQ-2 — CLOSED by D6 revision 4.** The allow-list is `docs/project/**` plus the marked
  sections; no investigation is needed.

OQ-1, OQ-3 and OQ-4 moved to P6.6 with the decisions that raised them.
