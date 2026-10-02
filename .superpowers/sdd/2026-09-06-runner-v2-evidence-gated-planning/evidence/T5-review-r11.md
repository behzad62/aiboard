# T5 independent review — round 11 (controller repair 7: R10-B1..B4)

Reviewer: independent, fresh context, no memory of the controller session. I did not edit any source or test file and did not commit. This file is the only file I wrote in the repo (`git status --short` = 18 entries before and after, not counting this file).

Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6-t5`.
Scratch: `C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch-t5-r11\`. An earlier, stopped r11 reviewer left partial outputs here. I re-generated every output myself and did not rely on them.
- `wt\` — a byte-identical copy of `runner-v2/{package.json,src,test}` (`diff -rq` shows it identical to the worktree; sha values below). `affected-tests.ts.bak` is a copy of the same file.
- `wt-fix\` — `wt` plus a one-line scratch prototype for B1 below (`proto-window.diff`). It was never copied to the worktree.
- Probe files: `probes-{r2,r2b,r3,r3b,r4..r10}.test.mts` (history), new `probes-r11.test.mts`, `probes-r11b.test.mts` and `timing-r11.test.mts`.
- Outputs: `*.cur.out.txt` (current tree), `*.r10tree.out.txt` (r10 tree, `review-scratch-t5-r10\wt`, sha `b6ac5a01…`), `*.proto.out.txt` (`wt-fix`), `diff-*.txt`, `pr11-*.txt` (prove-red), `proto-suite.txt`.

## Scope

Read:
- `T5-review-r10.md`;
- `T5.md` "Controller repair 7 (after review r10)";
- in `runner-v2/src/affected-tests.ts`: `stripGradleComments` (`:727-763`), `GRADLE_CROSS_PROJECT_OPENER` (`:778`), `GRADLE_PLAIN_PROJECT_CALL` (`:781`), `readGradleProjectEdges` (`:807-941`) and `parseMavenGradleGraph` (`:944-1033`, including the new build-logic scan `:963-976`);
- the new test `R10: statement-level openers, escaping project values, build logic and project() self` (`runner-v2/test/affected-tests.test.ts:1176-1258`).

TEST-RUN RULE: I did not re-run the repair-7 suites in the worktree. Hash check:

| File | Evidence sha256 | Tree | Match |
|---|---|---|---|
| `runner-v2/src/affected-tests.ts` | `0bcc353dcb0552bbe271d2a4e71821448c8ffd366beabcc565720952197e3bba` | same | OK |
| `runner-v2/test/affected-tests.test.ts` | `fe82f0eff6df25c43ab363a2aa5fc231e30b2e4201b1ef592bae598efa2e4c3f` | same | OK |

## B1–B4: verification

- **B1 (statement-level opener): fixed for the shapes named in r10, and the reviewer-r10 prototype semantics are kept.**
  - The statement-level mechanics match the prototype: `parenDepth`, the newline continuation set `{ . ) ?.`, `;` ending a statement, and saving/restoring statement start and paren depth per brace frame (`:817-884`).
  - These now read correctly: Z1/Z2/Z2b; Z3/Z3b/Z4/Z5/Z9/Z11 fail closed; and the new variants B1a (`dependencies\n\n\t{`), B1b/B1c (a comment before a next-line `{`), B1d (`project.dependencies\n{`) and B1f (`allprojects\r\n{ dependencies\r\n{`). O20 (a module written in Allman style throughout) is now precise; the r10 tree was narrow there.
  - **One deviation from the prototype, not in it: the opener is no longer the whole statement. It is at most the last 300 characters before `{`** (`WINDOW`, `:820`, `:832`, used at `:862`/`:872`). This was added for r10-N1 speed. It re-opens B1 for long cross-project openers → new BLOCKING **B1** below.
- **B2 (escaping values): fixed for the r10 shapes and their variants.**
  - Fixed: D1/D2/D3/D5; B2a `val p = findProject(":core")!!`, B2c `mapOf(... to project(..))`, B2d `extra["core"] = project(..)`, B2e Groovy `ext { coreDep = project(':core') }`, B2f `by lazy { project(..) }` and B2g `fun coreDep() = project(..)` all fail closed. Z7 now fails closed as well.
  - Residue: a value that escapes *through a dereference* stays narrow (N1 below; rare, pre-existing).
- **B2 over-correction: none on the ordinary shapes the task names.** Every one of these gives data change → DataTest only and core change → AppTest + CartTest (`probes-r11.cur.out.txt`, O-block):
  - O1: a full Android app module (`android { defaultConfig / buildTypes / proguardFiles(...) / testOptions }`, `libs.*`, `platform(...)`);
  - O2: `tasks.named("check") { dependsOn(project(":app").tasks.named("test")) }`;
  - O3: `rootProject.project(":app").afterEvaluate {}`;
  - O4: `gradle.projectsEvaluated {}`;
  - O5: a Spring Boot Groovy module (`bootJar { archiveFileName = "${project.name}.jar" }`);
  - O6/O7: Kover and Dokka root aggregation (`kover(project(..))`, `dokka(project(..))`, `moduleName.set(project.name)`);
  - O8: `evaluationDependsOn(":core")`;
  - O9: `project.version`, `project.findProperty(..)`, `projectDir`, `rootProject.name`, `project.name` and `project.hasProperty`;
  - O10: Groovy `if (project.hasProperty('ci')) { test {} }`;
  - O11/O19/O29: root `subprojects {}` with plugins, repos, `dependencyManagement` and `libs` deps;
  - O12: `allprojects { version = project.version }`;
  - O13: a KMP module (`commonMain.dependencies {}`);
  - O14: `testFixtures(project(..))`;
  - O15: `val v = project(":core").version`;
  - O16: `jar { from project(':core').sourceSets.main.output }`;
  - O17: two dereferenced `dependsOn` arguments;
  - O18: sonarqube properties;
  - O26: `project(":core").let { p -> … dependsOn(p.tasks…) }`;
  - O27: `subprojects { afterEvaluate {} }`;
  - O30: Groovy `dependsOn project(':core').tasks.test`.

  Three less common root shapes now fail closed; they were precise on the r10 tree: `configure(listOf(project(":app"), project(":data"))) {…}` (O23), `configure([project(':app'), project(':data')]) {…}` (O24) and an Allman `project(':app')\n{` (O25). See N2.
- **B3 (build logic outside `build.gradle`): fixed.**
  - The NiA-style convention plugin that references `project(":core")` fails closed (N2). So do a buildSrc precompiled script plugin, a `gradle/*.gradle` `apply from:` script, a plugin under an `includeBuild("gradle/plugins")` directory (N4), buildSrc Java `p.project(":core")` (N5), `getDependencies().project(Map.of("path", …))` (N6), `rootProject.findProject(":core")!!` (N7) and `project(corePath)` (N8).
  - The clean NiA-style build is precise in both directions (N1). It has `includeBuild("build-logic")`, `build-logic/settings.gradle.kts`, a `kotlin-dsl` `build-logic/convention/build.gradle.kts`, an `AndroidApplicationConventionPlugin` that uses `with(pluginManager) { apply(..) }`, `extensions.configure<…> {}` and `dependencies { add("implementation", libs.findLibrary(..).get()) }`, and a `KotlinAndroid.kt` with `project.findProperty`, `commonExtension.apply {}` and `val Project.libs`.
  - Unrelated scripts with `project.findProperty`, `project.rootDir` or `project.projectDir` stay precise (O21 `gradle/publishing.gradle`, O22 `gradle/detekt.gradle.kts`).
  - **The `[^)\s]` guard is right:**
    - `project.findProperty(`, `project.name` and `with(project)` never match, because `project` must be followed by `(`.
    - `findProperty(` is not `findProject(`.
    - `project()` and `project( )` are excluded, and `\s*` backtracking cannot turn the space into the required non-space.
    - `project(\n":x"\n)` still matches.

    The scan is also linear (B1/B2 timing rows below).

    Files scanned: every file whose basename is not `build.gradle(.kts)` or `settings.gradle(.kts)`, if it is under `buildSrc/` or `build-logic/` at the repo root, under an `includeBuild(...)` directory named in settings, or is any `*.gradle` or `*.gradle.kts`.
  - Gaps: a reference by name without `project(` (`childProjects`, `subprojects.first { it.name == … }`) is not seen (N3). The string `"see projects.md"` in a plugin fails closed (N12, harmless). A Gradle root nested in a monorepo subfolder (`android/…`) already goes to the `full_suite` rung (N3/N3b), so it is safe.
- **B4 (`project()` self): fixed.** C2/C2g/O28 are precise. B4a `project( )` is precise.

## Probe-history diff (current tree vs r10 tree, both directions)

All commands: `"C:\Program Files\nodejs\node.exe" .\node_modules\tsx\dist\cli.mjs --test --test-concurrency=1 <file>` from the worktree root. The r10 tree was run with `AFF_SRC=file:///C:/Users/b_a_s/AppData/Local/Temp/p6-6/review-scratch-t5-r10/wt/runner-v2/src/`. Every file had 0 failures on both trees; probe tests print observations and do not assert.

| Probe file | pass/fail (cur / r10) | PROBE lines | Diff lines | Changes (classification) |
|---|---|---|---|---|
| r2 | 15/0 / 15/0 | 100 | 10 | `ms` timing values only — neutral |
| r2b | 3/0 / 3/0 | 12 | 0 | — |
| r3 | 12/0 / 12/0 | 47 | 0 | — |
| r3b | 1/0 / 1/0 | 7 | 0 | — |
| r4 | 6/0 / 6/0 | 75 | 0 | — |
| r5 | 6/0 / 6/0 | 106 | 0 | — |
| r6 | 2/0 / 2/0 | 28 | 0 | — |
| r7 | 3/0 / 3/0 | 29 | 0 | — |
| r8 | 5/0 / 5/0 | 53 | 4 | SL 20k/80k unclosed `project(` (garbage, no deps block): `edgesUnknown` false → true — neutral / fail-closed |
| r9 | 3/0 / 3/0 | 24 | 0 | — |
| r10 | 5/0 / 5/0 | 63 | 52 | Z1/Z2/Z2b narrow → precise; Z3/Z3b/Z4/Z5/Z9/Z11 narrow → fail-closed; Z7 narrow → fail-closed; C2/C2g all-modules → precise; D1/D2/D3/D5/D6/D6b/D7 narrow → fail-closed; T timings much lower (`a{`×100k 7573→27 ms, 80k `project(` 3551→31 ms). **All changes are fixes.** |
| r11 (new) | 3/0 / 3/0 | 115 | 80 | Fixes: O20, O28, N2, N4–N8, B1a–B1g, B1k, B2a, B2c–B2g, B4a. Precise → all modules: O23, O24, O25 (N2), N12 (harmless). **Fail-closed → narrow: B1h** (B1 below) |
| r11b (new) | 1/0 / 1/0 | 5 | 2 | **L2 fail-closed → narrow** (B1 below). L1 is narrow on both trees. L3–L5 fail closed on both. |

## Findings

### BLOCKING

**B1 — The 300-character opener window cuts off long cross-project openers. The result is a too-narrow `ok` selection. This is a regression from the r10 tree for single-line openers, and it leaves the multi-line form of R10-B1 unfixed.**
- Location: `affected-tests.ts:820` (`WINDOW = 300`) and `:832` (`statementBefore` = `code.slice(Math.max(stmtStart, at - WINDOW), at)`). The window is used for the cross-project test at `:862` and `:872`.
- Scenario (core change; AppTest missed; `edgesUnknown=false`; rung `module_graph`; the root gets edge `core`, the subprojects get none):
  - L2: Groovy Spring-style root `configure(subprojects.findAll { !['bom', 'docs', 'samples', …13 names].contains(it.name) && … }) {\n  dependencies {\n    implementation project(':core')\n  }\n}`. On the r10 tree the whole physical line was the opener, so this failed closed. Now it is narrow.
  - B1h: the Kotlin form `configure(subprojects.filter { it.path in listOf(":app", …18 paths) }) { dependencies { "implementation"(project(":core")) } }`. It too was fail-closed on the r10 tree and is now narrow.
  - L1: the same filter wrapped over lines (`configure(subprojects.filter {\n it.name != "bom" &&\n … 13 lines\n}) {`). It is narrow on both trees, so R10-B1's multi-line `configure(\n…\n) {` fix only holds when the argument is shorter than 300 characters.
  - Why it happens: `configure(subprojects` falls outside the last 300 characters. The remaining text contains no cross word, and the lambda's own `{ }` frame does not help.
  - B1g, B1i2 and the r10 Z4 happen to fail closed only because a module name contains the word `with` (`another-module-with-a-long-name`) inside the window.
  - Configuring a filtered set of subprojects with shared test dependencies is an ordinary pattern in large Java and Kotlin builds, and a filter list longer than 300 characters is realistic.
- Minimal fix: the cross test must also see the *head* of the statement, which is where `configure(`, `subprojects`, `allprojects` and `project(` live. At `:872`:

  ```ts
  cross: GRADLE_CROSS_PROJECT_OPENER.test(head) || GRADLE_CROSS_PROJECT_OPENER.test(code.slice(stmtStart, Math.min(i, stmtStart + WINDOW))),
  ```

  This stays bounded, so N1 speed is kept. An incremental alternative: set a per-statement "cross seen" flag while scanning, save it in the frame, and reset it at a statement start.
  - Prototyped in `wt-fix` (`proto-window.diff`, 1 line):
    - `affected-tests.test.ts` 44/44 (`proto-suite.txt`).
    - Probe history r2–r10 and all of r11 except B1h: 0 changed PROBE lines against the current tree.
    - B1h, L1 and L2 become fail-closed.
    - The prototype's trailing `.replace(...)` lost its backslashes to shell quoting and so does nothing. That does not matter, because `dependencies` is not a cross word.
- Test to add: L2 (single-line long `configure(subprojects.findAll {…}) { dependencies {` → `edgesUnknown` true) and L1 (the same wrapped over lines).

### NON-BLOCKING

- **N1 — A project value that escapes *through a dereference* is still silent.** This is pre-existing (narrow on the r10 tree too), and the shapes are rare.
  - Location: `affected-tests.ts:922-928`. `dereferenced` counts as benign even when the statement assigns the result.
  - Shapes: `val p = project(":core").also { … }` (B2h), `findProject(":core")?.let { it }` (B2j), `.apply { }` (B2k), Groovy `def p = project(':core').with { it }` (B2l), `def p = project(':core') { }` (B2m), `rootProject.project(":core").project` (B2n). Each is followed by `implementation(p)`. Core change → AppTest missed.
  - Fix: when the statement before the call is an assignment (`=` that is not `==`, or `val`/`var`/`def`), treat receiver-returning scope calls (`.also`, `.apply`, `.let`, `.run`, `.with`, `.takeIf`, `.project`) and a block opener as escaping. Keep plain property reads (`.version`, `.path`, `.name`, as in O15) benign.
- **N2 — Fail-closed widenings on less common shapes; the first is a regression from r10.**
  - `configure(listOf(project(":app"), project(":data"))) {…}` and Groovy `configure([project(':app'), project(':data')]) {…}` (O23/O24) select every module even with no dependencies block. `configureArgument` (`:925`) accepts only the *first* list element; the second call's `before` ends with `), `.
  - Fix: accept any call whose enclosing paren chain starts the statement with `configure(`. For example: `parenDepth > 0 && /^\s*configure\s*\(/.test(code.slice(stmtStart, stmtStart + 40))`.
  - Allman `project(':app')\n{` (O25) is unknown because `opensBlock` looks only past spaces and tabs (`:903`, `:923`). Fix: skip `\r\n` too when the statement continues with `{`.
- **N3 — A project reference by name, without `project(`, is not seen.** This is pre-existing and rare.
  - `rootProject.subprojects.first { it.name == "core" }`, `rootProject.childProjects.getValue("core")` and `rootProject.childProjects.core` stay narrow in build-logic files (N9/N10), in `gradle/*.gradle` scripts (N11) and in module files (B2o).
  - Fix: add `\bchildProjects\b` (and optionally `subprojects\s*\.\s*(?:find|first|single)`) to the build-logic regex (`:975`) and treat it as unknown in `readGradleProjectEdges`.
- **N4 — Hostile-input time is quadratic in brace *nesting depth*, not in line length.** Line length is now fine.
  - Cause: `context()` walks the whole stack for every project call (`:822-831`), and `stack.some(b => b.projectScoped)` runs on every dependencies `{` (`:869`).
  - Measured (`timing-r11.cur.out.txt`, via `parseMavenGradleGraph`):

    | Input | Time |
    |---|---|
    | `dependencies {` ×20k / ×40k / ×80k on one line | 161 / 570 / 2187 ms |
    | `dependencies {\n` ×40k / ×80k | 570 / 2099 ms |
    | 40k `{` + 40k `project(':x')` inside deps | 1363 ms |
    | 80k `{` + 80k `project(':x')`, no deps | **5051 ms** |

  - The newline look-ahead is linear but carries a constant of about 300: 2M blank lines took 1281 ms.
  - Every single-line case the task names is fast:

    | Input | Time |
    |---|---|
    | 200k `a{` | 60 ms |
    | 80k `project(` | 29 ms |
    | 80k `findProject(':x'` in deps | 53 ms |
    | 200k `(` | 4 ms |
    | 2 MB `projects.` | 145 ms |
    | 200k `project()` | 84 ms |

  - Realistic 5.9 MB and 6.2 MB files took 590 and 644 ms. Build-logic scan inputs (spaces after `project(`, unterminated `/*`, quotes, `"""`) all ran under 70 ms.
  - Realistic nesting depth is under 20, so this is not blocking.
  - Fix: keep a running index of the innermost deps frame, a count of cross frames below it, and a count of `projectScoped` frames, all updated on push and pop. That makes each check O(1). Memoise the newline look-ahead end position.
- **N5 — The build-logic scan is purely path-based.**
  - `buildSrc/` and `build-logic/` are matched only at the repo root (`:972`).
  - `includeBuild(file("x"))` and `includeBuild("../x")` directories are missed.
  - `includeBuild(".")` makes every passed file "build logic". It still stayed precise in N13, because the regex needs a real `project(`.
  - A nested Gradle root is already routed to `full_suite`, so none of this produces a too-narrow selection today. The T6 caller contract recorded in the evidence (pass these files in `fileContents`) is essential: without it, B3 is inert.

### NOTES

- The known scanner gaps (slashy and dollar-slashy strings) are unchanged. A leaked `(` from a slashy regex only lengthens statements, which can only add cross words, so the effect is fail-closed.
- The cross regex still matches words inside string literals in the opener: a module named `…-with-…` or `…-run-…` fails closed. The effect is harmless.
- B2b `listOf(project(":core")).forEach { implementation(it) }` inside a dependencies block records the correct edge.

## Prove-red (reproduced in `review-scratch-t5-r11\wt`, `--test-name-pattern="R10"`)

- Baseline: 1 test, 1 pass, 0 fail (`pr11-baseline.txt`).
- Mutation A, the controller's "newline always ends the statement": `:840` becomes an unconditional `stmtStart = i + 1;`. Result: **0 pass, 1 fail** (`pr11-red-A.txt`). The failure is the `R10` test (`:1176`), assertion at `affected-tests.test.ts:1189:12` on `edgesUnknown` for `dependencies\n{` (actual `true`, expected `undefined`). Under this mutation the Allman block loses its opener, so the reader flags the file unknown instead of recording the edge.
- Mutation B, the controller's "escaping values ignored": `:926` is reduced to `if (/\bdependencies\b/.test(before)) {`. Result: **0 pass, 1 fail** (`pr11-red-B.txt`), assertion at `:1209:12`, message `val coreProject = project(":core")`.
- Restore: each time with `cp` from the `.bak`. `cmp` reports the file identical to the `.bak` and to the worktree file. The re-run gave 1/0 (`pr11-restored.txt`).
- Both match the evidence (0/1 each).

## Commands and counts

- `sha256sum` of both files: matches repair 7 (table above), before and after the review.
- Probe history, current tree against the r10 tree: 13 files, 0 failures on both trees.
  - PROBE line counts: r2 100, r2b 12, r3 47, r3b 7, r4 75, r5 106, r6 28, r7 29, r8 53, r9 24, r10 63, r11 115, r11b 5.
  - Diff line counts: r2 10 (timing only), r8 4, r10 52, r11 80, r11b 2; all others 0.
- `timing-r11.test.mts`: 1/0, 24 TIME lines.
- Prove-red: baseline 1/0, A 0/1, B 0/1, restored 1/0.
- Prototype (`wt-fix`, scratch only): `affected-tests.test.ts` 44/44. Against the current tree, r2–r10 have 0 changed PROBE lines. r11 changes only B1h and r11b only L1 and L2, all toward fail-closed.
- Worktree: 18 status entries before and after. No file other than this review was written in the repo.

## Verdict

Repair 7 closes R10-B1..B4 as named. The ordinary Android, NiA-style, Spring Boot, KMP, Kover/Dokka and plain multi-module shapes stay precise, and the probe history from r2 to r10 is either unchanged or moved toward correct.

One blocking gap remains. The speed fix bounds the opener to the last 300 characters, which drops `configure(subprojects…` from long cross-project openers. A long `configure(subprojects.findAll {…}) { dependencies { … project(…) } }` is therefore read as a root-only edge: a too-narrow `ok` selection, and a regression from the r10 tree. The fix is one line (also test the statement head), and it is prototyped and verified with 44/44 tests and no history changes.

T5 REVIEW r11 — REPAIR REQUIRED — 1 blocking
