# Recoverable Job Service — standalone coding benchmark design

Date: 2026-09-08. Release status updated 2026-09-22: the modeled profile is
implemented, qualified, and integrated into AI Board WorkBench. The owner selected
**implement the missing core from a specification**, in a problem independent of
the existing application.

## Objective and independence

Measure whether an AI coding model can implement a small but demanding service
whose correctness survives concurrency, interrupted writes, process termination,
owner takeover, asynchronous callbacks and restart. The problem is a generic
recoverable job service, not an application feature, an app checkout repair, or a
rewrite of existing project code.

The service runs jobs, retains stdout/stderr, allows a consumer to acknowledge
output, preserves evidence, stops work and recovers incomplete cleanup. Correctness
requires both safe refusal under uncertainty and eventual progress when sufficient
evidence exists. This provides the same kinds of reasoning challenges as the C1–C5
experience while using a new domain contract, fresh names, original code and fresh
test fixtures.

The historical work is a private source of failure patterns. No production module,
database schema, public API, internal class name, retained process directory,
credential, repair patch or old test is copied into the candidate's project.
Maintainer provenance can reference the source experience; the runnable benchmark
must have zero runtime/build dependency on that repository.

## Artifacts in this design

- [Candidate problem and contract](../../benchmarks/recoverable-job-service/problem.md).
- [Public acceptance families and fairness rules](../../benchmarks/recoverable-job-service/acceptance-contract.md).
- [Private evaluation catalogue](../../benchmarks/recoverable-job-service/evaluation-cases.md).
- `docs/benchmarks/recoverable-job-service/source-map.json`: private source-document
  identities and mappings used to audit historical coverage. It is not distributed
  to candidates and is not proof that tests have been implemented.

The benchmark remains a standalone candidate problem even though AI Board now
provides its launch, runner, scoring, and durable-results UI. Its dedicated runner
package pins its own runtime and dependencies; the candidate contract has no API or
runtime dependency on AI Board application code.

## Scope and starter kit

Use a standalone TypeScript/Node project for version 1. Pin the benchmark runtime
and dependencies in its own manifest; do not inherit a product's version policy.
There is no UI, networking service, account integration, model API or scheduler for
unrelated application work.

The starter kit provides compiling interfaces, an empty core implementation,
serialization/cryptographic primitives, a transactional storage primitive, clocks,
bounded file I/O and process-control primitives. It supplies small sample workloads
and public contract tests. These are infrastructure, not a completed lifecycle:
the model must implement the durable state machine, transaction boundaries,
supervision decisions, replay/evidence rules and cleanup coordination.

Provided adapters must not solve a behavior and then award the candidate points
for it. For example, a primitive may check a token's signature, but the candidate
must select and revalidate the correct current token at the required boundary. A
primitive may execute an authenticated control request, but the candidate must
choose the workload rather than the supervisor and order the operation correctly.
The private catalogue distinguishes candidate responsibilities from trusted
infrastructure qualification.

The delivered APIs and type definitions must fully instantiate the candidate
contract before release. This design defines their behavior; it is not a claim
that those interfaces, primitives or tests already exist.

## Organization of the challenge

Use five requirement groups:

| Group | Candidate responsibility |
| --- | --- |
| A — Ownership and streaming | Current authority, coherent output/ACK operations, listener lifetime and nonblocking observation. |
| B — Cleanup and recovery | Durable partial progress, single deadline, retained late work and truthful service close. |
| C — Evidence | Actual-byte integrity, bounded durable continuation, replay rules and atomic terminal transfer. |
| D — Process lifecycle | Separate workload/witness control, causal retirement and complete output drain. |
| E — Composition | Cross-job isolation, initialization failure, crash recovery and public lifecycle outcomes. |

The main task asks for the full core from the same empty skeleton. Every model
receives the same public requirements and applicable platforms. Group results
explain failures, while the primary outcome requires the complete service to work.

A later development suite may ask for one missing module with the other modules
implemented by benchmark-owned reference components. Such module tasks are reported
separately and are not treated as independent samples of the integrated task. A
repair track is out of scope for the selected version.

## Public contract, private scenarios

All normative behavior is visible in the problem statement. The evaluator keeps
exact scenarios, schedules, data, test code and reference implementations private.
Hidden tests can choose a crash boundary or reorder events within the public
contract; they cannot introduce a new requirement after submission.

Every proposed scored family and its expected behavior is also published in the
acceptance contract. Hidden material is limited to concrete inputs, fault timing,
permitted schedules and oracle implementation. The release cannot rely on a model
inferring requirements from our app history, reference design or private reviews.

**No deduction without an explicit public contract.** A case must pass a substantive
instruction-sufficiency review, not just link to a vaguely related clause. This
applies to safety gates as well as partial credit. Required interfaces, schemas,
fault semantics, capacities, timing, dependency order, adapter responsibilities,
profiles and accepted outcome alternatives must be supplied before the attempt.
Unspecified or reasonably ambiguous expectations are unscored until clarified in
a future frozen release. If discovered during a campaign, quarantine the affected
measurement consistently for every submission; never retroactively apply a newly
written requirement to earlier candidates.

The public problem, acceptance contract, types, adapters, examples and release
manifest must agree. A contradiction is a benchmark defect and blocks admission;
there is no private 'reference implementation wins' precedence rule. A blind
contract reviewer must be able to derive the expected outcome from the candidate
package alone, without seeing reference code, hidden tests or source-app history.
Each public family needs at least one readable input/event/outcome example, and
each distinct permitted blocker needs a paired progress example where feasible.

Behavior is evaluated through public service operations plus trusted driver/storage
observations. The model's own logs, tests, summary and `complete: true` fields are
not the oracle. The evaluator verifies actual effects, bytes, persistent transitions
and resource ownership. Alternative valid internal designs pass; source-code
similarity and matching the reference schema are not criteria.

Public interfaces include inspection of durable status and categorical blockers,
but a candidate inspection response alone cannot certify correctness. Trusted
adapters record actual control operations, output acceptance/ACK, committed storage
effects and exact resource lifetime outside candidate-writable storage.

## What counts as complete

For each job, terminal release requires all applicable facts: workload quiescent;
retained output settled; evidence finalized or validly marked diagnostically lossy;
channel detached; process authority released; isolation released. Batch close must
also account for jobs that failed before a running session was established, not
only jobs returned by a bounded recovery pass.

The evaluator uses positive/negative pairs. Intact authority and reconstructible
output must allow recovery; stale identity or missing earlier evidence must block.
A retry can reuse an authenticated completed fact without repeating its effect.
It cannot turn an unknown issued effect into a fresh attempt merely because the
old caller timed out. 'Always block' fails the positive cases. 'Always succeed'
fails safety gates even when the ordinary demonstration looks correct.

## Converting the source experience into independent cases

Each historical finding gets a private traceability record:

| Field | Meaning |
| --- | --- |
| Stable ID and source | Exact review/report section and hash; original finding and final disposition. |
| Classification | Candidate behavioral defect, evaluator defect, clarified requirement, unresolved observation, rejected finding or duplicate. |
| Generalized scenario | Original names/code removed; legal starting state, event schedule and fault boundary. |
| Public requirement | The candidate-visible clause that authorizes the expectation. |
| Observable outcome | Required durable facts, effects, bytes, resource disposition and blocker. |
| Controls | Successful progress and closest unsafe/uncertain counterpart. |
| Executable proof | Test identity, environment, known-good pass and intentional faulty-core failure at the intended assertion. |
| Admission | Proposed, admitted or quarantined, with reason. |

The private catalogue is an initial family inventory, not a claim of an implemented
or exhaustive test suite. Before claiming 'all encountered edge cases,' reconcile
every source review finding and later discovery to an executable case or an explicit
non-scoring disposition. There must be zero unclassified findings. Duplicate tests
map to the same family and do not inflate its score.

Do not import an unsettled historical assumption as a correct answer. A newly
defined standalone requirement can be clearer than the old project requirement,
but it must be independently implemented, reviewed and demonstrated before scoring.
Unknown old failure causes remain unknown; their observable safety boundaries can
still motivate independently proven scenarios.

## Harness design and isolation

The candidate works in a fresh repository containing only the starter kit and public
contract. Private tests, this source map, reference code, answer-bearing history,
hidden seeds and evaluator credentials are inaccessible to its agent. No source
project Git objects, worktree pointers or caches enter the export.

Freeze the submitted source and evaluate it in a fresh isolated environment with
evaluator-owned tests and invocation. Candidate edits cannot replace hidden test
code, dependencies, case selection or grading. Evaluation processes and trusted
observations run outside the candidate's writable authority. A native job runs only
inside an evaluation-owned environment with fresh identities and exact resource
accounting. Never use historical live process state as input.

Use two explicit execution profiles:

1. **Deterministic core.** A documented process/storage model provides real durable
   transactions and controlled events, virtual deadlines, crash points and late
   completions. This is the repeatable primary correctness profile, identified as
   modeled process behavior rather than native operating-system proof.
2. **Native integration.** The same public core runs against fixed native primitives
   and actual small workloads. Windows and Linux results are reported separately;
   a combined portable result requires both. Other platforms are not claimed.

Native and deterministic cases use separate entry points and an exact expected
selection manifest. A regular-expression filter alone is insufficient isolation.
Native primitives are qualified with a reference control before candidate grading.
Container-runtime variants are an optional separately declared profile, never an
undeclared prerequisite for the primary core task.

## Test construction

Prefer controlled event schedules over timing luck. Cover crash/takeover before,
at and after durable intent, file publication, state CAS, consumption, ACK and
release. Test deadlines before issuance, during an issued effect and after an
await. Compose buffered output with stop, stopped consumers with private drain,
reentrant listener mutation with terminal delivery, and concurrent isolated jobs.

Every scoring family must pass on a fully reviewed reference core and reject at
least one plausible faulty implementation for the intended observable behavior.
For example, remove the all-owned-job scan and show that the 1,025th unfinished job
in a profile whose published capacity permits it makes close falsely succeed;
restore it and show the exact test passes. Neither a 1,024-row batch size nor a
particular scan algorithm is required. Failure to
compile, absent imports, broken fixtures and setup timeouts do not qualify as such
proof. A second different correct strategy or a simplification audit should check
that hidden tests are not accidentally coupled to reference implementation choices.

The initial reference must be written for this independent specification. Historical
green source counts do not qualify it. Reference and faulty controls are calibration
artifacts, not participant models or leaderboard entries.

The evaluator must retain complete primary and cleanup errors, exact selected cases,
subprocess terminal exits and fixture ownership dispositions. A passing case body
with a failing finalizer is a failed case. Loss of evaluator provenance invalidates
the affected measurement; it is not a model defect inferred from silence.

## Scoring

Each attempt reports three separate fields:

- **Measurement:** valid or infrastructure-invalid.
- **Safety:** pass or fail, with invariant IDs.
- **Outcome:** resolved, incomplete or failed.

For a valid measurement, a family passes only when every required variant passes.
Let `p_g` be passing families divided by applicable families in group `g`. Diagnostic
coverage is `100 × mean(p_A, p_B, p_C, p_D, p_E)`. Each group has equal weight, so a
group with many tiny tests cannot dominate. Profile applicability and denominators
are frozen before any submissions; no case is removed after a model fails it.

**Resolved means all mandatory families and preserved public regressions pass, with
no safety violation.** A 98% coverage result with output loss or false release is an
unsafe failure, not a nearly correct solution. Primary comparison is the fraction
of resolved attempts, accompanied by unsafe-attempt rate and group coverage.
Evaluator-only H cases do not earn candidate points.

Infrastructure-invalid covers trusted environment/selection failures, unavailable
declared capabilities or missing required evaluator evidence. A valid test where
candidate code hangs, corrupts its records, omits output or leaks owned resources
is a candidate failure. An unsupported or skipped mandatory native profile gets
no combined portable score. Never count missing cases as passes.
Candidate-caused test tampering or interference with the evaluator is an execution
contract failure, not a way to obtain an infrastructure-invalid exclusion. Preserve
the trusted evidence identifying the cause; ambiguous infrastructure failures must
be triaged consistently without crediting an unobserved pass.

Wall time, cost, tokens, tool calls and revisions are separate efficiency measures.
Compare efficiency among resolved attempts; a quick unsafe implementation must not
rank above a correct one. Prose quality, confidence and an LLM review verdict do
not earn correctness points. A deterministic record of the candidate's final claims
may be reported as an honesty diagnostic, separate from functional scoring.

## Comparable model runs

Use the same agent harness, tools, permissions, context policy, task materials,
network access and assistance rules for every model. The primary track is one agent
with self-directed editing and public test access, no external reviewer feedback
and no access to hidden test outcomes during the attempt. Record exact model version,
reasoning/sampling settings and harness version.

Pilot on development scenarios to choose common wall-time and cost ceilings, then
freeze numeric budgets in the release manifest before ranked runs. At budget expiry,
freeze and grade the current source without a grace repair. Record raw/cached/output
tokens and the pricing schedule rather than treating token count as universal cost.

An initial comparative study should use at least three fresh attempts per model,
common seed schedules and all attempts included. Report sample size and uncertainty;
increase repetition when ranking remains unstable. Do not select the best attempt
and describe it as pass@1. Related scenarios are correlated; statistical uncertainty
must not treat hundreds of assertions as hundreds of independent coding problems.

A later review-assisted experiment must keep reviewer, prompt and feedback-round
allowance identical and report agent-system results separately. New findings during
a campaign enter the next version; they do not silently change current scores.
A confirmed evaluator defect requires a disclosed withdrawal/re-evaluation decision
applied consistently to every affected submission.

## Release gates and next implementation work

This design is ready to turn into a standalone implementation plan. No model can
be scored yet. Release requires, in order: finalize interfaces and public examples;
build independent primitives and empty starter; implement and review a reference
core; reconcile the historical catalogue; implement hidden cases and faulty controls;
qualify deterministic and native environments; audit answer isolation; pilot budgets;
freeze the version and scoring manifest; then run models under an authorized budget.

The integrated benchmark may be released once its own reference and evaluator are
qualified. It does not depend on completion of the app's remaining phase gates.
The similarity is in failure modes, not shared code or a shared release dependency.

## Methodological references

Long tasks alongside diagnostic components are discussed in
[Terminal-Bench's challenge design](https://www.tbench.ai/news/terminal-bench-challenges).
Answer leakage and test gaming motivate the separation described in
[NIST's agent-evaluation examples](https://www.nist.gov/caisi/cheating-ai-agent-evaluations/2-examples-cheating-caisis-agent-evaluations).
The evaluator itself must be qualified because flawed coding tasks can distort
measurements, as discussed in
[OpenAI's evaluation audit](https://openai.com/index/separating-signal-from-noise-coding-evaluations/).
