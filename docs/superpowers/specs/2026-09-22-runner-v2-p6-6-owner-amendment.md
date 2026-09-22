# Runner V2 P6.6 — Owner amendment, 2026-09-22

**Status:** APPROVED OWNER AMENDMENT to P6.6. It is a SOURCE document for
`docs/superpowers/plans/2026-09-06-runner-v2-evidence-gated-planning.md` alongside the
existing source `docs/superpowers/specs/2026-09-08-runner-v2-evidence-gated-planning-source.txt`
(SHA-256 `c228180addae043c3ffc793d229178c213f9a1540a666cb91c5ed92468750906`). That existing
source is byte-identical to the owner's planning standard `~/.claude/plan-standard.md`: P6.6 is
the work of making Runner V2 follow that standard for its own Builds.

This amendment **adds** obligations. It removes and weakens none.

## Authority

Owner decisions in session 2026-09-22, recorded verbatim:

> "P6.6 is not set in stone. so split as you suggested and move them to P6.6, Also I would like
> to take your suggestions also to make the best and most robust possible agent harness tool
> without wasting tokens. And yes we need to support questions in the build mode too."

Two design goals therefore govern every item below and are themselves obligations:
**robustness** — a defect should be caught by structure, not by hoping a model notices — and
**token economy** — no model pass without a stated purpose, and no pass over unchanged input.

## Origin

The items come from two places:

1. **Moved from the agent-capability design**
   (`docs/superpowers/specs/2026-09-22-runner-v2-agent-capability-model-design.md`, revision 1,
   decisions D4, D5, D7). That design was reviewed four times; the reviews established that these
   decisions duplicate P6.6 T3 (coverage review) and T6 (deliverable review), and P6.6 forbids a
   second competing critic or coverage authority. Their distinctive ideas land here instead.
2. **Found during that work:** a request that needs no build cannot be handled in Build mode today.

The evidence motivating all of it: P6.5 shipped ten packets and independent review found fifteen
real defects, **each after the implementing worker reported a fully green suite**. Roughly twelve
had no acceptance criterion able to catch them, because every existing review layer is
criterion-shaped. Roughly six were only provable by execution. And the review pattern that caught
them — a fresh-context reviewer that reads the original source, writes down what it requires
**before** looking at the artifact, then compares — is the pattern the owner asked Runner V2 to
adopt.

---

## OA-1 — Coverage review derives obligations before it may read the plan

P6.6 T3 already requires one independent reviewer reading the entire original source, and a
negative test for a reviewer that "sees only the ledger". It does not fix the **order**.

**Obligation.** The coverage reviewer:
1. runs in a **fresh session whose event list is empty at derivation**;
2. reads the approved source and amendments — and, for an ordinary Build request, the objective
   and durable user guidance — and **nothing produced by the Architect**;
3. **durably records** the obligations it derives, **before** the plan is provided;
4. only then receives the plan;
5. returns one verdict per derived obligation: `covered`, `weakened` or `missing`.

The kernel refuses a coverage verdict when no obligations were recorded first. This reuses the
device RG-6 already proved in P6.5: `record_verification_expectations` and the reducer gate that
refuses a two-pass verdict without recorded expectations.

**Why.** An agent shown a conclusion tends to confirm it. RG-6 removed that bias from the
verifier; without ordering, a coverage reviewer handed the plan first becomes a plan reader.

**Proof required.** Assertions on the deriving turn's **actual messages, tool results and loaded
session** — covering context pack, prompt, tool result, session replay and an earlier-turn
checkpoint — that the source is present and no plan or criteria text is. A section-id check is a
helper, not the proof: planning review showed it can pass while the turn has already seen the plan.

## OA-2 — Finding vocabulary for what the criteria missed

Additive to the existing eight plan-critique categories:

| Category | Means |
|---|---|
| `missing_coverage` | the source requires it and nothing delivers it |
| `weakened_obligation` | something covers it, for less than was asked |
| `scope_creep` | work that serves no part of the source |
| `unverified_claim` | a cited evidence record does not support the claim citing it |

A criterion that existed but was **never exercised** must be expressible as `weakened`, not
collapsed into `covered` — that is the exact shape of the P6.5 defect where a documented
acceptance criterion threw on every call while its packet's suite was green. `scope_creep` and
`unverified_claim` are reportable even though they are not per-obligation verdict values.

**`unverified_claim` is decided mechanically wherever it can be:** the cited evidence record
exists, and its command, exit status, revision and artifacts match what the claim asserts. Only
the residue is reviewer judgement, and it is recorded as judgement.

## OA-3 — Deliverable review forms its view before reading the worker's claims

P6.6 T6 requires one combined independent deliverable review bound to the exact submitted change
and evidence. **Obligation:** that review forms its findings from the source criteria and the
exact diff **before** it is shown the worker's report or self-assessment, then marks each worker
claim `verified` or `unverified`.

**Selection excludes both the Architect's model identity and every model that authored the
change.** `RuntimeRouter.selectVerifier` already accepts `acceptedChangeAuthorRuntimeIds`
(`runtime-router.ts:189`); reuse it.

**Why.** Four P6.5 workers reported green on broken work. A reviewer that reads the report first
starts from "it works".

## OA-4 — Review depth follows deterministic change risk

P6.6 EP21 already permits additional specialist review "with a stored risk reason". This
obligation makes that reason **computed**, not asserted.

**Change risk** is deterministic — no clock, randomness, environment lookup or model call:

| Signal | Rationale |
|---|---|
| author model tier | fast, cheap workers earn more scrutiny |
| shared kernel surface touched | an explicit named set, not prose |
| source changed with no test changed | the loudest single smell in P6.5 |
| task needed more than one attempt | it already struggled |
| an `acceptedFailures` waiver was used | a red command was explicitly accepted |
| size | files and lines |

**Depth by tier** — every task still gets its one mandatory independent review (EP21):

| Tier | Review depth |
|---|---|
| low | the standard review, reading only |
| medium | the standard review with repository inspection |
| high | specialist depth: the reviewer **runs the affected tests itself**, recorded as evidence |

The high-tier command must be the **affected-test command derived mechanically** from a named
rule. An arbitrary command must not satisfy it — planning review showed `echo ok` would otherwise
pass.

**Thresholds are measured, not chosen.** Replayed over the fourteen P6.5 packet commits, whose
review-found defects are recorded in the P6.5 ledger, thresholds are accepted only if: no
defect-carrying commit lands in `low`; at least one trivially safe commit lands in `low`; and at
least one commit whose defect was only provable by execution lands in `high`.

**Requires** the agent-capability program's reader execution (its D2), because the high tier has
the reviewer execute.

## OA-5 — Questions are supported in Build mode

**Problem, verified at `6c166f97`.** AIBoard routes questions to the `panel`, `debate` and
`specialist` modes (`lib/db/schema.ts:481`), which never plan. But a question typed into **Build**
mode is forced into building: the Architect's first reason is always `plan_required`; no Architect
tool answers and stops; and `buildCompletionReadiness` (`scheduler-store.ts:848-873`) requires
terminal tasks, an integration revision and a current final verification, except under the
`plan_only` policy, which still requires a plan.

**Obligation.**

1. **Triage is the Architect's first action, not an extra model call.** It chooses `answer`,
   `build` or `clarify`, and the choice is durable.
2. **`answer` completes a run with no plan, no workers, no integration and no final
   verification.** The answer is durable and shown in the UI.
3. **The kernel enforces that an answered run changed nothing:** no task, no worker dispatch, no
   integration, no project mutation. This is a structural guarantee, not a prompt instruction.
4. **An answer that discovers a needed change converts explicitly to `build`,** with a durable
   conversion event. It never quietly edits the project.
5. **A mixed request** ("explain X, then fix Y") routes to `build`.
6. **`clarify`** pauses through the existing `ask_user` flow and returns to triage.
7. Answering may run commands in a disposable copy, per the agent-capability program's D2, and
   never mutates the project.
8. **Token economy:** no critic, coverage review or verifier runs on the answer path by default.
   The answer lists, in the same turn, the parts of the question it addresses. An independent
   answer review runs only when the user opts in for that run.
9. Runs created before this policy keep today's behaviour.

## OA-6 — Every model pass is accounted for

**Obligation.** Every model pass beyond the one that does the work — coverage review, plan
critique, deliverable review at each depth, verifier passes — records its **purpose** and **token
cost** against the run, using the P6.5.4 context manifests and the existing usage projection. A
gate may be skipped only by a recorded rule, never silently. No reviewer re-reads input that has
not changed since its last accepted review. The T8 synthetic qualification reports tokens per gate,
so P7 can tune the thresholds against real cost instead of assumption.

**Why.** "Without wasting tokens" is only enforceable if the cost of each gate is visible.

## OA-7 — Planning stays read-only

The agent-capability program grants the Architect command execution. Under a new-policy run in
**planning** state, T3 must not admit it: P6.6 forbids implementation tests and application
execution during planning. The OA-5 answer path is not planning state.

## OA-8 — Ordering

P6.6 now depends on the agent-capability program as well as P6.5. Campaign order:
**P6.5 → agent-capability program → P6.6 → P7.** OA-4's high tier and OA-5's command use depend on
that program's reader execution; OA-3's model exclusion and OA-6's accounting depend on P6.5 APIs
now merged at `6c166f97`.

## OA-9 — Runtime policy, for the owner to confirm

P6.6 is currently **PLAN BLOCKED** on its own decision D3: exact Node 24.18.0 versus a range. Since
then the owner stated "that node 22 support is stale for sure, we dropped that", and
`package.json` engines is `>=24.0.0 <25`. That evidence points to **Node 24.x, with 24.18.0 as the
verified local version**. It is recorded as the proposed resolution; it is not assumed.
