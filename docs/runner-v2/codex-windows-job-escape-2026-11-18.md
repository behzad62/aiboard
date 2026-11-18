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
