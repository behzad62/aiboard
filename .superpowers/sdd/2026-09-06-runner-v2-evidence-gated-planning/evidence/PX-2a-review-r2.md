# PX-2a independent review, round 2

- Reviewer: independent fresh-context reviewer (did not write PX-2a, did not do round 1)
- Model: Sonnet 5.5 (claude-sonnet-5-5), extra-high effort
- Date: 2026-09-30
- Packet: PX-2a (Runner V2, lane C), repair commit `5d6e6540` ("wip(px-2a-r1)", branch HEAD of `codex/runner-v2-px1`). Original PX-2a is `7a1703e2`. PX-2b `e8eb8720`, PX-2c `cd475d57` and PX-2t text fix `abeb6d7e` lie between them and were not judged here (only used as A/B references).
- Inputs: round 1 review `PX-2a-review-r1.md`; repair brief `px2a-repair1-muse.txt`; worker evidence `PX-2a.md` ("Repair cycle 1"); original brief `px2a-brief-muse.txt`; the diff `git show 5d6e6540`; the combined PX-2a result at HEAD.
- Repo effects of this review: this file only. No source or test file edited, staged, committed, stashed or pushed. No scratch git worktree created. Nothing named node_modules touched. Probe copies of `runner-v2` were plain exports in the system temp dir (no node_modules inside) and were removed. Kept in the session scratchpad for reproduction: `scratchpad\px2ar2\{common.mts, exploitA.mts, exploitB.mts, mutate.mjs}`.
- Leftovers not mine to clean: `%TEMP%\aiboard-px2a-evil-*` (the speed test leaks one per run, see N-r2-4) and the worker's `aiboard-px2a-dbg*`.

sha256 of changed files at HEAD `5d6e6540` (git blob content, LF). The worktree copies of the two `src` files are CRLF (autocrlf); their sha256 `c931ef2e…` (host) and `3ab114c2…` (ps1) match the worker's "pristine" values, and `81d67faf…`, `52448e10…` for the two tests are the worker's too.

| File | sha256 (blob) |
|---|---|
| runner-v2/src/windows-job-process-host.ts | `be44561b30258a32d7ed2a13836033900ed13a8ae3e554a287f3019bcff527b8` |
| runner-v2/src/managed-process-job-host.ps1 | `fffaa75754b6a76c42d908c231638a252896f9cfded532de7e9b0e7afdeba1a2` |
| runner-v2/src/managed-process-supervisor.mjs (not changed by the repair) | `1006fad3f1938f78724c9dc2a25cf34ca25e4aa280c5f84ee8c72fd22d59d93b` |
| runner-v2/test/windows-job-launch-speed.test.ts | `81d67fafb0893f56e879b2e59cd9c984f508a09e53e5fc3e8f2af384b9c2bd6b` |
| runner-v2/test/task8-raw-launch-closure.test.ts | `67933281a018f0b57e829233057cb37de5d859c9f4da706ed783614df831931e` |
| runner-v2/test/windows-job-real-host-guarantees.test.ts (changed only by `abeb6d7e`, not by the repair) | `03c904af6dfab5bf10ee12f5412a31c09432e2af2bf7a55484877c4c9763402f` |
| .superpowers/sdd/.../evidence/PX-2a.md | `948b4de2a48061d2957fc4a1f5c9cae4d0b8d8ee9e6d8d86c72066f57a8e9a32` |

**Verdict: REPAIR — 1 blocking**

B1 and B2 from round 1 are fixed. The trust anchor is fixed for the exact shape I exploited in round 1. But the worker's new "self-heal on a deleted DLL" path re-opens the same exploit in a different shape. A contained full-profile command deletes the DLL, races the runner's recompile, and its bytes get blessed. I reproduced it 5 out of 5 times. The un-jobbed Job host then loads attacker code. The fix is small (stop recompiling in place). Everything else in the packet holds.

## r1 findings status

| r1 # | Topic | Status | Evidence |
|---|---|---|---|
| B1 | task8-raw-launch-closure red | **RESOLVED** | Compile is async `spawn`, inside `compileJobHostHelperAssembly` in `windows-job-process-host.ts`. One allowlist line added (with reason). At HEAD the test is still red, but only on 5 PX-2c violations, none from PX-2a (item 1). |
| B2 | T1 watched csc machine-wide | **RESOLVED** | T1 has no process watching; it reads the per-call helper event. 15/15 at concurrency 4, twice, once under a csc noise loop (item 2). |
| N1 | Trust anchor (DLL plus record swap) | **PARTIAL** | The exact round-1 shape never loads (item 3, exploit A). The deleted-DLL self-heal path lets an attacker choose the compile moment and win the race (new finding R2-B1). |
| N2 | `ensure` can throw, orphan supervisor | **RESOLVED** | Total function; helper resolved before the supervisor is spawned (item 4). |
| N3 | Concurrent first compile, sticky null, no self-heal | **RESOLVED** as reported (single in-flight compile, failures not cached). The self-heal it added is R2-B1. |
| N4 | `spawnSync` compile on event loop | **RESOLVED** | Async `spawn`; one compile per runner process. |
| N5 | Missing type is not a fallback | **RESOLVED** | ps1 checks the type; direct test T7 pins `missing-type`. |
| N6 | Curly-quote path bug | **RESOLVED** | Path is a plain argv string; injection-shaped and curly-quote paths compile and execute nothing. (Bracket paths fall back, see N-r2-2.) |
| N7 | Swap windows in the compile | **PARTIAL** | Source now goes over a private stdin pipe; output dir is private per process. Two windows remain reachable only through the heal trigger (DLL, wrapper file). Same fix as R2-B1 closes them. |
| N8 | Trailing `\r` in extracted source | **RESOLVED** | 30082 chars on the CRLF checkout, does not end in `\r`. |
| N9 | Watcher leaks its stop dir | **RESOLVED** | `rmSync` is in `finally`. (A different leak exists, N-r2-4.) |
| N10 | Fallback reason invisible | **PARTIAL, by design** | Runner logs once per state dir when the helper is unavailable (reason is always the fixed text `no-helper-config`). Per-call tamper reasons stay in `job-events.jsonl`. Documented by the worker. Accepted. |
| N11 | Old generation dirs never pruned | **RESOLVED** | Other digest dirs pruned; per-process dir removed on `exit` (no `aiboard-job-host-assembly-*` left in `%TEMP%` after my runs). |

## New findings

| # | Sev | Finding | Location | Evidence | Expected | Actual | Fix |
|---|---|---|---|---|---|---|---|
| R2-B1 | **Blocking** | Self-heal on a deleted or emptied DLL re-blesses attacker bytes. A contained command chooses the moment of the recompile and overwrites the fresh DLL before the runner hashes it. | `windows-job-process-host.ts` `ensureJobHostHelperAssembly` (the `if (jobHostHelperReady) { … existsSync … byteLength > 0 … }` block, then `compileJobHostHelperAssembly`: `rmSync(dllPath)`, spawn, `readFileSync(dllPath)`, hash) | Exploit B, real host, profile `full`, 5 of 5 runs won (3 plain runs plus 2 runs that also tracked the impact). Steps: (1) warm call compiles the helper; (2) a long-lived contained `node -e` deletes the DLL at the known path (it listed `%TEMP%` in exploit A; path is `aiboard-job-host-assembly-<rand>\<digest>\ManagedProcessJobHost.dll`), then spins on `existsSync(dll)` and calls `writeFileSync(dll, evilBytes)` the moment it appears; (3) 2.5 s later a second call launches, the runner recompiles, and the attacker's write lands `lagMs=1` after the file appears, before the runner reads it back to hash. Result: trigger call helper event `mode=precompiled reason=null`; the next call `precompiled/null`; the evil DLL (a copy of the real source plus a static constructor that appends to a marker file) wrote `EVIL-LOADED in powershell pid=…` from the Job host process (`powershell`, outside the Job) on both calls. The next call's cleanup was `verified_empty`, so no signal reached the runner. | A replaced DLL never loads, whatever the attacker does (the goal of the repair, and r1 judge item 3). The digest must not be re-derived from bytes an agent-run command can write. | The pin is only as good as the moment it is taken. Recompiling in place, at a known path, on a condition the attacker controls (delete or empty the file), hands the attacker that moment. The worker's evidence calls this "fail-open to a fresh trusted compile"; it is not trusted. | Do not recompile in place on a missing or emptied DLL. Simplest (Option A, validated below): if `jobHostHelperReady` is set, return it as is. A vanished file then makes the Job host fall back with `missing-file` for the rest of the runner life (a warn-once log is enough). Failed compiles (no DLL existed) still heal, because they are not attacker-triggerable. Option C (stronger): keep the DLL bytes in runner memory and pass them base64 over the private stdin config; nothing on disk is trusted at all. |

Why this is blocking, not a residual. r1 accepted N1 as non-blocking because the DLL had the same exposure as the `.ps1` on disk. That parity holds only while the pin holds. PX-2a moves trusted code from the runner's source dir (which an installer can protect) into user-writable `%TEMP%`. The digest pin is what restores parity. This path lets a contained command defeat the pin in one tight loop. It matters wherever the source dir is protected and `%TEMP%` is not. The controller's brief said "the replacement must never load". It does load.

Validation of the proposed fix. On a plain export of HEAD in `%TEMP%` I replaced the whole heal block with `return jobHostHelperReady;` and re-ran exploit B twice. Both runs: trigger call and next call `fallback` / `missing-file`, attacker `wrote=no` (the file never reappeared), no marker, calls still succeed. Exploit A also stays safe. So Option A closes it. The only test that must change is T8 (below). The copy was deleted.

| # | Sev | Finding | Detail |
|---|---|---|---|
| N-r2-1 | Low | T8 pins the vulnerable behavior, and its `finally` hides the primary failure. | T8 "a deleted assembly file self-heals through recompile" asserts `precompiled` after deletion; with R2-B1 fixed it must assert `fallback` / `missing-file` and no recompile. Its `finally` calls `locateHelperAssembly()`, which asserts the file exists. In my prove-red M6 the visible message was "helper assembly must exist" (the `finally` throw) instead of the real mode assertion. Move the recovery out of `finally` or do not assert there. |
| N-r2-2 | Low, info | A TEMP path with `[` or `]` disables the fast path. | `Add-Type -OutputAssembly` treats brackets as wildcards. The wrapper prints an error but exits 0; the runner finds no DLL and returns null (fallback, warn once). Safe. `[WildcardPattern]::Escape($args[0])` in the wrapper would fix it. Non-Latin TEMP (CJK, Cyrillic) also returned null in my probe, but that comes from `TEMP` itself (csc temp files); a direct compile to a CJK output path works, and the baseline Add-Type has the same TEMP limit. Not a regression. |
| N-r2-3 | Low | Compile timeout 120 s sits on the launch critical path. | A hung compile (AV, load) delays the first launch and every concurrent launch (they share the flight) by up to 120 s, then falls back. Before, the same 120 s blocked the whole event loop, so this is better. Consider 30 s. |
| N-r2-4 | Nit | The speed test leaks `%TEMP%\aiboard-px2a-evil-*` (one per run; at least 10 present). `evilAssembly()` never removes its dir. Also `resetJobHostHelperAssemblyForTests` adds one `process.once("exit")` listener per call (Node warns after 11; test-only). |
| N-r2-5 | Nit | T2 and T9 still watch `csc`/`cvtres` machine-wide, but only assert "at least one compiler seen". Other suites' compilers can only help them, so they cannot false-red like the old T1. |
| N-r2-6 | Info | No tests for N8 (CR strip), N10 (once-per-state-dir log), N11 (prune, exit cleanup). T6 checks that no records are written but does not launch a real call under a bad TEMP. I did that by probe (item 4). |
| N-r2-7 | Info, outside PX-2a | A PX-2b test is flaky: `px2b: fused fence upgrade is durable across host instances` fails with `process_control_unavailable ... not verified terminal` at `releaseOwned` (`windows-job-fence-effects.test.ts:212`). Whole-file runs at HEAD: 2 of 7 red; the single test alone: 8 of 8 green. A/B at the exported PX-2b commit `e8eb8720`: 3 of 4 whole-file runs red. So it is a pre-existing PX-2b race (the test releases right after launching `process.exit(0)` without waiting for terminal), not caused by the repair. Forward to the PX-2b review. |

## Judge items

**1. B1 (compile allowlist).**
- The compile is `spawn` (async), inside `compileJobHostHelperAssembly` in `windows-job-process-host.ts`, the same module as the Job-host launch. No `spawnSync` remains in that path.
- `git diff 5d6e6540~1 5d6e6540 -- task8-raw-launch-closure.test.ts` is exactly one added line: file `windows-job-process-host.ts`, container `compileJobHostHelperAssembly`, kinds `powershell-script-launcher, powershell-launcher, child-process-spawn`, reason "runner-internal one-time helper compile beside the Job host launch". The module-level `.ps1` constant is gone.
- The test at HEAD is red on exactly 5 violations. `git blame` puts every line on `cd475d57` (PX-2c):
  - `managed-process-supervisor.mjs:384 retireSpare member-kill backend?.kill`
  - `windows-job-process-host.ts:397 <module> process-kill process.kill`
  - `:528 retireSpare member-kill entry.launcher.kill`
  - `:556 startSpare child-process-spawn spawn`
  - `:798 sweepRetiredSpareRecords process-kill process.kill`
- None comes from PX-2a. Proof the new entry is exact and live: a scratch copy of the test with those five PX-2c entries added passes both tests, including the stale-rule check. (Copy kept outside the repo, deleted.)

**2. B2 (parallel safety).**
- T1 (`windows-job-launch-speed.test.ts`) now runs a warm call, then three calls, and asserts each call's helper event is `precompiled` with reason `null`. No process watching.
- `--test-concurrency=4` with `windows-job-supervisor-input` and `windows-job-output-replay`: 15/15 pass, twice. The second run had a loop compiling with `Add-Type` next to it (17 of 30 polls saw `csc`/`cvtres`). The round-1 T1 (machine-wide watch) would be expected to go red under that noise; I did not re-run it.

**3. Trust anchor.**
- Compile once per runner process: one `jobHostHelperReady`, shared in-flight promise. 8 concurrent callers gave 1 compile process, the same path and digest for all, and the 9th call returned the same object.
- Digest only in memory: `grep` finds no `.sha256` read or write in `runner-v2/src`. The digest travels in the supervisor stdin config (`managed-process-supervisor.mjs:304,494`, `windows-job-process-host.ts:473,601`). A legacy `.sha256` record beside an intact DLL is ignored (T3, prove-red M3).
- Fresh path per process: `mkdtempSync(tmpdir()/aiboard-job-host-assembly-XXXXXX)`, then `<sourceDigest>/`. Note it is unpredictable but not hidden: a contained command lists `%TEMP%` and finds it (my exploit A did).
- Source to the compiler over a private stdin pipe (base64 line); the wrapper is a fixed string. The DLL path is a plain argv string. Probe: TEMP subdirs named `dollar$(Set-Content -Path INJ1.txt …)x`, `q';Set-Content INJ2.txt 1;'q`, and `curly’;Set-Content INJ3.txt 1;’x` all compiled and no marker file appeared. Also fine: space, `'`, curly quotes, backtick, `;`, `&`, `%`, `#@!=,`, braces, `^`, leading dash, `é`, `€`. Brackets fall back (N-r2-2).
- Exploit A (round-1 shape), real host, `full`: a contained `node -e` listed `%TEMP%`, replaced the DLL with the evil DLL and wrote `ManagedProcessJobHost.dll.sha256` plus `digest.txt` beside it. Next call and third call: `fallback` / `digest-mismatch`, no marker. The replacement never loads.
- Exploit B (delete plus race): **loads, see R2-B1.**
- Failed compile not cached: with `PATH` broken the call returned `null` without throwing; after `PATH` was restored the next call compiled. Empty state and a missing DLL heal (that part is the R2-B1 trigger).
- In-flight sharing: yes (above). Self-heal after deletion: works, and that is the problem.

**4. N2, missing type, N3-N11.**
- `ensureJobHostHelperAssembly` never throws: unusable TEMP (file instead of dir) and broken `PATH` both returned `null`.
- Real launch under an unusable TEMP (set in the runner process, inherited by the Job host): the call is rejected with `Process launch was not proven` (the fallback `Add-Type` also needs TEMP, the same as the baseline). The record is `stopped`, no supervisor alive after 1.5 s, one runner warn line, and the next call after restoring TEMP works. No orphan, no `running` record.
- Missing type / garbage bytes / missing file: direct tests exit 0, run the command, and record `missing-type` / `load-error` / `missing-file`. Truncated file records `digest-mismatch` (T9).
- N3-N11: see the status table.

**5. Per-call semantics.**
- C# body byte-identical: the extracted here-string has the same sha256 prefix `7246389f05043aa0` at the parent `cb567e62`, at `7a1703e2` and at HEAD.
- `git diff cb567e62 HEAD` on the ps1 adds only `Initialize-JobHostType` and its two call sites (the here-string now sits in `$jobHostCsSource`). Suspended create, assign, resume, kill-on-close and every proof are untouched.
- Keep-alive fix is present (`agent: false`, `Connection: close`, `windows-job-process-host.ts:1384`); T4 green.
- `static-adapter-policy`, `package-parity`, `one-shot-command-routing-static`, `git-caller-routing`, `managed-backend-boundary`: 23/23.

**6. Tests and prove-reds.** Each fault applied to a plain export of HEAD in `%TEMP%`, restored from a pristine copy, sha256 verified equal after (host `c931ef2e…`, ps1 `3ab114c2…`).

| Test | Fault | Red result |
|---|---|---|
| T1 | host extraction marker broken | `call 0 must load the precompiled helper` |
| T2, T5, T9 | host vouches for the live file's bytes (pin defeated) | all three red: tampered bytes loaded (`Unable to find an entry point named 'SetInformationJobO…ject'`), `replacement reason must be recorded`, `truncation reason must be recorded` |
| T3 | host prefers an on-disk `.sha256` record | `a stray on-disk record must not divert the call to fallback` |
| T6 | `ensure` and compile rethrow | `ENOENT … mkdtemp …aiboard-px2a-badtemp-…` |
| T7 | ps1 type check `if ($false)` | `valid assembly without the type must fall back, not exit 1` |
| T8 | heal check removed | red, but with the masked message (N-r2-1) |

All meaningful. None of them covers R2-B1 (T8 pins the opposite).

Green results at HEAD (`NODE_TEST_CONTEXT` unset):
- `windows-job-launch-speed`: 9/9 (concurrency 1), 15/15 twice at concurrency 4 with the two neighbours.
- `windows-job-real-host-guarantees`: 12/12.
- `windows-job-spare-host` (PX-2c): 9/9. `windows-job-fence-effects` (PX-2b): 14/14 in 5 of 7 whole-file runs at HEAD, one flaky test (N-r2-7).
- `windows-process-backend`, `one-shot-command-family-production-matrix`, `execution-host`, `subprocess-runtime`, `durable-process-store` at concurrency 4: 222 tests, 221 pass, 0 fail, 1 skip (pre-existing).
- `tsc --noEmit -p runner-v2/tsconfig.json` clean; eslint on the three changed TS files clean; `git diff --check` clean.
- `task8-raw-launch-closure`: red on the 5 PX-2c lines only (item 1).

## Follow-up list

1. **Blocking (R2-B1):** stop recompiling in place on a missing or emptied DLL (Option A, validated), or pass the bytes over stdin (Option C). Invert T8 to "deleted DLL gives `fallback` / `missing-file`, the call still works, the file is not recreated". Add a regression test that replays exploit B: a long-lived contained `node -e` deletes the DLL then spins on `existsSync` and overwrites it; a second call launches meanwhile. Assert no evil marker and never `precompiled` with the evil bytes. Fix N-r2-1 while there. Prove-red it against the current heal block (it must go red there).
2. Optional hardening in the same pass: escape brackets in the wrapper path (N-r2-2), shorten the compile timeout (N-r2-3), remove the `aiboard-px2a-evil-*` leak (N-r2-4).
3. PX-2b review: the flaky `px2b: fused fence upgrade is durable across host instances` (N-r2-7). It is not a PX-2a defect.
4. PX-2c review: the five `task8-raw-launch-closure` violations at HEAD belong to PX-2c and need the controller's allowlist decision there.
5. Residual to record, not to fix here: a same-user process that survives a previous runner and watches `%TEMP%` can still race a runner's first compile, and the `.ps1` in the source dir is same-user writable. The pin cannot fix either; docs already say Job containment is lifecycle containment, not confinement.
6. Interactive/LSP wall-clock gain is still unmeasured (unchanged from round 1).

**Verdict: REPAIR — 1 blocking**
