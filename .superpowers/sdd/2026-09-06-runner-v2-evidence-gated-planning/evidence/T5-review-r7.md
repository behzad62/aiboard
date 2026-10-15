# T5 independent review — round 7 (narrow)

Reviewer: independent, fresh context, no memory of the controller session. Inputs read from disk only. No source or test file edited; nothing committed; this file is the only file written in the repo.

Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6-t5` (T5 uncommitted). Scratch: `C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch-t5-r7\` — `probes-r7.test.mts` (+`.out.txt`), `probes-r7-against-r6.test.mts` (+`.out.txt`, same probes against the r6-reviewed copy `review-scratch-t5-r6\wt`, sha `512d3ec4…b6b014`), `rerun-probes-{r6,r5,r4}.txt`, `wt\` (byte-identical copy of `runner-v2/{package.json,src,test}`), `inject.cjs`, `affected-tests.ts.bak`, `pr-*.txt`.

## Scope

Read: `T5-review-r6.md`; `T5.md` "Controller repair 3 (after review r6)"; `parseMavenGradleGraph` build-file branch (`affected-tests.ts:761-799`) plus `parseTypesafeGradleEdges` (`:721-731`); new test `R6-B1: …` (`affected-tests.test.ts:1027-1061`). Per the owner's rule the controller's suites were not re-run.

| File | Evidence sha256 | Tree | Match |
|---|---|---|---|
| `runner-v2/src/affected-tests.ts` | `b4099ac6855066c8288b2ab606caa9257c1c3eeaa3d72a86125a9b0274246fea` | same | OK |
| `runner-v2/test/affected-tests.test.ts` | `0014da4a2e02c25f9d955d058b6783356b36158b85b3681b57974a7b7d6bc283` | same | OK |

`git status --short`: 18 entries (unchanged from r6), before and after this review.

## Verification

### R6-B1 fixed (both shapes + requested variants)

Settings `include ':app', ':core', ':data'`, change `core/src/main/kotlin/Cart.kt`. All of these now give `edgesUnknown=true` → App/Core/Data tests (r6 tree: CartTest only):

| Probe | Root build file | r7 |
|---|---|---|
| OCf2 (r6) | `project(':app') { dependencies { implementation project(':core') } }` | fail-closed |
| OCf3 (r6) | `subprojects { … dependencies { implementation project(':core') } }` | fail-closed |
| V1 | `configure(subprojects.filter { … }) { dependencies { … } }` | fail-closed |
| V2 | `allprojects { dependencies { testImplementation project(':core') } }` | fail-closed |
| V3 | KTS `subprojects { dependencies { "implementation"(project(":core")) } }` | fail-closed |
| V4 | KTS `project(":app") { dependencies { "implementation"(project(":core")) } }` | fail-closed |
| V5 | `configure(listOf(project(":app"), project(":data"))) { … }` | fail-closed |
| V6 | `subprojects { dependencies { "implementation"(projects.core) } }` | fail-closed |
| V12 | `subprojects { afterEvaluate { p -> p.dependencies { … } } }` | fail-closed |

### Over-correction (OA-12) — realistic builds stay precise

All `edgesUnknown=false`, core change → `[AppTest, CartTest]`, data change → `[DataTest]` only:
- OC1 root `plugins {}` + `allprojects { group; repositories { mavenCentral() } }` + `subprojects { apply plugin: 'java'; dependencies { testImplementation 'junit:junit:4.13' } }` (external deps only); OC1b data change.
- OC2 config-only `project(':core') { … }` / `project(':app') { … }` openers (the r6 OCf1/OCf1b also stay precise, and the root no longer carries a spurious `.→[app, core]` entry).
- OC3 root `findProject(":app")?.let { it.version = "1" }`.
- OC4/OC4b typical Android Studio multi-project (template `settings.gradle` with `pluginManagement`/`dependencyResolutionManagement`, root `plugins { … apply false }` + `clean` task, app `android { … packagingOptions { resources { excludes += '/META-INF/{AL2.0,LGPL2.1}' } } testOptions { unitTests.all { … } } }`).
- OC5/OC5b typical Spring Boot multi-module (`allprojects`, `subprojects { apply plugin …; dependencyManagement { imports { mavenBom … } }; dependencies { external } ; tasks.named('test') { … } }`).
- OC6 subproject with `tasks.withType<Test>().configureEach {}`, `tasks.named("test").configure {}`, `configure<JavaPluginExtension> {}` — not treated as cross-project.

### No regression in earlier probes

| Probe file | Result | PROBE lines | Diff vs prior output |
|---|---|---|---|
| `review-scratch-t5-r6\probes-r6.test.mts` | 2/2 | 28 | only intended: OCf2/OCf3 now fail closed; OCg/OCh (commented legacy) now precise; OCf1/OCf1b drop the spurious root entry (selection unchanged) |
| `review-scratch-t5-r5\probes-r5.test.mts` | 6/6 | 106 | only G10 (commented legacy) now precise — intended (r6 N1) |
| `review-scratch-t5-r4\probes-r4.test.mts` | 6/6 | 75 | none (ms timing stripped) |

### Prove-red (reproduced two of the controller's three claims, in `wt\`)

Baseline `--test-name-pattern="R6-B1"`: 1 pass / 0 fail.
- X — cross-project rule off (`:794` `if (false && crossProject …`; 1 match, sha `edfa8ea1…`): **RED 0/1** at `affected-tests.test.ts:1040` (AppTest missed for `project(':app') { dependencies { … } }`). Matches controller claim 1.
- M — build-file comment stripping off (`:767` `const code = content;`; 1 match, 4-line diff, sha `1a74af1c…`): **RED 0/1** at `affected-tests.test.ts:1050`, actual `true` vs expected `undefined`. Matches controller claim 2.
- Restored from backup after each; scratch sha `b4099ac6…6fea`, `cmp` vs worktree IDENTICAL; re-run 1/0. Worktree hash unchanged throughout.

## Findings

### BLOCKING

**R7-B1 (regression introduced by repair 3's N1 fix): the build-file comment stripper is not string-aware, so `/*`, `*/` and `//` inside ordinary string literals delete real `project()` edges; the rung stays `module_graph` ok with a too-narrow selection.**
- Location: `affected-tests.ts:767` — `content.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ")`. Both the call count (`:771`) and the edge read (`:776`) run on the stripped `code`, so the dropped edge also drops its call and no `edgesUnknown` is raised. (`:722` has the same pattern for type-safe accessors — pre-existing, probe CM6.)
- Probes (core change; r6 tree selected `[AppTest, CartTest]` for every one of CM1–CM5; r7 selects `[CartTest]` only, `edgesUnknown=false`):
  - CM2 Android app: `packagingOptions { exclude 'META-INF/*.kotlin_module' }` … `dependencies { implementation project(':core') }` … jacoco `excludes: ['**/R.class', …]` — `/*` in the first glob and `*/` in `**/` of the second bracket the whole dependencies block.
  - CM3 `test { include '**/*Test.class' }` before deps and a genuine `/* … */` comment after.
  - CM4 `// TODO: move libs/* into the catalog` (block regex runs first, so `/*` inside a line comment opens a "block") then a later `/** docs */`.
  - CM5 KTS `java.exclude("gen/*")` before deps, `exclude("**/Slow*")` after.
  - CM1 `repositories { maven { url 'https://jitpack.io' } }; dependencies { implementation project(':core') }` on one line — `//` in the URL eats the edge.
  - CM6 (pre-existing, `:722`) same bracketing hides `projects.core`.
- Why blocking: glob strings with `/*` and `**/` (test include/exclude filters, `META-INF/*` packaging excludes, jacoco class-dir filters) are routine in Android and JVM build files, and a single trailing real block comment is enough to close the span. The result is exactly the false-narrow `ok` this round's rule targets, and r6 handled all of these correctly.
- Minimal fix: replace both regex strippers (`:722`, `:767`) with one small string-aware scanner that copies `'…'`, `"…"`, `'''…'''`, `"""…"""` (with `\` escapes) verbatim and only blanks `//…EOL` and `/*…*/` found outside strings. (Alternative fail-closed fallback: if the raw content has more `project(`/`findProject(`/`projects.` occurrences than the stripped code, and any removed occurrence is not on a line whose first non-space token is `//` or inside a `/*` that starts a line, set `edgesUnknown`.)
- Tests to add: CM2, CM3, CM4, CM5 (and CM1) → AppTest selected; controls OCg/OCh/CM7 (commented legacy edge) stay precise with `edgesUnknown` undefined.

### NON-BLOCKING

**N1: Root-level cross-project dependency declarations through member chains / collection iteration are still attributed to the root and missed.** (Pre-existing; same result on the r6 tree.)
- Location: `:793` — `crossProject` only matches `subprojects {`, `allprojects {`, `configure(` and `project('…') {` openers.
- Probes (all `ok`, `[CartTest]` only): V7 `project(':app').with { dependencies { implementation project(':core') } }`; V8 `findProject(':app')?.dependencies?.add('implementation', project(':core'))`; V11 `project(':app').dependencies.add('implementation', project(':core'))`; V13 `rootProject.subprojects.each { p -> p.dependencies.add('implementation', p.project(':core')) }`.
- Uncommon idioms, hence non-blocking. Cheap fix while in the area: treat any project edge in a build file whose `dirOf(path) === "."` as `edgesUnknown` (root build files rarely declare real deps on their own subprojects; aggregation roots just fail closed), or widen `crossProject` to `\b(?:subprojects|allprojects)\b` (any reference) and `(?:project|findProject)\s*\([^)]*\)\s*\??\.`.

**N2 (r6 N2 only partly fixed): `findProject(":core")?.let { implementation(it) }` is still dropped.**
- `:770` now classifies `findProject('…')?.let {` as a configuration opener, so r5/r6 DYN5 and V9 (the app's only edge) still give `ok` `[CartTest]`. The repair fixed only the `findProject(":core")!!` form the new test covers. Rare (optional modules), non-blocking. Fix: count a `findProject(…)?.let {` opener as an edge to that path in a non-root build file (root keeps OC3 precise), or as an unreadable call when it appears inside a `dependencies {` block.

**N3 (regression, low realism): Groovy `implementation project(':core') { transitive = false }` is now read as a configuration opener and the edge is dropped** (V10; r6 read it as an edge). In Groovy the closure binds to `project(path, closure)` so this form rarely builds cleanly in practice, hence non-blocking. Fix: only treat `project(…) {` as an opener at statement position (preceded by line start, `{`, `}` or `;`).

### NOTES

1. The `.@.` root entry no longer appears for config-only roots (OC2, OCf1) — a small precision improvement.
2. `edgesUnknown` is graph-global: a single root with a cross-project dependency widens every module. This is the intended fail-closed behaviour and does not affect ordinary builds (OC1–OC6).

## Commands and counts

All from the worktree root with `"C:\Program Files\nodejs\node.exe" .\node_modules\tsx\dist\cli.mjs --test --test-concurrency=1 <file>`.
- sha256 of both changed files = controller repair 3 values.
- `review-scratch-t5-r7\probes-r7.test.mts`: 3/3 (log-only), 29 PROBE lines.
- Same probes against r6 copy: 3/3, 29 PROBE lines; diff = V1–V6, V12 fixed; V8 root entry; V10, CM1–CM5 regressed; OC2/CM7 intended.
- Re-runs: r6 2/2 (28), r5 6/6 (106), r4 6/6 (75); diffs as above.
- Prove-red (`--test-name-pattern="R6-B1"` in `wt\`): baseline 1/0; X 0/1 (`:1040`); M 0/1 (`:1050`); restored 1/0, `cmp` IDENTICAL. Worktree sha `b4099ac6…6fea` before and after; `git status` 18 entries.

## Verdict

R6-B1 is fixed for every requested shape, and realistic Android, Spring and plain multi-project roots stay precise (OA-12 holds). But the comment-stripping half of the repair is not string-aware and now hides real edges behind ordinary glob/URL strings — a new false-narrow `ok` regression (R7-B1).

T5 REVIEW r7 — REPAIR REQUIRED — 1 blocking
