# PX-2a independent review, round 1

- Reviewer: independent fresh-context reviewer (did not write PX-2a)
- Model: Sonnet 5.5 (claude-sonnet-5-5), extra-high effort
- Date: 2026-09-30
- Packet: PX-2a, commit `7a1703e2` (parent `cb567e62` = PX-2t), branch `codex/runner-v2-px1`. Reviewed AT that commit in a detached scratch worktree (sparse: runner-v2, docs, scripts, deploy, lib; node_modules junction). Later commits e8eb8720 and cd475d57 were not judged here.
- Inputs: brief `px2a-brief-muse.txt`; plan CD-21 and packet PX-2a; `PX-1-review-r1.md` (F5, F7, conditions 1-10); worker evidence `PX-2a.md`; the diff `git show 7a1703e2`.
- Repo effects of this review: this file only, in this worktree. No source or test file edited, staged, committed, stashed or pushed.
- **REVIEWER INCIDENT (needs the controller's attention now).** My cleanup command `git worktree remove --force` on my scratch worktree followed the `node_modules` junction in it. It deleted 132 top-level entries (including `.bin`, `esbuild`, `@types`, `eslint`, and part of `eslint-config-next`) from the SHARED target `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6\node_modules`. That folder is also the junction target for the `runner-v2-px1` and `runner-v2-p6-6-t5` worktrees and for other reviewers' scratch worktrees, so `tsx`, `eslint` and `tsc` shims may fail there until it is restored. Git stopped on a "Filename too long" error, and I then unlinked my two scratch junctions (link only) so nothing else can be deleted. Tracked files and evidence are untouched; only `node_modules` is affected. `runner-v2-p6-5\node_modules` has the identical `package-lock.json` and identical versions for all 342 shared packages, so it is an exact source. My copy-back was blocked by the permission classifier and I did not try another route. The list of missing entries is in `C:\Users\b_a_s\AppData\Local\Temp\px2ar1-restore-list.txt`. Restoring (copy only the missing entries from `runner-v2-p6-5\node_modules`, never overwrite, or run `npm ci` in `runner-v2-p6-6`) needs the owner's or controller's go-ahead. Lesson for the review recipe: use a real `npm ci` or a copy, or unlink the junction before `git worktree remove`.
- My detached scratch worktrees (`px2ar1\wt`, `px2ar1\wt-parent`) are unregistered from git; their leftover folders (junction links already removed) and the `px2ar1\p` probe folder remain in the session scratchpad and are safe to delete.

sha256 of the changed files at 7a1703e2 (git blob content, LF):

| File | sha256 |
|---|---|
| runner-v2/src/managed-process-job-host.ps1 | `bb31734b2f685f2cc3c1ad5abbf182a191d161f385de2af39af8d67739104652` |
| runner-v2/src/windows-job-process-host.ts | `ef51e620a25621f3c9af71ef6134c804654b56dd5f8a1203751b8b44b62ab7ec` |
| runner-v2/src/managed-process-supervisor.mjs | `22299d3cf9b2d5d82fd0ff691f093db65bb6520294401bba5eb62dada1e12aca` |
| runner-v2/test/windows-job-launch-speed.test.ts | `a2c078f847d58eae9277e6be5ff48539d7f5c4dd0a6526665d34de388c0926bc` |
| .superpowers/sdd/.../evidence/PX-2a.md | `cea1fb315cdb625409d3ab2503e0a88c6b77ee59985f589c75c7d3d3d2c735ff` |
| runner-v2/test/windows-job-real-host-guarantees.test.ts (unchanged) | `147a16d71e5c66ff4da83fef0547cded654af28a35cd308835564baf5fdabf30` |

The hashes in `PX-2a.md` (`b88cd9bb…`, `f27e515e…`) are of CRLF working-tree copies. They cannot be reproduced from the commit blobs. This is a line-ending difference only (nit N9).

**Verdict: REPAIR — 2 blocking**

The design is sound and the measured gain is real. Two defects stop acceptance. B1: a security policy test that was green at the parent is red at this commit, and the evidence never ran it. B2: the headline "no compiler ran" test fails when any other suite compiles at the same time. Both fixes are small. The trust anchor (N1) is weaker than "digest-pinned" suggests; I confirmed it with an exploit probe. I rate it non-blocking because it matches the exposure of the `.ps1` itself. I recommend folding the fix into the same repair.

## Findings

| # | Sev | Finding | Location | Evidence | Expected | Actual | Fix |
|---|---|---|---|---|---|---|---|
| B1 | **Blocking** | The Task 8 raw-launch closure test is red at this commit. PX-2a adds an un-allowlisted raw PowerShell launch. The worker never ran or reported this test. | `windows-job-process-host.ts:20` (module constant `JOB_HOST_SCRIPT_FILENAME`), `:172-181` (`compileJobHostHelperAssembly`: `spawnSync("powershell.exe", …)`); allowlist in `runner-v2/test/task8-raw-launch-closure.test.ts:18-54` | `task8-raw-launch-closure.test.ts` "Task 8 production tree has no raw execution or ambient environment escape outside exact hosts": PASS at `cb567e62`, FAIL at `7a1703e2` (same sparse layout, docs present). Violations: `:20 <module> powershell-script-launcher managed-process-job-host.ps1`; `:181 compileJobHostHelperAssembly child-process-spawnSync`; `:181 compileJobHostHelperAssembly powershell-launcher powershell.exe`. `git diff 7a1703e2 cd475d57` on that test is empty, so PX-2b/2c do not fix it. `PX-2a.md` §5 lists no static-policy suite. | Every raw process boundary is exactly allowlisted (architecture.md line 13: "deliberately allowlisted, audit-marked, and documented"), and the suite stays green. | A new audited boundary exists in code but not in the allowlist. The allowlist file is outside the worker's writable set, so the worker could not fix it and did not flag it. | Controller decision, then a small edit: add exact rules for `windows-job-process-host.ts` / `compileJobHostHelperAssembly` (kinds `powershell-launcher`, `child-process-spawnSync`), and either move the `.ps1` literal into an already-allowlisted container or add a `<module>` `powershell-script-launcher` rule. The stale-rule check needs every rule live. Add `task8-raw-launch-closure` and `static-adapter-policy` to the packet's validation list. |
| B2 | **Blocking** | T1 ("precompiled path is used") is not parallel-safe. It fails whenever any other process on the machine runs `csc.exe`. | `runner-v2/test/windows-job-launch-speed.test.ts:203-245` (watcher polls machine-wide `Get-Process -Name 'csc','cvtres'`), `:323` (assertion) | Ran the new file together with `windows-job-supervisor-input` and `windows-job-output-replay` at `--test-concurrency=4`: T1 RED with `no compiler may run during call 0 (saw csc:68212)`. Alone it passes (4/4). Those suites launch the raw `.ps1` through `test/support/windows-fixture-job.ts` with no helper fields, so every launch runs `Add-Type` and starts `csc.exe`. The controller runs suites in parallel next to reviews. | T1 goes red only when THIS call's Job host compiles. | The oracle is machine-global. Any concurrent suite in the same matrix flips the gate red. | Attribute compilers to the call (count only `csc`/`cvtres` whose parent chain contains this call's `supervisorPid`, one `Win32_Process` snapshot per poll), or drop the global assertion and keep the deterministic helper event as the proof (the precompiled branch never reaches `Add-Type`). T2/T3's positive `compilers.length > 0` can stay informational or use the same attribution. |
| N1 | Medium (non-blocking; fix recommended) | The digest pin sits beside the file it pins. A same-user contained command can replace the DLL and the digest record. The next call loads attacker code into the un-jobbed Job host and reports `precompiled`. | `windows-job-process-host.ts:138-168` (recorded digest read from `<dll>.sha256` on every call, `:162` passes it through) | Exploit probe on the real host, profile `full` (the only profile that launches arbitrary commands on Windows; `project` refuses with `isolation_capability_unavailable`): (1) warm call compiles the helper; (2) one contained `node -e` copies `evil.dll` over the DLL and writes its sha256 into the record; (3) next call: helper event `mode=precompiled reason=null`, and a marker file written by code inside the replaced DLL from a process named `powershell` (the Job host, outside the Job). Replacing only the DLL, or only the record, falls back (worker's T2/T3, and my variants). | A pin an agent-run command cannot move. | The pin is an integrity check against accidental damage and non-coordinated tampering only. Same exposure as the `.ps1` on disk (also same-user writable), and docs say Job containment is lifecycle containment, not confinement, so I do not block. The worker disclosed the limit in §6. | Keep the digest in the runner process's memory. Compile once per runner process into a fresh generation directory, never trust another process's record, and cache by source digest across state dirs in-process (write the same bytes into each state dir). This also fixes N3, N4 and N7. |
| N2 | Medium | `ensureJobHostHelperAssembly` can throw although its doc says it returns null. In `launchOwned` the call sits after the supervisor is spawned and the record persisted, so a throw leaves an orphan supervisor and a `running` record. | `:173` (`mkdtempSync` is before the `try`), `:289` (call site outside `try`) | TEMP pointed at a file: `ensureJobHostHelperAssembly` THREW `ENOENT … mkdtemp`. Through the real host: `launchOwned` rejected with the raw ENOENT, record `status=running` left, supervisor process ALIVE (I killed only that PID). Every later call retries and fails the same way, because the failure is not cached. | Any compile-side failure returns null and falls back. | Raw exception, leaked supervisor. A baseline host with an unusable TEMP fails too (Add-Type needs TEMP), so probability is low. | Move `mkdtempSync` inside the `try`; wrap the call in `try/catch` returning null. |
| N3 | Low-Medium | Two processes first-compiling in one state dir: the loser returns null and caches the failure for its whole life. The pair on disk is valid, but it never uses it. A bad pair never self-heals. | `:152`, `:168` (`helperAssemblyCompileFailures`), `:162` | 12 rounds (6 simultaneous, 6 staggered 250 ms): in 11 rounds exactly one process returned null; final on-disk pair CONSISTENT every time. No mixed load. Truncated, empty or flipped DLL with the original record: fallback `digest-mismatch` every call, no recompile. | Loser re-reads the on-disk pair. A damaged pair is replaced. | Sticky slow path, silent. Fail-closed, so safe. | On null, re-check the on-disk pair before caching. Expire the cached failure. Write to a unique temp name, then rename. |
| N4 | Low | The compile is `spawnSync` on the runner event loop (about 300 ms here, timeout 120 s), once per distinct state dir. | `:181` | Cold `ensure` on a fresh dir: 252-373 ms across the 24 calls of the race probe. Direct ps1 runs: precompiled 282-414 ms, fallback 436-494 ms. | Async, or shared per process. | An ephemeral state dir that makes one call pays about 300 ms to save about 150 ms. Long-lived production dirs are fine. | Async spawn. Or the N1 fix (one compile per process). |
| N5 | Low | "Load succeeded but the type is missing" is not a fallback. | ps1:743-748 | Variant g: a valid assembly without `ManagedProcessJobHost` and a matching digest: `mode=precompiled`, then `Unable to find type [ManagedProcessJobHost]`, exit 1. | Any load-side failure falls back. | Fail-closed but no fallback. Reachable only with a blessed wrong file. | After `Load`, check `'ManagedProcessJobHost' -as [type]`; else fall back. |
| N6 | Low | The PowerShell quote helper handles ASCII `'` only. PowerShell also treats U+2018, U+2019, U+201A and U+201B as quotes. | `:179` | State dir `curly’quote`: compile returns null (fallback). Paths with space, `'`, `$`, backtick and non-ASCII letters compile fine. A crafted state-dir path can break out of the compile command (owner-controlled path). | Any path compiles. Nothing in a path is executable. | Quoting bug in security-sensitive code. Safe degradation only. | Pass paths through env vars or `-EncodedCommand`. |
| N7 | Low | Two small swap windows in the compile. The C# source is written to a shared `%TEMP%` dir and read by PowerShell after its boot (100-300 ms). The DLL is written to its final path and read back by the host to hash. | `:172-190` | Code reading. | Source and output stay private until verified. | A same-user swap in either window gets blessed. Same class as N1. | With the N1 fix: pass the source on stdin or `-EncodedCommand`; compile to a private temp; hash; then rename. |
| N8 | Nit | The extracted source has a trailing `\r` on CRLF checkouts. Not byte-identical to PowerShell's here-string, so "byte-identical source" is slightly off. | `:119-125` (`.replace(/\r?\n$/, "")` cannot match, because the slice ends before `\n`) | 30083 vs 30082 chars on a CRLF checkout; the committed blob is LF. | Same text as the here-string. | Harmless whitespace. | Strip a trailing `\r`. |
| N9 | Nit | Test helper leaks its stop dir when `work()` throws (one `aiboard-px2a-watch-*` from my red run; removed). Ten `aiboard-px2a-*` dirs from the worker's own probes remain in `%TEMP%` (not mine, left). | test:203-245 | Directory listing. | Cleanup in `finally`. | Leak on failure. | Move `rmSync` into `finally`. |
| N10 | Low | The fallback reason exists only in the per-call `job-events.jsonl`. No runner-level log or counter. A runner stuck on the slow path is silent. | ps1:758-771 | Code reading. | "Records why" in a place someone will see. | Per-call file only. | Log once per state dir when a helper event says `fallback`. |
| N11 | Nit | Old generation dirs under `job-host-assemblies/<digest>/` are never removed. | `:149` | Code reading. | Prune on source change. | Grows slowly (about 150 KB each). | Prune other digests after a successful compile. |

## Judge items

**1. Trust chain.**
- Compiler: the runner process (host TS). It extracts the C# between the `$jobHostCsSource` markers and compiles it with a throwaway `powershell.exe … Add-Type -OutputAssembly … -OutputType Library`, as the runner user.
- Location: `<state>/managed-processes-job-host/job-host-assemblies/<sha256 of source>/ManagedProcessJobHost.dll` plus `ManagedProcessJobHost.dll.sha256`. No explicit ACL. Any same-user process can write both (see N1).
- Digest path: recorded at compile time (the host hashes the bytes it reads back), re-read from the record on every later call and by a later runner process, sent in the supervisor stdin config, forwarded to the Job host's stdin line (base64 in the interactive/production path). I found no argv, env or HTTP path, and the persisted `HostRecord` does not carry the fields.
- Same bytes: the Job host reads the file once (`ReadAllBytes`), hashes those bytes, and calls `Assembly.Load` on the same array. There is no check-to-load gap.
- Failure matrix (Job host run directly, 13 variants; each still ran its child and exited 0 unless noted):

| Variant | Recorded mode / reason |
|---|---|
| good pair | precompiled / null |
| file missing | fallback / missing-file |
| flipped byte, original digest | fallback / digest-mismatch |
| truncated to half | fallback / digest-mismatch |
| zero bytes | fallback / digest-mismatch |
| garbage bytes with matching digest | fallback / load-error |
| valid assembly, wrong type, matching digest | precompiled, then exit 1 (N5) |
| upper-case digest | precompiled / null |
| non-hex digest | fallback / digest-mismatch |
| path without digest | fallback / no-helper-config |
| directory as path | fallback / missing-file |
| no fields | fallback / no-helper-config |
| file locked exclusively by another process | fallback / missing-file |

- Concurrent first compiles: one process, no race (the compile is synchronous). Two processes: no mixed or inconsistent pair in 12 rounds, but a permanent null for the loser (N3).
- A digest recorded by a previous runner process is trusted as is (N1).

**2. Fallback.** Any read, hash or load failure runs `Add-Type` on `$jobHostCsSource`, the same source text as before, and appends the reason. Unverified bytes are never loaded. The path and digest come only from the private stdin config, so the fallback cannot be pointed at attacker code. Gaps: N1 (a blessed pair loads) and N5 (missing type does not fall back).

**3. Per-call semantics.** The C# body is byte-identical to the parent (29383 chars in both). The ps1 tail diff adds only `Initialize-JobHostType` and two calls to it. Suspended-create, assign, resume, kill-on-close and every proof are untouched. `static-adapter-policy` still pins `LimitFlags` and the `CreateProcess` flags and passes. The supervisor diff forwards two fields. The host diff is the call site plus two request options. One order change: the type now loads after the config is read (before, at script start). Harmless.

**4. Keep-alive.** `agent: false` plus `Connection: close`. `authenticatedStatus` absorbs a refused or reset request by reading the durable status (persisted before `server.close`). The last-chunk `/ack-output` response is written before the server closes. Mixed-load probe (quick, 3 MB burst, 6 s wait, 3 s trickle, stderr+stdout): 30 calls at concurrency 6, and 60 calls at concurrency 12. Result: 0 failures, 0 supervisors alive 1.5 s after the last result. At the parent, 1 supervisor was still alive. Each request now opens a loopback connection (a few ms). No race found.

**5. Tests.**
- `windows-job-launch-speed.test.ts` 4/4 pass alone. T1 fails in parallel (B2).
- Prove-reds re-run on the scratch copy, each restored byte-exact (sha256 before equals after):

| Fault | Red result |
|---|---|
| T1: `ensure…` returns null | `no compiler may run during call 0 (saw csc:7844,cvtres:36752)` |
| T2: host vouches for live bytes | tampered bytes loaded: `Unable to find an entry point named 'SetInformationJobO�ject'` |
| T3: ps1 compare forced false | `mismatched digest must not load` |
| T4: keep-alive reverted | `supervisor to exit after the result did not settle within 1000ms` |

  T2's fault is the host-side pin, not the ps1 compare. T3 covers the ps1 compare. Together they are meaningful.
- Guarantee file unchanged (`git diff cb567e62 7a1703e2` empty). 12/12 green at this commit.
- Windows Job suites (`windows-process-backend`, `windows-job-output-replay`, `windows-job-supervisor-input`, `one-shot-command-family-production-matrix`, `execution-host`, `subprocess-runtime`, `durable-process-store`): 228 tests, 227 pass, 0 fail, 1 skip (pre-existing).
- Also green: `filesystem-mutation-routing`, `managed-backend-boundary`, `process-host-semantic-probes` (33/33); `static-adapter-policy`, `package-parity`, `one-shot-command-routing-static`, `git-caller-routing`. **Red: `task8-raw-launch-closure` (B1).**
- `tsc --noEmit -p runner-v2/tsconfig.json` clean; eslint on the two TS files: no rule findings (the only message is the sparse checkout's missing `pages` dir); `git diff --check` clean.

**6. Measured gain.** Plausible. Alternating parent/commit runs, n=10, on a machine shared with other reviewers (medians in ms, run 1 then run 2):

| Command | Parent | Commit |
|---|---|---|
| rev-parse | 945, 1047 | 855, 906 |
| quiet | 873, 919 | 810, 770 |
| large | 1025, 1091 | 931, 911 |

Fence effects stay 14 / 16 / 16. The gain is about 90-180 ms under load, consistent with F5's 140 ms and the worker's 133 ms. My direct Job host runs show the same shape: precompiled 282-414 ms against fallback 436-494 ms. The keep-alive part removes the post-result supervisor linger (F7).

## Follow-up list

1. B1: controller updates the Task 8 allowlist (a policy decision) and adds the two static suites to the PX-2a/2b/2c validation list. Re-check PX-2b and PX-2c at their own commits.
2. B2: make T1 attribute compilers to its own call or rely on the helper event.
3. N1/N3/N4/N7: one design change fixes all four: compile once per runner process, keep the digest in memory, share across state dirs, private temp then rename. Fold into the repair.
4. N2: make `ensure…` total (never throws); on any launch failure after spawn, abort the supervisor.
5. N5, N6, N8-N11: small hardening, same repair or later.
6. Add tests for `missing-file`, `load-error` and truncated-file reasons (I verified them by direct probe only).
7. Interactive/LSP wall-clock gain is not measured (the worker says so). Production always launches interactive, so the helper path is exercised, but the number is unmeasured.

**Verdict: REPAIR — 2 blocking**
