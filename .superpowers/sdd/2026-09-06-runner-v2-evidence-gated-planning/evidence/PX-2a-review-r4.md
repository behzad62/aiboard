# PX-2a independent review, round 4 (targeted)

- Reviewer: independent fresh-context reviewer (did not write PX-2a or the repair, did not do rounds 1-3)
- Model: Sonnet 5.5 (claude-sonnet-5-5), extra-high effort
- Date: 2026-09-30
- Packet: PX-2a (Runner V2, lane C), controller repair 3: commit `241d5f64` (code and tests) and `f1ed5d2b` (evidence "Repair cycle 3").
- Inputs: round 3 review `PX-2a-review-r3.md` (finding R3-B1); `git show 241d5f64`; evidence `PX-2a.md` at `f1ed5d2b`; the round-3 probe scripts (copied and retargeted, originals untouched).
- Where I ran things: a detached scratch worktree at `241d5f64` at `C:\Users\b_a_s\AppData\Local\Temp\px2ar4\wt` with a node_modules junction. The px1 worktree was not touched. No source or test file was edited in any checkout. The positive controls and the prove-reds ran on plain `git archive` exports (`ctl` at `1daf1b89`, `red` at `241d5f64`) in the same temp folder. Probes are in the session scratchpad `px2ar4\`.
- Repo effects of this review: this file only.

sha256 of files at `241d5f64` (git blob content, LF; the CRLF checkout hash is in brackets where it differs):

| File | sha256 (blob) |
|---|---|
| runner-v2/src/windows-job-process-host.ts | `ad4ce429d2eb2124bac5c01300a1479f959388548874db4ee118eecfca299cc8` [checkout `d3bce3b48fa723b8439a9a4d803fc6c7eb76cedf88b4500ccfe3d2c7180074c1`] |
| runner-v2/test/windows-job-launch-speed.test.ts | `0e19e083495da79c9eaf4cda97fed4fa1cb185df695c6ce723b03ecb81ba224b` [checkout `26f5b2f48475717c96bb97de2665ca8a9899f2b9eabac2009bb3fe3f4ef95799`] |
| .superpowers/sdd/.../evidence/PX-2a.md (at `f1ed5d2b`) | `1516062b3c045c358215d452cde379361b66a2516bd6146eceb1167ed57eb4f2` |
| runner-v2/src/managed-process-job-host.ps1 (not changed by repair 3) | `fffaa75754b6a76c42d908c231638a252896f9cfded532de7e9b0e7afdeba1a2` |
| runner-v2/src/managed-process-supervisor.mjs (not changed by repair 3) | `f82a6f68bd5faaee402706ed9eb6483fb8cdac7afb65079f2a0b822d2bccffe2` |
| runner-v2/test/task8-raw-launch-closure.test.ts (not changed) | `3d46774ce74af21e525de3a170480e5c49309323cb72f6012be091684268fad1` |
| runner-v2/test/windows-job-real-host-guarantees.test.ts (not changed) | `d1b0644d80b831177faa4a2e6b8f010defb0c2745addc0e3497ab3d8cedb9dc7` |

The repair diff (`git show 241d5f64`) touches only the host file, the speed test file, and adds the round-3 review file. The ps1 is byte-identical to round 3.

**Verdict: ACCEPT**

R3-B1 is fixed. The runner now compiles at most once per process in every path. A failed compile is remembered, so no later call recompiles into the per-process directory. My probes could not pin or load attacker bytes on any path, and the same probes win against `1daf1b89`. No blocking issue found.

## Findings

No blocking findings. Non-blocking notes are in the follow-ups.

## Judge items

**1. Round-3 probes D and D2, and the round-1 and round-2 exploits, against `241d5f64`.**
- Probe D (first compile fails, retry raced): 3 of 3 runs, first compile null, retry null.
- D4, my stronger copy of D. It counts the attacker's writes, keeps the attacker alive through the retry, then runs one sequential and two concurrent real calls: 3 of 3 runs. Retry is null, all three real calls are `fallback` / `no-helper-config` and print their output, the marker never appears. The attacker did own the file (`dll on disk == evil: true`), so the negative result is not vacuous.
- Positive control on `1daf1b89` (plain export): D4 wins 2 of 2 (`retry PINNED`, `attackerBytes=true`, calls `precompiled`, marker written). So the harness sees a real load.
- D2b, bracket TEMP. It replaces D2, which cannot run against the fix because no generation folder exists any more. The attacker computes the public digest folder name, plants the DLL and keeps overwriting it. Fix: 3 of 3 runs, call 1 null (skip), call 2 null, two real calls under the bracket TEMP are `fallback` / `no-helper-config` with output, no marker. Positive control on `1daf1b89`: wins 1 of 1 (pinned attacker bytes, calls `precompiled`, marker written).
- Round-2 exploit B (delete, then race the recompile): 3 of 3, trigger and next call `fallback` / `missing-file`, attacker `wrote=no`, no marker.
- Round-2 variant C (empty the DLL, overwrite in a loop, sequential and concurrent calls): 2 of 2, every call `fallback` / `digest-mismatch`, pin object unchanged, marker absent.
- Round-1 exploit A (replace the DLL and write four digest-record names): 2 of 2, next and third call `fallback` / `digest-mismatch`, marker absent, pin unchanged.
- Every call succeeded and printed its output, through the fallback.

**2. At most one compile attempt per runner process, in every path.**
- Code reading: `ensureJobHostHelperAssembly` returns on `jobHostHelperReady !== undefined` (an assembly or null), shares the in-flight promise, and records the outcome of the one attempt in `jobHostHelperReady = assembly` (assembly or null). The outer `catch` also records null. `compileJobHostHelperAssembly` has one call site (`ensure`); `ensure` has two production call sites (`launchOwned`, `startSpare`); `resetJobHostHelperAssemblyForTests` has no production caller (repo-wide grep). A caller arriving between flight completion and the first caller's continuation still sees the flight, because the `finally` clears it only after `jobHostHelperReady` is set.
- Measured (`onceprobe.mts`, wrapper-file mtime as the attempt counter, plus dirs created): (a) compile fails after the folder exists (PATH broken): 6 concurrent callers then 5 later calls, all null, 1 dir, wrapper mtime unchanged. (b) `mkdtemp` throws (TEMP is a file), then good TEMP: 4 concurrent plus 2 later, all null, 0 dirs created in the real TEMP. (c) success: 6 concurrent plus 5 later, one object, 1 dir, mtime unchanged. (d) wildcard skip: 6 concurrent plus later plus after TEMP restored, all null, no wrapper written. The same probe on `1daf1b89` shows the retries (a: mtime changed, all-null false; b: a new dir in the real TEMP; d: wrapper written), so the counter can see a retry.
- Nothing re-reads or re-trusts a file after the pin. After the pin `ensure` returns the stored object with no disk access. The DLL bytes are read in the compile (before the pin) and in the Job host (`ReadAllBytes`, hash, `Assembly.Load(bytes)`, one read). The supervisor only passes path and digest through (`managed-process-supervisor.mjs` lines 321-322 and 515-516). The digest is memory-only: the generation folder holds only the DLL and the wrapper.

**3. Bracket TEMP handling.**
- Claim measured on Windows PowerShell 5.1.19041.6456 with the wrapper's own `Add-Type -OutputAssembly` shape:
  - plain path: compiles.
  - `br[1]` unescaped: `Cannot set output assembly. The path ... did not resolve to a single file.`
  - `[WildcardPattern]::Escape(path)`: `Error generating Win32 resource: The system cannot find the path specified.` (the escaped text goes to csc).
  - double-escaped: `did not resolve to a single file` with the doubled backtick text.
  - Confirmed for absolute paths, escaped or not.
- Nuance, not a defect: a relative path with the PowerShell location set inside the bracket folder (`Set-Location -LiteralPath`, then `.\a.dll`, `-Command` shape) did compile. With the real wrapper shape (`-File`, spawn `cwd` inside, relative or bare name) it failed with `Access is denied`. So "cannot compile" is true for the shape the runner uses; a different wrapper might keep the fast path (follow-up 2).
- Regex `/[[\]*?`]/`. PowerShell wildcard characters are `*`, `?`, `[`, `]` (backtick is the escape). `*` and `?` cannot occur in a Windows path, so the class over-covers. Only the TEMP prefix can carry them: `mkdtemp` adds six alphanumeric characters, the digest folder is hex, the DLL name is fixed. So the tested string covers the whole path.
- Character sweep through the real `ensureJobHostHelperAssembly` with TEMP set to a folder whose name holds each character (29 names, `charsweep.mts`): space, `'`, `$`, `&`, `;`, `,`, `(`, `)`, `{`, `}`, `%`, `#`, `@`, `!`, `^`, `=`, `+`, `~`, `$(calc)`, `é`, curly single and double quotes, `.`: compiled and pinned, digest matches the file. `` ` ``, `[`, `]`, `[x]`, `[1]`: null at once, no wrapper written (skip). `Ж`, `中` and an emoji: compile attempted and failed, null, remembered. So no other wildcard character passes the regex, and every non-skipped failure ends in the same remembered fallback. Not a bypass: a compile that fails returns null, and nothing is retried.
- Backtick: unescaped it compiled fine in my direct test, so the regex is over-cautious there. Safe, and it costs the fast path on a backtick TEMP only.

**4. Tests and prove-reds.**
- T6 tail: after the unusable-TEMP null it restores TEMP and asserts two more `ensure` calls are null, then a real call falls back (`fallback` / `no-helper-config`, output printed, supervisor exits), then the test-only reset returns the fast path (`precompiled`, reason null). Meaningful: a retry with a good TEMP would pin a new assembly, so the assertion is red for any retry, in the same directory or a fresh one.
- Bracket test: no wrapper written, `ensure` null, second call null, cleans up (0 `aiboard-px2a-br*` dirs left). The wrapper's absence is a sound proxy (the wrapper is written immediately before the spawn).
- Prove-red 1 (`if (jobHostHelperReady !== undefined)` to `if (jobHostHelperReady)`): T6 red on `a failed compile must never be retried in place`, actual was a pinned assembly, expected null. The bracket test stays green. Restored, host hash `d3bce3b4...74c1` before and after.
- Prove-red 2 (mine, the old assignment `if (assembly) jobHostHelperReady = assembly;`): T6 red on the same assertion, restored byte-exact.
- Prove-red 3 (wildcard skip line replaced by a comment): the bracket test red on `no compile may be attempted for a wildcard path (found: ...compile-helper-wrapper.ps1)`. `helper === null` still passed, so the red is for the stated reason. T6 stays green. Restored byte-exact.
- Weaknesses in the tests, both nits (follow-up 3): the bracket test's second `ensure` call cannot tell "remembered" from "skipped again", since the regex skips again either way (T6 carries the remembering); and neither test drives a real call under a bracket TEMP (my D2b did, 3 of 3 fallback).

**5. Suites (scratch worktree at `241d5f64`, `NODE_TEST_CONTEXT` unset, machine at about 76 percent CPU).**
- `windows-job-launch-speed.test.ts`, concurrency 1: 11/11.
- The same file at `--test-concurrency=4` with `windows-job-supervisor-input` and `windows-job-output-replay`: 17/17.
- `windows-job-real-host-guarantees.test.ts`: 12/12.
- `task8-raw-launch-closure.test.ts`: 2/2 (green; the five PX-2c lines from round 3 are gone at this commit).
- `tsc --noEmit -p runner-v2/tsconfig.json`: exit 0. `eslint` on the two changed TS files: exit 0. `git diff --check 241d5f64~1 241d5f64 -- runner-v2`: clean.

## Follow-ups (none blocking)

1. Evidence wording. Earlier cycle sections of `PX-2a.md` still say "failures NOT cached (next call retries: N3 self-heal)" (line 172), "next call self-heals to precompiled" (204, 207), "Failed compiles ... still retry ... not attacker-triggerable" (299-300) and "Safe by construction" (353). The end-of-file "Evidence correction" supersedes them, but a strike-through note at those lines would stop a later reader quoting them. The two sha256 values in "Repair cycle 3" are on different bases (host is the CRLF checkout hash, test is the LF blob hash).
2. The "Limit" line names only wildcard characters. Measured here: a TEMP with non-Latin characters (`Ж`, `中`, emoji) also loses the fast path (compile fails, remembered). The old note "Non-Latin TEMP behaves the same as the pre-PX-2a baseline" is not accurate for the compile. These calls still work through the fallback. Optional: a bracket or non-Latin TEMP could keep the fast path with a different wrapper (for example `Set-Location -LiteralPath` then a relative output name, which compiled in my `-Command` test but not in the `-File` shape).
3. Optional test polish: a real call under a bracket TEMP that asserts `fallback` / `no-helper-config`; a PATH-broken variant of T6 that mirrors probe D (fail after the folder exists); and a strengthening of the bracket test's "remembered" assertion. The current tests already catch the natural regressions (prove-reds 1 to 3).
4. Carried, not from repair 3. N-r2-3: the 120 s compile timeout sits on the first call's critical path, and a timeout now also sets the fallback for the runner's lifetime. N-r2-4: `resetJobHostHelperAssemblyForTests` adds one `process.once("exit")` listener per call (test-only; Node warns after 11, seen in my sweep). A failure cause is not logged: the warn-once line always says `no-helper-config`, so a compile failure, a wildcard skip and a timeout look the same. Round 3 suggested logging once.
5. Residual, already in the evidence (line 364): a same-user process alive during the one compile can still race that compile. The remember-once rule stops a second chance; it does not remove the first. Closing it needs a different design (a protected precompiled asset).

## Cleanup

Junctions removed with `cmd /c rmdir` before any recursive delete (scratch worktree, `ctl`, `red`); links confirmed gone and `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6\node_modules\eslint` confirmed present; `git worktree remove --force` on the scratch worktree; my `px2ar4` temp folder and the `px2ar4-*` probe roots removed after a reparse-point scan. Temp counts: `aiboard-px2a-evil-*` 14 before, 14 after; `aiboard-job-host-assembly-*` 3 before, 2 after (none left by my runs). Probe scripts kept in the session scratchpad `px2ar4\` (`common.mts`, `exploitA.mts`, `exploitB2.mts`, `exploitC.mts`, `exploitD.mts`, `exploitD4.mts`, `exploitD2b.mts`, `onceprobe.mts`, `charsweep.mts`, `probeE.mts`, `relprobe.mts`, `wild.ps1`). `common.mts` reads the checkout path from `PX_WT` and defaults to `C:/Users/b_a_s/AppData/Local/Temp/px2ar4/wt`; recreate that worktree before reuse.

**Verdict: ACCEPT**
