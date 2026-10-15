# PX-2a independent review, round 3 (targeted)

- Reviewer: independent fresh-context reviewer (did not write PX-2a, did not do rounds 1 or 2)
- Model: Sonnet 5.5 (claude-sonnet-5-5), extra-high effort
- Date: 2026-09-30
- Packet: PX-2a (Runner V2, lane C), repair commit `1daf1b89` ("wip(px-2a-r2)"), on top of `5d6e6540`.
- Inputs: round 2 review `PX-2a-review-r2.md`; repair brief `px2a-repair2-muse.txt`; worker evidence `PX-2a.md` ("Repair cycle 2"); `git show 1daf1b89`; the round-2 exploit scripts (copied and retargeted, originals untouched).
- Where I ran things: a detached scratch worktree at `1daf1b89` with a node_modules junction. The scratchpad path was too long for the checkout (Windows "Filename too long"), so I used `C:\Users\b_a_s\AppData\Local\Temp\pxr3\wt` instead. The px1 worktree was not touched. No source or test file was edited. One attempt to edit a source file inside the scratch worktree was blocked by the permission classifier and I did not retry it. The prove-red was done on a plain `git archive` export of `runner-v2` at `1daf1b89` in the system temp dir (the round-2 method).
- Repo effects of this review: this file only.

sha256 of files at `1daf1b89` (git blob content, LF):

| File | sha256 (blob) |
|---|---|
| runner-v2/src/windows-job-process-host.ts | `818527b91f83da0f9dd199f04174e4634d4f1d044936b71a5be6b7d200ae45d2` |
| runner-v2/test/windows-job-launch-speed.test.ts | `97277e9118f9ab98258c352cf94197e5f7515e20911c7b6a8585ed0bd8f53c01` |
| .superpowers/sdd/.../evidence/PX-2a.md | `e4dd44499344aafcc51391e0bad5d4bf5f79d340a0de32ad8688471df422408a` |
| runner-v2/src/managed-process-job-host.ps1 (not changed by the repair) | `fffaa75754b6a76c42d908c231638a252896f9cfded532de7e9b0e7afdeba1a2` |
| runner-v2/src/managed-process-supervisor.mjs (not changed) | `1006fad3f1938f78724c9dc2a25cf34ca25e4aa280c5f84ee8c72fd22d59d93b` |
| runner-v2/test/task8-raw-launch-closure.test.ts (not changed) | `67933281a018f0b57e829233057cb37de5d859c9f4da706ed783614df831931e` |
| runner-v2/test/windows-job-real-host-guarantees.test.ts (not changed) | `03c904af6dfab5bf10ee12f5412a31c09432e2af2bf7a55484877c4c9763402f` |

The checkout copies of the host and speed-test files differ from the blob hashes only by line-ending conversion (`de0e64f7…` and `908d062f…` in my checkout).

**Verdict: REPAIR — 1 blocking**

R2-B1 itself is fixed. The exact delete-and-race exploit no longer works, the new tests are meaningful, and everything else in the diff holds. But the failed-compile retry path is still an in-place recompile with no pin yet, and it can be raced. Round 2 called that path "not attacker-triggerable" and "safe". I measured it and it is not safe when a contained process is alive during the retry. The worker's "safe by construction (never loads)" note about bracket TEMP paths is wrong for the same reason. The repair is small.

## Findings

| # | Sev | Finding | Location | Evidence | Fix |
|---|---|---|---|---|---|
| R3-B1 | **Blocking** | A failed compile leaves no pin, and the next call recompiles into the same per-process directory. A contained process that is alive during that retry gets its own DLL hashed and pinned, and the Job host then loads it. | `windows-job-process-host.ts` `ensureJobHostHelperAssembly` / `compileJobHostHelperAssembly` (`jobHostHelperReady` stays unset on failure; the retry reuses `jobHostHelperProcessDir`, the same `<digest>` directory, `rmSync(dllPath)`, then compile, then `readFileSync` and hash) | Probe D (first compile made to fail by a broken PATH, then restored): the retry pinned the replacement bytes in 3 of 3 runs, and the next real call reported `precompiled` and wrote the marker. Probe D2 (TEMP path containing `[ ]`, so every compile fails silently with no DLL): call 1 returned null, then with a replacement process alive, call 2 pinned its bytes in 2 of 2 runs. Both probes used the runner module in-process with a separate replacement process; the round-2 exploit reached the same state through a contained call. | Do not recompile into the same directory after a failure. Simplest: remember the failure for the runner's lifetime (log once) so every later call falls back to in-process Add-Type; a runner restart restores the fast path. A fresh directory per attempt is weaker (it narrows the window but does not close it). Also escape the output path in the wrapper (`[WildcardPattern]::Escape`) so bracket TEMP paths keep the fast path, and fix the evidence note that calls this case safe. Add a regression test for "failed compile is never retried in place while a replacement process is alive". T6's last step ("failures are not cached, so the next call recompiles") must change with it. |

Preconditions, stated plainly. The failure that opens the window is not something the contained process can cause. It needs an environment fault (a bracket in TEMP, a transient compile failure) plus a live contained process during a later call. A bracket TEMP makes it repeatable, because every call is then a retry. The impact is the one round 2 rated blocking: replacement code running in the Job host process outside the Job. I rate it blocking because the property the controller asked for ("no recompile into the same place during a runner's lifetime") does not hold on this path, I have a failing probe, and the earlier reviews recorded the case as safe.

If the controller decides the environment precondition makes this a residual instead, the honest wording is: "before the first successful pin, a compile retry into the same directory can be raced by a live contained process". That should replace "not attacker-triggerable" in the evidence.

## Judge items

**1. Round-2 exploits against `1daf1b89` (scratch worktree, real host, profile `full`).**
- Exploit B (delete, then race the recompile): 3 of 3 runs. The trigger call reported `fallback` / `missing-file`, the contained racer reported `wrote=no`, the DLL never reappeared. My tolerant copy of B (the original script throws when the DLL is absent) also showed the next call `fallback` / `missing-file`, no marker, 3 of 3.
- Variant C (DLL emptied, then overwritten in a loop for 30 s while one sequential call, three concurrent calls and one more sequential call ran): all five calls `fallback` / `digest-mismatch`, no marker, the pin object unchanged (`===`, same path and sha). 2 of 2 runs.
- Exploit A (round-1 shape: replace the DLL plus write digest records): next and third call `fallback` / `digest-mismatch`, no marker. 1 of 1.
- Calls succeed in every case, through the fallback, with the right reason.
- Positive control: the same exploit B against a plain export with the round-1 self-heal block put back wins 2 of 2 (`precompiled`, marker written, `RACE WON`). So the harness can see a real load and the negative results above mean something.

**2. No recompile after the pin; no other re-read or re-trust.**
- `jobHostHelperReady` is assigned in one place (after a successful compile) and cleared only by `resetJobHostHelperAssemblyForTests`, which has no production caller (repo-wide grep). After the pin, `ensure` returns the stored object with no disk access.
- The DLL bytes are read in three places only: the compile (before the pin), and the Job host (`ReadAllBytes`, hash, `Assembly.Load(bytes)` from those same bytes, no second read). The supervisor only passes path and digest through. The PX-2c spare path calls the same `ensure`.
- Digest in memory only: the compile directory holds only the DLL and the wrapper. No `.sha256` or digest file on disk (probe).
- One compile per runner process: 8 concurrent callers got the same object in 261 ms, and the 9th call returned it again.
- Failed-compile retry before the first pin: see R3-B1.

**3. T8, T10, cleanup.**
- T8 is inverted: deleted DLL gives `fallback` / `missing-file`, the call succeeds, the file is not recreated. Its `finally` is best-effort with no assertions, and the byte-exact assert sits after the block. With the self-heal put back, T8 fails with its real message (`deleted assembly must fall back, never recompile in place`, actual `precompiled`), not a masked one.
- T10 replays delete-and-race: a contained racer deletes the DLL then overwrites it when it reappears, the victim launches after the delete is observed. It asserts racer `wrote:no`, victim `fallback` / `missing-file`, no marker, byte-exact restore.
- Prove-red on the export with the self-heal restored: full file 8 pass, 2 fail (exactly T8 and T10). T8 red on the mode assertion. T10 red on `nothing ever reappeared for the attacker to overwrite` (`wrote:yes`), 4 of 4 runs. T10 goes red whichever side wins the race, because the file reappearing at all is the vulnerable behavior.
- Temp dirs: `aiboard-px2a-evil-*` count 14 before and 14 after all my runs (newest 13:27, an hour before my runs), so the leak is fixed. No `aiboard-job-host-assembly-*` left.

**4. Nothing else weakened.**
- The diff is the one `ensure` change, T8, T10, the `evilScratchDirs` cleanup, and the evidence file. The ps1, supervisor and guarantee file are unchanged (blob hashes equal round 2).
- Round-1 exploit still falls back (exploit A). Compile once per runner process and digest in memory only: item 2.
- Evidence file: it says failed compiles "are not attacker-triggerable" and that a bracket TEMP is "safe by construction (never loads)". Both statements need correcting (R3-B1).

**5. Suites (scratch worktree at `1daf1b89`, `NODE_TEST_CONTEXT` unset).**
- `windows-job-launch-speed.test.ts`, concurrency 1: 10/10.
- Same file at `--test-concurrency=4` with `windows-job-supervisor-input` and `windows-job-output-replay` (once): 16/16.
- `windows-job-real-host-guarantees.test.ts`: 12/12.
- `task8-raw-launch-closure.test.ts`: red on exactly five lines, all blamed to `cd475d57` (PX-2c): `managed-process-supervisor.mjs:384` retireSpare member-kill; `windows-job-process-host.ts:396` module process-kill, `:527` retireSpare member-kill, `:555` startSpare child-process-spawn, `:797` sweepRetiredSpareRecords process-kill. None from PX-2a. The second test in that file passes.
- `tsc --noEmit -p runner-v2/tsconfig.json`: clean. `eslint` on the two changed TS files: clean. `git diff --check 1daf1b89~1 1daf1b89 -- runner-v2`: clean.

## Minor and follow-ups

1. Blocking: R3-B1 above.
2. N-r2-2 (bracket TEMP): still open. Escape the wrapper output path. It also becomes part of R3-B1.
3. N-r2-3 (120 s compile timeout on the first call's critical path): unchanged, noted in the evidence. Optional.
4. N-r2-4 partly done: the `evil-*` leak is fixed. `resetJobHostHelperAssemblyForTests` still adds one `process.once("exit")` listener per call (test-only).
5. Carried from round 2, not PX-2a: the flaky PX-2b test (`fused fence upgrade is durable across host instances`), and the five PX-2c `task8-raw-launch-closure` lines needing the controller's allowlist decision.
6. Residual to keep in the docs: a process that is alive during a compile can race it. The pin closes this only if no such process exists at compile time. Fully closing it needs a different design (for example a protected precompiled asset), not more hardening of this one.

Cleanup done at the end of the review: junction removed with `cmd /c rmdir`, the link confirmed gone and the shared `node_modules\eslint` confirmed present, then `git worktree remove --force`; my `px2ar3-*` and `pxr3` temp dirs removed (no reparse points inside them). Probe scripts kept for reproduction in `C:\Users\b_a_s\AppData\Local\Temp\claude\D--repos-ai-discussion-board\c3a6c726-b6f1-47ec-bea6-214ebdabe566\scratchpad\px2ar3\` (`common.mts`, `exploitB2.mts`, `exploitC.mts`, `exploitD.mts`, `exploitD2.mts`, `probeE.mts`). They hard-code `C:\Users\b_a_s\AppData\Local\Temp\pxr3\wt` as the worktree path in `common.mts`; retarget `WT` before reuse.

**Verdict: REPAIR — 1 blocking**
