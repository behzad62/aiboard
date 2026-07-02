# Benchmark case-quality review — 2026-07-02

Multi-agent review of the benchmark **case content** (weak / redundant / pointless cases), complementing the implementation-bug review in `review-2026-07-01.md`. Nine suite reviewers ran to completion; each finding then went through 2–3 adversarial verifiers (verification was cut short by request, so Fireworks and cross-suite findings are **unverified** — confirm in code before acting). Full per-finding evidence, proposed improvements, and verifier corrections are in `findings-2026-07-02/*.json`.

Status legend: **C** confirmed (all verifiers agreed) · **P** plausible (majority) · **U** unverified · severity high/med/low. Findings marked *(known)* re-observe an item from the 2026-07-01 review. The `benchmark-fixes-phase-1` branch was merged into main mid-review (`1682a7b`), so some known items are already fixed on main.

Totals: 92 findings — 58 confirmed, 4 plausible, 29 unverified, 1 refuted (excluded below). The TeamIQ suite reviewer did not finish; TeamIQ case content remains unreviewed.

## GameIQ Battleship — effectively broken as a benchmark

- **C/high leak** — full `BattleshipGameState` (every opponent ship cell + shipIds) is serialized into the model prompt; the hidden-information premise is void.
- **C/high leak** — scenario titles included in the prompt name the exact target cell ("follow the carrier line at B1") for all 23 generated scenarios.
- **C/high weak** — 25 scenarios ≈ 2 decision archetypes; 24/25 use the same untouched default board; a genuinely skilled player *without* the leak would fail most of it.
- **C/high verifier** — the 7 "information-gain / repeat-avoidance" scenarios designate objectively bad or arbitrary cells (min-probability corners; empty water while the leak shows ships; nothing to "avoid repeating").
- **C/med verifier** — coordinate conventions internally inconsistent (ship titles use col-letter+row-number; expected labels use row-letter+col-number) — a consistent candidate cannot score 100.
- **C/med redundant** — 17 scenarios are "name a cell of ship X on the fixed board" re-skinned.
- **C/high gap** — none of the canonical targeting skills present (orientation disambiguation, blocked-line reversal, sunk-to-hunt, size constraints; only 1/25 has shot history).
- **C/med gameable** *(known #67)* — binary exact-match vs one memorizable default board.
- **C/low dead** *(known #35)* — latencyFactor computed/averaged but no longer weighted (dead plumbing).

## GameIQ Codenames — passable with zero skill

- **C/high weak** — all 25 scenarios give full credit for bare clue legality; a board-blind constant baseline scores 100.
- **C/med leak** — the JSON shape example `{"word":"example","count":2}` is itself a legal full-credit answer for every scenario.
- **C/med redundant** *(known)* — 24 generated scenarios are one decision re-skinned; deleting 23 changes nothing.
- **P/med verifier** — decorative never-compared expected words make identical-decision items count as distinct scoring groups and mislead the UI ("Expected result").
- **C/high gap** — zero guess-phase scenarios, zero binding legality constraints, despite types/validators already supporting guesses.
- **C/low verifier** — "conservative count" demanded by the prompt but never asserted (count 0 or 8 both pass).
- **C/low redundant** — easy/medium/hard labels fabricated from array index on identical tasks.
- **P/low dead** — per-scenario `maxResponseMs` feeds the dead latencyFactor.

## GameIQ Connect Four

- **C/high weak** — two win-in-one boards have TWO winning columns but only one is accepted (perfect play scored wrong).
- **C/high weak** — 40 scenarios ≈ 4 archetypes (column translation + color swap of the same bottom-row pattern).
- **C/high gap** — no diagonal tactics, no above-bottom-row play, no win-vs-block priority conflicts, no legality pressure.
- **C/med redundant** — 4 duplicate boards (trap-center-red ≡ open-three-trap; 3 exact color-swaps).
- **C/med leak** — prompt/titles name the tactic, orientation and row; trap-* titles nearly name the answer column.
- **C/med weak** — 31% of score unfailable (legalActionRate + structuredReliability); always-column-4 bot scores ~48/100.
- **C/med verifier** — `distinctGroupKey` includes label/note prose and omits `initialState` (duplicates count twice; different boards sharing a column collapse).
- **C/low weak** — several boards unreachable in a legal game (stone-parity impossible), e.g. win-left-edge/right-edge/wide-red.
- **C/low dead** *(known)* — latencyFactor plumbing.
- **C/low** *(known #5)* — trap-setup validator now exists on main; boards verified (fixed by phase-1 merge).

## GameIQ Chess

- **C/high leak** — the chess JSON shape example (`from e2 to d4`) IS the expected answer to the knight-wins-queen scenario.
- **C/med leak** — prompts/titles spell out the tactic and moving piece.
- **C/high gap** — 4 micro-positions (~2 real decisions post-leak), all white-to-move, ≤8 pieces, no defense, no distractors — ~2 bits of chess signal in a "first-class" pack.
- **C/med verifier** — `distinctGroupKey` omits `initialState` (latent mis-aggregation).
- **C/low verifier** — accepted promotion vocabulary never stated in the prompt (UCI-style "q" scored illegal on schema-less providers).
- **C/low verifier** — `validateChessLegalTactic` only asserts "any capture or promotion" — far weaker than the scenarios' claims.
- **C/low** *(known #12)* — 60-clone chess pack already reduced to 4 base scenarios on main (`c188f4a`).

## Tool Reliability

- **C/high leak** — certified prompt prints the exact expected tool action JSON and says "Return exactly this action object" (all 25 tool-call cases are copy tests).
- **C/high leak** — forbidden-action cases print the allowed answer; the 10 cases are byte-identical.
- **C/high redundant** — 125 cases ≈ 12 distinct decisions (~10× inflated coverage).
- **C/high verifier** — json-schema / repair-loop cases pass the schema as provider strict structured output → measures the provider, unfailable on compliant providers.
- **C/high dead** *(known)* — 70-case stress pack (only minimality-enforced, multi-hunk cases) is runtime-dead; live large-patch cases never enforce the no-whole-file-rewrite rule.
- **C/med verifier** — repair-loop never shows the model its own failed output (harness-injected constant).
- **C/med dead** — 20 tool-strategy stress cases never evaluated anywhere; read_range half unpassable as authored.
- **C/med redundant** — firstAttempt metric duplicates the category's primary metric (double-counted weight).
- **C/med verifier** — forbiddenActionRate computed over all 125 cases → unfailable constant on 115 of them, diluting the multiplier.
- **C/med gap** — every runtime patch case is a single-line substitution; multi-hunk/insertion/deletion never measured.
- **C/med weak** — "batch dedup" cases present no candidate list to deduplicate (reworded single-read cases).
- **P/low gameable** — path targeting untested (pathless output auto-attributed; schema enums the single correct path).
- **C/low redundant** — TeamIQ quick pack always samples the first case per category (1 of 3 schemas, 1 of 5 patch kinds).
- **C/low verifier** *(known #49)* — stress evaluator `rate()` returns 1.0 on empty case list (test-only path).

## WorkBench

- **C/high leak** — reference solution + verifier criteria shipped into the model's workspace (`case-meta.json` referenceFiles verbatim; `negative-control.json` names the wrong answer).
- **C/high gameable** — requiredSnippets are whole-file substring checks and the buggy line is never forbidden → paste the snippet in a comment, fix nothing, pass all 19 cases.
- **C/high weak** — requiredSnippets encode implementation details not stated in the prompt → honest perfect candidates can't reliably pass; alternatives fail.
- **C/med redundant** — 6 of 19 corpus cases byte-identical clones modulo id (~32% padding in the flagship pack).
- **C/med verifier** — "deterministic behavioral verifier" claim is false: no fixture code is ever executed; all assertions are text snapshots (Node is available — it runs verifier.mjs).
- **C/med verifier** — `changedLines` is positional, not aligned: one insertion marks every shifted line changed ("surgical diff" measures reference-layout mimicry).
- **C/med gap** — every case is a 1–3-line stated edit; cannot separate skill tiers above "search/replace in a long file"; largely re-tests what ToolReliability already scores.
- **C/med dead** — the CRLF "alternate formatting" behavioral check is vacuous (candidate byte-identical to reference).
- **C/low redundant** — 7 extra-language cases all hardcoded kind `parser-edge-case` (kind-pack groupings wrong).
- **U/low weak** — most assertion weight passes by default → no-op patch scores 0.5–0.9 partial.
- **U/low** *(known #58, #59)* — network policy unenforced; negative-control/reference files shipped but unconsumed at runtime.

## Fireworks (GameIQ port + TeamIQ packs) — ALL UNVERIFIED, confirm before acting

- **U/high leak** — category names/card-role labels leak via seed, gameId, partner card ids.
- **U/high leak** — seeded events + clueHistory strings still hand the model the memory card's exact identity (defeats the phase-1 redaction fix — re-check post-merge).
- **U/high weak** — "always play cardIndex 0" scores 100% on TeamIQ memory + GameIQ basic/memory packs (decision card always at slot 0; 60/100 scenarios expect play-0).
- **U/high redundant** — ×10-per-category generation is pure re-skinning: 100 scenarios ≈ 7 decisions, averaged without dedup.
- **U/med dead** — GameIQ basic pack's filter+slice silently drops all 10 needed_clue scenarios (clue-giving unreachable from every GameIQ pack).
- **U/med verifier** — green avoid_bad_play variants: the "correct" clue targets a dead card (partner green 1 vs stacks.green=1).
- **U/med redundant** — GameIQ port re-wraps the identical TeamIQ scenario objects (cross-track double count).
- **U/med gap** — "team" scenarios are single P1 decisions; team_lift structurally ~0 on 100/120 cases.
- **U/med verifier** — flat 0.3 legal floor credits provably harmful moves same as reasonable alternatives.
- **U/med weak** — difficulty tiers largely decorative (half the "Trap States" pack is the easy archetype).
- **U/med gap** — "memory" suites deliver all clue history in the same prompt as the decision (no recall).
- **U/low dead** — `FIREWORKS_GAMEIQ_SCENARIOS` alias export referenced nowhere.
- *(known, U)* — port drops forbiddenActions; random_legal is one deterministic trajectory; full-game fallback still shapes scores; equally-good alternatives scored as failures.

## Build cases (`lib/benchmark/build-cases.ts`)

- **C/high dead** — every saved "real-work" build case is inert: never run, verified, or scored; only inflates the dashboard "Cases" count and export bundles.
- **C/med redundant** — duplicates certified WorkBench intent in a schema the certified pipeline can't consume.
- **C/med dead** — `runWorkBenchModelPatchBuild` has no production caller and is structurally unpassable on multi-file cases.
- **C/low gap** — capture is failure-biased (cases minted only from stop reports).
- **P/low leak** — stop-report artifact embeds oracle-grade diagnosis if cases are ever replayed.

## Cross-suite (UNVERIFIED)

- **U/high dead** — "TeamIQ: ToolReliability quick (all modes)" wires the FULL 125-case pack against a 150-call budget → every run dies on CertifiedBudgetExceededError, writing zero-score attempts.
- **U/med verifier** — TeamIQ fireworks caseCount/contamination digests describe full scenario sets while the runner executes different slices.
- **U/med gap** — TeamIQ fireworks tactics runs 2/6 categories, memory 1/4; trap + memory-stress scenarios reachable only as solo GameIQ.
- **U/med redundant** — same case sources selectable under two tracks feed one merged leaderboard row (fireworks and toolreliability both double-count).
- **U/med dead** — stress pack + stress-evaluator (the only whole-file-rewrite enforcement) unreachable at runtime.
- **U/med redundant** — three near-identical large-file patch fixture families across toolreliability cases, stress cases, and workbench challenges.
- **U/med weak** — certificationTier is decorative and doesn't track rigor.
- **U/med weak** — "Fireworks: Full games" default config likely exceeds its own 500-call budget; mid-run budget throw discards completed attempts.

## Fix status (as of 2026-07-02, wave 1 complete)

- Phase-1 branch merged to main separately (`1682a7b`) — fixes several *(known)* items above.
- **Wave 1 DONE and validated** (tsc clean; guard + e2e + scoring/manifest tests green):
  - **ToolReliability** (13 findings fixed): prompts no longer print the expected action; 8 distinct forbidden-action judgment cases with hardened chained/piped detection; pack de-templated 125 → 44 distinct cases (`toolreliability-v2` scoring, pack 0.2.0); schema/repair validated post-hoc from raw text (no provider strict structured output); genuine own-output repair loop; firstAttemptValidRate unweighted (diagnostic); forbiddenActionRate over applicable cases; stress pack's minimality/whole-file-rewrite policies ported into the live evaluator and the dead stress files deleted; TeamIQ quick suite now a diverse fixed 6-case sample and the all-modes suite fits its budget.
  - **WorkBench** (11 fixed): grading spec (`case-meta.json`) hidden from model-facing runner reads (verifier keeps it out-of-band); comment-aware required snippets + per-case forbidden buggy lines (no-op and comment-only patches now fail all 20 cases); behavioral JS execution checks; 6 byte-clones replaced with distinct cases + new `workbench-pipeline-0001` multi-file diagnosis case (caseVersion 3.0.0, 19 → 20 cases — all caseHashes changed); LCS-aligned changedLines; kinds relabeled.
  - **Fireworks** (16 fixed): decision-card slot varied (slot-0 baseline no longer passes — guard-tested); needed_clue reachable in the GameIQ basic pack; identity/category leaks closed; dead-card clue oracles regenerated; packs de-templated with real decision variation; harmful moves score below the legal floor; runtime slices stratified and digests/caseCounts describe what actually runs; mid-run budget stop keeps completed attempts; packs bumped to 0.2.0.
  - **GameIQ shared layer** (9 fixed): scenario title/notes removed from model prompts; shape examples can never equal a scoreable answer (guard-tested, incl. codenames literal example word rejected); battleship state redacted via `gameIqModelStateView` (shot history only); coordinate convention + promotion vocabulary stated in prompts; `distinctGroupKey` keyed on gameId + initialState + expectedActions (no prose); latencyFactor diagnostic-only; certificationTier now honest labels enforced by `gameIqPackFirstClassFloor` (chess demoted to lightweight).
  - Coordinator follow-ups applied: `CertifiedRunPanel` wired to the quick pack for all-modes TeamIQ (the always-dies-on-budget suite now fits), v2 scoring/case versions persisted, fireworks stratified slices consumed from the shared function, teamiq barrel re-exports, scoring-rules.md + case-authoring.md updated, `GameIqScoreInput.latencyFactor` optional, build-adapter source pattern covers cs/cpp.
- **Deferred with reasons** (see fix-agent reports): multi-turn fireworks memory episodes (architecture), GameIQ port forbiddenActions carry-through (needs `GameIqScenario.version` literal-type change), TeamIQ genuine repair flow (optional), `scoring/aggregate.ts` cross-track double-count grouping, OS-level network isolation (runner v0.1 limitation).
- **Wave 2 DONE and review-gated (2026-07-02)** — all four game packs re-authored by Opus agents, then coordinator-reviewed (prompt-leak scan, test-rigor audit, semantic spot-checks) and validated (tsc, eslint, all pack/guard/manifest/corpus/e2e tests green):
  - **Battleship** 25 → 11 scenarios, v0.2.0, promoted first-class: hidden-information targeting with engine-fired shot histories (line extension, blocked reversal, orientation probing, forced orientation, sunk-to-hunt, guaranteed-gap). Test re-derives every accepted target set from an independent ship-placement enumerator and asserts the redacted view exposes no unhit ship cell; corner/first-legal baselines fail.
  - **Codenames** 25 → 10 scenarios, v0.2.0, promoted first-class: 6 deterministic guess decisions (association, elimination, count-driven, two-forced-alternatives) with hidden roles redacted from the model view, and 4 binding clue decisions (on-board clue word illegal, count pinned to family size, assassin-adjacent trap, tight count) scored against small allowlists — a legal board-blind clue scores zero. Reviewer fixes: replaced fillers ZEBRA/YOGURT (they were hidden competing answers for the ANIMAL/COLD scenarios) and tightened the avoid-assassin allowlist (dropped WOODWIND/ORCHESTRA/SYMPHONY, which contradicted the scenario's own trap logic).
  - **Connect Four** 40 scenarios, v0.2.0, first-class kept honestly: duplicates and color-swaps deleted (engine-asserted), dual-win boards accept both columns (expected == all engine-winning columns), boards satisfy reachability parity, new diagonal / above-bottom-row / win-over-block / full-column archetypes; trap boards found by self-play search and re-verified independently.
  - **Chess** 4 → 15 scenarios, v0.3.0, promoted first-class: 9 mate-in-1 (incl. black-to-move and two-mate positions with engine-asserted mate-set equality), 3 winning captures with engine-proven losing distractors, 1 unique mate-defense (all other legal moves lose to mate next ply), 2 promotion best-moves. validateChessLegalTactic is now unused by any pack (candidate for removal).
- **Wave 3 DONE and review-gated (2026-07-02)** — the small/medium follow-ups, four Opus agents + coordinator review; full battery (20 suites), tsc and eslint green:
  - `validateChessLegalTactic` removed (unused since wave 2); chess promotion synonyms ("q"/"Q"/"N", any case) normalized candidate-side at the single `isStructuredGameIqAction` boundary — canonical expectations unchanged, unknown strings still fail legality (`scripts/test-gameiq-action-normalization.mts`).
  - latencyFactor dead plumbing fully removed (runner computation, `GameIqScenarioResult`/`GameIqRunMetrics` fields, `GameIqScoreInput`); scenario `maxResponseMs` retained as timeout metadata only.
  - Fireworks GameIQ port now carries `forbiddenActions` (prior-review #34 closed): a forbidden match scores 0 with a distinct `forbiddenBlunder` flag in results/assertions, so trap failures are visible as trap failures; `GameIqScenario.version` widened from the `'0.1.0'` literal; fireworks packs bumped to 0.3.0.
  - TeamIQ toolreliability repair is now a genuine two-call flow (real team attempt 0 → post-hoc validation → repair call carrying the team's own output + feedback); the seeded constant is no longer used by the TeamIQ path and `firstAttemptSource` labels stay accurate.
  - Cross-track de-dup: `dedupeCrossTrackAttempts` in `scoring/aggregate.ts`, keyed on explicit `source:<teamiq-scenario-id>` case tags or shared case ids (never fuzzy), wired into the merged leaderboard (`aggregate.ts`) and merged summary (`metrics.ts`); per-track views untouched.
  - Reviewer fixes on top: `scripts/test-gameiq-scoring.mts`'s codenames check updated to the wave-2 skill-binding semantics (a legal board-blind clue must be legal yet score zero — the old check asserted the retired legality-only behavior and its fixture word had become a board word); stale chess.ts comment.
- **Known real-data limits of the cross-track de-dup** (documented, not bugs in the mechanism): GameIQ attempts are pack-level, so a fireworks GameIQ pack attempt cannot be de-duplicated per-scenario against TeamIQ attempts (needs per-scenario attempt records or fully disjoint runtime slices — TeamIQ tactics slices are already disjoint from the basic pack, hard/memory overlap remains); solo vs TeamIQ toolreliability attempts carry different suite-level caseIds, so they only de-dup if future runners emit per-case attempts. The mechanism is in place and test-verified for both keying modes.
- Still open (bigger/decision-gated): build-cases dead-feature decision (wire it into a runner or remove the misleading dashboard count); multi-turn fireworks memory episodes (architectural — memory suites still deliver clue history in the same prompt).
