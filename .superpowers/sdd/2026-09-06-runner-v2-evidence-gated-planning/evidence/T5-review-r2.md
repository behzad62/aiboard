# T5 independent review — round 2

Reviewer: independent reviewer (a different model from the T5 worker, Muse). No memory of round 1; round 1 was read from `T5-review-r1.md`.
Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6-t5`, branch `codex/runner-v2-p6-6-t5`, base `57e80f45`, T5 not committed.
No source or test file was edited, and nothing was committed. This review is the only file written in the repo.
Scratch: `C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch-t5-r2\`. It holds:
- `probes-r2.test.mts`: the 41 round-1 probes, adapted or inverted, plus the new probes.
- `probes-r2b.test.mts`: the store, Cargo and cap probes.
- `importgraph.mjs`: a static import graph of this repo's `runner-v2/src` and `runner-v2/test`.
- `wt/`: a byte-identical copy of `runner-v2/src` and `runner-v2/test`, used for prove-red.

## Scope reviewed

- Read: the T5 brief, the repair brief (`t5-repair1.txt`), `T5-review-r1.md`, `evidence/T5.md` (including "Repair cycle 1"), OA-11, OA-12 and OA-13 in the owner amendment, plan T5 and the EP46 row.
- Code read in full: `test-report-readers.ts`, `validation-observation.ts`, `evidence-applicability.ts`, `affected-tests.ts`, `mutation-probe.ts` and `change-risk.ts`, plus the diffs of `evidence-store.ts`, `sqlite-evidence-store.ts` and `evidence-tools.ts`.
- Scope check:
  - `git status --short` shows only the 3 modified and 15 new T5 files.
  - `git diff --name-only` shows only `evidence-store.ts`, `evidence-tools.ts` and `sqlite-evidence-store.ts`.
  - No existing test file was modified.
  - No forbidden file (scheduler, planning, build-runtime, factory, runtime, architect, prompt, T1 contract, UI) was touched.
  - `git diff --quiet 57e80f45 -- package.json package-lock.json runner-v2/package.json` shows no package change, so no new dependency was added.

## sha256 verification ("Repair cycle 1" table)

- 17 of 18 rows match the working tree exactly.
- The `runner-v2/test/change-risk.test.ts` row is malformed. It records 96 hex characters: `4a2a2552…ce2fd8`**`f2f1f9103f2fd8`**`d50b8f2f1f9103f`. The actual hash is `4a2a2552f51db40a7ff0923ce4a0651d7301bb10ddfce2fd8d50b8f2f1f9103f`, which is the recorded value with a pasted 14-character fragment removed.
- This is a typo in the evidence file, not a tree mismatch (see N10).

## Verification of round-1 findings

| R1 finding | Status | Evidence (probe → result) |
|---|---|---|
| B1 nothing-ran reads `passed` | **Fixed** | R1 (all-skipped JUnit), R2 (TRX `executed=0`) and R4 (gtest all disabled / `notrun`) → `unknown`. A3 (`passed:0`) is now rejected at creation. |
| B2 TRX timeout/aborted | **Fixed** | R3 → `failed` (2 failed). A lying `ResultSummary` gives `outcome="Completed"` with failing counters → `unknown`. |
| B3 malformed / contradicting JUnit | **Fixed** | R5 (failure element against clean aggregate) → `unknown`. R6 (truncated) → `unknown`. R7 (totals in a comment) now reads the real suite → `failed` 1/2. R8c (DOCTYPE/ENTITY) → `unknown`. CDATA holding `<testcase …><failure/>` inside a Surefire `system-out` is ignored correctly (reads `passed` 2 + 1 skipped). |
| B4 stale dirty tree | **Fixed** | A1 → `satisfies:false`. A legit dirty observation with the matching digest → `true`. Prove-red reproduced (below). |
| B5 required assertions | **Fixed** | A2 (required id skipped) → false. A6 (empty required list) → false. A7 (1 of 3 selected) → false. |
| B6 reuse without impact inspection | **Fixed** | E1 → `unknown`. Legit reuse (all four dimensions plus `changedCheckIds` plus a matching `codeImpact`) → `reusable`. Code drift → `invalidated`. |
| B7 empty selection | **Fixed for the round-1 shapes** | T1 (lockfile) → all module tests. T2 (root file only) → full suite. T3 (impact tool with no `run`) → full suite. T4 (xUnit) → the `App.Tests` files. T4b (`Directory.Build.props`) → all module tests. T7 (Cargo inline tests) → full suite. T8 (LSP 0 refs) and T8b (LSP truncated) → full suite. **New variants under-select, see NB1 and NB3.** |
| B8 Go/Gradle dependents | **Partly fixed** | Go single module: T5 without sources → every package; with sources → `api`+`util` (correct). Gradle Groovy `include ':x'` plus `project(':x')`: T6 → `app`+`core` (correct). **Still broken for Go `replace` multi-module, Gradle Kotlin DSL / comma includes, and Cargo inline-table or table-form dependencies, see NB2.** |
| B9 durable envelope | **Fixed** | Real SQLite store, restart: the acceptance decision before and after reload is `deepEqual` (satisfies:true, dirty + digest + skip rationale). A base-version DB opens read-only with no observations, then read-write. A pre-repair T5 DB (table with no envelope columns) opens read-only, migrates read-write, and a legacy row reloads with `capabilityFingerprint` absent → acceptance `false` (fails closed). New rows survive restart. |
| B10 mutation rung 1 | **Partly fixed** | P1 (exit 127) and a crashed spawn (ENOENT) → step down to `builtin_mutator`, recorded in notes. Every write goes to `/copy/…` and cleanup runs. Survivors are carried when the parser exists. **A tool with no survivor parser still reports "tool-reported survivors: 0" (P3), see NB4.** |
| N1 quadratic readers | **Fixed** | Hostile input (32 000 × `<testsuite `) → 1 ms. A 9.96 MB realistic JUnit report (164 254 cases) → 137 ms, `passed`. 10 MB hostile unterminated tag → 8 ms. 10 MB `<` flood → 42 ms. 8 MB `<!--` flood → 25 ms. 9 MB tag flood → 552 ms. An 8.5 MB TRX → 58 ms. |
| N2 config/dependency | **Fixed** | A4 → false. A missing expectation → false. |
| N3 prose | **Fixed** (residue in N4 below) | A5 `manual-claim` → false. |
| N4 flaky isolation | **Mostly fixed** (residue in N5 below) | A10 (other tests and fingerprints) throws. |
| N5 unverified_claim | **Fixed** | E2 (empty revision, no artifacts) → `unverified_claim`. A legit claim → `verified`. |
| N6 lexer | **Fixed for every listed shape** (residue in N6 below) | M1, M2kt, M2swift, M3, M3b, M3c (C# raw), M4raw, M4nested, M5raw, M5regex, M6, M6f and M7 produce no string, comment or generic mutants. The C++ raw string with delimiter, spanning lines, is handled. The Kotlin nested comment and the Go raw string over multiple lines are handled. |
| N7 non-building mutants | **Fixed** | P2 (Java, no build oracle) → caught 0, unverified 2. |
| N8 kernel surface | **Partly fixed** (see N9 below) | A project set works (C1 project surface → `high`). The default Runner V2 set is still applied silently to other projects. |
| N9 unknown evidence id | **Fixed** | "Observation cites non-existent evidence nope." |
| N10 truncated LSP | **Fixed** | T8b → full suite. |
| N11 fixtures assert selections | **Fixed** | Tests assert selections. The .NET and CMake fixtures use realistic names. |

## Over-correction check (does fail-closed break genuine passes?)

- **Clean passes still read passed:**
  - Surefire (pass plus skip, CDATA in the log) → passed.
  - pytest → passed.
  - gtest (pass plus skip) → passed.
  - jest-junit (with a comment and `>` in an attribute) → passed; a real jest failure → failed.
  - pytest with a BOM → passed.
  - TRX clean → passed; TRX with mixed outcomes → failed.
- **Legit acceptance and legit reuse** → `satisfies:true` and `reusable`.
- **Ladder narrowness is kept, not always the full suite:**
  - xUnit solution: a Web change → only `Shop.Web.Tests`; a Core change → Core and Web tests.
  - Cargo workspace: a core change → core and cli (plain `path` dependency).
  - CMake: a `core/cart.cpp` change → `tests/test_cart.cpp` only.
  - This repo without an LSP → full suite (correct: a single package with no workspaces).
- **Genuine passes that now read `unknown`.** These are non-blocking because they fail closed (N1 below):
  - PHPUnit nested suites.
  - `ctest --output-junit` with a skipped test.
  - A `<!DOCTYPE html>` inside a CDATA `system-out`.

## New findings

### BLOCKING

**NB1: The module-graph rung silently drops a changed file that maps to no module when another changed file does map.** `runner-v2/src/affected-tests.ts:417-423` (unmapped files are skipped) and `:548-552` (a non-empty result is returned).
- The fallback for an unmapped file (B7 step-down) only fires when the whole selection is empty. A mixed change set loses the unmapped file's dependents.
- Probe TN1 (npm workspaces):
  - Change `packages/a/src/a.ts` plus the root-level shared file `shared/util.ts`.
  - Result: `module_graph` with `[a.test.ts, b.test.ts]`. `packages/c` is never selected.
  - T2 shows the same shared file alone correctly goes to the full suite. The rule is inconsistent.
- Probes TN3b and TN3c (Gradle): change `core` plus `app`. Only `ATest.java` is selected. `core`'s own `CTest.java` (and, in TN3c, `web`'s `WTest.java`, since web depends on core) are missed, because `core` is not a parsed module (see NB2).
- Scenario: the OA-4 high-tier affected-test command skips a broken consumer, and the outcome is a false green.
- Minimal fix: if any changed file is not under a module dir (and is not a test file), return the full suite (or step down), whatever the other files map to. Record the unmapped file in the rung reason.

**NB2: Module-graph parsers miss dependency edges on mainstream syntax, so dependents are not selected (B8 class).**
- **Cargo**, `affected-tests.ts:277`:
  - `depsSection = content.split(/\[dependencies\]/)[1]?.split(/\[/)[0]` cuts the section at the first `[`.
  - Any inline table with an array before the path dependency truncates it. Example: `serde = { version = "1", features = ["derive"] }`, which is ubiquitous.
  - The `[dependencies.shop-core]` table form and `[dev-dependencies]` are ignored too.
  - Probes CARGO features, CARGO table form and TN5b dev-dependency: a core change selects only `crates/core/tests/cart.rs`. `crates/cli/tests/cli.rs` (cli depends on core) is missed.
- **Go**, `:296` and `:308`:
  - Only the first `go.mod` is used.
  - Nested modules wired with `replace example.com/lib => ./lib` get the wrong import path (`example.com/app/lib`), so `import "example.com/lib"` edges never resolve.
  - The doc comment claims require/replace handling that does not exist.
  - Probe TN2: a change to `lib/lib.go` → only `lib/lib_test.go`. The `api` package (which imports `example.com/lib`) is missed.
- **Gradle**, `:367`:
  - The include regex `include\s+['"]…['"]` does not match Kotlin DSL `include(":app", ":core")` (the Gradle default).
  - It takes only the first name of a comma list (`include 'app', 'core', 'web'`).
  - A module with no `project(...)` dependencies is then absent from the graph, and every edge to it is dropped at `:428` (`if (!byName.has(dep)) continue`).
  - Feeds NB1 (TN3b, TN3c).
- Minimal fix:
  - Cargo: parse every `[dependencies]`, `[dev-dependencies]`, `[build-dependencies]`, `[target.*.dependencies]` and `[dependencies.<name>]` section line by line, not by a `[` split.
  - Go: read every `go.mod` (module path per module dir) and map `replace … => ./dir`.
  - Gradle: accept `include(...)` and comma lists.
  - In all three: when a dependency or include cannot be parsed, set `edgesUnknown` (every module is a dependent), the safe direction the code already supports for Go.

**NB3: The LSP rung keeps only direct test references and discards non-test referencers, so tests that reach a changed file through another module are never selected.** `affected-tests.ts:500-520` (`:512` keeps only `isTestFile` locations).
- Probe TN8 on this repository's real import graph (`runner-v2/src` → `runner-v2/test`, via `importgraph.mjs`), changing `runner-v2/src/evidence-store.ts`:
  - The LSP rung selects 13 test files.
  - 124 test files import it transitively; 112 of those are missed.
  - The missed files include `evidence-tools.test.ts`, `sqlite-evidence-store.test.ts`, `final-verification-runtime.test.ts` and `final-verification-runtime-b1.test.ts`. The T5 worker itself had to run these for this very change.
- Because rung 2 sits above the module graph, it preempts the safe floor.
- Scenario: a behavior change in a shared source module passes the high-tier affected-test run while a downstream consumer's tests are never executed.
- OA-12 words rung 2 as "the tests that reference changed symbols", but also says "the ladder never narrows below what it can justify". A direct-only reference set does not justify excluding transitive dependents (the same reasoning that made B8 blocking).
- Minimal fix:
  - Follow non-test referencing files through `query` to a fixpoint, with a bound on files and queries.
  - Exceeding the bound, or any `unsupported_language` or truncation inside the closure, is a failed rung → step down.
  - Add a fixture where src A → src B → test B asserts `test B` is selected.

**NB4: The mutation probe's rung 1 still reports "0 survivors" when the configured tool has no survivor parser (B10 residue).** `runner-v2/src/mutation-probe.ts:742`, `:747`, `:760`.
- `parseSurvivors?.(…) ?? []` makes an absent parser equal to "parsed, zero survivors".
- Probe P3: Stryker exits 0 with stdout "Mutation score 60%. Survived: 4" and no `parseSurvivors`. The result is `rung:"project_tool"`, `toolSurvivors:[]`, note "tool-reported survivors: 0".
- This is exactly the "success with 0 survivors" shape the repair brief forbids: the report was never parsed.
- Related (same fix site): cargo-mutants exits 2 and mutmut exits non-zero *because* survivors exist. Probe P4 shows the rung is marked failed and the tool's two `MISSED` survivors are discarded before parsing. The step-down is honest, but the tool's evidence is lost.
- Minimal fix:
  - Make `parseSurvivors` required; when it is absent, treat the rung as failed ("report unparseable") and step down.
  - Allow a per-tool set of "survivors found" exit codes that still parses the report and records the survivors.

### NON-BLOCKING

- **N1: Reader over-correction on genuine passes (fails closed, but unusable evidence).** `test-report-readers.ts`:
  - `:150-152` and `:170`: `hasDoctype` scans the raw text, so a `<!DOCTYPE html>` inside a CDATA `system-out` (Selenium or Playwright page dumps) makes a passing report `unknown`. Check the stripped text, or only the prolog before the root.
  - `:206-216`: a testcase with `status="notrun"` and a `<skipped/>` child counts twice. `ctest --output-junit` writes exactly that for a skipped test, per CMake's JUnit writer, so any ctest run with a skip is `unknown`. OA-13 names ctest.
  - `:236-251`: nested `<testsuite>` totals are summed at every level, so a clean PHPUnit report is `unknown`.
  - Fix: count one not-executed per testcase, and take totals from the root or leaf suites only.
- **N2: TRX is still less strict than JUnit.** `test-report-readers.ts:326-371`:
  - `<UnitTestResult outcome="Failed">` elements are never cross-checked against `Counters`. Probe "trx lying counters vs results" reads `passed`.
  - A TRX cut after `<Counters>`, with no `</ResultSummary>` or `</TestRun>`, reads `passed`.
  - Both need a malformed or merged file, not VSTest output, but they are the same class B3 fixed for JUnit.
- **N3: Aggregate-only JUnit (`<testsuite tests="5" failures="0"/>` with no testcase elements) reads `passed` 5/5.**
- **N4: Acceptance gaps.** `validation-observation.ts`:
  - `:258-263`: an empty `expectedArtifactHashes` makes the substituted-artifact check vacuous. Probe A11: a substituted artifact → `satisfies:true`. This is inconsistent with the fail-closed rule applied to a missing config or dependency expectation (`:270`).
  - `:174-192`: `MACHINE_READABLE_METHODS` includes `command` and `exit_code`, methods with no machine-readable counts. Probe A12 → `true` with caller-synthesised counts. OA-13 says exit status alone is not proof that a test ran.
- **N5: Flaky isolation accepts a rerun of any test the first run selected, not the failing one.** `validation-observation.ts:468-483`.
  - Probe A10b: the rerun of `a1` → `flaky`.
  - The worker lists this approximation. The fix needs an explicit failing-assertion-id input, since T1's observation has no per-assertion results. It never yields a pass, since flaky still blocks.
- **N6: Mutation lexer residue.**
  - Rust plain `"…"` strings may span lines, and the next line's content is mutated (probe "rust multiline plain string" → `==` and `&&` inside the string).
  - JSX `<div>` and `</div>` brackets are mutated in `.tsx` (M10). They are then counted as caught, because TS is a script family with no build oracle. That inflates `caught`; there is no false survivor.
- **N7: Widening misses common config files.**
  - `jest.config.js`, `vitest.config.ts`, `tsconfig.build.json` / `tsconfig.*.json`, `.env` and `Dockerfile` raise no trigger (TN9).
  - They fall to the impact tool or LSP rungs. Usually these return nothing and step down, but a configured impact tool can return a narrow set.
- **N8: The Maven parser takes the `<parent>` artifactId as the module name, so every child merges into one module** (`affected-tests.ts:360`). TN7 → over-selection (safe direction). With no root `pom.xml`, the merged dir becomes one child's dir.
- **N9: change-risk.**
  - When `kernelSurface` is omitted, the Runner V2 default is applied silently: the detail is "no kernel surface touched", not "default surface used" (`change-risk.ts:291-292`). The repair brief asked for "unknown set recorded, not silently 0".
  - `isTestPath` (`:160-166`) does not recognise `*_test.go`, `*Tests.cs` or `FooTest.java` outside `/test/`. This over-estimates risk (safe direction).
  - Thresholds and the three P6.5 conditions are unchanged from round 1. The constants in the source match the table: 3/120/10/800, bands 1/4, kernel 2, no-test 2, attempts/waiver 1, tiers 0/1/2. no defect-carrying commit is `low`; four trivially safe commits are `low`; `58f71603` is `high`.
- **N10: Evidence hygiene.**
  - The `change-risk.test.ts` sha256 row is malformed (see above).
  - `evidence-tools.ts` is labelled "(untouched)", although it is modified against base. It was untouched only by the repair cycle.

### NOTES

- `applyMutant` throws when the disposable file's content differs from `files[].content`, and the exception escapes `runBreakItProbe` after cleanup. This fails loudly, not falsely.
- `recordObservation` accepts an evidence id from a different run, and does not cross-check the envelope's `artifactHashes` against the cited evidence record's artifacts. The acceptance check relies on the caller's `expectedArtifactHashes` (see N4).
- The mutation caps work:
  - Count cap: executed 2 of 6, `partial`, reason recorded.
  - Time cap: executed 3 of 6, `partial` "(time cap)".
  - The original tree is never written; the fake FS log shows writes only under `/copy/`.
  - Ruby → `not_available`, recorded.

## Commands and counts

- sha256 check: `sha256sum` of all 18 files in the "Repair cycle 1" table. Result: 17 match exactly, and 1 row has a malformed recorded value (the actual file is as described above).
- Worker suites were **not** re-run, per the owner rule (evidence records 703/703).
- Probes (`node .\node_modules\tsx\dist\cli.mjs --test --test-concurrency=1 <file>`, run from the worktree root):
  - `review-scratch-t5-r2\probes-r2.test.mts`: 15 tests, 15 pass, 0 fail, 100 `PROBE` lines. This covers every round-1 probe, adapted or inverted, and the new reader, acceptance, applicability, ladder, lexer, mutation and change-risk probes.
  - `review-scratch-t5-r2\probes-r2b.test.mts`: 3 tests, 3 pass, 0 fail, 12 `PROBE` lines. This covers Cargo inline tables, mutation caps and a crashed tool, and the store checks: base DB, pre-repair T5 DB, restart plus acceptance identity, and a missing evidence id.
- **Prove-red reproduced: B4 stale dirty tree.**
  - Mutating the worktree was refused by the auto-mode classifier, so this ran in a byte-identical scratch copy (`wt\runner-v2`).
  - Worktree hash, re-read afterwards: `5dcfb735…bcb812`, unchanged.
  - Scratch baseline: `validation-observation.test.ts` 20/20.
  - BEFORE: `5dcfb735f8ee52e838c9871184c41be19272ab8c3e804b921e5af75736bcb812`, 23254 bytes.
  - Injection, a unique match at line 243: `if (obs.dirty !== input.expectedDirty) {` becomes `if (input.expectedDirty && obs.dirty !== input.expectedDirty) {`.
  - INJECTED: `a5d9b55ee288b69e3ae9842ec49994a0b3eb45fed8d0550e34d5939953ddcebd`, 23277 bytes, the same size as the worker's recorded injection. `diff` shows 1 line changed.
  - RED: 19/20. The failing test is "repair B4" at `validation-observation.test.ts:479`, with `actual: true`, `expected: false`: stale dirty evidence satisfies acceptance. This matches the worker's record.
  - Restored from a byte copy. AFTER: `5dcfb735…bcb812`. `cmp` against the worktree file is identical, and the re-run is 20/20.
- **Prove-red reproduced: B7 empty selection.** This also ran in the scratch copy.
  - BEFORE: `89896b00…747886`.
  - Injection at `:548`: `tests.length > 0` becomes `>= 0`.
  - INJECTED: `a5a68ce3…c8de`. `diff` shows 1 line.
  - RED: 14/16, failing at `affected-tests.test.ts:58` and `:194`, with `actual: 'module_graph'`, `expected: 'full_suite'`. This matches the worker's record.
  - Restored. `cmp` is identical to the worktree, and AFTER is `89896b00…747886`.

## Verdict

- **Fixed:** all round-1 reader, acceptance, reuse and store defects (B1–B6, B9), plus the round-1 empty-selection shapes (B7) and the named lexer shapes.
- **Over-correction:** it does not break clean JUnit or TRX passes, legit acceptance, legit reuse, or narrow selection on .NET, Cargo and CMake.
- **Still open:**
  - The affected-test selector under-selects on realistic input in three ways:
    - A mixed mapped/unmapped change (NB1).
    - Cargo inline-table deps, Go `replace` modules and Gradle Kotlin DSL (NB2).
    - The LSP rung drops transitive dependents: 112 of 124 test importers are missed in this repo (NB3).
  - Mutation rung 1 still reports "0 survivors" for an unparsed tool report (NB4).

T5 REVIEW r2 — REPAIR REQUIRED — 4 blocking
