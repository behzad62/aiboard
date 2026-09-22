# Runner V2 — Agent capability model and change critique (execution plan)

**Verdict:** see §11. **Execution has not started.**

---

## 0. Source identity and parameters

| | |
|---|---|
| SOURCE | `docs/superpowers/specs/2026-09-22-runner-v2-agent-capability-model-design.md` |
| SOURCE status | APPROVED by owner, session 2026-09-22 |
| Base revision | `6c166f97` on `main` |
| Prior phase | P6.5 review-gap closure, merged PR #98; lint cleanup PR #99 |
| PLAN_DIR | this file + `.superpowers/sdd/2026-09-22-runner-v2-agent-capability/` |
| PROJECT_RULES | `CLAUDE.md`, `AGENTS.md`, and the Runner V2 Task 12 mandate in `CLAUDE.md` |
| MAX_WORKERS | 4 permitted; **this plan derives 2, opening to 3** — see §5 |
| REPAIR_BUDGET | 3 evidence-backed cycles per tracked blocking issue |

### 0.1 Host capabilities — discovered, not assumed

| Capability | Actual support |
|---|---|
| Independent implementation workers | **Yes.** Cursor CLI, `grok-4.7-high`. Established method through all of P6.5. |
| Independent reviewer, fresh context | **Yes.** Same mechanism, separate invocation. |
| Git worktrees | **Yes.** `D:\repos\ai-discussion-board\.worktrees\`. |
| Atomic task claims | **No.** There is no claim primitive. The single controller serializes all assignment. Recorded as procedural, not mechanical. |
| State gates enforced by harness | **No.** Gates in §7 are procedural unless they land as kernel invariants. |
| Native launch chips | **No.** §10 provides copy-ready cards. |

### 0.2 Carried-forward execution amendments

These were owner-approved during P6.5 and remain in force.

1. **Affected-graph validation per packet.** Each packet runs typecheck, targeted ESLint and
   tests over its affected graph — its own tests plus every test importing a changed shared
   kernel surface. The full `npm run test:runner-v2` runs exactly **twice** per phase: entry
   baseline and exit gate.
2. **Node 24 only.** `package.json` engines are `>=24.0.0 <25`. Use
   `C:\Program Files\nodejs\node.exe` explicitly; agent shells resolve a different Node.
3. **Serial test execution.** Affected graphs containing host or process fixtures must run
   `--test-concurrency=1`. Parallel runs collide on Windows Job objects and MCP temp roots
   and produce false failures.
4. **`public/*.zip` are publication artifacts.** Builds dirty them; packets leave them dirty
   and the controller reverts them. They are refreshed in a deliberate publication commit.

### 0.3 Inherited baseline facts

Established at `6c166f97`, reusable as baseline evidence under §6.4:

- `npm run test:runner-v2` — **3096 tests, 3091 pass, 0 fail, 5 skipped**, plus 18 chained
  scripts PASS.
- The 5 skips are host gates: 2 Darwin, 2 POSIX, 1 win32. No convenience skips.
- `tsc -p runner-v2/tsconfig.json --noEmit` exit 0; `tsc --noEmit` exit 0.
- `npm run build` exit 0, 20/20 static routes.
- `npx eslint .` exit 0 — **0 errors**, 13 warnings (all pre-existing, none in runner-v2 src).

---

## 1. Requirement ledger

Status legend: `PLANNED` (no implementation), `INVESTIGATE` (blocked on a bounded question).

| ID | Requirement | Source | Owning phase | Packets | Gate | Evidence required | Status |
|---|---|---|---|---|---|---|---|
| AC-1 | Failed manifest write retries with bounded backoff before being treated as failed | D1 | B | B1 | packet | fault injection: a stub store failing N-1 times then succeeding records exactly once, no pause | PLANNED |
| AC-2 | Exhausted failure writes a durable note to the **scheduler store**, not the failed ledger | D1 | B | B1 | packet | durable event asserted present after the manifest store is made permanently failing | PLANNED |
| AC-3 | Exhausted failure pauses and presents a typed Architect decision; never silently continues, never dies without the note | D1 | B | B2 | packet | runtime test: step returns paused with the typed reason; note present; no model call to complete | PLANNED |
| AC-4 | Architect resolves with exactly one of `retry` / `proceed_without_manifest` (rationale required) / `abort`, durable and attributed | D1 | B | B2 | packet | one test per resolution + rejection of a rationale-less waiver at the durable append boundary | PLANNED |
| AC-5 | Each role's tool surface is an explicit allow-list, asserted at registration, failing closed | D2 | A | A1 | packet | exact sorted tool-list assertion per role; adding and removing a tool both redden | PLANNED |
| AC-6 | The Architect can run commands, subject to the run permission profile | D2 | A | A3 | packet | Architect tool list contains the command tool; approval required under non-`full` | PLANNED |
| AC-7 | Architect project writes are refused outside the configured plan/spec allow-list | D2 | A | A4 | packet | write inside allow-list succeeds; write to `runner-v2/src/**` is refused with a typed error | PLANNED |
| AC-8 | Verifier and critic command execution is confined to their own workspace | D2 | A | A3 | packet | command with `cwd` outside the reader workspace is refused; project tree unchanged after a reader run | PLANNED |
| AC-9 | No reader commits, integrates or completes the run; verifier and critic cannot alter the plan or review tasks | D2 | A | A1 | packet | exact-list assertion excludes every lifecycle tool; attempted call returns unregistered | PLANNED |
| AC-10 | Reader roles admit only MCP tools declaring `readOnlyHint: true`, asserted | D3 | A | A2 | packet | stub MCP server exposing one read-only and one mutating tool; only the first is registered | PLANNED |
| AC-11 | A change critique stage runs at integration before the verifier, reusing finding/gate/resolution contracts | D4 | C | C2, C4 | packet | dispatcher test: ordering, and blocking findings hold integration | PLANNED |
| AC-12 | Change-critic selection excludes the Architect **and** every accepted change author | D4 | C | C2 | packet | emptying either exclusion set reddens a distinct test | PLANNED |
| AC-13 | Stage 2 forms findings before being shown its own stage-1 findings | D4 | C | C3 | packet | first-turn messages asserted not to contain stage-1 finding ids; second turn asserted to contain them | PLANNED |
| AC-14 | Change risk is deterministic — same change, same risk, no clock/randomness/env/model | D5 | C | C1 | packet | repeated calls deep-equal; grep proves no `Date`/`Math.random`/`process.env` in the module | INVESTIGATE (OQ-1, OQ-3) |
| AC-15 | Change critique is graded low/medium/high, with a durable recorded skip at low | D5 | C | C4 | packet | one runtime test per tier; low records a durable skip and advances | PLANNED |
| AC-16 | At high risk the critic runs affected tests itself, recorded as durable evidence | D5 | C | C4 | packet | high-tier test asserts a command evidence record exists and is cited by a finding | PLANNED |
| AC-17 | Architect plan/spec writes land as an attributed Architect-authored ChangeSet | D6 | A | A4 | packet | ChangeSet present with architect actor; audit export contains it | PLANNED |
| AC-18 | Pre-change runs keep current semantics and remain replayable | compat | D | every packet | phase | replay of a fixture run recorded before the change produces an identical projection | PLANNED |

### 1.1 Reverse traceability — every packet supports an obligation

| Packet | Requirements | Enabling-only? |
|---|---|---|
| I1 | AC-14, AC-15 | investigation |
| I2 | AC-7 | investigation |
| I3 | AC-14 | investigation |
| A1 | AC-5, AC-9 | no |
| A2 | AC-10 | no |
| A3 | AC-6, AC-8 | no |
| A4 | AC-7, AC-17 | no |
| B1 | AC-1, AC-2 | no |
| B2 | AC-3, AC-4 | no |
| C1 | AC-14 | no |
| C2 | AC-11, AC-12 | no |
| C3 | AC-13 | no |
| C4 | AC-11, AC-15, AC-16 | no |
| C5 | AC-11 (surface) | no |
| D1g | AC-18, program gate | no |

No packet exists without a requirement. No applicable requirement lacks an owning packet.

---

## 2. Phases

### Phase I — Bounded investigation

**Purpose.** Resolve three empirical unknowns before contracts depend on guessed constants.
**Entry.** Base `6c166f97`. **Packets.** I1, I2, I3.
**Exit.** Each question answered with a recorded decision criterion and evidence; dependent
packet contracts updated before release.
**Unlocks.** A4 (I2), C1 (I1, I3).

### Phase A — Capability model

**Purpose.** Replace the blanket read-only filter with asserted per-role allow-lists, and
grant readers execution and the Architect path-scoped writes.
**Requirements.** AC-5, AC-6, AC-7, AC-8, AC-9, AC-10, AC-17.
**Scope.** Tool registration and admission for all four roles; path write policy; MCP
admission. **Exclusions.** No change to what any tool *does*; no new lifecycle authority.
**Entry.** Base `6c166f97`; I2 accepted before A4 starts.
**Exit.** Every role has an asserted exact tool list; readers execute only in their own
workspace; Architect writes are path-scoped and attributed; affected graph green; full suite
**not** run here.
**Unlocks.** C4's high tier (AC-16) depends on A3.

### Phase B — Manifest recording failure resolution (OD-3)

**Purpose.** Retry, durably note, then let the Architect decide.
**Requirements.** AC-1, AC-2, AC-3, AC-4.
**Scope.** `context-manifest-store.ts`, the three recording call sites, one new scheduler
event family, one pause reason, one Architect resolution tool.
**Exclusions.** No change to what a manifest contains; no change to tool-ledger semantics.
**Entry.** Base `6c166f97`. Independent of Phase A.
**Exit.** All four ACs have packet evidence; affected graph green.

### Phase C — Change critique

**Purpose.** A second critic stage that reviews the change, risk-gated and blind-first.
**Requirements.** AC-11, AC-12, AC-13, AC-14, AC-15, AC-16.
**Entry.** I1 and I3 accepted; A1 integrated (tool allow-list exists); B2 integrated (shared
kernel surfaces released — see §5.2).
**Exit.** All six ACs have packet evidence; affected graph green.

### Phase D — Program gate

**Purpose.** Compatibility reconciliation and final acceptance.
**Requirements.** AC-18 and the program gate.
**Entry.** Phases A, B, C accepted.
**Exit.** §9 satisfied.

---

## 3. Packet contracts

Every packet below inherits the **shared packet rules** in §3.0.

### 3.0 Shared packet rules

**Writable surfaces** are listed per packet. Everything else is forbidden, including
`public/*.zip` (leave dirty, never stage) and any file owned by another lane (§5.2).

**Definition of Done, every packet:**
1. Every mandatory acceptance criterion has evidence in `evidence/<packet>.md`.
2. Prove-red performed for each new guard: disable it alone, confirm a named test fails,
   restore byte-exact, confirm the restore by hash.
3. Affected graph green with a recorded scope rationale.
4. `tsc -p runner-v2/tsconfig.json --noEmit` and `tsc --noEmit` exit 0.
5. `npx eslint .` introduces no new error or warning.
6. Independent review has no unresolved mandatory finding.
7. Worker did **not** commit, stage or stash. The controller integrates.

**Mandatory injection discipline**, carried from P6.5 where each of these cost a real defect:
- An injection must be **proven to have changed the file** (byte count or SHA-256) before its
  result is read. A no-op injection is indistinguishable from a covered case.
- A **type-level** injection must be probed with `npx tsc --noEmit`, never a `tsx` script run;
  `tsx` strips types without checking them.
- Assert **exact sorted allow-lists**, never a negative `does not include` check. Prove both
  directions: adding a forbidden entry reddens, and removing a required entry reddens.
- An assertion that already passed **before** the feature existed proves nothing. Force it to
  fail once.
- Before reporting done, grep the test tree and confirm every new exported class, function and
  tool is **constructed or called** by a test, not merely imported as a type.

---

### I1 — Change-risk thresholds (investigation)

| | |
|---|---|
| Phase | I |
| Requirements | AC-14, AC-15 |
| Question | What threshold values for each D5 signal separate low / medium / high? |
| Deliverable | `evidence/I1.md`: for each of the 14 P6.5 packet commits, the measured signal values and which tier the proposed thresholds would assign. |
| Decision criterion | Thresholds are accepted if, replayed over the P6.5 commits, **no** commit that contained a review-found defect lands in `low`, and at least one trivially safe commit does. |
| Writable | `evidence/I1.md` only. No source changes. |
| Unlocks | C1 |

Rationale for measuring rather than guessing: §1.1 of SOURCE records which P6.5 packets
carried defects, so the ground truth already exists.

### I2 — Architect write allow-list (investigation)

| | |
|---|---|
| Phase | I |
| Requirements | AC-7 |
| Question | Which paths may the Architect write, and is the allow-list per-project configuration or a fixed default? |
| Deliverable | `evidence/I2.md`: proposed path set, the configuration surface, and a survey of what currently writes those paths. |
| Decision criterion | The set must exclude every path that can affect built output or test outcome. Verify by checking each candidate against `tsconfig` includes, `next.config`, and the test globs. |
| Writable | `evidence/I2.md` only. |
| Unlocks | A4 |

### I3 — Author model tier (investigation)

| | |
|---|---|
| Phase | I |
| Requirements | AC-14 |
| Question | Is "author model tier" an existing attribute, a new per-runtime declaration, or derived from `lib/providers/catalog.ts`? |
| Deliverable | `evidence/I3.md`: what is available today from `acceptedChangeAuthorRuntimeIds`, and the recommended source of tier. |
| Decision criterion | The chosen source must be available **inside the runner** without a network call, and must be deterministic. |
| Writable | `evidence/I3.md` only. |
| Unlocks | C1 |

---

### A1 — Per-role tool allow-lists, asserted

| | |
|---|---|
| Phase | A · Requirements | AC-5, AC-9 |
| Outcome | Every agent role's tool surface is an explicit, asserted allow-list. An unlisted tool fails closed. |
| Writable | `runner-v2/src/native-architect-runtime.ts`, `native-verifier-runtime.ts`, `native-plan-critic-runtime.ts`, `worker-runtime.ts`, and a new `runner-v2/src/role-capabilities.ts` |
| Forbidden | `tool-broker.ts` (approval semantics unchanged), every tool implementation, all Phase B and C surfaces |
| Depends on | nothing · **Required base** `6c166f97` |
| Produces | `ROLE_TOOL_ALLOWLISTS`, `assertRoleToolSurface(role, tools)` |

**Steps.** Extract today's effective tool list per role by construction, not by reading the
code, and record it as the starting allow-list. Replace each `if (tool.definition.readOnly)`
filter with admission against the named list. Add `assertRoleToolSurface`, modelled on the
existing `assertReadOnlyInspectionDefinition`, which throws on any admitted tool not in the
list and on any list entry not admitted.

**Acceptance.** Exact sorted list asserted per role. Architect, verifier and critic lists
contain no commit, integrate or complete tool; verifier and critic lists contain no plan or
task-review tool. Behaviour is otherwise unchanged at this packet — **no capability is added
here**.

**Prove-red.** Per role: add a forbidden tool to the list → red; remove a required tool → red;
admit a tool without listing it → the assert throws.

**Validation scope.** Affected graph = every test importing any of the four runtimes. Rationale:
this packet changes tool admission for all four agent roles, so any test constructing an agent
is in impact.

**Rollback.** Whole-packet revert; no durable data shape changes.

### A2 — MCP admission for reader roles

| | |
|---|---|
| Phase | A · Requirements | AC-10 |
| Outcome | A reader role receives only MCP tools whose server declares `readOnlyHint: true`. |
| Writable | `runner-v2/src/native-architect-runtime.ts`, `role-capabilities.ts` |
| Forbidden | `mcp-tools.ts` (the mapping from server hint to `readOnly` is unchanged), worker MCP admission |
| Depends on | **A1** (shares both files) |

**Steps.** Route MCP registration for reader roles through the A1 admission path, admitting
only `tool.definition.readOnly === true`. Worker MCP admission is untouched.

**Acceptance.** With a stub MCP manager exposing one `readOnlyHint: true` tool and one
without, the Architect receives exactly the first. The critic and verifier receive no MCP
tools, as today.

**Prove-red.** Remove the readOnly condition → the mutating stub tool appears in the exact
list → red.

**Validation scope.** Affected graph + `runner-v2/test/mcp-tools.test.ts` and
`mcp-lazy-native.test.ts`. Rationale: MCP admission path changes.

### A3 — Reader command execution, workspace-confined

| | |
|---|---|
| Phase | A · Requirements | AC-6, AC-8 |
| Outcome | Architect, verifier and critic can run commands. Reader execution cannot leave its own workspace. |
| Writable | the four runtimes, `role-capabilities.ts` |
| Forbidden | `evidence-tools.ts` (the command tool itself is unchanged), `tool-broker.ts` |
| Depends on | **A1** |

**Steps.** Add `run_evidence_command` to the Architect, verifier and critic allow-lists.
Confine reader execution to the reader's own workspace path; a `cwd` outside it is refused
with a typed error before the command runs.

**Acceptance.** AC-6: the Architect's exact list contains the command tool, and under a
non-`full` profile the call requires approval. AC-8: a reader command with a `cwd` outside its
workspace is refused; after a full reader run the project tree is byte-identical.

**Prove-red.** Remove the confinement check → the escaping `cwd` is accepted → red. Remove the
tool from a reader list → the capability test reddens.

**Validation scope.** Affected graph + `execution-host.test.ts`, `process-tools.test.ts`,
`permission-store.test.ts`. Rationale: this grants an `effect: "external"` tool to three new
callers, so approval and execution paths are in impact.

**Risk note for review.** This is the packet that most changes the system's security posture.
Independent review must specifically confirm that no reader can reach the project tree, and
that approval semantics under each of the three permission profiles are unchanged.

### A4 — Architect path-scoped writes, attributed

| | |
|---|---|
| Phase | A · Requirements | AC-7, AC-17 |
| Outcome | The Architect can write plan and spec paths, and those writes are attributed as an Architect-authored ChangeSet. |
| Writable | `native-architect-runtime.ts`, `role-capabilities.ts`, `filesystem-tools.ts` (allow-list policy only) |
| Forbidden | the mutation fence, worker write paths |
| Depends on | **A1**, **I2 accepted** |

**Steps.** Add an allow-list path policy alongside the existing `protectedPaths`. Admit the
filesystem mutation tools for the Architect **only** under that policy. Route the resulting
change into an Architect-authored ChangeSet.

**Acceptance.** AC-7: a write inside the allow-list succeeds; a write to `runner-v2/src/**` is
refused with a typed error. AC-17: the ChangeSet exists with an architect actor and appears in
the audit export.

**Prove-red.** Drop the allow-list check → the `runner-v2/src/**` write succeeds → red. Drop
the ChangeSet attribution → the audit assertion reddens.

**Validation scope.** Affected graph + `filesystem-tools.test.ts`,
`filesystem-mutation-fence.test.ts`, `git-production-managers.test.ts`. Rationale: a new
writer role reaches the mutation path.

**Cleanup note.** If a new source file under `runner-v2/src/` imports `node:fs`, it must be
added to the reviewed owner list in `filesystem-mutation-routing.test.ts`. That guard caught a
real miss at the P6.5 exit gate and throws on the **first** unreviewed owner, so one failure
does not prove there is only one.

---

### B1 — Manifest recording retry and durable note

| | |
|---|---|
| Phase | B · Requirements | AC-1, AC-2 |
| Outcome | A failed manifest write retries, and an exhausted failure is durably recorded in a store that did not fail. |
| Writable | `runner-v2/src/context-manifest-store.ts`, `scheduler-store.ts` (one new event), the three recording call sites |
| Forbidden | `sqlite-context-manifest-store.ts` schema, tool-ledger semantics, every Phase A and C surface |
| Depends on | nothing · **Required base** `6c166f97` |

**Steps.** Wrap the two I/O awaits in a bounded retry with backoff. On exhaustion append a
`context_manifest.recording_failed` event to the **scheduler store**, carrying purpose, task
id, attempt, revision, attempts made and the error reason. Then surface the failure to the
caller (B2 converts it into a pause).

**Acceptance.** AC-1: a stub store that fails N-1 times then succeeds records exactly once and
produces no note. AC-2: a permanently failing stub produces exactly one durable note in the
scheduler store with the reason.

**Prove-red.** Remove the retry → the transient stub produces a note → red. Point the note at
the manifest store instead of the scheduler store → the note is lost when the store is failing
→ red.

**Validation scope.** Affected graph = tests importing `context-manifest-store` or
`scheduler-store`. Rationale: new event type in a shared kernel surface.

### B2 — Architect resolution of a recording failure

| | |
|---|---|
| Phase | B · Requirements | AC-3, AC-4 |
| Outcome | An exhausted recording failure pauses the run and is resolved by exactly one typed Architect decision. |
| Writable | `build-runtime.ts`, `architect-tools.ts`, `user-steering-contracts.ts`, `scheduler-store.ts` (reason + applicability), `lib/client/runner-v2.ts`, `components/RunnerV2ObservabilityPanel.tsx` |
| Forbidden | Phase A and C surfaces |
| Depends on | **B1** |

**Steps.** Mirror the four existing pause-and-decide flows. Add the pause reason, the
`resolve_context_recording_failure` Architect tool with the three resolutions, the reducer
cases, and the surface.

**Acceptance.** AC-3: the runtime returns paused with the typed reason; the note is present;
the run does not advance. AC-4: each of the three resolutions has a test; a
`proceed_without_manifest` without a non-empty rationale is rejected **at the durable append
boundary**, not only in the tool.

**Prove-red.** Each of the three resolution branches disabled alone → red. The rationale check
removed → the empty-rationale waiver is accepted → red. The pause removed → the run advances
→ red.

**Validation scope.** Affected graph for `build-runtime`, `architect-tools`,
`user-steering-contracts`, `scheduler-store`, plus the two UI scripts. Rationale: four shared
kernel surfaces plus the client mirror.

---

### C1 — Deterministic change-risk assessment

| | |
|---|---|
| Phase | C · Requirements | AC-14 |
| Writable | new `runner-v2/src/change-risk.ts`, new `runner-v2/test/change-risk.test.ts` |
| Depends on | **I1 accepted**, **I3 accepted** |

**Steps.** Implement `assessChangeRisk(input): ChangeRiskAssessment` over the six D5 signals
with the I1 thresholds, returning `low | medium | high` plus the contributing reasons, in the
exact style of `assessPlanRisk`.

**Acceptance.** Identical input yields a deep-equal result across repeated calls; evidence
ordering is stable; the module contains no `Date`, `Math.random`, `process.env` or model call.

**Prove-red.** Each signal removed alone → a distinct named test reddens. Introduce a
`Date.now()` term → the determinism test reddens.

**Validation scope.** The new file plus any importer. Rationale: pure module, no shared
surface yet.

### C2 — Change critique contracts, events and selection

| | |
|---|---|
| Phase | C · Requirements | AC-11 (contracts), AC-12 |
| Writable | `plan-critique-contracts.ts`, `scheduler-store.ts`, `plan-critique-authority.ts` |
| Depends on | **C1**, **B2 integrated** (releases `scheduler-store.ts`, §5.2) |

**Steps.** Generalise the critique contracts with an explicit `stage: "plan" \| "change"`,
preserving every existing plan-stage shape unchanged. Add the change-stage events. Pass the
real `acceptedChangeAuthorRuntimeIds` at selection.

**Acceptance.** AC-12: emptying the Architect exclusion reddens one named test; emptying the
author exclusion reddens a **different** named test. Plan-stage behaviour is byte-identical —
prove by running the whole existing plan-critique suite unchanged.

**Prove-red.** Each exclusion set alone; each new reducer case body replaced by `break`.

### C3 — Change critic runtime, blind-first

| | |
|---|---|
| Phase | C · Requirements | AC-13 |
| Writable | `native-plan-critic-runtime.ts`, `agent-prompts.ts` |
| Depends on | **C2**, **A1 integrated** (allow-list exists) |

**Steps.** Add the change stage to the critic runtime. Turn one: the diff and the criteria,
**without** stage-1 findings. Turn two: the stage-1 findings, to mark which remain open.

**Acceptance.** AC-13: first-turn messages are asserted **not** to contain any stage-1 finding
id or claim text; second-turn messages are asserted to contain them. The exact stage-2 tool
list is asserted.

**Prove-red.** Provide the stage-1 findings in turn one → the `doesNotMatch` assertion reddens.

**Risk note for review.** This is the anchoring guarantee. Review must confirm the findings
cannot reach turn one through any channel — context pack, prompt, tool result or session
replay — using the same tool-surface reasoning that found the P6.5.6 `git.show` leak.

### C4 — Dispatcher stage and graded response

| | |
|---|---|
| Phase | C · Requirements | AC-11 (wiring), AC-15, AC-16 |
| Writable | `build-runtime.ts`, `native-build-factory.ts` |
| Depends on | **C3**, **A3 integrated** (high tier needs reader execution), **B2 integrated** (releases `build-runtime.ts`) |

**Steps.** Insert the change stage at integration, **before** the verifier. Route by tier:
low records a durable skip and advances; medium runs the critic read-only; high additionally
permits the critic to run the affected tests.

**Acceptance.** AC-11: ordering asserted — critic before verifier; blocking findings hold
integration. AC-15: one runtime test per tier. AC-16: at high tier, a durable command evidence
record exists and is cited by a finding.

**Prove-red.** Move the stage after the verifier → the ordering test reddens. Each tier branch
disabled alone → red. Remove the blocking gate → workers advance with an unresolved blocking
finding → red.

### C5 — Client, UI and audit surface

| | |
|---|---|
| Phase | C · Requirements | AC-11 (surface) |
| Writable | `lib/client/runner-v2.ts`, `components/RunnerV2ObservabilityPanel.tsx`, `scripts/test-runner-v2-observability.mts`, `scripts/test-runner-v2-client.mts` |
| Depends on | **C4** |

**Acceptance.** Every stage-2 state renders: skipped with tier and reason, findings with
severity, resolution, and the absent case. Counts differ for differing mixes.

**Note.** `lib/client/native-build-activity.ts` maps no event types — verified at the P6.5.5d
gate — so it needs no change. Re-verify rather than assume.

---

### D1g — Compatibility and program gate

| | |
|---|---|
| Phase | D · Requirements | AC-18, program gate |
| Depends on | A, B, C accepted |

**Steps.** Independent source-to-delivery reconciliation per §9, then the full suite on the
final integrated candidate, then the publication commit.

**Acceptance.** AC-18: a fixture run recorded before this program replays to an identical
projection. Full suite green. Every ledger row has evidence or an explicit disposition.

---

## 4. Dependency graph

```
I1 ─┐
I3 ─┼──────────────► C1 ──► C2 ──► C3 ──► C4 ──► C5 ──┐
I2 ─┼──► A4                  ▲       ▲      ▲          │
    │     ▲                  │       │      │          │
A1 ─┴──► A2                  │       │      │          ├──► D1g
 │   └──► A3 ────────────────┼───────┴──────┘          │
 └───────────────────────────┘                          │
                                                        │
B1 ──► B2 ──────────────────────────────────────────────┘
        │
        └── releases scheduler-store.ts and build-runtime.ts to lane C
```

Acyclic. Longest path: `I1/I3 → C1 → C2 → C3 → C4 → C5 → D1g` (7).

---

## 5. Lanes, ownership and serialized surfaces

### 5.1 Lane roster

MAX_WORKERS is 4. **This plan derives 2 lanes, opening to 3.** Deriving four would invent
parallelism the dependency graph does not support — `scheduler-store.ts` and
`build-runtime.ts` are contended between Phases B and C, and Phase C depends on Phase A.

| Lane | Packets | Exclusive write ownership |
|---|---|---|
| **Lane A** | I2 → A1 → A2 → A3 → A4 | the four agent runtimes, `role-capabilities.ts`, `filesystem-tools.ts` |
| **Lane B** | I1 → I3 → B1 → B2 | `context-manifest-store.ts`, `architect-tools.ts`, `user-steering-contracts.ts`, **and `scheduler-store.ts` + `build-runtime.ts` until B2 integrates** |
| **Lane C** | C1 → C2 → C3 → C4 → C5 | `change-risk.ts`, `plan-critique-*`, the client and UI surface; **inherits `scheduler-store.ts` + `build-runtime.ts` after B2 integrates** |

Lane C opens when B2 is integrated **and** I1, I3 are accepted. Before that, Lane C's worker
runs I1 and I3 (investigation only, no source writes).

### 5.2 Serialized surfaces — one owner at a time

| Surface | Owner sequence | Why |
|---|---|---|
| `scheduler-store.ts` | Lane B (B1, B2) → then Lane C (C2) | event union and reducer; concurrent edits conflict semantically, not just textually |
| `build-runtime.ts` | Lane B (B2) → then Lane C (C4) | dispatcher ordering |
| `native-plan-critic-runtime.ts` | Lane A (A1, A3) → then Lane C (C3) | tool admission before stage logic |
| `lib/client/runner-v2.ts`, the panel | Lane B (B2) → then Lane C (C5) | one client mirror |
| `filesystem-mutation-routing.test.ts` | **controller only** | a shared reviewed-owner audit list |

Different files do not prove independence. Lane A changes what tools every role receives; Lane
C constructs agents. Lane C must rebase onto integrated Lane A work before C3.

### 5.3 Controller

One controller owns: assignment (there is no atomic claim primitive — see §0.1), integration
order, the reviewed-owner audit list, the ledger, and acceptance state. Workers own only their
lane surfaces and their evidence file. Workers never commit.

---

## 6. Validation and evidence policy

### 6.1 Scope selection
Impact-based, not filename-based. Compute the affected graph as: the packet's own tests, plus
every test importing a changed shared kernel surface, plus any consumer identified by
inspecting callers. Record the rationale in the evidence file.

### 6.2 Full-suite policy
Exactly twice: the entry baseline in §0.3 (reusable) and the D1g exit gate. Never after a
packet, fix, review or merge. Rationale, carried from P6.5: ten full runs at ~35 minutes is
six hours of re-proving untouched code. **Accepted trade-off:** a defect escaping every
affected graph surfaces at the exit gate and is located by bisecting per-packet commits. This
happened once in P6.5 — an unreviewed native filesystem owner — and the gate caught it.

### 6.3 Evidence records
Each record in `evidence/<packet>.md` identifies: requirement and acceptance condition;
tested revision plus uncommitted-diff identity; command, environment and inputs; actual
outcome with exit status and pass/fail/skip counts; inspectable log paths; review disposition.

Zero selected tests, unexplained skips, stale results and prose-only claims do not prove
acceptance.

### 6.4 Evidence reuse
The §0.3 baseline is reusable while the relevant code, dependencies, configuration and
environment are unaffected; the record must state why it still applies. A documentation-only
commit does not invalidate behavioural evidence. When a change invalidates evidence, reopen
only the affected checks and dependents.

### 6.5 Fault injection
Only in disposable fixtures. Never mutate protected evidence or user data. Remove the
injection and retain the regression test. Restore byte-exact and prove it by hash.

---

## 7. Review and acceptance

**Planning review.** One independent coverage review by a fresh-context reviewer reading the
SOURCE — not this ledger — before PLAN READY. See §11: **this gate is currently
outstanding.**

**Packet review.** One independent review per packet. A worker never self-accepts. The review
covers source obligations, the actual diff and surrounding behaviour, evidence reliability,
missing behaviour and regressions, and scope compliance. The reviewer reruns checks to resolve
concrete concerns, not to repeat worker commands by default.

**Controller accepts a packet only when** every mandatory criterion has valid evidence,
independent review has no unresolved mandatory finding, integration and affected-boundary
checks passed, and the state records reflect it.

**Gate enforcement is procedural**, not mechanical — see §0.1. Do not claim otherwise.

**States:** PLANNED, READY, RUNNING, IN_REVIEW, READY_TO_INTEGRATE, BLOCKED, ACCEPTED.

---

## 8. Repair policy

REPAIR_BUDGET 3 evidence-backed cycles per tracked blocking issue, counted across sessions and
replacement agents. A cycle is a substantive correction plus validation, not a diagnostic
command. Related symptoms of one root cause share an issue record; renaming a failure does not
reset the budget.

Escalate only for: a genuine authority decision, an unsafe or destructive action, an
unresolved requirement conflict, an owner-dependent external blocker, a proposed weakening of
a control, or an exhausted budget. A blocked lane does not block the program.

---

## 9. Program closure

1. Independent source-to-delivery reconciliation against the SOURCE, before the expensive
   suite. Reuse accepted packet reviews; do not re-audit unchanged implementation.
2. Repair omissions with targeted validation.
3. Full `npm run test:runner-v2` on the final integrated candidate, plus both typechecks,
   ESLint and `npm run build`.
4. Publication commit refreshing `public/*.zip`.
5. Ledger reconciled; every row evidence-backed or explicitly dispositioned.

"Complete" means the agreed obligations are verified — not that every possible defect has been
disproved. §3 of SOURCE records what this program cannot catch.

---

## 10. Launch cards

### Controller

> You are the controller and integrator. Read
> `.superpowers/sdd/2026-09-22-runner-v2-agent-capability/STATE.md` first, then this plan's §5
> and §7. You own assignment, integration order, the ledger, and
> `filesystem-mutation-routing.test.ts`. There is no atomic claim primitive: serialize every
> assignment yourself and record worker, lane, base and ownership. Workers never commit — you
> integrate. Enforce §5.2 surface ownership before releasing a packet. Reserve the full suite
> for D1g.

### Lane A

> You own Lane A: I2 → A1 → A2 → A3 → A4. Read STATE.md, then §3.0 and your packet contracts.
> Writable: the four agent runtimes, `role-capabilities.ts`, `filesystem-tools.ts`. Everything
> else is forbidden, including `scheduler-store.ts` and `build-runtime.ts` — Lane B owns those.
> Base `6c166f97`, worktree per §5. A3 changes the security posture; expect a focused review.
> Do not commit, stage or stash. Write evidence to `evidence/<packet>.md`. Continue through
> eligible packets without approval stops; persist a handoff if blocked.

### Lane B

> You own Lane B: I1 → I3 → B1 → B2. Read STATE.md, then §3.0 and your packet contracts.
> Writable: `context-manifest-store.ts`, `architect-tools.ts`, `user-steering-contracts.ts`,
> and — **until B2 integrates** — `scheduler-store.ts` and `build-runtime.ts`. You must release
> those two the moment B2 is accepted; Lane C is blocked on them. Base `6c166f97`. Do not
> commit, stage or stash.

### Lane C (opens after B2 integrates and I1, I3 are accepted)

> You own Lane C: C1 → C2 → C3 → C4 → C5. Read STATE.md and §3.0 first. Rebase onto integrated
> Lane A work before C3 — your agents are constructed with Lane A's allow-lists. C3 carries the
> anchoring guarantee: prove stage-1 findings cannot reach stage 2's first turn through **any**
> channel, including the tool surface. Do not commit, stage or stash.

---

## 11. Verdict

**PLAN BLOCKED — independent planning coverage review not yet performed.**

- **Outstanding condition:** §7 requires one independent coverage review by a fresh-context
  reviewer reading the SOURCE directly, before PLAN READY. The plan author cannot satisfy it;
  self-review is not independent review.
- **Responsible owner:** controller.
- **Unblock action:** dispatch a fresh-context reviewer against
  `docs/superpowers/specs/2026-09-22-runner-v2-agent-capability-model-design.md`, repair any
  coverage gap, re-review only the corrections and affected coverage, then re-issue the verdict.

Three requirement rows additionally sit at `INVESTIGATE` (AC-14 via OQ-1 and OQ-3) and one
packet is gated on I2 (AC-7). Those are scheduled investigation packets, not planning gaps.

**Execution has not started. Planning readiness does not authorize execution.**
