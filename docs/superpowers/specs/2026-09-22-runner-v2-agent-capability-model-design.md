# Runner V2 — Agent capability model and change critique (design)

**Status:** APPROVED SOURCE. Owner-approved in session 2026-09-22. This document is the
SOURCE for the execution plan at
`docs/superpowers/plans/2026-09-22-runner-v2-agent-capability-and-change-critique.md`.

**Base revision:** `6c166f97` on `main` (P6.5 merged as PR #98, pre-existing lint cleared
as PR #99).

**Supersedes nothing.** Extends the P6.5 review-gap closure
(`docs/superpowers/plans/2026-09-02-runner-v2-p6-5-review-gap-closure.md`) and resolves the
open owner decision OD-3 recorded in
`.superpowers/sdd/2026-08-26-runner-v2-robust-build-improvements/progress.md`.

---

## 1. Why this exists

P6.5 closed six review gaps and shipped ten packets. During that phase an independent
controller reviewed every packet and found **fifteen real defects, every one of them after
the implementing worker had reported a fully green test suite**.

That fact is the entire justification for this document. The defects were not caught by the
existing review machinery, and they were not caught because of how that machinery is shaped,
not because anyone was careless.

### 1.1 What the fifteen defects looked like

| Class | Count | Example |
|---|---|---|
| No acceptance criterion existed to catch it | ~12 | six untested manifest identity components; a class never constructed by any test; a compound guard whose clause had zero coverage |
| A criterion existed but nothing exercised it | ~3 | "a revised task that was `waiting_guidance` transitions to `planned`" — documented, and it threw on every call |

**Every P6.5 packet met its stated acceptance criteria.** That is precisely why four
workers honestly reported green. The defects lived in the space *between* the criteria.

### 1.2 Why the current roles could not catch them

Runner V2 has three review layers as of `6c166f97`. All three are criterion-shaped:

| Layer | When | Model | Question it asks |
|---|---|---|---|
| Plan critic (`native-plan-critic-runtime.ts`) | before work | ≠ Architect, enforced | "is this plan sound?" |
| Architect `review_task` (`architect-tools.ts:1338`) | per task | same as planner | "does this meet AC-1..n?" |
| Independent verifier (`native-verifier-runtime.ts`) | at integration | ≠ Architect and ≠ change authors, enforced | "is each criterion satisfied?" |

`submit_verifier_verdict` (`verifier-tools.ts:35`) has exactly one output channel,
`criterionVerdicts: [{ taskId, criterionId, verdict, ... }]`, and
`assertExactVerifierCriteria` requires every criterion exactly once with no extras. The
verifier therefore **structurally cannot report a finding that is not attached to an
acceptance criterion**. It has nowhere to put that sentence.

### 1.3 Why the readers could not prove what they suspected

All three reader roles are filtered to read-only tools. `native-verifier-runtime.ts:885-889`:

```ts
.filter((tool) =>
  tool.definition.readOnly &&
  tool.definition.effect === "none" &&
  tool.definition.lifecycle !== true && ...)
...
assertReadOnlyInspectionDefinition(tool.definition);
```

`run_evidence_command` (`evidence-tools.ts:45`) is `readOnly: false` because running a
command can write to its working directory, so the blanket filter excludes it. The verifier
receives `inspect_evidence` only.

The consequence: **a reader can only read evidence produced by the thing it is judging.**
Of the fifteen P6.5 defects, roughly six were only *provable* by running something — breaking
a guard and observing that zero tests failed. A reader without execution can suspect those
and cannot establish them.

Note what `VERIFIER_AUTHORITY_INVARIANTS` (`agent-prompts.ts`) actually forbids:

> "You have no authority to **edit files, create commits, integrate changes, alter the plan,
> review worker tasks, or complete the run**."

That list is about **authorship and lifecycle control**. Running a command to check a claim
is none of those. The read-only tool filter is broader than the stated intent and excludes
execution as collateral, not by decision.

### 1.4 The owner's position

Recorded verbatim, 2026-09-22:

> "if we are giving AI agents to handle the tasks they should have the necessary tools to do
> it, unless we let other parts of our architect handle such a things and we do it for a good
> reason"

and

> "maybe we dont want the architect and verifier to directly write code or modify project
> files but that does not mean it should not be able to write/modify specs/plans and other
> parts or run tools"

The distinction the owner draws, and which this design adopts: **"must not author project
code" is a legitimate boundary. "Cannot act at all" is not.**

---

## 2. Approved decisions

### D1 — Context manifest recording failure is resolved by the Architect (closes OD-3)

**Problem.** `recordContextPack` (`context-manifest-store.ts`) awaits `artifacts.put` and
`store.record` with no `try`/`catch`, and the Architect, worker and verifier runtimes all
await it on the model-call path. A side-ledger write failure — a locked SQLite file, a full
disk, an antivirus handle — therefore fails the Build step. `SqliteToolLedger` behaves the
same way, so this is consistent with Runner V2, not an oversight. It was surfaced by the
implementing worker rather than silently patched.

The tension: the tool ledger is load-bearing (it fences and de-duplicates tool calls, so
proceeding after a failed write is genuinely unsafe). The context manifest is **audit-only** —
nothing reads it to make a decision. An observability feature that can kill a build is a
real cost, and this phase hit Windows `EPERM` on SQLite handles twice.

**Decision.** Neither "always die" nor "always continue". The Architect assesses and decides.

```
recordContextPack fails
  → retry with bounded backoff            (catches the common transient lock)
  → still failing
  → write a durable note to the SCHEDULER STORE
    (deliberately a different database from the one that failed,
     so the note itself can land)
  → PAUSE and present a typed decision to the Architect
```

The Architect must answer with exactly one of:

| Resolution | Meaning | Effect |
|---|---|---|
| `retry` | "the cause is addressed or transient" | re-attempt recording, bounded |
| `proceed_without_manifest` | "not fixable, not fatal" — **requires a rationale** | run continues; the audit gap is attributed, never silent |
| `abort` | "unrecoverable" | run stops with the reason recorded |

**Rationale for the middle option.** The objection to "just continue" was silent audit gaps.
A waiver is not silent: it is a decision with an author and a written reason in the durable
record. This is the same device RG-2 already uses for `acceptedFailures`.

**Rationale for the shape.** This mirrors four existing P6.5 pause-and-decide flows —
repair-cycle limit, verifier unavailable, worker replan, plan critique resolution. Nothing
new to learn and the UI vocabulary already exists.

**Explicitly rejected:** making recording silently non-gating (reintroduces the silent gap);
leaving it purely fail-closed (a locked file kills a long build for an audit write).

### D2 — Capability model: doers author, readers observe and execute

**Decision.** Replace the blanket read-only filter with an explicit per-role capability
allow-list. Every boundary must be **asserted**, not merely filtered, so it cannot drift.

| Role | Read project | Run commands | Write project code | Write plans/specs | Lifecycle authority |
|---|---|---|---|---|---|
| Worker | yes | yes | yes | yes | none |
| Architect | yes | **yes (new)** | no | **yes, path-scoped (new)** | plan, review, integrate, complete |
| Independent verifier | yes | **yes, in its own workspace (new)** | no | no | typed verdict only |
| Plan / change critic | yes | **yes, in its own workspace (new)** | no | no | typed findings only |

Unchanged for every reader role: **no commits, no integration, no completing the run.** The
verifier and critic additionally retain: no plan mutation, no task review.

**Why readers may now execute.** Independent review that cannot run an experiment is
skeptical reading. The evidence from §1.3 is direct: roughly six of the fifteen P6.5 defects
were only provable by execution. `run_evidence_command` already records exit code, output and
revision as durable, attributable evidence, so a reader running a command is not off-book —
it produces evidence exactly like a worker does.

**Why this does not compromise independence.** The verifier and critic execute inside **their
own disposable workspace copy**, never the user's project. The verifier already receives a
workspace; RG-6 added a second baseline one. Nothing the user cares about is mutated.

**Why the Architect still may not author code.** The Architect is also the reviewer
(`review_task`). An Architect that writes code reviews its own code. That is the same defect
RG-6 was built to remove one layer up, and it is not reopened here.

**Why path-scoped writes are cheap.** `filesystem-tools.ts` already enforces `hiddenPaths`
(read policy) and `protectedPaths` (write policy). Architect plan/spec writes are an
allow-list variant of machinery that exists.

**Explicitly rejected:** giving the Architect full worker powers (destroys reviewer
independence); keeping readers execution-free (the status quo that produced §1.3).

### D3 — MCP tools are filtered for reader roles

**Problem.** The Architect is the only role whose boundary is not self-enforcing. It filters
filesystem and git tools by `readOnly`, and extension capabilities by
`readOnly === true && effect === "none"`, but registers **all MCP tools unfiltered**
(`native-architect-runtime.ts:304-308`). MCP tools carry `effect: "external"` and take
`readOnly` from the server's own `readOnlyHint`.

Approval (`tool-broker.ts:272-279`) is `permissionProfile !== "full" && (... effect === "external" ...)`.

| Profile | Architect MCP call |
|---|---|
| `guarded` / `project` | user approves each one |
| `full` | **no approval and no filter** |

So under `full`, a configured MCP server can hand the Architect write and execute power,
twenty lines below the code that deliberately stripped exactly those. This is an
inconsistency rather than a silent backdoor — the operator chose `full` — but the Architect
should not be the one role whose boundary can drift.

**Decision.** Reader roles admit only MCP tools whose server declares `readOnlyHint: true`,
and the admission is covered by the same style of assert the verifier already has. MCP is not
banned: read-only documentation lookup (Context7 and similar) is genuinely useful for
planning.

**Explicitly rejected:** banning MCP for readers (loses legitimate capability); forcing
approval even under `full` (changes what the operator's own `full` setting means).

### D4 — The plan critic becomes a two-stage critic

**Decision.** Extend the existing critic rather than adding a parallel reviewer role. It
gains a second stage that reviews the **change** instead of the **plan**.

```
plan → [critic stage 1: plan] → workers → integrate
     → [critic stage 2: change]   ← new
     → [verifier: criteria] → final verification → complete
```

**What is reused unchanged.** `PlanCritiqueFinding` (severity / category / taskIds / claim /
evidence), the blocking gate, the Architect `resolve_plan_critique` resolution flow, advisory
auto-resolution, the independence selection rule, and the observability surface. The finding
vocabulary is already a review-finding vocabulary.

**What must differ.**

1. **Selection excludes change authors.** A plan critic must not be the Architect. A change
   critic must also not be any worker who authored an accepted change.
   `RuntimeRouter.selectVerifier` already accepts `acceptedChangeAuthorRuntimeIds`
   (`runtime-router.ts:189`); the plan stage passes `[]`, the change stage passes the real
   authors. A consequence to accept: **stage 2 may select a different model than stage 1**,
   which is correct.
2. **Stage 2 is blind-first.** Its own stage-1 findings are **not** provided in its first
   turn. It forms and files findings against the diff, and only then is shown the stage-1
   findings to mark which remain open. Handing an agent its own prior conclusions up front
   recreates precisely the anchoring bias RG-6 exists to remove, and would turn stage 2 into
   a checklist that catches only the ~3 defect class from §1.1.
3. **Stage 2 runs before the verifier.** The verifier answers the contract; the critic hunts
   what the contract missed. If the critic blocks, the verifier's budget has not been spent
   on a change that is about to change.

**Why not a separate reviewer role.** It would duplicate the finding contracts, the
resolution flow, the selection rule, the UI and the tests, and would give the operator two
roles to configure for one job.

### D5 — Change critique is risk-gated with graded depth

**Decision.** Stage 2 is **not** run on every build, and is **not** a binary skip-or-review.

Owner rationale, recorded: the purpose is to catch edge cases and poor work from fast cheap
worker models, and neither tokens nor wall-clock should be spent on changes that do not
warrant it.

**Change risk is assessed deterministically**, in the same style as `assessPlanRisk`: no
clock, no randomness, no environment lookup, no model call, so the same change always yields
the same risk.

| Signal | Rationale |
|---|---|
| Author model tier | a fast cheap worker earns more scrutiny than a frontier one; authorship is already durable via `acceptedChangeAuthorRuntimeIds` |
| Shared kernel surface touched | a change to the scheduler store is not a change to a README |
| Source changed with no test changed | the loudest single smell observed during P6.5 |
| Task required more than one attempt | it already struggled once |
| An `acceptedFailures` waiver was used | someone explicitly accepted a red command |
| Size — files and lines touched | blunt but real |

**Graded response.**

| Risk | Stage 2 behaviour | Cost |
|---|---|---|
| low | durable skip, recorded with reason | ~0 |
| medium | read the diff, file findings | one model pass |
| high | read the diff **and run the affected tests itself** | one pass plus compute |

The top tier is where D2's execution capability pays for itself: reading a test file shows it
exists; running it with the guard removed shows whether it does anything.

**Explicitly rejected:** running stage 2 on every build (wastes budget on trivial changes);
binary skip-or-full (wastes the middle tier).

### D6 — Architect-authored plan and spec writes are attributed

**Decision.** Architect writes under the allow-listed plan/spec paths land as an
**Architect-authored ChangeSet** — attributed, in the audit, carrying no acceptance criteria.

**Why.** Today every repository change belongs to a task, a worker and a ChangeSet. An
unattributed Architect write would be the only change in the system with no owner.

**Explicitly rejected:** keeping plans in runner-private state and exporting on demand (splits
the plan away from git, where the owner reads it).

---

## 3. Honest limits of this design

Recorded so the plan does not oversell what it buys.

1. **Review has a ceiling.** Sorting the fifteen P6.5 defects by what would have been needed:
   roughly seven were findable by careful reading, roughly six were only provable by running,
   and a further class — timing, load, real-world behaviour — is findable by **neither**. As
   the owner put it: "sometimes things only show in real live and smoke tests anyway." That
   class belongs to P7 real-world qualification and is explicitly out of scope here.
2. **The Architect cannot repair runner-private state, and this design does not grant that.**
   Under D1 the Architect's "solve it" is realistically *retry after a transient cause
   passes*, or *waive with a reason*, or *stop*. The SQLite ledgers and workspaces under
   `stateDirectory` are written only by the runner itself, and opening them to an agent would
   undermine the fencing, ownership and replay guarantees that depend on them.
3. **Stage 2 costs a full model pass over the diff** whenever risk is medium or high, plus
   compute at high. D5 exists to bound that, but the cost is real and should be measured
   before it is assumed acceptable at scale.
4. **A blocking critic finding can halt a build.** That is intended — a critic that cannot
   block is a suggestion box, and the ~12 defect class from §1.1 would ship regardless — but
   it means a reader model gains the power to stop delivery, gated by Architect resolution.

---

## 4. Requirements this design creates

Stable IDs. The execution plan owns decomposition, ownership and acceptance routes.

| ID | Requirement | From |
|---|---|---|
| **AC-1** | A failed context-manifest write retries with bounded backoff before it is treated as failed. | D1 |
| **AC-2** | An exhausted recording failure writes a durable note to the scheduler store, not to the ledger that failed. | D1 |
| **AC-3** | An exhausted recording failure pauses the run and presents a typed decision to the Architect; the run never silently continues and never dies without the note. | D1 |
| **AC-4** | The Architect resolves it with exactly one of `retry`, `proceed_without_manifest` (rationale required), `abort`; each is durable and attributed. | D1 |
| **AC-5** | Each agent role's tool surface is an explicit allow-list, asserted at registration, failing closed on an unlisted tool. | D2 |
| **AC-6** | The Architect can run commands, subject to the run's permission profile. | D2 |
| **AC-7** | The Architect can write only under configured plan/spec paths; any other project write is refused. | D2 |
| **AC-8** | The verifier and critic can run commands **inside their own workspace only**; the user's project is never mutated by a reader. | D2 |
| **AC-9** | No reader role can commit, integrate, or complete the run; the verifier and critic additionally cannot alter the plan or review tasks. | D2 |
| **AC-10** | Reader roles admit only MCP tools declaring `readOnlyHint: true`, asserted. | D3 |
| **AC-11** | A change critique stage exists, runs at integration before the verifier, and reuses the existing finding, gate and resolution contracts. | D4 |
| **AC-12** | Change-critic selection excludes the Architect **and** every accepted change author. | D4 |
| **AC-13** | Stage 2 forms its findings before being shown its own stage-1 findings. | D4 |
| **AC-14** | Change risk is deterministic: identical change, identical risk; no clock, randomness, environment or model call. | D5 |
| **AC-15** | Change critique is graded low / medium / high, with a durable recorded skip at low. | D5 |
| **AC-16** | At high risk the critic runs the affected tests itself and its results are recorded as durable evidence. | D5 |
| **AC-17** | Architect plan/spec writes land as an attributed Architect-authored ChangeSet. | D6 |
| **AC-18** | Runs created before this change keep current semantics and remain replayable. | compatibility |

---

## 5. Open questions for the owner

None blocking. Recorded for the plan's investigation packets:

- **OQ-1** — the concrete thresholds for low / medium / high change risk. Needs measurement
  against real P6.5-era changes rather than a guessed constant.
- **OQ-2** — which paths form the Architect's write allow-list. `docs/superpowers/plans/`
  and `docs/superpowers/specs/` are the obvious candidates in this repository.
- **OQ-3** — whether "author model tier" is a declared per-runtime attribute or derived from
  the model catalogue. No such attribute exists today.
