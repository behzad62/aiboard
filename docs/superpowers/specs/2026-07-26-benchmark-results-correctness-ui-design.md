# Benchmark Results Correctness and Clarity Design

## Goal

Make certified benchmark results trustworthy and immediately understandable when
solo models and multi-model teams are compared. Fix the TeamIQ all-modes timeout
that produced a misleading zero-quality track, preserve completed TeamIQ evidence
when a later composition fails, remove invalid cross-track team-lift claims, and
make charts, verdicts, failure provenance, and responsive layouts unambiguous.

## Observed failure

The saved certified run contains two healthy solo rows and one team row. The team
completed all 19 WorkBench cases at 100% verified quality, but TeamIQ hit the
shared 900-second wall-clock limit after completing earlier compositions. The
runner then synthesized five zero-quality `failed_budget` TeamIQ attempts because
the completed compositions had not been recorded incrementally. The dashboard's
equal-track index correctly averaged TeamIQ 0 and WorkBench 100 to 50, but the UI
did not expose that calculation or its budget-failure provenance.

The same dataset also produced a `+26.1` team-lift claim by comparing the team's
TeamIQ/WorkBench evidence with member solo evidence from GameIQ/Tool Reliability.
Those tracks are not comparable, so that lift is not a valid measurement.

## Chosen approach

Keep Certified Index v1.0 and its equal-track semantics. Repair the evidence
pipeline and presentation instead of changing the historical scoring formula.
This preserves comparability with existing certified results while making
failures and coverage explicit.

The rejected alternatives are:

- A presentation-only patch, because it would leave completed TeamIQ evidence
  vulnerable to later failures and retain invalid lift calculations.
- An attempt-weighted overall score, because it would silently redefine the
  existing certified index and make historical comparisons inconsistent.

## TeamIQ execution and persistence

The Tool Reliability all-modes TeamIQ suite receives a 3,600-second wall-clock
budget. The single-strategy quick suite retains its existing 900-second budget.
The 150-model-call ceiling remains unchanged because the current three-stateful-
case pack already passes the call-budget fit and the observed failure was
wall-clock exhaustion.

The TeamIQ certified runner records each completed composition's returned
attempts immediately through the certified run context. It does not wait for
every solo baseline and team strategy to finish before recording anything.
Returning the same attempts at the end must not double-persist them.

If a later composition fails or exhausts the run budget, the run engine
synthesizes failure evidence only for missing case/composition pairs. Previously
completed solo baselines and strategies remain intact, scored, and auditable.

## Certified Index and failure explanation

The overall formula remains:

1. Average verified quality within each completed or scored track.
2. Give each represented track equal weight.
3. Average those track scores into Certified Index v1.0.

The leaderboard and charts call this value `Overall index`, not `Verified
quality`. Row detail exposes the per-track values that produced the index and
shows failed-attempt counts. Budget failures are labeled with the exhausted
limit and are never presented as ordinary low-quality answers.

Historical attempts remain immutable. The existing 900-second failed run stays
visible as certified evidence; a new run under the corrected budget produces new
evidence rather than rewriting the old run.

## Comparable team lift

Team lift is calculated only on benchmark tracks for which both the team and the
relevant solo member have scored evidence. Track-local team-minus-best-member
differences are averaged with equal track weight, matching the index's coverage
discipline.

If there are no common scored tracks, team lift is unavailable and the UI shows
`Not comparable` with an explanation such as `Run the same track solo and as a
team`. It must not compare a team's WorkBench/TeamIQ score against a member's
GameIQ/Tool Reliability score.

## WorkBench verdict

The Full Certified preset remains team-only for WorkBench to avoid silently
multiplying an already long runner workload. The decision card is therefore
`Best WorkBench team` and selects only team rows with measured WorkBench
evidence. Its empty state asks for a team WorkBench pack, not a solo pack.

Advanced solo WorkBench evidence remains visible in the leaderboard and profile,
but it does not populate the team-specific verdict.

## Chart identity and accessibility

Each trade-off chart includes a visible legend mapping every plotted point to its
model or team. Colors are assigned by a stable row identity rather than current
sort/filter position, so a row keeps the same color across both charts and after
filter changes.

Tooltips and keyboard focus content include:

- Full model or team name.
- Solo or team classification.
- Overall index.
- Tokens or elapsed time per successful case.
- Measured track coverage.

Chart copy, axis labels, and accessible data use `Overall index`. Point, tick,
grid, and text colors meet the contrast needed for their rendered size. The
existing HTML accessible-data disclosure remains available and includes the same
row identity as the visual plot.

## Leaderboard, profiles, and responsive behavior

Desktop keeps the dense comparison table. Small screens render the same rows as
stacked metric cards instead of forcing a 980-pixel table into a narrow viewport.
The cards retain the profile action, evidence maturity, coverage, confidence
range, efficiency metrics, and failure indicators.

The profile exposes:

- Per-track quality, pass count, and attempt count.
- Failed and budget-failed attempt counts.
- A concise explanation of how the overall index was calculated.
- Provider, effort, and team-role metadata already present in certified
  evidence.

Long model/team names wrap without hiding identity. Controls have accessible
names, visible focus treatment, and logical keyboard order.

## Data and compatibility boundaries

- Do not delete, migrate, or mutate existing certified attempts.
- Do not change WorkBench, Tool Reliability, or GameIQ verifier semantics.
- Do not import the legacy WorkBench engine into product Build mode.
- Missing legacy metadata remains tolerated.
- Filters continue to affect presentation only.
- Team-lift unavailability is represented as missing data, never numeric zero.

## Testing and verification

Focused tests cover:

- 3,600 seconds for TeamIQ all-modes and 900 seconds for the quick suite.
- Incremental TeamIQ attempt recording and preservation across a later failure.
- No duplicate attempt persistence on successful completion.
- Team lift with common tracks, partial common coverage, and no common tracks.
- The WorkBench team verdict and its corrected empty state.
- Stable chart identity, legend/tooltip copy, overall-index terminology, and
  accessible data labels.
- Mobile leaderboard cards and failure provenance.

Regression verification includes benchmark tests, lint, TypeScript/build checks,
and live Chrome testing at desktop and mobile widths. The final browser check
must verify point-to-model identity, WorkBench verdict wording, explanation of
the historical failed TeamIQ row, responsive leaderboard usability, keyboard
focus, and absence of console errors.
