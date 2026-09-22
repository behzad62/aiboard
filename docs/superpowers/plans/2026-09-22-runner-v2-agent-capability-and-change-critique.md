# Runner V2 — Agent capability model and change critique (execution plan)

**Revision 3.** Repairs the four BLOCKING conditions the r2 re-review found still open, the
one new BLOCKING D7 finding, and the four regressions revision 2 introduced
(`evidence/plan-review-r2.md`); revision 1's history is in `evidence/plan-review-r1.md`.
**Execution has not started.** Verdict in §11.

---

## 0. Source identity and parameters

| | |
|---|---|
| SOURCE | `docs/superpowers/specs/2026-09-22-runner-v2-agent-capability-model-design.md` |
| SOURCE status | APPROVED by owner; D7 added 2026-09-22 after review |
| Base revision | `6c166f97` on `main` |
| Prior phase | P6.5 review-gap closure, PR #98; lint cleanup PR #99 |
| PLAN_DIR | this file + `.superpowers/sdd/2026-09-22-runner-v2-agent-capability/` |
| PROJECT_RULES | `CLAUDE.md`, `AGENTS.md`, the Runner V2 Task 12 mandate |
| MAX_WORKERS | 4 permitted; **this plan derives 2, opening to 3** — see §5 |
| REPAIR_BUDGET | 3 evidence-backed cycles per tracked blocking issue |

### 0.1 Host capabilities — discovered, not assumed

| Capability | Actual support |
|---|---|
| Independent implementation workers | **Yes.** Cursor CLI, `grok-4.7-high`. |
| Independent reviewer, fresh context | **Yes.** Separate invocation; demonstrated by the r1 review. |
| Git worktrees | **Yes.** |
| Atomic task claims | **No.** The single controller serializes assignment. Procedural, not mechanical. |
| Harness-enforced state gates | **No.** §7 gates are procedural unless they land as kernel invariants. |
| Native launch chips | **No.** §10 provides copy-ready cards. |

### 0.2 Carried-forward execution amendments

1. **Affected-graph validation per packet.** Full `npm run test:runner-v2` runs exactly twice
   per program: entry baseline and the D1g exit gate.
2. **Node 24 only**, invoked as `C:\Program Files\nodejs\node.exe`.
3. **`--test-concurrency=1`** for any affected graph containing host or process fixtures.
4. **`public/*.zip`** are publication artifacts: packets leave them dirty, the controller
   reverts, and they are refreshed in a deliberate publication commit.

### 0.3 Inherited baseline, reusable under §6.4

At `6c166f97`: `npm run test:runner-v2` **3096 tests, 3091 pass, 0 fail, 5 skipped** plus 18
chained scripts PASS; both typechecks exit 0; `npm run build` exit 0, 20/20 routes;
`npx eslint .` exit 0 with 0 errors and 13 pre-existing warnings. The 5 skips are host gates
(2 Darwin, 2 POSIX, 1 win32).

---

## 1. Requirement ledger

| ID | Requirement | Source | Phase | Packets | Evidence required | Status |
|---|---|---|---|---|---|---|
| AC-1 | Failed manifest write retries with bounded backoff | D1 | B | B1 | stub failing N-1 times then succeeding records once, emits no note | PLANNED |
| AC-2 | Exhausted failure writes a durable note to the **scheduler store** | D1 | B | B2 | permanently failing stub → exactly one durable note carrying the reason | PLANNED |
| AC-3 | Exhausted failure pauses with a typed Architect decision **on all four agent paths**; never silently continues, never dies without the note | D1 | B | B2 | one test per path — architect, worker, verifier, critic; note present; **plus** a fail-closed test where the scheduler append itself throws. The **worker** path is mandatory and separate: `task-scheduler.ts:227-234` turns every `driver.run` rejection into a failed task, so a dispatcher-only catch never sees it | PLANNED |
| AC-4 | Exactly one of `retry` / `proceed_without_manifest` (rationale required) / `abort`, durable and attributed | D1 | B | B2 | one test per resolution; rationale-less waiver rejected **at the durable append boundary**; `retry` budget exhaustion re-pauses rather than looping | PLANNED |
| AC-5 | Each role's tool surface is an explicit allow-list, asserted, failing closed, **across every broker that role uses** | D2 | A | A1 | exact sorted list per role per broker; adding and removing an entry both redden | PLANNED |
| AC-6 | The Architect can run commands, subject to the run permission profile | D2 | A | A3 | Architect list contains the command tool; approval required under non-`full` | PLANNED |
| AC-7 | Architect project writes are refused outside the **I2-recorded allow-list** | D2 | A | A4 | success only for an I2-recorded path; refusal for a path outside the allow-list **and outside `runner-v2/src`** — a denylist of one prefix must not satisfy this | PLANNED |
| AC-8 | Verifier and critic command execution is confined to their own workspace | D2 | A | A3 | fixture project byte-identical after a reader run while the reader's copy may change; confinement proved against a fixture double, since `containedDirectory` already exists | PLANNED |
| AC-9a | **Verifier and critic** cannot commit, integrate, complete, alter the plan or review tasks | D2 | A | A1 | exact-list assertion on their brokers excludes every such tool | PLANNED |
| AC-9b | **The Architect retains** `review_task`, `request_integration` and `complete_run`; the allow-list must not delete them | D2 | A | A1 | assertion targets **both** the inspection broker and `createArchitectTools`; removing any of the three reddens | PLANNED |
| AC-10 | Reader MCP admission accepts only tools the mapper marks `readOnly`, as a **checked class**, not static list entries | D3 | A | A2 | stub server: `readOnlyHint` alone is refused; `readOnlyHint && !destructiveHint` is admitted; verifier and critic remain at zero MCP | PLANNED |
| AC-11 | A change critique stage runs at integration before the verifier, reusing finding, gate and resolution contracts | D4 | C | C2, C4 | ordering asserted; blocking findings hold integration; **`resolve_plan_critique` extended for `stage: "change"`**; zero-blocking auto-resolve preserved | PLANNED |
| AC-12 | Change-critic selection excludes the Architect **and** every accepted change author | D4 | C | C2 | emptying either exclusion reddens a **distinct** named test | PLANNED |
| AC-13 | Stage 2 forms findings before being shown its own stage-1 findings, and durably marks which remain open | D4 | C | C3 | turn-1 messages contain no stage-1 finding id or claim text; turn-2 does; a durable "remains open" mark exists | PLANNED |
| AC-14 | Change risk is deterministic; **a named producer computes the signals from a change** | D5 | C | C1 | repeated calls deep-equal; explicit kernel set and affected-test rule are named constants, not prose | INVESTIGATE (I1, I3) |
| AC-15 | Graded low / medium / high, with a durable recorded skip at low | D5 | C | C4 | one runtime test per tier | PLANNED |
| AC-16 | At high risk the critic runs **the affected tests** and the result is durable evidence cited by a finding | D5 | C | C4 | the recorded command must be the affected-test command from AC-14's rule — an arbitrary command must **not** satisfy it | PLANNED |
| AC-17 | Architect plan/spec writes land as an attributed Architect-authored ChangeSet **carrying no acceptance criteria** | D6 | A | A5 | ChangeSet stored with architect actor, present in audit, asserted to have no acceptance criteria | PLANNED |
| AC-18 | Pre-change runs keep current semantics and remain replayable | compat | A→D | **A0** records, D1g compares | fixture captured **before the first source packet**, replayed at D1g to an identical projection | PLANNED |
| AC-19 | Coverage obligations derive from the **original objective and durable user guidance**, never the Architect's criteria or plan, **in a session whose event list is empty at derivation** | D7 | E | E1, E2 | asserted on the deriving turn's **actual messages, tool results and loaded session** — not a section-id list — that the objective and guidance are present and no criteria, plan or diff text is. A section-id helper is not the acceptance | PLANNED |
| AC-20 | Obligations are durably recorded **before** the plan or diff is provided; the kernel refuses a coverage verdict with none recorded | D7 | E | E1, E2 | kernel gate reddens when deleted; ordering asserted | PLANNED |
| AC-21 | Verdict is per obligation — `covered` / `weakened` / `missing` — resolved through the **extended `resolve_plan_critique` path**, and blocking `missing`/`weakened` holds the build | D7 | E | E2, E3 | one test per verdict value; blocking holds integration; **a criterion that existed but was never exercised is expressible as `weakened` and must not collapse into `covered`** | PLANNED |
| AC-22 | The four new categories are accepted and malformed ones rejected, alongside the existing eight; **`scope_creep` and `unverified_claim` stay reportable even though they are not obligation-verdict values** | D7 | E | E1 | each new category round-trips; an unknown category is rejected; the existing eight still validate; a `scope_creep` finding carrying no obligation verdict is accepted | PLANNED |
| AC-23 | A cited evidence record not supporting its citing claim is reportable as `unverified_claim` | D7 | E | E2 | a seeded mismatch produces the finding; a matching citation does not | PLANNED |

### 1.1 Reverse traceability

| Packet | Requirements |
|---|---|
| I1, I2, I3 | investigation for AC-14/15, AC-7, AC-14 |
| A0 | AC-18 (capture) |
| A1 | AC-5, AC-9a, AC-9b (the brokers Lane A owns) |
| A1b | AC-9b (the `createArchitectTools` half) |
| A2 | AC-10 |
| A3 | AC-6, AC-8 |
| A4 | AC-7 |
| A5 | AC-17 |
| B1 | AC-1 |
| B2 | AC-2, AC-3, AC-4 |
| C1 | AC-14 |
| C2 | AC-11 (contracts), AC-12 |
| C3 | AC-13 |
| C4 | AC-11 (wiring), AC-15, AC-16 |
| C5 | AC-11 (surface) |
| E1 | AC-19, AC-20, AC-22 |
| E2 | AC-19, AC-20, AC-21, AC-23 |
| E3 | AC-21 (gate) |
| D1g | AC-18 (compare), program gate |

Every packet supports an obligation. Every applicable obligation has an owning packet.

---

## 2. Phases

**Phase I — investigation.** I1, I2, I3. Exit: each question answered against its decision
criterion. Unlocks A4 (I2) and C1 (I1, I3).

**Phase A — capability model.** A0, A1, **A1b**, A2, A3, A4, A5. Requirements AC-5..AC-10,
AC-17, AC-18 (capture). Entry: base `6c166f97`; **A0 runs first, before any source packet**
(the three investigations write evidence files only and may run beside it); I2 accepted
before A4.

**Phase B — manifest recording resolution.** B1, B2. Requirements AC-1..AC-4.
**Entry: after A0.** Phase B is **not** independent of Phase A for scheduling purposes —
see §5.2 for the surfaces it shares.

**Phase C — change critique.** C1..C5. Requirements AC-11..AC-16.

**One entry rule. C1 needs A0, I1 and I3 — nothing else.** Every later C packet carries its
own `Depends on` and those are authoritative. §5.1, both Lane C card lines and STATE state
this same rule and no other; r3 finding N-2 found the header and §5.1 still opening the lane
at B2.

C1 depends on **A0** because it writes source (`change-risk.ts`) — r3 finding N-9. The
"no source before A0" rule has no exceptions; only the three investigations, which write
evidence files alone, may run beside A0.

**Phase E — coverage review.** E1, E2, E3. Requirements AC-19..AC-23. Entry: C2 integrated
(shares the critique contracts).

**Phase D — program gate.** D1g. Requirements AC-18 (compare) and program closure.

---

## 3. Packet contracts

### 3.0 Shared packet rules

**Writable surfaces** are listed per packet and **each packet's list includes the test files
it must add or edit**. Everything else is forbidden, including `public/*.zip` and any file
another lane holds (§5.2). `runner-v2/test/filesystem-mutation-routing.test.ts` is
**controller-owned**: a packet that introduces a new `node:fs` importer reports it and stops.

**Definition of Done** (every packet): every mandatory criterion has evidence; prove-red
performed per new guard and restored byte-exact with a hash; affected graph green with a
recorded scope rationale; both typechecks exit 0; ESLint introduces no new error or warning;
independent review has no unresolved mandatory finding; the worker did **not** commit, stage
or stash.

**Injection discipline** — each of these cost a real defect in P6.5 or was caught by the r1
review:
- Prove the injection changed the file (bytes or SHA-256) **before** reading the result.
- Probe a type-level injection with `npx tsc --noEmit`, never a `tsx` run.
- Assert **exact sorted allow-lists**; prove both directions.
- **Check whether the behaviour you are "adding" already exists.** If an equivalent guard is
  already present elsewhere, your prove-red will not redden and your packet proves nothing.
- An assertion that passed before the feature existed proves nothing until it can fail.
- Before reporting done, grep the tests and confirm every new export is constructed or called.

---

### I1 — Change-risk thresholds (investigation)

Deliverable `evidence/I1.md`: measured signal values for each of the 14 P6.5 packet commits
and the tier each candidate threshold set assigns.

**Decision criterion (strengthened after r1 finding I-7).** Thresholds are accepted only if,
replayed over the P6.5 commits: **(a)** no commit containing a review-found defect lands in
`low`; **(b)** at least one trivially safe commit lands in `low`; **and (c) at least one
commit whose defect was only provable by execution lands in `high`.** Without (c) the
execution tier can be empty while the criterion passes.

Writable: `evidence/I1.md`. Unlocks C1.

### I2 — Architect write allow-list (investigation)

Deliverable `evidence/I2.md`: the proposed path set, the configuration surface, and each
candidate checked against `tsconfig` includes, `next.config` and the test globs.
**Decision criterion:** the set excludes every path that can affect built output or test
outcome. Writable: `evidence/I2.md`. Unlocks A4.

### I3 — Author model tier (investigation)

Deliverable `evidence/I3.md`: what `acceptedChangeAuthorRuntimeIds` already yields and the
recommended source of tier. **Decision criterion:** available inside the runner without a
network call, and deterministic. Writable: `evidence/I3.md`. Unlocks C1.

---

### A0 — Capture the compatibility fixture (must run first)

| | |
|---|---|
| Phase A · Requirements | AC-18 (capture) |
| Outcome | A pre-change scheduler projection fixture exists in the tree, so D1g has a "before" to compare against. |
| Writable | `runner-v2/test/support/pre-capability-run.fixture.json` (new), `runner-v2/test/replay-compatibility.test.ts` (new) |
| Depends on | nothing. **No source packet may start until A0 is integrated.** |

**Why first.** After A, B, C and E land, "before" cannot be recorded from the integrated tree.
Raised by r1 finding I-8.

**Steps.** Drive a representative run at `6c166f97` — plan, one worker task, a verifier
verdict, a context manifest — and serialise the resulting projection and event list. Add a
test that replays the fixture and asserts the projection deep-equals the stored one.

**Acceptance.** The replay test passes at `6c166f97`. It is the same test D1g re-runs.

**Prove-red.** Mutate one field of the stored projection → the replay test reddens.

---

### A1 — Per-role tool allow-lists, asserted across every broker

| | |
|---|---|
| Phase A · Requirements | AC-5, AC-9a, AC-9b |
| Writable | `native-architect-runtime.ts`, `native-verifier-runtime.ts`, `native-plan-critic-runtime.ts`, `worker-runtime.ts`, new `role-capabilities.ts`, new `runner-v2/test/role-capabilities.test.ts`, and the existing tests asserting those brokers |
| Forbidden | `tool-broker.ts`, every tool implementation, all B / C / E surfaces |
| Depends on | **A0 integrated** |

**Two brokers, not one.** r1 finding B-2. Each role's surface is composed from more than one
registration site:

| Role | Inspection / extras broker | Lifecycle tools |
|---|---|---|
| Architect | `native-architect-runtime.ts` | `createArchitectTools` registered at `build-runtime.ts:1416` |
| Verifier | `createInspectionTools` | its verdict tool |
| Critic | `createInspectionTools` | its critique tool |
| Worker | `worker-runtime.ts` | its lifecycle tools |

`assertRoleToolSurface` must be applied to **the role's full composed surface**, not one
broker. AC-9b exists because `request_integration` (`architect-tools.ts:1482`) and
`complete_run` (`architect-tools.ts:1528`) are legitimate Architect authority that D2 keeps —
an assertion on the inspection broker alone would pass while proving nothing.

**`build-runtime.ts` is held by Lane B until B2 integrates.** A1 therefore lands the
allow-list and the assert for the brokers it owns, and the Architect lifecycle assertion is
added by **A1b**, a controller-scheduled follow-on that runs after B2 releases that file. A1
is not accepted until A1b is accepted; they share one evidence file.

**Third filter.** `PlanOnlyInspectionRuntime` (`native-architect-runtime.ts:707-714`) uses a
**different** predicate — `readOnly && effect !== "workspace"`. r1 finding I-5. A1 must route
it through the same allow-list or its surface will drift.

**Steps.** Derive today's effective list per role **by construction**, not by reading code.
Replace each filter with admission against the named list. Add `assertRoleToolSurface`,
modelled on `assertReadOnlyInspectionDefinition`, throwing on an admitted tool absent from the
list and on a list entry never admitted. **No capability is added in this packet.**

**Prove-red.** Per role and per broker: add a forbidden entry → red; remove a required entry →
red; admit without listing → the assert throws. For AC-9b: remove `complete_run` from the
Architect list → red.

**Validation scope.** Every test importing any of the four runtimes or `createArchitectTools`.

### A1b — Architect lifecycle allow-list on `createArchitectTools`

| | |
|---|---|
| Phase A (lane B) · Requirements | AC-9b (the `createArchitectTools` half) |
| Outcome | The Architect's lifecycle tool surface is asserted by the same allow-list, so AC-9b is proved on the broker where those tools actually live. |
| Writable | `build-runtime.ts` (the `createArchitectTools` registration at `:1416`) and the affected tests **only** |
| Forbidden | everything Lane A holds; the tool implementations |
| Depends on | **A1**, **B2 integrated**, and **must integrate before C4 takes `build-runtime.ts`** |

**Why it is a separate packet.** r2 finding B-2 and regression 1. Revision 2 referred to A1b in
prose but never gave it a contract, a traceability row, a phase listing or a graph node, so a
controller could not assign it — and §5.2 did not order it ahead of C4, so A1b and C4 could
both edit `build-runtime.ts`.

**Steps.** Apply `assertRoleToolSurface` — already defined by A1 in `role-capabilities.ts` —
to the Architect's composed surface including `request_integration`
(`architect-tools.ts:1482`), `complete_run` (`:1528`) and `review_task` (`:1338`).

**A1b does not write `role-capabilities.ts`.** r3 finding N-5: A1b depends on A1 and B2, not on
A2/A3/A4, so Lane B could reach A1b while Lane A still held that file. A1 lands every
allow-list entry A1b needs; A1b only applies the assert at the second registration site.

**Acceptance.** Removing any of those three from the Architect allow-list reddens a named test.
Adding a verifier-only tool reddens a different one.

**A1 and A1b are one acceptance unit.** A1 is not accepted until A1b is; they share one
evidence file.

---

### A2 — MCP admission for the Architect

| | |
|---|---|
| Phase A · Requirements | AC-10 |
| Writable | `native-architect-runtime.ts`, `role-capabilities.ts`, `runner-v2/test/role-capabilities.test.ts`, `runner-v2/test/mcp-tools.test.ts` |
| Forbidden | `mcp-tools.ts`, the verifier and critic runtimes, worker MCP admission |
| Depends on | **A1** |

**A checked class, not list entries.** r1 finding B-3. MCP tool names come from the server and
cannot be static allow-list entries. A2 adds a *class* rule to the admission path: a
dynamically named tool is admitted iff `tool.definition.readOnly === true` as set by
`createMcpTools` — which requires `readOnlyHint === true` **and** `destructiveHint === false`
(`mcp-tools.ts:156-159`) — and `assertRoleToolSurface` treats class-admitted names as valid.

**Scope is the Architect only.** The verifier and critic receive zero MCP tools today, and
`assertReadOnlyInspectionDefinition` rejects `effect !== "external"`… precisely, it rejects
`effect !== "none"`, so it could never admit one. This packet does **not** change that, and
the SOURCE records it as deliberate.

**Acceptance.** A stub server exposing (a) `readOnlyHint: true, destructiveHint: false`,
(b) `readOnlyHint: true` with `destructiveHint` absent, and (c) neither: only (a) is admitted
for the Architect. Verifier and critic lists remain MCP-free.

**Prove-red.** Drop the `destructiveHint` half of the predicate → (b) is admitted → red.

---

### A3 — Reader command execution, workspace-confined

| | |
|---|---|
| Phase A · Requirements | AC-6, AC-8 |
| Writable | the four runtimes, `role-capabilities.ts`, **`agent-prompts.ts`**, the affected tests |
| Forbidden | `evidence-tools.ts`, `tool-broker.ts` |
| Depends on | **A1** |

**The prompt must change with the capability.** r1 finding I-4.
`VERIFIER_AUTHORITY_INVARIANTS` still says "Use only the provided read-only inspection tools."
A3 owns `agent-prompts.ts` so the authority sentence is corrected in the same packet that
grants execution. **The authorship prohibitions stay exactly as they are** — only the
read-only-tools sentence changes.

**Workspace per role, stated explicitly.** r1 finding I-2.

| Role | Execution root | May it write project code? |
|---|---|---|
| Verifier | its verification workspace (`workspace.path`) | no |
| Critic | its disposable workspace (`native-plan-critic-runtime.ts:154-156`) | no |
| Architect | `projectRoot` (`native-architect-runtime.ts:248`) | **decision below** |

**Architect execution decision.** An Architect command running in `projectRoot` could write
project code, which would defeat D2's filesystem boundary by another route. This packet
confines Architect execution to a **disposable copy** as well, matching the readers. If the
owner later wants Architect commands against the live project, that is a separate decision.

**Confinement already exists.** `containedDirectory` (`evidence-tools.ts:243-255`) already
rejects an escaping `cwd`, and A3 may not edit that file. A prove-red that removes a *second*
check will not redden. A3's prove-red therefore uses a **fixture double** of the execution
context with the containment stubbed out, and asserts the runtime-level confinement refuses
independently.

**Acceptance.** AC-6 as stated. AC-8: after a full verifier or critic run against a fixture
project, the fixture project tree is byte-identical while the reader's copy may differ.

---

### A4 — Architect path-scoped writes

| | |
|---|---|
| Phase A · Requirements | AC-7 |
| Writable | `native-architect-runtime.ts`, `role-capabilities.ts`, `filesystem-tools.ts`, `runner-v2/test/filesystem-tools.test.ts` |
| Depends on | **A1**, **I2 accepted** |

**Acceptance (strengthened after r1 finding I-3).** A write to a path **I2 recorded** succeeds.
A write to a path outside the allow-list **and outside `runner-v2/src`** — for example under
`lib/` or `app/` — is refused. Testing only a `runner-v2/src` refusal would be satisfied by a
one-prefix denylist, which is not the requirement.

**Prove-red.** Replace the allow-list with a `runner-v2/src` denylist → the `lib/` refusal test
reddens.

**Cleanup note.** A new `node:fs` importer must be **reported** to the controller for the
reviewed-owner list; the packet does not edit that test.

### A5 — Architect ChangeSet attribution

| | |
|---|---|
| Phase A (lane B) · Requirements | AC-17 |
| Writable | `change-set.ts`, **`native-build-factory.ts`** (the `acceptedChangeSessions` filter at `:2725-2743`), `native-architect-runtime.ts`, `build-runtime.ts`, `scheduler-store.ts`, the affected tests |
| Depends on | **A4**, **B2 integrated**, and **before C2 and C4 take their §5.2 turns** |

**Why the surface is larger than revision 2 said.** r2 finding B-4. The audit list is
`acceptedChangeSessions`, which keeps a session only when `actor.role === "worker"` and the id
is an integrated task's `changeSetId`. `ChangeSet` has **no actor field** at all. So AC-17
needs three things revision 2 left to the worker: an actor on the ChangeSet, a relaxation of
that worker-only filter, and a stated commit mechanism. All three are named here, and
`native-build-factory.ts` — where the filter lives — is in the writable list.

**Commit mechanism, named rather than deferred.** r3 finding N-3 rejected "define how" as a
step. The concrete mechanism:

| Requirement | What satisfies it |
|---|---|
| a workspace | `WorkspaceManager.createTaskWorkspace` with a reserved architect id; every commit API in the tree needs a task workspace, including `commitTask` (`workspace-manager.ts:129`) |
| `taskId` in `createChangeSet` | that reserved architect id, e.g. `architect:plan`, **not** a planned task |
| `taskCommit` | `WorkspaceManager.commitTask(<architect id>, summary)` |
| at least one evidence hash | the written file's own content hash |
| an actor on the ChangeSet | a new `actor` field on `ChangeSet`, since it has none today |
| appearing in the audit | `acceptedChangeSessions` (`native-build-factory.ts:2725-2743`) must relax **both** the `actor.role === "worker"` check **and** the integrated-task-id lookup, because a reserved architect id is not an integrated task |

Relaxing only the role check leaves the change invisible in the audit — the lookup is the
second gate, and r3 named it specifically.

**Why a separate packet.** r1 finding B-4. `createChangeSet` (`change-set.ts:63-100`) requires
a `taskId`, a `taskCommit` and at least one evidence hash, and throws on empty evidence.
An Architect write has none of those. AC-17 is **not reachable** from A4's surface, and the
packet that satisfies it must own the ChangeSet constructor.

**Steps.** Define how an Architect write obtains a commit without a worker task, extend the
constructor for an architect-authored ChangeSet with no acceptance criteria, and route it into
the audit export.

**Acceptance.** The stored ChangeSet has an architect actor, appears in the audit export, and
is **asserted to carry no acceptance criteria**.

---

### B1 — Bounded retry inside `recordContextPack`

| | |
|---|---|
| Phase B · Requirements | AC-1 |
| Writable | `context-manifest-store.ts`, `runner-v2/test/context-manifest-store.test.ts` |
| Forbidden | **every runtime call site**, `scheduler-store.ts`, `build-runtime.ts` |
| Depends on | **A0 integrated** |

**Restructured after r1 finding B-1.** The original contract said "the three recording call
sites". There are **five, in four files**, three of which Lane A owns and one
(`native-worker-driver.ts`) that was on no roster. Editing them from Lane B would have been a
parallel-write collision.

**The fix is structural: no call site changes.** `recordContextPack` retries internally and,
on exhaustion, throws a typed `ContextManifestRecordingError` carrying purpose, task id,
attempt, revision, attempts made and the underlying reason. The five call sites already
`await` without catching, so the error propagates unchanged. B2 converts it into a note and a
pause at the dispatcher, which is a file Lane B already owns.

**Acceptance.** A stub failing N-1 times then succeeding records exactly once and throws
nothing. A permanently failing stub throws the typed error after exactly the bounded number of
attempts.

**Prove-red.** Remove the retry → the transient stub throws → red. Make the bound unbounded →
a never-succeeding stub does not terminate within the test timeout → red.

### B2 — Note, pause and Architect resolution

| | |
|---|---|
| Phase B · Requirements | AC-2, AC-3, AC-4 |
| Writable | `build-runtime.ts`, **`task-scheduler.ts`**, `architect-tools.ts`, `user-steering-contracts.ts`, `scheduler-store.ts`, `lib/client/runner-v2.ts`, `components/RunnerV2ObservabilityPanel.tsx`, the affected tests and the two UI scripts |
| Depends on | **B1** |

**The worker path does not reach the dispatcher.** r2 finding B-1. `task-scheduler.ts:227-234`
catches **every** `driver.run` rejection and calls `recordOutcome(..., { type: "failed" })`,
which transitions the task to `failed` (`:290-292`). `build-runtime.ts:837-838` only ticks and
awaits idle, and that promise already resolved inside the scheduler's catch. A dispatcher-only
catch therefore sees the architect, both verifier and the critic paths — and **never the
worker**. The run would continue with a burnt task attempt and no note, while every test
written against the other three paths passed.

**Do not re-raise.** r3 finding N-1: re-raising reaches `awaitIdle` and runs `finally`, but it
skips `recordOutcome`, so the task stays `running` and the next `tick` dispatches it straight
back into the same error. An uncaught rejection becomes `autonomous_pump_error`
(`native-build-manager.ts:729-736`) and the note is never written.

**Use the pause outcome that already exists.** `task-scheduler.ts:278-288` handles
`outcome.type === "paused"` by appending `run.paused` and **returning without transitioning
the task to `failed`**. B2's catch therefore, on `ContextManifestRecordingError` only:
appends the `context_manifest.recording_failed` note, then calls `recordOutcome` with the
existing `paused` outcome. `awaitIdle` resolves, `build-runtime.ts:840` sees the pause, and
the task is neither failed nor redispatched. Every other rejection keeps today's
`type: "failed"` behaviour exactly.

**`proceed_without_manifest` must be able to resume.** A waiver is useless if the resumed
worker throws again at the same call. B1 therefore gives `context-manifest-store.ts` a
run-scoped **recording-suspended registry**: `recordContextPack` checks it and returns
`undefined` early. B2's dispatcher sets it when a waiver is recorded, and re-sets it on
restart by reading the durable waiver from the projection. This works for all five call sites
and **changes none of them**.

AC-3 requires a separate named test per agent path; the worker test is the one that proves
this, and it must assert the task is **not** `failed` and **not** redispatched.

**Steps.** Catch `ContextManifestRecordingError` at the dispatcher. Append
`context_manifest.recording_failed` to the scheduler store, then pause with the typed reason.
Add `resolve_context_recording_failure` with the three resolutions, the reducer cases and the
surface, mirroring the four existing pause-and-decide flows.

**Bounded `retry`.** r1 finding I-1. The Architect's `retry` consumes a finite budget;
exhausting it re-pauses with the existing note rather than looping.

**Fail-closed when the note itself cannot be written.** r1 finding I-1. If the scheduler
append throws, the run must not continue the model call. Tested explicitly.

**Acceptance.** AC-2, AC-3 (including the scheduler-append-throws case), AC-4 (one test per
resolution; rationale-less waiver rejected at the durable append boundary; retry-budget
exhaustion re-pauses).

**On release — B2 releases nothing on its own.** r3 finding N-4: revision 3's release sentence
here and in the Lane B card handed `build-runtime.ts` and `scheduler-store.ts` to Lane C at
B2, which is exactly the A1b/A5 race §5.2 forbids. The release is the **controller's single
announcement**, made only after B2, A1b **and** A5 have integrated, per §5.2. B2 unblocks A1b
and A5. It unblocks nothing in Lane C.

---

### C1 — Deterministic change-risk assessment and its producer

| | |
|---|---|
| Phase C · Requirements | AC-14 |
| Writable | new `change-risk.ts`, new `change-risk.test.ts` |
| Depends on | **A0 integrated**, **I1 accepted**, **I3 accepted** |

**A producer, not only a pure function.** r1 finding I-7. This packet delivers both
`assessChangeRisk(input)` **and** `collectChangeRiskSignals(projection, changeSet)` which
computes the six signals from a real change. It also defines, as named exported constants:
the **kernel surface set** and the **affected-test rule**. Prose definitions are not
acceptable — AC-16 depends on the affected-test rule being mechanically derivable.

**Acceptance.** Identical input deep-equals across calls; evidence ordering stable; the module
contains no `Date`, `Math.random`, `process.env` or model call.

**Prove-red.** Each signal removed alone → a distinct named test reddens. Add a `Date.now()`
term → the determinism test reddens.

### C2 — Change critique contracts, events and selection

| | |
|---|---|
| Phase C · Requirements | AC-11 (contracts), AC-12 |
| Writable | `plan-critique-contracts.ts`, `scheduler-store.ts`, `plan-critique-authority.ts`, `architect-tools.ts` (extend `resolve_plan_critique` for `stage: "change"`), the affected tests |
| Depends on | **C1**, **B2 integrated**, **A5 integrated** (A5 writes `scheduler-store.ts` after B2 — r3 finding N-3) |

**Resolution behaviour is reused, not just the finding type.** r1 finding I-6. Extend
`resolve_plan_critique` to accept `stage: "change"`, preserve the zero-blocking auto-resolve
path (`build-runtime.ts:1684-1692`), and add the durable field C3 needs to mark a stage-1
finding as still open.

**Acceptance.** AC-12: emptying the Architect exclusion reddens one named test; emptying the
author exclusion reddens a **different** one. Plan-stage behaviour byte-identical — prove by
running the whole existing plan-critique suite unchanged.

### C3 — Change critic runtime, blind-first

| | |
|---|---|
| Phase C · Requirements | AC-13 |
| Writable | `native-plan-critic-runtime.ts`, `agent-prompts.ts`, the affected tests |
| Depends on | **C2**, **A1 integrated**, **A3 integrated** (r1 finding B-5: A3 also writes this runtime and `agent-prompts.ts`) |

**Acceptance.** Turn-1 messages contain no stage-1 finding id or claim text; turn-2 messages
contain them; the exact stage-2 tool list is asserted; a durable "remains open" mark is
produced on turn 2.

**Review focus.** This is the anchoring guarantee. Confirm the findings cannot reach turn 1
through **any** channel — context pack, prompt, tool result or session replay — using the same
tool-surface reasoning that found the P6.5.6 `git.show` leak.

### C4 — Dispatcher stage and graded response

| | |
|---|---|
| Phase C · Requirements | AC-11 (wiring), AC-15, AC-16 |
| Writable | `build-runtime.ts`, `native-build-factory.ts`, the affected tests |
| Depends on | **C3**, **A3 integrated**, and the controller's release announcement after **B2 + A1b + A5** (r3 findings N-3, N-4, N-7) |

**AC-16 must not be vacuous.** r1 finding I-7. The high-tier test asserts that the recorded
command **is the affected-test command derived by C1's rule**. An arbitrary command such as
`echo ok` must not satisfy it, and the prove-red replaces the command with an arbitrary one to
show the assertion reddens.

**Acceptance.** Ordering: critic before verifier. Blocking findings hold integration. One
runtime test per tier; low records a durable skip and advances.

### C5 — Client, UI and audit surface

| | |
|---|---|
| Phase C · Requirements | AC-11 (surface) |
| Writable | `lib/client/runner-v2.ts`, `components/RunnerV2ObservabilityPanel.tsx`, the two scripts |
| Depends on | **C4** |

Every stage-2 state renders, including the absent case; differing severity mixes render
differently. Re-verify — do not assume — that `lib/client/native-build-activity.ts` still maps
no event types.

---

### E1 — Coverage contracts and blind derivation

| | |
|---|---|
| Phase E · Requirements | AC-19, AC-20, AC-22 |
| Writable | `plan-critique-contracts.ts`, `scheduler-store.ts`, `agent-prompts.ts`, the affected tests |
| Depends on | **C2 integrated**, **C3 integrated** |

**Why C3 and not only C2.** r2 regression 2. §5.2 sequences `agent-prompts.ts` as A3 → C3 →
E1/E2. With a C2-only dependency, E1 and C3 could both hold that file after C2 integrated.

**Steps.** Add the four categories. Add a `coverage_obligations_recorded` event and the kernel
gate that refuses a coverage verdict with none recorded — modelled directly on RG-6's
expectations gate. Add the derivation context builder, which carries the **objective and
durable user guidance only**.

**Acceptance.** AC-19 is **not** accepted here. r3 finding N-8: E1's section-id assertion is a
**helper**, and a worker graded on it could satisfy this paragraph while the deriving session
already held the plan. AC-19 is accepted on E2's message, tool-result and loaded-session
assertions. E1 delivers the helper and is graded on AC-20 and AC-22 only.
AC-20: the gate reddens when deleted. AC-22: each new category round-trips; an unknown one is
rejected; the existing eight still validate.

### E2 — Coverage review stages

| | |
|---|---|
| Phase E · Requirements | AC-19, AC-20, AC-21, AC-23 |
| Writable | `native-plan-critic-runtime.ts`, `agent-prompts.ts`, the affected tests |
| Depends on | **E1**, **C3 integrated** |

**A fresh session is part of the requirement, not an implementation detail.** r2 finding D7-1.
The live critic session is created before the critique and already carries the plan
(`native-plan-critic-runtime.ts:175-194`), so a derivation turn inside it is not blind however
the context pack is composed. E2 must open a **new session whose event list is empty at
derivation**.

**The acceptance asserts the turn, not a section list.** A section-id check is a helper, not
the proof. E2 asserts on the deriving turn's **actual messages, tool results and loaded
session state** that the objective and durable user guidance are present and that no criteria,
plan or diff text is — covering the four channels named in the SOURCE and the two the r2
review added: **session replay and an earlier-turn checkpoint**.

**Prove-red.** Derive inside the existing critic session → the empty-event-list assertion
reddens. Replay a checkpoint carrying the plan into the deriving turn → the message assertion
reddens. A section-id-only check must be shown **not** to redden in either case, which is why
it is not the acceptance.

Stage 1 derives from the objective before the plan is provided; stage 2 before the diff.
Verdicts are per obligation. AC-23: a seeded evidence/claim mismatch produces
`unverified_claim`; a matching citation does not.

**OQ-4 — one predicate, and it does not contradict D5.** r3 finding N-6 rejected revision 3's
wording: defect-hunting already starts at `medium`, so "one tier lower" was the same floor,
and stage 1 runs before a change exists so change risk is not even a stage-1 input.

The recorded default: **stage-1 coverage review is never skipped.** It runs on every run that
produces a plan, including a low-plan-risk run where the plan critique itself is skipped.
Stage-2 coverage follows D5's tiers with `low` raised to `medium` — that is the "harder to
skip" the SOURCE recommends, expressed as a real difference rather than a slogan.

Acceptance: a low-plan-risk run still records coverage obligations. The owner may override
before Phase E starts.

### E3 — Coverage gate and surface

| | |
|---|---|
| Phase E · Requirements | AC-21 (gate) |
| Writable | `build-runtime.ts`, `lib/client/runner-v2.ts`, the panel, the two scripts, the affected tests |
| Depends on | **E2**, **C4 integrated** |

A blocking `missing` or `weakened` verdict holds the build until resolved through the extended
resolution path.

---

### D1g — Compatibility and program gate

Depends on A, B, C, E accepted. Independent source-to-delivery reconciliation per §9, then
AC-18's replay of the **A0 fixture**, then the full suite, then the publication commit.

---

## 4. Dependency graph

Edges below are the authoritative graph. The packet "Depends on" fields match it exactly.

```
A0 ──► A1 ──► A2
  │     ├──► A3 ───────────────────┐
  │     └──► A4 ──► A5             │
  │            ▲     ▲             │
I2 ────────────┘     │             │
                     │             │
A0 ──► B1 ──► B2 ────┼──► A1b ─────┼──────┐
                     │      │      │      │ (A1b before C4)
                     ├──────┴──────┼──────┼──► C2 ──► C3 ──► C4 ──► C5
                     │             │      │     ▲       ▲      ▲
I1 ─┬──► C1 ─────────┴─────────────┴──────┴─────┘       │      │
I3 ─┘                               A1 ─────────────────┘      │
                                    A3 ────────────────────────┘

                          C2 ──► E1 ──► E2 ──► E3
                          C3 ──────┘      ▲      ▲
                                   C3 ────┘  C4 ─┘

all ──► D1g
```

**The authoritative edge list.** Every packet's `Depends on` field and every STATE row is a
copy of this and contains nothing else. r3 finding N-7 found three edges living in a contract
or in STATE but not here.

```
A0 → A1        A0 → B1        A0 → C1
I2 → A4        I1 → C1        I3 → C1
A1 → A2        A1 → A3        A1 → A4        A1 → A1b        A1 → C3
A3 → C3        A4 → A5
B1 → B2        B2 → A1b       B2 → A5        B2 → C2
A1b → C4       A5 → C2        A5 → C4        A3 → C4
C1 → C2 → C3 → C4 → C5
C2 → E1        C3 → E1        C3 → E2        C4 → E3
E1 → E2 → E3
A4 → D1g   A5 → D1g   C5 → D1g   E3 → D1g
```

**A0 gates every packet that writes source.** r2 regression 4: revision 2's caption said
"A0 → everything", which the drawing did not show and which is not true of I1, I2 and I3 —
those write only an evidence file and may run beside A0. The rule is: **no packet writes a
source file before A0 integrates.**

Acyclic. **Longest path is 9**, not the 8 revision 3 claimed (r3 finding N-10, which the
E-chain edges lengthened): `A0 → B1 → B2 → C2 → C3 → E1 → E2 → E3 → D1g`.

---

## 5. Lanes, ownership and serialized surfaces

### 5.1 Lane roster

| Lane | Packets | Owner of |
|---|---|---|
| **Lane A** | I2 → A1 → A2 → A3 → A4 | the four agent runtimes, `role-capabilities.ts`, `filesystem-tools.ts`, `agent-prompts.ts` (A3) |
| **Lane B** | A0 → I1 → I3 → B1 → B2 → A1b → A5 (A1b and A5 both before Lane C may take `build-runtime.ts`) | `context-manifest-store.ts`, `architect-tools.ts`, `user-steering-contracts.ts`, `change-set.ts`, and `scheduler-store.ts` + `build-runtime.ts` + the client surface **until B2** |
| **Lane C** | C1 → C2 → C3 → C4 → C5 → E1 → E2 → E3 | `change-risk.ts`, the critique surfaces; **inherits `scheduler-store.ts` + `build-runtime.ts` after B2** |

**I1 and I3 belong to Lane B. Only Lane B.** r1 finding B-5 — revision 1 assigned them twice.
Lane C does not open until B2 integrates, so Lane B carries the investigations.

**A0 is Lane B's first packet and gates every other source packet**, including Lane A's.

### 5.2 Serialized surfaces — one owner at a time

| Surface | Owner sequence, in order | Why |
|---|---|---|
| `build-runtime.ts` | B (B2) → B (**A1b**) → B (A5) → C (C4) → C (E3) | dispatcher, the Architect lifecycle assertion, and the Architect ChangeSet. **A1b and A5 both precede C4** — r2 finding B-2 and regression 3 |
| `scheduler-store.ts` | B (B2) → B (A5) → C (C2) → C (E1) | event union and reducer |
| `native-build-factory.ts` | B (A5) → C (C4) | the `acceptedChangeSessions` audit filter lives here — r2 finding B-4 |
| **`task-scheduler.ts`** | B (B2) only | its catch must re-raise the typed recording error — r2 finding B-1 |
| `native-plan-critic-runtime.ts` | A (A1, A3) → C (C3) → C (E2) | tool admission before stage logic |
| `agent-prompts.ts` | A (A3) → C (C3) → C (E1, E2) | the authority sentence changes with the capability; **E1 depends on C3** so this file has one owner at a time — r2 regression 2 |
| `native-architect-runtime.ts` | A (A1, A2, A3, A4) → B (A5) | A5 needs it after A4 |
| `architect-tools.ts` | B (B2) → C (C2) | resolution tools |
| `lib/client/runner-v2.ts`, the panel | B (B2) → C (C5) → C (E3) | one client mirror |
| `plan-critique-contracts.ts` | C (C2) → C (E1) | one contract owner |
| `filesystem-mutation-routing.test.ts` | **controller only** | shared reviewed-owner audit list |
| the five `recordContextPack` call sites | **nobody edits them** | B1 throws a typed error instead — r1 finding B-1 |

**Lane B holds `build-runtime.ts` longer than revision 2 implied.** It is released to Lane C
only after B2, A1b **and** A5 have integrated. The controller announces that release; until
then C4 is blocked, and the Lane C card says so.

Different files do not prove independence. Lane A changes what tools every role receives;
Lane C constructs agents. **Lane C rebases onto integrated Lane A work before C3.**

### 5.3 Controller

One controller owns assignment (no atomic claim primitive — §0.1), integration order, the
reviewed-owner audit list, the ledger, the A1/A1b pairing and acceptance state. Workers own
only their lane surfaces and their evidence file, and never commit.

---

## 6. Validation and evidence policy

**6.1 Scope.** Impact-based: the packet's own tests, every test importing a changed shared
kernel surface, plus consumers found by inspecting callers. Rationale recorded per packet.

**6.2 Full suite.** Exactly twice — the §0.3 baseline and D1g. Accepted trade-off: an escape
surfaces at the exit gate and is located by bisecting per-packet commits. This happened once
in P6.5 and the gate caught it.

**6.3 Evidence records.** Requirement and condition; tested revision plus uncommitted-diff
identity; command, environment, inputs; outcome with exit status and counts; log paths; review
disposition. Zero selected tests, unexplained skips and prose-only claims do not prove
acceptance.

**6.4 Reuse.** The §0.3 baseline applies while the relevant code, dependencies, configuration
and environment are unaffected, and the record must say why. A documentation-only commit does
not invalidate behavioural evidence.

**6.5 Fault injection.** Disposable fixtures only. Remove the injection, retain the regression
test, restore byte-exact and prove it by hash.

---

## 7. Review and acceptance

**Planning review.** One independent coverage review by a fresh-context reviewer reading the
SOURCE. Revision 1 was reviewed (`evidence/plan-review-r1.md`, PLAN COVERAGE INSUFFICIENT,
5 BLOCKING + 9 IMPORTANT). **Revision 2 requires a re-review of the corrections and affected
coverage** before PLAN READY.

**Packet review.** One independent review per packet; a worker never self-accepts. Covers
source obligations, the actual diff and surrounding behaviour, evidence reliability, missing
behaviour and regressions, scope compliance.

**Acceptance.** Every mandatory criterion evidenced; no unresolved mandatory finding;
integration and affected-boundary checks passed; state records reflect it.

**Gate enforcement is procedural** (§0.1). States: PLANNED, READY, RUNNING, IN_REVIEW,
READY_TO_INTEGRATE, BLOCKED, ACCEPTED.

---

## 8. Repair policy

REPAIR_BUDGET 3 evidence-backed cycles per tracked blocking issue, counted across sessions and
agents. A cycle is a substantive correction plus validation. Related symptoms of one root
cause share a record; renaming does not reset the budget. Escalate only for a genuine
authority decision, an unsafe action, an unresolved requirement conflict, an owner-dependent
blocker, a proposed weakening of a control, or an exhausted budget.

---

## 9. Program closure

1. Independent source-to-delivery reconciliation against the SOURCE, before the expensive
   suite. Reuse accepted packet reviews.
2. Repair omissions with targeted validation.
3. AC-18: replay the A0 fixture and assert an identical projection.
4. Full `npm run test:runner-v2`, both typechecks, ESLint, `npm run build`.
5. Publication commit refreshing `public/*.zip`.
6. Ledger reconciled; every row evidenced or explicitly dispositioned.

"Complete" means the agreed obligations are verified. SOURCE §3 records what this program
cannot catch.

---

## 10. Launch cards

### Controller
> Read `.superpowers/sdd/2026-09-22-runner-v2-agent-capability/STATE.md`, then §5 and §7. You
> own assignment, integration order, the reviewed-owner audit list, the A1/A1b pairing, and
> acceptance. There is no atomic claim primitive: serialize every assignment and record worker,
> lane, base and ownership. **A0 gates every source packet — integrate it first.** Enforce §5.2
>
> **Lane B holds `build-runtime.ts` and `scheduler-store.ts` through B2, A1b and A5.** Make one
> release announcement, only when all three have integrated. Until then C2 and C4 are both
> blocked — **B2 alone unblocks neither**, because A5 still writes `scheduler-store.ts`
> (r3 finding N-3). A1 is not accepted until A1b is; they are one unit sharing one evidence
> file. Reserve the full suite for D1g.

### Lane A
> You own I2 → A1 → A2 → A3 → A4. Read STATE.md, then §3.0 and your contracts. Writable: the
> four agent runtimes, `role-capabilities.ts`, `filesystem-tools.ts`, and `agent-prompts.ts`
> from A3. Forbidden: `scheduler-store.ts`, `build-runtime.ts`, `architect-tools.ts` — Lane B
> holds those. A1 asserts **both** the inspection broker and `createArchitectTools`; the second
> half is A1b and the controller schedules it after B2. A3 changes the security posture and
> must correct the verifier authority sentence in the same packet. Do not commit, stage or
> stash.

### Lane B
> You own A0 → I1 → I3 → B1 → B2 → A1b → A5. **A0 first: it captures the compatibility fixture
> and every other source packet is blocked until it integrates.** B1 must not touch any
> `recordContextPack` call site — it retries internally and throws a typed error; B2 catches it
> at the dispatcher. You hold `scheduler-store.ts`, `build-runtime.ts` and the client surface
> until B2, **and you still hold them through A1b and A5**. You release nothing yourself: the
> controller makes one release announcement after all three have integrated. Do not commit,
> stage or stash.

### Lane C (opens after B2 integrates and I1, I3 are accepted)
>
> You own C1 → C5 then E1 → E3. **C1 needs only I1 and I3 accepted; every later packet carries
> its own Depends on and those are authoritative.** C4 waits for `build-runtime.ts`, which Lane
> B holds through B2, A1b and A5 — wait for the controller's release announcement, not for B2.
> E1 waits for C3, because C3 holds `agent-prompts.ts`. Rebase onto integrated Lane A work
> before C3 — your agents are constructed with Lane A's allow-lists, and A3 also writes
> `native-plan-critic-runtime.ts` and `agent-prompts.ts`. C3 and E2 carry the blindness
> guarantees: prove the withheld material cannot reach the first turn through **any** channel,
> including the tool surface. AC-16 must assert the affected-test command specifically — an
> arbitrary command must not satisfy it. Do not commit, stage or stash.

---

## 11. Verdict

**PLAN BLOCKED — revision 4 corrections not yet independently re-reviewed.**

Revision 3 was re-reviewed (`evidence/plan-review-r3.md`) and returned **PLAN COVERAGE
INSUFFICIENT** again. **B-2, D7-1 and regressions 1 and 2 were confirmed REPAIRED.** B-1
became a **NEW DEFECT**, B-4, B-5 and regressions 3 and 4 were still **NOT FIXED**, and six
further findings were raised.

Revision 4 repairs those. The B-1 repair is the third and final cycle permitted by
REPAIR_BUDGET; unlike the first two it is not another variation of the same idea but a
mechanism the reviewer identified and the controller verified in the source
(`task-scheduler.ts:278-288` already returns on a `paused` outcome without failing the task).

| r3 finding | Repair in revision 4 |
|---|---|
| N-1 — re-raising leaves the task `running`, so `tick` redispatches it into the same error | No re-raise. The catch records the **existing `paused` outcome** plus the note, so the task is neither failed nor redispatched. A run-scoped recording-suspended registry in `context-manifest-store.ts` lets a waiver resume without changing any of the five call sites |
| N-2 — Phase C still had two rules | One rule: C1 needs A0, I1, I3. §5.1, both Lane C lines and STATE now say only that |
| N-3 — A5 still had no executable commit path | The workspace, the reserved architect id, `commitTask`, the evidence hash, the new `actor` field and **both** audit gates are named explicitly |
| N-4 — B2's own text released the files it must hold | Deleted from B2 and the Lane B card. One controller announcement after B2 + A1b + A5 |
| N-5 — A1b raced Lane A on `role-capabilities.ts` | A1b's writable list is `build-runtime.ts` and its tests only |
| N-6 — the OQ-4 default contradicted D5 | Stage-1 coverage is never skipped; stage 2 raises D5's `low` to `medium` |
| N-7 — three edges lived in a contract or STATE but not the list | One authoritative edge list; every `Depends on` and STATE row is a copy of it |
| N-8 — E1 still accepted AC-19 on the helper | E1 is graded on AC-20 and AC-22 only; AC-19 is accepted on E2 |
| N-9 — C1 writes source with no path to A0 | `A0 → C1` added |
| N-10 — longest path was 9, not 8 | Corrected, with the path shown |

Earlier repairs that held and are unchanged: **B-3** (r2), **B-2 and D7-1** (r3), regressions
1 and 2, and all nine r1 IMPORTANT findings.

| r2 condition | Repair in revision 3 |
|---|---|
| B-1 — the worker's typed error is swallowed by `task-scheduler.ts:227-234` | B2 now owns `task-scheduler.ts` and its catch re-raises; AC-3 requires a named test **per agent path**, worker included |
| B-2 — A1b had no contract and raced C4 | A1b is a real packet with a contract, a traceability row, a phase listing and a graph node, ordered before C4 on `build-runtime.ts` |
| B-4 — A5 could not reach the audit filter or state a commit mechanism | A5 owns `native-build-factory.ts`, and the actor field, the worker-only filter relaxation and the commit mechanism are all named |
| B-5 — three different Phase C start rules | One rule: C1 needs I1 and I3; later packets carry their own `Depends on`, and those are authoritative everywhere |
| D7-1 — AC-19 could pass while the turn had already seen the plan | A fresh session with an empty event list is required, and the acceptance asserts the turn's real messages, tool results and loaded session, covering replay and checkpoint |
| regressions 1–4 | A1b orphan (above); `C3 → E1` so `agent-prompts.ts` has one owner; A5 ordered ahead of C2/C4; the "A0 → everything" caption corrected to "no packet writes source before A0" |

Three of revision 2's repairs held and are unchanged: **B-3** (MCP as a checked class with the
mapper's real predicate) and all nine IMPORTANT findings, which the r2 review confirmed were
answered by contract changes rather than prose.

- **Responsible owner:** controller.
- **Unblock action:** re-review revision 4, scoped to these corrections and the coverage they
  affect, then re-issue this verdict.
- **Repair budget:** B-1 has now consumed all three permitted cycles. If revision 4's B-1
  repair is still not sound, it is escalated to the owner as an exhausted budget under §8,
  not revised a fourth time.

**Execution has not started. Planning readiness does not authorize execution.**
