# CW0b: how Codex's processes ended up outside the Runner's Windows Job

Date: 2026-11-18. Packet CW0b of docs/plans/2026-11-14-cli-workers.md (§5). Investigation only: no product code, no
change to `runner-v2/src`. Base: main dd85ca48.

**Method.** Read-only. This packet ran no Codex, started no process tree under a Job, and built no reproduction. It
reads:

- the CW0 report (docs/runner-v2/cli-workers-spike-2026-11-17.md §6.1) and its fixtures
  `runner-v2/test/fixtures/cli-workers/codex-cli/{background-escaped,background-escaped-run2,model-unavailable}.windows.*`;
- CW0's throwaway harness copy (job definitions only);
- the Job host (`managed-process-job-host.ps1`, `windows-job-process-host.ts`, `windows-job-process-channel.ts`,
  `windows-process-backend.ts`) and the shell launchers (`shell-session.ts`, `shell-inventory.ts`, `command-line.ts`);
- commit 14feeda0 and PR #167, which added the desktop app policy;
- strings in the installed Codex binary (codex-cli 0.169.0), read as data;
- the launcher script of the hook involved, read as data;
- Microsoft Learn: UpdateProcThreadAttribute, Job Objects, Nested Jobs, IsProcessInJob, and the MSIX and App Execution
  Alias pages.

One observation was made before this packet became read-only: a single run of the `python3` alias with `-c` printed
which interpreter it hands off to. It ran in a plain shell, under no Runner Job. The CW0 leftovers (the hook process
and the node server, pid 54776) were gone before this packet started, so no live process could be inspected.

## 0. Summary

1. **The most likely mechanism is one the Runner already measured and documented as a known gap (PR #167, 2026-11-10).**
   A packaged (MSIX or Microsoft Store) program that a *descendant* of the Job's root starts has its own children
   created outside the Job. The Job host's desktop app policy covers only a packaged program that is the Job's root.
   Under Codex, the Store `pwsh.exe` is never the root: `codex.exe` starts it for every shell command. The hook case
   fits the same shape: the hook's launcher runs `python3`, which on this PC is the Python Install Manager's packaged
   alias.
2. **CW0's four "stayed inside" reproductions tested a different shape.** Each one ran the Store pwsh as the Job's
   root, the one case the policy covers. CW0's merged report says this too (§6.1, "The difference from Codex").
3. **A plain Runner-managed process can take the same path, with no Codex.** By PR #167's own table, `cmd` or
   `powershell` starting the Store pwsh leaves pwsh's children outside the Job with either host. Two ways in:
   - **An API worker's command at Full access.** Any shell that runs `pwsh`, `python3` or `py` gets the WindowsApps
     alias first on this PC.
   - **The Runner's own pwsh shell session.** On a PC whose only pwsh is the Store one, shell-session.ts:213-214 starts
     it as `cmd.exe /d /c pwsh.exe …`, which is exactly #167's measured gap. The comment above it (:198-203) says the
     policy keeps the shell in the Job, which #167's evidence contradicts. This affects API workers on main today. It is
     inferred from code plus #167, not traced here.
4. **One doc conflict is open.** Microsoft documents `DISABLE_PROCESS_TREE` as "inherited by the descendant processes
   until it is overridden". Read literally, it should reach a descendant-launched Store pwsh, yet #167 measured that it
   does not. Either something in the chain re-enables breakaway (§2, M3), or the inheritance does not survive alias
   activation; neither is documented. The trace in §4.1 settles it.
5. **Recommendation.** Keep Codex refused on Windows; no Codex launch setting is known that avoids the Store pwsh or
   the user's hooks. Run the owner's trace (§4.1). Then do one Runner packet with an independent review (§4.2):
   - launch the Runner's own Store pwsh as the Job's root;
   - detect a packaged descendant in the Job and fail the stop closed;
   - take the WindowsApps alias folder off managed children's PATH;
   - fail closed when the policy attribute can't be set.

## 1. What CW0 recorded (data from the fixtures)

| Run | Codex's command (fixture `stdout.jsonl`) | Survivor | In a job | Parent |
|---|---|---|---|---|
| background 1 | `"<home>\AppData\Local\Microsoft\WindowsApps\pwsh.exe" -Command "Start-Process -FilePath (Get-Command node).Source -ArgumentList '-e', '…listen(0)' -WindowStyle Hidden"`, exit 0 | `node.exe` + its `conhost.exe` | no | gone |
| background 2 | the same alias, `Start-Process -FilePath node -ArgumentList @('-e', '…') -WindowStyle Hidden`, exit 0 | `node.exe` (pid 54776, found later by command line; the sampler missed its short-lived pwsh parent) | no | gone |
| model unavailable | none (the turn failed at once: `turn.failed`) | a Python process of a hook from a user-installed plugin + its `conhost.exe` | no | gone |

Both runs that started a background server escaped, 2 of 2. That points to a deterministic path, not a race. In each
run Codex itself wrapped the command in the full path of the WindowsApps `pwsh.exe` alias. So the shell is a packaged
program, and its parent is `codex.exe`, a descendant of the Job's root, not the root.

CW0's free reproductions (job definitions in the harness copy, `jobs-escape-win*.json`, `mkescape2.mjs`) set
`command` to the WindowsApps `pwsh.exe` itself, so the Store pwsh was the managed root. That is the shape the Job
host's attribute covers, and they stayed inside, as #167's pinned test expects.

## 2. Candidate mechanisms, ranked

### M1 (strong). A packaged program started by a descendant, not by the Job host

The Job host starts the root with `PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY` = `DISABLE_PROCESS_TREE`
(managed-process-job-host.ps1:376-396). Its own comment (:345-350) says the policy "does not reach a packaged program a
descendant launches (that one is created outside the Job either way)."

**Evidence for:**
- **PR #167's measured table (2026-11-10, Store pwsh 7.6.9):**

  | Launch | Child in Job | Survives stop |
  |---|---|---|
  | Store pwsh as root, old host | no | yes |
  | Store pwsh as root, new host | yes | no |
  | cmd / powershell → Store pwsh (either host) | no | yes (known gap) |

  Commit 14feeda0 says the same: "Still outside the Job: a packaged program that a shell or other descendant launches
  (for example cmd running the Store's python). No launch attribute reaches that one."
- **The Codex shape matches row 3.** Codex starts the Store pwsh alias as a child of `codex.exe` for every shell
  command, and pwsh then starts node.
- **The root shape matches row 2.** CW0's reproductions ran the Store pwsh as the root and stayed in.
- **"Parent gone" fits.** `Start-Process` returns at once, so pwsh exits within the same tool call and the server
  outlives it.
- **The hook case fits too.**
  - The hook's launcher script tries `python3`, then `python`, then `py`, and execs the first one that runs. It even
    probes a WindowsApps alias with `-c ""` before using it.
  - On this PC, `python3` resolves only to `%LOCALAPPDATA%\Microsoft\WindowsApps\python3.exe`, an alias of the Python
    Install Manager. That is an MSIX package (`PythonSoftwareFoundation.PythonManager`), which also owns the
    `python.exe`, `py.exe`, `pymanager.exe` and `pythonw.exe` aliases there.
  - The alias hands off to a separate, non-packaged interpreter (`C:\Python3xx\python.exe`; the one observation
    above).
  - So the hook's interpreter, and the process it starts, are children of a packaged program that a descendant
    (Codex's hook runner) launched: row 3 again.

**Evidence against, or open:**
- The doc conflict in §0.4. Microsoft documents DISABLE_PROCESS_TREE as inherited by descendants until a process is
  created with `ENABLE_PROCESS_TREE`. Neither `cmd` nor `powershell` is known to set that attribute, yet #167 measured
  the escape through both.
- The "broker" that creates a packaged program's children is not identified. The fixtures hold names, pids and job
  membership only: no creator process, image path, session or token.
- The hook chain (runner shell → alias → interpreter → the escaped process) is inferred from the launcher script and
  PATH. The sampler recorded no image paths, so it was not traced.

### M2 (low). The attribute silently dropped (:365-386)

If `InitializeProcThreadAttributeList` or `UpdateProcThreadAttribute` fails, the root starts without the policy and
no error is raised.

- **Against:** this PC runs Windows 10 19045. Microsoft documents the attribute for 1703 and newer, and a one-entry
  list has no known way to fail there. CW0's root-shape reproductions ran under the same host and harness and stayed
  inside. Without the attribute they would have escaped (#167, row 1), so the attribute was applied in those runs.
- **For:** nothing specific. The fallback is still fail-open by design. It should fail closed on a Windows version that
  supports the attribute (§4.2, R4).

### M3 (low to medium, not excluded). Codex sets a creation policy of its own

The Codex binary's strings show three spawners on Windows (ConPTY, "Windows pipe", "legacy"). Each puts the command in
a Job of its own (`CreateJobObjectW`, `AssignProcessToJobObject`, `SetInformationJobObject(KILL_ON_JOB_CLOSE)`, "spawned
ConPTY is missing its process job") and can "preserve descendants after root exit".

If a spawner passes `PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY` = `ENABLE_PROCESS_TREE`, that alone would explain the
override. The value is numeric and doesn't show in strings. M1 explains all three cases without M3, and #167 saw the
same escape with no Codex. A stack on the Process Create event (§4.1) settles it.

### M4 (ruled out). Codex's own nested Job or breakaway

- "After a process is associated with a job, the association cannot be broken" (Job Objects).
- A breakaway in a hierarchy goes up "until it reaches a job that does not permit breakaway" (Nested Jobs). The
  Runner's Job permits none (`LimitFlags` is `KILL_ON_JOB_CLOSE` only, :549-562).
- Codex's binary carries the error "(the Windows host job must allow breakaway)" for its detached app-server. Codex
  expects that it cannot detach under such a host.
- Codex's per-command Job and its "preserve descendants" keep a process inside the Runner's Job; they cannot take one
  out.

### M5 (low, not traced). Creation brokered by a service

Microsoft documents that "Child processes created using Win32_Process.Create are not associated with the job". Task
Scheduler and COM activation behave alike.

Nothing points to one here:
- The escaped commands are `Start-Process` (ShellExecuteEx in PowerShell), and the same form, run from a root Store
  pwsh, stayed in.
- The hook launcher uses only `exec`.
- Codex's strings show no `Win32_Process`, `schtasks` or task-scheduler use. Its Windows sandbox, which uses
  `CreateProcessAsUserW`, is turned off by `--dangerously-bypass-approvals-and-sandbox`, which every CW0 run passed.

The trace in §4.1 shows the creator of each process, which would expose a broker.

### M6 (no evidence). Codex's helpers

`codex-code-mode-host.exe`, `node_repl.exe` and the user's configured MCP servers were seen in Codex's tree. None
survived a stop.

## 3. Can a plain Runner-managed process reach it?

Yes, as far as the Runner's own measurement and code show. No Codex is needed.

| Path | Shape | Covered by the policy? |
|---|---|---|
| `process.run` with shell `pwsh` (command-line.ts:33) | the Store pwsh alias is the Job's root | yes (#167's pinned real-host test) |
| Runner pwsh **shell session** on a PC whose pwsh is the Store one (shell-session.ts:213-214) | `cmd.exe /d /c pwsh.exe …`: cmd is the root, the Store pwsh a descendant | **no**, by #167 row 3; the comment at :198-203 claims otherwise |
| An API worker's command at Full access, in any shell (`cmd`, `powershell`, `bash`, or a script), that runs `pwsh`, `python3`, `py` or another WindowsApps alias | a packaged program as a descendant | **no** (#167 row 3) |
| A hook or tool of any CLI (Claude Code's hooks also run `python3` here, per CW0 §6.1) | as above | **no** |

Consequences:
- On this PC the Runner's `contained_workload` stop text ("The process and every process it started have exited",
  managed-process-tools.ts:516) can be untrue for an API worker today, not only for a Codex worker.
- CW0's "none found" for Claude Code and agy means nothing outlived a stop, not that everything stayed in the Job.
  Claude Code's `python3` hooks likely ran outside the Job and exited before the stop. That is an inference; no trace
  shows it.
- By DECISION §3, a host service a workload asks to launch work (Model B/C) is outside the native contract. A packaged
  alias on PATH is not that case: it is ordinary command resolution that a worker hits without trying to. So the stop
  claim has to account for it.

## 4. What would settle it

### 4.1 A trace the owner runs

Process Monitor is a Microsoft Sysinternals download
(https://learn.microsoft.com/sysinternals/downloads/procmon), so the owner downloads and runs it. A built-in
alternative, from an elevated prompt, is the `Microsoft-Windows-Kernel-Process` ETW provider through `logman`.

**What to run while tracing.** Normal use only, chosen by the owner:
- a Runner pwsh shell session on this PC (Store pwsh) that starts a long-running project command, such as a dev
  server;
- optionally, with the owner's go, one CW0 background run of Codex.

**Process Monitor settings:**
- Toolbar: show only *Process and Thread Activity* (turn off registry, file system, network and profiling).
- Filter, Include: `Operation is Process Create`, `Operation is Process Start`, `Operation is Process Exit`.
- Filter, Include: `Process Name is pwsh.exe`, `cmd.exe`, `node.exe`, `python.exe`, `python3.exe`, `codex.exe`,
  `svchost.exe`, `RuntimeBroker.exe`, `sihost.exe`, `explorer.exe`. A broadly filtered capture also works; filter
  afterwards.
- Columns (Options > Select Columns): Process Name, PID, Parent PID, Session, Integrity, Image Path, Command Line,
  User, Virtualized. Hide or blank the User column before sharing.
- Options > Configure Symbols if a stack with symbols is wanted (Microsoft symbol server). Open the *Process Create*
  event of the escaped child, then the Stack tab.
- Tools > Process Tree after the stop, for the escaped process's ancestry.

**What to read:**
- **The creator.** A *Process Create* event is logged in the context of the creating process. If node's (or the
  interpreter's) Process Create sits under the Store pwsh, the creation was in-process. If it sits under a service
  host or broker, the creator is that process, and the event's stack names the component.
- **The new process's Parent PID** (in its *Process Start* event), compared with the creator.
- **Session and integrity** of the escaped process, compared with the Job's root.
- **For M3:** the stack of `codex.exe`'s Process Create of the Store pwsh. A desktop app policy attribute isn't
  visible there directly, but the call path (ConPTY, or `CreateProcessW` with an attribute list) is.

**Job membership.** Process Monitor does not show it. Note the escaped pid and check it with `IsProcessInJob(h, NULL)`
("tests if the process is running under any job"), as CW0 did.

**ETW alternative (elevated, built in):**

```text
logman create trace cw0b-proc -p Microsoft-Windows-Kernel-Process 0x10 -o %TEMP%\cw0b-proc.etl -ets
… run the case …
logman stop cw0b-proc -ets
tracerpt %TEMP%\cw0b-proc.etl -o %TEMP%\cw0b-proc.xml -of XML
```

Event 1 (ProcessStart) carries the new `ProcessID`, `ParentProcessID`, `SessionID` and `ImageName`. The event
header's `Execution ProcessID` is expected to be the creator; check it against the Process Monitor stack.

### 4.2 The Runner change it implies

A process-ownership change, in its own packet, with an independent review recorded in its PR. It keeps fail-closed
ownership and fencing, adds no timeout inflation, and keeps the affected portable coverage. It is verified with targeted
tests plus `npm run typecheck:runner-v2`, never the full suite.

- **R1. The Runner never starts a packaged program as a descendant itself.**
  - The Store pwsh shell session becomes the Job's root, as `process.run`'s pwsh already is (command-line.ts:33), so
    the root attribute covers it. The alternative is to prefer a non-packaged pwsh or `powershell.exe` for sessions.
  - Fix the comment at shell-session.ts:198-203 either way.
  - The reason the session goes through cmd (a managed launch pins its program by real path and contents, which an
    alias lacks) needs a decision in that packet: pin the alias the way `process.run` already does, or don't offer a
    Store-only pwsh for sessions.
  - Test: a real-host pin, "a Store pwsh shell session's child dies with its Job", that fails on main.
- **R2. Packaged descendants are detected inside the Job, and the stop fails closed.**
  - The Job host asks the Job for its own membership events: a completion port with `JOB_OBJECT_MSG_NEW_PROCESS`. For
    each new member that is not the root, it checks package identity (`GetPackageFullName` on the process handle).
  - If a packaged non-root process ran in the Job, the stop is not `contained_workload`. It is recorded as an escape
    incident (`cleanup_blocked` per DECISION §8.3, i.e. case 2 `process_stop_unproven` in the plan's terms), never as
    the contained stop text.
  - This uses the Job's own evidence (§8.2), not a host census (§8.1, §14.1).
  - **It works only if the packaged process itself is in the Job.** If the trace shows that the descendant-launched
    Store pwsh is itself created outside the Job, R2 cannot see it, and R3 plus the Codex refusal are what remain.
  - Tests: a real-host case where a non-root packaged process ran gets the unproven outcome; a workload without one
    keeps `verified_empty` and the contained text; a static policy pin of the port and the message handling.
- **R3. Take the WindowsApps alias folders off managed children's PATH** (child-environment).
  - Folders: `%LOCALAPPDATA%\Microsoft\WindowsApps` and its per-package folders.
  - Then `pwsh`, `python3`, `py` and other aliases do not resolve by name inside a worker, and a CLI falls back to the
    other shells it knows. Codex's strings list `powershell.exe` and `C:\Program Files\PowerShell\7\pwsh.exe`, which
    still needs a Codex run with the owner's go to confirm.
  - This is defense in depth, not proof: an explicit alias path still works. R2 is what makes the stop honest.
  - Tests: child-environment pins on Windows that PATH has no WindowsApps entry; inventory and shell detection still
    find the Runner's own shells.
- **R4. Fail closed on the policy attribute.** On Windows 10 1703 or newer, a failure to build or update the attribute
  list refuses the launch with a coded Runner refusal (plan §3.11 case 1) instead of launching without the policy.
  Test: an injected failure refuses before any spawn; static-adapter-policy pins it.
- **Lifting Codex's refusal on Windows (plan §3.11)** then needs R1 to R4, the trace's answer to M3, and a CW0-style
  measurement with the fix in place showing zero escapes across the background and model-unavailable cases. Claude
  Code and agy should get the same measurement, with a job-membership check on every process in the tree while it runs,
  not only after the stop.

**Not proposed:**
- a host-wide process census or a per-PID escape killer (DECISION §8.1, §8.3);
- changing the user's Codex config, plugins or hooks;
- allowing breakaway on the Job.

## 5. Reproduction script

None. This packet was observational by decision. PR #167's measurement (row 3 of the table in §2) is the existing
Codex-free evidence for M1. A Runner real-host test that pins the descendant shape belongs to the fix packet (§4.2,
R1 and R2), with its own cleanup by marker.

## 6. The fix packet (R1–R4): what it measured and changed (2026-11-18)

Host: Windows 10 Pro 19045, Store pwsh 7.7.0 (`Microsoft.PowerShell_7.7.0.0_x64__8wekyb3d8bbwe`), WinDbg from the Store
(`cdb.exe`, a second packaged console program). Each shape ran through the real Job host (supervisor, PowerShell host,
desktop app policy on the root), and a raw Job with a completion port for the first two rows. "Members" are the
processes whose `JOB_OBJECT_MSG_NEW_PROCESS` the Job posted, with their package identity read at once.

| Root → descendants | Packaged members in the Job | Child after the stop |
|---|---|---|
| cmd → Store pwsh (alias) → node | none: only cmd and conhost joined; pwsh and node are outside the Job | **survives** (#167 row 3) |
| cmd → the package's own `pwsh.exe` (real path) → node | none: pwsh is created outside the Job the same way | **survives** |
| cmd → `cdb.exe` (other package); node | none | dies (node was cmd's child) |
| Store pwsh root → node | node and conhost, **with the root's own package** | dies |
| Store pwsh root → the package's own `pwsh.exe` → node | the inner pwsh, node, conhost: the root's package | dies |
| Store pwsh root → `cdb.exe` (other package); node | none from WinDbg: cdb is created outside the Job | dies |
| Store pwsh root → Store pwsh **alias** → node | conhost (root's package); the alias pwsh and node are outside | **escapes** (the stop waited ~30 s on the stdout pipe node inherited, until node exited by itself) |

Two more facts:
- The Store pwsh has its package identity whether CreateProcess names the alias or the package's own `pwsh.exe`
  (`GetPackageFullName` on both). So 0fb60a60's note that "a directly launched package program has no package
  identity" does not hold on this host; pinning the real program does not unpackage it.
- A Job's port receives `NEW_PROCESS` for members of a nested child Job too, and the count matched the Job's
  `TotalProcesses` (5 of 5).

**What this means.** On this host, every packaged program that a descendant starts (alias or real path, any package)
is created outside the Job, so the Job's own evidence never shows it. The only packaged members a Job ever held were
descendants that inherited a packaged root's own identity under the desktop app policy, and those were contained.

**An escape R2 can never see (measured by the second review of #232, 2026-11-18).** A raw Job built like the host's
(kill-on-close, the completion port attached before the root joins) with a Store pwsh 7.7 root started under
`DISABLE_PROCESS_TREE`. The root started `cmd.exe` (System32, unpackaged) with the attribute set to
`ENABLE_PROCESS_TREE`, and that cmd started node. Neither cmd nor node posted `NEW_PROCESS`, the Job's process count
still matched the messages received, and node was outside the Job and survived the Job's close. Under an unpackaged
Windows PowerShell root the same call kept both in the Job, and node died with it. So:
- A packaged root may opt its own children out of the desktop app environment, and Windows then creates them outside
  the Job: they never join it, so no membership message, accounting check or package read can see them. Narrowing 1
  (the root's own package) is not the cause; the child never joins.
- It applies only under a packaged root, that is a Store pwsh started as the Job's root (R1's sessions, `process.run`
  with `shell: "pwsh"` where only the Store's pwsh is installed, a bare `process.start pwsh` or a check run by a Store
  program, per R3 below). It is M3's shape (§2), the one lifting Codex's refusal depends on.
- R1 is still a net gain: before it, the Store pwsh itself started outside the Job (row 1).
- What would close it: preferring an unpackaged shell root wherever one is installed (an MSI pwsh, or Windows
  PowerShell for the pwsh shell), so no packaged root is ever the Job's root for a workload that can ask for this; or
  refusing a packaged root outright. Neither is done here: both change which program a worker's shell is, which is the
  owner's choice, and the measurement shows a Store pwsh root keeps every ordinary descendant (the table above).

**What the packet does:**
- **R1.** A pwsh shell session is the Job's root (`shell-session.ts` `sessionLaunch`), as `process.run`'s pwsh is: the
  managed launch pins the package's own `pwsh.exe` and the Job host starts it with the policy. Real-host pin
  `shell-session-native.test.ts` "R1: a Store pwsh shell session's child dies with its Job" (Start-Process node, the
  Codex shape) passes; with main's `cmd.exe /d /c pwsh.exe` it fails (node outlives the session's stop; both reviews
  confirmed this with the mutation). `shell-session-native` is not in PR CI, so CI's only R1 coverage is the static pin
  in `static-adapter-policy.test.ts`.
- **R2.** The Job host associates a completion port with the Job before the root joins and reads each non-root member's
  package identity. Evidence (kept durably by the supervisor, never cleared; a test reads it from the supervisor's last
  durable status line) is:
  - a packaged member that does not carry the root's own package under the root's policy;
  - a member that could not be identified: it could not be opened for a reason other than having exited, or its
    membership or package could not be read;
  - the Job's `TotalProcesses` ahead of the messages received;
  - a watch that fails, or a settle past its ceiling;
  - a member event that could not be written. A failed write stays pending and is retried at every wake of the watch
    (at most 100 ms apart); one still pending when the workload ends by itself fails the host with
    `windows_job_membership_evidence_lost`, which the supervisor keeps as evidence;
  - an interactive host that ended after its workload started with neither a natural stop (the only path that settles
    the watch) nor a stop the Runner requested: it failed or could not write its events, so its watch never settled.
    This covers a coded line that could not be written either (a test makes the event file unwritable for it);
  - an interactive host that ended **before** its `started` line with no stop request (third review). The host writes
    that line only after it resumes the workload, so a host whose event file cannot take it, or one killed from outside
    between the resume and the line, ran its workload unwatched. The supervisor ends such a launch as a failed start
    ("ended before it reported that its workload started") and keeps the unsettled watch as evidence. The only hosts
    exempt are one never sent its workload and one that reported a failure before any process was created: the host
    adds `"launched": false` to its error line only when CreateProcess never returned a process (a coded R4 or watch
    refusal, or a file it cannot start) or when it failed before entering its launch at all. Those still end as the
    coded or plain startup failure they were. A test fault (`started_emit_unwritable`) leaves the host silent after the
    resume.

  A Job with evidence is never verified empty (`cleanup_blocked`, `verified_empty_failed`, with the packaged text),
  never released (`process_stop_unproven_packaged_descendant`) and never retired by record retention.
  Two deliberate narrowings of §4.2's literal rule ("a packaged non-root process ran in the Job"):
  1. **The root's own package.** A member with exactly the root's package under the root's policy is not evidence:
     measured above, the literal rule would mark every Store-pwsh-rooted stop unproven (they were all contained).
  2. **A member that already exited.** A member that is gone before the watch opens it (`ERROR_INVALID_PARAMETER`), or
     whose PID now names a process outside the Job, is not evidence. Short-lived members whose parent drops its handle
     at once (`start /b`, a sequential `cmd /c`) did that routinely (the plain-burst test failed intermittently on
     Win32 87 before this rule). The window is the watch's latency from the member's message to its open, which grows
     under load; it applies only once every handle to the member is closed: a member that exited while something still
     holds a handle to it opens, reads `IsProcessInJob` true and returns its package, so it is judged like a live one
     (measured by the second review). No measured shape put a packaged program in the Job as a member, so the residual
     gap is a packaged member that exits within that latency after starting children outside the Job.

  The watch thread runs at high priority, ends when it settles, and is stopped before the host closes the Job handle on
  every path, so it never queries a closed handle (the first review found that race producing false evidence on clean
  stops). Its settle waits for an event, never a sleep, under a 5000 ms ceiling: 120 of 120 natural-end settles took
  under 1 ms here (single process, 40 sequential and 40 detached children, a Store pwsh root starting node; idle and
  under 4 and 6 busy cores of 16), reported by the host's `watch_settled` event.
- **What R2 proves and does not.** Every product Job is interactive (`windows-process-backend.ts` launches with
  `interactive: true`; the host's non-interactive path is unused in product). Only a workload's natural end settles the
  watch. Every stop the Runner makes (`process.signal`, a `process.run` timeout or cancel, a session's stop, run close,
  a spare's retirement) ends the host with TerminateProcess, without settling. So R2 proves that no packaged program
  other than the root's own inherited package was in the Job, among the members the watch handled before the end:
  members that joined earlier were reported when they joined; a member that joined in the last moments before a kill,
  or an accounting mismatch younger than two 100 ms checks, can go unreported, and a write still pending at a kill is
  lost. Settling those stops needs a stop request the host serves itself (TerminateJobObject, settle, then its
  terminal event), with the kill kept as the fallback and a killed host counting as unsettled: a follow-up. R2 does
  **not** see a packaged program that a descendant starts, because Windows creates that one outside the Job (every
  escaping row above), nor the packaged root's own opt-out above. R3 and Codex's refusal remain the protection for
  those shapes, plus the existing output rule: an escapee that holds an inherited stdout or stderr open leaves the
  stop's output unsettled.
- **PID reuse (recorded, not changed).** A released member's PID can be reused before the watch opens it. If the new
  process is one the Runner cannot open (`OpenProcess` returns 5 for SYSTEM and other sessions' processes), the member
  reads unidentified and the Job is wedged as `cleanup_blocked`. It is rare and fails closed. A live member keeps its
  PID, so reuse can never hide one.
- **R3.** `%LOCALAPPDATA%\Microsoft\WindowsApps`, its per-package folders, the Program Files package root and a package's
  folder on another volume's package root (`<drive>:\WindowsApps\<Name>_..._<PublisherId>`) leave a Windows child's PATH,
  compared on the entry and on its real path (a junction or an 8.3 name that reaches them counts), each entry resolved once (`child-environment.ts` `isWindowsAppsPathEntry`,
  decision `removed_packaged_alias_path`). The patterns are anchored to those folders, so an unrelated folder merely
  named `WindowsApps` stays. The launch's **own program** is still looked up on the PATH that keeps them, in their
  places (`withChildEnvironment`'s root-program environment), and an alias found there is pinned to its package's own
  program and started as the Job's root, as R1's pwsh is (a folder is recognised the same two ways as the child's filter,
  so a folder the child lost through a junction is pinned too): `process.start pwsh` or `python3`, a final check run by a
  Store `python3` or `winget`, and the final-check tool lookup, which searches the same PATH, all work as on main
  (real-host test `windows-store-root-programs.test.ts`, guarded per program: it checks that the Job record of the check
  and of `process.start` names the package's own program and never the alias, that a long-lived Store workload dies
  with `process.signal`, and that a junction to WindowsApps is pinned). Only the root's children lose those
  folders: `pwsh`, `python3` or `py` typed inside a worker's shell does not resolve to a Store program. I chose this
  over a coded "found only under WindowsApps" reason because the program is installed and the owner can do nothing
  about it; a packaged root under the host's policy keeps its ordinary descendants in the Job (the table above), and R2
  stays the backstop. It does widen where a packaged root can appear (the escape above): an MSI or other unpackaged
  install earlier on PATH still wins, as before.
- **R4.** On Windows 10 1703 (build 15063) or newer, a failure to build or update the attribute list refuses the launch
  with `windows_job_desktop_policy_unavailable` before CreateProcess; a failure to watch the Job refuses with
  `windows_job_membership_watch_unavailable`. The version comes from `RtlGetVersion` with the Unicode structure (276
  bytes; an unknown version expects the policy). The code reaches the caller: a refused `process.run` returns it with
  the host's words, and a spare claim keeps it. Main's supervisor reported such a host-side failure in the interactive
  path as a clean stop with pid 0; it now ends as the coded startup failure.
- **Pre-existing, not changed.** A `process.start` whose Job host fails before its workload runs (a refused launch, or
  a file CreateProcess cannot start) reports `managed_process_failed` ("Managed failed start retains unverified exact
  cleanup") and its run then fails to close. Main does the same for a CreateProcess failure; it is a follow-up for the
  managed runtime's failed-start cleanup.

**Update 2026-11-20.** Codex's Windows refusal was lifted after Codex's own source settled M1 and M3 and a fake Codex reproduced the escape under the real Job: docs/plans/2026-11-14-cli-workers.md §3.11c.

**Not changed (2026-11-18).** Codex CLI workers stay refused on Windows. Lifting that still needs the owner's trace (§4.1), a
CW0-style measurement with Codex runs and an answer to the packaged-root opt-out above, with the owner's go. No host
census, per-PID killer, breakaway, or change to the user's Codex config.

## 7. The Start-Process gap: the stop-time escape sweep (2026-11-20)

The one escape §6 and the CLI workers plan §3.11c left open: `Start-Process pwsh` (or cmd's `start pwsh`) in any
worker's command uses ShellExecuteEx, which finds a Store-only program through the App Paths keys
(`HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths\pwsh.exe` names
`C:\Program Files\WindowsApps\Microsoft.PowerShell_7.7.0.0_x64__8wekyb3d8bbwe\pwsh.exe` here, and the same for the
Python install manager's `python.exe`/`python3.exe`, `winget.exe` and `wt.exe`), although R3 took WindowsApps off the
child's PATH. The program is created outside the Job and outlived a stop the Runner reported as proven.

**Measured (this PC: Windows 10 19045, Store pwsh 7.7 only; a raw Job built like the host's: kill-on-close, the desktop
app policy on a Windows PowerShell root; not elevated).**

| Escapee | In the Runner's Job | In any job | Parent | Created | Session | Root's environment | Assign to the Job |
|---|---|---|---|---|---|---|---|
| Store pwsh, by `Start-Process pwsh` | no | yes (its package's) | the Job member that ran `Start-Process` | after that member | the same | **inherited** (a marker set on the root is there) | refused, Win32 5 |
| Store pwsh, by its full path (`Process.Start`) | no | yes | the same | after | the same | inherited | refused, 5 |
| node, started by that pwsh | no | **no** | the escaped pwsh | after it | the same | inherited | succeeds (then dies with the Job) |

- The full-path row shows the gap is not ShellExecuteEx's alone: any packaged program a Job descendant starts escapes
  (§6 row 2 measured the same). ShellExecuteEx is only the way a name still reaches one after R3.
- The Runner can end the escaped pwsh by a handle it holds (TerminateProcess), but cannot put it back in the Job.
- Without admin there is no process-creation watch: `Win32_ProcessStartTrace` answers "Access denied". (This user is in
  Performance Log Users, which could start an ETW session, but that is not a product assumption.)
- So the only Runner-side evidence that ties an escapee to the attempt, without the worker's help, is its inherited
  environment.

**The owner's two ideas, weighed.**
1. *Ask workers to close what they start.* Kept as a layer: one line in every editing role's kernel invariants
   (`RUNNER_PROCESS_CLEANUP_LINE`, agent-prompts.ts) and in the CLI worker's rules (cli-worker-adapters.ts). It never
   proves a stop: a worker stopped at its deadline or cancelled mid-turn gets no chance, and it cannot know what its
   tools start.
2. *Workers report their PIDs.* Not built. A reported PID can only point at a process the sweep below already finds by
   its mark, and misses what matters: a worker cut off mid-turn reports nothing, and an escapee's own children (a dev
   server's node under the escaped pwsh) are never listed. Taking the PIDs as a hint would add an untrusted input and
   no coverage.

**The fix (owner's decision 2026-11-20; DECISION 2026-09-19 §8.1 as amended).**
- **The mark.** On Windows every process the Runner starts for an owner (run and agent session) carries
  `AIBOARD_PROCESS_MARK=<32 hex>`, random per session (process-escape-marks.ts, set by child-environment.ts like
  `AIBOARD_MCP_DEPTH`: a caller's override is rejected). It is issued on the owner's first launch and written to the
  run's state (`<run>/process-marks/`), so a stop retried after a restart still sweeps it. Its issue time bounds the
  sweep. That time is the Runner's wall clock: a system clock set back during a Build could make a later escapee look
  older than the mark, and the sweep would skip it.
- **The sweep.** After the owner's managed stop (`ManagedProcessService.closeAgent`, which the worker, subagent,
  Architect and verifier stop paths call after their language and MCP servers are closed) and at the run binding's close
  (after every recorded process is released), the Job host's helper runs `ManagedProcessEscapeSweep`
  (managed-process-job-host.ps1, `--aiboard-escape-sweep`; launched by `sweepMarkedWindowsProcesses`). It takes one
  Toolhelp snapshot and, for each process of the Runner's own session, opens one handle and reads through it: the
  creation time (older than the mark: never looked at), the user (another user: skipped), and the environment from the
  process parameters. Only an exact `AIBOARD_PROCESS_MARK=<value>` entry makes it the owner's. It is then ended with
  TerminateProcess on that same handle and its exit waited for (30 s, the root ender's bound). The snapshot repeats
  while it keeps finding marked processes (a child started meanwhile), at most 8 rounds.
- **Fail closed.** The owner's stop is unproven (`process_cleanup_unverified`, so #220 keeps the worktree claim and
  pauses) when a marked process cannot be ended or its exit is not seen; when one sits inside some job without being
  packaged (it may be a live Runner Job member, or in a job the Runner cannot attribute; it is never ended); when its
  job or package cannot be read; when 8 rounds still found new ones; or when the sweep itself fails (its PowerShell
  does not report ready within the Job host's start ceiling, or its report within 60 s, or reports an error or a
  malformed report).
- **Unreadable processes (the owner's question).** A process of this session created after the mark whose handle
  cannot be opened for reading (an elevated or protected one), whose token or environment cannot be read, is recorded
  in the run's sweep log (`<run>/process-marks/sweeps.jsonl`, with every sweep's ended and unended lists) and never
  ended. It does not by itself leave the stop unproven: nothing attributes it to the owner, and the owner's own elevated
  tools started during an attempt would otherwise block every stop (DECISION §8.4). Two consequences: the log keeps the
  image path of each such process of the owner's (an elevated or protected program created during a Build) in the
  run's state; and a marked escapee whose environment read fails only at that moment is skipped like the rest, so the
  stop can read proven with it alive. Re-reading such entries once in a later round would narrow that; it is not done.
- **A live launch of the same session.** The sweep never runs beside a live Runner-owned process that shares the mark:
  it would end one that is packaged and fail on one that is not. So a session's sweep first requires every launch of
  that session (and of its subagents) to be released in the run's own stores: managed records, streaming sessions
  (language and MCP servers, managed processes) and one-shot commands. A live one leaves the stop unproven, and the
  retried stop sweeps once it is gone. So every stop path closes the session's other launches before its managed
  stop: language and MCP servers everywhere, a subagent's managed Build tools (its managed stop is now outermost,
  subagent-tools.ts), and a worker's subagents before the worker's own managed stop in `retryStop`
  (native-worker-driver.ts); the review's re-check found those two orders reversed. Current callers give each actor its
  own session.
- **Subagents and launches during a sweep.** A session's sweep covers its subagents' sessions
  (`<session>:subagent:<id>`), because after a restart the worker's retried stop reaches only the subagents with a
  managed record left. A session with no launch since its last settled sweep is not swept again (nothing can carry its
  mark that was not there before), and a launch during a sweep keeps the session pending.
- **A known cost to the owner.** A Store program a worker started that the owner then uses (a single-instance app such
  as Windows Terminal or Notepad on Windows 11) is ended at the worker's stop, with any unsaved work in it.
- **Not covered.** 32-bit Windows (the sweep reads 64-bit process parameters; there every Windows stop would be
  unproven). A transient run (a CLI Test or check) removes its whole folder after its proven close, sweep log
  included.

**What it proves and what it does not.** It is detection, not proof. It finds every live escapee that kept the
worker's environment, whatever started it and however deep. It does not see a packaged program started without that
environment (`Start-Process -UseNewEnvironment`, a launch through Explorer, COM, WMI or the Task Scheduler: Model B/C,
outside the native contract), a program that scrubs its own environment, or one that exits before the stop.
- **A CLI that does not pass its environment on.** The real-Codex run (Codex CLI 0.171.0, plan §3.11c, docs PR #253)
  counted environments: Codex's command shells (57–69 variables), the `Start-Process` server (57) and its hook shells
  carry Codex's whole environment, so they carry the mark. Its stdio MCP servers got only 19–22 (Codex's source:
  `rmcp-client` starts them with `inherit: Core`, a fixed allowlist), so a Store program an MCP server Codex runs
  starts by name is not seen. A user's own Codex `shell_environment_policy` (`inherit = "core"` or `"none"`, `exclude`,
  `include_only`) can drop the mark from commands too. Codex's default excludes match names containing KEY, SECRET or
  TOKEN, which the mark's name avoids. The counts were measured, not the mark itself.
- **The packaged-root opt-out of §6.** Such a child also inherits the environment, so the sweep is expected to end it
  when it is unpackaged and in no job; that was not measured.

**Tests.** `windows-start-process-escape.test.ts` (real host; it needs a pwsh that exists here only as a Store app and
skips elsewhere): a worker's one-shot `Start-Process pwsh` server and the node it starts are ended by the owner's stop,
another owner's escapee and an unmarked process are not, and the sweep log records both ended processes; an injected
terminate failure leaves the stop unproven (`isProcessStopUnprovenError`) and a retried stop ends it; the run's close
ends an escapee no owner stop swept; a child carries the persisted mark. With the sweep calls removed (main's
behavior) the first three fail: the Store pwsh survives the stop, the stop reads proven, and the run's close leaves it.
Two more cases run on any Windows host (CI included): a marked process alive in a live Runner Job of another actor of
the session leaves the stop unproven and is left alone, and the sweep asked directly reports it `in_job_not_packaged`
without ending it (a mark nobody carries, or a later start time, ends nothing); a sweep that fails at the run's close
leaves the close failed, and a retried close proves it. `process-escape-marks.test.ts` (portable, in PR CI): the
mark's issue, persistence and restart; what each report means for the stop; subagent sessions and a launch during a
sweep; the environment rules; where `closeAgent` runs the sweep. The independent review of the first version found
the live-launch, subagent and launch-during-sweep gaps (all latent with today's callers); they are fixed as above.
