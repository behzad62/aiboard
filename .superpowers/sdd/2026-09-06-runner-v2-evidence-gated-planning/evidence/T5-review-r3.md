# T5 independent review — round 3

Reviewer: independent reviewer (a different model from the T5 worker, Muse). No memory of rounds 1 or 2; both were read from `T5-review-r1.md` / `T5-review-r2.md`.
Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6-t5`, branch `codex/runner-v2-p6-6-t5`, base `57e80f45`, T5 uncommitted.
No source or test file was edited; nothing was committed. This file is the only file written in the repo.
Scratch: `C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch-t5-r3\`
- `rerun-probes*.txt`: the round-1 (41) and round-2 (15 + 3) probe files re-run unchanged against the current tree.
- `probes-r3.test.mts`, `probes-r3b.test.mts` (+ `.out.txt`): new round-3 probes.
- `repograph.mjs`: a whole-repo static import graph (relative + `@/` alias, 1279 files) used as a simulated LSP.
- `wt/`: byte-identical copy of `runner-v2/src` + `runner-v2/test` used for the prove-red.

## Scope reviewed

- Read: `t5-brief.txt`, `t5-repair1.txt`, `t5-repair2.txt`, `T5-review-r1.md`, `T5-review-r2.md`, `evidence/T5.md` "Repair cycle 2" (including "Not done / limits"), OA-11..OA-14 in `docs/superpowers/specs/2026-09-22-runner-v2-p6-6-owner-amendment.md`.
- Code read in full: `affected-tests.ts`, `test-report-readers.ts`, `validation-observation.ts`; the rung-1 section of `mutation-probe.ts` (`:668-976`); the scoring half of `change-risk.ts` (`:150-356`).
- Scope: `git status --short` = 18 entries (3 modified, 15 new, all T5 files). `git diff --name-only` = `evidence-store.ts`, `evidence-tools.ts`, `sqlite-evidence-store.ts` only. `git diff --quiet 57e80f45 -- package.json package-lock.json runner-v2/package.json` → no change, so no new dependency. No forbidden file touched.

## sha256 verification ("Repair cycle 2" table)

All 18 rows are exactly 64 hex characters and all 18 match the working tree byte-for-byte (`sha256sum` of every file; the only textual difference is `sha256sum`'s binary-mode `*` marker). The malformed cycle-1 `change-risk.test.ts` row (r2 N10) is superseded by a correct row.

## Verification of round-2 findings

Every round-2 probe was re-run unchanged; outputs were diffed line-by-line against the round-2 recorded outputs.

| R2 finding | Status | Evidence (probe → now) |
|---|---|---|
| NB1 unmapped file dropped in a mixed change | **Fixed** | TN1 (npm `packages/a` + `shared/util.ts`) → `full_suite` incl. `packages/c` (was `module_graph` a+b). Prove-red reproduced (below). |
| NB2 Cargo inline tables / table form / dev-deps | **Fixed** | CARGO features, CARGO table form, TN5b dev-dependency → `cli.rs` + `cart.rs` (was `cart.rs` only). |
| NB2 Go `replace` multi-module | **Fixed** | TN2 → `api/api_test.go` + `lib/lib_test.go`. New X9 (replace + nested package + aliased block import + root `main` package) → api, cmd/tool, lib/money, root `main_test.go`; X9b `go.work` wiring → same; X9c `lib/other` change stays narrow. |
| NB2 Gradle Kotlin DSL / comma includes | **Fixed for the named shapes** | TN3a/b/c → core + app (+ web). New X5 kts `project(":core")`, X5c multi-line `include(...)`, X5d nested `:libs:core` all correct. **Typesafe project accessors still missed, see NB8.** |
| NB3 LSP direct-only | **Fixed** | TN8 (`evidence-store.ts`) → 140 selected, 0 of 124 transitive test importers missed (was 112 missed). X10 on the whole repo (1279 files, `@/` alias): `planning-contracts.ts` 140/0 missed, `lib/providers/base.ts` 216/0 (closure 542 files), `lib/db/schema.ts` 216/0, `lib/orchestrator/build.ts` 216/0, `components/ui/button.tsx` 22/0, `gameiq/types.ts` 44/0, `affected-tests.ts` 1/0. The 1000-file cap is never hit on this repo (max closure 542) and is sane: over the cap → step-down, not partial (worker test + code `:760-764`). |
| NB4 parser-less tool → "0 survivors" | **Fixed** | P3 → `builtin_mutator`, note "tool report unparseable (no survivor parser for stryker)". P4 cargo-mutants exit 2 → `project_tool` with both `MISSED` survivors kept. |
| N1 reader over-correction | **Fixed** | PHPUnit nested → passed 2/2; ctest `notrun`+`<skipped/>` → passed 2 + 1 skipped; `<!DOCTYPE html>` in CDATA → passed. R10 nested wrapper → ok 3/3 (was unknown). A real prolog doctype stays unknown (R8c). |
| N2 TRX lying counters / truncated | **Fixed** | both → `unknown` (were `passed`). |
| N3 aggregate-only JUnit | **Not changed (listed "not done")** | Ruled below. |
| N4 empty artifacts / `exit_code` method | **Fixed** | A11 → false, A12 → false. Legit clean acceptance still `satisfies:true`. |
| N5 flaky rerun of a non-failing test | **Fixed** | A10b now refused ("requires the first run's failing assertion ids"). |
| N6 lexer residue | **Fixed** | M4 Rust multiline plain string → only the real line-4 `==`; M10 JSX → only the real `>` inside `{x > 1}`. |
| N7 config widening | **Fixed** | TN9: `jest.config.js`, `vitest.config.ts`, `tsconfig.build.json`, `.env`, `Dockerfile` → build-configuration widening. |
| N8 Maven parent merge | **Fixed** | TN7 → core + api, `other` excluded. X6 (root `dependencyManagement` listing `core`) → same; X6b `other` narrow. |
| N9 kernel surface / test paths | **Fixed** | C1 → "kernel surface unconfigured (no project policy selected; Runner V2 default not applied)"; C2 `*_test.go` → pairing ok. |
| N10 evidence hygiene | **Fixed** | see sha256 section. |

Round-2 "verified" list — no regression: readers (R1–R10 and every RN clean-pass shape identical or improved), acceptance (A legit true; A1–A12 fail closed), reuse (E legit `reusable`, E1 `unknown`, E2 `unverified_claim`/`verified`), store (base DB read-only then read-write; pre-repair DB migrates; legacy row → acceptance false; restart decision `deepEqual`; unknown evidence id refused), mutation caps (count 2/6 partial, time 3/6 partial, crash → step-down), 10 MB reader timings (133–576 ms).
Round-1 probe file: 38/41 pass; the 3 failures are expected, not defects: A3 now throws at creation (the fix), E2 used a superseded call shape (`claim.args`), S1 is a Windows `EPERM` on the probe's own temp-dir cleanup (the same store checks pass in `probes-r2b`).

## New findings

### BLOCKING

**NB5 — Test-file identity is a filename heuristic that misses `.spec.*` (and non-`*Tests` .NET test projects), so mixed layouts under-select on both the LSP and the module-graph rungs.** `runner-v2/src/affected-tests.ts:155-176` (`isTestBasename` / `isTestFile`), used at `:774` (LSP collection) and `:710` (module-graph attribution).
- `.spec.ts` / `.spec.js` (Jest, Vitest, Angular, Playwright, Mocha) is never a test unless it sits under `/test/`, `/tests/` or `__tests__`. A top-level `tests/x.spec.ts` is not one either (the `/tests/` check needs a leading slash).
- Probe X1 (npm workspaces, `a` has colocated `src/cart.spec.ts`, `b` depends on `a` and has `test/b.test.ts`): change `packages/a/src/cart.ts` → `module_graph` `[packages/b/test/b.test.ts]`. `a`'s own spec never runs.
- Probe X1 (LSP): `cart.ts ← cart.spec.ts`, `cart.ts ← checkout.ts ← {checkout.spec.ts, test/e2e.test.ts}` → `lsp_references` `[test/e2e.test.ts]`; both specs dropped, although the caller's `fullSuiteTests` lists them.
- Probe X7 (.NET): `Shop.Web.Specs` (references `Shop.Web`, which references `Shop.Core`; files `CheckoutSpecs.cs`, `WhenPaying.cs`) is never selected on a Core change.
- Only a pure-`.spec` repo is safe (nothing recognised → step-down → full suite, X1b). Any repo that mixes a recognised name with `.spec` gets a narrowed selection with a clean `ok` rung — the OA-12 "never narrows below what it can justify" violation the ladder exists to prevent.
- Minimal fix: treat any path in `fullSuiteTests` as a test (the caller's suite is the authoritative test identity); add `.spec.`, `_spec.`, `.cy.`, `Spec(s)` stems to the heuristic; for .NET, attribute every file in a project that references a test SDK (or whose project is in the full suite) as a test. Test both rungs with a mixed `.spec`/`.test` fixture asserting the spec is selected.

**NB6 — A changed test file is not selected unless something else reaches it.** `affected-tests.ts:773-785` (LSP collects only referencers), `:708-717` + `:727-730` (module graph: a changed test outside every module is neither selected nor "unmapped"), `:814-817` (impact-tool result returned as-is).
- Probe X2: change `src/a.ts` + `test/b.test.ts` (b does not import a) → `lsp_references` `[test/a.test.ts]`; the edited test never runs.
- Probe X2c (npm workspaces): change `packages/a/src/a.ts` + root `tests/e2e/checkout.test.ts` → `module_graph` `[packages/a/test/a.test.ts]`; the changed e2e test is dropped (the NB1 guard deliberately excludes test files).
- Probe X2d: an impact tool that omits the changed test → the changed test is dropped.
- A modified or newly added test is affected by definition. Downstream B5 acceptance catches it only when the test is a *required* assertion; an edited non-required test (for example one the change broke) passes the OA-4 high-tier affected run unexecuted.
- Minimal fix: union every changed file that is a test (NB5 identity) into the selection of every rung above the full suite, and record it in the rung reason. Test each rung.

**NB7 — Cargo: inline `#[cfg(test)]` unit tests of affected crates are dropped whenever any affected crate has a `tests/` file (B7 variant).** `affected-tests.ts:708-717` (only `isTestFile` paths are selected; a crate's `src/*.rs` never is), fallback at `:874-878` fires only on an empty result.
- Probe X3: `shop-core` has only inline unit tests; `shop-cli` depends on it and has `tests/cli.rs`. Change `crates/core/src/cart.rs` → `module_graph` `[crates/cli/tests/cli.rs]`. Core's own unit tests — the tests closest to the change — are not selected. The same happens to core's inline tests when core also has a `tests/` dir (only `tests/*.rs` is listed).
- Inline unit tests are the default Rust layout, so this is the common case, not an edge case. Round 1 B7 required the changed crate's inline tests to be selected; the repair only covered the empty-selection shape (round-2 T7).
- Minimal fix: for `kind: "cargo"`, select each affected crate as a whole (for example its `src/lib.rs` / `src/main.rs` as the inline-test target, or a crate id), or, when inline tests cannot be ruled out without source contents, step down to the full suite. Test: X3 must include core.

**NB8 — Gradle typesafe project accessors (`implementation(projects.core)`) are not parsed and do not set `edgesUnknown`, so dependents are dropped (NB2 residue).** `affected-tests.ts:627-633` only matches `project(':x')`.
- Probe X5b: settings `enableFeaturePreview("TYPESAFE_PROJECT_ACCESSORS")` + `include(":app", ":core", ":other")`; `app/build.gradle.kts` has `implementation(projects.core)`. Change core → `module_graph` `[core/.../CartTest.kt]`; `app`'s tests are missed.
- This is the Kotlin DSL form used by modern Android/Kotlin multi-project builds (for example Google's nowinandroid). Round-2 NB2's fix contract was "when a dependency cannot be parsed, set `edgesUnknown`"; here the dependency is not even recognised as one.
- Minimal fix: parse `projects.<a>.<b>` (camelCase/kebab to project path per Gradle's accessor mapping) into edges; when `projects.` accessors or the feature preview appear and a name cannot be mapped, set `edgesUnknown`. Test X5b selects app + core.

**NB9 — Over-correction: the Cargo parser sets `edgesUnknown` on mainstream manifest syntax, so every crate's tests are selected for any change in a modern workspace.** `affected-tests.ts:300` (the header regex rejects `[[bin]]` / `[[bench]]` / `[[test]]`, so their keys are swallowed into the previous section), `:359-362` (the dependency-line regex rejects dotted keys), `:369-371` (`[workspace.dependencies]` is "unknown").
- Probe X4: member `[dependencies] serde.workspace = true` (workspace inheritance, stable since Rust 1.64) → `edgesUnknown` → a core change selects `core`, `cli` and the unrelated `other`.
- Probe X4b: dotted key alone → same. Probe X4c: `[[bench]]` after `[dependencies]` in a manifest with no workspace features at all → same.
- Consequences: rung 3 degrades to "all module tests" for most current Cargo workspaces, so the narrow selection the NB2 repair was meant to deliver is unusable there. Safe direction, but this is exactly the "legitimate narrow selection unusable in common real layouts" class.
- Minimal fix: recognise `[[...]]` array-of-tables headers as their own (non-dependency) sections; accept dotted keys `name.workspace = true`, `name.path = "..."`, `name.version = "..."` as a dependency on `name`; treat `[workspace.dependencies]` as a non-edge table (member edges come from the members' own `{ workspace = true }` lines). Test: X4/X4b/X4c select core + cli, not `other`.

### NON-BLOCKING

- **N1 — Docs files widen code changes to the full suite.** `affected-tests.ts:140-143` (`.md` is an "unknown file type", which skips rungs 1–2) plus the NB1 guard (`:867-869`, a root `.md` is "outside every module").
  - Probe Y1b/Y1c, this repo with a working LSP: `runner-v2/src/affected-tests.ts` alone → 1 test; the same change + its task evidence `.md` (this project's normal commit shape) → `full_suite`, 260 tests.
  - Probe Y1e, npm monorepo with Changesets: `packages/a/src/a.ts` + `.changeset/brave-owls.md` (added on every PR) → `full_suite`.
  - Not blocking: OA-12 literally requires "a file type the ladder does not understand" to step down to at least rung 3, and to rung 4 without a module graph. The result is always correct, only slower. Recommended: make documentation types (`.md`, `.mdx`, `.rst`, `.txt`, `LICENSE`, `.changeset/*.md`) "understood, non-executable": record them and exclude them from widening and from the NB1 unmapped check.
- **N2 — mutmut exit codes with the fatal bit set count as a completed run.** `mutation-probe.ts:725` returns true for any code with bit 2. Probe X12: exit 3 (fatal | survived) → `project_tool`, survivors kept, no failure note. mutmut documents bit 1 as "fatal error". Survivors are reviewer evidence and never block, so there is no false pass, but a fatal run is reported as complete. Fix: `(exitCode & 1) === 0 && (exitCode & 2) !== 0`.
- **N3 — `.csproj` files count as test files.** Probe X7 lists `tests/Shop.Core.Tests/Shop.Core.Tests.csproj` in the selection (the stem ends in `Tests`). Harmless over-listing; filter build files out of `isTestFile`.
- **N4 — `change-risk.ts` `isTestPath` also misses `.spec.*`.** A `.spec.ts` change counts as product source without a test (`:162-179`). This overestimates risk (safe direction). Fix with NB5.

### Rulings on the worker's "not done" list

- **Aggregate-only JUnit (`<testsuite tests="5" failures="0"/>`, no `<testcase>`) reads `passed` 5/5.** Classified **NON-BLOCKING**.
  - No tool named in OA-13 (Surefire/Gradle, gtest, `ctest --output-junit`, pytest `--junitxml`, jest-junit, cargo-nextest, go-junit-report) writes totals without testcase elements for a run where tests executed. Each writes one `<testcase>` per test.
  - A nothing-ran run writes `tests="0"` → `unknown` (probe X11c).
  - A truncated run cannot produce this shape. A cut before the root closes is `unknown` (X11e, and r2 R6). A self-closed or closed aggregate element is a complete document, not a truncation.
  - The only producers are hand-written, merged, or fabricated summaries. A fabricated report can fabricate testcases just as easily, so the reader cannot close that hole alone.
  - Cheap hardening, recommended but not required: `caseCount === 0 && tests > 0` → `unknown`.
- **Stryker exit 1 below the `thresholds.break` score steps down to the built-in mutator.** **NOTE**. There is no false pass: the built-in rung runs and records survivors, survivors never block, and the step-down is recorded. `survivorsFoundExitCodes: [1]` restores the tool's survivors when configured. Related NOTE (X12b): `parseSurvivors` returning `[]` for unrecognised output still reads "0 survivors". The interface doc (`:697-702`) should require parsers to throw on an unrecognised report.
- **Flaky isolation needs caller-supplied failing ids.** **NOTE**.
  - The ids must be members of the first run's selection, their count must equal `first.counts.failed`, and the rerun selection must equal them exactly (`:461-508`).
  - A wrong id only changes `flaky` into `consistent_failure` or back. Neither outcome passes the check (the flaky check still blocks).
  - The residual risk is repair-cycle accounting in T6: a mislabelled passing test that passes on rerun would read `flaky` and charge no cycle. T6 must source the ids from the report, not from a model.
  - The readers currently expose counts only, so T6 needs a per-testcase id extraction.

### NOTES

- TRX `ResultSummary outcome="Warning"` with passing counters reads `unknown` (X11g). This fails closed. Worth confirming whether VSTest emits `Warning` for run-level warnings on green runs; if it does, this is a genuine-pass over-correction.
- Surefire `<flakyFailure>` (a test that passed on rerun) reads `passed` (X11d). This is Surefire's own semantics, but OA-14 wants flakes visible. Consider surfacing `flakes` as a finding.
- `change-risk.ts:344` labels an omitted kernel surface `"default"` in the digest input, while the signal says "unconfigured". The label is cosmetic only.

## Commands and counts

All from the worktree root with `node .\node_modules\tsx\dist\cli.mjs --test --test-concurrency=1 <file>` unless stated.
- sha256: `sha256sum` of the 18 T5 files against the "Repair cycle 2" table: 18/18 match, and 18/18 rows are 64 hex characters.
- Worker suites were **not** re-run (owner rule; evidence records 724/724).
- `review-scratch-t5\probes.test.mts` (round 1): 41 tests, 38 pass, 3 fail (expected, see above), 57 PROBE lines.
- `review-scratch-t5-r2\probes-r2.test.mts`: 15/15 pass, 100 PROBE lines. Diffed against `probes-r2.out.txt`: every change is a defect removed.
- `review-scratch-t5-r2\probes-r2b.test.mts`: 3/3 pass, 12 PROBE lines.
- `review-scratch-t5-r3\probes-r3.test.mts`: 12/12 pass, 47 PROBE lines (X1–X12).
- `review-scratch-t5-r3\probes-r3b.test.mts`: 1/1 pass, 7 PROBE lines (Y1).
- **Prove-red reproduced: NB1 unmapped-file guard.**
  - Worktree mutation was avoided; this ran in the byte-identical scratch copy `wt\runner-v2`.
  - Scratch baseline: `affected-tests.test.ts` 26/26.
  - BEFORE: `3c585332ed49a0a439cbc947551463ca8f23e87bf57ed9bda485b2a9e3ab5896`, 38464 bytes, identical to the worktree.
  - Injection (Node byte-exact replace, CRLF preserved, 1 match at `:868`): `if (unmapped.length > 0) {` becomes `if (unmapped.length > 0 && false) {`.
  - INJECTED: `09c2e2b93116c82eaf301fde36058432d59fced11168981939d2e2241b9899e6`, 38473 bytes. `diff` shows exactly 1 line.
  - RED: 25/26. "repair NB1: a mapped change plus an unmapped shared file widens to the full suite" fails at `affected-tests.test.ts:311` with `actual: 'module_graph'`, `expected: 'full_suite'`. This matches the worker's record.
  - Restored from the byte copy. AFTER: `3c585332…ab5896`. `cmp` against the worktree file is identical, and the re-run is 26/26.
  - Worktree hash unchanged throughout: `3c585332…ab5896`.
  - A first `sed` attempt normalised CRLF (37583 bytes). It was discarded and restored before any test ran.

## Verdict

- **Fixed:** all 4 round-2 blocking findings (NB1–NB4) and every round-2 fail-closed and over-correction item except the listed aggregate-only JUnit approximation (ruled non-blocking).
- **No regression:** readers, acceptance, reuse, store, mutation caps and change-risk thresholds all hold. This repo's LSP closure is complete and well under the 1000-file cap.
- **Still open:** the affected-test selector still produces narrowed selections with an `ok` rung on common real inputs:
  - `.spec` tests are not recognised (NB5).
  - Changed test files are dropped (NB6).
  - Cargo inline unit tests are dropped (NB7).
  - Gradle typesafe accessors lose dependency edges (NB8).
- **Over-correction:** the Cargo parser makes narrow selection unusable in modern Cargo workspaces (NB9).

T5 REVIEW r3 — REPAIR REQUIRED — 5 blocking
