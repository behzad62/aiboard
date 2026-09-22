# Runner V2 — Agent capability model (execution plan)

**Revision 6.** The filename is kept for reference stability; change critique and coverage
review moved to P6.6 by owner amendment (2026-09-22) and are no longer in this plan.
**Execution has not started.** Verdict in §11.

---

## 0. Source identity and parameters

| | |
|---|---|
| SOURCE | `docs/superpowers/specs/2026-09-22-runner-v2-agent-capability-model-design.md`, revision 2 |
| Moved scope | D4, D5, D7 → `docs/superpowers/specs/2026-09-22-runner-v2-p6-6-owner-amendment.md` |
| Base revision | `6c166f97` on `main` |
| PLAN_DIR | this file + `.superpowers/sdd/2026-09-22-runner-v2-agent-capability/` |
| PROJECT_RULES | `CLAUDE.md`, `AGENTS.md`, the Runner V2 Task 12 mandate |
| MAX_WORKERS | 4 permitted; **this plan derives 2** — see §5 |
| REPAIR_BUDGET | 3 evidence-backed cycles per tracked blocking issue; ESC-1 carries one owner-granted extra cycle |
| Planning history | four independent reviews of revisions 1–5: `evidence/plan-review-r1.md` … `-r4.md` |

### 0.1 Host capabilities — observed

| Capability | Support |
|---|---|
| Independent implementation workers | **Yes.** Cursor CLI, `grok-4.7-high`. |
| Independent fresh-context reviewer | **Yes.** Separate invocation; demonstrated four times on this plan. |
| Git worktrees | **Yes.** |
| Atomic task claims | **No.** The single controller serializes assignment. Procedural. |
| Harness-enforced state gates | **No.** §7 gates are procedural unless landed as kernel invariants. |
| Native launch chips | **No.** §10 gives copy-ready cards. |

### 0.2 Carried-forward execution rules

1. Affected-graph validation per packet; the full `npm run test:runner-v2` runs exactly twice —
   the §0.3 baseline and the D1g exit gate.
2. Node 24, invoked as `C:\Program Files\nodejs\node.exe`.
3. `--test-concurrency=1` for any affected graph containing host or process fixtures.
4. `public/*.zip` are publication artifacts; packets leave them dirty, the controller reverts,
   and they are refreshed in a deliberate publication commit.

### 0.3 Baseline, reusable under §6.4

At `6c166f97`: `npm run test:runner-v2` **3096 tests, 3091 pass, 0 fail, 5 skipped** plus 18
chained scripts PASS; both typechecks exit 0; `npm run build` exit 0, 20/20 routes;
`npx eslint .` 0 errors, 13 pre-existing warnings. The 5 skips are host gates.

---

## 1. Requirement ledger

| ID | Requirement | Source | Phase | Packets | Evidence required | Status |
|---|---|---|---|---|---|---|
| AC-1 | Failed manifest write retries with bounded backoff | D1 | B | B1 | a stub failing N-1 times then succeeding records exactly once and throws nothing; a permanently failing stub throws `ContextManifestRecordingError` after exactly the bound | PLANNED |
| AC-2 | Exhausted failure writes a durable note to the scheduler store | D1 | B | B2 | exactly one `context_manifest.recording_failed` event carrying purpose, task id, attempt, revision, attempts and reason | PLANNED |
| AC-3 | Exhausted failure pauses the run with a typed Architect decision on **all four agent paths** | D1 | B | B2 | one named test per path — architect, worker, verifier, critic. The worker test asserts the task is **neither `failed` nor redispatched** while paused. Plus a fail-closed test where the scheduler append itself throws | PLANNED |
| AC-4 | Exactly one of `retry` / `proceed_without_manifest` (rationale required) / `abort`, durable, attributed and restart-safe | D1 | B | B2 | one test per resolution; rationale-less waiver rejected at the durable append boundary; `retry` budget exhaustion re-pauses; **three restart tests** — paused-before-decision stays paused with no dispatch, post-waiver restart re-derives suspension before the first dispatch, post-abort run is terminally failed | PLANNED |
| AC-5 | Each role's tool surface is an asserted allow-list across every broker it uses | D2 | A | A1 | exact sorted list per role per broker; adding and removing an entry both redden; `PlanOnlyInspectionRuntime` included | PLANNED |
| AC-6 | The Architect runs commands in a disposable copy, subject to the permission profile | D2 | A | A3 | the command tool is in the Architect list; approval required under non-`full`; the project fixture is byte-identical after an Architect command | PLANNED |
| AC-7 | Architect document writes are refused outside the I2 allow-list | D2, D6 | A | A4 | success only for an I2-recorded path; refusal for a path outside the allow-list **and outside `runner-v2/src`**; enforced at the durable append boundary, not only in the tool | PLANNED |
| AC-8 | Verifier execution is confined to its own workspace; the critic has no command tool | D2 | A | A3 | fixture project byte-identical after a verifier run while its workspace may differ; confinement proved against a fixture double because `containedDirectory` already exists; the critic's exact list contains no command tool | PLANNED |
| AC-9a | Verifier and critic cannot commit, integrate, complete, alter the plan or review tasks | D2 | A | A1 | exact-list assertion on their brokers | PLANNED |
| AC-9b | The Architect retains `review_task`, `request_integration`, `complete_run` | D2 | A | A1, A1b | assertion on **both** the inspection broker and `createArchitectTools`; removing any of the three reddens | PLANNED |
| AC-10 | The Architect admits only mapper-`readOnly` MCP tools, as an asserted class | D3 | A | A2 | stub server: `readOnlyHint` alone refused; `readOnlyHint && !destructiveHint` admitted; verifier and critic remain MCP-free | PLANNED |
| AC-17 | An Architect document write lands as a kernel-applied `architect_document` task with Architect attribution in git, absent from accepted change sessions | D6 | A | A5 | the integration branch contains the file in a commit carrying the Architect trailer; `acceptedChangeSessions` does not list it; zero model calls to apply it | PLANNED |
| AC-18 | Pre-change runs keep current semantics and replay | compat | A→D | A0 records, D1g compares | fixture captured before the first source packet, replayed at D1g to an identical projection | PLANNED |

### 1.1 Reverse traceability

| Packet | Requirements |
|---|---|
| I2 | AC-7 (investigation) |
| A0 | AC-18 (capture) |
| A1 | AC-5, AC-9a, AC-9b (brokers Lane A owns) |
| A1b | AC-9b (the `createArchitectTools` half) |
| A2 | AC-10 |
| A3 | AC-6, AC-8 |
| A4 | AC-7 |
| A5 | AC-17 |
| B1 | AC-1 |
| B2 | AC-2, AC-3, AC-4 |
| D1g | AC-18 (compare), program gate |

Every packet supports an obligation; every obligation has an owning packet. AC-11..AC-16 and
AC-19..AC-23 are owned by P6.6 (EP33–EP38), not dropped.

---

## 2. Phases

**Phase I — investigation.** I2. Writes an evidence file only and may run beside A0.

**Phase A — capability model.** A0, A1, A1b, A2, A3, A4, A5. AC-5..AC-10, AC-17, AC-18
(capture). **No packet writes a source file before A0 integrates.**

**Phase B — manifest recording resolution.** B1, B2. AC-1..AC-4. Entry: A0 integrated.

**Phase D — program gate.** D1g.

---

## 3. Packet contracts

### 3.0 Shared rules

**Writable surfaces** are listed per packet and include that packet's tests. Everything else is
forbidden, including `public/*.zip` and any file another lane holds (§5.2).
`filesystem-mutation-routing.test.ts` is controller-owned: a packet adding a `node:fs` importer
reports it and stops.

**Definition of Done:** every mandatory criterion evidenced; prove-red per new guard, restored
byte-exact with a hash; affected graph green with a scope rationale; both typechecks exit 0;
ESLint adds no error or warning; independent review has no unresolved mandatory finding; the
worker did not commit, stage or stash.

**Injection discipline** — each item cost a real defect during P6.5 or this plan's reviews:
prove the injection changed the file before reading the result; probe type-level injections
with `tsc --noEmit`, never `tsx`; assert exact sorted allow-lists in both directions; **check
whether the behaviour you are adding already exists**, or your prove-red cannot redden; an
assertion that passed before the feature existed proves nothing until it can fail; grep that
every new export is constructed or called by a test.

---

### I2 — Architect document allow-list (investigation)

Deliverable `evidence/I2.md`: the path set, whether it is per-project configuration or a fixed
default, and each candidate checked against `tsconfig` includes, `next.config` and the test
globs. **Decision criterion:** no path in the set can affect built output or test outcome.
Writable: `evidence/I2.md`. Unlocks A4.

### A0 — Capture the compatibility fixture (first)

| | |
|---|---|
| Requirements | AC-18 (capture) |
| Writable | `runner-v2/test/support/pre-capability-run.fixture.json`, `runner-v2/test/replay-compatibility.test.ts` |
| Depends on | nothing |

Drive a representative run at `6c166f97` — plan, one worker task, a verifier verdict, a context
manifest — and store its projection and event list. The replay test asserts deep equality.
Prove-red: mutate one stored field → red. D1g re-runs the same test. After the work lands,
"before" no longer exists, which is why this is first.

### A1 — Per-role allow-lists, asserted across the brokers Lane A owns

| | |
|---|---|
| Requirements | AC-5, AC-9a, AC-9b (inspection half) |
| Writable | `native-architect-runtime.ts`, `native-verifier-runtime.ts`, `native-plan-critic-runtime.ts`, `worker-runtime.ts`, new `role-capabilities.ts`, their tests |
| Depends on | A0 |

Derive today's effective list per role **by construction**. Replace every filter — including
`PlanOnlyInspectionRuntime` (`native-architect-runtime.ts:707-714`), whose predicate is
`readOnly && effect !== "workspace"` — with admission against a named list. Add
`assertRoleToolSurface`, modelled on `assertReadOnlyInspectionDefinition`. **No capability is
added here.** Prove-red per role and broker: add a forbidden entry, remove a required entry,
admit without listing — each reddens. **A1 is not accepted until A1b is**; one evidence file.

### A1b — Architect lifecycle allow-list on `createArchitectTools`

| | |
|---|---|
| Requirements | AC-9b (lifecycle half) |
| Writable | `build-runtime.ts` (the `createArchitectTools` registration, `:1416`) and its tests **only** |
| Depends on | A1, B2 |

Apply `assertRoleToolSurface` — defined by A1 — to the Architect's composed surface including
`request_integration`, `complete_run` and `review_task`. Removing any of the three reddens a
named test. A1b does not write `role-capabilities.ts`.

### A2 — MCP class for the Architect

| | |
|---|---|
| Requirements | AC-10 |
| Writable | `native-architect-runtime.ts`, `role-capabilities.ts`, `mcp-tools.test.ts`, `role-capabilities.test.ts` |
| Forbidden | `mcp-tools.ts`, verifier and critic runtimes |
| Depends on | A1 |

Admit a dynamically named tool iff `createMcpTools` set `readOnly === true`
(`readOnlyHint === true && destructiveHint === false`, `mcp-tools.ts:156-159`), with a class
assert that accepts `effect: "external"` only for that class. Stub server with three shapes:
only `readOnlyHint && !destructiveHint` is admitted. Prove-red: drop the `destructiveHint` half.

### A3 — Reader command execution

| | |
|---|---|
| Requirements | AC-6, AC-8 |
| Writable | the four runtimes, `role-capabilities.ts`, **`agent-prompts.ts`**, **`native-build-factory.ts`** (wiring the Architect's disposable workspace), their tests |
| Forbidden | `evidence-tools.ts`, `tool-broker.ts` |
| Depends on | A2 |

| Role | Execution root |
|---|---|
| Verifier | its verification workspace (`workspace.path`) |
| Architect | a disposable copy, using the provider pattern the critic already uses (`native-plan-critic-runtime.ts:154-156`) |
| Critic | **no command tool** |

Correct the read-only-tools sentence in `VERIFIER_AUTHORITY_INVARIANTS` in the same packet;
keep every authorship prohibition word-for-word. Prove-red uses a **fixture double** with
containment stubbed, because `containedDirectory` already rejects an escaping `cwd`.
Security-sensitive: review confirms no reader reaches the project tree and approval semantics
under all three permission profiles are unchanged.

### A4 — `write_plan_document`

| | |
|---|---|
| Requirements | AC-7 |
| Writable | `architect-tools.ts`, `scheduler-store.ts` (`architect_document.requested` and its path validation), `role-capabilities.ts`, `build-runtime.ts` (tool registration), `build-spec.ts` **only if I2 chose per-project configuration**, their tests |
| Depends on | I2, A3, A1b |

The Architect receives **no** filesystem mutation tool. It calls
`write_plan_document(path, content, summary)`; the path is validated against the I2 allow-list
in the tool **and** at the durable append boundary. Acceptance per AC-7. Prove-red: replace the
allow-list with a `runner-v2/src` denylist → the `lib/` refusal test reddens.

### A5 — Kernel-applied `architect_document` task

| | |
|---|---|
| Requirements | AC-17 |
| Writable | `task-contracts.ts` (`BuildTaskKind`), `task-graph.ts`, `acceptance-contracts.ts`, `scheduler-store.ts`, `task-scheduler.ts`, `build-runtime.ts`, `workspace-manager.ts` (Architect commit trailer), their tests |
| Depends on | A4 |

**Named mechanism.** `architect_document.requested` creates a task of kind
`architect_document`. The scheduler routes that kind to a **runner-applied** path, not a worker
driver: `WorkspaceManager.createTaskWorkspace(taskId)`, write the file, `commitTask` with an
Architect trailer, `createChangeSet` with the content hash as its evidence hash, then
`IntegrationManager.integrate` (`integration-manager.ts:474`).

**Must also hold:** the task carries no acceptance criteria and is exempt from the
acceptance-contract upgrade requirement; it counts toward completion readiness only as a
terminal `integrated` task; it makes **zero** model calls; and it does not appear in
`acceptedChangeSessions`, because it has no worker session — consistent with ESC-2 and with no
change to that filter.

**Budget.** AC-17 was changed by owner decision ESC-2. This is a new mechanism under a changed
requirement, reviewed once; if review finds it unsound it escalates again rather than
consuming a fresh budget.

### B1 — Retry, typed error and recording suspension

| | |
|---|---|
| Requirements | AC-1 |
| Writable | `context-manifest-store.ts`, `context-manifest-store.test.ts` |
| Forbidden | **every `recordContextPack` call site** |
| Depends on | A0 |

`recordContextPack` retries internally and on exhaustion throws `ContextManifestRecordingError`.
B1 also owns the **recording-suspension API** — `suspendContextRecording(runId, reason)` and
`isContextRecordingSuspended(runId)` — which `recordContextPack` consults first, returning
`undefined` while suspended. Round 4 found this registry described in B2 but contracted to no
packet; it is B1's now. Prove-red: remove the retry; make the bound unbounded; ignore the
suspension check — each reddens.

### B2 — Note, pause and Architect resolution

| | |
|---|---|
| Requirements | AC-2, AC-3, AC-4 |
| Writable | `build-runtime.ts`, `task-scheduler.ts`, `architect-tools.ts`, `user-steering-contracts.ts`, `scheduler-store.ts`, `native-build-manager.ts` (the abort path), `lib/client/runner-v2.ts`, `components/RunnerV2ObservabilityPanel.tsx`, their tests and the two UI scripts |
| Depends on | B1 |

**Worker path.** In the scheduler's catch, on `ContextManifestRecordingError` only: append the
note, then record the **existing `paused` outcome** (`task-scheduler.ts:278-288`). The task
stays `running` but the run is paused, and `tick` does not dispatch while paused
(`task-scheduler.ts:119`). Every other rejection keeps today's `failed` behaviour. **Do not
re-raise** — round 3 showed it leaves the task for the next tick to redispatch.

**Architect, verifier, critic paths.** These propagate to the dispatcher; its catch appends the
note and pauses the run through the existing pause mechanism.

**Resolutions.**
- `retry`: resume. The worker task is redispatched and recording re-attempted — correct, not a
  defect. A finite retry budget; exhaustion re-pauses with the existing note.
- `proceed_without_manifest`: append the durable waiver, call `suspendContextRecording`. On
  **every runtime construction**, re-derive suspension from the durable waiver **before the
  first dispatch**, so a crash between the waiver and the next dispatch cannot redispatch into
  the same failure.
- `abort`: `RunSupervisor.fail(runId, key, "context_recording_aborted")`
  (`run-supervisor.ts:117`). The run is terminal and nothing redispatches.

Tests per AC-2..AC-4, including the three restart tests.

---

### D1g — Compatibility and program gate

Depends on **A5** — the only leaf; every packet has a path to it. Independent source-to-delivery
reconciliation, then AC-18 replay of the A0 fixture, then the full suite, then the publication
commit.

---

## 4. Dependency graph

**Authoritative edge list.** Every `Depends on` field and every STATE row is a copy of this.

```
A0 → A1        A0 → B1
A1 → A2 → A3
A1 → A1b       B1 → B2 → A1b
I2 → A4        A3 → A4        A1b → A4
A4 → A5
A5 → D1g
```

Acyclic. **Longest path 7**, two of them:
`A0 → A1 → A2 → A3 → A4 → A5 → D1g` and `A0 → B1 → B2 → A1b → A4 → A5 → D1g`.

---

## 5. Lanes, ownership and serialized surfaces

### 5.1 Lanes

| Lane | Packets | Notes |
|---|---|---|
| **Lane A** | I2, A1, A2, A3 | runtimes, `role-capabilities.ts`, `agent-prompts.ts`, `native-build-factory.ts` |
| **Lane B** | A0, B1, B2, A1b, A4, A5 | recording, scheduler, dispatcher, Architect tools, the new task kind |

Two lanes, not four: after A3 and B2 both lanes converge on the same files, so a third or fourth
lane would be false parallelism. **Real parallelism is A1–A3 alongside B1–B2**, which touch no
common file. They are not behaviourally independent — B2's tests construct runtimes whose tool
lists A1 changes — so the controller re-runs the affected graph after integrating each.

### 5.2 Serialized surfaces

| Surface | Owner sequence |
|---|---|
| `build-runtime.ts` | B2 → A1b → A4 → A5 |
| `scheduler-store.ts` | B2 → A4 → A5 |
| `task-scheduler.ts` | B2 → A5 |
| `architect-tools.ts` | B2 → A4 |
| `role-capabilities.ts` | A1 → A2 → A3 → A4 |
| `native-architect-runtime.ts` | A1 → A2 → A3 |
| `native-verifier-runtime.ts`, `native-plan-critic-runtime.ts` | A1 → A3 |
| `agent-prompts.ts`, `native-build-factory.ts` | A3 only |
| `native-build-manager.ts`, `lib/client/runner-v2.ts`, the panel | B2 only |
| `context-manifest-store.ts` | B1 only |
| `filesystem-mutation-routing.test.ts` | controller only |
| the five `recordContextPack` call sites | **nobody** |

### 5.3 Controller

Owns assignment (no atomic claim primitive), integration order, the reviewed-owner audit list,
the A1/A1b pairing, and acceptance. Workers own only their surfaces and evidence file, and never
commit.

---

## 6. Validation and evidence

**6.1 Scope** — impact-based: the packet's tests, every test importing a changed kernel surface,
and consumers found by inspecting callers. **6.2 Full suite** — exactly twice. **6.3 Records** —
requirement and condition; revision and diff identity; command, environment, inputs; outcome
with exit and counts; logs; review disposition. **6.4 Reuse** — the §0.3 baseline applies while
code, dependencies, configuration and environment are unaffected, with the reason recorded.
**6.5 Fault injection** — disposable fixtures only; restore byte-exact and prove by hash.

---

## 7. Review and acceptance

One independent review per packet; workers never self-accept. A packet is accepted when every
mandatory criterion is evidenced, no mandatory finding is unresolved, integration and
affected-boundary checks pass, and STATE reflects it. Gates are procedural (§0.1). States:
PLANNED, READY, RUNNING, IN_REVIEW, READY_TO_INTEGRATE, BLOCKED, ACCEPTED.

## 8. Repair policy

Three evidence-backed cycles per blocking issue, counted across sessions and agents; related
symptoms share a record; renaming does not reset the count. Escalate only for an authority
decision, unsafe action, requirement conflict, owner-dependent blocker, weakened control or
exhausted budget. **ESC-1 holds one owner-granted cycle; if B-1 is still unsound after this
revision's review, it escalates again.**

## 9. Program closure

Independent reconciliation against the SOURCE; targeted repair; AC-18 replay; full suite, both
typechecks, ESLint, `npm run build`; publication commit; ledger reconciled.

---

## 10. Launch cards

**Controller.** Read STATE, then §5 and §7. A0 gates every source packet — integrate it first.
Serialize assignments and record them. Hold the A1/A1b pairing. After integrating anything from
one lane, re-run the other lane's affected graph. Reserve the full suite for D1g.

**Lane A.** You own I2, A1, A2, A3. I2 may start now; A1 waits for A0. Writable per contract;
`build-runtime.ts`, `scheduler-store.ts`, `task-scheduler.ts` and `architect-tools.ts` are Lane
B's. A3 changes the security posture and must correct the verifier authority sentence in the
same packet. Do not commit, stage or stash.

**Lane B.** You own A0, B1, B2, A1b, A4, A5, in that order. **A0 first.** B1 must not touch any
`recordContextPack` call site. B2 must not re-raise from the scheduler. A4 waits for I2 and A3
from Lane A. Do not commit, stage or stash.

---

## 11. Verdict

**PLAN BLOCKED — revision 6 not yet independently re-reviewed.**

Revision 6 is a scope reduction plus two owner decisions, not a routine repair:

| Change | Reason |
|---|---|
| D4, D5, D7 and phases C and E removed | owner amendment moving them to P6.6, which already owns coverage review (T3) and deliverable review (T6) and forbids a second competing authority |
| ESC-1 → one more cycle | B-1's remaining defects were contract assignment (the suspension registry now belongs to B1), stale text (the re-raise rationale is gone), an unspecified `abort` (now `RunSupervisor.fail`) and crash recovery (suspension re-derived before the first dispatch; three restart tests) |
| ESC-2 → git attribution, not the audit list | the commit path is now a kernel-applied `architect_document` task, which supplies the workspace, task id, commit and evidence every existing API requires, and is absent from `acceptedChangeSessions` without changing it |
| Architect gets no filesystem mutation tool | document writes go through `write_plan_document` and the kernel, which removes the isolation problem of writing into `projectRoot` |
| Plan critic stays execution-free | P6.6 forbids execution during planning; the change-review stage that needed it moved to P6.6 |

- **Responsible owner:** controller.
- **Unblock action:** one independent review of revision 6 against revision 2 of the SOURCE,
  covering the whole revised plan because the scope change touches every section.

**Execution has not started. Planning readiness does not authorize execution.**
