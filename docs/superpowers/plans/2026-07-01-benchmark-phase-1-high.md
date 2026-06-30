# Benchmark Fixes — Phase 1 (High severity) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore scoring honesty and export privacy in the `/benchmark` feature by fixing the 9 high-severity findings — broken/gameable scoring across Codenames, Fireworks, GameIQ trap cases, WorkBench, the `invalid_case` exclusion, and the artifact-only redaction gap.

**Architecture:** Fully client-side Next.js 15 app (App Router, React 19, TS strict, static export — no backend). The benchmark engine, scoring, and store all run in the browser; data lives in `lib/benchmark/**`, UI in `components/benchmark/**`. Fixes are surgical changes to scoring/aggregation/redaction logic plus the user-run local runner (`scripts/bench-runner.mjs`).

**Tech Stack:** TypeScript, React 19, Next 15. **No test runner** — tests are plain `tsx` scripts under `scripts/test-*.mts` that import the module, assert via a local `check(name, ok, detail?)` helper printing `PASS`/`FAIL`, end with `console.log(failures === 0 ? "PASS" : "FAIL …")` + `process.exit(failures === 0 ? 0 : 1)`, and run via `npx tsx scripts/test-<name>.mts`. Lint via `npm run lint`. Test scripts use **relative** imports (`../lib/...`), app code uses `@/*`.

**Branch:** `benchmark-fixes-phase-1`. Commit after each task.

---

## File structure (what each task touches)

| Task | Primary files | Test |
| --- | --- | --- |
| 1. `invalid_case` exclusion | `lib/benchmark/metrics.ts` (`isScoredCertifiedAttempt`) | `scripts/test-benchmark-scoring.mts` |
| 2. Redaction covers all channels | `lib/benchmark/redaction.ts` | `scripts/test-benchmark-redaction.mts` |
| 3. Codenames win attribution + de-dup | `lib/benchmark/metrics.ts` (`addGameMatch`) | `scripts/test-game-benchmark-registry.mts` |
| 4. Fireworks fallback not scored | `lib/benchmark/fireworks/certified-runner.ts` | `scripts/test-certified-fireworks-runner.mts` |
| 5. Fireworks view answer-leak | `lib/games/fireworks/hidden-view.ts`, `lib/benchmark/gameiq/fireworks.ts`, fireworks certified-runner, snapshot JSON | `scripts/test-fireworks-scenarios.mts` |
| 6. GameIQ trap-setup validator + boards | `lib/benchmark/gameiq/validation.ts`, `lib/benchmark/gameiq/connect-four.ts` | `scripts/test-gameiq-scenarios.mts` |
| 7. WorkBench gameable verifier | `scripts/bench-runner.mjs`, `lib/benchmark/workbench/executor.ts` | `scripts/test-bench-runner-guards.mts` (new) |
| 8. WorkBench cost factor | `lib/benchmark/workbench/build-adapter.ts`, `lib/benchmark/scoring/workbench.ts`, `lib/client/build-engine.ts` | `scripts/test-build-benchmark-hooks.mts` |

> **Sequencing note:** Tasks 1 and 3 both edit `lib/benchmark/metrics.ts` but different functions (`isScoredCertifiedAttempt` vs `addGameMatch`) — do 1 then 3. Tasks 4 and 5 both touch `lib/benchmark/fireworks/certified-runner.ts` — do 4 then 5.

---

## Task 1: Exclude `invalid_case` from certified scoring

**Files:**
- Modify: `lib/benchmark/metrics.ts` (`isScoredCertifiedAttempt`, ~line 673-686; summary buckets ~486-497)
- Modify (import): `lib/benchmark/failures.ts` exports `INVALID_STATUSES` / `isInvalidCertifiedRun`
- Test: `scripts/test-benchmark-scoring.mts` (extend the existing exclusion assertions ~line 192-239)

**Problem:** `isScoredCertifiedAttempt` switches only four invalid statuses to `false` and `default: return true`, so `invalid_case` (broken fixture/verifier — explicitly not the model's fault) is scored against the model. Every other module treats it as excluded.

**Change:** Derive the scored decision from the single source of truth in `failures.ts` instead of the duplicated switch.

- [ ] **Step 1 — Write the failing test.** In `scripts/test-benchmark-scoring.mts`, add an assertion that an `invalid_case` attempt is NOT scored, mirroring the existing four:
```ts
check(
  "invalid_case excluded from scoring",
  isScoredCertifiedAttempt({ ...baseAttempt, status: "invalid_case" }) === false,
  "invalid_case must be excluded like the other invalid statuses"
);
```
(Use the same `baseAttempt`/attempt factory the existing exclusion checks use.)

- [ ] **Step 2 — Run, expect FAIL.** `npx tsx scripts/test-benchmark-scoring.mts` → the new check prints `FAIL` (function currently returns `true`).

- [ ] **Step 3 — Make the change.** In `lib/benchmark/metrics.ts`, replace the body of `isScoredCertifiedAttempt` so the invalid set comes from `failures.ts`:
```ts
import { isInvalidCertifiedRun } from "@/lib/benchmark/failures";
// …
function isScoredCertifiedAttempt(attempt: BenchmarkAttemptV2): boolean {
  if (attempt.mode !== "certified") return false;
  return !isInvalidCertifiedRun(attempt.status);
}
```
Confirm `isInvalidCertifiedRun` is exported from `failures.ts` (it is, derived from `INVALID_STATUSES` which includes `invalid_case`). Keep any existing `mode`/non-certified guard semantics identical.

- [ ] **Step 4 — Add the excluded-case bucket.** In the dashboard summary (`metrics.ts:486-497`), add `excludedCaseAttempts: excludedAttempts.filter(a => a.status === "invalid_case").length` alongside the provider/harness/environment/user buckets, and surface it in the corresponding `CertifiedBenchmarkDashboardData.summary` type in `lib/benchmark/scoring/types.ts` (`excludedCaseAttempts: number`). Render is optional this phase; the field keeps parity.

- [ ] **Step 5 — Run, expect PASS.** `npx tsx scripts/test-benchmark-scoring.mts` → all PASS. Also run `npx tsx scripts/test-benchmark-lab.mts` to confirm dashboard build still passes.

- [ ] **Step 6 — Lint.** `npm run lint`

- [ ] **Step 7 — Commit.**
```bash
git add lib/benchmark/metrics.ts lib/benchmark/scoring/types.ts scripts/test-benchmark-scoring.mts
git commit -m "fix(benchmark): exclude invalid_case attempts from certified scoring"
```

---

## Task 2: Redact every export channel, not just artifacts

**Files:**
- Modify: `lib/benchmark/redaction.ts` (`redactBenchmarkBundle`, ~161-198; `BenchmarkRedactionSummary`)
- Test: `scripts/test-benchmark-redaction.mts` (extend)

**Problem:** `redactBenchmarkBundle` only scrubs `artifacts[].content`. `traces`, `toolCallTraces`, `runEvents`, `verifierResults`, and `failures` carry free-text (model raw responses, shell commands incl. the runner token, verifier stderr with absolute home paths) and export unredacted, while the summary reassures "scanned N artifacts."

**Change:** Run the existing `redactKnownSecretsWithCount` + `redactAbsoluteLocalPathsWithCount` (and `scanArtifactForSecrets` for blocked warnings) over every free-text field on every channel; report total channels scanned.

- [ ] **Step 1 — Write the failing test.** In `scripts/test-benchmark-redaction.mts`, seed a runner token / absolute path / api key into a `toolCallTrace`, a `verifierResult`, a `trace.rawResponse`, a `runEvent`, and a `failure`, then assert the redacted bundle contains none of the raw secrets:
```ts
const leaky: BenchmarkReportBundleV2 = {
  ...bundle, // reuse the existing artifact bundle
  toolCallTraces: [{ id: "tc1", attemptId: "a1", command: "curl -H 'x-runner-token: aiboard-runner-token-1234567890abcdef'", outputPreview: "C:\\Users\\b_a_s\\secret.txt", inputJson: "", status: "ok", createdAt: "2026-06-27T10:00:00.000Z" } as any],
  traces: [{ id: "tr1", attemptId: "a1", rawResponse: "key sk-proj-abcdefghijklmnopqrstuvwxyz1234567890", createdAt: "2026-06-27T10:00:00.000Z" } as any],
  verifierResults: [{ id: "vr1", attemptId: "a1", passed: true, stderrPreview: "/Users/alice/proj failed", createdAt: "2026-06-27T10:00:00.000Z" } as any],
  runEvents: [{ id: "re1", attemptId: "a1", message: "token=aiboard-runner-token-deadbeefcafe1234", createdAt: "2026-06-27T10:00:00.000Z" } as any],
  failures: [{ id: "f1", attemptId: "a1", message: "C:\\Users\\b_a_s\\app", details: "sk-ant-abcdefghijklmnopqrstuvwxyz12345", createdAt: "2026-06-27T10:00:00.000Z" } as any],
};
const r = redactBenchmarkBundle(leaky);
const blob = JSON.stringify(r);
check("traces redacted", !blob.includes("sk-proj-") , blob.slice(0,200));
check("tool-call command + path redacted", !blob.includes("aiboard-runner-token-1234567890abcdef") && !blob.includes("b_a_s\\\\secret"), "");
check("verifier stderr path redacted", !blob.includes("alice"), "");
check("run event token redacted", !blob.includes("aiboard-runner-token-deadbeefcafe1234"), "");
check("failure details key redacted", !blob.includes("sk-ant-abcdefghijklmnopqrstuvwxyz12345"), "");
```
(Match the real field names in `lib/benchmark/types.ts` for each record type before finalizing — `BenchmarkModelCallTrace`, `BenchmarkToolCallTrace`, `BenchmarkRunEvent`, `BenchmarkVerifierResult`, `BenchmarkFailure`.)

- [ ] **Step 2 — Run, expect FAIL.** `npx tsx scripts/test-benchmark-redaction.mts` → new checks FAIL.

- [ ] **Step 3 — Make the change.** In `redaction.ts`, add a helper that redacts a string field and accumulates count:
```ts
function redactText(value: unknown, counters: { secrets: number }, warnings: string[], labelFor: (kind: string) => string): unknown {
  if (typeof value !== "string" || value.length === 0) return value;
  const scan = scanArtifactForSecrets(value);
  for (const f of scan.findings) if (f.blocked) warnings.push(labelFor(f.kind));
  const sec = redactKnownSecretsWithCount(value);
  counters.secrets += sec.count;
  return redactAbsoluteLocalPathsWithCount(sec.content).content;
}
```
Then in `redactBenchmarkBundle`, after the existing `artifacts` map, build redacted copies of `traces`, `toolCallTraces`, `runEvents`, `verifierResults`, and `failures` by mapping their free-text fields through `redactText` (e.g. trace `rawResponse`/`parsedResponseJson`/`error`/`fallbackReason` + each `retryHistory[].rawResponse/message/parsedJson`; tool-call `command`/`inputJson`/`outputPreview`/`error`; runEvent `message`/`detailsJson`; verifier `command`/`stdoutPreview`/`stderrPreview`/`resultJson`; failure `message`/`details`). Return these redacted arrays explicitly instead of relying on `...bundle`. Extend `BenchmarkRedactionSummary` with `scannedRecords: number` (artifacts + all redacted records) and keep `scannedArtifacts` for back-compat.

- [ ] **Step 4 — Run, expect PASS.** `npx tsx scripts/test-benchmark-redaction.mts` → all PASS (including the original artifact checks).

- [ ] **Step 5 — Update the user-facing count.** In `components/benchmark/useBenchmarkReportActions.ts:69-71`, change the toast to report `scannedRecords` (e.g. "Redaction scanned N record(s)") so it no longer implies artifact-only coverage. Mirror in `reports.ts` "Redaction scanned artifacts" line (`appendRawV2Counts`).

- [ ] **Step 6 — Lint.** `npm run lint`

- [ ] **Step 7 — Commit.**
```bash
git add lib/benchmark/redaction.ts lib/benchmark/types.ts components/benchmark/useBenchmarkReportActions.ts lib/benchmark/reports.ts scripts/test-benchmark-redaction.mts
git commit -m "fix(benchmark): redact secrets/paths across all export channels, not just artifacts"
```

---

## Task 3: Fix Codenames win attribution and per-model double-counting

**Files:**
- Modify: `lib/benchmark/metrics.ts` (`addGameMatch`, ~857-927)
- Test: `scripts/test-game-benchmark-registry.mts` (extend; if absent, create following the `check` harness)

**Problem:** Codenames persists winner as the team token (`"red"`/`"blue"`) while participant ids are role-suffixed (`"red-spymaster"`), so `winnerId === participant.id` is never true → every codenames model recorded as a loss. Both red seats share one `modelId`, so per-model tallies double-count per match.

**Change:** (a) Resolve a team winner to participants via prefix/team match; (b) de-dupe accumulation by distinct `modelId` per match.

- [ ] **Step 1 — Write the failing test.** Construct a codenames `GenericGameMatchRecord` (winner `"red"`, participants `red-spymaster`/`red-operative` both `modelId: "m-red"`, `blue-*` both `modelId: "m-blue"`), feed it through `buildBenchmarkDashboardData`, and assert: `m-red` has `wins === 1`, `losses === 0`, `games === 1` (not 2); `m-blue` has `wins === 0`, `losses === 1`, `games === 1`.

- [ ] **Step 2 — Run, expect FAIL.**

- [ ] **Step 3 — Make the change in `addGameMatch`.** Add a winner-resolution helper and collapse by modelId:
```ts
function participantIsWinner(p: { id: string }, winnerId: string | null): boolean {
  if (!winnerId) return false;
  return p.id === winnerId || p.id.startsWith(`${winnerId}-`); // team token e.g. "red" matches "red-spymaster"
}
```
In the per-participant loop, iterate over **distinct modelIds** (a `Set` already counted this match) so `games`/`completions`/`legalActions`/`schemaValid` increment once per model per match; credit a win to a model if **any** of its seats `participantIsWinner`. Keep chess/connect-four/battleship behavior identical (their `id === winnerId` still holds).

- [ ] **Step 4 — Run, expect PASS.** Also re-run `npx tsx scripts/test-benchmark-lab.mts`.

- [ ] **Step 5 — Lint.** `npm run lint`

- [ ] **Step 6 — Commit.**
```bash
git add lib/benchmark/metrics.ts scripts/test-game-benchmark-registry.mts
git commit -m "fix(benchmark): credit codenames team wins and stop double-counting per-model games"
```

---

## Task 4: Stop scoring the Fireworks deterministic fallback as the model's answer

**Files:**
- Modify: `lib/benchmark/fireworks/certified-runner.ts` (`runScenarioCase`, ~320-335)
- Test: `scripts/test-certified-fireworks-runner.mts` (extend)

**Problem:** On parse/illegal failure, `callFireworksAction` returns a near-optimal deterministic fallback with `fallbackUsed=true`; `runScenarioCase` scores that fallback and can pass the `score >= 0.7` assertion, inflating quality even though the model emitted garbage.

**Change:** Zero the scenario score when `fallbackUsed`.

- [ ] **Step 1 — Write the failing test.** Drive a scenario with a mock model that returns invalid JSON (forcing `fallbackUsed`), and assert the scenario's contributed score is `0` and its assertion `passed === false` (today it's ~1/true).

- [ ] **Step 2 — Run, expect FAIL.**

- [ ] **Step 3 — Make the change.** In `runScenarioCase`:
```ts
const score = call.call.fallbackUsed
  ? 0
  : scoreFireworksScenarioAction(params.benchmarkCase, call.action);
```
(Place before the assertion is built so `passed: score >= 0.7` correctly fails.) Leave the recorded `failed_tool_use` status + `BenchmarkFailure` push intact. The deterministic fallback still advances full-game simulation — only scenario scoring is zeroed.

- [ ] **Step 4 — Run, expect PASS.** Re-run the full file; confirm legitimate (non-fallback) scenarios still score as before.

- [ ] **Step 5 — Lint.** `npm run lint`

- [ ] **Step 6 — Commit.**
```bash
git add lib/benchmark/fireworks/certified-runner.ts scripts/test-certified-fireworks-runner.mts
git commit -m "fix(benchmark): zero Fireworks scenario score when deterministic fallback is used"
```

---

## Task 5: Remove answer leakage from the Fireworks model-facing view (recommendations + memory identity)

**Files:**
- Modify: `lib/games/fireworks/hidden-view.ts` (`getFireworksPlayerView`, ~32-137)
- Modify: `lib/benchmark/gameiq/fireworks.ts` (~26-44, where `initialState` is built)
- Modify: `lib/benchmark/fireworks/certified-runner.ts` (prompt path / memory-scenario mapper) and the GameIQ prompt path
- Regenerate: `benchmarks/gameiq/v1/fireworks.json` (committed snapshot currently contains leaked `recommendations`/identity)
- Test: `scripts/test-fireworks-scenarios.mts` (extend)

**Problem:** Two leaks make Fireworks measure transcription, not reasoning: (a) the model-facing view embeds `recommendations` (precomputed optimal moves), and (b) memory scenarios put resolved `knowledge.color`/`rank` directly in the visible own-hand, so `clueHistory` is decorative and `recommendations.knownPlayableCards` hands over the answer index.

**Change:** Add an opt-in redaction mode to the view builder, used only on the certified/GameIQ prompt path; keep `recommendations` for the live game UI (which still consumes it).

- [ ] **Step 1 — Write the failing test.** In `scripts/test-fireworks-scenarios.mts`, for each memory scenario assert the **model-facing** serialized view (the one passed into the prompt) contains no resolved own-card `color`/`rank` and an empty `recommendations.knownPlayableCards`. Also assert non-memory scenario prompts no longer include any `recommendations` block.

- [ ] **Step 2 — Run, expect FAIL.**

- [ ] **Step 3 — Add a redaction option to `getFireworksPlayerView`.**
```ts
export interface FireworksViewOptions { redactOwnIdentity?: boolean; omitRecommendations?: boolean; }
export function getFireworksPlayerView(state, playerId, opts: FireworksViewOptions = {}) {
  // …build view…
  if (opts.redactOwnIdentity) {
    for (const card of view.ownHand.cards) { card.color = null; card.rank = null; if (card.knowledge) { card.knowledge.color = null; card.knowledge.rank = null; } }
    for (const k of view.ownHand.knowledge ?? []) { k.color = null; k.rank = null; }
  }
  if (opts.omitRecommendations || opts.redactOwnIdentity) delete (view as any).recommendations; // or build with empty knownPlayableCards
  return view;
}
```
Keep `notColors`/`notRanks`/`clueHistory` intact so the deduction remains solvable. Do NOT change the default (no-arg) behavior — the live game UI (`components/games/fireworks/FireworksActionPanel.tsx`) relies on `recommendations`.

- [ ] **Step 4 — Use the redacted view on the benchmark prompt path only.** In `lib/benchmark/gameiq/fireworks.ts` build `initialState` with `{ omitRecommendations: true, redactOwnIdentity: <isMemoryScenario> }`. In `lib/benchmark/fireworks/certified-runner.ts`, when serializing the scenario into the prompt (`gameIqScenarioPrompt` / `buildFireworksPrompt` path), pass the same options for the memory suite. Ground truth (`scenario.expectedActions`, `scenario.state`) is untouched, so scoring still works.

- [ ] **Step 5 — Regenerate the committed snapshot.** Find the generator (Grep for the writer of `benchmarks/gameiq/v1/fireworks.json`, e.g. a `scripts/*generate*`/`review-benchmark-corpus` script). Regenerate so the serialized scenario states no longer contain leaked recommendations / resolved memory identity. If no generator exists, the snapshot is authored by hand — update it via a small script that re-emits the scenarios through the redacted mapper.

- [ ] **Step 6 — Run, expect PASS.** `npx tsx scripts/test-fireworks-scenarios.mts` and `npx tsx scripts/test-certified-fireworks-runner.mts`.

- [ ] **Step 7 — Lint.** `npm run lint`

- [ ] **Step 8 — Commit.**
```bash
git add lib/games/fireworks/hidden-view.ts lib/benchmark/gameiq/fireworks.ts lib/benchmark/fireworks/certified-runner.ts benchmarks/gameiq/v1/fireworks.json scripts/test-fireworks-scenarios.mts
git commit -m "fix(benchmark): strip optimal-move recommendations and memory identity from Fireworks prompt view"
```

---

## Task 6: Add a trap-setup correctness validator and fix the three broken Connect Four boards

**Files:**
- Modify: `lib/benchmark/gameiq/validation.ts` (`validateConnectFourCategory`, ~255-286)
- Modify: `lib/benchmark/gameiq/connect-four.ts` (the trap-setup board definitions, ~88-115 and generated ~305-334)
- Test: `scripts/test-gameiq-scenarios.mts` (extend)

**Problem:** `trap-setup` scenarios have hand-authored expected columns with no engine-derived correctness check (only legality is verified). Empirically 3 of 10 trap boards do NOT produce the advertised double threat: `trap-right-yellow`, `trap-low-red`, `trap-high-yellow` — and for two of them a different column is the real answer, so the scorer marks the correct move wrong.

**Change:** Add a validator that drops the expected disc and requires ≥2 immediate winning follow-ups; fix the 3 boards.

- [ ] **Step 1 — Write the failing test.** Extend `scripts/test-gameiq-scenarios.mts` to run the new `validateConnectFourCategory` trap branch over all trap-setup scenarios and assert each passes (≥2 winning follow-ups after the expected drop). It will fail on the 3 known-bad boards.

- [ ] **Step 2 — Run, expect FAIL** (3 boards fail).

- [ ] **Step 3 — Add the validator branch.** In `validateConnectFourCategory`, add a `trap-setup` case that, using the same `dropDisc`/`getLegalColumns` helpers as `hasImmediateConnectFourWin`, drops the expected disc for `state.turn`, then counts columns whose next drop wins for `state.turn`; fail with a clear message if `< 2`.

- [ ] **Step 4 — Fix the three boards.** In `connect-four.ts`: set `trap-low-red` expected column to `3`, `trap-high-yellow` to `5`; re-author `trap-right-yellow`'s board so some column yields a genuine double threat (the current board has none). Verify each by re-running the validator.

- [ ] **Step 5 — Run, expect PASS.** `npx tsx scripts/test-gameiq-scenarios.mts` and the corpus review `npx tsx scripts/review-benchmark-corpus.mts` (if present).

- [ ] **Step 6 — Lint.** `npm run lint`

- [ ] **Step 7 — Commit.**
```bash
git add lib/benchmark/gameiq/validation.ts lib/benchmark/gameiq/connect-four.ts scripts/test-gameiq-scenarios.mts
git commit -m "fix(benchmark): validate Connect Four trap-setup correctness and fix three broken boards"
```

---

## Task 7: Harden the WorkBench verifier against case-meta tampering

**Files:**
- Modify: `scripts/bench-runner.mjs` (`resolveSafePath` / write/patch/append handlers, ~539-553 and the `/write` `/patch` routes)
- Modify: `lib/benchmark/workbench/executor.ts` (verify-time re-check)
- Test: `scripts/test-bench-runner-guards.mts` (new) — exercise the path guard at the module level

**Problem:** The live build-engine WorkBench path lets the model-under-test write `case-meta.json` (the verifier's entire ruleset) and `verifier.mjs` via the runner's generic write/patch tools. Blanking the criteria yields `passed=true, score=1` with no detection.

**Change:** (a) Make a fixed set of harness files read-only from the worker's perspective in the runner; (b) re-snapshot/compare those files at verify time and hard-fail (`invalid_case`) on tamper.

- [ ] **Step 1 — Write the failing test.** In `scripts/test-bench-runner-guards.mts`, import the path-guard predicate from `bench-runner.mjs` (export a small pure helper `isProtectedWorkspaceFile(relPath)` if not already separable) and assert it returns `true` for `case-meta.json`, `verifier.mjs`, `verifier-result.json`, `negative-control.json`, `reference-solution.md`, and `false` for `src/app.ts`.

- [ ] **Step 2 — Run, expect FAIL** (helper not present / returns false).

- [ ] **Step 3 — Add the runner write guard.** In `bench-runner.mjs`, add `isProtectedWorkspaceFile(relPath)` (normalize then compare against the protected set — reuse the exclusion list already in `build-adapter.ts:548-562`), and reject `/write`, `/patch`, `/append` whose resolved in-workspace path is protected (HTTP 403 / structured error). This closes the full build-engine path that the patch-only path already restricts.

- [ ] **Step 4 — Add verify-time tamper detection.** In `executor.ts`, before running the verifier, compare `case-meta.json` + `verifier.mjs` against the prepare-time snapshot (already captured in `meta.snapshot`) — if changed, set the attempt `status: "invalid_case"` (tamper) instead of scoring it.

- [ ] **Step 5 — Run, expect PASS** for the guard test; manually reason through the executor path (no automated runner in tests).

- [ ] **Step 6 — Lint.** `npm run lint`

- [ ] **Step 7 — Commit.**
```bash
git add scripts/bench-runner.mjs lib/benchmark/workbench/executor.ts scripts/test-bench-runner-guards.mts
git commit -m "fix(benchmark): make WorkBench harness files read-only and detect verifier tampering"
```

---

## Task 8: Stop awarding full cost credit when WorkBench traces are unpriced

**Files:**
- Modify: `lib/benchmark/workbench/build-adapter.ts` (`summarizeBuildDiscussionResult`, ~266-275)
- Modify: `lib/benchmark/scoring/workbench.ts` (cost term policy, ~18-26)
- Modify: `lib/client/build-engine.ts` (stamp `estimatedUsd` onto benchmark traces, ~3693 and ~3744)
- Test: `scripts/test-build-benchmark-hooks.mts` (extend with an unpriced-trace case)

**Problem:** `costUsd` is set only if *every* trace is priced; the build-engine path never stamps `estimatedUsd`, so cost is always `null` → `efficiencyScore` awards full cost credit (`?? 1`). Unpriced/custom models out-rank fully-priced ones.

**Change:** Sum priced traces like the other tracks; don't award full credit for unknown cost; root-cause by stamping `estimatedUsd` on build-engine traces.

- [ ] **Step 1 — Write the failing test.** In `scripts/test-build-benchmark-hooks.mts`, add a case where traces have **mixed/omitted** `estimatedUsd` and assert `summarizeBuildDiscussionResult(...).costUsd` is the **sum of priced traces** (non-null), and that `scoreWorkBenchAttempt` with `actualCostUsd = null` does NOT yield full cost credit.

- [ ] **Step 2 — Run, expect FAIL.**

- [ ] **Step 3 — Fix the cost summation.** In `build-adapter.ts`, replace the all-or-nothing rule with the shared semantics:
```ts
costUsd: costTotal(input.traces.map((t) => t.estimatedUsd ?? null)),
```
(`costTotal`/`sumNullable` returns null only when every trace is unpriced — mirror `gameiq/certified-runner.ts`.)

- [ ] **Step 4 — Fix the scoring policy.** In `workbench.ts`, stop awarding full credit for unknown cost: when `costFactor` is null, exclude the cost term and renormalize the remaining weights (or treat as no cost credit). Do not keep `0.25 * (costFactor ?? 1)`.

- [ ] **Step 5 — Stamp cost on build-engine traces (root cause).** In `lib/client/build-engine.ts`, pass the already-computed `estimatedUsd` (≈ lines 3782-3789) into the `createGameModelCallTrace` calls at ~3744 (success) and ~3693 (error), so build traces carry real cost like the certified path.

- [ ] **Step 6 — Run, expect PASS.**

- [ ] **Step 7 — Lint.** `npm run lint`

- [ ] **Step 8 — Commit.**
```bash
git add lib/benchmark/workbench/build-adapter.ts lib/benchmark/scoring/workbench.ts lib/client/build-engine.ts scripts/test-build-benchmark-hooks.mts
git commit -m "fix(benchmark): sum priced WorkBench traces and stop full cost credit for unpriced runs"
```

---

## Self-review checklist (run after implementing)

- [ ] Every High finding maps to a task (1→invalid_case, 2→redaction, 3→codenames, 4→fireworks-fallback, 5→fireworks-view-leak [covers both memory + recommendations findings], 6→gameiq-trap, 7→workbench-verifier, 8→workbench-cost). ✅ 9 findings / 8 tasks.
- [ ] No placeholders — each task names exact files, the concrete change, a real `tsx` test, the run command, and a commit.
- [ ] Identifiers used here (`isInvalidCertifiedRun`, `costTotal`, `getFireworksPlayerView`, `scoreFireworksScenarioAction`, `createGameModelCallTrace`) are verified against the actual files during implementation before writing final code.
- [ ] `npm run lint` clean and all touched `scripts/test-*.mts` print `PASS` before each commit.
