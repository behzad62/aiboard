# T5 independent review — round 12, narrow (controller repair 8: R11-B1 + N2)

Reviewer: independent, fresh context, no shared memory with the controller session. I did not edit any source or test file and did not commit. This file is the only file I wrote in the repo (`git status --short` = 18 entries before and after, not counting this file).

Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6-t5`.
Scratch: `C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch-t5-r12\`.
- `wt\` is a byte-identical copy of `runner-v2/{package.json,src,test}` (`diff -rq` identical). `affected-tests.ts.bak` is a copy of the same source file.
- Probe history `probes-{r2,r2b,r3,r3b,r4..r11,r11b}.test.mts` was copied from `review-scratch-t5-r11\`.
- New in this round: `probes-r12.test.mts`, `probes-r12b.test.mts` (the same cases, with the escaping value used from `subprojects { dependencies { … } }`), `timing-r12.test.mts` and `mut.cjs` (prove-red mutations).
- Outputs:
  - `*.cur.out.txt`: the repair-8 tree;
  - `*.r7tree.out.txt`: the repair-7 tree, `review-scratch-t5-r11\wt`;
  - `diff-vs-repair7.txt` and `diff-vs-proto.txt`;
  - `pr12-*.txt`: prove-red.

## Scope

This round covers only the repair-8 changes to `readGradleProjectEdges` (`runner-v2/src/affected-tests.ts`). The diff against the repair-7 tree has exactly three hunks:
- `:872-876`: the cross test also runs on the statement head, `code.slice(stmtStart, min(i, stmtStart + WINDOW))`. This is R11-B1.
- `:907-912`: after a project call, whitespace including line breaks is skipped, bounded by `WINDOW`. This is part of N2.
- `:934-935`: `configureArgument` now accepts any element of a `configure(listOf(…))` or `configure([…])` list, via `[^{};]*`. This is the other part of N2.

It also covers the new test `R11: long cross-project openers fail closed; configure lists and Allman project blocks stay precise` (`runner-v2/test/affected-tests.test.ts:1245-1262`).

I also read `T5-review-r11.md` and `T5.md` "Controller repair 8 (after review r11)".

TEST-RUN RULE: I did not re-run the repair-8 suites. Hash check (before and after the review):

| File | Evidence sha256 | Tree | Match |
|---|---|---|---|
| `runner-v2/src/affected-tests.ts` | `00f2a968065c56e9b7cdebdf040a82a18ef5e88c3515f1ff139baf6be80c540f` | same | OK |
| `runner-v2/test/affected-tests.test.ts` | `9d18c463c1bcd6deb43545c76a9606701f9fbcc516911a4877c531f1c7e4f92f` | same | OK |

## R11-B1: verification — fixed

The statement-head check at `:875-876` is the r11 prototype's line. The prototype also had a `.replace(...)` that did nothing, and it is dropped here; that makes no difference, because `dependencies` is not a cross word.
- **L1** (Kotlin `configure(subprojects.filter {` with a 13-line, roughly 330-character condition), **L2** (Groovy Spring-style `configure(subprojects.findAll { ![…].contains(it.name) && … })`) and **B1h** (Kotlin `filter { it.path in listOf(…18 paths) }`) all fail closed now:
  - `edgesUnknown=true`;
  - with a core change, AppTest, CartTest and DataTest are all selected.
- On the repair-7 tree, all three were narrow (CartTest only).
- The new test covers both single-line long forms: a 40-name Groovy `findAll` and a Kotlin `filter { it.path in listOf(…) }`. It does not cover L1, the wrapped multi-line form. L1 is fixed by the same line and fails closed in the probes. See NOTE 1.

## Probe-history diff (repair-8 tree against the repair-7 tree and against the r11 prototype)

All commands were run from the worktree root: `"C:\Program Files\nodejs\node.exe" .\node_modules\tsx\dist\cli.mjs --test --test-concurrency=1 <file>`. For comparison I used the r11 reviewer's recorded `probes-*.cur.out.txt` (the repair-7 tree) and `probes-*.proto.out.txt` (the prototype). Only `PROBE` lines were compared.

| Probe | pass/fail | PROBE lines | Diff vs repair 7 | Diff vs r11 prototype | Changes |
|---|---|---|---|---|---|
| r2 | 15/0 | 100 | 8 | 12 | `ms` timing values only |
| r2b | 3/0 | 12 | 0 | 0 | — |
| r3 | 12/0 | 47 | 0 | 0 | — |
| r3b | 1/0 | 7 | 0 | 0 | — |
| r4 | 6/0 | 75 | 0 | 0 | — |
| r5 | 6/0 | 106 | 0 | 0 | — |
| r6 | 2/0 | 28 | 0 | 0 | — |
| r7 | 3/0 | 29 | 0 | 0 | — |
| r8 | 5/0 | 53 | 0 | 0 | — |
| r9 | 3/0 | 24 | 0 | 0 | — |
| r10 | 5/0 | 63 | 12 | 12 | `ms` timing values only |
| r11 | 3/0 | 115 | 14 | 12 | See the list below |
| r11b | 1/0 | 5 | 4 | 0 | L1, L2: narrow → fail-closed |

Changes in r11:
- B1h: narrow → fail-closed (the fix).
- O23, O24 and O25 (both the `[data]` and `[core]` rows): all modules → precise (N2).

Only the long-opener probes and the N2 shapes changed. Against the prototype, the only differences are the N2 rows (O23/O24/O25), which the prototype did not include. No ordinary-build probe from r2 to r11 widened or narrowed.

## N2 changes: adversarial probes (`probes-r12[b]`, repair-8 tree against the repair-7 tree)

`probes-r12` used `project(":app") { dependencies { "implementation"(p) } }` as the consumer of an escaping value. That form is itself `projectScoped` and therefore always fails closed, so it masks the escape. `probes-r12b` repeats the same cases with a neutral consumer, `subprojects { dependencies { "implementation"(p) } }`. The results below are from r12b; r12 agrees except where masked.

### `configure(listOf(…))` / `configure([…])` with `[^{};]*`

- **A neighbouring statement is not treated as benign.** Each of these fails closed on both trees:
  - E1 `configure(listOf(project(":data"))); val p = project(":core")` (one line);
  - E2, the Groovy `configure([project(':data')]); def p = project(':core')`;
  - E3 and E4, the newline-separated forms (`val p = …` and `ext.coreDep = …`);
  - E8 `configure(listOf(…)) { }; extra["core"] = project(":core")`.

  The reason: `;` at paren depth 0, or a non-continuing newline, resets `stmtStart`, so `before` no longer contains `configure(`. In addition, `[^{};]` cannot cross `;`, `{` or `}`.
- **Dependency manipulation in the same statement is still unknown.**
  - E5 `configure([project(':app')]).each { it.dependencies.add('implementation', project(':core')) }` fails closed: `before` contains `dependencies`, and `{` blocks the regex anyway.
  - E6 and E7, `configure([…]) { dependencies { implementation project(':core') } }`, fail closed: the dependencies block sits under a cross frame.
- **Root dependencies after a configure call are read correctly.** E10 (`configure([…]) ; dependencies { implementation project(':core') }`) and E11 (the newline-separated form) record the root → core edge.
- **A non-configure name is not accepted.** E12 `reconfigure(listOf(project(":core")))` fails closed, because `\b` does not match inside a word.
- **New narrowing, contrived:** a *non-configure call nested inside* the configure list argument is benign. See N1.
  - E14 `configure(listOf(project(":data"), coreHolder.set(project(":core")))) { }` and E9 `configure(listOf(project(":data")) + listOf(project(":core")).also { rootProject.extra["c"] = it.first() }) { }` were fail-closed on repair 7 and are narrow now.
  - E13 `val x = foo.configure(listOf(project(":core")))` and E15 `val t = configure(listOf(project(":core"))) { }` are narrow on both trees (pre-existing). In E13, `\b` matches after `.`.

### Skipping line breaks after a project call

- **The intended effects hold.**
  - O25, the Allman `project(':app')\n{`, is precise.
  - F7, Groovy `dependsOn project(':core')\n    .tasks.named('test')`, went from all modules to precise.
  - F8 is the in-dependencies form `implementation(project(":core")\n    .also { })`. It went from an edge to unknown. That is correct: inside dependencies, a dereferenced call is unknown.
  - F9, F10 and F12, ordinary multi-line Groovy dependency blocks (including a `{ transitive = false }` closure on the next line, and `}` on the next line), stay precise.
  - F11 (an Allman project block with a dependencies block inside) fails closed.
  - F4 (400 blank lines before `.also`) exceeds `WINDOW` and fails closed.
- **The regression: the escape-through-dereference residue (r11 N1) now extends to the multi-line form.** Each case below was fail-closed on repair 7 and is narrow now: a core change selects CartTest only and misses AppTest.
  - F1 `val p = project(":core")\n    .also { println(it.name) }`, consumed later.
  - F2 `val p = project(":core")\n{ }`.
  - F3 `val p = project(":core")\n\n  .let { it }`.
  - F6, Groovy `def p = project(':core')\n    .tasks`. This one is harmless: `p` is a `TaskContainer`.

  F1s, the same-line form, is narrow on both trees; it is the accepted r11 N1 residue. See N2.

## Speed (`timing-r11` and `timing-r12`, repair-7 tree → repair-8 tree, in ms)

- **Unchanged within noise** for every r11 timing row, including:

  | Case | Repair 7 | Repair 8 |
  |---|---|---|
  | S1 200k `a{` | 61 | 66 |
  | S5 80k `project(` | 51 | 32 |
  | S6 80k `findProject(':x'` in dependencies | 38 | 55 |
  | S9 200k `project()` | 86 | 93 |
  | M8 5.9 MB realistic | 663 | 633 |
  | M9 6.2 MB root | 533 | 564 |
  | M6, the known N4 nesting-depth case | 5249 | 5252 |
  | Build-logic B1–B5 | ≤ 66 | ≤ 67 |

  M5 measured 1795 on the first run and 1267 on a re-run. The repair-7 figure was 1266, so the first reading was noise.
- **New hostile inputs:**

  | Case | Repair 7 | Repair 8 |
  |---|---|---|
  | H1 200k `a{}` (statement head re-sliced per brace) | 165 | 246 |
  | H2 299-character head + 100k `{}` | 74 | 95 |
  | H3 `configure(listOf(` + 80k elements, one line | 98 | 94 |
  | H4 the same, one element per line | 70 | 68 |
  | H6 8k × (call + 299 newlines) | 914 | 871 |
  | H7 80k nested `configure([` | 37 | 41 |
  | H8 40k `configure([project(x){` | 1086 | 1073 |
  | H9 100k `(){}` after a 300-character head | 45 | 74 |
  | H10 40k `configure(listOf(project(x), <250 chars>` | 1193 | 1282 |
  | H5 80k × (`project(':x')` + 299 spaces), a 2.5 MB single line | 2908 | 3349 |

  H5 is the slowest case, but it is pre-existing: it is just as slow on repair 7. The `before` window of up to 300 characters is re-sliced and regex-tested for each call. The time grows linearly with input size.

  All added work is bounded by `WINDOW` per brace or call. There is no hang and no new superlinear case.

## Findings

### BLOCKING

None.

### NON-BLOCKING

- **N1 — `[^{};]*` accepts any nested call inside a configure list argument** (`affected-tests.ts:935`).
  - E14 `configure(listOf(project(":data"), coreHolder.set(project(":core")))) { }` and E9 (an `.also { extra[…] = … }` inside the argument) were fail-closed on repair 7 and are narrow now.
  - Both are contrived. A configure target list does not ordinarily hide a project value in a side-effecting call.
  - Minimal fix: allow only earlier *plain project elements* between the list opener and the call:

    ```ts
    /\bconfigure\s*\(\s*(?:(?:listOf\s*\(|\[)(?:\s*(?:project|findProject)\s*\(\s*(['"])[^'"\n]*\1\s*\)\s*(?:!!)?\s*,)*)?\s*$/
    ```

    This keeps O23/O24 precise and makes E9/E14 unknown. Optionally, also require `(?<![.\w])configure` so that E13 `foo.configure(listOf(…))` is not taken as Gradle's `configure`.
- **N2 — Skipping line breaks extends the accepted r11-N1 residue (escape through a dereference) to next-line forms** (`:907-913`, `:932`).
  - `val p = project(":core")\n    .also { … }` (F1), `\n.let { it }` (F3) and `\n{ }` (F2), each followed by `implementation(p)` from another block, were fail-closed on repair 7. They are narrow now.
  - This is not a new class: the same-line forms (F1s, r11 B2h/B2m) were already narrow and were accepted in `T5.md` as rare residue. Formatting a scope call onto the next line is common Kotlin style, but the underlying pattern is rare: binding a project to a variable through a scope function, then using it as a dependency.
  - Minimal fix (this also closes r11 N1): in the not-in-dependencies branch, when `before` ends in an assignment (`/(?:\b(?:val|var|def)\b[^=]*|[^=!<>])=\s*$/`), treat `opensBlock` and a dereference into a receiver-returning scope call (`.also`, `.apply`, `.let`, `.run`, `.with`, `.takeIf`, `.project`) as escaping. Keep property reads (`.version`, `.path`, `.name`, `.tasks`) benign.
  - T6/T8 should record this together with the existing residue.

### NOTES

1. The R11 test covers only the two single-line long openers. Adding the wrapped L1 form (`configure(subprojects.filter {\n …13 lines… \n}) {`) would pin the multi-line variant as well. It already fails closed in the `probes-r11b` L1 probe.
2. H5 (2.5 MB of `project(':x')` separated by 299 spaces, on one line) takes about 3 s on both trees. This is pre-existing and linear. It could be reduced by caching the last `before` regex results, but that is not required.
3. `probes-r12` (the `project(":app") { dependencies { … } }` consumer) shows that any escape consumed from a project-scoped block fails closed regardless. The narrowings above need a neutral consumer (`subprojects {}`), a module file, or `extra`.

## Prove-red (reproduced in `review-scratch-t5-r12\wt`, `--test-name-pattern="R11"`)

- Baseline: 1 test, 1 pass, 0 fail (`pr12-baseline.txt`).
- **A: statement-head cross check removed** (`:875-876` → `GRADLE_CROSS_PROJECT_OPENER.test(head),`). Result: **0 pass, 1 fail** (`pr12-red-A.txt`). The assertion at `affected-tests.test.ts:1252:12` fails on the long `configure(subprojects.findAll { ![…'excluded-module-0'…` opener: actual `undefined`, expected `true`.
- **B: configure list back to first-element-only** (the repair-7 regex, via `mut.cjs B`). Result: **0 pass, 1 fail** (`pr12-red-B.txt`). The assertion at `:1260:12` fails on `configure(listOf(project(":app"), project(":data"))) {`: actual `true`, expected `undefined`.
- **C: newline not skipped after a call** (spaces and tabs only, via `mut.cjs C`). Result: **0 pass, 1 fail** (`pr12-red-C.txt`). The assertion at `:1260:12` fails on `project(':app')\n{`.
- Restore: `cp` from the `.bak` after each mutation. `cmp` reports the file identical to the `.bak` and to the worktree file. The re-run gave 1/0 (`pr12-restored.txt`).
- All three match the evidence (0/1 each).

## Commands and counts

- `sha256sum` of both files: matches repair 8, before and after the review.
- Probe history, 13 files on the repair-8 tree: 0 failures.
  - pass counts: r2 15, r2b 3, r3 12, r3b 1, r4 6, r5 6, r6 2, r7 3, r8 5, r9 3, r10 5, r11 3, r11b 1.
  - PROBE line counts: 100, 12, 47, 7, 75, 106, 28, 29, 53, 24, 63, 115 and 5, in the same order.
  - PROBE diff lines against repair 7: r2 8 (timing), r10 12 (timing), r11 14, r11b 4; all others 0.
  - PROBE diff lines against the r11 prototype: r2 12 (timing), r10 12 (timing), r11 12 (O23/O24/O25 only); all others 0.
- `probes-r12`: 2/0, 28 PROBE lines. Differences from repair 7: E9, E14, F7, F8.
- `probes-r12b`: 2/0, 28 PROBE lines. Differences from repair 7: E9, E14, F1, F2, F3, F6, F7, F8.
- `timing-r11`: 1/0, 24 TIME lines on each tree, plus one re-run on repair 8. `timing-r12`: 1/0, 10 TIME lines on each tree.
- Prove-red: baseline 1/0, A 0/1, B 0/1, C 0/1, restored 1/0.
- Worktree: 18 status entries before and after. No file other than this review was written in the repo.

## Verdict

Repair 8 fixes R11-B1: L1, L2 and B1h fail closed, which matches the r11 prototype's effect on the whole r2–r11 probe history. It also makes O23/O24/O25 precise as intended. No ordinary-build probe changed.

The N2 regex does not treat a neighbouring statement, or a same-statement dependency manipulation, as benign. The newline skip is bounded, and hostile-input speed is unchanged.

Two narrowings remain, both non-blocking:
- a side-effecting call nested inside a configure list (contrived);
- the next-line form of the already-accepted dereference-escape residue.

Both have one-line fixes, listed above.

T5 REVIEW r12 — ACCEPT
