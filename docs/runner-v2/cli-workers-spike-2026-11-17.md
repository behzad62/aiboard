# CW0 spike: Codex CLI, Claude Code and agy as Runner-managed processes

Date: 2026-11-17, corrected after review the same day. Packet CW0 of docs/plans/2026-11-14-cli-workers.md (§5).
Spike only: no product code. Fixtures are in `runner-v2/test/fixtures/cli-workers/` (its README describes the layout
and the scrubbing). Base: main 935a176e.

## 0. What CW2 and CW5 need to know first

1. **agy: the §3.5 arguments do not work.** `-p` takes the next argument as its prompt (exit 2), and
   `--input-format stream-json` requires `--output-format stream-json`. Text-mode `-p` cannot read the prompt from
   stdin (`-p=-` is the literal prompt "-"). The working form is stream-json in and out with an empty, attached
   `-p=` last, and one stdin line `{"event":"user","message":{"content":"<prompt>"}}` (§2).
2. **Linux: Codex and Claude Code leave the managed process group in normal use, by design.** Every Codex shell
   command runs as `/bin/sh -lc` in a new session; Codex's `git` and its `codex-code-mode --listen` host get their own
   process groups. Every Claude Code Bash tool command runs as `bash -c` in a new session. The portable backend's
   verified stop covers only the group. After it, a Codex `codex-code-mode` and a Claude Code background server were
   still running, and a Codex background server had left the group unseen (§6.2). By §3.11 ("If one does by design,
   CLI workers for that CLI are refused on that OS until a design amendment"), CLI workers for both are refused on
   Linux. Only Linux was measured; macOS was not.
3. **Windows: Codex left processes outside the Runner's Job in 3 of its 7 Windows runs.** Both runs of the
   background prompt left the server it started with the Store `pwsh.exe` and `Start-Process … -WindowStyle Hidden`
   running, in no Job, after a stop the Runner reported as verified. The harness saw only the first: in the second, the
   server's parent was never sampled, so the harness reported nothing left; a search by command line found it hours
   later, still running. The third run (an unknown model, no command run) left a hook process from a user-installed
   Codex plugin outside the Job. The Job's `LimitFlags` are `KILL_ON_JOB_CLOSE` only (managed-process-job-host.ps1:552),
   so `CREATE_BREAKAWAY_FROM_JOB` cannot work. A candidate mechanism is the desktop-app breakaway policy: the job host
   sets `PROCESS_CREATION_DESKTOP_APP_BREAKAWAY_DISABLE_PROCESS_TREE` on the root (:379) and silently launches without
   it when the attribute list cannot be built (:365-386), and the Store `pwsh.exe` is a packaged app (§6.1). The
   mechanism is not shown. Free reproductions of the same `Start-Process` from the Runner's root stayed inside the Job.
   Claude Code and agy left nothing found outside the Job (§6.1, with one run that can't be classified).
4. **Claude Code `-p` does not exit while a `run_in_background` task runs.** With `--output-format json` it then prints
   nothing at all, so the result is lost when the Runner stops it at the deadline. With `--output-format stream-json
   --verbose`, the `result` event (with `structured_output`) arrives when the turn ends (`duration_ms` 8242 in the
   fixture) while the process stays up. CW2 should use stream-json for Claude Code and treat its `result` event as the
   end of the turn (§3, §7).
5. **Two CLIs state remaining usage and reset times.** agy: `agy --output-format json -p=/quota`, run from
   PowerShell, is free: no model turn, every token count 0, an empty `conversation_id`, and remaining fractions and
   reset times per model group (fixture `agy/free/quota.json`). Claude Code: stream-json emits `rate_limit_event` with
   `utilization`, `status` and `resetsAt` (Unix seconds) per window, but only inside a run that spends usage. The
   plan's "None of the CLIs reports remaining usage" (§3.4) is no longer true for these two (§7).
6. **Claude Code as root refuses `--dangerously-skip-permissions`** ("cannot be used with root/sudo privileges for
   security reasons", exit 1). A Runner running as root (Docker, some CI) cannot launch it with the plan's flag (§5).
7. **Fence claims: no failure.** On Windows, 0 failed claims at launch or stop across 25 real CLI launches and 350
   launches of a fake CLI-shaped load, on the OS-lock fence with its 15 s default deadline. The figures for 2 and 4
   workers at once rest mainly on the fake load (§8).

## 1. What ran

**Harness** (throwaway, not committed): one `createExecutionHost` + `bindRun` (permission profile `full`), a
`ToolBroker` that issues the real execution grant, and `ManagedProcessService.start` with `interactive: true` for each
run, one worker owner per run, in a fresh clone of a toy repository (`sum.js`, `sum.test.js`, `package.json`). The
prompt went to stdin and stdin was closed (`writeInput` with `closeInput`). Output was read in pages until the process
exited, then the harness called `closeAgent(owner)` and checked which processes it had linked to the run were still
alive. A separate observer sampled the host's process table (Windows: `Win32_Process` every 0.5 s; Linux: `/proc`
every 150 ms) to build each run's descendant tree. The observer is the spike's own and is not part of the Runner.

The observer has two limits that matter for §6:
- **A child whose parent was never sampled is never linked.** A short-lived parent (a shell that starts a background
  process and exits) can live and die between two samples; its child then has no seen parent, so it is neither in
  the tree nor checked after the stop. Codex's second Windows background server and its Linux background server were
  missed this way (§6). "Nothing alive after the stop" in a meta file means nothing the observer linked was alive.
- **Windows pid reuse.** A process counts as a descendant only when its parent was seen and was created before it.
  Runs before 14:09 UTC (rounds A to D) used a weaker rule and list unrelated host processes; the descendant counts
  for those runs in §6 are approximate. The job check (`IsProcessInJob` on each survivor) was added at the same time.

The result schema the runs used is committed as `runner-v2/test/fixtures/cli-workers/result.schema.json`; §9.7 says how
it differs from `CliWorkerResultV1`.

**Platforms.**
- Windows 10 Pro 19045 (this PC), Job backend.
- Linux: Debian bookworm in Docker (`node:24-bookworm-slim`, 4 CPUs), portable supervisor. Codex and Claude Code were
  installed from npm and logged in by the owner inside the container as a non-root user. agy was not installed on
  Linux (its Linux installer is not known here).
- **Not covered:** macOS (no Mac reachable); agy on Linux; any real usage-limit output (no CLI hit a limit; the owner's
  earlier logs are prose only, docs/plans/2026-11-03-simple-build-and-delegate.md §2.1); and Claude Code stream-json
  for a success, a needs-decision, an `is_error` result from a model call, or a killed run (Claude Code had used its
  ten prompts before stream-json was found). The stream-json fixtures are the background run and a free logged-out
  run; the background run's `result` event has the same fields as the json mode's result object.

**Prompts** (the owner's "go" on 2026-11-17, CWD-1; at most ten per CLI). Spent: Codex 10, Claude Code 10, agy 7.
agy runs refused before any model call (exit 2 argument errors, stream-input errors, the `--effort` refusal) are not
counted. agy's 7th is an accident: Git Bash rewrote `-p=/quota` into a path under `C:/Program Files/Git`, so agy ran
a real turn on it. The `/quota` capture was redone from PowerShell, where it is a free command. Each meta file has the
exact stdin of its run.

| Case | Prompt (abridged) | Codex | Claude Code | agy |
|---|---|---|---|---|
| success | add `mul(a, b)` to sum.js and one test, run `node --test` once, don't commit, reply with the schema | Win, Linux | Win, Linux | Win (+1 probe: `-p=-`) |
| resume | resume the success session: "name the function you added" | Win | Win | Win |
| needs-decision | "divide(a, b), but what when b is 0? don't guess" | Win | Win (`--model sonnet`) | Win |
| background | start `node -e "require('http').createServer(…).listen(0)"` in the background, reply | Win ×2, Linux | Win (json), Win (stream-json), Linux | Win |
| killed | the success prompt, `process.signal` SIGTERM 12 s after launch | Win, Linux | Win, Linux (finished before the signal) | Win |
| model unavailable | a tiny prompt with model `cw0-no-such-model` | Win | Win | Win (refused locally, see §5) |
| logged out | the success prompt with no login (Linux, free) | Linux | Linux | — |
| (accident) | `-p=/quota` rewritten by Git Bash into a path | — | — | Win |

Every run used low effort (`-c model_reasoning_effort=low`, `--effort low`) and the CLI's permission bypass.

## 2. The §3.5 flags

| CLI | Flag or form in §3.5 | Finding |
|---|---|---|
| Codex | `exec --json --output-schema <file> -o <file> [-m <model>] [-c model_reasoning_effort=<e>] --dangerously-bypass-approvals-and-sandbox -C <worktree> -` | **Confirmed**, every flag. `-m` reaches the server (the unknown-model run names it); `-c model_reasoning_effort=low` accepted. |
| Codex | prompt on stdin (`-`) | **Confirmed.** |
| Codex | resume: `exec resume <threadId> -` | **Confirmed**, with `--json`, `--output-schema`, `-o`, `-c` and the bypass flag. `exec resume` has **no `-C`**: the process's cwd must be the worktree. |
| Claude Code | `-p --output-format json --json-schema <schema> [--model <m>] [--effort <e>] --dangerously-skip-permissions --session-id <uuid>` | **Confirmed** on Windows and as a non-root Linux user; `--json-schema` took the inline JSON schema as one argv entry; `--model sonnet` and `--effort low` accepted. **Replace `--output-format json` with `--output-format stream-json --verbose`** (finding 4; stream-json needs `--verbose` in `-p`). **As root, `--dangerously-skip-permissions` is refused** (§5). |
| Claude Code | prompt on stdin | **Confirmed.** |
| Claude Code | resume: `-p --resume <uuid>` | **Confirmed**; sessions are stored per project folder, so the resume must run with the same cwd (the worktree). |
| agy | `-p --input-format stream-json --output-format json --json-schema <file> [--model <m>] [--effort <e>] --dangerously-skip-permissions --print-timeout 0` | **Does not work.** `-p` is a string flag: `-p --output-format …` exits 2 with "-p took "--output-format" as its prompt". `--input-format stream-json` requires `--output-format stream-json` (help text). |
| agy | **replacement** | `--input-format stream-json --output-format stream-json --json-schema <file> [--model <m>] [--effort <e>] --dangerously-skip-permissions --print-timeout 0 -p=` (the empty value attached, last), stdin one line `{"event":"user","message":{"content":"<prompt>"}}` then EOF. |
| agy | prompt on stdin in text mode | **Not possible.** Text input reads the prompt only from `-p`; `-p=-` is a literal "-". The changelog says `-p` no longer reads stdin when a prompt is given by flag. |
| agy | resume: `--conversation <id>` | **Confirmed** with the replacement form. |
| agy | stream input errors (free, no model call) | no `event`: "stream input message is missing the "event" field"; `"event":"user"` without `message`: "…missing the "message" field"; `message` a string: a decode error; `message: {}`: "…has no content"; empty `content`: "empty prompt". Each exits 1 with a `result` of status `ERROR` and zero usage. An unknown `event` value is only a warning. |

The Test button's restricted-mode flags (§3.4: Codex `-s read-only --skip-git-repo-check --ephemeral`, Claude Code
`--permission-mode plan --no-session-persistence`, agy `--mode plan`) were not run. agy's `-p` problem applies to the
Test button's form too.

## 3. Result and usage shapes

**Codex** (`--json`, JSONL on stdout; fixtures `codex-cli/*.stdout.jsonl`):
- `{"type":"thread.started","thread_id":"<uuid>"}` first, then `turn.started`, `item.started` / `item.completed`
  (`item.type`: `agent_message` with `text`, `command_execution` with `command`, `aggregated_output`, `exit_code`,
  `status`; `file_change` with `changes[{path, kind}]`; `error` with `message`), and `turn.completed`.
- The final `agent_message.text` is the schema JSON as a string; the same JSON is written to the `-o` file.
- Usage, on `turn.completed`: `{input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens,
  reasoning_output_tokens}`.
- Failure: `{"type":"error","message":…}` lines, then `{"type":"turn.failed","error":{"message":…}}`, exit 1.
  **An `error` event or item is not always fatal**: the unknown-model run's first `error` is a warning ("Model
  metadata for `cw0-no-such-model` not found. Defaulting to fallback metadata…"), and the logged-out run's `error`
  events are reconnect notices. Only `turn.failed` ends the turn.
- **The `-o` file is created even when no final message exists** (killed, model error, logged out): it is then
  0 bytes. Test for a non-empty, parsable file, not for its existence.

**Claude Code** `--output-format json` (one object; fixtures `claude-code/*.stdout.json`):
- `type: "result"`, `subtype` (`success` even for API errors), `is_error`, `result` (text), `structured_output`
  (the schema object), `session_id`, `num_turns`, `stop_reason`, `terminal_reason` (`completed`, `api_error`),
  `api_error_status` (e.g. 404), `api_error_type` (e.g. `not_found_error`), `duration_ms`, `total_cost_usd`
  (list price; not a bill under a subscription), `permission_denials`, `subagent_stats`.
- Usage: `usage {input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens, …}` and
  `modelUsage[<model>] {inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUSD,
  contextWindow, …}`. The model actually used is the `modelUsage` key (`claude-opus-5-5` with no `--model`).
- `credential_expires_at` is in the result; the parser must drop it (CW2's account-field rule).

**Claude Code** `--output-format stream-json --verbose` (fixtures `claude-code/background-streamjson.windows.stdout.jsonl`
and `claude-code/free/logged-out-streamjson.linux.stdout.jsonl`):
- `system` events (`hook_started`, `hook_response`, `init` with `session_id`, `model`, `tools`, `mcp_servers`,
  `plugins` and more, `task_started`, `background_tasks_changed`), `assistant` and `user` messages,
  `rate_limit_event`, and a final `result` object with the json mode's fields.
- Logged out: `init`, then an `assistant` event with `error`, then `result` with `subtype: "success"`, `is_error:
  true` and `result: "Not logged in · Please run /login"`; exit 1.
- `rate_limit_event.rate_limit_info`: `status` (`allowed`, `allowed_warning`), `rateLimitType` (`seven_day`),
  `utilization` (0–1), `resetsAt` (Unix seconds), `surpassedThreshold`, `unifiedWindows.{five_hour,seven_day}
  {utilization, resetsAt, status}`, and overage fields. The fixture's figures are synthetic; the shape is real.

**agy** stream-json (fixtures `agy/*.stdout.jsonl`):
- `{"event":"init","conversation_id":…,"init":{cwd, tools, permission_mode, json_schema}}`, then
  `{"event":"step_update","step_update":{conversation_id, step_index, state: ACTIVE|DONE, step_type:
  user_input|agent_response|tool|system_message|finish, text_delta?, tool_name?, tool_info?, usage?}}`, then
  `{"event":"result","result":{…}}`.
- `result`: `conversation_id`, `status` (`SUCCESS`, `ERROR`), `response` (text), `structured_output` (the schema
  object), `json_schema` (echoed), `duration_seconds`, `num_turns`, `error` and `finished_reason` on failure, and
  `usage {input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens}`.
- `--output-format json` (one object, fixture `agy/literal-dash-prompt.windows.stdout.json`) has the same `result`
  fields at the top level.

## 4. Session ids and resume

| CLI | Id | Where | Resume | Seen |
|---|---|---|---|---|
| Codex | thread id (UUID v7) | `thread.started.thread_id` | `exec resume <id> -`, cwd = worktree | same id on resume; the model remembered the earlier turn |
| Claude Code | session id (UUID the Runner chooses) | `--session-id`; `session_id` in the result | `-p --resume <id>`, same cwd | same id; remembered |
| agy | conversation id (UUID agy chooses) | `init.conversation_id`, every `step_update`, `result` | `--conversation <id>` | same id; remembered |

An agy run refused before any model call is not a resumable session. The `--effort` refusal prints no `init` event
and a `result` with `conversation_id: ""`; the free `/quota` command has `conversation_id: ""` too.

## 5. Exit codes

| CLI | 0 | 1 | Other | Killed by the Runner |
|---|---|---|---|---|
| Codex | the turn completed (done and needs-decision alike; the outcome is in the result) | the turn failed: unknown model, not logged in (it retries the 401 over WebSocket, then over HTTPS, then fails: 17 s) | — | exit code and signal `null` in the managed record (Windows and Linux); partial JSONL, no `turn.completed`, an empty `-o` file |
| Claude Code | the turn completed | `is_error: true` (unknown model 404, "Not logged in · Please run /login"), and the root refusal of `--dangerously-skip-permissions` (stderr only) | — | `null`; with json output nothing is printed |
| agy | the turn completed | stream-input errors; the `--effort` refusal ("invalid model selection (--model … --effort …): --effort is not supported for model …"; checked locally, no model call). This run shows how agy treats `--effort` for a model it doesn't know, not how it treats an unknown model alone | 2: argument errors; 3: model or agent errors after a partial stream (changelog, not observed) | `null`; partial `step_update` stream, no `result` |

The free checks' exit codes and output streams are in each CLI's `free/meta.json`: `codex login status` writes
"Logged in using ChatGPT" (exit 0) or "Not logged in" (exit 1) to stderr; `claude auth status` prints JSON with
`loggedIn` (exit 0 logged in, 1 logged out; logged in, it has `email`, `orgId` and `orgName`, which CW2 must drop);
`agy models` exits 0. agy was only seen logged in.

## 6. Descendants and process groups

### 6.1 Windows (Job backend)

| CLI | Runs | Descendants seen (per run) | Outside the Job after the verified stop |
|---|---|---|---|
| Codex | 7 | 36–49: `conhost`, `pwsh.exe` (the Microsoft Store alias in WindowsApps) for every shell command, `git`, `node_repl.exe`, `codex-code-mode-host.exe`, and the owner's configured MCP servers and hooks | **3 of 7 runs** (below) |
| Claude Code | 7 | 25–43 (the background-hang run's 149 includes pid-reuse noise): `conhost`, Git `bash.exe` and `sh.exe` per Bash tool call, `git`, `python3` hooks, the owner's configured MCP servers | none found in 6 runs; 1 run can't be classified (below) |
| agy | 11 | up to 23 (none for runs refused at once): `conhost`, `powershell.exe` for `run_command`, the owner's configured MCP servers | none found |

The Codex escapes:
- **Background run 1:** Codex ran `pwsh.exe -Command "Start-Process -FilePath (Get-Command node).Source
  -ArgumentList '-e', '…listen(0)' -WindowStyle Hidden"`. The node server appeared under a `pwsh.exe` that was in
  Codex's tree. After `closeAgent` returned a verified stop, it was still alive, `IsProcessInJob` was false, and its
  parent was gone. It was stopped by hand.
- **Background run 2, same prompt:** Codex ran the same `Start-Process` form. The harness reported nothing alive,
  because the pwsh that started the server (pid 69624) was never seen in the tree, most likely because it exited
  between two samples. A search by command line hours later found the server (pid 54776, created during the run),
  still running, in no Job, parent gone. It is left running for CW0b.
- **Unknown-model run:** Codex ran no command (the turn failed at once), but a hook process from a user-installed
  Codex plugin (Python) and its `conhost.exe` were alive after the verified stop, in no Job, parent gone. It exited on
  its own later.
- **Free reproductions** under the same harness and Job, each child tagged with a marker in its arguments and
  searched for machine-wide after the stop: Store `pwsh -Command Start-Process … -WindowStyle Hidden` (in Codex's
  exact form and in another), Windows PowerShell's `Start-Process`, and `[Diagnostics.Process]::Start` from Store
  pwsh. **All stayed inside the Job** and were killed by the stop. (A `cmd /c start` variant failed on quoting and
  proves nothing.) The difference from Codex: there the root was the Store pwsh itself; under Codex it is a
  grandchild that `codex.exe` starts.
- **The Job allows no breakaway.** Its `LimitFlags` are `KILL_ON_JOB_CLOSE` only (managed-process-job-host.ps1:552),
  with no `BREAKAWAY_OK` or `SILENT_BREAKAWAY_OK`, so `CREATE_BREAKAWAY_FROM_JOB` fails. The escaped processes were
  created outside the Job by another path.
- **Candidate mechanism, not shown:** the job host sets `PROCESS_CREATION_DESKTOP_APP_BREAKAWAY_DISABLE_PROCESS_TREE`
  through `PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY` on the root it creates (:379). When the attribute list cannot be
  built or updated, it drops the attribute and launches without it, with no error (:365-386). The Store `pwsh.exe` is
  a packaged app, and that policy governs whether a packaged app's processes run inside the creator's tree. A
  descendant that creates a process with the opposite policy would also override it. CW0b traces which applies; this
  spike did not change the script.
- **Claude Code's unclassified run** (`background-hang.windows`) predates the pid-reuse rule and the job check. Its
  600 s tree holds processes Claude Code cannot have started (`docker.exe`, `gh.exe` from other work on the machine).
  Claude Code's own session log shows one Bash call only: the background server. A server like that never exits on its
  own, and none of the 14 survivors was alive 5 minutes after the stop, so the server stayed in the Job. The other 13
  cannot be told apart from pid-reuse noise. The stream-json rerun of the same prompt, with both fixes, saw the server
  in its tree and found nothing alive after the stop. A machine-wide search by command line for the spike's server
  code and paths, the evening of 2026-11-17, found only Codex's run-2 server.
- Consequence: on Windows the Job's `contained_workload` stop text ("The process and every process it started have
  exited") is not true for a Codex worker. Before this PR, the plan's §3.11 treated escapes as a POSIX matter only;
  its amendment adds the Windows Job and refuses Codex on Windows until the escape is explained and fixed (CWD-10).

### 6.2 Linux (portable supervisor, process group)

The managed group leader is `portable-process-child.mjs` (its own session); the CLI runs inside that group. No user
configuration (MCP servers, hooks) existed in the container.

| CLI | In the group | Left the group |
|---|---|---|
| Codex | `codex exec` | every shell command: `/bin/sh -lc …` with **a new session** (setsid) and its children; `git` and `codex-code-mode --listen` in **their own process groups** (same session) |
| Claude Code | `claude -p`, `git` | every Bash tool command: `bash -c …` with **a new session**, and its children (`node --test`, the background server) |
| agy | not measured | not measured |

After the verified group stop:
- Codex killed run: `codex-code-mode` (own group) still alive.
- Claude Code background run: the `node` server (new session) still alive.
- Both were zombies (exited) when checked again about two minutes later. The harness did not record when or why they
  exited.
- **Codex background run:** Codex ran `/bin/sh -lc "nohup node … </dev/null >/dev/null 2>&1 &"`. Its
  `aliveAfterStop` is empty only because the observer never saw the shell or the server: the shell exited between two
  150 ms samples, and the server, reparented to PID 1, had no seen parent. The server ran in its own session
  (sid 9808, outside the managed group) and is a zombie in the container now; when it exited is not recorded.

A tool command that keeps running (a dev server started by a shell command) is outside what the Runner can prove
stopped on POSIX, exactly the case §3.11 and §6 risk 3 describe.

**macOS: not measured.** The CLIs' process launching on macOS is likely the same POSIX code path, but that is a guess.

## 7. Other findings

- **Claude Code and background tasks (Windows and Linux).** With a `run_in_background` Bash task running, `claude -p`
  ends its turn (structured output given, Stop hook run) and then waits for the task. A server never ends, so the
  process never exits; with json output it prints nothing, and the result is lost. The deadline (90 min, CWD-6) would
  stop it and fail the attempt. With stream-json, the `result` event arrives at the end of the turn. The CLI branch
  can then take the result and stop the owner (§3.5 step 5) without waiting for an exit. agy behaves differently: it
  ran the server with `run_command` and exited 0 with its result. The step's parameters show only `CommandLine`;
  agy's own reply text says it used `IsDaemon=true`. Codex's `Start-Process` server outlived Codex itself (§6.1).
- **agy quota for free.** `agy --output-format json -p=/quota`, run from PowerShell, returns `command.name: "usage"`
  and `command.data.groups[{name, description, buckets[{id, name, description, window: weekly|5h,
  remaining_fraction, reset_time}]}]`, with `num_turns` 0, every token count 0 and an empty `conversation_id`
  (fixture `agy/free/quota.json`, figures synthetic). From Git Bash, `/quota` must be protected from path conversion
  (`MSYS_NO_PATHCONV=1`), or agy gets a path and runs a real turn. CW3's Test button and CW4's free checks can show
  agy's remaining usage and reset times without a prompt, and a `remaining_fraction` of 0 with a stated `reset_time`
  is a usage limit with a stated reset (§3.8's rule).
- **Claude Code `rate_limit_event`** (stream-json only) states `resetsAt` per window: a provider-stated reset for
  §3.8. It appears only inside a run that spends usage, so it is no free check; the Test button, which sends a prompt
  anyway, could read it.
- **`codex debug models`:** `{"models":[…]}`, 10 entries, 8 with `visibility: "list"`; `supported_reasoning_levels`
  is a list of `{effort, description}` (efforts `low` … `max`, and `ultra` on some).
- **`agy models`:** a "Fetching available models..." line, then one `id<TAB>name` line per model (18).
- **Codex on Windows runs shell commands through the Store `pwsh.exe` alias** (WindowsApps), when it is installed.
- **Every CLI loads the user's own MCP servers and hooks** in a headless run (dozens of processes per Codex run here).
  They are inside the Job on Windows except as in §6.1, and they add launch time: launches took 1.0–3.2 s on Windows.

## 8. Windows fence claims (OS-lock fence, 15 s default claim deadline)

A failed claim surfaces as a start error (`OwnedFenceContentionError`, `OwnedFenceLockUnavailableError`) or an
unverified stop (`AgentCleanupUnverifiedError`); the harness recorded every start and stop error with its cause chain.

| Load | Workers at once | Launches | Failed claims at launch | Unverified stops | Launch p50 / p95 / max | Stop p50 / p95 / max |
|---|---|---|---|---|---|---|
| real CLIs (all rounds) | 1–4 | 25 | 0 | 0 | — / — / 3,226 ms | — / — / 263 ms |
| fake CLI load, stop after exit | 2 | 80 | 0 | 0 | 756 / 1,071 / 1,248 ms | 3 / 5 / 5 ms |
| fake CLI load, stop after exit | 4 | 120 | 0 | 0 | 1,274 / 1,823 / 2,192 ms | 3 / 5 / 6 ms |
| fake CLI load, stop while running | 2 | 50 | 0 | 0 | 872 / 1,167 / 1,370 ms | 459 / 2,037 / 2,256 ms |
| fake CLI load, stop while running | 4 | 100 | 0 | 0 | 1,326 / 1,867 / 1,995 ms | 2,647 / 5,598 / 6,108 ms |

- **The real launches:** Codex 7, Claude Code 7, agy 11. One round ran 4 at once (round A: Codex, Claude Code and two
  agy runs); three ran 3 at once (rounds B, E and F: one of each CLI); three ran 2 at once (A2: two agy runs; C: four
  runs two at a time; D: Claude Code and agy); four ran alone. So the real sample at 4 at once is one round of 4
  launches, and at 2 at once three rounds of 8 launches. **The 2- and 4-at-once figures rest mainly on the fake
  load.** Of agy's 11 launches, 9 have fixtures. The other two, both under the harness, repeat a fixture's refusal
  and are not committed: round A's second agy run (the `-p` argument error, exit 2) and round A3 (the missing `event`
  refusal, exit 1). The Git Bash `/quota` accident ran outside the harness and is not among the 25.
- The fake load is a Node program that reads stdin, runs a shell with `node --test`, `git status` and a CPU-bound
  child for 6 s (60 s for the stop-while-running rows, stopped at 5 s).
- No Windows Job host record write failed (#221's replace retry). The waits that succeeded were not instrumented, so
  how long any of them waited is not known.
- Stop time grows with concurrency when processes are still running: up to 6.1 s with 4 at once, 41% of the 15 s
  deadline. The descendant observer was running during the stop-while-running rows and adds host load of its own.

## 9. What this means for the plan

The owner's decisions of 2026-11-17 on item 3 (CWD-10, Codex on Windows, and CWD-11, the POSIX refusal) are in the
plan amendment in the same pull request.
1. §3.5 agy row: replace the arguments with the stream-json form of §2.
2. §3.5 Claude Code row: `--output-format stream-json --verbose`; the turn ends at the `result` event. That changes
   §3.5 step 4 (wait for the `result` event or the exit, not only the exit) and §3.11 case 2 (the CLI may still be
   running when its result is in hand and the stop runs; "the CLI had exited before the unproven stop" becomes "the
   CLI had delivered its result or exited").
3. §3.11 Escapes: on Linux both measured CLIs leave the group by design, so the plan's own rule refuses them there.
   §3.11 is per OS and macOS was not measured; refusing them on macOS too is the fail-closed reading, not a
   measurement. agy was not measured on any POSIX system. On Windows, Codex left the Job in 3 of 7 runs (§6.1).
4. §3.12 and CW4: a Runner running as root cannot start Claude Code with `--dangerously-skip-permissions`.
5. §3.4 and §3.8: agy `/quota` is a free stated remaining usage and reset; Claude Code's `rate_limit_event` is a
   stated reset inside a paid run; Codex has neither.
6. §3.8 rows that no fixture pins yet, and CW2 needs the owner's logs for them:
   - a real usage-limit output from each CLI (Codex `--json` stdout and stderr with the limit, agy's exit-3 stream,
     Claude Code's `is_error` result or `rate_limit_event` at `rejected`);
   - a 429, and a 5xx or overload message, from any CLI;
   - agy logged out.
   Three rows differ from what was captured:
   - `agy/model-unavailable` is the `--effort` refusal, not agy's answer to an unknown model;
   - Codex's unknown-model text is "The 'cw0-no-such-model' model is not supported when using Codex with a ChatGPT
     account.", not the `model_not_found` §3.8 names;
   - §3.8's "no `-o` file" for the Codex usage limit is wrong for every failure seen: the file exists with 0 bytes.
7. The result schema the runs used (`result.schema.json`) differs from `CliWorkerResultV1` (§3.5 step 1): every field
   is required and the optional ones (`question`, `replanReason`) are nullable, for OpenAI's strict mode; `notRun` and
   `concerns` are required arrays; and `checks` lacked `cwd`, `outputs` and `criterionIds`. CW2's schema needs the same
   strict-mode form, with the missing check fields added as required and nullable.
