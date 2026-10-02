# T5 independent review — round 10 (structural Gradle reader)

Reviewer: independent, fresh context, no memory of the controller session. I did not edit any source or test file and did not commit. This file is the only file I wrote in the repo.

Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6-t5` (T5 is uncommitted; `git status --short` = 18 entries before and after).
Scratch: `C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch-t5-r10\`:
- `wt\` — byte-identical copy of `runner-v2/{package.json,src,test}` (+ `affected-tests.ts.bak`), used for prove-red;
- `wt-fix\` — the same copy plus a scratch-only prototype of the B1 fix (see B1), never copied to the worktree;
- `probes-{r2,r2b,r3,r3b,r4..r9}.test.mts` (earlier probe files; r2/r3 got only the env-configurable `AFF_SRC` import line) and `probes-r10.test.mts` (new);
- `probes-*.{cur,r9tree,proto}.out.txt`, `diff-*.txt`, `timing.test.mts`, `timing.cur.out.txt`, `pr-baseline.txt`, `pr-red-A.txt`, `pr-red-B.txt`, `pr-restored.txt`, `proto-suite.txt`.

## Scope

Read: `T5-review-r9.md`; `T5.md` "Controller repair 6 (after review r9) — structural Gradle reader"; `runner-v2/src/affected-tests.ts` `stripGradleComments` (`:727-763`), `GRADLE_CROSS_PROJECT_OPENER` (`:778`), `GRADLE_PLAIN_PROJECT_CALL` (`:781`), `readGradleProjectEdges` (`:807-892`), the build-file branch of `parseMavenGradleGraph` (`:922-940`); the new test `R9: dependency-block project references…` (`runner-v2/test/affected-tests.test.ts:1138-1174`).

Per the owner's TEST-RUN RULE I did not re-run the repair-6 suites. Hash check:

| File | Evidence sha256 | Tree | Match |
|---|---|---|---|
| `runner-v2/src/affected-tests.ts` | `b6ac5a0196b9ea404cc21d1aa45d44996c9b77d03e1f6596c941c62673f3a21c` | same | OK |
| `runner-v2/test/affected-tests.test.ts` | `17e57133792da90b1b071f5b187321ea0c7bce35ac57c4895d18f2ef7af38e2d` | same | OK |

Baseline for regression diffs: the r9 tree, `review-scratch-t5-r9\wt` (sha `cadec8d4…a641`).

## Design assessment

The direction is right, and it is a real change of method rather than another rule: one linear, string-aware brace-stack pass whose rules are stated in terms of *context* (inside a `dependencies {}` block / under a block that configures another project / outside) and *value flow* (a project literal inside a dependencies block is an edge only if its value is used as-is; any dereference makes it unreadable). That model is why R9-B1/B2 are closed without re-breaking R8's roots, and why the r4–r9 history is stable (below). The inside-dependencies rule is sound.

It still has three structural holes, and they are design holes, not missing shapes:

1. **Block context is taken from the physical line, not from the statement.** The opener of a `{` is `code.slice(lineStart, i)` (`:840`). Gradle's grammar does not put the `{` on the same line as the call it belongs to: Allman style (`dependencies\n{`), wrapped Kotlin arguments (`configure(\n  …\n) {`) and chained calls (`subprojects\n  .filter {…}\n  .onEach {`) all lose their opener. This is a regression versus the r9 tree for the most basic shape — a module's own `dependencies` block (B1).
2. **"Outside a dependencies block, project calls are ignored" is not sound.** The rule is justified for values consumed on the spot (`project(":a").tasks…`, `project(':x') {`, `findProject(":a")?.let { it.version = … }`), but a Project value that *escapes* (assigned, put in a collection, passed to `add(...)` in a helper) can reach a dependency declaration through a name the reader never sees. The r9 tree read these as edges; they are now silent (B2). The fix is the mirror image of the inside rule, so it stays structural.
3. **The reader only sees `build.gradle(.kts)`.** Convention plugins (buildSrc / build-logic) and `apply from:` script plugins declare project dependencies for every module that applies them (B3, pre-existing).

Plus one pre-existing over-wide case on an idiom from the Gradle manual (`implementation(project())` in JVM Test Suites, B4).

So: the structural rule does not just move the whack-a-mole. Holes 1 and 2 are each one structural change (1 is prototyped below: 43/43 tests and every r4–r9 probe unchanged). But as shipped it is not yet sound.

## Probe-history diff (current tree vs r9 tree, both directions)

All commands: `"C:\Program Files\nodejs\node.exe" .\node_modules\tsx\dist\cli.mjs --test --test-concurrency=1 <file>` from the worktree root. The r9 tree was run with `AFF_SRC=file:///C:/Users/b_a_s/AppData/Local/Temp/p6-6/review-scratch-t5-r9/wt/runner-v2/src/`. Every file: 0 failures on both trees (probe files print observations; the tests do not assert).

| Probe file | pass/fail (cur / r9 tree) | PROBE lines | Diff lines | Changes (classification) |
|---|---|---|---|---|
| r2 | 15/0 / 15/0 | 100 | 18 | timing numbers only (`ms` values) — neutral |
| r2b | 3/0 / 3/0 | 12 | 0 | — |
| r3 | 12/0 / 12/0 | 47 | 0 | — |
| r3b | 1/0 / 1/0 | 7 | 0 | — |
| r4 | 6/0 / 6/0 | 75 | 0 | — |
| r5 | 6/0 / 6/0 | 106 | 0 | — |
| r6 | 2/0 / 2/0 | 28 | 4 | **DYN6** narrow → fail-closed (intended, fixes R9-B1) |
| r7 | 3/0 / 3/0 | 29 | 16 | V5, V8, V11, V13: root edge list changes, all still `edgesUnknown` — no selection effect (neutral) |
| r8 | 5/0 / 5/0 | 53 | 12 | **SG4** (unterminated `"""` before deps) precise → narrow (regression, invalid script, NOTE N4); SL 20k/80k unclosed `project(` unknown → not unknown (neutral: garbage, no deps block) |
| r9 | 3/0 / 3/0 | 24 | 36 | RX1, RX2, RX6–RX11, RX13, RX17 narrow → fail-closed (intended, R9-B1/B2 fixed); RX4, RX5 (`project(':core').sourceSets.test.output`) precise → fail-closed (safe widening, NOTE N5) |

New `probes-r10.test.mts`: 5/0 on both trees, 63 PROBE lines. Current vs r9 tree:

| Probe | Shape | r9 tree | current | Class |
|---|---|---|---|---|
| Z1, Z2, Z2b | module `dependencies\n{` (Groovy, KTS, CRLF) | precise | **narrow** | regression → B1 |
| Z3, Z3b | root `subprojects\n{ dependencies {` | fail-closed | **narrow** | regression → B1 |
| Z4 | root `configure(\n  subprojects.filter {…}\n) {` | fail-closed | **narrow** | regression → B1 |
| Z5 | root `configure(listOf(\n  project(":app"),…\n)) {` | fail-closed | **narrow** | regression → B1 |
| Z9, Z11 | `subprojects\n.filter{}\n.onEach { p -> p.dependencies {`; `subprojects(\n{ p -> …})` | narrow | narrow | pre-existing → B1 (same fix) |
| Z7, Z8 | `val app = project(":app"); app.dependencies {`; `gradle.beforeProject {` | narrow | narrow | pre-existing, rare → N3 |
| Z6, Z10 | `subprojects { if (…) { dependencies {`; `listOf(project…).forEach {\n it.dependencies {` | Z6 unknown, Z10 narrow | unknown | Z10 improved |
| D1 | `val coreProject = project(":core")` + `implementation(coreProject)` | precise | **narrow** | regression → B2 |
| D2 | Groovy `def shared = [project(':core')]` + `implementation shared` | precise | **narrow** | regression → B2 |
| D5 | `fun DependencyHandler.coreDeps() { add("implementation", project(":core")) }` | precise | **narrow** | regression → B2 |
| D3 | root `ext.coreDep = project(':core')`, app `implementation rootProject.ext.coreDep` | narrow | narrow | pre-existing → B2 |
| D6, D6b | build-logic `.kt` convention plugin / buildSrc precompiled script plugin adding `project(":core")` | narrow | narrow | pre-existing → B3 |
| D7 | `apply from: "$rootDir/gradle/common.gradle"` declaring `project(':core')` | narrow | narrow | pre-existing → B3 |
| D4, D8, D13, W2 | top-level `dependencies.add(…)`, `dependencies.implementation project(…)`, `withDependencies { add(project.dependencies.create(project(…))) }` | precise | fail-closed | acceptable |
| D9–D12, D14 | `each`/`forEach` in deps (unknown); `constraints {}`, `sourceSets { main { dependencies {`, `project.dependencies {` (edge) | same | same | OK |
| C2, C2g | JVM Test Suites `implementation(project())` + a plain edge | **all modules** | **all modules** | pre-existing → B4 |
| C11–C14 | `if (findProject(":core") != null) {`, `extensions.configure<…> {`, `if (project.hasProperty(…)) {`, `afterEvaluate {` wrapping own deps | precise | all modules | widening on less common shapes → N2 |
| C1, C3–C10, C15–C22 | KMP `val commonMain by getting`, Android app module, Spring Boot Groovy, `configureEach`, `constraints`, `platform`/`enforcedPlatform`/`testFixtures`, string-invoked `"implementation"(…)`, root `subprojects`/`allprojects` configuration, `plugins.withType`, multi-line `project(\n":core"\n)`, `tasks.register("run")`, BOM prefix, `'{'`/`'}'` char literals, `java-test-fixtures` | precise | precise | OK |

## Findings

### BLOCKING

**B1 — Block openers are read from the physical line, so a `{` on the next line (or after a wrapped argument list or a call chain) loses its opener. The result is a too-narrow `ok` selection. This is a regression from the r9 tree.**
- Location: `affected-tests.ts:825` (`lineStart` is the only boundary), `:840` (`const opener = code.slice(lineStart, i)`), `:841` (`/\bdependencies\s*$/`), `:850` (cross test on the same slice).
- Scenarios (core change; AppTest missed; `edgesUnknown=false`; rung `module_graph`):
  - Z1/Z2/Z2b: a module's own `dependencies\n{\n implementation project(':core')\n}`. The `{` has an empty opener, so the block is not a dependencies block, and the call is treated as "outside" and ignored. On the r9 tree this was precise.
  - Z3/Z3b: `subprojects\n{\n dependencies {`. The cross opener is lost. The edge is attributed to the root only.
  - Z4/Z5: Kotlin wrapped `configure(\n  subprojects.filter { … }\n) {` and `configure(listOf(\n  project(":app"),\n  project(":data"),\n)) {`. The opener is `) `. These shapes are what ktlint or IntelliJ produce for long argument lists.
  - Z9/Z11 (pre-existing): chained `subprojects\n  .filter {…}\n  .onEach { p -> p.dependencies {`, and a Groovy closure argument on its own line.
- Minimal fix: take the opener from the start of the *statement*, not the line. Do this in the same pass:
  - Track `parenDepth`.
  - At a newline with `parenDepth === 0`, start a new statement only if the next non-blank character is not `{`, `.`, `?.` or `)`.
  - `;` at depth 0 starts a statement.
  - `{` saves `(stmtStart, parenDepth)` on its frame, then resets both for the block body.
  - `}` restores them, so a chain `a {…}\n.b {` stays one statement.
  - I prototyped exactly this in `review-scratch-t5-r10\wt-fix` (about 20 changed lines; diff in the scratch dir):
    - `affected-tests.test.ts`: 43/43 pass.
    - r4–r9 probe files: 0 changed PROBE lines against the current tree.
    - r10 probes: Z1, Z2 and Z2b become precise; Z3, Z3b, Z4, Z5, Z9 and Z11 become fail-closed.
    - No C-control changes.
  - For N1 below, compute the opener flags incrementally, or bound the slice, rather than re-slicing.
- Tests to add: Z1 (module Allman: core change must select AppTest precisely) and Z4 (wrapped `configure(` in a root: fail closed).

**B2 — A Project value that escapes outside a dependencies block reaches dependency declarations silently. The result is a too-narrow `ok` selection. This is a regression from the r9 tree for D1, D2 and D5.**
- Location: `affected-tests.ts:876-880`. Outside a deps block a `project(`/`findProject(` call is ignored unless its line contains the word `dependencies`.
- Scenarios (core change; AppTest missed; `edgesUnknown=false`):
  - D1: `val coreProject = project(":core")` then `dependencies { implementation(coreProject) }`.
  - D2: Groovy `def shared = [project(':core')]` then `dependencies { implementation shared }`.
  - D5: `fun DependencyHandler.coreDeps() { add("implementation", project(":core")) }` then `dependencies { coreDeps() }`.
  - D3 (pre-existing): root `ext.coreDep = project(':core')`, consumed in a module through `rootProject.ext.coreDep`.
  - Why it is silent: inside a dependencies block, an identifier argument (`coreProject`, `shared`, `coreDeps()`) is not a project call, so nothing marks it unknown.
- Minimal fix: the mirror of the inside rule. Outside a dependencies block, a project call is benign only when its value is consumed on the spot. Otherwise → unknown. "Consumed on the spot" means any of these:
  - it is dereferenced (`.x` or `?.x`, as the code already detects with `next`);
  - it opens a block (`project(':x') {`);
  - it is an argument of `dependsOn`, `mustRunAfter`, `shouldRunAfter`, `finalizedBy` or `evaluationDependsOn`;
  - its statement (with B1's `stmtStart`) is a cross-project opener such as `configure(listOf(project…)) {`.

  An escaping value is one that is assigned, put in a collection literal, or passed to `add(` or any other call. This keeps the R8 roots and OC3/RR7/RY1–RY5 precise. Those roots are all dereferences or block openers.
- Test to add: D1 and D2 (module file: core change must select AppTest or give `edgesUnknown`). Add RR7 and OC3 as controls.

**B3 — Project dependencies declared in convention plugins or script plugins are never read. The result is a too-narrow `ok` selection. This is pre-existing and was not raised in earlier rounds.**
- Location: `affected-tests.ts:922`. Only `build.gradle(.kts)` basenames are read, so every other Gradle build-logic file in `fileContents` is skipped.
- Scenarios (core change; AppTest missed; `edgesUnknown=false`):
  - D6: `build-logic/convention/src/main/kotlin/FeatureConventionPlugin.kt` does `dependencies { add("implementation", project(":core")) }`, and app applies `id("example.feature")`. This is the Now-in-Android `AndroidFeatureConventionPlugin` pattern: feature modules get `:core:ui` and `:core:designsystem` edges only through the plugin.
  - D6b: a buildSrc precompiled script plugin `feature-conventions.gradle.kts` with `"implementation"(project(":core"))`.
  - D7: `apply from: "$rootDir/gradle/common.gradle"`, where the script declares `implementation project(':core')`.
- Minimal fix: in `parseMavenGradleGraph`, scan every other Gradle build-logic file that `fileContents` carries. That means:
  - any `*.gradle` or `*.gradle.kts` other than build or settings files;
  - any file under `buildSrc/`;
  - any file under an `includeBuild("…")` directory named in settings.

  Scan with the same string-aware reader. Any `project(`, `findProject(` or `projects.` reference in such a file sets `edgesUnknown`, because the owner is whoever applies the plugin, and that cannot be read. Most convention plugins reference no project, so ordinary convention builds stay precise.

  Record the T6 caller contract: pass those files in `fileContents`.
- Test to add: D6 and D6b (core change must select AppTest or give `edgesUnknown`). Add a control: a convention plugin with only `libs.*` deps stays precise.

**B4 — `implementation(project())` (self reference, the JVM Test Suite idiom from the Gradle manual) makes every ordinary build with integration-test suites select every module. This is pre-existing.**
- Location: `affected-tests.ts:781`. `GRADLE_PLAIN_PROJECT_CALL` requires a quoted path, so `project()` falls through to `unknown = true` at `:875`.
- Scenarios C2 and C2g: `testing { suites { val integrationTest by registering(JvmTestSuite::class) { dependencies { implementation(project()); implementation(project(":core")) } } } }`, and its Groovy form. A data change selects all three test sets, and `edgesUnknown=true`, on both trees.
- Minimal fix: inside a dependencies block, `project\s*\(\s*\)` is the owning project itself. Skip it: no edge and no unknown.
- Test to add: C2. A data change must select DataTest only, with no `edgesUnknown`.

### NON-BLOCKING

- **N1: the time cost is quadratic in line length, not linear.**
  - Cause: every `{` re-slices and regex-tests the line from `lineStart` (`:840-851`), and every call outside a dependencies block re-slices its whole line (`:877-879`).
  - Measured with `timing.test.mts`, through `parseMavenGradleGraph`:

    | Input | Time |
    |---|---|
    | 80k `project(` on one line | 3452 ms |
    | 80k `findProject(` on one line | 4851 ms |
    | 100k `a{` on one line | 18.7 s |
    | 200k `a{` on one line | **75.5 s** |
    | 20k `dependencies {` on one line | 7.4 s |
    | 40k `dependencies {` on one line | 29.6 s |
    | 80k `project(` newline-separated | 43 ms |
    | Realistic 1.77 MB multi-line block | 109 ms |

  - Realistic files have short lines, so this is not blocking. It does not match the evidence note "80k unclosed `project(` 53 ms", which only holds for newline-separated input.
  - Fix: incremental opener flags per statement (B1), or cap the opener slice and cache the per-line `dependencies` test.
- **N2: own-project blocks are treated as cross-project, and ordinary files lose precision.**
  - Scenarios: C11 `if (findProject(":core") != null) {`, C12 `extensions.configure<…> {`, C13 `if (project.hasProperty("x")) {`, C14 `afterEvaluate {`, each wrapping the module's own dependencies block. They were precise on the r9 tree and now give `edgesUnknown`, which selects all modules.
  - Cause: `GRADLE_CROSS_PROJECT_OPENER` (`:778`) matches `project` in `project.hasProperty`, `configure` in `configure<T>`, and a receiver-less `afterEvaluate`.
  - This fails closed and the shapes are less common, so it is not blocking.
  - Fix: count `project`/`findProject` only as `…(`-calls with a path, `configure` only as `configure(`, and `afterEvaluate` only with an explicit receiver.
- **N3: `val app = project(":app"); app.dependencies {` (Z7) and root `gradle.beforeProject { dependencies {` (Z8) stay narrow.** Both are rare. B2's escape rule covers Z7.

### NOTES

- **N4:** SG4 (an unterminated `"""` before the dependencies block) is now narrow. The script is invalid, so Gradle fails before tests run and no false green is possible. The known scanner gaps from r8 and r9 (slashy and dollar-slashy strings, nested templates holding `/*`) are unchanged: SG5, SG7, SG8 and SG21 are narrow on both trees.
- **N5:** RX4 and RX5 (`project(':core').sourceSets.test.output` inside a dependencies block) went from a precise edge to fail-closed. This is safe. If precision is wanted, a dereference inside a dependencies block could be read as edge plus unknown only for lambda members.
- Robustness checks passed:
  - BOM (C19), CRLF (SG13, SG14), and `'{'`/`'}'` char literals (C20) are precise.
  - Unbalanced closers and an unterminated triple quote produced no crash.
  - A 5 MB realistic file took 177 ms.
  - 20k nested `dependencies {` lines took 196 ms, and 20k `{` plus 20k project calls took 314 ms.
- Word-boundary checks passed:
  - `configureEach` (C5), `withType`, `withId`, `applyFrom` (W1) and `letter` (W3) do not trigger the cross rule.
  - `withDependencies` (W2) fails closed through the `dependencies` line rule, which is acceptable.
  - `tasks.register("run") {` (C18) does not matter, because it has no nested dependencies block. A string in the opener can still match a cross word, since the opener slice includes string text.

## Prove-red (reproduced in `review-scratch-t5-r10\wt`, `--test-name-pattern="R9|R6-B1"`)

- Baseline: 2 tests, 2 pass, 0 fail.
- Mutation A, the controller's "non-plain call inside deps not marked unknown": `:875` `unknown = true;` becomes a comment. Result: 1 pass, **1 fail**, at `affected-tests.test.ts:1159` in `R9` (`:1138`). The assertion body is `implementation(project(":core").also { println(it) })`. This matches the evidence (0/1 on the `.also` shape).
- Mutation B, the controller's "cross-project ancestor rule removed": `:871` `if (crossAbove) unknown = true;` becomes a comment. Result: 1 pass, **1 fail**, at `:1041` in `R6-B1` (`:1028`). This matches the evidence.
- Restore: `cp` from the `.bak`. `cmp` reports the file identical to both the backup and the worktree file. The re-run gave 2/0.

Prototype validation (B1 fix, scratch only): `wt-fix` `affected-tests.test.ts` 43/43 pass (`proto-suite.txt`); r4–r9 probe files 0 changed PROBE lines against the current tree; r10 probes change only Z1, Z2, Z2b, Z3, Z3b, Z4, Z5, Z9 and Z11, all toward correct.

## Commands and counts

- `sha256sum` of both files: matches repair 6 (table above), before and after the review.
- Probe history, current tree against the r9 tree: 11 files, all with 0 failures. PROBE line counts: r2 100, r2b 12, r3 47, r3b 7, r4 75, r5 106, r6 28, r7 29, r8 53, r9 24, r10 63. Diff line counts: r2 18 (timing only), r6 4, r7 16, r8 12, r9 36, all others 0.
- `timing.test.mts`: 1/0, 9 TIME lines.
- Prove-red: baseline 2/0, A 1/1, B 1/1, restored 2/0.
- Worktree: 18 status entries before and after. No file other than this review was written in the repo.

## Verdict

The structural reader is the right design. It closes R9-B1 and R9-B2, keeps the whole r4–r9 probe history stable, and keeps ordinary Android, Spring Boot, KMP and root-configuration builds precise. Two of its axioms are unsound as shipped:
- The opener is taken from the physical line, which drops a module's own `dependencies\n{` edges and misses wrapped or chained cross-project openers (B1, a regression).
- Project values outside a dependencies block are assumed benign, which drops edges that flow through variables and helpers (B2, a regression).

Two pre-existing gaps are also in the requested scope: convention-plugin and script-plugin dependencies are never read (B3, too narrow), and the manual's `implementation(project())` self reference fails the whole graph closed (B4, every module selected). B1 and B4 are each a small fix. B1's fix is prototyped and verified.

T5 REVIEW r10 — REPAIR REQUIRED — 4 blocking
