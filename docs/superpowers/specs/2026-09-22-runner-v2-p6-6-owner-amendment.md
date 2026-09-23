# Runner V2 P6.6 — Owner amendment, 2026-09-22

**Revision 2** (2026-09-22, same day). Revision 1 held OA-1..OA-9. Revision 2 applies the
owner's later decisions: OA-3's reviewer rule is loosened (distinct model preferred, fresh
context fallback); OA-9 is confirmed; OA-10 records the owner's choices on the five narrowings
the first coverage review found; OA-11..OA-17 add the owner-approved robustness suggestions,
written to work for every language the runner may build.

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

Later in the same session, recorded verbatim:

> "in the case that user had no access to many models that fit as reviewer they might use the
> same model for different tasks. we should not enfore different model in that case but instead
> use a clear context one to make sure it has not prior context" — then: "A, same rule everywhere".

> "all six, add them to P6.6. good ideas. just for 1 and 2, can runner reliably do them? given it
> is only a tool?" — then: "go with yours. … runner is a generic AI harness that can run code in
> all languages like c++ and c# too. make sure what you said work in all conditions".

> "yes, 24.x is fine."

Three design goals therefore govern every item below and are themselves obligations:
**robustness** — a defect should be caught by structure, not by hoping a model notices — and
**token economy** — no model pass without a stated purpose, and no pass over unchanged input;
and **language neutrality** — every mechanism the runner performs itself works for any language
and build system, degrades through recorded steps, and never reports "passed" where it could
not check.

**Capability ladders.** Where the runner performs a check itself (OA-11, OA-12, OA-13), it uses a
**ladder**: try the most precise method the project supports, step down when it is not
available, and **record which rung was used**. The bottom rung is always safe — the full suite,
or an explicit "not available" — never a guess. The rule is: always correct, sometimes slower.

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

**Selection prefers a distinct model and otherwise requires a fresh context** (revision 2; the
same rule the agent-capability program's D8 applies to the verifier and the plan critic):

1. Prefer a candidate whose model identity differs from the Architect's and from every model
   that authored the change. `RuntimeRouter.selectVerifier` already computes these exclusions
   from `acceptedChangeAuthorRuntimeIds` (`runtime-router.ts:189`); reuse it.
2. If no such candidate exists, use an eligible candidate that shares a model identity, in a
   **new session whose event list is empty** when it starts — no messages, tool results or
   context from any other session.
3. Record `independence: "distinct_model"` or `"fresh_context"` durably and show it.
4. Pause for a user selection only when no eligible candidate exists at all.

The agent-capability program's packet R1 delivers the router fallback; P6.6 reuses it. The
same rule applies to the coverage reviewer (OA-1) and the opt-in answer review (OA-5).

**Why.** Four P6.5 workers reported green on broken work. A reviewer that reads the report first
starts from "it works".

## OA-4 — Review depth follows deterministic change risk

P6.6 EP21 already permits additional specialist review "with a stored risk reason". This
obligation makes that reason **computed**, not asserted.

**Change risk** is deterministic — no clock, randomness, environment lookup or model call:

| Signal | Rationale |
|---|---|
| author model tier | fast, cheap workers earn more scrutiny — a lower tier **raises** risk; the tier comes from the model's recorded track record (OA-16) where one exists |
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

The high-tier command must be the **affected-test command derived mechanically** by the OA-12
ladder, and its outcome is read through OA-13. An arbitrary command must not satisfy it —
planning review showed `echo ok` would otherwise pass. At high tier the runner also runs the
OA-11 break-it probe and hands the reviewer its result.

**Thresholds are measured, not chosen.** Replayed over the fourteen P6.5 packet commits, whose
review-found defects are recorded in the P6.5 ledger — the ledger, not a new labelling, is the
source of which commits carried a defect — thresholds are accepted only if: no
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

P6.6 now depends on the agent-capability program as well as P6.5. That program (SOURCE D6 revision 4) gives the
Architect a project documentation folder, `docs/project/**`, committed by the runner outside the
task graph, with a completion check on `docs/project/STATE.md`. It adds **no** task kind. P6.6's
readiness conditions must keep that check, and its generated exports must not overwrite the
Architect's files there. Campaign order:
**P6.5 → agent-capability program → P6.6 → P7.** OA-4's high tier and OA-5's command use depend on
that program's reader execution; OA-3's model exclusion and OA-6's accounting depend on P6.5 APIs
now merged at `6c166f97`.

## OA-9 — Runtime policy: CONFIRMED

P6.6's decision D3 (exact Node 24.18.0 versus a range) is **resolved by the owner: Node 24.x**
("yes, 24.x is fine"), matching `package.json` engines `>=24.0.0 <25`. 24.18.0 is the verified
local version, not a pin. D3 no longer blocks P6.6.

## OA-10 — Owner decisions on the five narrowings

The first coverage review of this amendment found five places where the moved agent-capability
text (revision 1, D4/D5/D7) was narrowed rather than carried over. The owner decided each:

| # | Pre-split text | Decision | Obligation now |
|---|---|---|---|
| 1 | AC-11: a separate change-critique stage before the verifier | **accept the narrowing** | none — T6's one deliverable review is the change review; P6.6 forbids a second critic |
| 2 | AC-13: stage 2 blind to stage 1's findings | **restore, generalized** | every reviewer records its own findings **before** it may see any other reviewer's findings on the same artifact. For a fix re-review: record its view of the fix first, then receive the prior findings to check each is resolved |
| 3 | AC-15: a recorded skip at low risk | **accept the narrowing** | none — low tier is still the one mandatory review, reading only |
| 4 | AC-20: obligations recorded before the diff | **restore at high risk only** | at high tier, the deliverable reviewer records the obligations it derives from the source criteria **before** it receives the diff; at low and medium, OA-3's order (criteria and diff first, report later) is enough |
| 5 | AC-21: a blocking miss or weakening holds the build | **restore the hold** | a coverage verdict of `missing` or `weakened` at blocking severity holds plan readiness until resolved, exactly like an omitted obligation |

## OA-11 — Break-it probe (mutation check) at high risk

**Obligation.** At high tier, the **runner** — not a model — changes small pieces of the task's
changed lines, one at a time, runs the OA-12 affected tests against each change, and records
which changes the tests did **not** catch ("survivors"). A survivor means the tests may not
check that line. It costs no model tokens.

**Ladder (language-neutral):**

1. **The project's own mutation tool**, when the project already configures one — for example
   Stryker (JavaScript/TypeScript), Stryker.NET (C#), PIT (Java), mutmut (Python),
   cargo-mutants (Rust), Mull (C/C++). The runner runs it scoped to the changed files.
2. **The runner's built-in token-level mutator**, by syntax family: C-family (C, C++, C#, Java,
   JavaScript, TypeScript, Go, Rust, Kotlin, Swift) and Python-family. It swaps simple tokens on
   changed lines only — comparison operators, boolean literals, `+`/`-`, `&&`/`||` — using a
   lexer that skips comments and strings.
3. **"Not available"**, recorded, for any other language or when no affected-test command
   exists.

**Rules for every rung.** A change that does not build is **discarded**, not counted as caught.
Work runs in a disposable copy, never the task workspace or the project. A cap on the number of
changes and on time applies; when it stops early, the partial coverage is recorded. **Survivors
are evidence for the reviewer, not automatic blockers** — the reviewer decides whether each is a
real gap. The rung used is recorded.

## OA-12 — Affected tests: a ladder with a safe floor

**Obligation.** "The affected tests" for a change is computed by a ladder, and the rung used is
recorded:

1. **The project's own impact tool**, when configured — for example `nx affected`,
   `jest --findRelatedTests`, `bazel query rdeps`, `dotnet-affected`, pytest-testmon.
2. **Compiler or language-server references** through the runner's existing generic LSP client
   (`lsp-client.ts`, `language-provider-router.ts`): the tests that reference changed symbols.
3. **The build system's module graph — the floor that always exists when there is a build
   system:** every test in the module that contains a changed file and in the modules that
   depend on it — for example the npm workspace, the `.csproj` / solution project, the CMake
   target, the Cargo crate, the Go package, the Maven/Gradle module.
4. **The full suite.**

**Widening.** A change to build configuration, a lockfile, a shared header, generated code, or
a file type the ladder does not understand steps down to at least rung 3, and to rung 4 when
no module graph exists. The ladder never narrows below what it can justify.

## OA-13 — Test results are read, not assumed

**Obligation.** The runner reads machine-readable test reports where the tool emits them:
**JUnit XML** (Java, gtest `--gtest_output=xml`, `ctest --output-junit`, pytest `--junitxml`,
jest-junit, cargo-nextest, go-junit-report) and **TRX** (`dotnet test --logger trx`). It records
selected, passed, failed and skipped counts. **A missing or unreadable report makes the result
"unknown", never "passed".** Exit status alone is recorded as exit status, not as proof that a
test ran — this is the existing T5 rule that zero selected tests is not green.

## OA-14 — A flaky failure is isolated before it costs a repair cycle

**Obligation.** Before a failing check charges a repair cycle, the runner re-runs **only the
failing tests once**, on the same revision and environment. If they then pass, the failure is
recorded as **flaky**, no cycle is charged, and the flake stays visible as a finding. If they
fail again, the cycle is charged as usual. This never turns a failure into a pass: a flaky
required check still blocks acceptance until it passes on its own run.

## OA-15 — Defect classes the reviewers found are remembered

**Obligation.** Each defect a review finds is recorded with a short class (for example "guard
never exercised", "error swallowed", "restart path untested"), per project. Worker and reviewer
briefs include the most frequent classes for that project, capped (default: five classes,
300 tokens). The cap and the inclusion are recorded under OA-6.

## OA-16 — A model's track record feeds change risk

**Obligation.** The runner keeps, per model identity, how often review found a defect in its
accepted work. OA-4's author-tier signal reads a **snapshot** of that record taken at risk
computation, so risk stays deterministic for identical inputs. With no record yet, the default
tier is used and that is recorded.

## OA-17 — No leftovers after a task

**Obligation.** After each task attempt and each verification, the runner checks for processes
it started that are still alive and for temporary files it created outside the workspace. It
uses the runner's existing process ownership, so this is the same on every language and OS the
runner supports. A leftover is cleaned up where ownership is proven, and is recorded as a
finding either way; uncertain ownership is retained and reported, never killed on a guess.
