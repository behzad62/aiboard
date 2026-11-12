# VF7a: the Playwright CLI under the Runner's process containment

Date: 2026-11-13
Packet: VF7a of `docs/plans/2026-11-13-build-verification.md` (§2.3, §4.5 "Browsing", §6 VF7a/VF7b, §8). A spike: no product code changed.
Read at: 77bf16f5 (branch `claude/vf7a-playwright-cli-spike-1cf63b`, cut from `claude/build-verification-plan`).
Hosts:
- Windows 10 Pro 10.0.19045, Node 24.18.0, Playwright 1.61.1, Chrome (per-user and machine-wide) and Edge installed, Playwright's own Chromium 1228 cached.
- Linux: Docker `node:24-bookworm` (Debian 12, Node 24.21.0, kernel 6.18 WSL2), user `node` (uid 1000), `npm ci --ignore-scripts` from a `git archive` of 77bf16f5. No Chrome or Edge; Playwright's Chromium 1228 installed inside the container only.
- macOS: no machine. §8 says what should carry over and what VF7b's CI must prove.

Harness: `vf7a-harness.mts` (Appendix A) uses the Runner's real process code: `createExecutionHost` → `bindRun` → a `ToolBroker` with `createProcessTools` (`process.run`, through `OneShotCommandExecutor`) and `createManagedProcessTools` (`process.start`, `poll`, `signal`, through `ManagedProcessService`). That is the path a Build worker's tool calls take. After every step it takes an OS process census of CLI daemons and Playwright browser processes. It lives outside `runner-v2/src` and was run from the scratchpad.

## 1. Answers in short

| # | Question | Windows | Linux |
|---|---|---|---|
| 1 | Does the release bundle carry the CLI? | Yes. The closure check passes, and a copy of exactly the bundle's package closure holds every CLI file and the skill. | Yes. The CLI ran from that copy: `open`, `snapshot`, `screenshot` and `close`. |
| 2 | What does a session start? | A Node daemon (`playwright-core/lib/entry/cliDaemon.js <session>`) and one headless browser (6–8 `chrome.exe`). State: `%LOCALAPPDATA%\ms-playwright\daemon\<hash>\<session>.session`; named pipe `\\.\pipe\pw-<userhash>-cli-<hash>-<session>`. | Same daemon; 8–10 browser processes, including two `chrome_crashpad_handler`. State: `~/.cache/ms-playwright/daemon/<hash>/`; socket `$TMPDIR/pw-<userhash>/cli/<hash>-<session>.sock`. |
| 3 | Under `process.run`, does the session survive between calls? | **No.** The detached daemon stays in the call's Job, so `process.run open` blocks until its timeout (90.9 s for a 90 s timeout) and reports "Process exceeded … ms". Then the Runner kills the Job, and the next call finds no session. | **Yes, but outside the Runner.** `open` returns in 3.4 s. The daemon, Chrome and crashpad each run in their own session, outside the Runner's process group. If the task ends without `close`, the daemon and 10 browser processes are **left running**. |
| 4 | As a managed process? | **Works.** `process.start node cliDaemon.js <session>` (ready on "Daemon listening on"), then any number of `process.run playwright-cli …` calls, then `close` (exit 0). Nothing is left after `close`, `process.signal SIGTERM`, `SIGKILL`, the task's end, or a kill of the daemon's PID alone. | **Works,** with the same results for every kill kind. But Chrome and crashpad are outside the owned process group: they exit because Chrome quits when its DevTools pipe closes (0.03–0.25 s), not because the Runner kills them. A hung (stopped) daemon keeps Chrome alive until the daemon is killed. |
| 5 | Which browser? Exact error when none? | Default is the `chrome` channel only, with no fallback: per-user Chrome first (`%LOCALAPPDATA%`), then Program Files. `--browser=msedge` uses Edge. Errors in §6. | No Chrome or Edge in the image; `--browser=chromium` uses Playwright's Chrome for Testing. Errors, including missing system libraries, in §6. |
| 6 | Where do snapshots and screenshots go? | Auto-named files go to `<daemon cwd>/.playwright-cli/`, or to `PLAYWRIGHT_MCP_OUTPUT_DIR` when the daemon has it. `--filename=` is relative to the calling command's cwd. Both can point into the worktree. | Same. |

**Recommended design for VF7b (§9):** the task's session is a managed process that runs the CLI daemon in the foreground, never `playwright-cli open`. It is named per task and gets a task-owned state folder. Models reach it through a `playwright-cli` shim that refuses `open` and the commands that would escape. VF7b needs no change to ownership, fencing or containment rules. One question goes to the lead and the independent review (§9.6): on POSIX the Runner's "every process it started has exited" covers only the process group, and the browser always leaves that group. For POSIX I recommend a Runner check, after the stop, of the browser processes it can attribute to the task; it only adds cleanup and takes nothing away.

## 2. The bundle (question 1)

- `scripts/release/bundle-contents.mts:11` lists `playwright` in `RUNTIME_PACKAGES`. `build-bundle.mts` `dependencyFiles()` walks the lockfile closure from it, so `playwright-core` is shipped too, and each package's files are copied whole (it skips only each package's own `node_modules` and its optional dependencies).
- `npx tsx scripts/release/test-bundle-closure.mts` → `PASS the release bundle's import closure is complete` (on 77bf16f5).
- A full bundle build needs the pinned Node archive from nodejs.org, which was not cached on this machine, so I did not build one. Instead, `vf7a-bundle-sim.mts` (Appendix B) repeats the `dependencyFiles()` walk and copies exactly that file set:
  - 10 packages, 1,285 files; left out as optional: `playwright -> fsevents` and the eight `@github/copilot-*` platform packages.
  - 168 files of `playwright` + `playwright-core`, including every file the CLI uses: `playwright/cli.js`, `playwright/lib/program.js`, `playwright-core/{package.json,browsers.json}`, `lib/coreBundle.js`, `lib/utilsBundle.js`, `lib/entry/cliDaemon.js`, `lib/tools/cli-client/{cli.js,program.js,session.js,registry.js,help.json}`, and the skill: `lib/tools/cli-client/skill/SKILL.md` (11,869 bytes) and its 10 `references/*.md`.
  - In the container, the CLI ran from that copy (`/tmp/bsim/app/node_modules/playwright/cli.js`, no other `node_modules` on the resolution path): `open`, `snapshot`, `screenshot --filename=bsim.png` (9,687 bytes), `close`. The daemon's registry folder got its own hash (`cd44e5d26c3c99fc`), so the daemon itself loaded from the copy.
- `fsevents` (left out) is only required inside the bundled chokidar file watcher, in a `try/catch` (`playwright-core/lib/serverRegistry.js:5952`, `utilsBundle.js:40331`), so its absence on macOS is harmless.
- The bundle has no `node_modules/.bin`, so there is no `playwright` or `playwright-cli` command on PATH. VF7b must add its own shim, as §4.5 already says.
- With `CLAUDECODE` or `COPILOT_CLI` set, `playwright cli --help` prints the skill's path (`Agent skill: …/cli-client/skill/SKILL.md`), so CLI workers find it themselves.

## 3. The session process (question 2)

Read from `playwright-core/lib/tools/cli-client/{program,session,registry}.js` and the `cli-daemon` part of `lib/coreBundle.js`, and checked on both hosts.

- `playwright cli <cmd>` is a short-lived client. `open` (and `attach`) spawns the daemon with `spawn(process.execPath, [cliDaemon.js, <session>, …flags], { detached: true, stdio: ["ignore", "pipe", <errfile>] })`, waits for `Daemon listening on`, and calls `unref()`. Every other command connects to the daemon, sends one `run` message and exits. `close` sends `stop`, and the daemon exits after closing the browser.
- `detached: true` means a new session (`setsid`) on POSIX. On Windows it means `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` without breakaway, so the daemon stays in the parent's Job. That one flag explains question 3.
- The daemon launches the browser through Playwright's `launchProcess`, also with `detached: process.platform !== "win32"`, and with `--remote-debugging-pipe`. On Linux, Chrome is therefore another session leader. Its `chrome_crashpad_handler` processes double-fork into sessions of their own (ppid 1). Seen in the container:

  ```
  PID   PPID  PGID  SID   COMMAND
  1291     1  1291  1291  node …/cliDaemon.js lib --browser=chromium      (client exited; re-parented to init)
  1303  1291  1303  1303  …/chrome-linux64/chrome --… --remote-debugging-pipe
  1305     1  1304  1304  …/chrome_crashpad_handler --monitor-self …
  1307     1  1306  1306  …/chrome_crashpad_handler --no-periodic-tasks …
  1310  1303  1303  1303  …/chrome --type=zygote …   (zygotes, gpu, utility, renderers: all in 1303's session)
  ```

- The daemon exits on `stop`, on SIGINT, SIGTERM or stdin close (`setupExitWatchdog`, which closes the browser gracefully first, within 15 s), and when its browser context closes. **I found no idle timer** in 1.61.1's daemon: the one-hour close the plan quotes from the playwright-cli README does not exist in this version, so VF7b must not rely on one.
- **State and naming:**
  - Session name: `-s=<name>` / `--session`, else `PLAYWRIGHT_CLI_SESSION`, else `default`.
  - Registry: `<base>/<workspaceHash>/<session>.session` (JSON with the socket path, version and launch options) and `<session>.err`. `<base>` is `%LOCALAPPDATA%\ms-playwright\daemon` on Windows, `${XDG_CACHE_HOME:-~/.cache}/ms-playwright/daemon` on Linux, `~/Library/Caches/ms-playwright/daemon` on macOS. `PWTEST_DAEMON_SESSION_DIR` overrides it.
  - `workspaceHash` is the SHA-1 of the nearest ancestor folder (up to 10 levels) that contains a `.playwright` folder. Without one, it is the hash of the **playwright-core install folder**, so every worktree on the machine shares one namespace. Two tasks that both use `default` would stop each other's session (`open` stops an existing session of the same name first).
  - Socket: Windows `\\.\pipe\pw-<sha1(USERNAME)[0:8]>-cli-<workspaceHash>-<session>`; POSIX `$TMPDIR/pw-<sha1(USER)[0:8]>/cli/<workspaceHash>-<session>.sock`, at most 103 bytes (a longer folder fails with "Socket directory path is too long … set PWTEST_SOCKETS_DIR"; a long name is shortened with a hash, so names do not collide). On POSIX `sanitizeForFilePath` turns `_` into `-`, so `a_b` and `a-b` share a socket file.
  - Profile: the default is an isolated, in-memory context. Chrome's temp profile is `$TMPDIR/playwright_chromiumdev_profile-XXXXXX`; Playwright also makes `playwright-artifacts-XXXXXX`. Both are removed on a graceful close and **left behind after a hard kill**: this spike's Windows hard-kill runs left 7 such folders in `%TEMP%`, and the container's `/tmp` kept several. Stale `.session` files and sockets are left too (the CLI prunes a stale entry when `list` or a connect fails).
  - Config: `.playwright/cli.config.json` under the daemon's cwd, `~/.playwright/cli.config.json`, `--config=`, and `PLAYWRIGHT_MCP_*` variables in the daemon's environment (`PLAYWRIGHT_MCP_OUTPUT_DIR`, `_BROWSER`, `_EXECUTABLE_PATH`, …).
- **No authentication.** Any process of the same user can connect to any session's pipe or socket. Session names isolate tasks by convention, not by access control (§7).

## 4. CLI commands under `process.run` (question 3)

Scenario `run-only` (Appendix A): `open`, `snapshot`, `screenshot`, `list`, `close`, each a separate `process.run` call; `run-no-close` ends the task after `open`; `control-detached` runs a plain Node script that leaves a detached child sleeping 15 s.

**Windows (Job Object):**
```
process.run cli -s=vf7a-run open http://127.0.0.1:60079/ -> isError=true 90910 ms
  {"exitCode":0,"error":"Process exceeded 90000 ms.","timedOut":true}
  ### Browser `vf7a-run` opened with pid 22608.   (the client's output arrived at once)
CENSUS after process.run open: daemons: none; browser processes: 0
process.run cli -s=vf7a-run snapshot -> {"exitCode":1}  Error: Browser 'vf7a-run' is not open.
control process.run (timeout 30000) -> 17218 ms {"exitCode":0}; detached child alive after the call returned: false
control process.run (timeout 5000)  -> 5402 ms {"exitCode":0,"error":"Process exceeded 5000 ms.","timedOut":true}; child alive: false
```
On Windows, a `process.run` call ends only when its whole Job is empty. A detached child keeps the call open and is killed at the timeout. Containment holds, but `open` costs the full timeout (120 s by default), comes back as a failure, and the session dies with the call. Unusable as is.

**Linux (process group):**
```
process.run cli -s=vf7a-run open … --browser=chromium -> isError=false 3377 ms {"exitCode":0}
CENSUS after process.run open: daemons: 1786(pgid 1786 sid 1786 ppid 1); browser processes: 10 [main 1815(sid 1815 ppid 1786), 1821(sid 1820 ppid 1), 1823(sid 1822 ppid 1)]
process.run cli -s=vf7a-run snapshot -> {"exitCode":0} (works: the session survived)
run-no-close: CENSUS 5 s after task end: daemons: 2343(sid 2343 ppid 1); browser processes: 10  → LEFT BEHIND
control process.run (timeout 30000) -> 1551 ms; detached child alive after the call returned: true
control process.run (timeout 5000)  -> 2215 ms; detached child alive after the call returned: true
```
On POSIX the call ends when its process group is empty. A `setsid` child is outside the group, so the Runner neither waits for it nor kills it, and neither does the task's end. The CLI session therefore survives between calls only because it escaped the Runner, and it leaks when a model forgets `close` (or the Runner stops first). The control shows this holds for any detached program, not only Playwright (§7.1).

`process.start` of the client's `open` (scenario `start-open-client`) behaves the same way: on Windows the managed process stays "running" while its Job holds the daemon, and on Linux the managed client exits at once and the daemon escapes (ppid 1). **No design may start the session with `open`.**

## 5. The session as a managed process (question 4)

The design under test: `process.start {command: node, args: [<playwright-core>/lib/entry/cliDaemon.js, <session>, --browser=…], until: {pattern: "Daemon listening on"}, waitMs: 30000}`. That runs the daemon in the foreground as the managed workload, with no detach. Later calls are ordinary `process.run node <playwright>/cli.js cli -s=<session> <cmd>`.

- Start: 1.3–2.3 s on Windows, 1.1–2.0 s on Linux. Each later command through `process.run`: 1.4–3.7 s on Windows, 1.6–3.3 s on Linux (most of it is Node and Runner start-up per call).
- The registry and socket are found because the client and the daemon compute the same workspace hash and registry folder (same Playwright install, same `LOCALAPPDATA`/`HOME`). The Runner's environment filtering keeps both.
- Two tasks (scenario `two-tasks`) with distinct names ran side by side; ending task B removed only B's daemon and browser. But task A's `list` showed B's session, and task A's `process.run cli -s=vf7a-task-b eval location.href` drove B's browser (§7.2).

Kill kinds. "Left" = CLI daemons plus browser processes (on Linux, Chrome's whole session plus every `chrome_crashpad_handler`) still alive at the census. Each census ran 0.5–1 s after the action, again 3–5 s later, and after the task ended.

| Kill kind | How | Windows | Linux |
|---|---|---|---|
| CLI close | `process.run cli close`, then poll | daemon exit 0; left: none | exit 0; left: none |
| Runner tree kill, SIGTERM | `process.signal SIGTERM` (530 ms Win, 994 ms Linux) | left: none | left: none |
| POSIX SIGKILL / Job termination | `process.signal SIGKILL` (799 ms Win, 946 ms Linux) | left: none | left: none (Chrome quit on pipe EOF) |
| Task end (run binding closed, `stopRun`) | `run.close()` with the daemon running | left: none | left: none |
| Parent-only kill | harness kills the daemon's PID only (TerminateProcess / SIGKILL) | left: none at 0.5 s; poll: stopped, exit 1 | left: none at 0.5 s; poll: stopped, SIGKILL |
| Process-group kill of Chrome only (Linux) | `kill -9 -<chrome pgid>`, daemon kept | n/a | all gone ≤ 29 ms; the daemon exits by itself |

On Windows each "none" is the Runner's own proof: the Job held every process. On Linux the Runner reported, for example, `{"status":"stopped","confirmed":"The process and every process it started have exited …"}`. That is proven only for the daemon's process group. Chrome and crashpad were gone by the census because of Chrome's own behaviour, which `vf7a-linux-orphans.sh` (Appendix C) measured without the Runner:

```
1. SIGKILL the daemon only (idle page)          chrome processes gone: 233 ms; crashpad gone: 3 ms (after Chrome)
2. SIGKILL the daemon, page spinning its thread  chrome gone: 106 ms; crashpad gone: 4 ms
3. SIGKILL Chrome's main process only            chrome gone: 28 ms; crashpad: 6 ms; daemon exits by itself: 27 ms
4. SIGKILL Chrome's process group                chrome gone: 29 ms; crashpad: 3 ms; daemon: 3 ms
5. SIGSTOP the daemon for 5 s                    Chrome keeps running (8 processes) while the pipe stays open;
                                                 after SIGKILL of the stopped daemon: chrome gone 79 ms, crashpad 3 ms
6. --disable-crash-reporter in launchOptions     crashpad handlers still start (2)
```

So on Linux "no browser left behind" rests on two things. The Runner proves the daemon is dead. Chrome then exits when its DevTools pipe closes, which it did in every case, within 0.25 s, and crashpad follows. Case 5 shows the Runner's kill of the daemon is what releases a stuck browser.

## 6. The browser (question 5); snapshots and screenshots (question 6)

- **Default:** `browserName: chromium, channel: "chrome"`, headless, 1280×720, isolated profile. There is no fallback: with Chrome missing, the default fails even when Edge or Playwright's Chromium is present. VF1/VF7b must pass `--browser=` (or `PLAYWRIGHT_MCP_BROWSER`) from the inventory.
- **Lookup** (`_createChromiumChannel`):
  - Windows tries `%LOCALAPPDATA%`, `%ProgramFiles%`, `%ProgramFiles(x86)%`, `%HOMEDRIVE%\Program Files`, `%HOMEDRIVE%\Program Files (x86)`, each + `\Google\Chrome\Application\chrome.exe` (Edge: `\Microsoft\Edge\Application\msedge.exe`). Here the default used the per-user Chrome, `C:\Users\…\AppData\Local\Google\Chrome\Application\chrome.exe`, and `--browser=msedge` used `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`.
  - Linux checks only `/opt/google/chrome/chrome` and `/opt/microsoft/msedge/msedge`; macOS only `/Applications/Google Chrome.app/…` and `/Applications/Microsoft Edge.app/…`.
- `--browser=chromium` means `chrome-for-testing`, Playwright's download in `ms-playwright/chromium-1228` (the full browser, not the headless shell). `--browser=firefox` names Playwright's Firefox; other engines were not tested.
- **Exact errors**, as the `open` client prints them (exit 1; first line `Error: Daemon pid=<n>: Daemon process exited with code 1`). Under `process.start` of the daemon, the same text comes on the managed process's stdout and the process exits 1 before "Daemon listening on" appears.
  - No Chrome (Windows, simulated by pointing `LOCALAPPDATA`, `ProgramFiles`, `ProgramFiles(x86)`, `ProgramW6432` at an empty folder and `HOMEDRIVE` at `Q:`; nothing was uninstalled):
    `[PlaywrightError: Chromium distribution 'chrome' is not found at <LOCALAPPDATA>\Google\Chrome\Application\chrome.exe` / `Run "npx playwright install chrome"] {`
  - No Edge (same simulation): `Chromium distribution 'msedge' is not found at <LOCALAPPDATA>\Microsoft\Edge\Application\msedge.exe` / `Run "npx playwright install msedge"`
  - No Chrome (Linux): `[PlaywrightError: Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome` / `Run "npx playwright install chrome"] {`
  - No Edge (Linux): `Chromium distribution 'msedge' is not found at /opt/microsoft/msedge/msedge`
  - No Playwright Chromium (Windows with `PLAYWRIGHT_BROWSERS_PATH` at an empty folder, and Linux): `Error: Browser "chrome-for-testing" is not installed. Run \`playwright-cli install-browser chrome-for-testing\` to install`
  - No Firefox: `Error: Browser "firefox" is not installed. Run \`playwright-cli install-browser firefox\` to install`
  - Linux, Chromium present but system libraries missing (before `install-deps`): the first line is the unhelpful `[TargetClosedError2: Target page, context or browser has been closed`, and the cause is a line further down under "Browser logs": `[pid=273][err] /home/node/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome: error while loading shared libraries: libnspr4.so: cannot open shared object file: No such file or directory`. VF1 should record the `error while loading shared libraries: …` line, not the first line.
- For VF1/VF2's `tool_missing`, match `Chromium distribution '<channel>' is not found` and `Browser "<name>" is not installed`. Better still, VF1 can ask Playwright's registry for the executable path in-process, with no launch, and keep a launch probe only for Linux libraries. Every one of these hints (`npx playwright install …`, `playwright-cli install-browser …`) is a download the plan forbids inside a Build (VD-4). VF2 should record the error text and show `aiboard browser install` as the remedy instead.
- Inside the container (root) I ran `npx playwright install chromium` and `npx playwright install-deps chromium`, which is allowed there because the container is thrown away. Nothing was downloaded on the Windows host.

### Snapshots and screenshots (question 6)

- **Auto-named files** (the snapshot after `goto`/`click`, console logs, a `screenshot` without `--filename`) go to the daemon's output folder:
  - `PLAYWRIGHT_MCP_OUTPUT_DIR`, or `outputDir` in the CLI config, when set;
  - otherwise `<daemon cwd>/.playwright-cli/`, or `<tmp>/.playwright-cli` when that cwd is a system folder or not writable.
  - The daemon's cwd is the cwd of `open`, or of the managed process.
- **`--filename=<path>`** is resolved against the cwd of the calling command (the client sends its cwd with every call). Its parent folder must exist; skill mode accepts any absolute path.
- The command output names each file relative to the caller's cwd, for example `- [Screenshot of viewport](aiboard-out\browser\page-2026-11-12T21-32-31-661Z.png)` or `- [Snapshot](shots\managed.yml)`. The `snapshot` command without `--filename` prints the tree inline instead.
- Shown on both hosts in `managed-close` (Windows file list after the run): `aiboard-out\browser\console-…log (122 B)`, `aiboard-out\browser\page-….yml (100 B)` ×2, `aiboard-out\browser\page-….png (7340 B)`, `managed.png (7340 B)`, `shots\managed.png (7340 B)`, `shots\managed.yml (100 B)`.
- So both kinds can be pointed into the task's worktree, and a check can name them as VF6 `outputs`: a glob over the daemon's output folder, or the exact `--filename` it chose. §9.3 says where the folder should be.

## 7. Other findings

1. **POSIX containment covers only the process group, for every program.** `control-detached` shows that any `process.run` or managed command can leave a `setsid` child running after its call and its task (`posix-process-backend.ts` attests `lifecycleScope: "process_group"`, `crash_cleanup: "unavailable"`). The managed-stop message "every process it started has exited" (`managed-process-tools.ts:517`) is stronger than that proof on POSIX. This predates the CLI and is outside VF7a. It is a follow-up for the lead, not part of VF7b.
2. **Sessions are isolated only by name.** One task can `list` and drive another task's session (shown on both hosts), and `kill-all` kills every CLI daemon of the user by command-line match (`program.js` `killAllDaemons`), other tasks' managed daemons included. A per-task registry (`PWTEST_DAEMON_SESSION_DIR`) hides other tasks' sessions: from another task's environment, `list` printed `(no browsers)` and `-s=iso-a` printed "not open". That is a convenience, not a boundary: a worker already runs arbitrary commands as the user.
3. **The CLI's exit code does not report command errors.** `screenshot --filename=shots/missing/x.png` exits 0 and prints `### Error` / `Error: ENOENT …`; with `--json` it prints `{"isError": true, "error": …}`, still with exit 0. Exit 1 is only for "not open" and usage errors. Checks and steps (VF3/VF4) that use the CLI must read `--json` output, not the exit code.
4. **The stock skill text conflicts with the Runner.** It tells models to `npm install -g @playwright/cli@latest` (a network install of another version), to `open` and `close` sessions, to use `--persistent` / `--profile=`, and to run `close-all` and `kill-all`. VF7b's AIBoard skill must be an edited copy (§9.4).
5. **The CLI writes wherever it is told.** In skill mode the CLI skips its file-root checks, so `--filename=` may be absolute or point outside the worktree. That matches `process.run`'s full access; VF6 collects only in-workspace outputs anyway.
6. `--filename=shots/x.png` fails with `ENOENT` when `shots/` does not exist (auto-named files do get their folder created).
7. On Linux, Playwright turns Chrome's sandbox off for Chrome for Testing and on for the `chrome` and `msedge` channels (`validateBrowserConfig`). Chrome refuses a sandboxed start as root, so a Runner running as root would need `chromiumSandbox: false` in the CLI config. Not tested: no Chrome in the image.

## 8. macOS (no machine)

Expected to carry over from Linux, because Node, Playwright and the Runner treat darwin as POSIX:
- `open` detaches the daemon with `setsid`, the Runner's POSIX backend is the same process-group backend, and the control result is OS behaviour. So `process.run open` escapes and leaks on macOS too.
- The managed daemon is in the Runner's group; Chrome starts `detached` (its own session) and is outside it.
- Chrome exits on DevTools pipe EOF (same Chromium code), so the managed kill kinds should leave no Chrome. Expected, not proven.
- Paths: registry `~/Library/Caches/ms-playwright/daemon`; socket under `$TMPDIR` (`/var/folders/…/T/`, about 49 bytes) with the same 103-byte limit, so session names must stay short.
- Lookup only in `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` and `/Applications/Microsoft Edge.app/…`.

Unknown on macOS: whether `chrome_crashpad_handler` leaves Chrome's process group or session there, and whether it exits with Chrome. Also unknown: where its database goes (`XDG_CONFIG_HOME` does not apply on macOS, so the Linux attribution trick in §9.3 may not cover it).

VF7b's portable CI (ubuntu-latest and macos-latest images ship Google Chrome, so `--browser=chrome` needs no download) must prove on each OS:
1. A managed session starts, serves at least three later `process.run` CLI calls, and stops with `close` with exit 0.
2. After each kill kind (`process.signal SIGTERM`, `SIGKILL`, the task's end, a kill of the daemon's PID alone, a kill of Chrome's main process alone) no daemon, no Chrome process and no crashpad process of that session remains within a bounded wait. Use a census like Appendix A's, keyed on the task's folder or PIDs, never on process names alone.
3. The shim refuses `open`, `attach`, `show`, `install*`, `close-all`, `kill-all` and a foreign `-s`.
4. Two tasks never share a session, and one task's environment cannot list the other's.
5. A hard kill leaves no profile or artifacts folder in the user's temp folder (they live in the task's folder).
6. The socket path fits in 103 bytes with the Runner's real state paths.

## 9. Recommended process design for VF7b

### 9.1 The session is a managed process running the daemon in the foreground
- Command: `<bundled node> <app>/node_modules/playwright-core/lib/entry/cliDaemon.js <session> --browser=<inventory choice>`, started through `ManagedProcessService` (the `process.start` path) with `until: {pattern: "Daemon listening on"}`. It is never started by `playwright-cli open` (§4).
- The Runner puts a `playwright-cli-session` command on PATH (a `.cmd` on Windows, an `exec`-ing `sh` script on POSIX) that runs exactly that, with the task's session name and environment. The session is then an ordinary command a model starts with its existing `process.start` tool: workers, the Architect after VF5, and the verifiers, which already have the process tools (role-capabilities.ts:56-68). A Runner-run final-check step starts the same command itself.
- This needs no new Runner capability and keeps today's ownership: the session is an owned managed process of that agent session, stopped by `process.signal` or when its owner ends (scenario `managed-run-end`: nothing left on either OS).
- Rejected: the Runner starting the session lazily on the first `playwright-cli` call. A shim inside a `process.run` tree cannot start an owned process; it would need a new channel from a child process back to the Runner, which is more ownership surface.
- Rejected: starting a browser eagerly for every task (8–10 processes per task, mostly unused).

### 9.2 Naming
- One session per owning agent session. The name is short and `[a-z0-9-]` only (`t-<8 hex>`), because of the POSIX socket budget and the `_`→`-` sanitizing.
- The Runner sets `PLAYWRIGHT_CLI_SESSION=<name>` in the environment of every process it starts for that owner, so `playwright-cli goto …` needs no `-s` (verified).

### 9.3 A task-owned state folder, removed with the task
Set for the daemon, and the registry variable for all of the owner's processes:
- `PWTEST_DAEMON_SESSION_DIR=<task>/pw/registry`: session files leave the shared namespace, and other tasks' sessions disappear from `list` and from `-s=` (verified). It is an internal Playwright hook, so pin it with a VF7b test that fails when a Playwright upgrade drops it.
- `TMPDIR`/`TEMP`/`TMP=<task>/pw/tmp` for the daemon only: the temp profile, the artifacts folder and the POSIX socket land in the task folder, so a hard kill leaves nothing in the user's temp folder. Keep the path short, or set `PWTEST_SOCKETS_DIR` to a short task-owned folder, to stay under 103 bytes.
- Linux: `XDG_CONFIG_HOME=<task>/pw/xdg` for the daemon. Crashpad's `--database` then points into the task folder (`--database=/tmp/task-7f3a/xdg/google-chrome-for-testing/Crash Reports`, instead of the user's `~/.config/…`). In the container, all 8 browser processes and both crashpad handlers carried the task folder in their command line (`vf7a-linux-taskenv.sh`, Appendix C), so every browser process the task started can be told apart from the user's own Chrome.
- `PLAYWRIGHT_MCP_OUTPUT_DIR=<worktree>/<outputs folder>`: auto-named snapshots, console logs and screenshots go to one known place in the worktree (verified). This is a VF6 coordination point: VF6 decides how outputs written into the worktree stay out of the task's commit. The CLI's default, `.playwright-cli/` under the daemon's cwd, has the same issue.

### 9.4 The `playwright-cli` shim and the skill
- The shim on PATH runs `<bundled node> <app>/node_modules/playwright/cli.js cli "$@"`, so the version always matches the skill.
- It refuses `open`, `attach`, `--cdp`/`--endpoint`/`--extension`, `show` (it starts a detached dashboard daemon), `install`, `install-browser`, `close-all`, `kill-all`, `delete-data`, `--profile`/`--persistent`, and a `-s`/`--session` other than its own. Each refusal says what to do instead: "start the browser with process.start playwright-cli-session", "use goto".
- When the session is not running, it rewrites the CLI's "please run open first" into that same instruction.
- This is a guardrail, not a boundary: a model can still run `node …/cli.js` directly, at the same trust level as any `process.run`.
- The AIBoard skill is the stock SKILL.md with the Installation and Browser Sessions sections replaced (no `npm install -g`, no `open`/`close-all`/`kill-all`), plus: start the session once with `process.start`, read results with `--json` (exit codes do not report command errors), and use `--filename=` only into existing folders.

### 9.5 Stopping
- At the owner's end the Runner stops the managed process exactly as today. Verified on both OSes for every kill kind it uses.
- Optionally VF7b can send the CLI's `close` first: it is graceful, removes the temp profile, and took 2.5 s here. If the Runner does, it must still do the tree kill afterwards and must not wait on `close` past its own stop deadline.
- No timeout is raised for this.

### 9.6 The one question for the independent review: POSIX browser processes outside the group
- On Windows the Job proves the whole browser is gone.
- On Linux, and expected on macOS, Chrome and crashpad are outside the owned group in every design, because Playwright itself starts Chrome with `setsid`. In §5 they went away within 0.25 s of the daemon's death, by Chrome's own pipe-EOF behaviour.
- Recommendation: VF7b adds a Runner-side check after the managed stop. While the daemon runs, it records the browser processes it can attribute exactly: the daemon's child Chrome by PID and birth, plus the processes whose command line holds the task folder of §9.3 (a crashpad handler is a session leader with its own group). After the stop, it waits a bounded time, sends SIGKILL to each recorded group whose PID and birth still match, verifies, and records the result.
- This only adds cleanup and never relaxes a rule. It does reach beyond the owned process group, and it must use exact identity (PID + birth), never name matching. So it needs the independent review the standing rules require. If the review prefers not to kill outside the group, the fallback records only: the stop result reports any attributable browser process still alive.
- **No ownership, fencing or containment rule has to be weakened for this design.**

## 10. Commands used

```bash
# Bundle
npx tsx scripts/release/test-bundle-closure.mts
VF7A_REPO="$PWD" npx tsx <scratch>/vf7a-bundle-sim.mts <scratch>/bundle-sim          # Appendix B

# Windows harness (worktree root, node_modules junction to the main checkout)
VF7A_REPO="$PWD" npx tsx <scratch>/vf7a-harness.mts control-detached run-only
VF7A_REPO="$PWD" npx tsx <scratch>/vf7a-harness.mts managed-close
VF7A_REPO="$PWD" npx tsx <scratch>/vf7a-harness.mts managed-sigterm managed-sigkill managed-run-end managed-parent-kill start-open-client two-tasks

# Linux container
git archive --format=tar -o <scratch>/docker/repo.tar HEAD
docker run -d --name vf7a-linux --init --shm-size=1g -v <scratch>/docker:/mnt/vf7a node:24-bookworm sleep infinity
docker exec vf7a-linux bash -c "mkdir -p /repo && tar -xf /mnt/vf7a/repo.tar -C /repo && chown -R node:node /repo"
docker exec -u node -w /repo vf7a-linux npm ci --ignore-scripts
docker exec -u node -w /tmp/ws vf7a-linux node /repo/node_modules/playwright/cli.js cli -s=nob open about:blank [--browser=…]   # §6 errors
docker exec -u node -w /repo vf7a-linux npx playwright install chromium            # then the missing-library error
docker exec -u root -w /repo vf7a-linux npx playwright install-deps chromium
docker exec -u node -w /repo -e VF7A_REPO=/repo -e VF7A_BROWSER=chromium vf7a-linux npx tsx /mnt/vf7a/vf7a-harness.mts control-detached run-only
docker exec -u node -w /repo -e VF7A_REPO=/repo -e VF7A_BROWSER=chromium vf7a-linux npx tsx /mnt/vf7a/vf7a-harness.mts run-no-close managed-close managed-sigterm managed-sigkill managed-run-end managed-parent-kill start-open-client two-tasks
docker exec -u node vf7a-linux bash /mnt/vf7a/vf7a-linux-orphans.sh                 # Appendix C
docker exec -u node vf7a-linux bash /mnt/vf7a/vf7a-linux-taskenv.sh                 # Appendix C
docker exec -u node -w /repo -e VF7A_REPO=/repo vf7a-linux npx tsx /mnt/vf7a/vf7a-bundle-sim.mts /tmp/bsim   # then the CLI from /tmp/bsim
```

## Appendix A: `vf7a-harness.mts`

Throwaway; not product code. Run from a checkout with `node_modules`: `VF7A_REPO=<repo> npx tsx vf7a-harness.mts <scenario ...>`.

<details><summary>vf7a-harness.mts</summary>

```ts
// VF7a throwaway harness (not product code). Drives the bundled Playwright CLI through the Runner's real
// process paths: ExecutionHost -> bindRun -> ToolBroker with process.run (one-shot, OneShotCommandExecutor) and the
// managed process.* tools (ManagedProcessService), exactly as a Build worker's tool calls reach them.
// After each step it takes an OS process census: CLI daemons (cliDaemon.js) and Playwright browser processes
// (every Chrome process carries --user-data-dir=...playwright_chromiumdev_profile-XXXX; on Linux the browser is a
// session leader, so its whole session is counted).
//
// Run (repo root = a checkout with node_modules):
//   VF7A_REPO=<repo> npx tsx vf7a-harness.mts [scenario ...]
// Scenarios: control-detached run-only run-no-close managed-close managed-sigterm managed-sigkill managed-run-end
//            managed-parent-kill start-open-client two-tasks   (Linux container: also VF7A_BROWSER=chromium)
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = resolve(process.env.VF7A_REPO ?? process.cwd());
const src = (name: string) => pathToFileURL(join(REPO, "runner-v2", "src", name)).href;
const { ArtifactStore } = await import(src("artifact-store.ts"));
const { createExecutionHost } = await import(src("execution-host.ts"));
const { snapshotNativeBuildAmbientEnvironment } = await import(src("native-build-factory.ts"));
const { ToolBroker } = await import(src("tool-broker.ts"));
const { createManagedProcessTools } = await import(src("managed-process-tools.ts"));
const { createProcessTools, processRunSupport } = await import(src("process-tools.ts"));
const { emptyRunnerCapabilitiesConfig } = await import(src("runner-capabilities-config.ts"));

const PW_CLI = join(REPO, "node_modules", "playwright", "cli.js");
const PW_DAEMON = join(REPO, "node_modules", "playwright-core", "lib", "entry", "cliDaemon.js");
const WIN = process.platform === "win32";
/** Optional browser for the daemon and `open` (Linux container: chromium, as it has no Chrome). */
const BROWSER = process.env.VF7A_BROWSER;
const BROWSER_ARGS = BROWSER ? [`--browser=${BROWSER}`] : [];
const PROFILE_MARK = "playwright_chromiumdev_profile-";
const t0 = Date.now();
const log = (...parts: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...parts);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- process census
interface Proc { pid: number; ppid: number; name: string; cmd: string; pgid?: number; sid?: number }
function listProcesses(): Proc[] {
  if (WIN) {
    const script = "Get-CimInstance Win32_Process | Where-Object { $_.Name -ne 'powershell.exe' -and ($_.CommandLine -like '*cliDaemon.js*' -or $_.CommandLine -like '*" + PROFILE_MARK + "*' -or $_.CommandLine -like '*playwright*cli.js* cli*') } | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", maxBuffer: 64 << 20, windowsHide: true }).trim();
    if (!out) return [];
    const rows = JSON.parse(out);
    return (Array.isArray(rows) ? rows : [rows]).map((r: any) => ({ pid: r.ProcessId, ppid: r.ParentProcessId, name: r.Name, cmd: r.CommandLine ?? "" }));
  }
  const procs: Proc[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmd = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").join(" ").trim();
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const name = stat.slice(stat.indexOf("(") + 1, close);
      const f = stat.slice(close + 2).split(" ");
      procs.push({ pid: Number(entry), ppid: Number(f[1]), pgid: Number(f[2]), sid: Number(f[3]), name, cmd });
    } catch { /* exited */ }
  }
  return procs;
}
interface Census { daemons: Proc[]; browsers: Proc[]; clients: Proc[]; profiles: string[] }
function census(baseline?: Census): Census {
  const all = listProcesses();
  const known = new Set([...(baseline?.daemons ?? []), ...(baseline?.browsers ?? []), ...(baseline?.clients ?? [])].map((p) => p.pid));
  const fresh = all.filter((p) => !known.has(p.pid) && p.pid !== process.pid);
  const daemons = fresh.filter((p) => p.cmd.includes("cliDaemon.js"));
  const clients = fresh.filter((p) => /cli\.js["']? cli\b/.test(p.cmd) && !p.cmd.includes("cliDaemon.js"));
  let browsers = fresh.filter((p) => p.cmd.includes(PROFILE_MARK));
  if (!WIN) {
    // Chrome is spawned detached (setsid) on POSIX: count every process in a marked browser's session, and
    // chrome_crashpad_handler, which double-forks into its own session (ppid 1) without the profile marker.
    const sids = new Set(browsers.map((p) => p.sid));
    browsers = fresh.filter((p) => (sids.has(p.sid) || p.cmd.includes("chrome_crashpad_handler")) && !p.cmd.includes("cliDaemon.js"));
  }
  const profiles = [...new Set(browsers.map((p) => p.cmd.match(new RegExp(PROFILE_MARK + "[A-Za-z0-9]+"))?.[0]).filter(Boolean) as string[])];
  return { daemons, browsers, clients, profiles };
}
function describe(c: Census): string {
  const d = c.daemons.map((p) => `${p.pid}${p.pgid !== undefined ? `(pgid ${p.pgid} sid ${p.sid} ppid ${p.ppid})` : `(ppid ${p.ppid})`}`).join(",") || "none";
  const browserMain = c.browsers.filter((p) => !/--type=/.test(p.cmd));
  const b = c.browsers.length ? `${c.browsers.length} [main ${browserMain.map((p) => `${p.pid}${p.pgid !== undefined ? `(pgid ${p.pgid} sid ${p.sid} ppid ${p.ppid})` : `(ppid ${p.ppid})`}`).join(",")}]` : "0";
  return `daemons: ${d}; browser processes: ${b}; cli clients: ${c.clients.length}`;
}

// ---------------------------------------------------------------- test page
function startPage(): Promise<{ server: Server; url: string }> {
  const html = `<!doctype html><html><head><title>VF7a probe</title></head><body><h1>Hello VF7a</h1>
<button onclick="console.error('clicked-error')">Press</button><script>console.log('page-loaded')</script></body></html>`;
  const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(html); });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, url: `http://127.0.0.1:${(server.address() as any).port}/` })));
}

// ---------------------------------------------------------------- Runner fixture
async function withRunner<T>(label: string, body: (f: Fixture) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "vf7a-"));
  const project = join(root, "project"), state = join(root, "state");
  await mkdir(project); await mkdir(state);
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts, ambientEnvironment: snapshotNativeBuildAmbientEnvironment() });
  const run = await host.bindRun({ runId: `vf7a-${label}`, permissionProfile: "full", capabilityContract: { digest: "d".repeat(64) } as any, capabilitiesConfig: emptyRunnerCapabilitiesConfig() });
  const broker = new ToolBroker({ permissionProfile: "full", workspacePath: project, executionGrants: run.executionGrants, artifacts });
  for (const tool of createProcessTools({ execution: run.commandExecution, support: processRunSupport(run.managedProcesses, artifacts) })) broker.register(tool);
  for (const tool of createManagedProcessTools(run.managedProcesses)) broker.register(tool);
  let seq = 0;
  const invoke = async (name: string, input: Record<string, unknown>, agent = "worker-session") => {
    const started = Date.now();
    const out = await broker.invoke({ type: "tool_call", callId: `vf7a-${label}-${++seq}`, name, arguments: input },
      { runId: run.runId, sessionId: agent, actor: { role: "worker", id: "worker" }, workspacePath: project });
    return { out, ms: Date.now() - started };
  };
  const text = async (out: any): Promise<string> => (await Promise.all(out.content.map(async (b: any) => {
    if (b.type === "text") return b.text;
    if (b.type === "json") return JSON.stringify(b.value);
    if (b.type === "artifact") return (await artifacts.get(b.hash)).toString("utf8");
    return "";
  }))).join("\n");
  const cli = async (session: string, args: string[], extra: Record<string, unknown> = {}) => {
    const { out, ms } = await invoke("process.run", { command: process.execPath, args: [PW_CLI, "cli", `-s=${session}`, ...args], timeoutMs: 90_000, ...extra });
    const body = await text(out);
    log(`process.run cli -s=${session} ${args.join(" ")} -> isError=${out.isError} ${ms} ms\n${indent(body)}`);
    return { out, body };
  };
  const fixture: Fixture = { project, state, run, host, invoke, text, cli, root };
  let closed = false;
  try {
    const result = await body(fixture);
    await closeRun(fixture); closed = true;
    return result;
  } finally {
    if (!closed) await closeRun(fixture).catch((e) => log("closeRun failed", e));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch((e) => log(`could not remove ${root}: ${e.message}`));
  }
}
interface Fixture {
  project: string; state: string; root: string; run: any; host: any;
  invoke: (name: string, input: Record<string, unknown>, agent?: string) => Promise<{ out: any; ms: number }>;
  text: (out: any) => Promise<string>;
  cli: (session: string, args: string[], extra?: Record<string, unknown>) => Promise<{ out: any; body: string }>;
}
async function closeRun(f: Fixture) {
  const started = Date.now();
  await f.run.close();
  await f.host.close();
  log(`run.close() + host.close() took ${Date.now() - started} ms`);
}
const indent = (s: string) => s.split(/\r?\n/).slice(0, 40).map((l) => `      | ${l.slice(0, 220)}`).join("\n");

async function startManagedDaemon(f: Fixture, session: string, env: Record<string, string> = {}) {
  const { out, ms } = await f.invoke("process.start", {
    command: process.execPath, args: [PW_DAEMON, session, ...BROWSER_ARGS], ...(Object.keys(env).length ? { env } : {}),
    until: { pattern: "Daemon listening on" }, waitMs: 30_000,
  });
  const body = await f.text(out);
  log(`process.start node cliDaemon.js ${session} -> isError=${out.isError} ${ms} ms\n${indent(body)}`);
  if (out.isError) throw new Error("managed daemon start failed");
  const json = out.content.find((b: any) => b.type === "json")?.value;
  return { processId: json?.processId as string, status: json?.status, body };
}
async function poll(f: Fixture, processId: string) {
  const { out } = await f.invoke("process.poll", { processId });
  const json = out.content.find((b: any) => b.type === "json")?.value;
  log(`process.poll -> ${JSON.stringify({ status: json?.status, exitCode: json?.exitCode, signal: json?.signal, cleanup: json?.cleanup })}`);
  return json;
}
async function waitStopped(f: Fixture, processId: string, ms = 30_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const json = await poll(f, processId);
    if (json?.status !== "running" || Date.now() > deadline) return json;
    await sleep(500);
  }
}
function report(label: string, baseline: Census, c = census(baseline)) {
  log(`CENSUS ${label}: ${describe(c)}`);
  return c;
}
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else out.push(`${relative(dir, p)} (${statSync(p).size} B)`); } };
  if (existsSync(dir)) walk(dir);
  return out;
}

// ---------------------------------------------------------------- scenarios
const scenarios: Record<string, (url: string, baseline: Census) => Promise<void>> = {
  // A: every CLI command as an ordinary process.run call.
  "run-only": async (url, baseline) => withRunner("run-only", async (f) => {
    const s = "vf7a-run";
    await f.cli(s, ["open", url, ...BROWSER_ARGS]);
    report("after process.run open", baseline);
    await f.cli(s, ["snapshot"]);
    report("after process.run snapshot", baseline);
    await f.cli(s, ["screenshot", "--filename=shots/run.png"]);
    await f.cli(s, ["list"]);
    await f.cli(s, ["close"]);
    report("after process.run close", baseline);
    log(`project files: ${filesUnder(f.project).join(", ") || "none"}`);
  }).then(() => { report("after task end (run-only)", baseline); }),

  // A2: process.run open, and the task ends without the CLI's close.
  "run-no-close": async (url, baseline) => withRunner("run-no-close", async (f) => {
    await f.cli("vf7a-run-nc", ["open", url, ...BROWSER_ARGS]);
    report("after process.run open", baseline);
  }).then(async () => { report("right after task end (run-no-close)", baseline); await sleep(5_000); report("5 s after task end (run-no-close)", baseline); }),

  // Control: a parent that leaves a detached child (stdio ignore, sleeping 15 s) and exits at once.
  "control-detached": async (_url, baseline) => withRunner("control-detached", async (f) => {
    const marker = join(f.project, "child-alive.txt");
    const script = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',"require('node:fs').writeFileSync(process.argv[1],String(process.pid));setTimeout(()=>{},15000)",${JSON.stringify(marker)}],{detached:true,stdio:'ignore'});c.unref();console.log('parent done, child pid '+c.pid);`;
    for (const timeoutMs of [30_000, 5_000]) {
      const { out, ms } = await f.invoke("process.run", { command: process.execPath, args: ["-e", script], timeoutMs });
      log(`control process.run (timeout ${timeoutMs}) -> ${ms} ms\n${indent(await f.text(out))}`);
      await sleep(300);
      const pid = Number(readFileSync(marker, "utf8"));
      let alive = true; try { process.kill(pid, 0); } catch { alive = false; }
      log(`detached child ${pid} alive after the call returned: ${alive}`);
      if (alive) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    }
  }).then(() => { report("after task end (control-detached)", baseline); }),

  // B: the session daemon as a managed process; stopped by the CLI's close, then the task ends.
  "managed-close": async (url, baseline) => withRunner("managed-close", async (f) => {
    const s = "vf7a-mclose";
    // The daemon's auto-named files (snapshots, console logs, screenshots without --filename) go to this folder.
    const d = await startManagedDaemon(f, s, { PLAYWRIGHT_MCP_OUTPUT_DIR: join(f.project, "aiboard-out", "browser") });
    report("after process.start daemon", baseline);
    await f.cli(s, ["goto", url]);
    await f.cli(s, ["snapshot"]);
    await f.cli(s, ["click", "e3"]);
    await f.cli(s, ["console"]);
    await f.cli(s, ["screenshot"]);
    await f.cli(s, ["screenshot", "--filename=managed.png"]);
    await f.cli(s, ["screenshot", "--filename=shots/missing-dir.png"]);
    await mkdir(join(f.project, "shots"));
    await f.cli(s, ["screenshot", "--filename=shots/managed.png"], { cwd: "." });
    await f.cli(s, ["snapshot", "--filename=shots/managed.yml"]);
    await f.cli(s, ["--json", "screenshot", "--filename=shots/missing/x.png"]);
    await f.cli(s, ["eval", "document.title"]);
    report("after process.run commands", baseline);
    log(`project files: ${filesUnder(f.project).join(", ") || "none"}`);
    await f.cli(s, ["close"]);
    await waitStopped(f, d.processId);
    report("after cli close", baseline);
    await f.cli(s, ["snapshot"]);
  }).then(() => { report("after task end (managed-close)", baseline); }),

  // C: the Runner's own stop (tree kill) with SIGTERM, no close first.
  "managed-sigterm": async (url, baseline) => managedStop(url, baseline, "SIGTERM"),
  // D: SIGKILL (Windows: job termination; POSIX: SIGKILL to the owned process group).
  "managed-sigkill": async (url, baseline) => managedStop(url, baseline, "SIGKILL"),

  // E: the task ends with the daemon still running (run.close() -> managed stopRun).
  "managed-run-end": async (url, baseline) => withRunner("managed-run-end", async (f) => {
    const s = "vf7a-mend";
    await startManagedDaemon(f, s);
    await f.cli(s, ["goto", url]);
    report("before task end", baseline);
  }).then(() => { report("after task end (managed-run-end)", baseline); }),

  // F: parent-only kill: only the daemon's own PID is killed (a crash, or a kill that misses the tree).
  "managed-parent-kill": async (url, baseline) => withRunner("managed-parent-kill", async (f) => {
    const s = "vf7a-mparent";
    const d = await startManagedDaemon(f, s);
    await f.cli(s, ["goto", url]);
    const before = report("before parent-only kill", baseline);
    const daemonPid = before.daemons[0]?.pid;
    log(`killing only daemon pid ${daemonPid} with SIGKILL (TerminateProcess on Windows)`);
    if (daemonPid) process.kill(daemonPid, "SIGKILL");
    await sleep(500);
    report("0.5 s after parent-only kill", baseline);
    await sleep(5_000);
    report("5.5 s after parent-only kill", baseline);
    await poll(f, d.processId);
    await f.cli(s, ["snapshot"]);
  }).then(() => { report("after task end (managed-parent-kill)", baseline); }),

  // G: the CLI client's `open` itself as a managed process (it starts a detached daemon and exits).
  "start-open-client": async (url, baseline) => withRunner("start-open-client", async (f) => {
    const s = "vf7a-gopen";
    const { out } = await f.invoke("process.start", { command: process.execPath, args: [PW_CLI, "cli", `-s=${s}`, "open", url, ...BROWSER_ARGS], until: { exit: true }, waitMs: 30_000 });
    log(`process.start cli open ->\n${indent(await f.text(out))}`);
    report("after managed client exited", baseline);
    await f.cli(s, ["snapshot"]);
    await f.cli(s, ["close"]);
  }).then(() => { report("after task end (start-open-client)", baseline); }),

  // H: two tasks in two worktrees at once, each with its own named managed session.
  "two-tasks": async (url, baseline) => {
    await withRunner("two-a", async (a) => withRunner("two-b", async (b) => {
      await startManagedDaemon(a, "vf7a-task-a");
      await startManagedDaemon(b, "vf7a-task-b");
      await a.cli("vf7a-task-a", ["goto", url]);
      await b.cli("vf7a-task-b", ["goto", `${url}?b`]);
      await a.cli("vf7a-task-a", ["list"]);
      await a.cli("vf7a-task-b", ["eval", "location.href"]);
      report("two tasks running", baseline);
    }).then(() => report("after task B ended", baseline)));
    report("after both tasks ended", baseline);
  },
};

async function managedStop(url: string, baseline: Census, signal: "SIGTERM" | "SIGKILL") {
  const label = `managed-${signal.toLowerCase()}`;
  await withRunner(label, async (f) => {
    const s = `vf7a-${signal.toLowerCase()}`;
    const d = await startManagedDaemon(f, s);
    await f.cli(s, ["goto", url]);
    report(`before process.signal ${signal}`, baseline);
    const { out, ms } = await f.invoke("process.signal", { processId: d.processId, signal });
    log(`process.signal ${signal} -> ${ms} ms\n${indent(await f.text(out))}`);
    report(`right after process.signal ${signal}`, baseline);
    await sleep(3_000);
    report(`3 s after process.signal ${signal}`, baseline);
    await f.cli(s, ["snapshot"]);
  });
  report(`after task end (${label})`, baseline);
}

// ---------------------------------------------------------------- main
const requested = process.argv.slice(2);
const names = requested.length ? requested : Object.keys(scenarios);
log(`platform ${process.platform}, node ${process.version}, repo ${REPO}`);
const { server, url } = await startPage();
log(`test page at ${url}`);
const baseline = census();
log(`baseline (other sessions' processes, ignored): ${describe(baseline)}`);
for (const name of names) {
  const scenario = scenarios[name];
  if (!scenario) throw new Error(`unknown scenario ${name}`);
  log(`================ ${name}`);
  try { await scenario(url, baseline); }
  catch (error) { log(`SCENARIO ${name} FAILED`, error); }
  const left = census(baseline);
  if (left.daemons.length || left.browsers.length) {
    log(`LEFT BEHIND after ${name}: ${describe(left)}; cleaning up for the next scenario`);
    for (const p of [...left.daemons, ...left.browsers]) { try { process.kill(p.pid, "SIGKILL"); } catch { /* gone */ } }
    await sleep(1_000);
  }
}
server.close();
log("done");
```

</details>

## Appendix B: `vf7a-bundle-sim.mts`

Repeats `build-bundle.mts` `dependencyFiles()` and copies exactly that file set, so the CLI can be run from it.

<details><summary>vf7a-bundle-sim.mts</summary>

```ts
// VF7a throwaway: reproduce scripts/release/build-bundle.mts dependencyFiles() (the lockfile-resolved runtime
// closure of RUNTIME_PACKAGES, optional dependencies left out, each package's own node_modules skipped), copy exactly
// those files to <out>/app/node_modules/..., and check the Playwright CLI files are among them.
//   VF7A_REPO=<repo> npx tsx vf7a-bundle-sim.mts <out>
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(process.env.VF7A_REPO ?? process.cwd());
const out = resolve(process.argv[2] ?? "bundle-sim");
const { RUNTIME_PACKAGES } = await import(pathToFileURL(join(root, "scripts", "release", "bundle-contents.mts")).href);
interface LockEntry { version?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }>; link?: boolean }
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as { packages: Record<string, LockEntry> };
const resolveFrom = (location: string, name: string): string | undefined => {
  let base = location;
  for (;;) {
    const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (lock.packages[candidate]) return candidate;
    if (!base) return undefined;
    const index = base.lastIndexOf("/node_modules/");
    base = index < 0 ? "" : base.slice(0, index);
  }
};
const visited = new Set<string>(); const skipped: string[] = [];
const queue = (RUNTIME_PACKAGES as string[]).map((name) => resolveFrom("", name)!);
while (queue.length) {
  const location = queue.shift()!;
  if (visited.has(location)) continue;
  const entry = lock.packages[location]!;
  visited.add(location);
  const required = new Set(Object.keys(entry.dependencies ?? {}));
  for (const name of Object.keys(entry.peerDependencies ?? {})) if (!entry.peerDependenciesMeta?.[name]?.optional) required.add(name);
  for (const name of Object.keys(entry.optionalDependencies ?? {})) { required.delete(name); skipped.push(`${location} -> ${name}`); }
  for (const name of [...required].sort()) queue.push(resolveFrom(location, name)!);
}
rmSync(out, { recursive: true, force: true });
const files: string[] = [];
for (const location of [...visited].sort()) {
  const directory = join(root, ...location.split("/"));
  const walk = (current: string, prefix: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (prefix === "" && entry.name === "node_modules") continue;
      const path = join(current, entry.name), archivePath = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(path, `${archivePath}/`);
      else if (entry.isFile()) { const target = join(out, "app", ...location.split("/"), ...archivePath.split("/")); mkdirSync(dirname(target), { recursive: true }); copyFileSync(path, target); files.push(`app/${location}/${archivePath}`); }
      else throw new Error(`${location}/${archivePath} is not a regular file`);
    }
  };
  walk(directory, "");
}
console.log(`packages in the closure: ${visited.size}; optional left out: ${skipped.join(", ")}; files: ${files.length}`);
const pw = files.filter((f) => f.startsWith("app/node_modules/playwright/") || f.startsWith("app/node_modules/playwright-core/"));
console.log(`playwright + playwright-core files: ${pw.length}`);
const wanted = [
  "app/node_modules/playwright/cli.js",
  "app/node_modules/playwright/lib/program.js",
  "app/node_modules/playwright-core/package.json",
  "app/node_modules/playwright-core/browsers.json",
  "app/node_modules/playwright-core/lib/coreBundle.js",
  "app/node_modules/playwright-core/lib/utilsBundle.js",
  "app/node_modules/playwright-core/lib/entry/cliDaemon.js",
  "app/node_modules/playwright-core/lib/tools/cli-client/cli.js",
  "app/node_modules/playwright-core/lib/tools/cli-client/program.js",
  "app/node_modules/playwright-core/lib/tools/cli-client/session.js",
  "app/node_modules/playwright-core/lib/tools/cli-client/registry.js",
  "app/node_modules/playwright-core/lib/tools/cli-client/help.json",
  "app/node_modules/playwright-core/lib/tools/cli-client/skill/SKILL.md",
];
for (const w of wanted) console.log(`${files.includes(w) ? "PRESENT" : "MISSING"} ${w}`);
console.log(`skill files: ${files.filter((f) => f.includes("/cli-client/skill/")).map((f) => f.split("/cli-client/skill/")[1]).join(", ")}`);
if (!existsSync(join(out, "app", "node_modules", "playwright", "cli.js"))) process.exitCode = 1;
```

</details>

## Appendix C: Linux probes

Run inside the container as user `node`. Plain CLI; the Runner paths are covered by Appendix A.

<details><summary>vf7a-linux-orphans.sh</summary>

```bash
#!/usr/bin/env bash
# VF7a throwaway (Linux): what Chrome and chrome_crashpad_handler do when the CLI daemon or Chrome dies without a
# graceful close. Plain CLI here; the Runner paths are covered by vf7a-harness.mts.
set -u
CLI=/repo/node_modules/playwright/cli.js
cd /tmp/ws
rm -rf /tmp/playwright_chromiumdev_profile-* /tmp/playwright-artifacts-*
CHROME="chrome-linux64/chrome "
python3 -m http.server 47811 --bind 127.0.0.1 >/dev/null 2>&1 &
HTTP=$!
sleep 1
URL=http://127.0.0.1:47811/
pids() { pgrep -f "$1" | tr '\n' ' '; }
daemon_pid() { pgrep -f "cliDaemon.js $1" | head -1; }
chrome_main() { for p in $(pgrep -f "$CHROME"); do tr '\0' ' ' < /proc/$p/cmdline | grep -q -- '--type=' || echo $p; done | head -1; }
gone_after() { # pid pattern -> ms until no process matches
  local start=$(date +%s%N) pattern=$1
  while pgrep -f "$pattern" >/dev/null; do
    if (( ($(date +%s%N) - start) / 1000000 > 15000 )); then echo "still alive after 15000 ms: $(pids "$pattern")"; return; fi
    sleep 0.02
  done
  echo "$(( ($(date +%s%N) - start) / 1000000 )) ms"
}
open_session() { node $CLI cli -s=$1 open "$URL" --browser=chromium ${2:-} >/dev/null; }

echo "== 1. SIGKILL the daemon only (idle page)"
open_session k1; D=$(daemon_pid k1); C=$(chrome_main)
echo "daemon $D, chrome main $C, crashpad: $(pids chrome_crashpad_handler)"
kill -9 "$D"
echo "chrome processes gone: $(gone_after "$CHROME"); crashpad gone: $(gone_after chrome_crashpad_handler)"

echo "== 2. SIGKILL the daemon while the page spins its main thread"
open_session k2; D=$(daemon_pid k2)
node $CLI cli -s=k2 eval "setTimeout(() => { for (;;) {} }, 1500), 1" >/dev/null
sleep 1
kill -9 "$D"
echo "chrome processes gone: $(gone_after "$CHROME"); crashpad gone: $(gone_after chrome_crashpad_handler)"

echo "== 3. SIGKILL Chrome's main process only"
open_session k3; D=$(daemon_pid k3); C=$(chrome_main)
kill -9 "$C"
echo "chrome processes gone: $(gone_after "$CHROME"); crashpad gone: $(gone_after chrome_crashpad_handler); daemon gone: $(gone_after "cliDaemon.js k3")"

echo "== 4. SIGKILL Chrome's whole process group (its session), daemon kept"
open_session k4; D=$(daemon_pid k4); C=$(chrome_main)
kill -9 -- "-$C"
echo "chrome processes gone: $(gone_after "$CHROME"); crashpad gone: $(gone_after chrome_crashpad_handler); daemon gone: $(gone_after "cliDaemon.js k4")"

echo "== 5. SIGSTOP the daemon (hung, pipe still open) for 5 s"
open_session k5; D=$(daemon_pid k5)
kill -STOP "$D"; sleep 5
echo "chrome still running while the daemon is stopped: $(pids "$CHROME" | wc -w) processes"
kill -9 "$D"
echo "after SIGKILL of the stopped daemon, chrome gone: $(gone_after "$CHROME"); crashpad gone: $(gone_after chrome_crashpad_handler)"

echo "== 6. --disable-crash-reporter through the CLI config"
mkdir -p /tmp/ws/.playwright
cat > /tmp/ws/cfg.json <<'EOF'
{ "browser": { "launchOptions": { "args": ["--disable-crash-reporter"] } } }
EOF
open_session k6 "--config=/tmp/ws/cfg.json"
echo "crashpad handlers with --disable-crash-reporter: $(pids chrome_crashpad_handler | wc -w); chrome processes: $(pids "$CHROME" | wc -w)"
node $CLI cli -s=k6 close >/dev/null
rm -rf /tmp/ws/.playwright

echo "== 7. leftovers on disk"
echo "profile dirs in /tmp: $(ls -d /tmp/playwright_chromiumdev_profile-* 2>/dev/null | wc -l); artifacts dirs: $(ls -d /tmp/playwright-artifacts-* 2>/dev/null | wc -l)"
ls ~/.cache/ms-playwright/daemon/*/
ls -la /tmp/pw-*/cli/ 2>/dev/null
echo "remaining: daemons $(pids cliDaemon.js | wc -w), chrome $(pids "$CHROME" | wc -w), crashpad $(pids chrome_crashpad_handler | wc -w)"
kill $HTTP
```

</details>

<details><summary>vf7a-linux-taskenv.sh</summary>

```bash
#!/usr/bin/env bash
# VF7a throwaway: a task-owned TMPDIR and XDG_CONFIG_HOME for the session daemon; are all browser processes attributable?
CLI=/repo/node_modules/playwright/cli.js
T=/tmp/task-7f3a; rm -rf $T; mkdir -p $T/tmp $T/xdg $T/reg $T/ws; cd $T/ws
TMPDIR=$T/tmp XDG_CONFIG_HOME=$T/xdg PWTEST_DAEMON_SESSION_DIR=$T/reg nohup node /repo/node_modules/playwright-core/lib/entry/cliDaemon.js t-7f3a --browser=chromium > $T/daemon.out 2>&1 &
D=$!
for i in $(seq 1 100); do grep -q "Daemon listening" $T/daemon.out && break; sleep 0.1; done
cat $T/daemon.out
total=0; marked=0
for p in $(pgrep -f "chrome-linux64/chrome"); do total=$((total+1)); tr '\0' ' ' < /proc/$p/cmdline | grep -q "$T" && marked=$((marked+1)); done
echo "browser processes: $total, carrying the task folder in their command line: $marked"
for p in $(pgrep -f chrome_crashpad_handler); do tr '\0' ' ' < /proc/$p/cmdline | grep -o -- "--database=[^ ]* [^ ]*"; done
ls $T/tmp $T/reg
PWTEST_DAEMON_SESSION_DIR=$T/reg node $CLI cli -s=t-7f3a close
sleep 1; echo "after close: tmp has $(ls $T/tmp | wc -l) entries; daemon alive: $(kill -0 $D 2>/dev/null && echo yes || echo no)"
```

Output:

```
Daemon listening on /tmp/task-7f3a/tmp/pw-7505d64a/cli/3d710e031e9f29b8-t-7f3a.sock

browser processes: 8, carrying the task folder in their command line: 8
--database=/tmp/task-7f3a/xdg/google-chrome-for-testing/Crash Reports
--database=/tmp/task-7f3a/xdg/google-chrome-for-testing/Crash Reports
/tmp/task-7f3a/reg:
3d710e031e9f29b8

/tmp/task-7f3a/tmp:
org.chromium.Chromium.LmD5Pl
playwright-artifacts-6Fjcje
playwright_chromiumdev_profile-6lZ4Vx
pw-7505d64a
Browser 't-7f3a' closed

after close: tmp has 2 entries; daemon alive: no
```

</details>
