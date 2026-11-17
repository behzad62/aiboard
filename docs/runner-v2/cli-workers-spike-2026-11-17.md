# CW0 spike: Codex CLI, Claude Code and agy as Runner-managed processes

Date: 2026-11-17. Packet CW0 of docs/plans/2026-11-14-cli-workers.md (§5). Spike only: no product code. Fixtures are in
`runner-v2/test/fixtures/cli-workers/` (its README describes the layout and the scrubbing). Base: main 935a176e.

## 0. What CW2 and CW5 need to know first

1. **agy: the §3.5 arguments do not work.** `-p` takes the next argument as its prompt (exit 2), and
   `--input-format stream-json` requires `--output-format stream-json`. Text-mode `-p` cannot read the prompt from
   stdin (`-p=-` is the literal prompt "-"). The working form is stream-json in and out with an empty, attached
   `-p=` last, and one stdin line `{"event":"user","message":{"content":"<prompt>"}}` (§2).
2. **Linux: Codex and Claude Code leave the managed process group in normal use, by design.** Every Codex shell
   command runs as `/bin/sh -lc` in a new session; Codex's `git` and its `codex-code-mode --listen` host get their own
   process groups. Every Claude Code Bash tool command runs as `bash -c` in a new session. The portable backend's
   verified stop covers only the group, and after it a Codex `codex-code-mode` and a Claude Code background server
   were still running (§6). By §3.11 ("If one does by design, CLI workers for that CLI are refused on that OS until a
   design amendment"), CLI workers for both are refused on POSIX until an amendment, for example the cgroup v2
   `contained_workload` adapter that docs/runner-v2/posix-detached-descendants.md names as the candidate.
3. **Windows: Codex left a process outside the Runner's Job in 2 of its 7 Windows runs.** Once it was a background
   server started with `pwsh -Command Start-Process … -WindowStyle Hidden`; once it was a Codex hook from the owner's
   TokenEconomizer plugin, in a run where Codex ran no command at all. Both were alive after a verified Job stop, in
   no job (`IsProcessInJob` false), with their parent gone. The Runner's Job allows no breakaway (`LimitFlags` is
   `KILL_ON_JOB_CLOSE` only, managed-process-job-host.ps1:552), so they were created outside the Job some other way.
   The mechanism is not known; four free reproductions of the same `Start-Process` stayed inside the Job. Claude Code
   (7 runs) and agy (6 runs) left nothing outside the Job. This is a containment gap §3.11 does not cover today
   (§6.1); it needs the owner's decision before CW5.
4. **Claude Code `-p` does not exit while a `run_in_background` task runs.** With `--output-format json` it then prints
   nothing at all, so the result is lost when the Runner stops it at the deadline. With `--output-format stream-json
   --verbose`, the `result` event (with `structured_output`) arrives when the turn ends, about 6 s in, while the
   process stays up. CW2 should use stream-json for Claude Code and treat its `result` event as the end of the turn
   (§3, §7).
5. **Two CLIs report usage without spending any.** agy: `agy -p=/quota --output-format json` (or `/usage`) returns
   remaining fractions and reset times per model group, with zero tokens and no conversation. Claude Code:
   stream-json emits `rate_limit_event` with `utilization`, `status` and `resetsAt` (Unix seconds) per window. The
   plan's "None of the CLIs reports remaining usage" (§3.4) is no longer true for these two (§7).
6. **Claude Code as root refuses `--dangerously-skip-permissions`** ("cannot be used with root/sudo privileges for
   security reasons", exit 1). A Runner running as root (Docker, some CI) cannot launch it with the plan's flag (§5).
7. **Fence claims: no failure.** On Windows, 0 failed claims at launch or stop across 25 real CLI launches (1 to 4 at
   once) and 350 launches of a fake CLI-shaped load (2 and 4 at once), on the OS-lock fence with its 15 s default
   deadline (§8).

## 1. What ran

**Harness** (throwaway, not committed): one `createExecutionHost` + `bindRun` (permission profile `full`), a
`ToolBroker` that issues the real execution grant, and `ManagedProcessService.start` with `interactive: true` for each
run, one worker owner per run, in a fresh clone of a toy repository (`sum.js`, `sum.test.js`, `package.json`). The
prompt went to stdin and stdin was closed (`writeInput` with `closeInput`). Output was read in pages until the process
exited, then the harness called `closeAgent(owner)` and checked that no process it had seen was still alive. A
separate observer sampled the host's process table (Windows: `Win32_Process` every 0.5 s; Linux: `/proc` every 150 ms)
to build each run's descendant tree. The observer is the spike's own and is not part of the Runner. A process counts
as a descendant only when its parent was seen and was created before it (this drops processes whose parent pid was
reused; runs before that rule was added list some unrelated host processes, and their counts in §6 are approximate).
The result schema had `outcome`, `summary`, `question`, `replanReason`, `checks` (`label`, `executable`, `args`),
`notRun` and `concerns`, every field required, with `null` allowed for `question` and `replanReason` (OpenAI's
strict-schema rule).

**Platforms.**
- Windows 10 Pro 19045 (this PC), Job backend.
- Linux: Debian bookworm in Docker (`node:24-bookworm-slim`, 4 CPUs), portable supervisor. Codex and Claude Code were
  installed from npm and logged in by the owner inside the container as a non-root user. agy was not installed on
  Linux (its Linux installer is not known here).
- **Not covered: macOS** (no Mac reachable), **agy on Linux**, and **any real usage-limit output** (no CLI hit a
  limit; the owner's earlier logs are prose only, docs/plans/2026-11-03-simple-build-and-delegate.md §2.1).

**Prompts** (the owner's "go" on 2026-11-17, CWD-1; at most ten per CLI). Spent: Codex 10, Claude Code 10, agy 6.
agy runs refused before any model call (exit 2 argument errors, stream-input errors, the unknown-model refusal) are
not counted.

| Case | Prompt (abridged) | Codex | Claude Code | agy |
|---|---|---|---|---|
| success | add `mul(a, b)` to sum.js and one test, run `node --test` once, don't commit, reply with the schema | Win, Linux | Win, Linux | Win (+1 probe: `-p=-`) |
| resume | resume the success session: "name the function you added" | Win | Win | Win |
| needs-decision | "divide(a, b), but what when b is 0? don't guess" | Win | Win (`--model sonnet`) | Win |
| background | start `node -e "require('http').createServer(…).listen(0)"` in the background, reply | Win ×2, Linux | Win (json), Win (stream-json), Linux | Win |
| killed | the success prompt, `process.signal` SIGTERM 12 s after launch | Win, Linux | Win, Linux (finished before the signal) | Win |
| model unavailable | a tiny prompt with model `cw0-no-such-model` | Win | Win | Win (refused locally) |
| logged out | the success prompt with no login (Linux, free) | Linux | Linux | — |

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

## 3. Result and usage shapes

**Codex** (`--json`, JSONL on stdout; fixtures `codex-cli/*.stdout.jsonl`):
- `{"type":"thread.started","thread_id":"<uuid>"}` first, then `turn.started`, `item.started` / `item.completed`
  (`item.type`: `agent_message` with `text`, `command_execution` with `command`, `aggregated_output`, `exit_code`,
  `status`; `file_change` with `changes[{path, kind}]`; `error` with `message`), and `turn.completed`.
- The final `agent_message.text` is the schema JSON as a string; the same JSON is written to the `-o` file.
- Usage, on `turn.completed`: `{input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens,
  reasoning_output_tokens}`.
- Failure: `{"type":"error","message":…}` lines, then `{"type":"turn.failed","error":{"message":…}}`, exit 1.
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

**Claude Code** `--output-format stream-json --verbose` (fixture `claude-code/background-streamjson.windows.stdout.jsonl`):
- `system` events (`hook_started`, `hook_response`, `init` with `session_id`, `model`, `tools`, `mcp_servers`,
  `plugins` and more, `task_started`, `background_tasks_changed`), `assistant` and `user` messages,
  `rate_limit_event`, and a final `result` object identical in shape to the json mode's.
- `rate_limit_event.rate_limit_info`: `status` (`allowed`, `allowed_warning`), `rateLimitType` (`seven_day`),
  `utilization` (0–1), `resetsAt` (Unix seconds), `surpassedThreshold`, `unifiedWindows.{five_hour,seven_day}
  {utilization, resetsAt, status}`, and overage fields.

**agy** stream-json (fixtures `agy/*.stdout.jsonl`):
- `{"event":"init","conversation_id":…,"init":{cwd, tools, permission_mode, json_schema}}`, then
  `{"event":"step_update","step_update":{conversation_id, step_index, state: ACTIVE|DONE, step_type:
  user_input|agent_response|tool|finish, text_delta?, tool_name?, tool_info?, usage?}}`, then
  `{"event":"result","result":{…}}`.
- `result`: `conversation_id`, `status` (`SUCCESS`, `ERROR`), `response` (text), `structured_output` (the schema
  object), `json_schema` (echoed), `duration_seconds`, `num_turns`, `error` and `finished_reason` on failure, and
  `usage {input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens}`.
- `--output-format json` (one object, fixture `agy/literal-dash-prompt.windows.stdout.jsonl`) has the same `result`
  fields at the top level.

## 4. Session ids and resume

| CLI | Id | Where | Resume | Seen |
|---|---|---|---|---|
| Codex | thread id (UUID v7) | `thread.started.thread_id` | `exec resume <id> -`, cwd = worktree | same id on resume; the model remembered the earlier turn |
| Claude Code | session id (UUID the Runner chooses) | `--session-id`; `session_id` in the result | `-p --resume <id>`, same cwd | same id; remembered |
| agy | conversation id (UUID agy chooses) | `init.conversation_id`, every `step_update`, `result` | `--conversation <id>` | same id; remembered |

An agy run refused before any model call still prints a fresh `conversation_id`; it is not a resumable session.

## 5. Exit codes

| CLI | 0 | 1 | Other | Killed by the Runner |
|---|---|---|---|---|
| Codex | the turn completed (done and needs-decision alike; the outcome is in the result) | the turn failed: unknown model, not logged in (it retries the 401 over WebSocket, then over HTTPS, then fails: 17 s) | — | exit code and signal `null` in the managed record (Windows and Linux); partial JSONL, no `turn.completed`, an empty `-o` file |
| Claude Code | the turn completed | `is_error: true` (unknown model 404, "Not logged in · Please run /login"), and the root refusal of `--dangerously-skip-permissions` (stderr only) | — | `null`; with json output nothing is printed |
| agy | the turn completed | stream-input errors, the unknown-model refusal ("invalid model selection (--model … --effort …): --effort is not supported for model …"; checked locally, no model call) | 2: argument errors; 3: model or agent errors after a partial stream (changelog, not observed) | `null`; partial `step_update` stream, no `result` |

Logged-out free checks: `codex login status` prints "Not logged in", exit 1; `claude auth status` prints JSON with
`loggedIn: false`, exit 1 (logged in: exit 0, with `email`, `orgId`, `orgName` that CW2 must drop). The Windows
login state of agy was only seen logged in (`agy models` exit 0).

## 6. Descendants and process groups

### 6.1 Windows (Job backend)

| CLI | Descendants seen (per run) | Outside the Job after the verified stop |
|---|---|---|
| Codex | 36–49: `conhost`, `pwsh.exe` (the Microsoft Store alias in WindowsApps) for every shell command, `git`, `node_repl.exe`, `codex-code-mode-host.exe`, and the owner's configured MCP servers and hooks (Blender, Unity, ComfyUI, Krita through `uvx`/`uv`, Python) | **2 of 7 runs** (below) |
| Claude Code | 25–43 (the background run's 149 includes pid-reuse noise): `conhost`, Git `bash.exe` and `sh.exe` per Bash tool call, `git`, `python3` hooks, the owner's MCP servers (Blender, Unity) | none in 7 runs |
| agy | 14–23: `conhost`, `powershell.exe` for `run_command`, `uvx`/`uv`/`windows-mcp`, the owner's MCP servers | none in 6 runs |

The Codex escapes:
- **Background run 1:** Codex ran `pwsh.exe -Command "Start-Process -FilePath (Get-Command node).Source
  -ArgumentList '-e', '…listen(0)' -WindowStyle Hidden"`. The node server appeared under `pwsh.exe` while Codex
  ran. After `closeAgent` returned a verified stop, it was still alive, `IsProcessInJob` was false, and its parent was
  gone. Background run 2, same prompt: the server never appeared in the tree (it likely failed to start), and nothing
  survived.
- **Unknown-model run:** Codex ran no command (the turn failed at once), but a
  `python -m tokeneconomizer.plugin.cli toolprune apply-pending --host codex --cwd <workspace>` process (a hook of the
  owner's TokenEconomizer plugin) and its `conhost.exe` were alive after the verified stop, in no job, parent gone.
  At the time of writing it was still running, about 35 minutes later.
- Free reproductions under the same harness and Job: Store `pwsh -Command Start-Process … -WindowStyle Hidden`,
  Windows PowerShell's `Start-Process`, `cmd /c start "" /b node …`, and `[Diagnostics.Process]::Start` from Store
  pwsh. **All four stayed inside the Job** and were killed by the stop.
- The Runner's Job has `KILL_ON_JOB_CLOSE` only (no `BREAKAWAY_OK` or `SILENT_BREAKAWAY_OK`), so a child cannot break
  away from it with `CREATE_BREAKAWAY_FROM_JOB`. The escaped processes were created outside the Job by some other path
  that Codex (or the hook runner it uses) takes. This spike did not find which.
- Consequence: on Windows the Job's `contained_workload` stop text ("The process and every process it started have
  exited") is not true for a Codex worker. The plan's §3.11 treats escapes as a POSIX matter only.

### 6.2 Linux (portable supervisor, process group)

The managed group leader is `portable-process-child.mjs` (its own session); the CLI runs inside that group. No user
configuration (MCP servers, hooks) existed in the container.

| CLI | In the group | Left the group |
|---|---|---|
| Codex | `codex exec` | every shell command: `/bin/sh -lc …` with **a new session** (setsid) and its children; `git` and `codex-code-mode --listen` in **their own process groups** (same session) |
| Claude Code | `claude -p`, `git` | every Bash tool command: `bash -c …` with **a new session**, and its children (`node --test`, the background server) |
| agy | not measured | not measured |

After the verified group stop: Codex killed run, `codex-code-mode` (own group) still alive; Claude Code background run,
the `node` server (new session) still alive. Both were zombies (exited) when checked again about two minutes later, so
they did exit on their own, likely when their parent's pipe closed or because Claude Code cleans up its background
tasks on SIGTERM. The harness did not record when. A tool command that keeps running (a dev server started by a
shell command) is outside what the Runner can prove stopped on POSIX, exactly the case §3.11 and §6 risk 3 describe.

**macOS: not measured.** The CLIs' process launching on macOS is likely the same POSIX code path, but that is a guess.

## 7. Other findings

- **Claude Code and background tasks (Windows and Linux).** With a `run_in_background` Bash task running, `claude -p`
  ends its turn (structured output given, Stop hook run) and then waits for the task. A server never ends, so the
  process never exits; with json output it prints nothing, and the result is lost. The deadline (90 min, CWD-6) would
  stop it and fail the attempt. With stream-json, the `result` event arrives at the end of the turn. The CLI branch
  can then take the result and stop the owner (§3.5 step 5) without waiting for an exit. agy behaves differently: it
  ran the server with `run_command` `IsDaemon=true` and exited 0 with its result. Codex's `Start-Process` server
  outlived Codex itself (§6.1).
- **agy quota for free.** `agy -p=/quota --output-format json` (and `/usage`) returns
  `command.data.groups[{name, buckets[{id, window: weekly|5h, remaining_fraction, reset_time}]}]` with zero usage
  and an empty `conversation_id` (fixture `agy/free/quota.json`). CW3's Test button and CW4's free checks can show
  agy's remaining usage and reset times without a prompt, and a `remaining_fraction` of 0 with a stated `reset_time`
  is a usage limit with a stated reset (§3.8's rule). The changelog says `/usage`, `/quota`, `/credits`, `/model`,
  `/effort` and `/skills` in print mode spend no quota.
- **Claude Code `rate_limit_event`** (stream-json only) states `resetsAt` per window: a provider-stated reset for
  §3.8. The run here showed `allowed_warning` at 85% of the seven-day window.
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

- The fake load is a Node program that reads stdin, runs a shell with `node --test`, `git status` and a CPU-bound
  child for 6 s (60 s for the stop-while-running rows, stopped at 5 s). The real-CLI rounds had 4, 3, 2 and 1 workers
  at once (25 launches in all), so the real sample at 4 is one round.
- No Windows Job host record write failed (#221's replace retry). The waits that succeeded were not instrumented, so
  how long any of them waited is not known.
- Stop time grows with concurrency when processes are still running: up to 6.1 s with 4 at once, 41% of the 15 s
  deadline. The descendant observer was running during the stop-while-running rows and adds host load of its own.

## 9. What this means for the plan (for the owner and the CW2/CW5 authors)

These are findings, not plan changes; the plan's owner decides.
1. §3.5 agy row: replace the arguments with the stream-json form of §2.
2. §3.5 Claude Code row: `--output-format stream-json --verbose`; the turn ends at the `result` event.
3. §3.11 Escapes: on POSIX both measured CLIs leave the group by design, so the plan's own rule refuses them there
   until an amendment. On Windows, Codex can leave the Job (§6.1); whether Codex CLI workers are refused on Windows
   too, until the mechanism is found, is a decision for the owner. A follow-up that traces how those processes are
   created (for example with Process Monitor on a Codex run under the Job) would settle it.
4. §3.12 and CW4: a Runner running as root cannot start Claude Code with `--dangerously-skip-permissions`. Either
   refuse Claude Code workers under root with a clear reason, or settle a different launch form with the owner.
5. §3.4 and §3.8: agy `/quota` and Claude Code's `rate_limit_event` are stated reset times and remaining usage; Codex
   still has neither.
6. §3.8 fixtures still missing: a real usage-limit output from each CLI (Codex `--json` stdout and stderr with the
   limit, agy's exit-3 stream, Claude Code's `is_error` result or `rate_limit_event` at `rejected`). CW2 needs the
   owner's logs for those rows.
