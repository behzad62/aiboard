# Independent planning coverage review

Reviewer context: fresh. Source read first. This section was written before the plan or STATE.md were opened.

Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-5`
Branch claimed by the brief: `docs/agent-capability-and-change-critique` at `ea0b7450`
Source: `docs/superpowers/specs/2026-09-22-runner-v2-agent-capability-model-design.md`
Status of source: APPROVED SOURCE, owner-approved 2026-09-22. Base revision cited: `6c166f97`.

---

## STEP 2 — Obligations derived from the SOURCE only

Derived from the source text, including section 3 (honest limits) and section 5 (open questions). The source's own AC table is treated as one input among the prose decisions, rejections, and limits — not as a ledger to confirm.

### D1 — Context-manifest recording failure (closes OD-3)

- **OB-D1-1 (mandatory).** A failed `recordContextPack` write retries with bounded backoff before it is treated as failed. The backoff is bounded; it is not an unbounded spin.
- **OB-D1-2 (mandatory).** After retries are exhausted, a durable note is written to the **scheduler store**, which is a different database from the context-manifest ledger that failed, so the note can land when that ledger cannot.
- **OB-D1-3 (mandatory).** Only after that note is written does the run pause and present a typed decision. The run never silently continues past an exhausted recording failure, and it never dies without the note.
- **OB-D1-4 (mandatory, security/audit).** The Architect resolves the pause with exactly one of `retry`, `proceed_without_manifest`, or `abort`. Each resolution is durable and attributed.
- **OB-D1-5 (conditional).** `retry` means the cause is addressed or transient, and recording is re-attempted, again bounded. It must not be an unbounded Architect retry loop.
- **OB-D1-6 (conditional, security).** `proceed_without_manifest` is legal only with a written rationale. The run may continue, and the audit gap stays attributed to that author and reason. A waiver without a rationale is refused. This is the same device as RG-2 `acceptedFailures`: a waiver is not a silent gap.
- **OB-D1-7 (conditional).** `abort` stops the run and the reason is recorded.
- **OB-D1-8 (mandatory, rejected alternative).** Recording must not become silently non-gating. Leaving the manifest purely fail-closed (a locked file kills the build for an audit write) is also rejected. The Architect decides.
- **OB-D1-9 (mandatory, security).** The tool ledger stays fail-closed. It fences and de-duplicates tool calls; proceeding after a failed tool-ledger write is unsafe. This change applies only because the context manifest is audit-only and nothing reads it to make a decision. Do not weaken `SqliteToolLedger`.
- **OB-D1-10 (operational).** The failure path applies wherever `recordContextPack` is awaited on the model-call path. The source names the Architect, worker, and verifier runtimes, not the Architect alone.
- **OB-D1-11 (operational).** The pause reuses the existing pause-and-decide vocabulary already used for repair-cycle limit, verifier unavailable, worker replan, and plan-critique resolution. It does not invent a new interaction model.
- **OB-D1-12 (mandatory, unresolved in the source).** If the scheduler-store note itself cannot be written, the run still must not continue silently and must not die without a note. The source requires both properties and does not specify the double-failure case. The plan has to own that case explicitly.

### D2 — Capability model

- **OB-D2-1 (mandatory, security).** Every role boundary is an explicit allow-list, **asserted at registration**, failing closed on an unlisted tool. A filter alone is not enough, because a filter can drift.
- **OB-D2-2 (mandatory).** Worker surface stays: read project, run commands, write project code, write plans/specs, and no lifecycle authority.
- **OB-D2-3 (mandatory).** Architect gains the ability to run commands. Those commands remain subject to the run's permission profile.
- **OB-D2-4 (mandatory, security).** Architect cannot write project code. The Architect is also `review_task`; writing code would make it review its own code. That independence boundary is not reopened.
- **OB-D2-5 (mandatory, security).** Architect may write only under configured plan/spec paths. Any other project write is refused. The mechanism is an allow-list variant of the existing `hiddenPaths` (read) and `protectedPaths` (write) machinery in `filesystem-tools.ts`.
- **OB-D2-6 (mandatory).** Architect keeps lifecycle authority for plan, review, integrate, and complete.
- **OB-D2-7 (mandatory, security).** Independent verifier and plan/change critic may run commands only inside their own disposable workspace copy. The user's project is never mutated by a reader. The verifier already has a workspace; RG-6 added a second baseline workspace. The critic needs the same isolation.
- **OB-D2-8 (mandatory, security).** Verifier and critic cannot write project code and cannot write plans/specs.
- **OB-D2-9 (mandatory, security).** No reader role (Architect, verifier, critic) can commit, integrate, or complete the run through the new capability. Verifier and critic additionally cannot alter the plan or review tasks. Lifecycle authority for those two roles is typed output only: verdict for the verifier, findings for the critic.
- **OB-D2-10 (mandatory, rejected alternative).** Do not give the Architect full worker powers. Do not keep readers execution-free.
- **OB-D2-11 (operational, evidence).** A reader running a command is on-book. `run_evidence_command` already records exit code, output, and revision as durable attributable evidence. Reader execution must produce that same class of evidence, not an unlogged side effect. This is broader than the high-risk test tier alone.
- **OB-D2-12 (security, scope of the old invariant).** `VERIFIER_AUTHORITY_INVARIANTS` forbids editing files, creating commits, integrating changes, altering the plan, reviewing worker tasks, and completing the run. Execution-to-check-a-claim is intentionally outside that list. The new allow-list must not re-expand into those forbidden authorship and lifecycle actions, and must not keep execution excluded as collateral of a read-only filter.

### D3 — MCP filtering for reader roles

- **OB-D3-1 (mandatory, security).** Reader roles admit only MCP tools whose server declares `readOnlyHint: true`. Admission is asserted in the same style as the verifier's existing read-only inspection assert, not merely filtered.
- **OB-D3-2 (mandatory, security).** The assert applies under every permission profile, including `full`. Today, under `full`, Architect MCP registration is unfiltered and approval is skipped (`permissionProfile !== "full"` is the approval gate, and MCP tools carry `effect: "external"`). The filter must hold when approval does not.
- **OB-D3-3 (mandatory, rejected alternative).** MCP is not banned. Read-only documentation lookup remains available. Forcing approval of MCP calls even under `full` is rejected, because that would change what the operator's `full` setting means.
- **OB-D3-4 (security).** Filesystem and git tools stay filtered by `readOnly` for the Architect, and extension capabilities stay limited to `readOnly === true && effect === "none"`, except where D2 deliberately adds command execution and path-scoped plan/spec writes. The MCP hole is closed without silently opening those other filters.
- **OB-D3-5 (conditional).** An MCP tool with `readOnlyHint` absent or false is refused for reader roles. Fail closed.

### D4 — Plan critic becomes a two-stage critic

- **OB-D4-1 (mandatory).** Extend the existing critic. Do not add a parallel reviewer role. One configuration surface, one finding contract, one resolution flow, one selection rule, one UI, one test family.
- **OB-D4-2 (mandatory).** Stage 2 reviews the change, not the plan. Order is: plan → critic stage 1 → workers → integrate → critic stage 2 → verifier (criteria) → final verification → complete.
- **OB-D4-3 (mandatory).** Stage 2 runs at integration and **before** the verifier. If the critic blocks, the verifier's budget is not spent on a change that is about to change.
- **OB-D4-4 (mandatory, reuse).** Reuse unchanged: `PlanCritiqueFinding` (severity, category, taskIds, claim, evidence), the blocking gate, Architect `resolve_plan_critique`, advisory auto-resolution, the independence selection rule, and the observability surface.
- **OB-D4-5 (mandatory, security).** Plan-critic selection still excludes the Architect. Change-critic selection excludes the Architect **and** every worker who authored an accepted change. `selectVerifier` already takes `acceptedChangeAuthorRuntimeIds`. Stage 1 passes `[]`. Stage 2 passes the real authors.
- **OB-D4-6 (mandatory, conditional outcome).** Stage 2 may select a different model than stage 1. The plan must not require the same model across stages.
- **OB-D4-7 (mandatory, anti-anchoring).** Stage 2 is blind-first. Its own stage-1 findings are not in the first turn. It forms and files findings against the diff first. Only after that is it shown the stage-1 findings, and it marks which of those remain open. Showing prior conclusions up front is rejected because it recreates the anchoring RG-6 removed and would catch only the smaller "criterion existed but was not exercised" class.
- **OB-D4-8 (mandatory).** The verifier's output channel stays criterion-shaped. `submit_verifier_verdict` is not given a freeform findings channel. The critic is what reports what the contract missed. `assertExactVerifierCriteria` (every criterion once, no extras) stays intact.
- **OB-D4-9 (operational).** A blocking finding can halt delivery, and that halt stays gated by Architect resolution. A critic that cannot block is rejected. An ungated reader stop, with no Architect resolution, is also outside the design.

### D5 — Change critique is risk-gated with graded depth

- **OB-D5-1 (mandatory).** Stage 2 is not run on every build, and it is not a binary skip-or-full review.
- **OB-D5-2 (mandatory).** Change risk is deterministic, in the style of `assessPlanRisk`: no clock, no randomness, no environment lookup, no model call. The same change always yields the same risk.
- **OB-D5-3 (mandatory).** The risk function consumes all six signals: author model tier (fast/cheap earns more scrutiny; authorship already durable via `acceptedChangeAuthorRuntimeIds`); shared-kernel surface touched (scheduler store versus a README); source changed with no test changed; task required more than one attempt; an `acceptedFailures` waiver was used; size in files and lines touched.
- **OB-D5-4 (conditional).** Low risk: durable skip recorded with a reason. Cost is approximately zero. No model pass.
- **OB-D5-5 (conditional).** Medium risk: read the diff and file findings. One model pass. Running tests is not required at this tier.
- **OB-D5-6 (conditional).** High risk: read the diff and run the affected tests in the critic's own workspace. One model pass plus compute. Results are durable evidence. The point of the top tier is to show whether a test does anything, including by breaking a guard and observing that zero tests failed.
- **OB-D5-7 (mandatory, open question).** Concrete low/medium/high thresholds are OQ-1. They come from measurement against real P6.5-era changes, not from a guessed constant. The plan's investigation work must produce those thresholds.
- **OB-D5-8 (mandatory, open question).** "Author model tier" has no attribute today. OQ-3 requires a decision: declared per-runtime attribute, or derived from the model catalogue. The plan must not invent a tier field without that decision, and the signal cannot be dropped to avoid the question.
- **OB-D5-9 (operational).** "Shared kernel surface" needs a concrete definition. The source's example is scheduler store versus README. The plan must say which paths or surfaces count.
- **OB-D5-10 (operational).** "Affected tests" at high risk needs a concrete selection rule. The source requires the critic to run them itself and record the results.

### D6 — Architect plan/spec writes are attributed

- **OB-D6-1 (mandatory, security/audit).** Architect writes under the allow-listed plan/spec paths land as an Architect-authored ChangeSet: attributed, present in the audit, and carrying **no** acceptance criteria.
- **OB-D6-2 (mandatory, rejected alternative).** Plans are not kept only in runner-private state and exported on demand. The plan stays in git, where the owner reads it.
- **OB-D6-3 (mandatory, open question).** OQ-2: which paths form the allow-list. `docs/superpowers/plans/` and `docs/superpowers/specs/` are the obvious candidates in this repository. The plan must decide the concrete set. Writes outside it are refused (OB-D2-5).

### Section 3 — Honest limits (constraints on what the plan may claim)

- **OB-L-1 (scope).** Timing, load, and real-world behaviour are findable by neither careful reading nor execution. That class belongs to P7 real-world qualification and is out of scope. The plan must not claim or build coverage for it.
- **OB-L-2 (security).** The Architect cannot repair runner-private state, and this design does not grant that. Under D1 the Architect's choices are retry after a transient cause, waive with a reason, or stop. SQLite ledgers and workspaces under `stateDirectory` are written only by the runner. Opening them to an agent is forbidden because it would undermine fencing, ownership, and replay.
- **OB-L-3 (operational).** Stage 2 costs a full model pass over the diff at medium and high, plus compute at high. That cost is measured before it is treated as acceptable at scale. D5 bounds it; it does not make the cost zero.
- **OB-L-4 (operational).** A blocking critic finding is allowed to halt a build, and the halt is gated by Architect resolution. The plan must preserve both the halt and the gate.

### Compatibility and process

- **OB-C-1 (compatibility).** Runs created before this change keep current semantics and remain replayable.
- **OB-C-2 (compatibility).** Existing stage-1 plan critique behaviour stays: same finding contract, same blocking gate, same resolution, same independence rule with an empty author exclusion list.
- **OB-C-3 (compatibility).** Worker capabilities and the tool ledger's fail-closed behaviour are unchanged.
- **OB-C-4 (compatibility).** `full` still means the operator is not prompted for each external call. The new MCP `readOnlyHint` assert is a capability filter, not a new approval prompt.
- **OB-C-5 (process).** The design extends the P6.5 review-gap closure and closes OD-3. It supersedes nothing. Decomposition, ownership, and acceptance routes belong to the execution plan.

### Acceptance-route obligations implied by the source (not a phase split)

These are about what would count as proof, derived from the source's own examples of how criteria failed in P6.5.

- **OB-P-1.** A criterion that names a runtime transition (pause, retry, abort, skip, block-before-verifier) is not proved by a parser or type test alone. Something must exercise the transition.
- **OB-P-2.** "Asserted, failing closed" (tool allow-list, MCP hint, path allow-list) is proved by an unlisted or disallowed tool/path being rejected at registration or call time, not by the allow-list existing.
- **OB-P-3.** "User project never mutated" is proved by a reader command that writes, run against a fixture project, leaving that project unchanged while the disposable workspace may change.
- **OB-P-4.** Blind-first is proved by the first critic turn's input not containing stage-1 findings, and by a later turn that does and records which remain open.
- **OB-P-5.** Determinism is proved by identical inputs yielding identical risk with clock, randomness, environment, and model calls unavailable to the function.
- **OB-P-6.** Replay compatibility is proved by replaying a pre-change run, not by a comment that old runs are supported.

---

End of STEP 2. The plan had not been opened when the list above was written.

---

## Coverage

Plan ledger: `docs/superpowers/plans/2026-09-22-runner-v2-agent-capability-and-change-critique.md` §1. State file matches that ledger and does not add requirements.

| Obligation | Ledger row | Verdict |
|---|---|---|
| OB-D1-1 bounded retry | AC-1 / B1 | covered |
| OB-D1-2 note in the scheduler store, not the failed ledger | AC-2 / B1 | covered |
| OB-D1-3 pause, no silent continue, note present | AC-3 / B2 | weakened — happy path only; see finding I-1 |
| OB-D1-4 exactly one of three resolutions, durable and attributed | AC-4 / B2 | covered |
| OB-D1-5 Architect `retry` is bounded | AC-4 | MISSING |
| OB-D1-6 waiver requires a rationale, refused without one | AC-4 | covered — rejection is at the durable append boundary |
| OB-D1-7 `abort` records the reason | AC-4 | covered |
| OB-D1-8 not silently non-gating; not purely fail-closed | Phase B exclusions | covered |
| OB-D1-9 tool ledger stays fail-closed | Phase B forbidden surface | covered |
| OB-D1-10 every model-call recorder | B1 "three recording call sites" | MISSING — five awaits, four files; critic omitted. Finding B-1 |
| OB-D1-11 reuse existing pause vocabulary | B2 | covered |
| OB-D1-12 note write itself fails | — | MISSING. Finding I-1 |
| OB-D2-1 asserted allow-list, fail closed | AC-5 / A1 | weakened — lifecycle tools live on another broker. Finding B-2 |
| OB-D2-2 worker surface unchanged | AC-5 / A1 | covered |
| OB-D2-3 Architect commands, permission profile | AC-6 / A3 | covered for non-`full`; `full` skipping approval is only protected by forbidding `tool-broker.ts` |
| OB-D2-4 Architect does not author project code | AC-7, AC-9 | weakened — shell execution can write the project. Finding I-2 |
| OB-D2-5 path allow-list, other writes refused | AC-7 / A4 | weakened — one refused prefix. Finding I-3 |
| OB-D2-6 Architect keeps plan, review, integrate, complete | AC-9 / A1 | MISSING — A1 strips integrate and complete. Finding B-2 |
| OB-D2-7 verifier and critic execute only in their workspace | AC-8 / A3 | weakened. Finding I-2 |
| OB-D2-8 verifier and critic cannot write code or plans | AC-5, AC-9 | covered if today's lists are frozen |
| OB-D2-9 no reader commit / integrate / complete; verifier and critic cannot alter the plan or review tasks | AC-9 / A1 | weakened. Finding B-2 |
| OB-D2-10 rejected alternatives (full worker powers; execution-free readers) | Phases A and C | covered |
| OB-D2-11 reader commands produce durable command evidence | implicit via reusing `run_evidence_command` | covered for the tool; AC-16 adds a citation check only at high risk |
| OB-D2-12 do not re-ban execution in the authority prompt | — | MISSING. Finding I-4 |
| OB-D3-1 MCP `readOnlyHint: true`, asserted | AC-10 / A2 | weakened. Finding B-3 |
| OB-D3-2 filter holds under `full`; approval policy unchanged | A2 registration + forbidden `tool-broker.ts` | covered for Architect registration, if A2 can be implemented |
| OB-D3-3 do not ban read-only MCP; do not force approval under `full` | A2 | weakened — verifier and critic stay at zero MCP. Finding B-3 |
| OB-D3-4 do not open the filesystem, git, or extension filters as a side effect | A1 snapshot | weakened — `PlanOnlyInspectionRuntime` is a second filter. Finding I-5 |
| OB-D3-5 missing hint fails closed | A2 | weakened — real mapping also requires `destructiveHint === false`. Finding B-3 |
| OB-D4-1 extend the critic; no second role | C2–C5 | covered |
| OB-D4-2 stage 2 at integration after workers | AC-11 / C4 | covered |
| OB-D4-3 stage 2 before the verifier; a block spends no verifier budget | AC-11 / C4 | covered by the ordering test plus "blocking findings hold integration" |
| OB-D4-4 reuse finding shape, blocking gate, `resolve_plan_critique`, advisory auto-resolution, selection, observability | AC-11 | weakened. Finding I-6 |
| OB-D4-5 stage 1 passes `[]`; stage 2 passes real authors | AC-12 / C2 | covered |
| OB-D4-6 stage 2 may select a different model | AC-12 | covered — no same-model constraint |
| OB-D4-7 blind-first, then mark which stage-1 findings remain open | AC-13 / C3 | weakened — turn contents are tested; the mark is not. Finding I-6 |
| OB-D4-8 verifier stays criterion-only | no packet writes `verifier-tools.ts` | covered |
| OB-D4-9 a block halts delivery and Architect resolution is the gate | AC-11 | weakened. Finding I-6 |
| OB-D5-1 not every build; not binary | AC-15 | covered |
| OB-D5-2 deterministic; no clock, randomness, env, model | AC-14 / C1 | covered |
| OB-D5-3 all six signals | C1 | weakened — scorer only; nobody extracts the signals. Finding I-7 |
| OB-D5-4 low: durable skip with reason | AC-15 / C4 | covered |
| OB-D5-5 medium: read the diff, file findings | AC-15 / C4 | covered |
| OB-D5-6 high: critic runs the affected tests; results are evidence | AC-16 / C4 | weakened. Finding I-7 |
| OB-D5-7 thresholds from P6.5 measurement, not a guess | I1 | weakened — medium vs high is unconstrained. Finding I-7 |
| OB-D5-8 author-tier source decided, local and deterministic | I3 | covered |
| OB-D5-9 shared-kernel definition | — | MISSING. Finding I-7 |
| OB-D5-10 affected-test selection rule | — | MISSING. Finding I-7 |
| OB-D6-1 Architect ChangeSet, attributed, no acceptance criteria | AC-17 / A4 | weakened, and not implementable on the declared surface. Finding B-4 |
| OB-D6-2 plan stays in git | A4 | covered only if B-4 is repaired |
| OB-D6-3 concrete allow-list paths | I2 | covered |
| OB-L-1 timing / load / live behaviour stays out of scope | §9 cites source §3 | covered |
| OB-L-2 Architect cannot repair `stateDirectory` | no packet grants it | covered |
| OB-L-3 measure stage-2 cost before calling it acceptable at scale | §9 | covered — the plan does not claim that |
| OB-L-4 block is real and resolution-gated | AC-11 | weakened. Finding I-6 |
| OB-C-1 pre-change runs keep semantics and replay | AC-18 / D1g | weakened. Finding I-8 |
| OB-C-2 stage 1 stays byte-identical | C2 existing suite | covered |
| OB-C-3 worker surface and tool ledger unchanged | A1, Phase B exclusions | covered |
| OB-C-4 `full` does not grow a new approval prompt | forbidden `tool-broker.ts` | covered |
| OB-P-1 runtime transitions are exercised | AC-3, AC-15 | covered where the row names a runtime test |
| OB-P-2 fail-closed is proved by an unlisted rejection | AC-5, AC-10 | weakened for MCP and lifecycle tools |
| OB-P-3 a writing reader command leaves the user project unchanged | AC-8 | weakened. Finding I-2 |
| OB-P-4 first turn lacks stage-1 findings; a later turn records which remain open | AC-13 | weakened. Finding I-6 |
| OB-P-5 identical inputs, deep-equal risk | AC-14 | covered |
| OB-P-6 replay a pre-change run | AC-18 | weakened. Finding I-8 |

Reverse traceability is sound. I1–I3 are the source's open questions. A1–A4, B1–B2, and C1–C5 each sit on a source decision. C5 is the observability surface D4 says to reuse. D1g is AC-18. No packet is unrelated improvement.

---

## Findings

### BLOCKING

**B-1. Lane B and Lane A both write the recording call sites, and those files are not serialized.**
Phase B is "Independent of Phase A" (§2). B1's writable surface is `context-manifest-store.ts`, `scheduler-store.ts`, and "the three recording call sites." The awaits are five, in four files:

- `runner-v2/src/native-architect-runtime.ts:175`
- `runner-v2/src/native-verifier-runtime.ts:378` and `:651`
- `runner-v2/src/native-plan-critic-runtime.ts:181`
- `runner-v2/src/native-worker-driver.ts:161`

Lane A's roster owns the first three. §5.2 serializes `native-plan-critic-runtime.ts` as Lane A then Lane C, with no Lane B turn. `native-worker-driver.ts` is on nobody's roster. `worker-runtime.ts`, which A1 does own, does not call `recordContextPack`. The source text names architect, worker, and verifier and omits the critic; the plan copied "three" from that sentence.

Fix: name the four files. Put the retry and the note inside `recordContextPack` so B1 does not edit runtimes. If a call site must change, add it to §5.2 with an owner sequence, and do not start that packet while Lane A holds the file.

**B-2. A1 cannot be executed: it both freezes today's Architect tools and removes integrate and complete.**
D2's table gives the Architect lifecycle authority for plan, review, integrate, and complete. A1 says behaviour is unchanged and the starting list is today's effective list. A1's acceptance also says the Architect list contains no integrate or complete tool.

Those tools exist: `request_integration` (`architect-tools.ts:1482`) and `complete_run` (`architect-tools.ts:1528`). They are not on the inspection broker in `native-architect-runtime.ts`. `build-runtime.ts:1416` registers `createArchitectTools`. That file is serialized Lane B then Lane C. A1 cannot write it. An exact-list test on the inspection broker passes while `complete_run` stays registered, so AC-9's evidence does not prove the requirement. Applying the exclusion to the real tools deletes Architect authority the source keeps.

Fix: split AC-9. Verifier and critic lists exclude plan mutation, task review, commit, integrate, and complete. The Architect list keeps `request_integration`, `review_task`, and `complete_run`. Point the assertion at both brokers, and serialize `build-runtime.ts` before any packet that asserts the lifecycle list.

**B-3. A2 contradicts A1 and the MCP mapper.**
A1's `assertRoleToolSurface` throws when an admitted tool is not in the exact list. MCP tool names come from the server. A2 tells the worker to route reader MCP registration through that same admission path, and also says the critic and verifier receive no MCP tools. A2's writable files are only `native-architect-runtime.ts` and `role-capabilities.ts`, so it cannot change the verifier or critic anyway.

`createMcpTools` (`mcp-tools.ts:156-159`) sets `readOnly` only when `readOnlyHint === true` and `destructiveHint === false`, and it sets `effect: "external"`. A stub with `readOnlyHint: true` and no `destructiveHint: false` is not `readOnly`. The verifier assert (`native-verifier-runtime.ts:899-908`) rejects `effect !== "none"`, so that assert cannot admit an MCP tool. The source's "admit `readOnlyHint: true`" is narrower than this mapper, and A2 forbids editing `mcp-tools.ts`.

Fix: state that dynamic MCP names are a checked class, not entries in the static list. State the real predicate (`readOnlyHint === true && destructiveHint === false`). Decide explicitly whether verifier and critic stay at zero MCP tools; if they do, record that as a source deviation. If they do not, give A2 their runtimes and a new assert that accepts `effect: "external"` only for that class.

**B-4. AC-17 cannot be built on A4's writable surface, and the acceptance drops "no acceptance criteria."**
A4 may write `native-architect-runtime.ts`, `role-capabilities.ts`, and the allow-list policy in `filesystem-tools.ts`. It forbids the mutation fence and worker write paths. `createChangeSet` (`change-set.ts:63-100`) is the only ChangeSet constructor. It requires `taskId`, a `taskCommit`, and at least one evidence hash, and it throws if evidence is empty even when acceptance criteria are omitted. Nothing in the Architect path creates one today. Filesystem tools do not either.

AC-17's evidence is "ChangeSet present with architect actor; audit export contains it." The source also requires that this ChangeSet carry no acceptance criteria. That clause is not in the test.

Fix: add a packet whose writable surface includes the ChangeSet constructor and the integration/audit path, state how an Architect write gets a commit without a worker task, and assert the stored ChangeSet has no acceptance criteria. Keep that packet off `scheduler-store.ts` and `build-runtime.ts` until B2 releases them, or put it on Lane B after B2.

**B-5. Dependency instructions disagree, so a controller cannot assign work.**
- Roster, STATE, and the Lane B launch card give I1 and I3 to Lane B. §5.1 says Lane C's worker runs I1 and I3 before the lane opens.
- §5.2 serializes `native-plan-critic-runtime.ts` as Lane A (A1, A3) then Lane C (C3). C3's Depends on, the §4 drawing, and STATE require only A1. C3 can start while A3 still writes that file.
- §2 says Phase C starts only after A1 and B2 are integrated. C1 depends only on I1 and I3. The drawing matches C1, not the phase entry.

The B2 release itself is consistent where it is written as a fact: C2 waits for `scheduler-store.ts`, C4 waits for `build-runtime.ts`, and §5.2, STATE, and the Lane B launch card say the same thing. The §4 drawing does not. B2's only arrow is to D1g. The release is a caption, not an edge. The drawing is acyclic. The packet Depends-on graph is also acyclic. They are not the same graph.

Fix: one owner for I1 and I3. Make C3 depend on A3 integrated. Make the phase entry match C1, or make C1 depend on B2. Draw B2 → C2 and B2 → C4.

### IMPORTANT

**I-1. AC-3 and AC-4 do not bound the failure they exist for.**
B2 tests a pause when the note write succeeds, and one test per resolution. Two source constraints have no step and no test. Architect `retry` is "re-attempt recording, bounded"; nothing says what happens on the next exhaustion, so retry can loop. AC-3 says the run never dies without the note; if the scheduler append throws, every stated B1/B2 test still passes and the run dies with no note.

Fix: a finite retry budget whose exhaustion pauses again with the existing note, and a fail-closed path when the scheduler append throws that does not continue the model call.

**I-2. A3's confinement proof does not redden, and it does not say whose workspace is the project.**
`run_evidence_command` already rejects a `cwd` outside `context.workspacePath` in `containedDirectory` (`evidence-tools.ts:243-255`). A3 forbids editing that file. Removing a second check in the runtime still leaves this one, so an end-to-end prove-red stays green.

The Architect broker uses `projectRoot` (`native-architect-runtime.ts:248`). The critic already builds a disposable workspace (`native-plan-critic-runtime.ts:154-156`) and the verifier broker uses `workspace.path`. A3's acceptance says the project tree is byte-identical after a reader run, without saying the Architect is excluded from that sentence. A command in `projectRoot` can write project code, which is the boundary D2 keeps for filesystem tools and does not restate for shell.

Fix: name the workspace per role. Prove verifier and critic commands against a fixture project leave it byte-identical while their copy may change. For the prove-red, disable `containedDirectory` in a fixture double, or allow a one-line edit of that function under a named exception. State whether an Architect command may write the project.

**I-3. AC-7 is proved by one refused prefix.**
The acceptance refuses `runner-v2/src/**` and the prove-red deletes the allow-list check until that write succeeds. A denylist of that prefix satisfies the row and still allows writes under `lib/` or `app/`. I2's decision criterion (exclude paths that affect build or test output) is the right bar and is not what A4 tests.

Fix: assert refusal for a path outside the accepted allow-list and outside `runner-v2/src`, and assert success only for a path I2 recorded.

**I-4. The verifier prompt still forbids the execution D2 grants.**
`VERIFIER_AUTHORITY_INVARIANTS` (`agent-prompts.ts:25-31`) includes the source's authorship sentence and a further sentence: "Use only the provided read-only inspection tools." No packet rewrites it. C3 may edit `agent-prompts.ts`, for the blind-first prompt, after A3. A3 does not list that file.

Fix: give A3 `agent-prompts.ts`, or add a serialized handoff so the authority sentence is updated in the same packet that adds `run_evidence_command`. Keep the authorship prohibitions.

**I-5. `PlanOnlyInspectionRuntime` is a second read-only filter.**
`native-architect-runtime.ts:707-714` snapshots `readOnly && effect !== "workspace"` at construction. A1 says to replace each `if (tool.definition.readOnly)` filter. This `.filter` does not match that pattern, so plan-only mode can drift from `assertRoleToolSurface`.

Fix: name this class in A1 and admit through the same allow-list.

**I-6. Stage 2 reuses the finding type and not the resolution behaviour.**
When a plan critique has zero blocking findings, `build-runtime.ts:1684-1692` appends `plan_critique.resolved` and continues. That is the advisory auto-resolution the source says to reuse. `resolve_plan_critique` is the Architect tool for blocking findings. No C packet names either. C3 checks that turn two's messages contain stage-1 findings. It does not check that the critic records which of those findings remain open, and C2 does not add a field for that mark. A stage-2 block can hold integration with no resolution tool.

Fix: extend the existing resolve path for `stage: "change"`, keep the zero-blocking auto-resolve, and assert a durable "remains open" mark produced on turn two.

**I-7. Risk grading has a pure function and no producer, and high can be vacuous.**
C1 implements `assessChangeRisk(input)` over six signals. No packet computes those signals from a change. "Shared kernel" and "affected tests" are undefined. C4 says high "permits" the critic to run the affected tests. AC-16's test requires some command evidence record cited by a finding, so `echo ok` passes. I1 accepts thresholds when no defect-bearing P6.5 commit is `low` and one trivial commit is `low`. Every remaining commit may be `medium`. The execution tier the source wants for the six defects that were only provable by running can be empty while I1 and AC-16 are green.

Fix: a named signal producer with an explicit kernel set and an affected-test rule. I1 must place at least one execution-only defect commit in `high`. AC-16 must assert that command, not an arbitrary one.

**I-8. AC-18's fixture is not in the tree and no earlier packet records it.**
D1g says a fixture run recorded before this program replays to an identical projection. There is no checked-in pre-change scheduler projection for that comparison. After A/B/C land, "before" cannot be recorded from the integrated tree.

Fix: capture the fixture at program entry, before the first source packet, and name its path in D1g.

**I-9. Most packets forbid the tests their acceptance requires.**
§3.0 says anything not listed is forbidden. C1 and C5 list test files. A1–A4, B1, B2, and C2–C4 do not. A4's cleanup note tells the worker to update `filesystem-mutation-routing.test.ts`, which §5.2 reserves for the controller.

Fix: each packet's writable list includes the test files it must add or edit. The controller test stays controller-owned, and the packet stops at reporting a new `node:fs` importer.

### MINOR

**M-1.** Source line `evidence-tools.ts:45` is the start of `runEvidenceTool`. `readOnly: false` is line 65. The fact is true. `tool-broker.ts` approval is lines 272-280; the source says 272-279. The expression matches. Verifier filter is lines 884-890; the source says 885-889. The predicate matches.

**M-2.** AC-1's ledger evidence says "no pause." B1's own acceptance says "no note," and the pause does not exist until B2.

**M-3.** B1 says "bounded backoff" and never states the attempt count or the delay cap. The N-1 stub can pass for any bound the worker picks.

### Sound where checked

- The Depends-on graph is acyclic. Longest packet path is I1/I3 → C1 → C2 → C3 → C4 → C5 → D1g.
- No packet is scope creep relative to the source.
- `submit_verifier_verdict` stays a single `criterionVerdicts` channel. No packet writes `verifier-tools.ts`.
- The tool ledger is explicitly out of bounds.
- §0.1 is honest. Packet assignment has no atomic claim primitive; `owned-fence-lock.mjs` `tryClaim` is the runner's process fence, not a claim API for these lanes. §7 gates are stated as procedural. The plan does not describe them as harness-enforced.
- I2 and I3 have decision criteria a worker can apply. Stage-1 behaviour is pinned to the existing plan-critique suite.

---

## Source citation check

| Citation | Result |
|---|---|
| Architect filesystem and git filtered by `readOnly`; extension capabilities `readOnly === true && effect === "none"`; MCP registered unfiltered at `native-architect-runtime.ts:304-308` | True. MCP loop is lines 304-307 with no filter. The extension filter is lines 309-313. |
| Verifier `createInspectionTools` filter and `assertReadOnlyInspectionDefinition` | True. Filter requires `readOnly`, `effect === "none"`, and `lifecycle !== true`, then the assert throws. |
| `submit_verifier_verdict` has only `criterionVerdicts` | True. Schema `additionalProperties: false`, `required: ["criterionVerdicts"]`. Items carry rationale and evidence, not a second top-level channel. |
| `run_evidence_command` is `readOnly: false` because a command can write its cwd | True. Also `effect: "external"`. Line number is the function, not the flag (M-1). Architect registration keeps only `inspect_evidence`. |
| `selectVerifier` takes `acceptedChangeAuthorRuntimeIds` at `runtime-router.ts:189` | True. Plan critic passes `[]` (`native-plan-critic-runtime.ts:135`). Verifier passes real authors (`native-verifier-runtime.ts:250`). |
| Approval is `permissionProfile !== "full" && (… effect === "external" …)` | True. The condition also includes outside-workspace, destructive, network, and credential access, and any non-`none` effect under `guarded`. |
| `hiddenPaths` read policy, `protectedPaths` write policy | True. |
| `recordContextPack` awaits `artifacts.put` and `store.record` with no try/catch | True of that function (`context-manifest-store.ts:131-142`). The try/catch at line 73 is `parseContextManifestPayload`. |
| `review_task` at `architect-tools.ts:1338` | True. |
| `VERIFIER_AUTHORITY_INVARIANTS` authorship sentence | True, and the next sentence still limits the verifier to read-only tools (I-4). |
| Architect, worker, and verifier await `recordContextPack` | Incomplete. The critic awaits it too, the verifier awaits it twice, and the worker await is in `native-worker-driver.ts`, not `worker-runtime.ts`. This is the count B-1 inherits. |
| MCP `readOnly` comes from `readOnlyHint` | Incomplete. `readOnly` also requires `destructiveHint === false`, and `effect` is `"external"`. This is the predicate B-3 inherits. |

No cited mechanism is invented. Two citations are incomplete in a way that the plan's packets depend on.

---

## Files two lanes would both write that §5.2 does not serialize

| File | Who the plan tells to write it | In §5.2? |
|---|---|---|
| `runner-v2/src/native-architect-runtime.ts` | Lane A (A1–A4) and Lane B (B1 call site), in parallel | No |
| `runner-v2/src/native-verifier-runtime.ts` | Lane A (A1, A3) and Lane B (B1 call sites), in parallel | No |
| `runner-v2/src/native-plan-critic-runtime.ts` | Lane B if B1 treats the critic as a recording call site, while §5.2 only sequences Lane A then Lane C | Sequenced for A then C only |
| `runner-v2/src/native-worker-driver.ts` | B1, once the worker finds the real call site | No roster entry at all |
| `runner-v2/src/build-runtime.ts` | Already B then C. A1's lifecycle assertion needs it too if AC-9 is real | Sequenced for B then C only |
| `runner-v2/test/scheduler-store.test.ts`, `native-architect-runtime.test.ts`, `native-plan-critic-runtime.test.ts` | Whichever packet proves an edit to the matching source. Not listed, so the §3.0 ban and the acceptance tests disagree (I-9) | No |

`scheduler-store.ts`, `build-runtime.ts`, `lib/client/runner-v2.ts`, and `components/RunnerV2ObservabilityPanel.tsx` are serialized, and the packet Depends-on fields wait for the prior owner. Those four are not the gap.

---

## Verdict

**PLAN COVERAGE INSUFFICIENT**

Blocking conditions:

1. B1 and Lane A write the same runtime files in parallel, and §5.2 does not say so (B-1).
2. A1 both preserves and removes Architect integrate/complete, on a broker the packet cannot edit (B-2).
3. A2 cannot admit dynamic MCP tools through A1's exact list, and its acceptance contradicts its steps (B-3).
4. A4 cannot produce the Architect ChangeSet AC-17 requires, and the row drops "no acceptance criteria" (B-4).
5. I1/I3 have two owners, and C3 can start before A3 releases `native-plan-critic-runtime.ts` (B-5).

Execution is not authorized until those five are repaired and the corrected packets are reviewed again. The §4 drawing being acyclic does not clear B-5.
