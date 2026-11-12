# AIBoard Simple Build and Delegate — One-Model Runner Tasks for the Web and a One-Shot `aiboard exec` — Implementation Plan
Date: 2026-11-03; revised 2026-11-11
Status: Ready to implement. The owner accepted every §14 decision on 2026-11-11. Order (owner decision, 2026-11-12, OD-33): the AIBoard home first, then CLI workers in their own plan, both built in Claude Code sessions; then an AIBoard Build with CLI workers builds Simple Build and `aiboard exec` (§18.1). The plan and the pre-launch fixes to AGENTS.md and CLAUDE.md (§17) are on main since 2026-11-11 (PR #171). Pushes, merges, releases and deploys stay with the owner.
**Revision 2026-11-11.** The owner chose a different Delegate. It is a one-shot, headless `aiboard exec` that works like `codex exec` or `claude -p`: no web app, no Runner server, no MCP server, nothing left running after it exits. Delegates get the same access choices as the web, Full included. The earlier Delegate design (the `aiboard task` CLI over a running Runner, the local MCP `task_*` tools, the tasks-scope proxy, `launchKind`, typed idle expiry, the delegation policy and the per-folder `delegate:` runtimes) is withdrawn; §16 says why. The Simple Build half is unchanged except where noted. Sections rewritten for this revision: §0, §4.1, §4.3, §5.5, §5.7, §5.8, §6.1 (Delegation), §6.2, §6.3, §6.4, §7.2, §7.5, §8.1, §8.2, §9, §10, §11, §13, §14, §15, §16, §17. It was reviewed independently on 2026-11-11 (see Review below).
**Revision 2026-11-11 (b): the AIBoard home.** The owner decided that AIBoard is a CLI tool with the browser as its GUI. Settings and keys therefore move from each browser's store to one per-user folder, `~/.aiboard`. The web edits it through a connected Runner, the CLI edits it directly, and `aiboard exec` reads it. Browser model calls go through the Runner. Existing browser settings are not copied (start fresh), and the passphrase option is removed. This replaces the delegate profile and Settings > Delegation of the first 2026-11-11 revision, and adds packets HM1–HM6. Sections touched: §0, §1, §3, §4.1–§4.3, §5.1, §5.5, §5.8, §5.10, §6.1–§6.3, the new §6.6, §8.1, §9, §10, §13–§17 and the appendix. Reviewed with the first 2026-11-11 revision (see Review below).
Primary repository: D:\repos\ai-discussion-board, audited at 16927e5f (2026-11-03). The plan branch was brought up to main at 3903fc46 (Runner 0.3.16) on 2026-11-11. Citations marked *(3903fc46)* were read at that commit; the others are at 16927e5f and must be re-checked against current main before a packet starts. The 2026-11-11 review also read main at 8e9c6c06. It differs from 3903fc46 only in a new .github/workflows/runner-bundle-closure.yml, five lines added to docs/plans/2026-10-27-aiboard-remote-STATUS.md (whose citations here use 8e9c6c06's line numbers), and runner-v2/src/language-server-executable.ts with its test, which this plan does not cite. Since 16927e5f, main added persistent shell sessions (shell-session.ts:11-18), Anthropic's bash tool for Claude 4 and later (anthropic-bash-tool.ts:1-8) and OpenAI's shell tool for GPT-6 (openai-shell-tool.ts:2-9) in Build *(3903fc46)*. A task's model loop gets the same native tools, within the same limits (§12.2), so a delegated Claude model works through the bash it expects.
Tools inspected on this PC with read-only `--help` (no prompts sent): codex-cli 0.166.0, Claude Code 2.1.317, agy 1.4.12; MCP SDK `@modelcontextprotocol/server` 2.4.0 (package.json:55).
Review: four independent reviews (CLI claims, feasibility, code claims, safety invariants) raised 97 findings against the first draft. A skeptic re-checked each lens: 94 were confirmed and 3 rejected. The rejected ones: no new denial circuit breaker is needed (§8.2); the architecture.md correction stands as first written (§17 item 6); the `keep` recipe is not a missing gate (§7.2). A recheck of that revision then tested its new mechanisms against the code (19 findings) and the whole document against the 94 (25 findings, four overlapping). Their code citations were spot-checked. This revision applies all of them; where a finding offered options, the choice is stated where it applies. A third round on 2026-11-11 reviewed both 2026-11-11 revisions with four independent reviews: the AIBoard home (27 findings), `aiboard exec` (28 findings, plus gaps it listed), drift against the code and current main (15), and the project docs that an unattended Build reads (26). Each finding was checked in the code before it was applied. The stale docs became §17's items; the ones that must be fixed before the Build starts are listed in §18.3.
Audience: the owner, and whoever implements the packets: a person, a coding agent, or AIBoard's own Build mode (§18).
Path convention: bare file names are under `runner-v2/src/`; `test/...` is `runner-v2/test/...`; other paths are repo-relative. Line numbers are at 16927e5f unless marked *(3903fc46)*.

## 0. TL;DR

- **Recommendation.** Build one task engine, `SoloTaskRuntime`, outside the Build scheduler kernel, and host it two ways.
  - A *task* is one model, one reasoning effort and one access level. Writing tasks work in their own git worktree through the Runner's existing agent loop, tool broker, execution host, worktree and ChangeSet machinery.
  - A task stops at a *handoff*: keep the branch, export a patch, apply it to the project, or discard it.
  - **Simple Build** (web): the Runner hosts tasks in `SoloTaskService`, with a durable, encrypted store (`state/solo-tasks.sqlite`), HTTP routes and a web view.
  - **Delegate** (`aiboard exec`): a one-shot, headless command that hosts exactly one task in its own process, prints a JSON result and exits, like `codex exec`. No web app, no Runner server, no MCP server. It uses the models enabled in the user's AIBoard home, set up in the web's Settings or with `aiboard models` (§9).
  - **AIBoard home**: settings and keys move from each browser to `~/.aiboard`, which every surface shares. The web edits it through a connected Runner, and its model calls go through that Runner (§5.8, §9).
  - Remote X3 and ACP come later, on the Runner-hosted service.
  - **Order** (owner decision, 2026-11-12): the AIBoard home first, then CLI workers (Codex CLI, Claude Code and agy as Build workers, in their own plan), both in Claude Code sessions. An AIBoard Build with CLI workers then builds Simple Build and `aiboard exec` (§18.1, OD-33).
- **Do not expose the existing solo sessions as they are.** ToolBench runs at Full access, edits the project folder in place (toolbench-session.ts:181-182) and fails on restart (:108-131). Runner Chat has read-only file tools (chat-agent-session.ts:284).
- **Four findings shape the design:**
  1. **No command isolation on a stock install.**
     - Only Full-profile bindings can run commands (execution-isolation-provider.ts:347-362; runner-capabilities-config.ts:80-98).
     - So any level that runs commands is unconfined. Commands run as the user. They can read the Runner's state, including the storage key and the credential stores it unlocks.
     - The level is therefore named `workspace_unconfined`, and both the web and `aiboard exec` say so before the first model call. Delegates get the same choices as the web, Full included, as with Codex's or agy's bypass flags (owner decision, OD-2/OD-3).
     - Approvals and budgets bind Runner tools, not a model with an unconfined shell (§8.1).
     - Such a shell can also commit on the task branch. So the finish pipeline folds model commits back into its own secret-checked commit (§12.3).
  2. **Auto-apply: the code's rule wins** (OD-1, decided).
     - The docs said final project handoff always pauses for the user (AGENTS.md:42 at 3903fc46). The code applies finished Builds automatically under the `finish` and `budgeted` run policies (native-build-manager.ts:1145-1150).
     - The docs are stale: AGENTS.md was corrected on 2026-11-11, and the two Runner V2 docs follow in SB0 (§17). Tasks may apply automatically: the web user chooses `apply_if_clean`, and `aiboard exec` applies its patch to the working tree by default when it applies cleanly and no secret was found (§7.2).
  3. **A delegate cannot need a running Runner.** Callers run one-shot commands, and every inspected CLI ends its child processes when its run ends. So `aiboard exec` composes its own execution host for one task (`createExecutionHost`, execution-host.ts:206 *(3903fc46)*), under a per-task state root. Its owner tether stops what the task started, even when the process is killed (§11.2).
     - A folder is either open in a Runner (web) or used by `aiboard exec` processes, never both. Any number of `aiboard exec` processes can share a folder (§11.1, OD-22).
  4. **Delegates cannot reach models today, and nothing outside a browser can.**
     - Keys and enabled models live in each browser's own store (lib/client/store.ts:71-101; lib/client/storage-adapter.ts:58, :598-619 *(3903fc46)*). The Runner keeps only the provider configs the web pushed to one folder, and never removes one (control-server.ts:583-607, :1680-1705 *(3903fc46)*). The Runner has no model catalog.
     - So settings and keys move to one per-user folder, the **AIBoard home** (`~/.aiboard`; owner decision, 2026-11-11). The web edits it through any connected Runner, the CLI edits it directly, and `aiboard exec` reads it in any folder, linked worktrees included. Browser model calls go through the Runner, which adds the key (§5.8, §9).
- **Estimate (focused engineer-days):**

| Milestone | This plan | ChatGPT estimate | Main reason for the difference |
|---|---|---|---|
| Prototype: web Simple Build, deny-only approvals, keep/discard handoff, restart = interrupted | 12.5–15.5 | "a few days" | Needed even here: worktree isolation, a solo tool surface with the protected-location guard and its worktree exemption, a result that separates claims from facts, a finish commit the model cannot bypass, and fail-closed restart handling |
| Simple Build v1 (web, SB0–SB9) | 29.5–38 | — | Approvals with deadlines, typed errors, idempotent admission, a closed state machine, `continue`, a secret-checked finish pipeline, gated handoff, recovery with snapshots, retention of every task, a real web view |
| AIBoard home (HM1–HM6) | 21–29 | — | Settings and keys move from the browser to `~/.aiboard`: an encrypted store with a write lock, conflict-checked op batches and keys bound to their upstream; the Runner's own model catalog; the routes and a hardened model proxy on its own port that every browser model call goes through, with one resolver for every provider client; Settings in connected mode; a version handshake for old Runners; `aiboard config`, `aiboard keys` and `aiboard models` |
| Delegate v1 on top (`aiboard exec`, DX1–DX6) | 17–23 | — | Model selection and the exec settings in the home, a one-task execution host per process tethered to it, folder locks shared with the Runner, owner-dead crash recovery, the CLI with paged output, typed exits, signals, `cancel` and `wait`, a journaled working-tree apply serialized between processes, Windows path and prompt handling, shims and caller recipes |
| **Dependable v1, all three** | **67.5–90 (about 13.5–18 weeks)** | "1–2 weeks" (5–10 days) | The safety and contract work that the four reviews and the recheck found, and the move of settings out of the browser (§13) |
| Later: MCP task tools, Remote X3, ACP, outbound CLI executors and more | about 29–32 more, plus NX7, planned separately | not covered | — |

## 1. What was asked

The owner asked two questions on 2026-11-03:
1. How much work is a **simple build mode** for the Runner? Today's Build runs an Architect, workers, a plan critic, reviewers and a verifier.
2. How should a future **delegate** feature work? Other tools would hand a task to the Runner like calling a CLI agent, pass model, effort, access and budget, and get a structured result back.

Answering this needed a check of Codex CLI, Claude Code and agy, a review of Runner V2, and a plan.

Terms:
- **Simple Build**: one model, one effort and one access level work on a coding task inside the Runner. The task reports what it did, the checks and their results, and what it could not finish. A handoff follows, chosen by the user or by the caller's `--handoff`.
- **Delegate**: a caller (Claude Code, Codex CLI, agy, a script) runs `aiboard exec`, which does one Simple Build task in its own process and prints a structured result. Both share one task engine.
- **Task**: one admitted unit of work, id `task_<uuid>`.
- **Principal**: who admitted the task. `web` means the Runner token or a paired local session. `exec` means an `aiboard exec` process run by the user's account.
- **Runner**: the long-running server that `aiboard` starts for a folder and pairs with the web app.
- **AIBoard home**: the per-user folder (`~/.aiboard`, or `AIBOARD_HOME`) that holds the user's settings and encrypted keys. The web edits it through a Runner, and the CLI edits it directly (§5.8, §9).
- **Worktree**: a separate git checkout of the same repository on its own branch, so a writing task never touches the user's folder through Runner tools before handoff.
- **Binding**: the Runner's per-run execution context (`ExecutionHost.bindRun`). It owns the run's processes, grants and recovery.
- **Broker**: `ToolBroker`, which allows each tool call, asks for approval, or refuses it.
- **ChangeSet**: the Runner's record of a task's commits and binary-safe diff (change-set.ts:83).
- **Evidence**: a durable record of a command the Runner itself ran, with exit code and output (`run_evidence_command`).
- **Idempotency key**: a caller-chosen string; the same key submitted twice admits the work once.
- **MCP**: Model Context Protocol, the tool protocol Claude Code, Codex and agy speak as clients.

### 1.1 Checking the earlier ChatGPT answer

| Claim | Verdict | Evidence |
|---|---|---|
| The benchmark already runs one model in a tool loop without Architect or scheduler, with native tools, usage tracking, budgets and result recording | **True, for ToolBench only** | toolbench-session.ts:48 ("A solo tool session. No Build, scheduler, Architect..."); tools :184-196; budgeted runtime and model :203, :222-224; `runAgentLoop` with `coordination: "solo"` :227-233 |
| The Runner has single-model chat with skills and managed MCP tools | **True** | chat-agent-session.ts:280-283 (skills), :295-297 (managed MCP); file tools read-only :284; 40 turns per message :103 |
| The benchmark session runs with full permissions | **True**, and it edits the project root in place | toolbench-session.ts:181 (`bindRun` "full"), :182 (`workspacePath: projectRoot`) |
| It treats interrupted work as failed | **True** | toolbench-session.ts:108-131 ("A restart never resumes model work"; `runner_restarted`) |
| So it should not be exposed as delegation | **Agree, with more reasons** | no worktree (:182); `finish_toolbench` takes `{}`, so there is no claim (:197-200); image inputs dropped, since the request has only a text prompt (toolbench-contracts.ts:8; :231); an existing snapshot is refused (:96-98) |
| Final project handoff always pauses for a user choice | **False in code**, true in docs | native-build-manager.ts:1145-1150 vs AGENTS.md:42 (§7.5) |
| "A few days for a prototype, 1–2 weeks for a dependable first version" | **Too low**: 12.5–15.5 days for the prototype; 46.5–61 for both halves, against 5–10, and 67.5–90 with the AIBoard home | §13 |
| `aiboard-runner delegate --model <m> --effort high "task"` returns a task id and a structured result | **Direction right, details wrong** | See the notes below this table. |
| Simple Build = one model + effort + access → works directly → reports → user chooses at handoff | **Agree**, if "directly" means in an isolated worktree | §7 |

Notes on the `aiboard-runner delegate` claim:
- The user command is `aiboard`. Its parsed commands are start, status, stop, version, help, remote and mcp (launcher.ts:44). update, uninstall and doctor are dispatched before parsing (:197-203).
- An unknown effort silently becomes "default" (reasoning-effort.ts:10-21).
- Large result parts must be paged and returned by reference.
- The owner's chosen form is `aiboard exec`, one-shot and headless (§6.3). It needs a model enabled in the AIBoard home (§9), and no running Runner.

## 2. How Codex CLI, Claude Code and agy handle delegated work

Versions on this PC: codex-cli 0.166.0, Claude Code 2.1.317, agy 1.4.12. Flags come from each CLI's own `--help`. Rows marked *(docs)* come from vendor documentation or the owner's run logs and were not re-executed.

### 2.1 Comparison

| Concern | Codex CLI `codex exec` | Claude Code `claude -p` | agy `agy -p` |
|---|---|---|---|
| Prompt input | argument, or stdin when absent or `-` | argument or stdin; `--input-format text\|stream-json` | argument; `--input-format stream-json` reads NDJSON from stdin |
| Model | `-m/--model` | `--model`, `--fallback-model` | `--model`; `agy models` |
| Effort | no flag; `-c` config override | `--effort <level>` | `--effort low\|medium\|high\|xhigh\|max` |
| Access | `-s/--sandbox`, `--dangerously-bypass-approvals-and-sandbox`, `-C/--cd`, `--add-dir` | `--permission-mode`, `--tools`, `--add-dir`, `--restricted`, `--bare` | `--mode accept-edits\|auto\|plan`, `--sandbox`, `--dangerously-skip-permissions`, `--add-dir` |
| Headless approvals | exec never asks *(docs)*; `--approve-for-me` routes approval requests through automatic review in the workspace-write sandbox | `-p` starts in Manual mode, so un-allowed tools do not run *(docs)*; `--permission-prompts <target>`, `--permission-prompt-tool`; denials in `permission_denials` *(docs)* | soft-deny, reported as `denied_actions` *(docs)* |
| Isolation | `--worktree` | `-w/--worktree [name]` | none for the main agent *(docs)*; `--sandbox` silently unavailable on Windows 10 *(owner logs)* |
| Structured result | `--output-schema`, `--json` events, `-o/--output-last-message` | `--output-format json\|stream-json`, `--json-schema` | `--output-format json\|stream-json`, `--json-schema` |
| Budget | none | `--max-budget-usd`; subtypes `error_max_turns`, `error_max_budget_usd` *(docs)* | `--print-timeout` (0s = unlimited) |
| Resume | `exec resume`, `exec fork` | `-r/--resume`, `-c/--continue`, `--fork-session`, `--session-id` | `-c/--continue`, `--conversation` |
| Background and status | app-server daemon, `codex agents`, `codex queue`; codex-plugin-cc `--background` jobs with status, result and cancel *(docs)* | `--bg/--background`; `claude agents --json [--all] [--cwd]` with states working, blocked, done, failed and stopped plus `waitingFor` *(docs)*; attach, logs, stop, rm, respawn | `remote-control` start/status/stop daemon, a Scheduled Task on Windows *(docs)* |
| Exit codes | 0 / 1 / 2 *(docs)* | SIGTERM gives 143, no result *(docs)* | 0 / 1 / 2 / 3 plus an `AGY_ERROR` stderr line *(docs)* |
| Quota failure | prose ("You've hit your usage limit") plus exit 1; `usage_limit_exceeded` only in rollout files and the app-server's `codexErrorInfo`; no `-o` file *(owner logs, docs)* | no quota subtype (success, error_max_turns, error_max_budget_usd, error_during_execution, error_max_structured_output_retries); quota shows only through `is_error`/`api_error_status`, `errors[]` and `rate_limit_event` *(docs)* | "Resets in 4h53m36s" as prose; `retryable: true` even for the weekly cap *(owner logs)* |
| Serves MCP | no (`codex mcp` manages client config; `app-server` is experimental) | `claude mcp serve`, tools only *(docs)* | no (`agy mcp` manages client config) |
| MCP client limits | `codex mcp add <NAME> -- <COMMAND>...` writes ~/.codex/config.toml; `startup_timeout_sec` 10 s covers initialize and the first tools/list (the key is in codex.exe 0.166.0); `tool_timeout_sec` 60 s; per-server output limit, default unverified *(docs)* | `claude mcp add <name> <commandOrUrl> [args...]`, scope `-s local\|project\|user` (default local); `MCP_TIMEOUT` 30 s at start-up; output cap 25k tokens, and text over 50,000 characters spills to a file; calls over 120 s go to the background and `-p` loses them; Bash tool 120 s by default, at most 600 s *(docs)* | `agy mcp add <name> <commandOrUrl> [args...]` writes ~/.gemini/config/mcp_config.json (per workspace: `.agents/mcp_config.json`); MCP timeouts unverified |

### 2.2 What to copy

| Pattern (seen in) | AIBoard form |
|---|---|
| One one-shot headless command with explicit model, effort and access (all three) | `aiboard exec -m <model> --effort high --access <level> "<prompt>"` |
| A machine-readable final result (all three) | `--json` prints `TaskResultV1`, bounded; large parts are paged with `aiboard exec show` |
| An event stream whose first line identifies the run (`--json`, `stream-json`) | `--output-format stream-json`: the first line is `task.admitted`, with the effective access and isolation |
| Denials listed instead of a hang (`permission_denials`, `denied_actions`) | `permissionDenials[]`, each with a hint; the existing stall guard pauses a model that keeps retrying them (§8.2) |
| Typed terminal reasons for limits (`error_max_turns`, `error_max_budget_usd`) | `paused` with `budget_exhausted` / `turns_exhausted` / `deadline_exceeded`, exit 27 |
| Worktree isolation; resume by id (`--worktree`, `-w`, `exec resume`, `--resume`) | always-on worktrees for writing levels; `aiboard exec resume <id>` |
| A cheap status listing (`claude agents --json`) | `aiboard exec list --json` for the folder's tasks |

### 2.3 What to avoid

| Failure (seen in) | AIBoard rule |
|---|---|
| Quota reset only in prose, wrong `retryable` (agy); quota only as prose and exit 1 (Codex exec) | typed `quota_exhausted`; `resetsAt` only from a provider-supplied value |
| No result file after a failure (Codex `-o`) | a result is written whenever a task stops |
| Partial work left uncommitted and unreported (Codex) | snapshot commit on every stop |
| Results scraped from log tails (the owner's wrapper) | structured fields only |
| Unconfined execution behind a reassuring name (Codex's `workspace-write` is a real sandbox) | access names state what they allow (`workspace_unconfined`), and the effective level and isolation are printed before the first model call; no name is chosen to get past a caller's classifier |
| Global always-proceed without a sandbox (agy) | access is per task, and disclosed before the first model call |
| A sandbox that silently does nothing (agy, Windows 10) or blocks test spawns (Codex EPERM) | refuse before any model call (`isolation_unavailable`); disclose `commandIsolation` |
| One MCP call that blocks for minutes (Codex 60 s, Claude 120 s); a server slow to start (Codex 10 s) | no MCP server in v1; a shell command, which callers already know how to run in the background (§6.3) |

### 2.4 The owner's delegation runs, 2026-10-27 to 2026-11-03
From the Codex session logs and the wrapper logs on this PC:

| Observation | Detail | Consequence |
|---|---|---|
| Mechanics | A wrapper ran the CLIs: prompt on stdin for Codex, argv for agy (up to 7,331 characters). Results were scraped from log tails. The prompt echo caused false positives, and a curly apostrophe caused a false negative. | Prompt by file or stdin; structured fields only. |
| Codex volume | 53 `exec` sessions: 62 completed turns and 11 errors (10 `usage_limit_exceeded`, 1 `model_not_found`). | Quota is the usual failure, so it is typed. |
| Codex quota failures | Exit 1, no `-o` file, and 150k–670k tokens of partial uncommitted work left behind. Recovery used fresh continuation prompts, never `resume`. | Always write a result, snapshot the work, keep `continue` cheap. |
| agy quota failures | Exit 3 with "Resets in 4h53m36s", or a weekly cap of "162h13m35s". No summary and no list of changed files. | `resetsAt`; changes listed from git. |
| Sandbox | Codex's Windows sandbox hit EPERM spawning tests, so the lead ran every test. | Checks run in the Runner's execution host. |
| Caller safety | Claude Code's classifier blocked `--dangerously-*` and `-ExecutionPolicy Bypass`. | Names describe authority accurately and are never chosen to pass a caller's classifier. |
| Test weakening | One delegate weakened a test, and the change was rejected. | Claims are kept apart from facts; failing checks block `apply_if_clean`, and the exit code reports them. |
| What worked | Two parallel Codex worktrees, 8–27 minutes per success. A preamble: use this worktree, no installs, focused tests only, never weaken tests, no commit or push, report in at most 25 lines. | These rules become the solo prompt (§12.1). |
| Outcome | The owner stopped delegating coding on 2026-11-03. | The lead implements this plan directly. |

## 3. What Runner V2 already has

Verdicts:
- **as-is**: unchanged.
- **refactor**: a small change that preserves the current default.
- **pattern**: copy the approach, not the code.
- **new**: written for tasks.
- **no**: not reusable as a base.

| Capability | Where | Verdict |
|---|---|---|
| Agent loop, solo coordination, stall guard | agent-loop.ts:139, :176, :179 (default 50 turns), :196-206 ({12,20} validated, unused), :926-947 (denied calls count as unproductive), :1022-1060, :1028-1032 (worker default {8,16}) | as-is; pass `maxTurns`, `coordination`, `readOnlyStall` |
| Provider runtimes | provider-config-store.ts:14-40 (`hostedTools` at :32); PUT `/v2/provider-configs` control-server.ts:583-607, merged at :1680-1705 (whole config replaced by runtimeId; no delete); native-build-factory.ts:3980, :4057 | as-is, except that a pushed config may omit `secret`, which the Runner fills from the AIBoard home (HM3); config cloned per task; hosted tools stripped unless allowed |
| Worker tool registration | worker-runtime.ts:141-143 (hardcoded `worker:task`), :185-211, :248, :280-286, :462-466, :484-501 | refactor: extract `worker-tool-surface.ts` |
| Role surfaces | role-capabilities.ts:12, :39-53, :91-97, :267-326 (`worker:task` needs `git.push`, `spawn_subagent`, `submit_task`), :454-483; test/role-capabilities.test.ts:467-479 | refactor: `solo:task`, `solo:inspection` |
| Lifecycle names and signal | runner-extension.ts:11; capability-registry.ts:227; agent-contracts.ts:186-187 (reused at toolbench-session.ts:197-199) | refactor: protect `finish_task`; signal as-is |
| Prompt invariants, project instructions | agent-prompts.ts:36-49 (frozen, byte-pinned), :51-52; project-context.ts:22 | pattern; as-is |
| Tool broker | tool-broker.ts:303-311, :313-343, :428-460 | as-is |
| Protected-location guard (S1a) | protected-locations.ts:94-126 and the categories after it; remote-path-guard.ts:174-215 (a pure deny-list), :340-378 (hardlink identity scan); tool-broker.ts:102-104 and :562-581 (`fs.*` and `image.inspect` only, :567; roles `remote` and `local_mcp` only, :568); code-intelligence-tools.ts:133-136, :239-241 (`code.*` paths resolved against the workspace; absolute and `..` paths allowed); subagent-tools.ts:78 (`permissions` typed as SqlitePermissionStore), :170-180 and :205 (subagent broker and image tools built with no guard) | refactor: apply when a guard is passed, to every path-taking tool; a worktree exemption in the guard; thread the guard and a narrow permissions interface into subagents and managed tools |
| Durable approvals | permission-store.ts:71-94 (no timeout), :112-140 (idempotent `decide`); the row stores the tool name, actor, profile, access summary and `outsideWorkspace`, not the call arguments; control-server.ts:556-582 | as-is behind SoloApprovalPolicy |
| Execution binding | execution-host.ts:122-131, :260-265, :285, :496 | as-is |
| Isolation | execution-lifecycle-policy.ts:44-53; execution-isolation-provider.ts:347-362, :939-958; windows-process-backend.ts:95-105; runner-capabilities-config.ts:80-98 | as-is, respected |
| Git baseline, worktrees | git-bootstrap.ts:10-46; git-baseline.ts:16 (100 MiB), :25-32, :70 (inspection), :72-88 (the root check at :84-88 runs after the init writes at :73-80), :106-108 (private index), :244-249; workspace-manager.ts:86-105, :164, :171-183 and :376-388 (guarded commit with `inspectCandidate`), :185-328 (cleanup deletes every task branch) | refactor: `initialize: false` option with the root check first; a worktree-only removal method |
| Integration and apply | integration-manager.ts:623, :723, :735-743, :744-751, :1701-1734, :2044 (`recoverProjectApply`, private) | refactor: `reserveDocsProject` option; a public recover-only method |
| ChangeSet, claim shape | change-set.ts:83, :143-148 (evidence required), :166-172 (`--binary --full-index`, `--no-renames` for submissions); validation-scope.ts:44-53 | refactor: `evidencePolicy` option |
| Submission secret check | submission-guard.ts:24-40 (`assertSubmissionHasNoSecrets`; filename rules :60-63); submission-guard-git.ts:15-46 (`addedLinesByPath`) | as-is |
| Check detection and running | final-verification-profile.ts:336; delivery-execution.ts:956-1000 (tests and build only; value-imports scheduler-store at :44); verification-workspace.ts:80, :136 | as-is; transitive kernel import accepted |
| Effort | reasoning-effort.ts:1-21; lib/benchmark/model-effort.ts:124 | refactor: strict parse, ported table |
| Budgets, usage | budgeted-model.ts:31; budgeted-tool-runtime.ts:19; budget-ledger.ts:47-55; sqlite-budget-ledger.ts:215; model-usage-projection.ts:91 | as-is |
| Budget enforceability | budget-enforceability.ts:21-45 (refuses only a budgeted run whose USD cap has no time limit) | new task predicate |
| Live output | live-model-output.ts:31-32; control-server.ts:1581-1588 | refactor: injected owner check |
| Startup recovery | runner-start.ts:421-439; runner-resource-cleanup.ts:48-112; execution-host-mcp-transport.ts:77; execution-host-lsp-transport.ts:165 | refactor: add task reconciler |
| Local MCP door | local-stdio-mcp.ts:6-7, :20, :102-103, :113-116 and :144-161, :215-232, :235-253; remote-tool-runtime.ts:374-389, :411-425, :468-475, :601-624 | no: unchanged; no task tools in v1 (§6.4) |
| Launcher commands and folder locks | launcher.ts:44 (the parsed `Command` union) *(3903fc46)*; launcher-instance.ts:33-37 (per-folder state under the user data root), :40-42 (per-user `remote` directory), :67-75 (project identity), :267-285 (`tryAcquireLock`: an exclusive SQLite `BEGIN IMMEDIATE` on `launcher-<kind>.sqlite`), :287-297 (`acquireDiscoveryLock`, 10 s) *(3903fc46)*; runner-start.ts:194-196 (the Runner holds the `lifetime` lock: "A Runner already owns this project state") *(3903fc46)* | refactor: an `exec` command; per-task exec locks taken under the discovery lock; the Runner's start refuses while exec tasks run (§11.1) |
| Execution host composition | runner-start.ts:249-260 builds one `createExecutionHost` over the state directory (execution-host.ts:206) *(3903fc46)* | refactor: a shared composition helper, so `aiboard exec` builds one over a per-task state root |
| Credentials | storage-key.ts:23 (the key file sits in the state directory); runner-start.ts:226-235 (encrypted provider and extension stores per state directory); encrypted-provider-config-store.ts:40-80; remote-device-store.ts:72-76 (a per-user secret, separate from the project storage key) *(3903fc46)* | as-is for the Runner's folder stores; a new per-user AIBoard home on the same envelope and key pattern (HM1) |
| Browser settings and keys | lib/client/store.ts:71-101; lib/db/schema.ts:300-399, :472-499; lib/client/providers.ts:350-363; lib/client/storage-adapter.ts:58, :598-619 *(3903fc46)* | refactor: settings move to the AIBoard home, and the store keeps history (HM4b) |
| Model catalog and runtime configs | lib/providers/catalog.ts; lib/providers/provider-registry.ts; lib/client/native-build-engine.ts:602, all web-only *(3903fc46)* | new: a generated snapshot and a Runner port, with parity scripts (HM2) |
| Browser model calls | lib/client/engine.ts:477; lib/benchmark/certified/model-call.ts:217; lib/client/capability-api.ts:413; lib/client/settings-api.ts:1082 *(3903fc46)* | refactor: one resolver gives every provider client the proxy's base URL and token (HM4a) |
| Durable remote jobs | remote-admission-store.ts:12-15 (states), :197-250 (idempotent admission, AES-GCM), :424-491 (cancellation), :857-890 (canonical-JSON hash) | pattern (encryption, idempotency, cancellation enums) |
| ToolBench, Runner Chat, Build kernel, worker lifecycle tools | toolbench-session.ts; chat-agent-session.ts; scheduler-store.ts:5746-5748, :5767-5769 (Architect-only); run-supervisor.ts:106-115; worker-lifecycle-tools.ts:168-175 (`ready_for_architect_review`) | no |

**Genuine gaps:**
1. No task-shaped API. POST `/v2/runs` is synchronous and Build-only (control-server.ts:609-647).
2. Approvals have no deadline and cannot be aborted.
3. No solo role surface.
4. A ChangeSet requires evidence.
5. No per-file diffstat. Nothing in runner-v2/src calls `--numstat`, although the git denylist (git-execution-policy.ts) allows it.
6. Effort is never validated.
7. Nothing can run a task without a Runner server: the execution host, stores and tool runtimes are composed only inside `startRunner`.
8. Settings and keys live only in each browser's store, which no other process can read. The Runner's provider configs are per folder, merged from whatever Builds, Chat turns and benchmarks pushed, and never removed (control-server.ts:1680-1705 *(3903fc46)*). The Runner has no model catalog, so it cannot turn a model id into a runtime config by itself (§9).
9. The protected-location guard covers only `remote` and `local_mcp` actors (tool-broker.ts:568). It skips path-taking tools other than `fs.*` and `image.inspect`, such as `code.*`, `repo.manifest` and `repo.map`. It has no exemption for a worktree inside the state directory, and subagents cannot take a guard.
10. The baseline initializes git in place for non-git folders and for repositories with no commit (git-baseline.ts:73-80), and has no option to refuse instead.
11. Apply recovery is private (integration-manager.ts:2044). It is reachable only through `applyToProject`, which applies when no journal exists (:1704).
12. The folder lock is exclusive only: the Runner's `lifetime` lock is one SQLite write transaction (launcher-instance.ts:267-285 *(3903fc46)*). Several `aiboard exec` processes need to share a folder while keeping the Runner out, so they need their own locks.
13. No owner method removes a task worktree but keeps its branch, or deletes the baseline, integration and handoff refs (git-baseline.ts:283; integration-manager.ts:1738, :4212). WorkspaceManager.cleanup deletes every task branch of the run (workspace-manager.ts:311-316).
14. Nothing stops a model with a shell from committing on the task branch itself. The commit hook inspects only baseline..candidate (workspace-manager.ts:347-353, :376-385), so a secret committed and then removed by the model would stay in the branch history.
15. Exec's deeper layout needs its own Windows path-length gate. A process cannot start in a folder past 258 characters (windows-path-limits.mjs:23, :66); `startRunner` checks only Build's deepest folder (runner-start.ts:172-173; git-run-context.ts:259) *(3903fc46)*.
16. Environment overrides on shell-session calls are not checked: only a session's first call is a managed launch (shell-session.ts:112-116, :221-231) *(3903fc46)*.
17. A command's identity is no longer one `process.run` string: commands arrive as whole command lines, session scripts, native shell tool calls and `process.start` jobs (process-tools.ts:115; shell-session-bash-host.ts:22; openai-shell-tool.ts:76-77; managed-process-tools.ts:58) *(3903fc46)*. Claim matching has to say which it trusts (§5.4).

Gap 7 has grown: `startRunner` now also owns the TEMP and path checks, the Git preflight, `ExecutionHost.prepare()` and the shell inventory (runner-start.ts:172-173, :248, :651), and the shared composition helper must carry them (§11.1).

## 4. Recommended architecture

### 4.1 Diagram
~~~
 Web: Simple Build view, Settings (AIBoard home)        Claude Code / Codex CLI / agy / a script
        |                                                (its own shell tool, one command per task)
  HTTP /v2/tasks, /v2/home, /v2/model-proxy                      |
        |                                               aiboard exec -m <model> --access <level> "<prompt>"
  Runner V2 process (started by `aiboard`)                       |
  holds the folder's `lifetime` lock                    one process per task; holds x/<shortId>/exec.lock;
        |                                               refuses while the folder is open in a Runner
  SoloTaskService (solo-task-service.ts)                         |
  admission + idempotency, capacity (2 / 16),           ExecTaskHost (solo-task-exec.ts)
  cancellation, SoloTaskStore = state/solo-tasks.sqlite  reads the AIBoard home (~/.aiboard); createExecutionHost
  (payloads encrypted), startup reconciler               over state/x/<shortId>/, tethered to this process;
        |                                               recovers crashed tasks on request; prints a result page, exits
        +-----------------------------+-----------------------------+
                                      |
                  SoloTaskRuntime (solo-task-runtime.ts): one task, host-agnostic
  repo checks + git baseline -> bindRun(task_<uuid>) -> recover + residue cleanup -> per-task stores ->
  integration branch + worktree -> ToolBroker(solo surface, S1a guard, SoloApprovalPolicy) ->
  runAgentLoop(coordination "solo") -> finish pipeline (stop, commit, secret check, ChangeSet, facts) -> handoff
                                      |
  unchanged primitives: ExecutionHost, ToolBroker, SqlitePermissionStore, WorkspaceManager,
  IntegrationManager, budget ledger, provider runtimes, ArtifactStore, evidence store
~~~

**One engine, two hosts.** `SoloTaskRuntime` takes its execution host, provider config, stores and approval policy as arguments. It depends on no Runner-wide singleton: no control server, no `SoloTaskStore`, no launcher state. The Runner's `SoloTaskService` and `aiboard exec`'s `ExecTaskHost` are its only two callers. An SB4a test runs a task with no Runner composed, which is exactly what `aiboard exec` does.

**Isolation from Build.**
- The service imports none of scheduler-store, build-runtime, NativeBuildManager or RunSupervisor directly. An import-boundary test pins this for `solo-task-*.ts` and `worker-tool-surface.ts`.
- One transitive import is accepted. `--checks runner` reuses `runDeliveryCategory`, and delivery-execution.ts value-imports scheduler-store (delivery-execution.ts:44).

**One id.** `task_<uuid>` is also the ExecutionHost run id, the permission run id, the live-output key and the worktree segment, so every per-run primitive works unchanged.

**Where state lives.** `state` is the folder's state directory under the user data root (launcher-instance.ts:33-37 *(3903fc46)*), the same for the Runner and for `aiboard exec`.
- Web tasks: binding state under `state/builds/<segment>` (execution-host.ts:496), like ToolBench today; worktrees under `state/workspaces/<runSegment>/<workspaceSegment>` (workspace-manager.ts:90-94).
- `aiboard exec` tasks: everything under `state/x/<shortId>/`, a 10-character id mapped to `task_<uuid>` inside it, which keeps worktree paths short enough for Windows (§11.1). The execution host, the per-task stores, the lock, the result and the worktree live there, so nothing a task writes is shared with another process, and recovery of one task never touches another (§11.3).
- Both worktree locations are inside the state directory, which the protected-location guard covers, so the guard gains an exemption for exactly the task's own worktree (§8.1).
- Branches and refs stay per task: `aiboard/<segment>/...` and `refs/aiboard/runs/<segment>/...`, with the task id as the segment. Cleanup is scoped to its own segment (workspace-manager.ts:185-195 *(3903fc46)*), and `git worktree prune` removes only registrations whose folders are gone, so one task's cleanup never removes another's.
- New private file owners:
  - `state/solo-tasks.sqlite` (SB3);
  - `state/x/<shortId>/`, the `state/x/active/` markers, the exec key and the exec-apply lock `state/launcher-exec-apply.sqlite` (DX2, DX4);
  - the per-user AIBoard home (HM1): `<home>/config.json`, `credentials.json` and `home-lock.sqlite`, and the key `<user data root>/home-key` (§5.8).
- Each new owner needs a reviewed entry in test/filesystem-mutation-routing.test.ts and a filesystem-owner review record, as AGENTS.md requires.
- `discard` and the sweeper remove files only through WorkspaceManager, IntegrationManager and the baseline module. These are already reviewed owners, and already in `GIT_FAMILY_MODULES`. Today's cleanup deletes every task branch of the run (workspace-manager.ts:311-316), so SB7 adds owner methods:
  - a WorkspaceManager method that removes only the task worktree: compare-and-set the branch tip, skip a branch checked out in another worktree, `git worktree remove` then prune, and keep the branch;
  - methods that delete the baseline ref, the integration branch, and the `integrated/*` and `handoff/*` refs.

  Each new method gets a filesystem-owner review entry.

**Naming.** Modules use a `solo-task-` prefix, because `task-*.ts` already belongs to Build (task-contracts.ts:13).

### 4.2 Preparation order

| Step | Action | Why here |
|---|---|---|
| 1 | **Admit, with no binding, in under 2 s.** Check: the closed-schema spec; the principal; depth (`aiboard exec` only, §11.4); the model (web: a pushed runtime; exec: a model usable from the AIBoard home, §9) and effort; per-task ceilings from the home (exec only); capacity (web only); budget enforceability; approvals availability (web `ui` only). Web tasks record idempotency. Return or print the effective access and isolation. | A cold `bindRun` takes about 9 s on the owner's Windows PC (measured 9.1 s, docs/plans/2026-10-27-aiboard-remote-STATUS.md:50; the open item is at :272). `ExecutionHost.prepare()` now runs the host checks before the first bind (execution-host.ts:405-411; runner-start.ts:651), so DX2 measures it again. Nothing here needs git. |
| 2 | **Writing levels only:** `captureRunGitBaseline` with `initialize: false` (SB2). It refuses, in this order, a non-git folder, a path that is not the repository root, and a repository with no commit, each as a typed `preparing` failure; `initGit` lifts the first and the last. Then snapshot the project's HEAD, index and porcelain status for `projectChangedDuringTask`. These reads run with `GIT_OPTIONAL_LOCKS=0`. | The baseline's temporary binding must close first (git-bootstrap.ts:10-12). Without the option, the baseline initializes git inside the user's folder (git-baseline.ts:73-80), and its root check (:84-88) runs only after those writes. SB2 moves the root check first in both modes. |
| 3 | `bindRun({ runId: taskId, permissionProfile, capabilityContract, capabilitiesConfig, localMcpDepth })`. `read_only`, `workspace_unconfined` and `full` bind `full`; `workspace_contained` binds `project`. | Only one live binding per run is allowed (execution-host.ts:260-265). The binding profile never changes during a task. |
| 4 | `binding.recover`. Refuse subprocess, streaming and isolation residue, as remote-tool-runtime.ts:379-383 does. For `aiboard exec`, the owner-dead recovery of §11.3 has already settled what a killed process left. Then `cleanupRecoveredMcpTransports` (execution-host-mcp-transport.ts:77) and `cleanupRecoveredLspTransports` (execution-host-lsp-transport.ts:165). | Build's full sequence (native-build-factory.ts:534-561), exported or re-implemented rather than imported from native-build-factory. |
| 5 | Per-task session, tool ledger, budget window, evidence and artifact stores | Existing classes; no new owner. |
| 6 | **Writing levels only:** `IntegrationManager.initialize`, then `WorkspaceManager.createTaskWorkspace` | integration-manager.ts:623; workspace-manager.ts:105 |
| 7 | ToolBroker over the solo surface, with the S1a guard and SoloApprovalPolicy as the permissions object | §8 |
| 8 | `runAgentLoop` (settings below) | toolbench-session.ts:221-233 shows this combination working. |

- `read_only` skips steps 2 and 6. It works on the project root, needs no git, and writes nothing to the repository.
- Resting states (paused, interrupted, ready_for_handoff) hold no binding and no running process.
- **`continue`** reuses the baseline and the project snapshot. It re-runs steps 3–5, has step 6 reattach the existing worktree, then runs steps 7–8.
  - A task interrupted before step 2 or step 6 completed runs those steps first.
  - A failure in this `preparing` returns the task to its resting state with the error (§5.2).

`runAgentLoop` settings:
- `coordination: "solo"`.
- `maxTurns` = min(300, maxModelCalls).
- `readOnlyStall`: {12,20} for `solo:task`, {40,60} for `solo:inspection` (Chat uses {30,39}, chat-agent-session.ts:257).
- `providerRetry` with `classifyProviderFailure`, bounded by the task deadline.
- Checkpoints go to the session store.
- Actor role `"worker"`, for usage attribution. The guard no longer depends on the role (§8.1).

### 4.3 Why this base, and the choices settled here

| Choice | Decision | Why |
|---|---|---|
| Base | Standalone service and store, contracts first | Build completion is Architect-only (scheduler-store.ts:5746-5748, :5767-5769), and `completeBuild` silently does nothing (run-supervisor.ts:106-115). scheduler-store.ts and build-runtime.ts changed often during Task 12. ToolBench works outside the kernel but lacks isolation and recovery. |
| Access | Four levels named by what they allow. Default `workspace_unconfined` for the web and for `aiboard exec`; any level, Full included, on request (OD-2, OD-3). | No command isolation on stock installs (§8.1); the owner wants delegates no more restricted than the web or other CLIs. |
| Caller approvals | Human only in v1 | A caller approving its own delegate defeats the gate. |
| Exit codes | Conventional shell codes (2, 124, 130, 143) plus task codes 20–29, outside Node's own fatal codes (§6.3) | The inspected CLIs mostly exit 1 on any failure, which callers cannot branch on. |
| Restart | Always pause as `interrupted` | Never auto-resume model work (toolbench-session.ts:108-131), but keep it recoverable. |
| Delegate process model | One-shot: `aiboard exec` hosts its one task in its own process and exits; no Runner, web app or MCP server is started or needed (OD-19, decided) | Callers expect `codex exec`/`claude -p` behaviour; a tool-started server dies with its client anyway. |
| Runner and `aiboard exec` on one folder | Mutually exclusive; any number of `aiboard exec` processes may share a folder (OD-22) | The Runner's startup recovery and Build auto-apply assume they own the folder's state. |
| Task tools on MCP | None in v1 (NX3) | The owner wants nothing extra running; every caller already has a shell. |
| Model commits | Folded back into the Runner's own secret-checked commit | A shell can commit on the task branch, and the hook sees only baseline..candidate. |
| Ctrl+C / SIGTERM on `aiboard exec` | Cancel: stop the task's processes, snapshot, print the result, exit 130/143 | The process owns its task; nothing else would. |
| Default checks | Model evidence plus a Runner-detected not-run list | The full suite takes hours (package.json:15). The Runner records facts and never certifies. |
| Evidence | Optional for tasks, via a default-preserving option | Build unchanged. |
| Naming | `aiboard exec`; `task_<uuid>` ids; `solo-task-*` modules | Matches `codex exec`, which callers already know (OD-11). |
| Follow-ups | `continue` on the same task; no `continueFrom` in v1 | `keep` rests in `ready_for_handoff`, so the worktree and baseline stay valid. |
| Recovery gate | Reconciler inside `reconcileRunnerStartup` | `buildRecoveryUnverified` is only the remote-only nested-state flag (runner-start.ts:182-183). |
| Delegate models | The AIBoard home, so every folder and linked worktree sees the same models (OD-6) | State is per folder (launcher-instance.ts:33-37 *(3903fc46)*), callers delegate from any folder, and no other process can read a browser store. |
| Admission | Bindless; repository checks run in `preparing` | Cold binds are slow; the web needs a fast reply. |
| Opt-in | Enabling a model in the home (in Settings, or with `aiboard models enable`); no other switch | Least surprise without a second gate the other CLIs do not have. |
| Settings and keys | One per-user AIBoard home; the web edits it through a Runner, the CLI directly (OD-25) | AIBoard is a CLI tool and the browser is its GUI; a headless process cannot read a browser store. |
| Browser model calls | Through the Runner's model proxy (OD-29) | Keeps every browser engine's code, and the keys never reach the browser. |

## 5. Contracts (`aiboard.task.v1`)

### 5.1 TaskSpecV1
~~~ts
export type AccessLevel = "read_only" | "workspace_contained" | "workspace_unconfined" | "full";
export type ApprovalsMode = "deny" | "ui";               // "ui" = the web task's Needs-you dock
export type HandoffMode = "ask" | "keep" | "export_patch" | "apply_if_clean" | "discard";
export type Effort = "default" | "none" | "low" | "medium" | "high" | "xhigh" | "max"; // reasoning-effort.ts:1-8

export interface TaskSpecV1 {
  contractVersion: "aiboard.task.v1";
  idempotencyKey: string;                    // ^[A-Za-z0-9._:-]{1,128}$; generated by aiboard exec
  prompt: string;                            // text only in v1; <= 256 KiB UTF-8
  model: { runtimeId: string; effort?: Effort }; // exec: a model id usable from the home, e.g. "openai:gpt-5.5"
  access?: { level?: AccessLevel;            // default workspace_unconfined (web and exec)
             network?: "deny" | "ask" | "allow" }; // Runner network tools only; default deny; "allow" is exec only
  approvals?: { mode?: ApprovalsMode;        // default: web ui; exec deny (the only exec mode)
                timeoutMs?: number };        // default 600_000, max 3_600_000
  handoff?: { mode?: HandoffMode | "apply_worktree" }; // default: web ask; exec apply_worktree (§7.2)
  budget?: { maxUsd?: number; maxWallClockMs?: number;         // default 3_600_000
             maxModelCalls?: number; maxToolCalls?: number };  // default 300 / none
  checks?: { mode: "agent" | "runner"; timeoutMs?: number };   // default agent
  initGit?: boolean;       // a non-git folder or a repository with no commit is refused unless true (OD-13)
  label?: string;          // display only
  provenance?: { client?: string; clientVersion?: string; note?: string }; // display only, caller-supplied
}
~~~
- The schema is closed; unknown fields are refused.
- Omitted fields take the defaults of the admitting principal at admission, and `effective` reports what was applied.
- `access.network` governs Runner network tools only (`research.fetch`, `browser.*`). It cannot stop a command from reaching the network (§8.1).
  - `deny` refuses those tools whatever the approvals mode.
  - `ask` sends them to the approvals mode (web).
  - `allow` approves them without asking. It exists for `aiboard exec`, which has no one to ask; the web uses `ask`.
- Prompts are text only in v1.
  - The web's one-model option disables attachments, with a note. The CLI has no `--image`.
  - Tool-produced images still reach image-capable runtimes: `inputModalities` is passed to BudgetedAgentModel as in chat-agent-session.ts:244.
- **Authority never comes from the spec.** The host supplies the principal, which is recorded on the task:
  - `web`: the Runner token or a paired local session.
  - `exec`: an `aiboard exec` process. It builds the spec from its flags and supplies the depth and ancestry from its environment (§11.4) and the ceilings from the AIBoard home (§5.8).

### 5.2 States

Three classes:
- **active**: queued, preparing, running, awaiting_approval, finishing, handing_off. The task holds a running slot, except `queued`, which holds a queue slot.
- **resting**: paused, interrupted, ready_for_handoff. The task holds no binding and no process; its worktree and branch remain, and it can continue or hand off.
- **terminal**: completed, failed, cancelled, outcome_unknown.
- `TaskState` (§5.4) is the union of these 13 names.

| State | Class | Meaning | Allowed next |
|---|---|---|---|
| queued | active | admitted, waiting for a slot (web only; an `aiboard exec` task starts at once) | preparing, cancelled, interrupted |
| preparing | active | repository checks, baseline, binding, worktree; on a continue, a fresh binding and the reattached worktree (§4.2) | running, paused, failed, cancelled, interrupted, outcome_unknown; on a continue, the source resting state instead of failed |
| running | active | model loop | awaiting_approval, finishing, paused, failed, cancelled, interrupted, outcome_unknown |
| awaiting_approval | active | a tool call waits for a human (`ui`) | running, paused, cancelled, interrupted, outcome_unknown |
| finishing | active | stop processes, commit, secret check, ChangeSet, facts, optional checks | ready_for_handoff, handing_off, completed, failed, cancelled, interrupted, outcome_unknown |
| paused | resting | a budget, turn, deadline, stall or provider limit stopped it; work snapshotted | preparing, handing_off, cancelled, completed |
| interrupted | resting | the Runner stopped with work in flight | preparing, handing_off, cancelled, completed |
| ready_for_handoff | resting | finished; handoff pending, kept or exported | preparing, handing_off, cancelled, completed |
| handing_off | active | applying or discarding | completed, outcome_unknown, its source resting state, or `ready_for_handoff` when entered from finishing |
| completed | terminal | handoff resolved: applied, discarded, nothing to hand off, or kept/exported at expiry | — |
| failed | terminal | unrecoverable, typed error | — |
| cancelled | terminal | stopped on request, or expired; stop and effect recorded | — |
| outcome_unknown | terminal | a stop or an apply whose effect cannot be proven | — |

Transition rules:
- An active state goes to `outcome_unknown` only when a stop (cancel, pause, failure or finish) cannot be verified, or when an apply's journal cannot be resolved.
- A cancel during `finishing` aborts the checks. It is recorded as `cancelled` after the commit and ChangeSet steps finish, so the snapshot stays consistent.
- `handing_off` returns to its source resting state (`ready_for_handoff` when it came from `finishing`) when a refusal, a failed precondition, or an `apply_failed` that provably applied nothing leaves the project unchanged.
- On a continue, a `preparing` failure returns the task to its source resting state with the error, so kept work is never orphaned.
- Terminal writing tasks accept `discard`, and `export_patch` of a verified, secret-checked snapshot, with no state change. The sweeper cleans them up (§7.4).
- `finishing` goes to `completed` when there is nothing to hand off (`read_only`, or an empty diff).
- A resting state goes to `completed` only through the retention sweeper, for kept or exported tasks (§7.4). Other expired tasks become `cancelled` with `expired`.

`final` and `stopped`:
- `final: true` exactly in terminal states.
- `stopped: true` in resting and terminal states. The web stops polling, and `aiboard exec` exits, when `stopped` is true.

The store enforces this closed table by compare-and-set, so the first committed transition wins any race. Later adapters map the states as follows:

| Task state | A2A 1.0 | Remote job.v1 |
|---|---|---|
| queued, preparing | TASK_STATE_SUBMITTED | queued |
| running, finishing, handing_off | TASK_STATE_WORKING | running |
| awaiting_approval, ready_for_handoff | TASK_STATE_INPUT_REQUIRED | awaiting_approval |
| paused, interrupted | TASK_STATE_INPUT_REQUIRED (a continue or a handoff is needed) | none in job.v1, where `blocked_quota` is terminal; needs the X3 job.v1 revision |
| completed | TASK_STATE_COMPLETED | by name |
| failed | TASK_STATE_FAILED | by name |
| cancelled | TASK_STATE_CANCELED | by name |
| outcome_unknown | TASK_STATE_FAILED with an `outcome_unknown` detail | outcome_unknown |

### 5.3 TaskEventV1
~~~ts
export type TaskEventType =
  | "task.admitted" | "task.state" | "model.turn" | "tool.call" | "tool.result"
  | "approval.requested" | "approval.decided" | "check.recorded" | "budget.warning"
  | "finish.claimed" | "handoff.updated" | "task.error";

export interface TaskEventV1 {
  taskId: string;
  sessionId: string;       // model session; new per continue
  sequence: number;        // monotonic, gap-free, survives restart
  cursor: string;          // opaque; pass back as `after`
  occurredAt: string;      // ISO-8601
  type: TaskEventType;
  data: Record<string, unknown>;  // <= 8 KiB after redaction and neutralization; larger by artifact ref
}
~~~
- The journal is the source of truth.
- `tool.call` and `tool.result` events carry Runner metadata (tool, duration, exit code, byte counts) plus an artifact reference. They never carry raw tool output.
- Model- and repository-authored strings are neutralized before they are stored or returned:
  - C0 and C1 controls, bidi controls, U+2028 and U+2029 are removed;
  - spoofed framing is escaped;
  - length is capped;
  - the string is marked `source: "model"`.
- Streaming model text uses the existing live hub, which is lossy by design (12 runs, 512 events; live-model-output.ts:31-32).

### 5.4 TaskResultV1
~~~ts
import type { ValidationScope } from "./validation-scope.js"; // changed, verified, testsRun[{command, counts}], notRun[{what, why}]

export interface TaskResultV1 {
  contractVersion: "aiboard.task.v1";
  taskId: string;
  state: TaskState;
  final: boolean;                                    // true only in terminal states
  stopped: boolean;                                  // true in resting and terminal states
  outcome: "done" | "partial" | "blocked" | "none";  // "none": finish_task never called
  claim: null | { source: "model";                   // reported by the model, not reviewed; neutralized
                  summary: string; scope: ValidationScope; knownIssues: string[]; followUps: string[] };
  changes: { baseRevision: string | null; baselineRef: string | null;
             branch: string | null;                  // null after a secret hit, unless the tip is the baseline
             committed: boolean;                     // the Runner's secret-checked commit exists, from finish_task or a stop
             snapshot: boolean;                      // committed without finish_task: a stop, a pause or a recovery
             snapshotUnavailable: null | "git_operation_in_progress" | "worktree_branch_changed"
                                  | "escaped_baseline" | "inventory_error"; // no commit was possible; nothing served
             replacedModelCommits: number;           // model commits folded into the Runner's commit (§12.3)
             files: { path: string; status: "A" | "M" | "D" | "T"; additions: number | null;
                      deletions: number | null; binary: boolean }[];  // name-status joined with numstat, --no-renames
             patchRef: string | null;                // ChangeSet diff artifact, paged
             projectChangedDuringTask: boolean | null }; // the user's folder changed between preparing and finishing
  checks: { name: string; source: "evidence" | "runner"; command: string; exitCode: number | null;
            passed: boolean; evidenceId: string; durationMs: number }[];
  commandsRun: { command: string;                    // the whole command line or session script, as launched
                 source: "process_run" | "shell_session" | "native_shell" | "process_start";
                 exitCode: number | null;            // a process.start job: its final code, null if still running at finish
                 exitCodeFrom: "runner" | "shell";   // "shell": printed by the shell that ran a session script
                 durationMs: number | null }[];      // every launch the Runner made; not checks
  notRun: { name: string; source: "agent" | "runner_detected"; reason?: string }[];
  unverifiedClaims: string[];                        // claimed testsRun commands with no matching Runner record
  permissionDenials: { tool: string; reason: string; wouldAllow?: string; occurredAt: string }[];
  usage: { modelCalls: number; toolCalls: number; inputTokens: number; outputTokens: number;
           cachedInputTokens: number; usd: number | null; costBasis: "priced" | "unpriced" };
  handoff: { mode: HandoffMode | "apply_worktree";
             status: "pending" | "kept" | "exported" | "applied" | "discarded" | "refused" | "none";
             reason?: string;
             applyRecipe?: string[];                 // two fixed commands naming the baseline commit id (§7.2);
                                                     // omitted on a secret hit or an unavailable snapshot
             untrackedPaths?: string[];              // new files `apply_worktree` left untracked in the user's tree
             patchPath?: string;                     // `--handoff patch`: where the stored patch is
             expiresAt?: string };
  cancellation: null | { stop: "pending" | "stopped" | "unverified" | "not_applicable";
                         effect: "pending" | "no_effect" | "known" | "effect_outcome_unknown" }; // Remote enums
  waitingFor: null | { kind: "approval"; approvalId: string } | { kind: "handoff" }
                    | { kind: "continue"; reason: string };
  error: TaskErrorV1 | null;
  effective: { principal: "web" | "exec"; runtimeId: string;
               effortRequested: Effort | null; effortSent: Effort | null;
               accessLevel: AccessLevel; approvalsMode: ApprovalsMode; checksMode: "agent" | "runner";
               commandIsolation: "unconfined_explicit_full" | "contained" | "inspection_only";
               networkEnforcement: "runner_tools_only" | "contained";
               stateCustody: "exposed_to_commands" | "guarded";
               network: "deny" | "ask" | "allow"; handoffMode: HandoffMode | "apply_worktree";
               providerHostedTools: string[];             // always empty in v1 (§8.1)
               budget: { maxUsd: number | null; maxWallClockMs: number;      // after the principal's defaults and the home's ceilings
                         maxModelCalls: number; maxToolCalls: number | null } };
  timing: { admittedAt: string; startedAt: string | null; stoppedAt: string | null; wallClockMs: number };
  exitCode: number | null;                           // `aiboard exec` only: the code the process exits with (§6.3)
}
~~~
Rules:
- A result is written every time a task stops, whether or not the state is terminal.
- **Redaction.** `redactSensitiveText` runs before storing or returning any of these: `commandsRun[].command`, `checks[].command`, every claim field, notRun reasons and denial reasons.
- **unverifiedClaims.** A `claim.scope.testsRun` entry is unverified in any of three cases:
  - no Runner record (evidence, runner check or `commandsRun` entry) has the identical whole command line;
  - the entry claims zero failures, but the matched record's exit code is not 0;
  - the only matching record has `exitCodeFrom: "shell"`. Claude's bash runs every command as a session script, and the exit code is printed by a loop inside the same shell, which the script can read and change (shell-session-bash-host.ts:22, :36-41 *(3903fc46)*). Such a record is reported, but never clears a claim.
- **Whole lines only.** `process.run` takes a whole command line and its description asks for chained commands in one call (process-tools.ts:115, :421 *(3903fc46)*), so a claimed `npm test` may have run as part of `npm ci && npm test`. A chained line matches no claim of its parts, and the result says so. The solo prompt asks the model to run each check as its own call, or through `run_evidence_command` (§12.1).
- **No process ids.** Retained output lives in the host's memory, 32 runs at most (`RETAINED_RUN_LIMIT`, managed-process.ts:68), so no result field names a processId.

  `claim.scope.verified` stays model-reported text and is not matched. The comparison is mechanical, not an assessment.
- A `read_only` result has `changes.branch: null`, no files, and `handoff.status: "none"`.
- A `completed` task with `handoff.status: "none"` (`read_only`, or an empty diff) succeeds when the outcome is `done`, no check failed, and `unverifiedClaims` is empty (exit 0, §6.3).
- `effective` is also returned by admission and by the `task.admitted` event, so a caller sees the access and isolation before the first model call.

### 5.5 Error and quota typing
~~~ts
export interface TaskErrorV1 {
  code: TaskErrorCode;
  message: string;            // redacted
  retryable: boolean;         // quota: true only when resetsAt is known
  resetsAt?: string;          // occurredAt + retryAfterMs, only when the provider supplied retryAfterMs
  providerKind?: string;      // classifyProviderFailure kind (provider-health.ts:48)
  phase: "admission" | "preparing" | "running" | "finishing" | "stop" | "handoff" | "command" | "startup";
}
~~~
`resetsAt` comes only from a value the provider supplied, such as a Retry-After header or a typed field.
- SB4a adds `retryAfterSource: "provider" | "heuristic"` to ProviderFailure.
- The monthly-limit branch infers 24 h from message prose, so it is marked `heuristic`.
- A heuristic value never sets `resetsAt` or `retryable: true`.

| Code(s) | When | Effect | Exit |
|---|---|---|---|
| `invalid_spec`, `idempotency_conflict` | admission | no task | 2 |
| `capacity_exceeded`, `model_not_configured`, `runtime_unsupported`, `home_key_missing`, `upstream_mismatch`, `effort_unsupported`, `account_transport_unavailable`, `isolation_unavailable`, `budget_unenforceable`, `approvals_unavailable` | admission (web) | no task | — (HTTP 4xx) |
| `windows_path_too_long`, `git_missing`, `git_too_old`, `git_unverified` | admission (web: HTTP 412, as POST `/v2/runs` answers today, control-server.ts:518-520) | no task | 29 |
| `folder_open_in_runner`, `no_delegate_models`, `model_not_enabled`, `no_default_model`, `home_unreadable`, `home_key_mismatch`, `home_unsafe`, `ceiling_exceeded`, `depth_exceeded`, `effort_unsupported`, `isolation_unavailable`, `budget_unenforceable`, `exec_busy`, `runner_recovery_pending`, `project_inside_aiboard_state` | admission (`aiboard exec`) | no task | 29 |
| `project_not_repo`, `project_not_repo_root`, `project_has_no_commits`, `isolation_unavailable` (attestation) | preparing | `failed`, no model call; on a continue, back to the resting state | 29 |
| `quota_exhausted`, `rate_limited`, `provider_unavailable`, `provider_auth` | running, after bounded retries | snapshot, `paused` | 23 |
| `budget_exhausted`, `turns_exhausted`, `deadline_exceeded` | running | snapshot, `paused` | 27 |
| `stalled`, `max_tokens` | running | snapshot, `paused` (continuable) | 26 |
| `approval_timeout` | running | the call is denied; the model continues | — |
| `runner_restarted`, `exec_process_lost`, `recovery_blocked` | startup (Runner), or `aiboard exec recover`, `resume`, `cancel` or `discard` (§11.3) | `interrupted`; after `recovery_blocked` the worktree is kept and nothing is applied | 24 |
| `no_finish`, `invalid_request`, `internal` | running | snapshot, `failed` | 21 |
| `secret_detected` | finishing or stop | handoff `refused`; nothing served. A finish rests in `ready_for_handoff`; a stop keeps its stop state. | 26 |
| `handoff_refused`, `apply_failed`, `patch_does_not_apply` | handoff | returns to the resting state with a reason; for `aiboard exec`, the task is kept and the result carries `applyRecipe` | 26 |
| `outcome_unknown` | stop or handoff | `outcome_unknown` | 28 |
| `not_found` | command | a task this principal may not see, or no such task | 2 |
| `invalid_state` | command | a command the task's state does not allow, such as `continue` on a running task | 2 |
| `expired` | command | the retention sweeper expired the task; it cannot continue | 29 |

The home's routes and commands have their own codes, which are not task errors: `home_busy`, `home_conflict`, `home_newer`, `home_unsafe`, `home_key_mismatch` and `home_unreadable` (§5.8), and the proxy's `proxy_path_refused` and `proxy_token_expired` (§9).
- `windows_path_too_long` comes from the same check the Runner runs at startup for Build (runner-start.ts:172-173; windows-path-limits.mjs:85), computed for the task layout (§4.1).
- The Git codes come from git-preflight.ts:13; while Git is unusable, Build and ToolBench are off (:246), and so are tasks.

Loop suspensions map as follows:
- `read_only_stall` and `repeated_evidence_failure` → `stalled`;
- `max_tokens` → `max_tokens`;
- `protocol_error` and `checkpoint_error` → `internal`;
- `turn_limit` → `turns_exhausted`;
- `budget_exhausted` → `budget_exhausted`;
- `model_ended_without_lifecycle` → `no_finish`;
- `provider_error` → by `ProviderFailureKind` (provider-health.ts:1-8): `usage_limit` → `quota_exhausted`; `rate_limit` → `rate_limited`; `authentication` → `provider_auth`; `provider_unavailable` and `transient` → `provider_unavailable`; `invalid_request` → `invalid_request` (failed, exit 21); `cancelled` → the task's own cancellation;
- `cancelled` → `cancelled`.

### 5.6 Commands: continue, handoff, cancel
~~~ts
export interface TaskContinueV1 {
  contractVersion: "aiboard.task.v1";
  idempotencyKey: string;
  prompt?: string;               // required from ready_for_handoff; optional from paused or interrupted
  budget?: TaskSpecV1["budget"]; // a fresh window; exec tasks stay under the home's exec.ceilings (§10)
}
export interface HandoffCommandV1 {
  contractVersion: "aiboard.task.v1";
  idempotencyKey: string;
  action: "keep" | "export_patch" | "discard" | "apply" | "apply_if_clean";
}
export interface CancelCommandV1 {
  contractVersion: "aiboard.task.v1";
  idempotencyKey: string;
  reason?: string;               // display only
}
~~~
- **continue**
  - It resumes the checkpointed conversation in a fresh budget window and appends `prompt` as a user turn.
  - Model, effort, access, approvals, checks and handoff mode are inherited. The closed schema refuses any other field.
  - It is allowed from resting states until the retention expiry. `aiboard exec resume <id>` is the same command for exec tasks.
  - SB4a owns the continue path: resuming the checkpoint in a new session, the fresh budget window and the inherit rules. §4.2 says which preparation steps re-run.
- **handoff**
  - `keep` and `export_patch` change no state. They set `handoff.status`, and `export_patch` also serves the patch.
  - `apply`, `apply_if_clean` and `discard` run through `handing_off`.
  - `apply` is the user's own choice and needs only mechanical preconditions. It is a web command.
  - `aiboard exec` has its own working-tree apply, `apply_worktree` (§7.2), as its default handoff and as the `aiboard exec apply <id>` verb for a kept task.
- Every web command carries its own idempotency key; a repeat returns the first outcome. `aiboard exec` verbs act on the task's files under its lock (§11.1), so a repeat finds the state the first one left.

### 5.7 Who may act on a task
- Web tasks live in the Runner's `SoloTaskStore`. The web sees and acts on them through `/v2/tasks`.
- `aiboard exec` tasks live in `state/x/<shortId>/`. The `aiboard exec` verbs run in that folder act on them (§6.3). Any process of the user's account can run those verbs, as with `codex exec resume`.
- Only the web answers approvals, and only for web tasks. `aiboard exec` has none to answer (§8.2).
- Later (NX13): a Runner started on the folder lists its earlier `aiboard exec` tasks read-only, so the web can show them. The two never run at once (§11.1).

### 5.8 AiboardHomeV1: the user's settings and keys
Owner decision, 2026-11-11: AIBoard is a CLI tool and the browser is its GUI. So the user's settings and keys live in one per-user folder that every surface reads, as `~/.codex` and `~/.claude` do for those CLIs (§9).

~~~ts
// <home>/config.json: no secrets
export interface AiboardHomeConfigV1 {
  contractVersion: "aiboard.home.v1";
  revision: number;                          // +1 on every write
  pathRevisions: Record<string, number>;     // the revision at which each section (see Ops) last changed
  updatedAt: string;
  providers: Record<string, {                // provider-registry.ts ids; ProviderKey without secrets (lib/db/schema.ts:371-399)
    enabled: boolean;
    baseUrl: string | null;                  // a gateway or override; null = the provider's default (§9)
    models: string[] | null;                 // user-defined deployments (Azure AI Foundry, NVIDIA NIM)
    enabledModelIds: string[] | null;
    defaultModel: string | null;
    lastValidationSucceeded: boolean | null;
    lastValidatedAt: string | null;
  }>;
  openAIConnectionMode: "api" | "subscription";
  customModels: HomeCustomModelV1[];         // CustomModel without apiKey and the legacy server fields (schema.ts:472-499)
  settings: HomeSettingsV1;
  exec: {                                   // added by DX1 (OD-33); writers that predate it keep it verbatim
    defaultModelId: string | null;           // `aiboard exec` without -m; must be usable by aiboard exec (§9)
    ceilings: { maxWallClockMs: number | null; // all null by default: no limit beyond the
                maxModelCalls: number | null;  // task defaults (60 min, 300 calls, §10)
                maxUsd: number | null };
  };
}

// An explicit allow-list of UserSettings fields (schema.ts:300-369), never "UserSettings minus a few"
type HomeSettingsV1 = Pick<UserSettings,
  | "defaultEffort" | "defaultMode" | "judgeModelId" | "defaultVerbosity" | "defaultStyleNote"
  | "defaultReasoningEffort" | "defaultBuildRunPolicy" | "defaultBuildSkillMode" | "defaultBuildBudgetUsd"
  | "defaultBuildTimeLimitMinutes" | "defaultBuildAlwaysRequireIndependentVerifier"
  | "modelPricingOverrides" | "modelContextOverrides" | "discoveredModelMetadata" | "providerToolCapabilityEvidence"> & {
  modelCapabilityProfiles?: Record<string, ModelCapabilityProbeProfile>; // written through a cast today (lib/client/capability-api.ts:77, :145)
  toolRuntime?: {
    remoteMcpServer?: Omit<RemoteMcpServerSettings, "authorizationToken"> | null; // the token goes to credentials
    openaiFileSearch?: OpenAIFileSearchSettings | null;
  };
};

// <home>/credentials.json: the AES-256-GCM envelope (encrypted-provider-config-store.ts:28-34) plus a clear `keyId`
interface AiboardHomeCredentialsV1 {          // the plaintext
  contractVersion: "aiboard.home-credentials.v1";
  providers: Record<string, HomeCredentialV1>;
  customModels: Record<string, HomeCredentialV1>;
  remoteMcpAuthorizationToken?: HomeCredentialV1;
}
interface HomeCredentialV1 {
  secret: string;
  boundUpstream: string;                     // the normalized base URL the secret was entered for
  savedAt: string;
}
~~~
- **Stays in each browser:** `id` and `chatDefaultApplied`; the Runner connections `toolRuntime.runner` and `benchmarkRunner`, tokens included, because each names a Runner, not a user (schema.ts:276-287, :366). The deprecated `discoveredModelCapabilities` is dropped. `openAIConnectionMode` is top-level only. A UserSettings field added later is per browser until it is named here; HM1's test fails when a field is in neither list.
- **Where.** `<home>` is `AIBOARD_HOME` when set, else `~/.aiboard`, which is `C:\Users\<user>\.aiboard` on Windows.
  - `AIBOARD_HOME` must be an absolute path to a folder the user owns; on POSIX it must not be group- or world-writable. Otherwise every surface refuses with `home_unsafe`. `aiboard exec` prints the resolved home in its stderr header (§6.3), so an environment variable never picks the keys silently.
  - AIBoard already keeps per-user files in `~/.aiboard`: managed extensions (launcher.ts:235; runner-start.ts:1052), user skills (native-build-factory.ts:3930) and the Copilot runtime (copilot-runtime.ts:66-70). On macOS and Linux it is also the install root, with `bin/`, `versions/` and `install.json` (scripts/release/installer-e2e.mts:153; self-update.ts:79-80; protected-locations.ts:134-136). The home's three files sit beside these.
  - Per-folder state and worktrees stay in the user data root (launcher-instance.ts:33-59), and so does the installed program on Windows.
  - **Uninstall.** `userStatePaths` (self-update.ts:657-665) also lists the home's three files, so `aiboard uninstall --remove-state` deletes settings and keys with the rest of AIBoard's data, and the uninstall prompt names them. Without `--remove-state` they stay; on POSIX the final `rmdir` of the install root then fails quietly and keeps `~/.aiboard` (self-update.ts:851).
- **Files.**
  - `config.json`: plain JSON with no secrets, so a person can read it and `aiboard config` can print it. "Has a key" and the key hints are not stored: readers derive them from `credentials.json`, so they can never disagree with it.
  - `credentials.json`: the envelope above. `keyId` is the first 16 hex characters of the SHA-256 of the home key.
  - The home key: 32 bytes at `<user data root>/home-key`, created the way the storage key is (storage-key.ts:19-59). It sits outside `<home>`, so a copied or synced `~/.aiboard` never carries usable keys. On Windows it stays in `AppData\Local`, which never roams.
  - `home-lock.sqlite`: the write lock. Every SQLite open, this one included, goes through `sqliteDatabaseLocation` (windows-path-limits.mjs:57), which test/windows-long-paths.test.ts:504-513 enforces.
  - Permissions: on POSIX, `<home>` is 0700 and the three files 0600. On Windows, the user profile's inherited ACL already limits them to the user, SYSTEM and administrators.
- **Reading keys.**
  - A secret is used only while its `boundUpstream` equals the current upstream of its provider or custom model (§9). A reader that sees a new `config.json` beside an old `credentials.json` therefore never sends an old key to a new host.
  - When `keyId` differs from the local home key's, the keys were saved on another computer, for example through a roaming or synced profile. Reads refuse with `home_key_mismatch` ("these keys were saved on another computer"), and so do writes to `credentials.json`, so two computers never keep overwriting each other. `aiboard keys reset` replaces them after a confirmation (§6.6).
  - When `keyId` matches and decryption fails, or the key file is missing or corrupt: `home_unreadable`, saying how to enter the keys again.
  - Any other read error, such as a sharing violation during a sync or an antivirus scan, is retried for 2 s before it becomes `home_unreadable`.
- **Who writes.** A Runner, for the web's Settings (§6.1, §6.2), and the `aiboard config`, `aiboard keys` and `aiboard models` commands (§6.6). A write:
  - takes `home-lock.sqlite`, polling for up to 5 s, then refuses with `home_busy`. `tryAcquireLock` cannot open this file: it takes only the `discovery` and `lifetime` kinds of one state directory and never waits (launcher-instance.ts:267-285), and only `acquireDiscoveryLock` polls (:287). HM1 adds `acquireLockFile(path, waitMs)` beside them, built from the same `BEGIN IMMEDIATE` pattern;
  - re-reads both files and applies one batch of ops (below), all or nothing;
  - writes each changed file to a temporary file, fsyncs it and renames it over the old one (the pattern at credential-migration.ts:388-406). On Windows a rename is retried on EPERM, EACCES and EBUSY for up to 2 s, as the installer does (self-update.ts:76). When a batch changes both files, `credentials.json` is written first;
  - bumps `revision` and sets `pathRevisions` for every section it touched.
- **Ops.** A write is a batch of `{path, op, value}` with one `baseRevision`.
  - `path` names one section: `providers.<id>`, `customModels.<id>`, `openAIConnectionMode`, `exec` (from DX1), `settings.<field>`, one entry of a map-valued settings field (`settings.modelPricingOverrides.<modelId>`, and the same for `modelContextOverrides`, `discoveredModelMetadata` and `modelCapabilityProfiles`), or one credential (`credentials.providers.<id>`, `credentials.customModels.<id>`, `credentials.remoteMcpAuthorizationToken`).
  - `op` is `set`, `merge` (named fields of an object) or `remove`. A `null` value clears a field.
  - If a touched section changed after `baseRevision`, the whole batch is refused with `home_conflict`, carrying the current revision and values. The web re-applies its change to the fresh copy and retries once (§6.1).
  - So two edits of different sections both land, two entries of one map included. Two edits of the same section: the later one is refused and retried on fresh data, so no edit is lost silently.
- **Compatibility.** A writer keeps every field it does not know, verbatim. A file whose `contractVersion` is newer than the writer's is read-only to it: reads use the fields it knows, and writes refuse with `home_newer` ("update AI Board").
- **Model ids.** Readers apply the web's model-id migration (`migrateFullModelId`, lib/providers/model-id-migration.ts:16) to every id they read, including `exec.defaultModelId`, the defaults and the enabled lists. The next write saves the migrated ids (HM2).
- **Who reads.** Readers take no lock. A rename is atomic, so a reader sees a whole old file or a whole new one. `aiboard exec` reads once at start and never writes. A Runner re-reads when `revision` or a file's modification time changed.
- **Base URLs.** A batch that changes the base URL of a provider or custom model that has a key also removes that key. With `boundUpstream`, a saved key is never sent to a new host unless the user enters it again.
- **Runner tools.** Every tool broker, Build's included, denies `credentials.json`, `home-lock.sqlite` and the home key to every actor at every level, and denies writes to `config.json`, so settings change only through the routes and commands above. This is a fixed deny in the broker, resolved through symlinks and junctions the way remote-path-guard.ts resolves paths, independent of the actor guard that today covers only `remote` and `local_mcp` actors (tool-broker.ts:567-568). Commands at an unconfined level can still read the files (custody, below).
- **Custody.** Any process of the user's account can read `credentials.json` and its key, as with `~/.codex/auth.json`, which Codex keeps in plain text. Settings and `aiboard config` say so. There is no passphrase: it would stop `aiboard exec` from running unattended (OD-27). A command at an unconfined level in any task can read the home, as it can read a folder's storage key today (§8.1).
- **Start fresh** (OD-26). Nothing is copied from a browser store. What the web then removes from its own store, and when, is in §9 ("Old Runners").
- **Account-backed models** (ChatGPT and Copilot through the account peer) keep their saved fields here like every provider, but never a credential: their peer's address and token change with every launch and come from the launcher at call time (§9, OD-32). `aiboard exec` never uses them, because it never starts the peer (OD-18).

### 5.9 Idempotency
- **Spec hash.** SHA-256 over RFC 8785 canonical JSON of the spec without `provenance`. This is the approach used at remote-admission-store.ts:857-890.
- **Same key.** Web keys are scoped per project. `aiboard exec` generates a fresh key per run; it has no repeat-submit path, because the caller gets the task id on stderr at once and resumes by id.
  - The same key and hash returns the existing task (`created: false`).
  - The same key with a different hash returns `idempotency_conflict` (HTTP 409), as in remote-admission-store.ts:205-225.
- **Tombstones.** Kept for 90 days.
- **Timeouts.** A timed-out HTTP call never means failure. Re-read by `taskId`, or resubmit the same key (Remote plan §4).

### 5.10 Storage
- `solo-tasks.sqlite` encrypts prompts, results and journal payloads with AES-256-GCM under the per-state storage key, as RemoteAdmissionStore does (OD-21). Ids, states and timestamps stay queryable.
- An `aiboard exec` task keeps the same records in `state/x/<shortId>/task.sqlite`, encrypted the same way under a per-folder exec key, `state/x/exec-key`, created on first use.
  - It is never the folder's storage key, which `aiboard exec` never creates or reads (storage-key.ts:23 *(3903fc46)*), so a Runner that later opens the folder finds its credential stores exactly as it left them.
  - It is not derived from the home key either, so entering the home's keys again after `home_unreadable` leaves kept tasks readable.
  - Checkpoints in the session store are plaintext JSON (sqlite-agent-session-store.ts), so this encryption covers the task store only; the custody note (§5.8) applies to the rest.
- Checkpoints stay in the session store.
  - Each checkpoint costs time linear in transcript size, because `SqliteAgentSessionStore.checkpoint` serializes the whole checkpoint.
  - SB4a keeps only the latest few checkpoint artifacts per task.

## 6. Surfaces

### 6.1 Web Simple Build
- **Composer.**
  - A "One model" option in the Build composer, components/DashboardPage.tsx, beside BuildCrewPicker (:782). The session is created through createDiscussion (:443).
  - It picks the model and effort, the access level, approvals and the handoff mode.
  - Choosing `workspace_unconfined` or `full` shows what commands can reach (§8.1) before the first model call.
  - Attachments are disabled with a note, because v1 prompts are text only.
- **Session.**
  - The Discussion stores the `taskId` (lib/db/schema.ts, Discussion at :401) and re-attaches after a reload; the Runner owns the state.
  - A new lib/client/solo-task-engine.ts polls the task. It sits beside lib/client/native-build-engine.ts, whose `runNativeBuildDiscussion` (:142) is the pattern.
  - Event types extend `OrchestratorEvent` (lib/orchestrator/engine.ts).
- **View.**
  - A new SimpleBuildView, rendered from app/discussion/discussion-client.tsx where BuildWorkspace is rendered today (:2945).
  - It reuses `DecisionCard` (components/build/BuildWorkspace.tsx:117) for approvals and the handoff choice.
  - It also reuses the Needs-you section (:414), extracted into its own component.
  - While open, it polls GET `/v2/tasks/approvals`, which is also the approvals-viewer heartbeat (§8.2).
- **Result card**, in two labeled halves:
  - "What the Runner observed": files with +/- counts, checks with exit codes, commands, denials, usage, detected-but-not-run checks, and whether the project folder changed during the task.
  - "What the model reports": labeled "reported by the model, not reviewed".
- **Buttons.**
  - Apply: disabled with the reason when the mechanical preconditions fail. It warns about failing checks, denials, a snapshot or unverified claims.
  - Keep, Discard, Copy patch.
  - Continue: a follow-up with a fresh budget window.
- **Approvals display.**
  - Each approval is drawn from the permission row (tool, actor, access summary) plus a sanitized command summary that the Runner builds (`commandApprovalSummary`, remote-approval.ts:52).
  - It shows the principal and session as the Runner derived them.
  - Caller-supplied `provenance` is shown only after neutralization, labeled "caller-supplied".
- **Settings on the AIBoard home (HM4b)**, app/settings/settings-client.tsx (tabs at :202-208 *(3903fc46)*):
  - **Source.** The page reads GET `/v2/home` from the connected Runner (`getLauncherConnection`, lib/client/local-runner-handoff.ts:264 *(3903fc46)*) and keeps it in memory only. The store's settings fields become a mirror of the home that is never persisted (§9, "Old Runners"), so the synchronous readers (`getUserSettings`, the provider registry) keep working.
  - **Before the first read.** Until the first GET returns, `homeReady` is false, like the store's own ready signal (`onStoreReady`, lib/client/store.ts:845-863). Settings shows a loading state, model pickers wait, and every settings writer refuses, so defaults are never written over the home.
  - **Not connected.** Providers, Tools, Capability Lab and Defaults say "AI Board isn't connected. Run `aiboard` in a terminal, in a project folder (not your home folder), and open the link it prints", with the existing setup panel (components/RunnerSetup.tsx). A Runner without `capabilities.home` gets "Update AI Board: run `aiboard update`" instead (§9). Extensions already needs a Runner. Storage still works, because it is about this browser's history.
  - **Connected.** The tabs work as today. A header names the folder the settings are saved in (the home path from GET). The page re-reads the home after every save and whenever its tab becomes visible again.
  - **Writers.** Every settings writer becomes an awaited batch of ops through the Runner (§5.8). It shows an error and reverts its change when the batch fails, and on `home_conflict` it re-applies its change to the fresh copy and retries once.
    - About twenty writers change the store synchronously today, among them lib/client/settings-api.ts:176-260, :792-825; app/settings/settings-client.tsx:175-185; lib/client/tool-runtime.ts:124-139; components/ToolRuntimeSettingsPanel.tsx:36-39; and lib/client/capability-api.ts:952-958 *(3903fc46)*. HM4b lists every one in its pull request.
    - A save that spans several sections is one batch: `saveProviderKey` writes the provider row, its key and its discovered metadata together, and `saveDefaults` writes its six fields together.
    - scripts/test-settings-home.mts fails when code outside the home client writes a settings field of the store.
  - **Keys** are typed once, sent in a request body (never a URL), and cleared from the field; the page then shows only the hint. "Test" saves the key first, then validates it through the model proxy (`validateProvider`, lib/client/settings-api.ts:1082) and writes the outcome to the home (§9, "Testing a key").
  - **Import and export.** Settings import (lib/client/storage-import.ts:41-47 *(3903fc46)*) skips keys and says to use `aiboard keys set`; export omits them. scripts/test-storage-settings-import.mts pins today's key merge, so HM4b rewrites it to pin the new rule.
  - **Defaults** gains an "`aiboard exec`" group, added by DX1 and shown only when the Runner reports `capabilities.execSettings`:
    - the default model, picked from the ids `aiboard exec` can use, with account-backed models shown as unavailable and why (OD-18);
    - optional per-task ceilings (minutes, model calls, USD);
    - a copyable example command.
  - **Security** becomes "Where your settings and keys live": the home path, the key's location, the custody note (§5.8) and what unconfined commands can reach (§8.1). The passphrase controls are removed (OD-27). A store that is encrypted today still gets a decrypt-only unlock, and is saved without encryption only after the user confirms (OD-28).
- **Client code.** Functions go in lib/client/runner-v2.ts, beside the ToolBench client (:27-51).

### 6.2 HTTP routes (`web` principal: Runner token or paired local session)

| Route | Purpose |
|---|---|
| POST `/v2/tasks` | Admit idempotently, in under 2 s and with no binding. Returns 201, or 200, with `{taskId, created, state, effective}`. |
| GET `/v2/tasks?state=&cursor=`, `/v2/tasks/:id` | List; snapshot with `waitingFor` |
| GET `/v2/tasks/:id/events?after=&waitMs<=10000` | Event page, long-poll of at most 10 s; at most 32 KiB, with `more` and the cursor |
| GET `/v2/tasks/:id/result?page=`, `/patch?offset=` | Result and diff, paged at 32 KiB serialized |
| POST `/v2/tasks/:id/cancel`, `/continue`, `/handoff` | `CancelCommandV1`, `TaskContinueV1`, `HandoffCommandV1` |
| GET `/v2/tasks/capabilities` | Access levels possible here, isolation facts, runtimes, efforts, limits |
| GET `/v2/tasks/approvals` | Pending task approvals, and the approvals-viewer heartbeat. Only a request with an allowed browser Origin or a paired local session stamps it (§8.2). |
| GET `/v2/home` | The home's config with "has a key" and the key hints derived from the credentials, never a secret; the paths of the home and its key; `revision` and `pathRevisions` (HM3) |
| POST `/v2/home` | One batch of ops with its `baseRevision` (§5.8). Returns the new `revision`, or 409 `home_conflict` with the current values. POST rather than PATCH, because the control port's CORS allows no PATCH or DELETE (control-server.ts:1756), and the existing approve, decline and credential routes are POST (extension-control-routes.ts:72-75). |
| POST `/v2/home/credentials/:providerId`, `/v2/home/credentials/custom/:id`, `/v2/home/credentials/remote-mcp` | `{action: "set", secret}` or `{action: "remove"}` for one key. The request body carries the key; the response carries only its hint. |
| POST `/v2/home/proxy-session` | A proxy token for this paired session and the proxy port's base URL (§9) |
| GET and POST on the proxy port: `/v2/model-proxy/:providerId/*`, `/v2/model-proxy/custom/:id/*` | The model proxy (§9). It takes the proxy token, not the Runner token, and no other route takes the proxy token. |
| existing PUT `/v2/provider-configs` | Configs may omit `secret`. The Runner resolves each from the home, or refuses with `home_key_missing` or `upstream_mismatch` (§9). |
| existing GET `/v2/health` | Gains `capabilities.home`, `capabilities.modelProxy`, `capabilities.secretlessProviderConfigs` and `catalogVersion` (§9); DX1 adds `capabilities.execSettings` |
| existing `/v2/permissions` | Approvals (control-server.ts:556-582) |
| existing live output | An injected owner check resolves task ids instead of `requireBuilds()` (control-server.ts:1581-1588) |

Errors are typed 4xx responses carrying `TaskErrorV1`. `aiboard exec` uses none of these routes: it needs no Runner.

### 6.3 CLI: `aiboard exec`
- `exec` joins the parsed `Command` union (launcher.ts:44 *(3903fc46)*). The update/uninstall/doctor dispatch before parsing is unchanged.
- **One-shot and headless.** It does one task in its own process, prints the result and exits. It never starts or contacts a Runner, never opens the web app, and starts no MCP server. Nothing it starts outlives it: a clean exit or Ctrl+C stops everything, and when the process is killed, the owner tether stops the task's processes (§11.2).
- It works the same from a person's terminal, a script, or another agent's shell tool.

~~~
aiboard exec [flags] "<prompt>"          # run a new task in this folder
aiboard exec resume <id> ["<prompt>"]    # continue a paused, interrupted or kept task (a fresh budget window)
aiboard exec cancel <id>                 # ask a running task to stop (§11.2), wait up to 30 s, exit with its code
aiboard exec wait <id> [--timeout <s>]   # block until a running task stops, then exit with its code
aiboard exec list [--json]               # this folder's tasks: id, state, model, age, pid and start time while running, handoff
aiboard exec show <id> [--page <n>] [--json]   # the stored result, paged; for a running task, its state and last event
aiboard exec diff <id> --output <path>   # write the binary-safe patch to a file (git's --output)
aiboard exec apply <id>                  # apply a kept task's patch to the working tree (§7.2)
aiboard exec discard <id>                # remove the task's worktree, branch and refs
~~~
`aiboard models` (§6.6) lists the models `aiboard exec` can use; there is no `aiboard exec models`.

| Flag | Meaning | Default |
|---|---|---|
| `-m, --model <id>` | a model `aiboard exec` can use, as `providerId:modelId` (§9) | the home's `exec.defaultModelId`; with none set, the only usable model (OD-24) |
| `--effort <default\|none\|low\|medium\|high\|xhigh\|max>` | validated per model | the home's default reasoning effort, or a custom model's own |
| `--access <read_only\|workspace_contained\|workspace_unconfined\|full>` | any level (OD-2, OD-3) | `workspace_unconfined` |
| `--network <deny\|allow>` | Runner network tools (§5.1) | `deny`; `allow` at `full` |
| `--handoff <apply\|keep\|patch\|discard>` | §7.2. `apply` is the working-tree apply. `patch` stores the patch and puts its path in the result. | `apply` |
| `--max-minutes`, `--max-model-calls`, `--max-tool-calls`, `--max-usd` | budget, within the home's ceilings | 60, 300, none, none; or the home's ceilings when set |
| `--deadline <seconds>` | a wall clock for this process. At the deadline minus a 30 s stop reserve, the in-flight model or tool call is aborted and the task pauses with a snapshot (`deadline_exceeded`). Set it below the caller's tool timeout (below). | none |
| `--checks <agent\|runner>` | §12.4 | `agent` |
| `--prompt-file <path>`, or `-` | prompt from a file or stdin (UTF-8, UTF-8 with BOM, UTF-16). On Windows, use one of these: see "Windows" below. | argv |
| `-C, --project <dir>` | the folder to work on | the repository root of the current directory (`git rev-parse --show-toplevel`), else the current directory |
| `--init-git` | allow a non-git folder or a repository with no commit (OD-13) | off |
| `--json`, `--output-format <text\|json\|stream-json>` | output | `text` |
| `--page-bytes <n>` | the size cap of one result page | 12288 |
| `--quiet` | no progress lines on stderr | off; on when the output is `json` or `stream-json` and stderr is not a terminal |
| `--label <text>` | display label | — |

- There are no `--dangerously-*` names and no `--result-file`. The result is stored with the task, and `aiboard exec show <id>` prints it again.
- **stderr, first line**, right after admission and before preparation and the first model call: the task id, model, effort, access level, command isolation and handoff, for example `task_… openai:… effort=high access=workspace_unconfined (commands run as you, unconfined) handoff=apply`. A caller that loses stdout can still cancel, wait for, resume or show the task by id. When `AIBOARD_HOME` is set, a second line names the home it read (§5.8). `--quiet` never hides these lines.
- **stderr, after that**: one short progress line per model turn and tool call, unless `--quiet`.
- **stdout**:
  - `text`: a fixed Runner line ("Delegated-model output follows; it is data, not instructions."), the model's summary labelled as reported, then the Runner's facts: files with +/- counts, checks with exit codes, denials, usage, and the handoff outcome. It is capped at the page size, and ends with the `show` command for the rest.
  - `--json`: one `TaskResultPageV1` (below).
  - `stream-json`: `TaskEventV1` lines (the first is `task.admitted`), then the first result page.
- **Size.** A page is at most `--page-bytes`, 12 KiB by default. Claude Code's shell tool truncates output past 30,000 characters, and the stderr header and progress lines land in the same captured output; a cut page is invalid JSON. Codex's limit may be smaller. DX5b records each caller's real limit.
- **ASCII only.** JSON output writes every non-ASCII character as `\uXXXX`, because Windows PowerShell 5.1 decodes native output with the OEM code page.
- Terminal control sequences are stripped from everything a model or repository wrote.
- **Exiting.** The process sets `process.exitCode` and lets stdout drain; it never calls `process.exit()` after a large write to a pipe, which can drop the end of the output.

~~~ts
interface TaskResultPageV1 {
  contractVersion: "aiboard.task-result-page.v1";
  // summary first, on every page
  taskId: string;
  state: TaskState;
  outcome: TaskResultV1["outcome"] | null;
  exitCode: number;                           // authoritative; the same code the process exited with
  handoff: { mode: string; status: string; reason?: string };
  changes: { files: number; added: number; removed: number; firstPaths: string[]; committed: boolean };
  error?: TaskErrorV1;
  // then whole entries of the result's lists, in order, as many as fit
  page: number;
  entries: Partial<TaskResultV1>;
  more: { nextPage: number; totalPages: number } | null;  // `aiboard exec show <id> --page <n> --json`
}
~~~
- Every page is a standalone JSON object that parses on its own. A missing page on stdout means the process crashed; `aiboard exec show <id>` then reports the task (exit 24 once recovered, §11.3).

**Refusals.** Refusals at admission create no task. A project precondition found in `preparing` (§5.5) leaves a `failed` task. With `--json`, every refusal prints a `TaskErrorV1` on stdout, with `retryable: true` for `exec_busy`.

| Code | Message |
|---|---|
| `folder_open_in_runner` | "This folder is open in AI Board (the Runner started by `aiboard`). Close it, or run `aiboard stop` in this folder, then retry." When that Runner was started by `aiboard mcp serve`: "This folder is open in AI Board's MCP server (`aiboard mcp serve`, probably your agent's own connection). Use its tools, or run `aiboard exec` in a linked worktree." (§11.1) |
| `runner_recovery_pending` | "AI Board has unfinished work from a Runner in this folder. Run `aiboard` here once to finish it, then retry." (§11.1) |
| `no_delegate_models` | "No models are set up for AI Board. Run `aiboard keys set <provider>` and `aiboard models enable <id>`, or enable one in AI Board's Settings." |
| `model_not_enabled` | "`<id>` is not enabled in AI Board. Usable: `<a>`, `<b>`. Run `aiboard models enable <id>`, or enable it in Settings." |
| `no_default_model` | "Several models are enabled: `<a>`, `<b>`. Pass `-m <id>`, or set a default with `aiboard config set exec.defaultModel <id>`." |
| `home_unreadable` | "AI Board cannot read its saved keys (<reason>). Enter them again with `aiboard keys set <provider>`, or in Settings." |
| `home_key_mismatch` | "AI Board's saved keys were saved on another computer. Run `aiboard keys reset`, then set them again." |
| `home_unsafe` | "`AIBOARD_HOME` points to a folder that is not yours alone: <reason>." |
| `windows_path_too_long` | "This folder is too deep for Windows: <path> would be <n> characters, over 258. Move the project to a shorter path." |
| `git_missing`, `git_too_old`, `git_unverified` | the Runner's own Git messages (git-preflight.ts:246, :259) |
| `project_inside_aiboard_state` | "This folder is inside AI Board's own data." (§11.4) |
| `depth_exceeded` | "`aiboard exec` cannot run inside another AI Board task." (§11.4) |
| `exec_busy` | "Another AI Board command is starting in this folder; retry." (the 10 s discovery-lock wait ran out, §11.1) |
| `ceiling_exceeded`, `effort_unsupported`, `isolation_unavailable`, `budget_unenforceable` | as in §5.5, each naming the limit or the supported values |

**Exit codes.** Task codes sit in 20–29, outside Node's own fatal codes (1 and 3–14), so a crash of Node itself never reads as a task outcome. The first matching row wins. The page's `exitCode` is authoritative.

| Exit | Meaning |
|---|---|
| 28 | `outcome_unknown` |
| 130 | Ctrl+C (SIGINT, and SIGBREAK on Windows): the task was cancelled with a verified stop (§11.2); the result is printed |
| 143 | SIGTERM, where it can be caught (POSIX): the same |
| 2 | usage error, invalid flags, unknown task id, or a verb the task's state does not allow |
| 29 | refused before any model call (the table above), a project precondition, or an expired task |
| 124 | `aiboard exec wait --timeout` ran out; the task is still running |
| 20 | `show`: the task is running |
| 25 | cancelled other than by a signal to this process (`aiboard exec cancel`) |
| 24 | interrupted: the process that ran the task died (reported by `show`, `wait` and `list` after recovery, §11.3) |
| 23 | paused by a provider or quota error (see `error.resetsAt`) |
| 27 | paused by a budget, turn or deadline limit, `--deadline` included |
| 21 | failed |
| 26 | nothing landed: outcome `blocked`; `stalled` or `max_tokens`; or the apply was refused (the patch does not apply, a secret was found, or nothing was committed) |
| 22 | the handoff resolved as asked, but a recorded check failed, `unverifiedClaims` is not empty, or the outcome is `partial` |
| 0 | `done`, no failed check, an empty `unverifiedClaims`, and the handoff resolved as asked (applied, kept, patch stored or discarded). A `read_only` task or an empty diff counts as resolved. |

- `cancel`, `wait` and `show` exit with the task's own code once it has stopped.
- Exit 0 does not need a passing check: the owner's model of a delegate is "like `codex exec`", which exits 0 when the agent finishes. The result still lists every check and every Runner-detected category that was not run, and a recorded failing check gives 22 when the patch landed, or 21 when the task failed.

**Caller timeouts.** Claude Code's Bash tool stops a command after 120 s by default and at most 600 s *(docs)*. The same holds for `codex exec` and `claude -p` run from a shell tool. On Windows such a stop is a hard kill: no signal handler runs, and the owner tether and recovery take over (§11.2, §11.3). So the caller docs (DX5a) say:
- for a short task, run `aiboard exec ... --json` in the foreground with `--deadline` 60 s below the tool's timeout;
- for a long task, start it in the background (Claude Code: `run_in_background`) with `--handoff keep`, read the task id from the first stderr line, `aiboard exec wait <id>` or `show <id> --json` later, and run `aiboard exec apply <id>` when the caller is ready for the edits. A background run with the default `apply` would land its patch in the caller's tree at an arbitrary moment.

~~~sh
# From Claude Code, Codex or agy (their shell tool), in a folder that is not open in AI Board's Runner:
aiboard exec -m <providerId:modelId> --effort high --deadline 540 --prompt-file task.md --json
# A longer task, started in the background:
aiboard exec -m <providerId:modelId> --access full --handoff keep --prompt-file task.md --json
aiboard exec wait <task id from stderr line 1> --timeout 540
aiboard exec apply <task id>
~~~

**Windows.**
- The managed install provides only `aiboard.cmd` (in AppData\Local\AIBoard\bin), which runs Node with `%*` through cmd.exe (self-update.ts:89-103).
- cmd re-parses `%*`: a newline ends the command, so a multi-line prompt is cut at its first line; an odd number of quotes exposes `&`, `|` and redirections to cmd (the BatBadBut class, CVE-2024-27980); and the line is capped at 8,191 characters. So on Windows, prompts go in `--prompt-file` or on stdin (`-`). `aiboard exec` warns on stderr when an argv prompt arrives through `aiboard.cmd`, which it can tell because the batch file sets `AIBOARD_VERSION`.
- Git Bash, the shell behind Claude Code's Bash tool, does not resolve a bare `aiboard` to `aiboard.cmd`. DX5a ships an extensionless `aiboard` shim beside it: a `#!/bin/sh` copy of the POSIX shim (self-update.ts:106-116) that execs `node.exe` directly, so no cmd is involved. `writeShim` (:119-124) and install.ps1 write it, and uninstall removes it.
- No `aiboard.ps1` is added: Windows client editions default to the Restricted execution policy, and PowerShell would prefer the `.ps1` and fail.
- Ctrl+Break arrives as SIGBREAK and is handled like Ctrl+C. Closing the console sends SIGHUP, and Windows ends the process about 10 s later, so on SIGHUP the process writes its stopping marker and exits within 5 s (§11.2). Ctrl+C through `aiboard.cmd` can stop at cmd's "Terminate batch job (Y/N)?" prompt, which is one more reason the shim runs Node directly.
- DX5a runs every documented shell line in Git Bash, PowerShell and cmd.

**Unattended caller permissions** (from each CLI's docs; DX5b verifies each with a real headless run, with the owner's approval):
- **Claude.** `-p` starts in Manual mode, so un-allowed tools do not run. Allow `Bash(aiboard exec:*)` through `--allowedTools` or settings `permissions.allow`.
- **Codex.** `aiboard exec` writes outside the workspace (the per-user state folder) and needs the network for its provider. Codex's `workspace-write` sandbox may block both, so DX5b measures it and documents the sandbox and approval settings that let the command run.
- **agy.** Add the allow rule `command(aiboard exec ...)`. On Windows, use a `regex:` command rule, because the command runs as `aiboard.cmd`.

### 6.4 MCP task tools: not in v1
- The owner wants nothing extra running for delegation. Every inspected caller has a shell tool, and `aiboard exec` is a shell command, so an MCP server adds a process and buys nothing.
- The withdrawn design (a tasks-scope MCP proxy, bounded waits, typed idle expiry, `launchKind`, signed mint fields) is in this file's history at acb7dcc1. If a caller ever needs MCP, NX3 is a thin stdio server whose tools run `aiboard exec` processes.
- The existing local MCP door (`aiboard mcp serve`) is unchanged by this plan.

### 6.5 Later surfaces

| Surface | Plan |
|---|---|
| Remote X3 | A cloud agent hands work to the local Runner, which uses the user's providers (Remote plan line 268). X3 calls this service with `task_*` names instead of `build_start`/`build_status`/`build_evidence`; no account-backed providers (Remote D1). After the Remote launch (NX5). |
| ACP | An `aiboard acp` stdio adapter for editors over the task engine's admit, events and result (NX6). |
| MCP task tools | A thin stdio server whose tools run `aiboard exec` processes, if a caller ever needs MCP (NX3). The `io.modelcontextprotocol/tasks` extension had no runtime in SDK 2.4.0 and was beta in Claude Code's main conversation only *(docs)*. |
| Outbound executors | CLI workers come first, in their own plan (OD-33): Codex CLI, Claude Code and agy as Build workers. They are the 2026-10-15 plan's Milestone B and the owner's Delegate-mode idea, for Build. NX7 is what remains after them: Simple Build tasks run by a CLI, over the same adapter. All three vendors restrict wrapping *(docs)*: Google's FAQ says wrapping agy in third-party apps is unsupported on consumer plans; the Claude Agent SDK policy says third-party products may not offer claude.ai login or rate limits without approval; Codex says app-server authentication was never permitted for commercial or hosted services. Whether this covers driving the user's own local CLI is unsettled. CLI workers need that owner or legal decision first, and NX7 reuses it: the user's own CLI and login only, and API-key mode for anything hosted or Remote. |

**CLI workers and this plan.** They are built after the home (OD-33). What they get from this plan, and what they must respect:
- **Settings in the home.** Their settings (which CLIs, model, effort, consent, test results) are home settings from the start: their plan names them in HM1's allow-list (§5.8) and saves them as op batches through the Runner (§6.1). Each CLI's own login stays in that CLI's files.
- **Configs.** A CLI worker's config takes no key from the home, so HM3 stores it as pushed (§9).
- **No tasks on a CLI.** A Simple Build task runs AIBoard's own agent loop, so admission refuses a CLI runtime with `runtime_unsupported` until NX7 (§9).
- **No loop.** A CLI worker is a child of the Runner, so `aiboard exec` started inside it is refused (§11.4).
- **One commit-undo step.** Their step that undoes a CLI's own commits is the method SB4b needs, and SB4b reuses it (§12.3).
- **Names.** Call them CLI workers, with a `cli` transport. Here "Delegate" means `aiboard exec`, and the Runner already says "local agents" for Build and Chat (local-agents-availability.ts:1-13 *(3903fc46)*).
- **Re-run checks.** Their plan re-runs the checks a CLI reports. It should refuse or time-limit `npm run test:runner-v2`, which takes hours (§18.2).
- **Browser evidence.** A CLI cannot record AIBoard's browser evidence, so this plan's UI work in the AIBoard Build (SB8, and DX1's Settings group) suits API workers better.

### 6.6 CLI: the AIBoard home
`aiboard exec` needs models without the web, so the home can also be set up from a terminal, as `codex login` does for Codex (HM5).
- The commands join the parsed `Command` union (launcher.ts:44 *(3903fc46)*). They start no Runner and write through the home lock (§5.8).

~~~
aiboard config [--json]                  # where the home and its key are; providers with key hints; enabled models; defaults
aiboard config set <key> <value>         # the keys in the table below
aiboard keys set <provider> [--stdin]    # prompts with echo off; --stdin reads one line from a pipe instead
aiboard keys remove <provider>
aiboard keys reset                       # after a confirmation, replaces keys saved on another computer (home_key_mismatch)
aiboard models [--json]                  # every enabled model; from DX1, marking the ones `aiboard exec` can use
aiboard models enable <id>               # a catalog id (§9) or a custom model id
aiboard models disable <id>
~~~
- A key is never taken from argv. `aiboard keys set openai sk-…` is refused, with a hint to pipe the key with `--stdin` or answer the prompt.
- **The prompt.** It uses `process.stdin.setRawMode(true)` and echoes nothing. A stdin that is not a terminal is read only with `--stdin`, so a session where Node sees no terminal, such as Git Bash's mintty, never reads a key while the terminal echoes it; there the command says to use `--stdin`. A leading BOM and a trailing CR or LF are stripped, because PowerShell pipes add them.
- `aiboard keys set` makes no network call. `aiboard config` shows the key as not validated until the web validates it.
- `aiboard models enable` refuses an id with an unknown provider, and names the nearest catalog ids. For a provider that discovers its models, an id that is not in the catalog snapshot is accepted with a warning (§9).
- In v1, custom models and pricing are edited in the web. `aiboard config set` covers only these keys:

| CLI key | Home path | Value |
|---|---|---|
| `exec.defaultModel` | `exec.defaultModelId` | a `provider:model` id, checked as for `aiboard models enable` |
| `exec.maxMinutes` | `exec.ceilings.maxWallClockMs` | 1–1440, stored × 60000; `none` clears it |
| `exec.maxCalls` | `exec.ceilings.maxModelCalls` | 1–10000; `none` clears it |
| `exec.maxUsd` | `exec.ceilings.maxUsd` | more than 0; `none` clears it |
| `defaults.reasoningEffort` | `settings.defaultReasoningEffort` | a `ReasoningEffort` value (lib/db/schema.ts:309), not the discussion effort `defaultEffort` |

HM5 ships `defaults.reasoningEffort`; the four `exec.*` keys arrive with DX1 (OD-33).

## 7. Isolation and handoff

### 7.1 Where work happens
- **Writing levels** work only in the task's worktree, on a task branch cut from the baseline.
  - Runner file tools never write the user's folder before handoff.
  - Commands at `workspace_unconfined` and `full` can. So the finish pipeline records `projectChangedDuringTask`, which blocks `apply_if_clean` and appears in the result. It compares HEAD, the index and `status --porcelain=v1 -z --untracked-files=all` against the snapshot taken in `preparing`.
- **What a writing task adds to the user's repository before handoff.** Nothing in the working tree. Only git metadata:
  - git objects;
  - the baseline ref (`refs/aiboard/runs/<segment>/baseline`);
  - the task and integration branches under `aiboard/<segment>/` (workspace-manager.ts:187);
  - the worktree registration under `.git/worktrees`.

  It never writes the working tree, the index, HEAD or `.gitignore`. Its reads of the project run with `GIT_OPTIONAL_LOCKS=0`, which SB2 sets (nothing does today, §11.1), so they never refresh the index's stat cache or take `index.lock`.
- **Line endings.** Runner git suppresses system and global config (git-execution-policy.ts:62-65), which drops a system-level `core.autocrlf=true`, the Git for Windows default. The baseline (`read-tree HEAD` into a fresh index, then `add -u`, git-baseline.ts:104-123) would then store a new CRLF blob for every text file, so the baseline tree would differ from HEAD everywhere, and a file the model rewrites with LF would become a whole-file patch.
  - So SB2 reads the user's effective `core.autocrlf`, `core.eol` and `core.safecrlf` once with `git config --get` (plain values; no driver runs), and tasks pass them as `-c` to every Runner git command on the project and the task worktrees: the baseline, the worktree checkout, the ChangeSet and the apply.
  - It is an option, so Build keeps today's behavior. Applying it to Build is later work (NX19).
- **The baseline includes uncommitted work.**
  - It snapshots tracked changes and untracked files through a private index (git-baseline.ts:106-108).
  - It excludes `.env*`, `node_modules/` and untracked files over 100 MiB (:16, :244-249).
  - So the task starts from what the user sees, and its diff applies on top of the user's current working tree.
- **`read_only`** reads the project root with inspection tools. It needs no worktree and no git, never captures a baseline, and writes nothing.
- **Repository checks** run in `preparing` (§4.2 step 2), in this order:
  - a non-git folder fails with `project_not_repo`, unless `initGit` is set (OD-13);
  - a path that is not the repository root fails with `project_not_repo_root` (git-baseline.ts:84-88), so a subfolder of an unborn repository is refused here;
  - a repository with no commit fails with `project_has_no_commits`, unless `initGit` is set.

  Without the SB2 option, git-baseline.ts:73-80 would append AIBoard's ignore block to the user's `.gitignore` and run `git init -b main`, both before the root check at :84-88. For a repository with no commit it would then also create an "AIBoard initial baseline" commit (:143-164) and move the user's HEAD to it (:188-190). SB2 moves the root check first in both modes.
- **`docs/project/`.** Build refuses ChangeSets that touch it (integration-manager.ts:735-743, :4553-4557). Tasks pass `reserveDocsProject: false`; Build keeps the default (SB2).

### 7.2 Handoff modes

| Mode | Effect | Who | Default for |
|---|---|---|---|
| `ask` | `ready_for_handoff`, status `pending`; the web offers Apply, Keep, Discard, Copy patch | spec | web |
| `keep` | Rests in `ready_for_handoff`, status `kept`. The branch stays and the task stays continuable. Unless the secret check failed or the snapshot was unavailable, the result carries `applyRecipe`. | spec or command | — |
| `export_patch` | Serves the ChangeSet binary diff (`--binary --full-index`, change-set.ts:166-172), paged through `/patch` or `aiboard exec diff`; status `exported`; no new file owner | spec or command | — |
| `apply` | The user's own choice. Needs only `applyToProject`'s mechanical preconditions: journal recovery, a named branch, and a clean tree including untracked files (integration-manager.ts:1701-1734). It lands as a commit on the user's branch. Warns about failing checks, denials, a snapshot or unverified claims. After a successful apply, the worktree and the Runner-private refs are removed; the task branch stays (OD-14). | web command | — |
| `apply_if_clean` | Applies when §7.3 holds. Otherwise status `refused` with reasons, and the task rests as kept. | web spec or command | — (the web user's choice; OD-1 decided) |
| `apply_worktree` | Applies the task's patch to the user's **working tree**, uncommitted, as `codex exec` leaves its edits. Conditions: `finish_task` ran with outcome `done` or `partial`; `changes.committed` is true; the secret check was clean; `git apply --check` of the patch passes against the current working tree. Then `git apply`, under a journal (below). On any failure, status `refused` with the reason, the task rests as kept, and the result carries `applyRecipe`. A `blocked` outcome, and every stop that is not a finish (paused, failed, interrupted, cancelled), rests as kept with `applyRecipe` and stays resumable; it is never applied. Serialized between processes by the exec-apply lock (§11.1). After a successful apply, the worktree and private refs are removed and the branch stays (OD-14). New files land untracked, and the result lists them (`handoff.untrackedPaths`). | `aiboard exec` (`--handoff apply`, or the `apply` verb) | `aiboard exec` (OD-23) |
| `discard` | Removes the worktree, the task branches and the private refs, through SB7's owner methods. Also allowed on terminal writing tasks, with no state change. | spec or command | — |

**Why `aiboard exec` applies to the working tree, not with `applyToProject`.** A delegating agent is usually mid-work, with uncommitted changes of its own. `applyToProject` requires a clean tree (integration-manager.ts:1724-1733 *(3903fc46)*) and commits on the user's branch, so it would refuse almost every delegated task. The baseline already includes the user's uncommitted work (§7.1), so the task's patch is relative to the tree the caller sees. `git apply --check` refuses when a hunk's context no longer matches; `git apply` moves a hunk to a new offset, so an edit the user made elsewhere in the same file is kept, not refused. DX4 tests both: an overlapping edit is refused, a non-overlapping one applies. This brings forward the useful half of NX2 (apply into a dirty tree) for `aiboard exec` only; the web's `apply` keeps its commit semantics.
- `apply_worktree` does not require a passing check or an empty `unverifiedClaims`. The result reports both, and the exit code reflects them (§6.3), as with any other CLI agent whose edits land as it works.
- It writes only the working tree: no index, no HEAD, no commit (plain `git apply`, §7.2's recipe notes).
- **The apply journal.** A working-tree apply writes file by file. A write error (on Windows, a file an editor or dev server holds open) or a kill during the apply could leave a partly applied tree, and `recoverProjectApply` covers only the web's commit apply, which goes through an isolated index (integration-manager.ts:1790-1818, :2303-2311). So before `git apply` runs, the task writes `state/x/<shortId>/apply.json` with the patch id and each path's pre-image and post-image blob ids. Recovery hashes each path and classifies the apply as landed, not started, or mixed. Mixed gives `outcome_unknown` (exit 28) with the paths listed, and is never repaired automatically.
- **One set of flags.** The Runner's check, its apply and the recipe use the same flags, so the user's `diff.renames` or `apply.whitespace` cannot make the recipe differ from what the Runner checked (change-set.ts:165-177 adds `--no-renames` only with `submissionScope` today). Both commands run with `-C <repository root>`, so a recipe run from a subfolder still covers every file. Line endings follow the user's settings (SB2, §7.1).

`applyRecipe` is fixed, written by the Runner, and names only the task's own branch and its baseline commit:
~~~
git -C <root> diff --binary --full-index --no-renames --no-ext-diff --no-textconv --no-color --output=<file> <baseRevision> <branch>
git -C <root> apply --whitespace=nowarn <file>
~~~
- It names the baseline commit id, not the Runner-private baseline ref, so it still works after the sweeper prunes that ref. The commit stays reachable as an ancestor of the kept branch.
- It is two commands with no pipe:
  - piping native output re-encodes it in Windows PowerShell 5.1;
  - without `--binary`, binary changes cannot apply.
- Plain `git apply` changes the working tree only. Use `--3way` only when the touched paths are committed or staged, because `--3way` implies `--index`.
- `keep` is not an apply. The Runner never writes the project under `keep`, so the final-handoff rule (AGENTS.md:42) is untouched.
  - What a calling agent does with a returned branch is governed by the caller's own permissions, as with Codex or Claude worktrees.
  - The real risks on this path are covered elsewhere: secrets by the finish pipeline's check, which withholds the recipe on a hit (§12.3), and steering of the caller by output neutralization (§5.3).

### 7.3 `apply_if_clean` conditions
1. The web user chose `apply_if_clean` for the task (OD-1 decided: the code's rule). These conditions are for web tasks; `aiboard exec` uses `apply_worktree` (§7.2).
2. The outcome is `done`, from `finish_task`. A snapshot never qualifies. This is a necessary claim, not evidence.
3. The checks:
   - at least one check ran and passed;
   - every Runner-detected category has a matching passing evidence record or runner check (§12.3 step 6), so no `runner_detected` notRun entry remains;
   - `unverifiedClaims` is empty.
4. No failed check, no `knownIssues` and no permission denials. Denials count as defects.
5. The finish pipeline's secret check was clean (§12.3).
6. `projectChangedDuringTask` is false.
7. The project tree is clean and on a named branch.

### 7.4 Retention
- Who sweeps:
  - the Runner, for web tasks, and at its start for expired `aiboard exec` tasks, since it then holds the folder (§11.1);
  - `aiboard exec recover`, for every `aiboard exec` task in the folder whose lock is free;
  - each writing verb, for its own task only. A new task never sweeps others, so a caller never waits for old work.
- `aiboard exec list` shows `expiresAt`, and how many tasks wait for `recover`.
- The sweeper never removes a worktree that holds uncommitted changes before it has taken a secret-checked snapshot commit on the task branch. When it cannot, it keeps the worktree and lists the task as needing attention.
- A resting task keeps its worktree for 7 days after its last state change (OD-14).
  - Results show `expiresAt`.
  - The web shows an "expires on" notice before unexported work expires.
- Terminal writing tasks that still hold a worktree (failed, cancelled, `outcome_unknown`) are swept on the same 7-day clock. A task that completes by apply, or with an empty diff, has its worktree and private refs removed at once.
- At expiry, the sweeper:
  - removes the worktree and the Runner-private refs (baseline, integration, `integrated/*`, `handoff/*`) through SB7's owner methods (§4.1);
  - never deletes a task branch that holds commits; only an explicit discard does that;
  - compare-and-sets the branch tip against the recorded task tip;
  - skips a branch that is checked out in any worktree.
- Kept or exported resting tasks become `completed`. A task whose handoff status is `refused` counts as kept. Other resting tasks become `cancelled` with `expired`, and later commands on them return `expired`. Terminal tasks keep their state.
- Task records (results and journals) are deleted 90 days after the task reaches a terminal state. The idempotency tombstone (§5.9) is kept for 90 days after that. An `aiboard exec` task's whole root goes with its records; its keys are fresh per run, so it needs no tombstone.

### 7.5 The auto-apply conflict
- **The docs.**
  - AGENTS.md:42 (at 3903fc46; replaced on 2026-11-11): "Final project handoff always pauses for a user choice, including under Full access."
  - docs/runner-v2/guide.md:9: "Final project handoff still pauses for the user."
  - docs/runner-v2/evidence-gated-planning.md:39: "Final project handoff always waits for your choice."
- **The code.** `finalizeExecutionInsideActivity` (native-build-manager.ts:1139-1196) auto-applies when three conditions hold (:1145-1150):
  - `projectHandoff.status === "requested"`;
  - `runPolicy` is `finish` or `budgeted`;
  - there are no `knownDefects`.

  It calls `selectProjectHandoffInsideActivity(runId, "apply_to_project", "automatic-project-handoff", ...)`. On failure it pauses with `automatic_project_handoff_failed`.
- **History.** Commit e7942618 (2026-07-14, "automatically commit completed builds") introduced the auto-apply. Commit acd3b78d (2026-10-26) made known defects wait for the owner.
- **Decision (OD-1, 2026-11-11): the code rules and the docs are stale.** The rule becomes:
  - "Final project handoff pauses for a user choice unless the run's policy is finish or budgeted, a project handoff was requested, and no known defects are recorded. A failed automatic apply pauses for the user."
  - "A Simple Build task applies automatically only when its user chose `apply_if_clean` in the web. `aiboard exec` applies its patch to the working tree by default when the patch applies cleanly and no secret was found; `--handoff keep` keeps the branch instead."
- The first sentence, about Build, replaced AGENTS.md's on 2026-11-11, before the Build (§17 item 1); SB0 writes it into the other two docs. The task sentence lands with SB7 (web tasks) and DX4 (`aiboard exec`), so the docs never describe a feature before it exists (§17).

## 8. Access levels and approvals

### 8.1 Access levels

| Level | Binding | Broker | Commands | Disclosed |
|---|---|---|---|---|
| `read_only` | full | Inspection only: reads, search, code navigation, read-only git. No process tools, and no tool, hidden or visible, that is not `readOnly`. `research.fetch` under `network: ask` behind approval (web), or under `network: allow` without asking (`aiboard exec`). | none | `inspection_only`; the Runner's own git runs unconfined |
| `workspace_contained` | project | Project | Contained by an attested provider. Refused with `isolation_unavailable` when none qualifies, which is always the case on a stock install. | `contained` |
| `workspace_unconfined` (default, web and `aiboard exec`) | full | Project. Writes, deletes and commands inside the worktree are approved. Runner file tools outside the worktree and credential-changing Runner tools go to the approvals mode, and so do `research.fetch` and `browser.*` under `network: ask`. | Unconfined: they run as the user and are not checked for network, credential or outside-worktree effects | `unconfined_explicit_full`; `exposed_to_commands` |
| `full` (web and `aiboard exec`, OD-3) | full | Full: everything is approved except protected locations, and network tools under `network: deny` | unconfined | `unconfined_explicit_full`; `exposed_to_commands` |

Why running commands needs a Full binding:
- Non-full profiles resolve to `contained_workload` (execution-lifecycle-policy.ts:44-53). Without an attested provider, that gives `isolation_capability_unavailable`. Only `full` gives `unconfined_explicit_full` (execution-isolation-provider.ts:347-362).
- A provider qualifies only with `write_confinement: "enforced"` (:939-958).
  - The Windows Job backend reports `"unavailable"` (windows-process-backend.ts:95-105).
  - Providers are OCI-only, and the default list is empty (runner-capabilities-config.ts:80-98).
- The failure surfaces per command (one-shot-command-executor.ts:191), so `workspace_contained` is checked at admission against the configured providers and attested in `preparing`.

Why `read_only` binds Full:
- It lets the Runner's own git, repo maps and code navigation work. Even `fs.list` and `fs.search` need it, because they run git through RepositoryIntelligence (repository-intelligence.ts:97-128).
- Its broker registers only the inspection surface. This is the existing pattern: grants follow the binding profile, while the approval policy is guarded (tool-broker.ts:433-435; `createInspectionTools`, native-verifier-runtime.ts:1020-1027).
- A task's binding is fixed at preparation and never switches.

**What unconfined commands can reach.** At `workspace_unconfined` and `full`, task commands run as the OS user, and the worktree sits inside the Runner's state directory. A command can:
- read `state/storage-key` and the encrypted credential stores it unlocks, including the credential-stores-v2 provider envelope, which hold every provider API key of the project (storage-key.ts:19-24; credential-migration.ts:70-72, :113-121);
- read `state/launcher-control.key` (launcher-instance.ts:393, :399);
- obtain a pairing code, in either of two ways:
  - sign a `pair` request with that key (launcher-ipc.ts:140-143);
  - run `aiboard start --no-open`, which registers a fresh pairing ticket for the running Runner (launcher.ts:519);
- exchange the code at `/v1/local-pair/exchange` for a session that is valid on every `/v2` route (control-server.ts:360, :384-390, :444-471).

So at these levels, approvals and budgets bind Runner tools and cooperating callers, not the delegated model.
- Any same-user process, including the caller's own shell, can approve web approvals. That is a stated limit of the threat model.
- The same holds for `aiboard exec` tasks. In both, a command can also read the AIBoard home's credentials and their key (§5.8). This is the exposure the owner accepted by giving delegates the web's choices (OD-2, OD-3), and the same one `codex exec` or `claude -p` have with their own credentials when run without a sandbox. The web and `aiboard exec` both state it before the first model call.
- A real fix needs OS-level containment (Remote S2).

**Network.**
- `access.network` governs Runner network tools only (`effective.networkEnforcement: "runner_tools_only"`).
  - Under `deny`, the default, `research.fetch` and `browser.*` are refused whatever the approvals mode. Under `ask`, they go to the approvals mode.
  - The only exception is `workspace_contained` with a provider whose `allowNetwork` is false, which reports `contained`.
- `process.run` declares only `external: true` and its working directory (process-tools.ts:139-143).
- **Provider-hosted tools.** A runtime's `hostedTools` (provider-config-store.ts:32) are sent on every request (openai-compatible-model.ts:230-237).
  - They are stripped from every per-task runtime clone in v1, so `effective.providerHostedTools` is always empty. Allowing them is later work.

**Protected locations.**
- Every task broker carries the S1a guard: the parent broker, read-only subagents and managed tools (protected-locations.ts:94-126 and the categories after it). It covers:
  - the state directory, the AIBoard data root and the device key;
  - the AIBoard home's `config.json`, `credentials.json` and lock, and the home key. On POSIX all of `~/.aiboard` is protected already, and on Windows the key sits in the protected data root (protected-locations.ts:115-136 *(3903fc46)*). HM1 adds the home's files on Windows, and `AIBOARD_HOME` wherever it points;
  - extension secrets;
  - `~/.ssh` and OS credential stores;
  - browser profiles and cloud credentials.
- Today the broker applies the guard only to `fs.*` and `image.inspect` (`REMOTE_GUARDED_FILE_TOOLS`, tool-broker.ts:102-104, :567), and only for `remote` and `local_mcp` actors (:568).
  - Other path-taking tools resolve paths against the workspace, and absolute and `..` paths are allowed (code-intelligence-tools.ts:133-136, :239-241).
  - Under a `full` broker, an outside path needs no approval (tool-broker.ts:303-311).
- SB4a changes four things:
  - **The broker.** The check applies whenever a guard is passed, to every path-taking tool: `fs.*`, `image.inspect`, `repo.*`, `code.*` and the hidden `openrouter.apply_patch`. Build passes no guard, so Build is otherwise unchanged; SB4a confirms that only `remote` and `local_mcp` pass one today. Build does get HM1's fixed deny of the home's secret files, which every broker applies (§5.8).
  - **The guard.** RemotePathGuard is a pure deny-list (remote-path-guard.ts:174-215), and the task worktree sits inside both the state directory and the data root.
    - So the guard gains an exemption option, for example `exemptDirectories`. It is canonicalized and identity-pinned when the guard is built, and checked after canonicalization.
    - It keeps denying any protected location nested inside the exemption or reached through a link out of it.
    - The hardlink identity scan skips the exempt subtree (:340-378).
  - **The carve-out** is exactly the task's own worktree: `state/workspaces/<runSegment>/<workspaceSegment>` for web tasks (workspace-manager.ts:90-94, :426-427), and the matching path under `state/x/<shortId>/` for `aiboard exec` tasks. Sibling tasks' worktrees, the exec task's lock, store and result, and the AIBoard home's files and key stay protected, and so do: `state/builds/<segment>`, which holds `subprocess-runtime.key`; `state/git-baselines`; the workspace-owner records; and the integration worktree.
  - **One guard object** is shared by the broker, the filesystem tools (filesystem-tools.ts:97-108) and the image tools (image-tools.ts:110). A new `pathGuard` option threads it into `createSubagentTools` and ManagedBuildToolRuntime, which build their own brokers and image tools with no guard today (subagent-tools.ts:170-180, :205).
- A protected hit is refused, never routed to approvals, and leaves no permission row.
- The guard covers Runner tools only. It cannot stop an unconfined command.
- **Comparison with the local MCP door.** The door also pairs a Full binding with a project broker (runner-start.ts:499-502; remote-tool-runtime.ts:374-376, :388, :474-475). It adds three things on top (remote-tool-runtime.ts:387, :468; :618, :624; :601, :622):
  - the S1a guard;
  - argument confinement;
  - the device policy.

  Tasks adopt the guard for every principal. The device policy belongs to the local MCP door and Remote, and does not apply to `aiboard exec`, which a caller runs under its own permissions like any other CLI.

### 8.2 Headless policy
- **Two tiers.** Under a Project broker, every `process.run` (effect `external`), every delete and every network call needs approval (tool-broker.ts:303-311; process-tools.ts:133-143). With a plain `deny`, the default level could run no command at all. So SoloApprovalPolicy has two tiers (§8.3):
  - tier 1 approves without asking: a call whose paths and working directory are all inside the task's worktree and that changes no credentials, and `research.fetch` and `browser.*` under `network: allow`. The local MCP door already approves this way (`approve: !request.outsideWorkspace`, remote-tool-runtime.ts:388-390);
  - everything else goes to tier 2, the approvals mode: `ui` on the web, `deny` for `aiboard exec`.
- **`deny`**, the only tier-2 mode of `aiboard exec`, refuses an approval-requiring call at once. It records the denial with a hint for the caller, such as "allowed with `--access full`" or "allowed with `--network allow`". The model sees an ordinary refusal. Under `full` almost nothing needs approval: only protected locations are refused, and those are never approvable.
- **Repeated denials.** A model that keeps retrying denied calls is already stopped.
  - Denied calls count as unproductive turns (agent-loop.ts:926-947).
  - SB4a passes `readOnlyStall` explicitly (§4.2 step 8), so for `solo:task` the stall guard reminds at 12 turns and suspends at 20 (:1028-1059). It never relies on the worker default, which differs between the option check (12/20, :196-199) and the guard itself (8/16, :1028-1031).
  - The task reports that as `paused` with `stalled`.
  - The stall guard does not catch a model that loops on shell reads: any successful `process.run` counts as progress, and a non-zero exit is not an error (agent-loop.ts:940-942; process-tools.ts:386 *(3903fc46)*). Claude reads and searches through `bash`, so for Claude the turn and budget limits are what stop such a loop.
- Denials are listed in `permissionDenials` and block `apply_if_clean`.
- **`ui`**, the web default, posts approvals to the task's Needs-you dock.
  - **Approvals-viewer heartbeat.** The web does not poll the Runner outside a live run. The launcher's own health check calls GET `/v2/health` with the Runner token (launcher-ipc.ts:337-356). So ordinary requests prove nothing about whether anyone can see an approval. Instead:
    - SB8's session view polls GET `/v2/tasks/approvals` at most every 20 s while its tab is visible;
    - the Runner stamps the viewer time only on that route, and only for a request with an allowed browser Origin or a paired local session. The health check never calls it.
  - Admission refuses `ui` with `approvals_unavailable` unless the stamp is under 60 s old.
    - A `web` admission that carries an allowed browser Origin counts as a fresh stamp, because the web opens the task's session view next, and that view polls.
  - If the stamp lapses while an approval is pending, the policy may deny it early, with reason `approvals_unavailable`. So approvals are posted only while the web shows them.
- Callers' models never answer approvals in v1 (OD-4). A caller that wants fewer denials picks a wider `--access` or `--network allow`, as it would pick a sandbox mode for `codex exec`.

### 8.3 SoloApprovalPolicy: one permissions object, with deadlines and abort
- **One object for every broker.** SoloApprovalPolicy implements the permissions interface (`requestTool`) and captures the task's AbortSignal and deadline when it is constructed. It is the only permissions object handed to the worker tool surface, to `createSubagentTools` and to ManagedBuildToolRuntime.
  - The read-only subagent broker and ManagedBuildToolRuntime call `options.permissions.requestTool` directly, and a read-only subagent always registers `research.fetch`.
  - Being that object is what gives every broker the deny mode, the deadline and the abort.
  - Both option types are the concrete SqlitePermissionStore class today (subagent-tools.ts:78; worker-runtime.ts:119). SB4a widens them to a narrow `requestTool` interface, keeping Build's default.
- **Tier 1 first.** `requestTool` approves tier-1 calls at once (§8.2) and sends only the rest to the approvals mode.
- At `read_only`, it refuses, and never asks about, any tool that is not `readOnly`.
- **Deadlines and abort.** The broker's approve callback has no signal (tool-broker.ts:325-336), and `SqlitePermissionStore.request` waits forever (permission-store.ts:71-94). The policy races three outcomes:
  - the decision;
  - a deadline anchored to the stored `occurredAt` (default 10 minutes, maximum 60);
  - the task's `AbortSignal`.
- **On a timeout or abort,** it calls `decide({ decision: "denied", idempotencyKey: "timeout:<id>" | "cancel:<id>" })`.
  - `decide` is idempotent for the same key and decision; otherwise it throws "already has a different decision" (permission-store.ts:112-140).
  - The wrapper catches that and re-reads, so the first committed decision wins.
  - The broker then returns `permission_denied` (tool-broker.ts:337-343).
- **What the row stores.** The permission row stores the tool name, actor, profile, the access summary (capability, paths, flags) and `outsideWorkspace`, but not the call arguments. The task journal keeps only the argument summary that the approval display needs, such as the command text.
- On restart, the reconciler denies pending rows with `restart:<id>`.

## 9. Models, effort, credentials

**The AIBoard home** (owner decision, 2026-11-11). AIBoard is a CLI tool, and the browser is its GUI. So the user's settings and keys live in one per-user folder, `~/.aiboard` (§5.8). The web edits it through a connected Runner, the CLI edits it directly (§6.6), and `aiboard exec` reads it in any project folder, linked git worktrees included. This replaces the browser-held keys for every surface.
- **Why the browser store cannot serve.** It is IndexedDB, or a folder whose handle is kept in that browser's IndexedDB (lib/client/storage-adapter.ts:58, :598-619 *(3903fc46)*). Each browser therefore has its own settings, and no other process can read them.
- **What moves to the home:**
  - provider keys, base URLs, enabled models and default models (`ProviderKey`, lib/db/schema.ts:371-399);
  - custom models and their keys (:472-499);
  - the `UserSettings` fields that `HomeSettingsV1` names (§5.8): defaults, pricing, context and metadata overrides, discovered model metadata, capability evidence and profiles, the remote MCP server (its token goes to the credentials) and OpenAI file search;
  - the OpenAI connection mode;
  - the new `aiboard exec` defaults (from DX1).
- **What stays in the browser store:** discussions, messages, attachments, Build files and checkpoints, context blobs, Build memories, benchmark records and model stats (lib/client/store.ts:71-101 *(3903fc46)*), the Storage tab's choice of where they live, and the per-browser Runner connections (§5.8). Moving history out of the browser is later work (NX17).
- **What goes:** the passphrase encryption of the browser store (lib/client/crypto-box.ts; components/StorageSettings.tsx:31-125; the Security tab, app/settings/settings-client.tsx:461-500) (OD-27). A store that is encrypted today is unlocked one last time and, after the user confirms, saved without encryption (OD-28).

**How each surface reaches models.**

| Surface | Today | With the home |
|---|---|---|
| Web Settings | Reads and writes the browser store (lib/client/settings-api.ts:176, :1160, :1285) | Reads GET `/v2/home` from a connected Runner and saves through it (§6.1, §6.2). With no Runner connected, it says to start `aiboard` in a project folder. |
| Chat, panel, debate, specialist | The browser streams from the provider, with a key from the browser store (lib/client/engine.ts:477) | The same engines stream through the Runner's model proxy, which adds the key; every provider client takes its address and key from one resolver (below) |
| Runner Chat with tools | The web pushes a config with the key on every turn (lib/client/runner-chat.ts:35) | The pushed config carries no secret; the Runner fills it from the home |
| Build, ToolBench, WorkBench | The web pushes configs with secrets (lib/client/native-build-engine.ts:228, :590, :602) | The same pushes, without secrets |
| Certified benchmarks, Capability Lab, key validation, model discovery | Browser calls with the stored key (lib/benchmark/certified/model-call.ts:217; lib/client/capability-api.ts:413; lib/client/settings-api.ts:397, :678, :1082) | Through the model proxy |
| `aiboard exec` | No models | Reads the home directly (below) |
| ChatGPT and Copilot (account-backed) | The launcher hands the page the account peer's address and token (lib/client/settings-api.ts:160-170; lib/client/providers.ts:86-127; lib/client/local-runner-handoff.ts:209) | Unchanged: the page and its pushes take the peer's address and token from the launcher at call time; the home stores no credential for them (OD-32) |
| NVIDIA NIM | Through the account peer, with the NVIDIA key in each request body, because browsers cannot call its API (lib/providers/provider-registry.ts:381-400; lib/providers/account-runner.ts:187-207; lib/providers/runner-capabilities.ts:180-187) | An OpenAI-compatible provider behind the model proxy, called by the Runner directly in Build; the account peer is no longer involved (OD-32) |

All dated *(3903fc46)*.

**The model proxy** (HM3, HM4a). Every browser model call needs a key, and moving each engine into the Runner would rewrite all of them. So the Runner forwards the calls and adds the key (OD-29).
- **Its own port.** The proxy listens on a second loopback port with the same allowed origins. Chrome allows six HTTP/1.1 connections per host and port, shared by every tab, and a proxied stream holds one for its whole length. On the control port, two tabs and a four-model benchmark would leave approvals and cancels queued with no sign (lib/client/runner-v2.ts:1796; lib/benchmark/certified/run-execution.ts:1006 *(3903fc46)*). On their own port, streams past six wait in the browser and nothing else does.
- **Proxy token.** POST `/v2/home/proxy-session` on the control port returns `{token, proxyBaseUrl, expiresAt}`. The token is 32 random bytes held in the Runner's memory, valid only on the proxy port and only for `/v2/model-proxy/*`. A token that leaks into SDK logs can spend from the user's keys, but cannot run a command or read a file.
  - There is one token per paired session. A new POST replaces it, and the old one stops working 60 s later, so streams in flight can finish. A token expires after 12 h; the page asks again on a 401 `proxy_token_expired`.
  - Revoking a paired session revokes its token. `LocalPairing.revoke` only deletes a hash today (local-pairing.ts:93 *(3903fc46)*), so HM3 adds a revoke hook.
  - A manual connection, which authenticates with the Runner token and has no paired session, gets a token that lives as long as the Runner.
  - The page always reaches the proxy through the launcher's connection (`getLauncherConnection`, lib/client/local-runner-handoff.ts:264), never through a discussion's saved `runnerUrl`.
- **Browser side: one resolver.** Many provider clients ignore the stored base URL today. A proxy token sent straight to a provider would fail with 401, and leak to a third party.
  - OpenAI's clients pass no base URL (lib/providers/openai.ts:671, :680-684); OpenRouter, DeepSeek, xAI and Meta hardcode theirs (openrouter.ts:7, deepseek.ts:6, xai.ts:21, meta.ts:20); Google's clients take none (google.ts:345, :357); Anthropic's validation drops it (anthropic.ts:801).
  - So HM4a adds `resolveProviderConnection(id) → {baseURL, apiKey, headers}` in lib/client/providers.ts, for a provider id or a custom model id. Every provider client and raw provider fetch goes through it: each provider module's stream and validate clients (Google's through `httpOptions.baseUrl`), `streamCustomChat` (lib/client/providers.ts:437), the catalog fetchers in lib/client/settings-api.ts (for example :535, :562), lib/client/capability-api.ts, lib/benchmark/certified/model-call.ts:215-217 and the discussion engine (lib/client/engine.ts:477, :504).
  - The keyless OpenRouter public catalog (settings-api.ts:390) stays a direct call. ChatGPT and Copilot keep their peer's address (above).
  - A new scripts/test-no-direct-provider-calls.mts fails when code outside the resolver builds a provider SDK client or fetches a provider host.
- **Upstream.** The home fixes it: the provider's saved base URL, else the provider's default from the catalog snapshot (below); for a custom model, its base URL. A request chooses only the path below it.
  - **Paths.** POST, plus GET for model lists, on a per-provider allow-list of the paths AIBoard's own clients call. Anything else gets 404 `proxy_path_refused`. HM3 builds the list from the resolver's call sites: for example `chat/completions`, `responses`, `models` and `embeddings` for OpenAI-compatible providers; `v1/messages`, `v1/messages/count_tokens` and `v1/models` for Anthropic; `v1beta/models`, `:generateContent`, `:streamGenerateContent` and `:countTokens` for Google. HM4a's browser test fails if any call AIBoard makes is refused.
  - **No escape.** The control server decodes path segments (control-server.ts:504 *(3903fc46)*), so the proxy reads the raw request target instead. The upstream URL is the fixed base string plus the raw, undecoded suffix. A suffix containing `..`, `%2e`, `%2f`, `%5c`, `\`, `//` or `@` is refused, and so is a request target in absolute form. Before sending, the Runner checks that the built URL's origin and path prefix equal the base's.
- **Key swap.** The Runner accepts the proxy token only in the header where that provider's SDK puts a key (`Authorization: Bearer`, `x-api-key`, `x-goog-api-key` or `api-key`), never in a query parameter. It compares the token in constant time, strips it, and sets the real key the way that provider expects. Anything else gets 401 and is never forwarded.
- **Headers.** Request headers are allow-listed per provider: content-type, accept, the provider's version and beta headers (`anthropic-version`, `anthropic-beta`), `x-stainless-*`, `x-goog-api-client`, OpenRouter's `HTTP-Referer` and `X-Title` (openrouter.ts:15-18), and idempotency keys. Host, origin, referer, cookie and `sec-*` are never forwarded. Response headers are allow-listed too: content-type, `retry-after`, and the rate-limit and request-id headers that the retry classifiers read.
- **CORS.** The proxy answers preflight itself. The control port allows only `GET, POST, PUT, OPTIONS` with `Authorization, Content-Type` (control-server.ts:1756-1757 *(3903fc46)*), and no route sends Expose-Headers, so the SDKs' own headers would fail there. On the proxy port:
  - Allow-Methods is `GET, POST, OPTIONS`;
  - Allow-Headers echoes only the requested names that are on that provider's allow-list;
  - Expose-Headers names each allowed response header one by one, because CORS has no prefix wildcard;
  - Max-Age is 600; the private-network grant is sent as on the control port (control-server.ts:369); only the allowed origins (the existing `--allow-origin` list) are answered.
- **Transport.**
  - The upstream call uses `node:https` (`node:http` for a loopback custom endpoint) and pipes bytes both ways, unbuffered. The release bundle declares no HTTP client package (scripts/release/bundle-contents.mts:11).
  - It sends `accept-encoding: identity`, so bodies arrive plain and can be scrubbed.
  - It sets no socket or body timeout. The client's abort, forwarded upstream, is the only stop: xAI's SDK already waits 360 s (lib/providers/xai.ts:28), and reasoning calls can be silent for minutes.
  - It passes the upstream status and body through, because the retry classifiers need them. In error bodies it replaces any copy of the real key with the key's hint, keeping a key-length tail between chunks, so a key split across two chunks is still caught. It logs no body.
- **Size.** The request cap counts streamed bytes, so a chunked body with no Content-Length is capped too; past the cap the proxy answers 413 before the upstream gets the rest. The cap is one constant shared with lib/attachments/types.ts, sized for its 8 attachments of 15 MiB (:38-39) after base64, and the composer refuses a larger message before sending.
- **Not connected.** Every model action refuses before it calls: the composer, benchmarks, Capability Lab and validation say "Connect AI Board: run `aiboard` in a project folder (not your home folder)". A plain `aiboard` in the home folder is refused with `project_folder_required` (launcher-instance.ts:112-123). A Runner opened only to change settings holds its folder, so `aiboard exec` there is refused until it stops (OD-22); `aiboard` with no project folder is later work (NX15).
- **Old Runners.** aiboard.me deploys on every push to main (.github/workflows/deploy-aiboard.yml:3-5), while a Runner release is a manual, signed dispatch that each user then installs (.github/workflows/runner-release.yml:15-16). So the web will meet Runners without the home.
  - Health gains `capabilities.home`, `capabilities.modelProxy` and `capabilities.secretlessProviderConfigs`, plus `catalogVersion`. It has three capabilities today (control-server.ts:537-550 *(3903fc46)*).
  - A Runner without them counts as not connected for model calls and settings, and the page says "Update AI Board: run `aiboard update`".
  - The web removes old secrets from its store only after its first successful GET `/v2/home` from a Runner with `capabilities.home`: the provider keys, every custom model's `apiKey`, and the remote MCP server's token. The browser's provider rows go with them, manual account-peer connections included, because a plain `aiboard` launches the peer and hands the page its connection. Until then the old values stay in place, unused.
  - The settings mirror is kept out of persisted memory: `clientStoreForMainPersistence` clones the whole store today (lib/client/store.ts:286-289 *(3903fc46)*).
  - Release order: HM1–HM3 and HM5 ship in a published Runner release before HM4a and HM4b merge to main (§13, §18.3).
- **Testing a key.** The proxy uses only saved keys, so testing a typed key saves it first: the key is stored, then validated through the proxy. A failed test leaves it saved and marked not validated, and says so; the user can correct or remove it. The same holds for an unsaved custom endpoint and for browsing a catalog before saving. Today these flows can test input without saving it (lib/client/settings-api.ts:1082-1145; components/ApiKeyForm.tsx:458, :639 *(3903fc46)*).

**The Runner knows models** (HM2, OD-30). The model catalog, the provider base URLs and transports, pricing, context profiles, and the code that turns a model id into a runtime config all live only in the web today (lib/providers/catalog.ts; lib/providers/provider-registry.ts; lib/providers/pricing.ts; lib/providers/model-context.ts; `createNativeProviderConfig`, lib/client/native-build-engine.ts:602 *(3903fc46)*). A `RunnerProviderConfig` carries pricing and context fields (provider-config-store.ts:14-45). `aiboard exec` and `aiboard models` cannot run web code, and Runner code never imports from `lib/`: the release bundle ships only runner-v2/src and its peer files (scripts/release/bundle-contents.mts:51-60). So:
- `scripts/generate-runner-model-catalog.mts` writes a committed, data-only module, `runner-v2/src/generated/model-catalog.ts`: `export const MODEL_CATALOG_SNAPSHOT = … as const`, plus a `catalogVersion` hash.
  - It carries the catalog entries, each provider's default base URL and transport, pricing and context profiles. Default base URLs are hardcoded in the provider modules or left to the SDKs today, so HM2 first moves them into provider-registry.ts as data.
  - A `--check` mode fails on a stale file. It runs in HM2's tests and in CI.
  - A `.json` file would not do: the bundle ships only git-tracked `.ts`, `.mts`, `.mjs`, `.js` and `.cjs` files, and the closure check, which runs on every pull request that touches runner-v2/src, refuses the import (bundle-contents.mts:51-83; .github/workflows/runner-bundle-closure.yml:8-20 on main).
- Function-valued rules are ported as code, in `runner-v2/src/home-model-policy.ts`: reasoning-effort support, the account API-equivalent pricing rule and `#effort` stripping.
- `resolveHomeRuntime(home, modelId)` builds a `RunnerProviderConfig` from the home and the snapshot. A parity script compares it with `createNativeProviderConfig` for every catalog model, a custom model and a `model#effort` runtime, secrets aside.
- `isHomeModelEnabled` ports the web's enabled-model rule (`getEnabledModels`, lib/client/providers.ts:366) under the same parity script.
- **Model ids.** An id with an unknown provider is refused. Every provider except Azure AI Foundry discovers its models (provider-registry.ts `modelDiscovery`), and the user's models are often not in the static catalog, so for those providers an id that is not in the snapshot is accepted with a warning. `migrateFullModelId` is ported and applied whenever the home is read (§5.8).
- The proxy's default upstreams come from the same snapshot.

**Pushed configs without secrets** (HM3). The web no longer holds keys, so it pushes configs with no `secret`.
- PUT `/v2/provider-configs` (control-server.ts:583-607, :1680-1705 *(3903fc46)*) resolves each config by its runtime id with `resolveHomeRuntime` before `validateProviderConfigs` runs, since that requires a secret (provider-config-store.ts:90-101 *(3903fc46)*).
  - The Runner takes the base URL, transport and protocol from the home and ignores the pushed ones. The native factory sends the secret to whatever `baseUrl` a config carries (native-build-factory.ts:4077-4110), so a pushed URL must never decide where a home key goes.
  - A pushed base URL that differs from the home's is refused with 422 `upstream_mismatch`.
- A filled config is stored with `secretSource: "home"` and no secret. The Runner reads the secret from the home each time it builds a runtime from that config, so a key removed with `aiboard keys remove`, or replaced, takes effect at once in every folder. Secrets already stored for home-backed providers are deleted on the first push after HM3.
- When the home has no key for the provider, the push is refused with 422 `home_key_missing`, naming the provider. A custom model whose endpoint needs no key (Ollama, LM Studio) gets the placeholder secret the web sends today (lib/client/native-build-engine.ts:637), never `home_key_missing`.
- **Configs that take no key from the home pass through as pushed.** ChatGPT and Copilot runtimes keep their pushed peer address and `runnerToken`, taken from the launcher's connection at push time (OD-32). CLI workers, in their own plan, push configs with no key at all (§6.5). The Runner never fills these from the home, never sends them through the proxy, and never refuses them with `home_key_missing`.
- The web already pushes before every Build, Runner Chat turn and benchmark. A Runner that builds runtimes from the home with no push at all is later work (NX16).

**Web tasks.**
- `model.runtimeId` must be a runtime the web pushed to this Runner (provider-config-store.ts:14-40; PUT `/v2/provider-configs`). Otherwise admission refuses with `model_not_configured`, the same check as native-build-factory.ts:3980. The refusal says whether no models were pushed to this Runner, or the id is unknown.
- A runtime that is a CLI worker (§6.5) is refused with `runtime_unsupported`: a task runs AIBoard's own agent loop, which cannot drive a CLI. Tasks run by a CLI are NX7.
- The web pushes the task's model when it admits the task, as a Build start does (lib/client/native-build-engine.ts:228 *(3903fc46)*), now without the secret.

**`aiboard exec` tasks** (owner decision 2026-11-11: models come from settings the user saved before).
- **Usable models.** A model `aiboard exec` can use is enabled by `isHomeModelEnabled`, has a key in the home (or is a custom model whose endpoint needs none), and is not account-backed (OD-18). There is no separate delegation switch: enabling a model is the opt-in (OD-7, OD-31).
- **Selection:**
  - `-m <id>` must be usable. Otherwise exit 29 `model_not_enabled`, naming the usable ids and how to enable more.
  - Without `-m`: the home's `exec.defaultModelId`. If that is unset and exactly one model is usable, that one. If several are, exit 29 `no_default_model`.
  - With no usable model: exit 29 `no_delegate_models`.
  - `aiboard models` lists every enabled model and marks the ones `aiboard exec` can use (§6.6).
- **Unreadable keys.** When the credentials cannot be decrypted (the home key is missing or corrupt), exit 29 `home_unreadable`, saying how to enter the keys again; keys saved on another computer give `home_key_mismatch` (§5.8).
- A key that later fails at the provider surfaces as `provider_auth` (§5.5), with the hint to set it again.
- Environment-variable keys are not read (§16), so a caller's environment can never pick the provider account.

**Effort.**
- The Runner silently maps unknown values to `default` (reasoning-effort.ts:10-21). The task door parses strictly: an unknown value is `invalid_spec` (exit 2 for `aiboard exec`), an unsupported one is `effort_unsupported`.
- The support table is ported from lib/benchmark/model-effort.ts:124, with a parity script.
- Effort goes into a per-task clone of the runtime config and is never written back. The result reports `effortRequested` and `effortSent`. For `aiboard exec`, an omitted `--effort` sends the home's default reasoning effort, or a custom model's own, as `createNativeProviderConfig` does for the web.

**Native tools.** A task's loop gets the same provider-native tools Build gives that model, with the same limits: Anthropic's bash (Claude 4 and later) and text editor (Claude 4.5 and later) through the Anthropic adapter, OpenAI's shell for GPT-6, and `process.run` with persistent shell sessions for others (§12.2 has the exact scope; anthropic-bash-tool.ts:1-8; openai-shell-tool.ts:2-9; shell-session.ts:11-18 *(3903fc46)*). A task is AIBoard's own model loop, which is where those tools belong.

**Credentials.**
- The Runner's per-folder credential stores stay as they are, keyed from a per-state-directory storage key (storage-key.ts:23; runner-start.ts:226-235 *(3903fc46)*; credential-migration.ts:70-72, :113-121). They hold the configs pushed for that folder; a home-backed config is stored with `secretSource: "home"` and no secret (above). `provider-configs.enc` is the legacy file they are migrated from (:284-289).
- The home is per user, under its own key (§5.8). `aiboard exec` never opens a folder's credential stores.
- **Account-backed runtimes** (ChatGPT and Copilot through the account runner). The account runner is a separate peer, launched only by a plain `aiboard` start (launcher.ts:394-397). Web tasks may use it while the peer is live, as Build does, with the peer's address and token from the launcher (OD-32). `aiboard exec` never starts it, so Settings and `aiboard models` mark account-backed models unavailable to it (OD-18).

## 10. Budgets and usage
- **Budget window.** Each task opens a budget window (sqlite-budget-ledger.ts:215) using `BudgetLimits` (budget-ledger.ts:47-55). `continue` opens a fresh window, like Build's fresh window per resume.
- **Enforceability.**
  - budget-enforceability.ts:21-45 is Build-shaped: it refuses only a budgeted run whose USD cap has no time limit. Tasks always have a wall clock, so it would accept every task.
  - SB4a adds a task predicate. When `maxUsd` is set and any selected runtime's cost basis is not priced (input and output pricing present), admission refuses with `budget_unenforceable`, whatever the time limits.
- **Overshoot.** Limits are checked between calls, and `BudgetedAgentModel` reserves output tokens (toolbench-session.ts:222-224). Overshoot is bounded by one model call, and this is disclosed.
  - No tool call runs past the deadline. Build's `process.run` now runs as long as the command's `timeoutMs`, up to 30 minutes, plus a 90 s result grace (process-tools.ts:84, :105, :138 *(3903fc46)*), and the broker uses the larger of that and its 120 s default (tool-broker.ts:135, :424). So SB4a builds the solo surface's process tools with `maximumTimeoutMs` no larger than the task's remaining wall-clock budget, using the existing option rather than a new mode, and aborts in-flight tool calls through the task's AbortSignal when the deadline passes, recording `deadline_exceeded`.
- **Defaults and ceilings.**
  - Defaults: 60 minutes, 300 model calls, no USD cap.
  - `aiboard exec`: the home's optional ceilings (§5.8). An explicit flag above one is refused, never clamped (OD-7); an omitted flag takes it.
- **No cumulative window in v1** (OD-7, revised 2026-11-11). Each `aiboard exec` process is independent, as each `codex exec` is. A loop of delegations is bounded only by the caller and by the per-task limits. A rolling per-user spending window shared by concurrent processes is later work (NX14), if the owner wants one.
- **Usage.** `projectNativeModelUsage` (model-usage-projection.ts:91) fills `usage`. The web folds it into model stats, as for Build workers.

## 11. Lifetime, cancellation, recovery, recursion

### 11.1 Lifetime, capacity and folder locks
- **Web tasks** live in the Runner process. A Runner holds at most 2 running and 16 queued tasks. Beyond that, admission refuses with `capacity_exceeded` (HTTP 429) and creates no task.
- **`aiboard exec` tasks** live in their `aiboard exec` process. It runs exactly one task and exits when the task stops. Nothing it starts outlives it (§11.2). There is no capacity limit across processes, as with `codex exec`; DX2 measures eight concurrent processes in one folder (time, memory, Job hosts, LSP servers) and records the result.
- **Layout.** An exec task's root is `state/x/<shortId>/`, where `shortId` is 10 characters; the public id stays `task_<uuid>` and is mapped inside the root. Windows cannot start a process in a folder longer than 258 characters (windows-path-limits.mjs:22-27, :66), and `state\exec\task_<uuid>` would add 47 characters to every worktree path, leaving only 30 to 40 characters of repository depth on a typical profile. Admission refuses with `windows_path_too_long` (exit 29) before any model call when the task's deepest working directory would pass the limit.
- **Composition.** `aiboard exec` builds what the task needs and nothing else. DX2 moves that part of `startRunner` into a shared helper, `composeTaskExecution`, so both hosts compose it the same way.
  - The helper carries the checks `startRunner` runs today: the Node version, `assertTempDirectoryUsable(tmpdir())` and the deepest-working-directory check (runner-start.ts:172-173; git-run-context.ts:259, computed for the exec layout), the ambient environment snapshot, the shell inventory (runner-start.ts:248), the Git preflight (git-preflight.ts), attestation and protected locations. It calls `executionHost.prepare?.()` right after `createExecutionHost` (execution-host.ts:197, :405-411; runner-start.ts:651), so the Windows host checks run during admission.
  - `aiboard exec` passes these differently: no warm Job spares (`windowsJobSpare.maxSpares: 0`; the Runner keeps up to four, runner-start.ts:249-259 *(3903fc46)*); no credential stores; protected locations computed for the exec root; `ownerTether: true` (§11.2); and an ambient snapshot without git's location variables (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_NAMESPACE`, `GIT_PREFIX`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT` with its `GIT_CONFIG_KEY_*` and `GIT_CONFIG_VALUE_*`). It resolves `-C` with those unset. Run from a git hook, `aiboard exec` would otherwise hand them to every task command, and a model's `git add` would write the user's real index (child-environment.ts:113-120 passes them today).
  - No control server, launcher IPC, pairing, account-runner peer or MCP session manager is started.
  - `aiboard exec` skips the integration worktree: `apply_worktree` uses only the ChangeSet diff and the task branch, so `IntegrationManager.initialize` (integration-manager.ts:623-634) and §12.3 step 4 do not run for it (§12.3).
  - Each task writes its log to `state/x/<shortId>/exec.log`, capped at 10 MiB and rotated once, and `show` names it.
- **One folder: a Runner or `aiboard exec` processes, never both** (OD-22). Several `aiboard exec` processes may share a folder.
  - Today's locks are SQLite write transactions on `state/launcher-<kind>.sqlite`, exclusive by construction (launcher-instance.ts:267-285 *(3903fc46)*). The Runner holds `lifetime` for its whole life when the launcher started it (runner-start.ts:185-196), and the launcher takes `discovery`, for at most 10 s, while it starts or inspects one (launcher-instance.ts:287-297).
  - **The lock primitive.** DX2 adds `tryAcquireLockFile(path)`, because `tryAcquireLock` takes only the `discovery` and `lifetime` kinds (launcher-instance.ts:267) and always opens and closes the file before it locks. On POSIX, closing any descriptor of a file drops every record lock the process holds on it (the code's own warning, :302-304), so a process that probed a lock it already held would silently lose it. The new primitive keeps a process-wide registry of held locks, keyed by canonical path: a path the process already holds returns `held_by_self` without opening the file, and scans skip their own locks. A probe that finds a lock busy retries once after 200 ms before it reports the task as running, because Windows may release a killed process's lock late. Every lock file opens through `sqliteDatabaseLocation` (test/windows-long-paths.test.ts:504-513).
  - **Each `aiboard exec` task holds its own lock**, `state/x/<shortId>/exec.lock`, for the life of the process, and an `active/<shortId>` marker that it creates under `discovery` and removes on a clean exit. Probes therefore cost only the active and crashed tasks, never every task ever run. The OS releases the lock if the process dies; the marker stays and marks a crashed task.
  - **Admission of every writing verb.** A new task, `resume`, `cancel`, `apply`, `discard` and `recover` each run these steps first:
    1. take `discovery` (waiting up to 10 s, else exit 29 `exec_busy`);
    2. probe `lifetime` of this folder's state directory, and of every state directory whose `launcher-project.json` project key is the repository root or lies inside its working tree (launcher-instance.ts:241-243), stopping at a nested `.git`, so linked worktrees and submodules stay independent. A Runner started from a subfolder, for example `aiboard mcp serve` launched from a package folder, is found this way. If any is held, release `discovery` and exit 29 `folder_open_in_runner`, with the message for an MCP-started Runner when its `launcher-instance.json` says `startedBy: "mcp"` (§6.3). That field is new: DX2 adds it where the launcher writes the record (launcher.ts:593-594 *(3903fc46)*), and `readInstance` already accepts fields it does not check (launcher-instance.ts:360-375 *(3903fc46)*), so older launchers still read the record; a record without the field gets the plain message;
    3. refuse with `runner_recovery_pending` (exit 29) when the folder's state has unresolved `handoff/*.apply.json` journals or unfinished Build or task specs (integration-manager.ts:2193-2195, :2303-2311), because exec must never apply on top of a Runner's unfinished apply;
    4. create `state/x/<shortId>/` and take its lock (a new task), or take the named task's lock (any other verb); a held lock means the task is running (exit 2 `invalid_state`, or `cancel`'s request, §11.2); write the `active` marker;
    5. release `discovery`. No step waits on another lock while holding `discovery`.
  - A Runner started with `--state-dir`, or started without the launcher, holds a marker lock in the folder's default state directory as well, so step 2 finds it.
  - **Starting a Runner** (`aiboard`, and `aiboard mcp serve` when it starts one) runs the same check in reverse: while it holds `discovery`, before taking `lifetime`, it probes every `state/x/*` task that has an `active` marker.
    - A held lock is a live `aiboard exec` task. The start refuses with "AI Board delegated tasks are running in this folder: `<ids>`. They exit when done, or stop them with `aiboard exec cancel <id>`; then run `aiboard` again."
    - A free lock with a marker is a crashed task. The start refuses with "A delegated AI Board task stopped without finishing: `<ids>`. Run `aiboard exec recover` in this folder, then run `aiboard` again." Recovery needs its own composition and a cold bind (§11.3), too slow to run inside the 10 s `discovery` window.
  - `discovery` serializes the two checks, so a Runner and an `aiboard exec` can never both pass them.
  - Linked git worktrees are separate folders with their own state (launcher-instance.ts:67-75 *(3903fc46)*), so a Runner on the main checkout never blocks `aiboard exec` in a linked worktree, and the other way round.
- **Shared git repository.** Concurrent tasks share the repository's object store and refs. Every task writes only refs and branches named by its own task id.
  - Reads of the project run with `GIT_OPTIONAL_LOCKS=0`. The git policy refuses that variable from callers and nothing sets it today (git-execution-policy.ts:11-13, :59-77), so `git status` on the project takes `.git/index.lock` and rewrites the user's index. SB2 makes `prepareGitExecutionPolicy` always set it.
  - Automatic maintenance is off. Runner git gets `gc.auto=0` and `maintenance.auto=false` in its fixed config (git-execution-policy.ts:23-28 has neither), because a `git commit` in the integration step can start `gc --auto`, which on POSIX detaches and outlives `aiboard exec`. Task children get `gc.autoDetach=false` and `maintenance.autoDetach=false` through `GIT_CONFIG_COUNT`, so a gc the model starts stays inside the Job (SB2).
  - Retry rule: an idempotent ref or worktree step whose stderr matches "Unable to create '…lock': File exists" or "cannot lock ref" is retried for up to 5 s in total, then fails with git's message. Nothing else is retried.
- **The exec-apply lock.** `apply_worktree` (§7.2) takes `state/launcher-exec-apply.sqlite` with the same primitive, waiting up to 60 s, so two tasks never check and apply patches to the working tree at the same time. The second task's `git apply --check` runs against the tree the first one left, so overlapping edits are refused, not merged. A wait that runs out keeps the task with `handoff.status: "refused"` and the reason.
- **Reading verbs** (`show`, `diff`, `list`, `wait`) never recover, sweep or write. They read the stored result. A task whose stored state is active but whose lock is free is shown as `crashed`, with `aiboard exec recover <id>`. `list` says how many tasks are crashed or expired.

### 11.2 Cancellation
1. Record `cancel_requested`: `cancellation.stop` and `cancellation.effect` are both `pending`.
2. Abort the task signal. That stops the loop and the in-flight provider call, and the approval policy denies anything pending.
3. Stop every owned process, with a 10 s grace period, and verify the stop. Owned processes include managed background processes, persistent shell sessions (kept for 15 minutes while idle, shell-session.ts:27) and aborted one-shot commands.
4. Writing levels: take the snapshot commit through the secret-checked commit (§12.3 step 2), then close the binding.
5. Record the outcome with the Remote enums (remote-admission-store.ts:12-15):
   - `stop`: `stopped` or `unverified`, or `not_applicable` when nothing was running;
   - `effect`: `no_effect`, `known` or `effect_outcome_unknown`.

After cancellation:
- An unverified stop gives `outcome_unknown`, and its snapshot is never offered for apply or export.
- Every other stop, such as a pause or a failure, uses the same order: stop and verify processes, then snapshot, then close the binding.
- A cancelled task with a verified stop and a clean snapshot can still be exported or discarded, with no state change (§5.2).

**`aiboard exec`.**
- **Signals.** Ctrl+C (SIGINT), Ctrl+Break (SIGBREAK, Windows) and SIGTERM (POSIX) run the cancellation above, print the result and exit 130 or 143 (§6.3).
- **A second Ctrl+C** writes a `stopping` marker, skips the waits and exits 130; the task stays active. The next `recover` or `resume` (§11.3) stops and verifies its processes and takes the snapshot. `outcome_unknown` is recorded only when that recovery cannot verify the stop, so a second Ctrl+C never loses the work.
- **SIGHUP** (the console was closed; Windows ends the process about 10 s later): write the `stopping` marker and exit within 5 s.
- **`aiboard exec cancel <id>`** writes `state/x/<shortId>/cancel-request.json`. The owning process checks for it every second and runs the cancellation above. The verb waits up to 30 s, then exits with the task's code, or 28 when the stop was not confirmed in time.
- **The owner tether.** Task processes run under supervisors that are spawned detached and then disconnected and unref'd, on purpose, so that a restarted Runner can adopt them (windows-job-process-host.ts:535, :1827-1831; native-process-backend.ts:246-252; managed-process-supervisor.mjs:62-69). The POSIX supervisor runs in its own session. So a parent-only kill (TerminateProcess of node.exe, a POSIX SIGKILL, a process-group kill) would leave supervisors, Job hosts and workloads running.
  - `aiboard exec` composes its execution host with `ownerTether: true`. The host keeps a channel open to every supervisor for its whole life, with no disconnect or unref. A supervisor that loses the channel kills its Job (Windows) or its process group (POSIX) and records `owner_lost`. This generalizes the retire-on-disconnect path that unclaimed spares already have (managed-process-supervisor.mjs:67-69). The Runner keeps survive-for-adoption.
  - DX2 pins, for each kill kind (a tree kill, a parent-only TerminateProcess, a POSIX SIGKILL and a process-group kill), that no task process remains after 10 s, including a Playwright browser, an LSP server, a persistent shell and a background dev server.
  - What no Job or process group can hold, disclosed in the caller docs: launches through WMI, Task Scheduler or COM; `start` or ShellExecute hand-offs to an app that is already running; a Microsoft Store program started by a descendant, which Windows creates outside the Job (managed-process-job-host.ps1:345-350); Docker and WSL.
- A `continue` or `resume` starts fresh shells, because a shell session's key includes the run and session ids (shell-session.ts:217). No shell state carries across.
- A task command at an unconfined level that clears the environment and runs `aiboard exec` itself starts an independent process that outlives a cancelled parent (§11.4).

### 11.3 Recovery at startup
- **Where the reconciler runs.**
  - It is a second entry in the `reconcileRunnerStartup` list (runner-start.ts:421-433; runner-resource-cleanup.ts:80), with its own `covers` set like `NATIVE_BUILD_RUNTIME_RECOVERY_COVERAGE` (native-build-factory.ts:396-403).
  - It runs before ToolBench and Chat recovery (runner-start.ts:434-439), and before LocalMcpSessions and ControlServer (:499-503).
- **Failure.** A reconciler failure fails startup. `--set-aside-run <id>` is the escape hatch.
- **Remote-only state.** Like Build and Chat, tasks are unavailable in remote-only nested state (`if (!remoteOnly)`, runner-start.ts:421; local-agents-availability.ts:11).
- Each recovered binding runs the full §4.2 step 4 sequence.

| State at stop | After restart |
|---|---|
| queued, preparing, running, awaiting_approval, finishing | `interrupted` (`runner_restarted`). Bindings are recovered, with residue cleanup. Pending approvals are denied with `restart:<id>`. Tool calls with unknown effect are journaled `reconciliation_required`. |
| handing_off (apply) | SB2's public recover-only IntegrationManager method wraps `recoverProjectApply` without the apply path, and returns one of three results:<br>• `landed` → `completed`;<br>• `not_started` (no journal) → back to the resting state, with status `refused` and a reason; never auto-applied;<br>• `unresolved` → `outcome_unknown`. |
| handing_off (discard) | The removal re-runs, which is idempotent; the task becomes `completed`. |
| paused, interrupted, ready_for_handoff | unchanged |

- **Interrupted writing tasks that have a worktree get their snapshot in the reconciler.** After binding recovery, it runs the stop pipeline with no model call: the secret-checked snapshot (§12.3 step 2), ChangeSet, integrate, diffstat and the result. Without this, the edits would sit uncommitted and a handoff would act on a stale or empty ChangeSet (integration-manager.ts:744-751).
  - A task stopped in `finishing` after `finish_task` re-runs the finish pipeline from step 2 instead, and keeps its claim.
  - A secret hit or `snapshotUnavailable` is recorded in the result. Neither fails startup.
- `export_patch` needs no recovery: it is a read, served again on request.
- v1 never resumes model work by itself (OD-8).

**`aiboard exec` tasks.**
- **When.** Recovery never runs on a new task's path, so a caller's new task never pays for an old crash. It runs for the one task named by `resume`, `cancel` or `discard`, and for every crashed task in the folder on `aiboard exec recover [<id>]`. It runs after the admission steps of §11.1, outside `discovery`.
- **Why the Remote rule cannot be copied.** An in-flight `process.run` keeps a durable `backend_observe` effect pending for as long as its process lives (subprocess-runtime.ts:845-849). Lease takeover is refused while any effect is pending (durable-process-store.ts:1940-1941), leases last 300 s (subprocess-runtime.ts:299), and exceptional recovery needs no pending effects plus an approval that `aiboard exec` can never give (:516-520; process-recovery.ts:304, :496). Remote refuses all such residue (remote-tool-runtime.ts:379-385), so a task killed during a command, which is what most caller timeouts do, would never recover. Build tolerates the residue instead (native-build-factory.ts:553-559).
- **Owner-dead proof and authority.** The task's lock is free, and its recorded owner pid and start time no longer exist. Under that proof, while holding the task's lock, recovery:
  1. settles the dead owner's pending effects as `outcome_unknown`, with a new fenced durable mutation;
  2. takes over the leases at once, instead of waiting them out;
  3. terminates what is left with `recoverExceptional`, by backend identity and birth fingerprint, with the lock proof as its authority. No model approval is involved, so deny-only is unchanged;
  4. verifies that nothing is left, then runs the stop pipeline with no model call: the secret-checked snapshot (§12.3 step 2), ChangeSet, diffstat and the result.
- The task becomes `interrupted` with `exec_process_lost` (exit 24). A handoff in progress resolves as in the table above, and an interrupted `apply_worktree` resolves from its journal (§7.2).
- If any step fails, the task becomes `interrupted` with `recovery_blocked`: the worktree is kept, nothing is applied, and `discard` is allowed after an identity-checked stop.
- This changes process ownership and fencing. The §13 rules for such changes apply: fail-closed semantics are never weakened, and DX2 gets an independent review of this part.
- A failure recovering one task is recorded in that task's result and never blocks another task.
- It never touches a task whose lock is held, so a running `aiboard exec` is never disturbed.
- `aiboard exec resume <id>` continues an interrupted task like `continue` (§5.6).

### 11.4 Recursion
- **Depth.**
  - Tasks bind with the caller's depth, so their children run at depth + 1 (execution-host.ts:285).
  - The Runner sets `AIBOARD_MCP_DEPTH` for its children (child-environment.ts:153-154). The door refuses a tool call that tries to set it ("MCP ancestry is Runner-owned", remote-tool-runtime.ts:600).
- **Ancestry.**
  - The Runner also sets `AIBOARD_TASK_ID` in the environment of every task child. SB4a sets it beside `AIBOARD_MCP_DEPTH` (child-environment.ts:154) and refuses it as a tool environment override, as is done for the depth today (:261, :266; remote-tool-runtime.ts:600).
  - `aiboard exec` refuses with `depth_exceeded` when `AIBOARD_TASK_ID` is set, or when `AIBOARD_MCP_DEPTH` is 1 or more, meaning it is a child of any Runner: a task, a Remote session, the local MCP door, or a CLI worker of a Build. The Runner sets the variable on every child it starts (child-environment.ts:99, :153-154 *(3903fc46)*), so `aiboard exec` started inside a CLI worker is refused, and no AIBoard → CLI → AIBoard loop forms. A malformed `AIBOARD_MCP_DEPTH` is refused the same way, failing closed; `parseMcpDepth` throws today, which would surface as a generic exit 1 (child-environment.ts:73-77, :99).
  - The home-writing commands `aiboard config set`, `aiboard keys` and `aiboard models enable|disable` refuse on the same conditions, so a task child cannot rewrite the user's home.
  - `aiboard exec` also refuses a project inside, or containing, the AIBoard data root or the home, with `project_inside_aiboard_state` (exit 29). That keeps a nested `aiboard exec` off its own task's worktree and off a Build worker's worktree, which the lock checks alone would allow, because linked worktrees have their own identity (§11.1).
  - **Session calls.** Only a shell session's first call is a managed launch, where child-environment.ts sets the depth (:154) and refuses forbidden names (:264). A later call's `env` travels inside the frame (shell-session.ts:221-231) and is exported by the in-shell host (shell-session-bash-host.ts:30-31) with no name check (process-tools.ts:307-313 *(3903fc46)*). So SB4a refuses forbidden names before any session call is sent: the `isForbiddenChildEnvironmentName` set, `AIBOARD_MCP_DEPTH`, `AIBOARD_TASK_ID` and `AIBOARD_SESSION_*`. The check sits in process-tools.ts, so Build gets it too.
  - So delegation depth is 1 (OD-12; the 2026-10-15 plan suggested 3 at line 125).
  - `LOCAL_MCP_DEPTH_LIMIT` stays 2 (child-environment.ts:71; local-stdio-mcp.ts:103).
- **This binds cooperating callers only.**
  - The depth is whatever the calling process's environment says.
  - At `workspace_unconfined` and `full`, a task command can clear both variables and run `aiboard exec`. That child runs under its own per-task limits and outlives a cancelled parent (§11.2). Several `aiboard exec` processes may share a folder, so only its per-task limits bound it. This is the same as a Codex task that runs `codex exec` from its shell, and it is disclosed with the unconfined levels (§8.1).
- **Remote sessions.** Until X3, Remote children are kept out by the depth rule (they carry `AIBOARD_MCP_DEPTH=1`, child-environment.ts:99), and a Runner that serves Remote holds its folder's `lifetime` lock, so `aiboard exec` refuses there anyway (§11.1). OD-12 cannot be raised without a Remote D1/X3 decision.

## 12. Completion semantics and checks

### 12.1 Solo prompt
A new `SOLO_KERNEL_INVARIANTS` constant leaves the byte-pinned `RUNNER_KERNEL_INVARIANTS` untouched (agent-prompts.ts:36, :44-50). It says:
- Use native tools for actions.
- Prose, command text and the end of the stream never complete work. Only `finish_task` records the claim.
- The Runner records the diff, commands, evidence and denials next to the claim, and does not grade it.
- Inspect the repository before editing, and preserve unrelated changes.
- `RUNNER_UNTRUSTED_DATA_LINE` (agent-prompts.ts:51-52).

Task rules, taken from the preamble that worked in §2.4:
- Work only in this worktree.
- No new dependencies unless asked. The worktree starts without `node_modules/` and `.env*` (§7.1); restoring the project's own dependencies with its lockfile command (for example `npm ci`) is allowed when a check needs them.
- Run focused checks with `run_evidence_command`; only those count as checks. A job started with `process.start` is not a check, so run a suite you want counted through `run_evidence_command`. Run each check as its own command, not chained with `&&` (§5.4).
- Never weaken or delete tests.
- Do not commit or push.
- Finish with `finish_task`. A blocked or partial finish still lists at least one `notRun` entry.

Project instructions are appended (project-context.ts:22).

### 12.2 Tool surfaces and `finish_task`

| Surface | Tools |
|---|---|
| `solo:task` required | `fs.*`, `code.*`, `artifact.read`, `image.inspect`, read-only git (`status`, `diff`, `log`, `show`, `remotes`), `repo.manifest`, `repo.map`, `search_session_history`, `process.run`, managed `process.start`, `process.read_output`, `process.list` and `process.signal`, `run_evidence_command`, `inspect_evidence`, `finish_task` |
| `solo:task` optional | `research.fetch`, `spawn_readonly_subagent`, managed `process.interact` and `process.write_stdin` behind the same approval, `browser.*`, skills, `recall_project_memory` |
| Excluded | `git.commit`, `git.push`, `spawn_subagent`, `submit_task`, Architect and worker lifecycle tools, memory writes; MCP extension tools off in v1 |
| `solo:inspection` (`read_only`) | the read-only subset plus `finish_task`; no tool, hidden or visible, that is not `readOnly` (no workspace-effect, process or git-write tools); `research.fetch` under `network: ask` behind approval (web), or under `network: allow` without asking (`aiboard exec`), as in §8.1 |

**Why the managed process tools are required.** Claude's `bash` replaces `process.run` and runs every command in one persistent session with no timeout of its own, so a command is capped at 90 s, and past the cap the model is told to start longer jobs with `process.start` (anthropic-bash-tool.ts:15-17, :31-37, :67; shell-session.ts:26; process-tools.ts:310, :315 *(3903fc46)*). Sessions exist only when the surface passes `processRunSupport(managedProcesses, artifacts)`; without it, every bash call returns `session_unavailable` and nothing runs (process-tools.ts:62-69, :308). So the solo surface passes `support: processRunSupport(binding.managedProcesses, artifacts)`, as worker-runtime.ts does, and registers the managed tools that `process.run`'s own description points to (process-tools.ts:113-116; managed-process-tools.ts:58).

**Native tools: the exact scope.** Anthropic's `bash` goes only to Claude 4 and later, and only where a bash can run, which on Windows means Git Bash (anthropic-bash-tool.ts:20-27). Its text editor goes only to Claude 4.5 and later, and only when `fs.read`, `fs.write` and `fs.patch` are all on the surface (anthropic-text-editor.ts:15-19). Both come only through the Anthropic adapter (anthropic-model.ts:167-175), so Claude through OpenRouter or an account runner gets the generic tools. OpenAI's shell tool goes only to GPT-6, through the Responses profile, and also needs a bash (openai-shell-tool.ts:24-26). Other models get shell sessions only when they ask with `shellSession` *(3903fc46)*. Text the model sees names the shell tool it actually has: `bash` for Claude, `shell` for GPT-6, `process.run` otherwise; never a tool that was replaced.

The hidden `openrouter.apply_patch` stays registered, on `worker:task` and `solo:task` only (worker-runtime.ts:207-211; openrouter-apply-patch-tool.ts:61; tool-registry.ts:56).
- It is invisible to the model, so `assertRoleToolSurface`, which checks `broker.definitions()`, cannot see it.
- So test/solo-task-tools.test.ts invokes it on a `solo:inspection` broker and expects `unknown_tool`.

~~~ts
interface FinishTaskInput {
  outcome: "done" | "partial" | "blocked";
  summary: string;                  // <= 4,000 chars
  scope: ValidationScope;           // changed, verified, testsRun[{command, counts}], notRun[{what, why}] (validation-scope.ts:44-53)
  knownIssues?: string[];
  followUps?: string[];
}
~~~
- **Parsing.** `finish_task` uses a task-specific parser that allows an empty scope for outcome `blocked` and for `solo:inspection`. The shared parser refuses an all-empty scope and any run with `selected` 0.
- **Signal.** It emits the existing `submit_task` lifecycle signal with `changeSetId = taskId` (agent-contracts.ts:186-187), as `finish_toolbench` does (toolbench-session.ts:197-199), so the loop is unchanged.
- **Protection.** Its name is protected, so no extension can shadow it.
- **Secret notice.** A file write by any actor that is not `remote` or `local_mcp` gets a notice that `submit_task` will refuse a file that looks like a secret (filesystem-tools.ts:1306-1310; submission-guard.ts:47-55 *(3903fc46)*). Solo surfaces have no `submit_task`, so their notice names `finish_task` and the handoff as what will refuse it, by the same rules. test/solo-task-tools.test.ts pins it.

### 12.3 Finish pipeline
1. **Stop** and verify owned processes (§11.2). An unverified stop ends the pipeline with `outcome_unknown`.
2. **Commit, secret-checked.** Commit through `commitWorkspace` with its `inspectCandidate` hook (workspace-manager.ts:171-183, :376-385). That hook inspects the immutable candidate tree before `commit-tree` runs and the task branch advances.
   - **Model commits are folded back first.** At `workspace_unconfined` and `full`, a command can commit on the task branch itself: the worktree's HEAD is that branch, and "Do not commit" is only a prompt rule. The hook's candidate would then be the model's own commit, and a secret committed and later removed would never show in baseline..candidate.
     - So before every guarded commit, finish or snapshot, the Runner compares the branch tip with the tip it last recorded: the baseline, or its own last snapshot or finish commit.
     - If the tip moved, a new WorkspaceManager method runs `git reset --soft <recordedTip>` behind a compare-and-set. The content stays in the index and the worktree, and only the hook's `commit-tree` can advance the branch.
     - The result reports `changes.replacedModelCommits`.
     - CLI workers, built before SB4b (OD-33), undo a CLI's own commits before the Runner's commit check. SB4b reuses that step as this method if it exists, rather than writing a second one, and the commit still goes through the hook.
   - The inspection is the existing submission secret check on baseline..candidate, as inspectSubmissionTree runs it but without a claim:
     - a name-status inventory;
     - `addedLinesByPath` (submission-guard-git.ts:15-46);
     - `assertSubmissionHasNoSecrets` (submission-guard.ts:24-40), with its filename rules (:60-63).
   - Without a `finish_task` call, the commit is marked as a snapshot. Every stop snapshot goes through the same hook.
   - **On a hit** (only an `assertSubmissionHasNoSecrets` throw counts):
     - nothing is committed. The branch and the working files are unchanged, and the work stays uncommitted in the task's worktree;
     - `commitWorkspace` stages with `git add -A` before the hook. So SB4b adds a default-off option that restores the worktree index on a throw, and Build keeps today's behavior. The staged blobs, the secret among them, stay in the shared object store as unreachable objects until `git gc`;
     - the result records `handoff.status: "refused"` with a redacted `secret_detected` reason, and `changes.branch: null` unless the branch tip equals the baseline;
     - no patch, recipe, export or apply is served.
   - **When no commit is possible.** `commitWorkspace` also refuses for reasons that are not secrets. The result then sets `changes.snapshot: false` and `changes.snapshotUnavailable` to one of:
     - `git_operation_in_progress`: a merge, cherry-pick, revert, rebase or sequencer is in progress;
     - `worktree_branch_changed`: the worktree is on another branch, or detached;
     - `escaped_baseline`: HEAD has left the baseline lineage;
     - `inventory_error`: git failed, or returned malformed output, or an unsupported path or status.

     The task still reaches its paused, cancelled or failed state, and a finish rests in `ready_for_handoff` with status `refused`. The work stays uncommitted and nothing is served; a `continue` can repair the git state. `NoTaskChangesError` only means there is nothing to snapshot.
3. **ChangeSet**, with `evidencePolicy: "optional"` (SB2, OD-5).
4. **Integrate** onto the task's integration branch (integration-manager.ts:723; zero commits is a no-op, :745-753). Web tasks only: `aiboard exec` skips the integration worktree, because `apply_worktree` uses only the ChangeSet diff and the task branch (§11.1).
5. **Diffstat.** `git diff --name-status -z --no-renames` and `git diff --numstat -z --no-renames`, joined by path.
   - They run through the inspection lifecycle (git-run-context.ts:56).
   - The new caller is added to `GIT_FAMILY_MODULES` (test/support/git-caller-audit.ts:5-10).
6. **Not-run detection.** `inspectFinalVerificationExecutionProfile` runs on the clean integration state (final-verification-profile.ts:336), or, for `aiboard exec`, on the task worktree after the step-2 commit, which leaves it clean. It detects categories from package.json scripts and fixes each category's command in `profile.commands` (:369-380).
   - **The match.** An evidence record covers a category when all three hold:
     - its executable and leading arguments equal the category's profile command, optionally followed by extra arguments such as paths or filters. So `npm run test -- src/a.test.ts` covers `npm run test`, and `echo ok` covers nothing;
     - it exited 0;
     - it was recorded after the task's last Runner file-tool write.
   - The match is mechanical, not an assessment: a narrowed command that selects no tests still matches.
   - Each detected category with no matching record becomes a `runner_detected` notRun entry. §7.3 uses this rule. Exit 0 does not: there these entries are only reported (§6.3).
   - Under `checks: runner`, tests and build run here with the exact profile commands (§12.4).
7. **`projectChangedDuringTask`**, against the snapshot taken in `preparing`.
8. **Result.** Compute `unverifiedClaims`, `applyRecipe` and `waitingFor`, then write the result.

`read_only` runs steps 1 and 8 only. It takes no commit, ChangeSet, integration, diffstat or stop snapshot.

### 12.4 Checks

| Mode | What runs |
|---|---|
| `agent` (default, OD-17) | Only what the model recorded with `run_evidence_command` counts as a check. Plain `process.run` goes to `commandsRun`: it is matched against claims, but it is not a check. Detected-but-not-run categories are listed. |
| `runner` (opt-in) | After finish, the Runner runs the detected tests and build categories in a VerificationWorkspace (verification-workspace.ts:80, :136) through `runDeliveryCategory` (delivery-execution.ts:956-1000), which supports only those two.<br>• Detected `runtime_smoke` and `browser` categories stay `runner_detected` notRun entries ("not run in runner mode in v1").<br>• A total cap applies (default 10 minutes).<br>• Refused at `read_only`.<br>• Unconfined at `workspace_unconfined` and `full`. At `workspace_contained` it runs through the task binding's executor, never an internal Full context. |

The full suite never runs by default. Running only affected tests is later work (NX1).

## 13. Packets

Verification rules:
- Each packet is verified with the targeted tests named below, plus `npm run typecheck:runner-v2` for every Runner packet, and `npx tsx scripts/release/test-bundle-closure.mts` for every packet that adds imports in runner-v2/src: CI runs that check on every pull request that touches runner-v2/src (.github/workflows/runner-bundle-closure.yml on main), and it fails on an import the release bundle cannot satisfy (scripts/release/bundle-contents.mts:51-83). Runner code never imports from `lib/`.
- The full `test:runner-v2` suite takes hours (package.json:15). It runs at the three gates (SB9, HM6, DX6), by CI or the owner, never by the lead unasked.
- **Gates do not block.** A gate passes on its listed targeted tests, `npm run typecheck:runner-v2`, root `npx tsc --noEmit` and `npm run lint`, and records "full suite pending (owner or CI)". No owner-only step (§18.3) blocks a later packet.
- **Commands.** One Runner test: `npx tsx --test --test-concurrency=1 runner-v2/test/<name>.test.ts`. One script: `npx tsx scripts/<name>.mts` (or `.tsx`). One Playwright spec: `npx playwright test tests/e2e/<name>.spec.ts` (playwright.config.ts: `testDir: "./tests/e2e"`).
- **Where new tests go.** New `runner-v2/test/*.test.ts` files join `test:runner-v2` through its glob (package.json:15). SB4a's effort parity script, SB8's state script and HM2's catalog parity script are appended to the `test:runner-v2` script. HM4a's and HM4b's new scripts form a new `test:home` npm script, which HM6 runs.
- **SQLite files.** Every new store and lock opens through `sqliteDatabaseLocation`, and so does any `ATTACH`; test/windows-long-paths.test.ts:504-513 fails otherwise. SB3, HM1, DX2 and DX4 run that test.
- **File owners.** A packet that adds or changes a runner-v2/src module so that it imports a mutation-capable `node:fs` API also updates test/filesystem-mutation-routing.test.ts in the same change, and adds a docs/runner-v2/filesystem-owner-review-<date>-<packet>.md record (AGENTS.md:57-64, after the 2026-11-11 edits). This applies at least to SB3, SB4a, SB4b, SB7, HM1, HM5, DX2, DX4 and DX5a.
- **Not Task 12 work.** These packets are not Runner V2 Task 12 / P6 acceptance work, so the bounded-gate mandate that CLAUDE.md and AGENTS.md carried until 2026-11-11 does not order them (OD-16); §17 item 11 replaced it with standing rules. Those rules still bind any change to process ownership or fencing (DX2's owner tether and owner-dead recovery): fail-closed semantics are never weakened, no timeout is raised to make a test pass, and the change gets an independent review.

Sequencing (OD-16, decided 2026-11-11):
- **No gate ordering.** The owner considers Task 12's gates passed. Each packet starts when approved, rebased on current main.
- **Home first** (owner decision, 2026-11-12, OD-33). SB0 and HM1–HM6 come first, built in Claude Code sessions, then the CLI-workers plan; an AIBoard Build with CLI workers then builds SB1–SB9 and DX1–DX6 (§18.1). `aiboard exec` needs HM1, HM2 and HM5, so models can be set up without the web; HM3, HM4a, HM4b and HM6 move the web onto the home. The `aiboard exec` settings are DX1's, not the home packets'.
- **Release order.** HM1–HM3 and HM5 ship in a published Runner release before HM4a or HM4b merges, because a merge to main deploys aiboard.me at once while each user installs Runner releases themselves (§9, "Old Runners"). The Build builds HM4a and HM4b on their branches as usual; the owner orders the release and the merges (§18.3).
- **Delegate needs the shared engine.** DX2–DX5a build on SB1–SB5 and SB7. DX1 needs HM2, HM4b and HM5.

| Id | Title | Depends on | Days | Targeted tests | Acceptance |
|---|---|---|---|---|---|
| SB0 | Owner decisions and doc corrections | — | 1–1.5 | none (docs only) | • §14 answered (done 2026-11-11)<br>• the pre-launch items of §17 confirmed in place, and §17's SB0 items applied in a docs-only change<br>• citations re-audited against current main |
| SB1 | Worker tool-surface extraction, solo surfaces with the managed process tools and `processRunSupport`, `finish_task`, the solo secret notice, solo invariants | — | 2.5–3 | test/role-capabilities.test.ts, test/worker-runtime.test.ts, test/git-caller-audit.test.ts, test/git-caller-routing.test.ts, test/shared-tool-parity.test.ts (its file lists rewritten to name worker-tool-surface.ts and the solo surfaces), test/anthropic-text-editor.test.ts, test/openai-shell-tool.test.ts, test/shell-session-native.test.ts, new test/worker-tool-surface.test.ts, new test/solo-task-tools.test.ts | • `worker:task` byte-identical, including the hidden `apply_patch` and `process.interact`<br>• `solo:inspection` has no tool that is not `readOnly`; the hidden `apply_patch` returns `unknown_tool` there<br>• `read_only` `fs.list`, `fs.search` and `git.status` work with no isolation provider configured<br>• the solo surfaces build from the same factories as Build, with `processRunSupport(` present; no option changes what the process tools do<br>• on `solo:task`, no bash call returns `session_unavailable`<br>• native tools follow §12.2's scope, and the model never sees a replaced tool's name<br>• the solo secret notice names `finish_task`<br>• worker-tool-surface.ts imports neither worker-runtime.ts nor scheduler-store, and joins `GIT_FAMILY_MODULES`, so the git-caller audit still covers the moved registration |
| SB2 | Options: ChangeSet `evidencePolicy`; IntegrationManager `reserveDocsProject` and a public recover-only apply method; baseline `initialize: false`, with the root check first; the user's line-ending settings for tasks. For all Runner git: `GIT_OPTIONAL_LOCKS=0`, automatic maintenance off, and `autoDetach` off for task children | — | 2–3 | test/change-set.test.ts, test/integration-manager.test.ts, test/git-baseline.test.ts, test/git-bootstrap.test.ts, test/git-execution-policy.test.ts | • Build defaults unchanged, apart from the git policy lines<br>• recover-only never applies<br>• `initialize: false` refuses a non-git folder, a non-root path (including a subfolder of an unborn repository) and a no-commit repository, in that order, with typed errors<br>• a refusal writes nothing in the project's working tree, index, HEAD, refs or `.gitignore`; the test compares the bytes of `.git/index`<br>• the root check runs before any init write, in both modes<br>• project reads never take `index.lock`<br>• a Windows fixture (system `core.autocrlf=true`, no `.gitattributes`, one mixed-EOL file, one binary file): with the option, untouched files keep their HEAD blob ids and the diffstat counts only changed lines |
| SB3 | Contracts, store, neutralization | SB0 | 3–3.5 | new test/solo-task-contracts.test.ts, new test/solo-task-store.test.ts (patterned on test/remote-job-store.test.ts), new test/solo-task-import-boundary.test.ts, test/windows-long-paths.test.ts, test/filesystem-mutation-routing.test.ts (one reviewed entry) plus a filesystem-owner review record | • closed schemas for spec, continue, handoff and cancel; omitted fields take the principal's defaults<br>• idempotent admit and 409<br>• every §5.2 row and refusal pinned, including: `handing_off` back to its source or to `ready_for_handoff`; `outcome_unknown` on any unverified stop; a continue's `preparing` failure back to the resting state; discard and verified export on terminal tasks with no state change<br>• sequences survive reopen<br>• payloads encrypted; redaction and neutralization applied before storage<br>• the import boundary pinned for `solo-task-*.ts` and worker-tool-surface.ts, allowing execution-host's second transitive path to scheduler-store (through process-recovery.ts) |
| SB4a | Engine: admission, preparation, `continue`, S1a guard on every path-taking tool with its worktree exemption, SoloApprovalPolicy with its two tiers, effort, budgets with tool calls capped at the deadline, the session-call environment check, capacity, cancellation, checkpoint retention, `AIBOARD_TASK_ID` | SB1–SB3 | 6–7.5 | new test/solo-task-runtime.test.ts, new test/solo-task-approvals.test.ts, new test/model-effort-support.test.ts, new scripts/test-runner-effort-parity.mts (wired into `test:runner-v2`), test/agent-loop.test.ts, test/tool-broker.test.ts (guard applied when passed, to every path-taking tool), test/remote-path-guard.test.ts, test/subagent-tools.test.ts, test/filesystem-tools.test.ts, test/code-intelligence-tools.test.ts, test/child-environment.test.ts, test/shell-session-native.test.ts, test/process-tools.test.ts, test/provider-call-retry.test.ts, test/permission-store.test.ts (unchanged) | • Runner tools leave the user's folder untouched before handoff, including an unborn-HEAD fixture<br>• the guard allows a worktree file, and refuses `state/storage-key`, `subprocess-runtime.key`, a sibling task's worktree, and a symlink or junction from the worktree to `storage-key`<br>• `repo.manifest` on the state directory, a `code.*` read of `~/.ssh`, and a read-only subagent's `fs.read` of `~/.ssh` are refused with no permission row<br>• at `workspace_unconfined` under `deny`: `process.run` and `fs.delete` in the worktree run; `fs.read` of the project root is denied with a hint; `browser.*` under `--network allow` runs<br>• under `network: ask`, a subagent fetch is denied at once under `deny`, and at the deadline and on cancel under `ui`<br>• the approval race is correct<br>• a long command near the deadline is stopped at it with `deadline_exceeded`; no tool call outlives the wall clock<br>• a Claude fixture runs a check over 90 s with `process.start` and reads its exit code<br>• forbidden environment names are refused on a first and on a later session call, in Build too<br>• `continue` resumes the checkpoint in a new session with a fresh window, inherits the spec, reattaches the worktree, and runs the missing steps after an early interrupt<br>• `AIBOARD_TASK_ID` is set for task children and cannot be overridden<br>• `resetsAt` comes only from provider values<br>• a background writer is stopped before the snapshot<br>• `SoloTaskRuntime` runs a task with no Runner composed: only an execution host, stores and a provider config passed in (the `aiboard exec` shape, §4.1)<br>• docs/runner-v2/security.md:26 updated (§17 item 22) |
| SB4b | Finish pipeline: stop, model-commit fold-back (reusing the CLI workers' commit-undo step if it exists, §12.3), secret-checked commit, snapshot outcomes, `changes.committed`, ChangeSet, integrate, diffstat, category matching, runner checks, `projectChangedDuringTask`, `commandsRun` with sources, claim matching, result | SB4a | 3.5–4.5 | new test/solo-task-finish.test.ts, new test/solo-task-diffstat.test.ts, test/workspace-manager.test.ts (fold-back method, index-restore option), test/e2-submission-guard.test.ts, test/submission-added-lines.test.ts, test/git-caller-audit.test.ts, test/git-caller-routing.test.ts | • a result on every stop<br>• an added secret line and a new `.env` file refuse the handoff<br>• a model `git commit` of a key file, and a secret the model committed and then removed, are both caught after the fold-back; `replacedModelCommits` reported<br>• a hit leaves the branch and working files unchanged, and the index restored<br>• a stop mid-rebase, a detached HEAD, and a backslash path on POSIX give `snapshotUnavailable`<br>• `committed` and `snapshot` set as §5.4 says<br>• `commandsRun` records `process.run`, session, native-shell and `process.start` launches with their source; a `process.start` job carries its final code, or null; a claim matched only by a shell-reported code stays unverified; a chained line matches no claim of its parts<br>• the category match pinned: a narrowed test command covers its category, `echo ok` does not<br>• claims matched mechanically, and claim fields neutralized<br>• `read_only` writes nothing |
| SB5 | Recovery and composition | SB4b | 2–2.5 | new test/solo-task-recovery.test.ts, test/runner-resource-cleanup.test.ts, test/recovery-smoke.test.ts, test/static-adapter-policy.test.ts | • the §11.3 table holds<br>• residue cleanup runs<br>• an interrupted writing task has a snapshot, ChangeSet and result before any handoff; one interrupted in `finishing` keeps its claim<br>• never a second apply<br>• an interrupted task re-prepares twice |
| SB6 | HTTP routes, principal rules, live-output owner check, approvals route, capabilities | SB4b | 2–2.5 | new test/control-server-tasks.test.ts, test/control-server.test.ts, test/live-model-output.test.ts | • admission in under 2 s, with no binding<br>• typed 4xx, including `invalid_state`, and 412 for `windows_path_too_long` and the Git codes<br>• `apply` is `web` only<br>• GET `/v2/tasks/approvals` stamps the viewer only for an allowed browser Origin or a paired session, and the launcher health check never stamps it<br>• a `web` admission with an allowed Origin counts as a fresh stamp |
| SB7 | Handoff modes, recipe, retention sweeper, owner methods for worktree-only removal and private refs | SB4b | 3–4 | new test/solo-task-handoff.test.ts, test/integration-manager.test.ts, test/workspace-manager.test.ts | • every refusal reason covered<br>• the recipe is pinned, uses §7.2's flags, and is tested against a dirty baseline and a binary change<br>• kept branches survive the sweeper; worktree-only removal skips a branch checked out elsewhere<br>• the sweeper never removes a worktree with uncommitted changes before a secret-checked snapshot, and keeps it when it cannot take one<br>• terminal writing tasks are swept, and discard works on them<br>• after an apply, the worktree and private refs are gone<br>• idempotent<br>• the web-task sentence of the OD-1 rule lands in the docs (§17) |
| SB8 | Web Simple Build | SB6, SB7 | 4–5 | new scripts/test-simple-build-state.mts (wired into a named npm group), scripts/test-build-live-state.mts, scripts/test-runner-v2-client.mts, scripts/test-build-activity-layout.mts, scripts/test-build-ui-overhaul.mts, scripts/test-native-build-cutover.mts, scripts/test-native-build-pause-gates.mts, scripts/test-native-build-steering-ui.tsx, scripts/test-build-skills-panel-removal.mts, scripts/test-build-crew.tsx, `npx tsc --noEmit`, `npm run lint` | • survives reload<br>• facts and claims separated<br>• the access disclosure is shown before the first model call<br>• the session view polls the approvals route while open |
| SB9 | Simple Build gate | SB0–SB8 | 0.5–1 | `npm run typecheck:runner-v2`, root `npx tsc --noEmit`, `npm run lint`, the SB8 web scripts; the full `test:runner-v2` by CI or the owner | green, or fixed forward with targeted reruns |
| HM1 | AIBoard home store: `AiboardHomeV1` with its settings allow-list; `AIBOARD_HOME` and its checks; the home key and `keyId`; encrypted credentials bound to their upstream; `acquireLockFile`; op batches with `pathRevisions` and `home_conflict`; atomic writes with the Windows rename retry; the compatibility rules; the base-URL rule; the fixed broker deny; uninstall paths | SB0 | 2.5–3.5 | new test/aiboard-home-store.test.ts, test/tool-broker.test.ts, test/remote-path-guard.test.ts, test/windows-long-paths.test.ts, test/filesystem-mutation-routing.test.ts (one reviewed entry) plus a filesystem-owner review record | • round-trips; a missing or corrupt key gives `home_unreadable` and a different `keyId` gives `home_key_mismatch`, never a partial read; a mismatch refuses writes to the credentials<br>• two writers changing different sections, two entries of one map included, both land; a stale `baseRevision` on the same section gets `home_conflict`; a reader never sees a torn file<br>• a test that pauses between the two renames never pairs a key with a new upstream<br>• a canary secret in every string field of UserSettings, ProviderKey and CustomModel never reaches `config.json`; a UserSettings field in neither list fails the test<br>• unknown fields survive a write; a newer `contractVersion` refuses writes with `home_newer`<br>• a relative or unsafe `AIBOARD_HOME` is refused<br>• changing a base URL removes that key<br>• a Build worker's and a remote actor's read of `credentials.json` or the home key, and a write to `config.json`, are refused, through symlinks and junctions too, on Windows and POSIX<br>• `userStatePaths` lists the home's files |
| HM2 | The Runner knows models: provider base URLs and transports as data in provider-registry.ts; the committed catalog snapshot module with `--check`; `home-model-policy.ts`; `resolveHomeRuntime`, `isHomeModelEnabled`, the model-id rules and `migrateFullModelId`; default upstreams; parity scripts | HM1 | 3.5–5 | new test/home-runtime.test.ts, `npx tsx scripts/generate-runner-model-catalog.mts --check`, new scripts/test-runner-model-catalog-parity.mts (appended to `test:runner-v2`), `npx tsc --noEmit` | • the snapshot equals the web's catalog, provider registry, pricing and context profiles; `--check` fails on a stale file<br>• `resolveHomeRuntime` equals `createNativeProviderConfig` for every catalog model, a custom model and a `model#effort` runtime, secrets aside, pricing and context included<br>• the enabled rule equals `getEnabledModels` on fixtures<br>• an unknown provider is refused; an id that a discovering provider has but the snapshot lacks is accepted with a warning; renamed ids migrate on read<br>• the bundle closure check passes |
| HM3 | Runner routes: GET and POST `/v2/home`, the credential routes, the health capabilities, proxy sessions and their lifetime, the model proxy on its own port (path and header allow-lists, raw-path checks, CORS, transport, size cap, scrubbing), pushed configs resolved from the home, and configs that take no key from the home passed through as pushed | HM2 | 4.5–6.5 | new test/control-server-home.test.ts, new test/model-proxy.test.ts, test/control-server.test.ts | • GET never returns a secret; a canary secret in the home appears in no response<br>• POST batches apply all or nothing; two clients editing different entries of one map both land; a stale `baseRevision` on one section gets 409<br>• the proxy sets each provider's key in its own header; a missing, wrong or expired token gets 401 and nothing is forwarded; a token in a query parameter is refused<br>• encoded slashes, dot segments, backslashes, `@` and an absolute-form target never reach any host but the base's; a path off the allow-list gets 404<br>• a recorded preflight from each provider SDK gets a passing answer, and Expose-Headers lists the allowed response headers<br>• SSE streams unbuffered; an upstream silent for 6 minutes is not cut; an abort reaches upstream; an oversized chunked body gets 413 before the upstream sees it; a key split across two chunks is scrubbed<br>• a proxy token is refused on the control port and on every other route, stops working 60 s after it is replaced, and dies with its session<br>• a pushed config with a foreign base URL gets `upstream_mismatch` and never a key; a keyless custom endpoint gets the placeholder; a removed key stops working without a new push<br>• an account-peer config is stored as pushed, never filled from the home and never refused with `home_key_missing`<br>• health reports the new capabilities |
| HM4a | Browser model calls through the proxy: `resolveProviderConnection` and every call site, Google's base URL included; NVIDIA as an OpenAI-compatible provider behind the proxy; the old-Runner check; "connect first" refusals; pushes without secrets; the size cap shared with attachments | HM3 | 4–5.5 | new scripts/test-model-proxy-client.mts, new scripts/test-no-direct-provider-calls.mts, scripts/test-runner-v2-client.mts, `npm run test:chat`, scripts/test-nvidia-provider-settings.mts, new tests/e2e/model-proxy.spec.ts, `npx tsc --noEmit`, `npm run lint` | • no provider SDK client or provider fetch outside the resolver<br>• with no Runner, or one without `capabilities.home`, every model action refuses before a call and names the fix<br>• in a real browser on the dev origin, against a real Runner and a stub upstream: one streamed call per provider SDK completes, and an approval and a cancel still go through while two tabs and a four-model certified run stream<br>• NVIDIA chat, catalog and validation work with no key in the browser; ChatGPT and Copilot work after a Runner restart<br>• Build, Runner Chat and benchmark pushes carry no secret |
| HM4b | Settings on the home: the mirror kept out of persistence, and `homeReady`; Settings connected, not connected and update states; every settings writer as an awaited batch with conflict retry; key entry with test-saves-first; import and export without keys; the Security tab; passphrase removal with the confirmed last unlock; removing old secrets after the first home read | HM4a | 4–5.5 | new scripts/test-settings-home.mts, scripts/test-openai-provider-settings.mts, scripts/test-capability-lab-settings-placement.mts, scripts/test-storage-settings-import.mts (rewritten: it pins today's key merge), scripts/test-store-write-serialization.mts, scripts/test-split-discussion-storage.mts, tests/e2e/model-proxy.spec.ts extended with one settings save, `npx tsc --noEmit`, `npm run lint` | • after the first GET from a home-capable Runner, the browser store holds no provider key, custom-model key or remote MCP token, and the Runner connection tokens stay; before it, nothing is deleted<br>• no settings write is sent before the first GET completes<br>• no code outside the home client writes a settings field of the store<br>• two tabs editing different entries of one map both keep their edits; a same-section conflict retries once on fresh data<br>• a failed save shows an error and reverts<br>• import skips keys and says how to set them; export has none<br>• an encrypted store opens once with its passphrase and is saved plain only after the user confirms; a declined picked folder stays untouched |
| HM5 | CLI: `aiboard config`, `aiboard keys` (set, remove, reset), `aiboard models`; the `exec.*` keys and marks come with DX1 | HM2 | 1.5–2 | new test/home-cli.test.ts, test/local-launcher.test.ts, test/static-adapter-policy.test.ts | • a key on argv is refused; the prompt echoes nothing (tested with a fake TTY stream); a stdin that is not a terminal is read only with `--stdin`; a BOM and a trailing CR or LF are stripped<br>• writes take the lock and never drop a concurrent web edit<br>• `config set defaults.reasoningEffort` maps, converts and validates as in §6.6<br>• the home-writing commands refuse under `AIBOARD_TASK_ID` or a Runner depth (§11.4)<br>• a canary secret in the home never appears in `aiboard config` output; no secret in argv, stdout, stderr or logs<br>• the manual terminal check of §18.3 is listed as pending |
| HM6 | Home gate and docs (§17 items 7–10, 23, and the HM6 parts of 17 and 18) | HM1–HM5 | 1 | `npm run typecheck:runner-v2`, root `npx tsc --noEmit`, `npm run lint`, `npm run test:home`, tests/e2e/model-proxy.spec.ts; the full `test:runner-v2` by CI or the owner | green, or fixed forward; no page or doc still says keys stay in the browser |
| DX1 | `aiboard exec` model selection from the home: usable models, the default and the one-model fallback, ceilings, the effort default, and the refusals `no_delegate_models`, `model_not_enabled`, `no_default_model`, `home_unreadable` and `home_key_mismatch`; the exec settings moved here from the home packets (OD-33): the home's `exec` section and its op path, `capabilities.execSettings`, the four `aiboard config exec.*` keys, the exec marks in `aiboard models`, and the Settings > Defaults "`aiboard exec`" group | HM2, HM4b, HM5 | 1.5–2 | new test/solo-task-exec-models.test.ts, test/aiboard-home-store.test.ts, test/control-server-home.test.ts, test/home-cli.test.ts, scripts/test-settings-home.mts, `npx tsc --noEmit`, `npm run lint` | • every selection rule of §9 pinned<br>• account-backed models never selected<br>• a folder AIBoard never opened and a linked worktree see the same models<br>• `aiboard exec` reads the home once and never writes it<br>• the `exec` section round-trips; a writer that predates it keeps it verbatim; the web shows the Defaults group only with `capabilities.execSettings`<br>• the four `exec.*` keys map, convert and validate as in §6.6<br>• `aiboard models` marks account-backed models unavailable to `aiboard exec` |
| DX2 | Exec task host: `composeTaskExecution` shared with `startRunner` (its checks, `prepare()`, the shell inventory; no spares, no credential stores, git's location variables stripped); the `state/x/<shortId>/` layout and its path check; `tryAcquireLockFile` and the `active` markers; the admission steps for every writing verb, with the ancestor probe, `startedBy` in the launcher's instance record, `runner_recovery_pending` and the Runner-side reverse check; the owner tether; owner-dead recovery and `recover`; `gc.autoDetach` off for task children; the exec key; logs | SB5, SB7, DX1 | 6–8 | new test/solo-task-exec-host.test.ts, new test/solo-task-exec-recovery.test.ts, test/local-launcher.test.ts, test/runner-resource-cleanup.test.ts, test/recovery-smoke.test.ts, test/windows-long-paths.test.ts, test/execution-host-prepare.test.ts, test/durable-process-store.test.ts, test/subprocess-runtime.test.ts, test/filesystem-mutation-routing.test.ts (reviewed entries) plus a filesystem-owner review record | • a task runs with no Runner, control server or launcher IPC<br>• `folder_open_in_runner` while a Runner holds the folder, including one started from a subfolder, with `--state-dir`, or by `aiboard mcp serve` (with its own message); a Runner start refuses while an exec task runs or a crashed one waits, and names them; the discovery lock decides a race either way<br>• every writing verb runs the admission steps; reading verbs never recover, sweep or write<br>• two concurrent exec tasks in one folder finish on separate branches; eight concurrent tasks are measured and recorded<br>• for each kill kind (tree kill, parent-only TerminateProcess, POSIX SIGKILL, process-group kill), no task process remains after 10 s, including a Playwright browser, an LSP server, a persistent shell and a background dev server<br>• after a kill during `process.run`, during a `process.start` dev server and during a Claude bash session, `aiboard exec recover` and then `resume <id>` succeed; a failed recovery step gives `recovery_blocked`<br>• a POSIX process that probes a lock it holds keeps it, and another process still cannot take it<br>• a long simulated LOCALAPPDATA gives `windows_path_too_long` before any model call<br>• with `GIT_INDEX_FILE` pointing at a scratch index, a model's `git add -A` leaves that index unchanged<br>• a loop of `git add` and `git commit` in the project during a read-only and a writing task never hits `index.lock`<br>• an unresolved Runner apply journal gives `runner_recovery_pending`<br>• a folder AIBoard never opened gets its state directory outside the project, and its storage key is never created<br>• resetting the home key leaves kept tasks readable<br>• the owner tether and owner-dead recovery pass an independent review |
| DX3 | `aiboard exec` CLI: verbs (`cancel`, `wait` and `recover` included), flags (`--deadline`, `--page-bytes`), prompt input, the stderr header and progress, `TaskResultPageV1` paging and ASCII output, exit codes 20–29, signals (SIGBREAK, SIGHUP, the second Ctrl+C), the depth rule, refusal messages, `aiboard status` listing exec tasks | DX2 | 4–5 | new test/solo-task-cli.test.ts, test/local-launcher.test.ts, test/static-adapter-policy.test.ts | • every exit code and refusal message pinned, in §6.3's order<br>• every page parses on its own; with stderr on the same pipe, a 300-call task stays under 30,000 characters; JSON output is ASCII only<br>• a console-signal harness (the child in a new process group, CTRL_BREAK_EVENT sent through PowerShell's `GenerateConsoleCtrlEvent`) cancels with a snapshot; Ctrl+C through the direct-node shim exits 130<br>• a second Ctrl+C leaves a `stopping` marker and loses no work<br>• `cancel` and `wait` exit with the task's code; `wait --timeout` gives 124; `show` on a running task gives 20<br>• a multi-line prompt containing `"`, `&`, `%`, `^`, `!` and a leading `/` arrives byte-identical through `--prompt-file` and stdin in Git Bash, PowerShell and cmd<br>• `AIBOARD_TASK_ID`, or an `AIBOARD_MCP_DEPTH` of 1 or more or malformed, is refused<br>• `-C`, and the repository-root default from a subfolder<br>• `resume`, `show`, `diff --output` and `list` work on stored tasks; `resume`, `apply` and `discard` refuse a running one<br>• no secret in argv, stderr or logs |
| DX4 | Working-tree apply (`apply_worktree`): its conditions, journal and recovery, the shared flags and recipe, untracked paths, the exec-apply lock, and the `aiboard exec` sentence of the OD-1 rule in the docs | DX3, SB7 | 3–4 | new test/solo-task-apply-worktree.test.ts, test/git-caller-audit.test.ts, test/git-caller-routing.test.ts, test/windows-long-paths.test.ts | • applies onto a dirty tree with unrelated edits, binary files included; a non-overlapping edit in the same file is kept, an overlapping one is refused<br>• a paused, failed, interrupted or cancelled task, and a `blocked` outcome, are never applied and stay resumable<br>• refuses, keeps the branch and returns `applyRecipe` on a secret hit or when nothing was committed<br>• a write error and a kill in the middle of an apply are classified from the journal as landed, not started or mixed (exit 28 with the paths)<br>• the recipe and the Runner's check use the same flags; the recipe run from a subfolder covers every file<br>• new files are listed in `untrackedPaths`<br>• two tasks applying at once are serialized; no index, HEAD or commit is written<br>• the §17 task sentence applied |
| DX5a | Caller integration, the Build's part: the Git Bash shim (a `#!/bin/sh` copy of the POSIX shim that execs node.exe), written by `writeShim` and install.ps1 and removed by uninstall; caller docs for Claude Code, Codex and agy (foreground runs with `--deadline`, background runs with `--handoff keep`, permission rules, prompt files on Windows, the kill limits of §11.2); an argv and stdin matrix in Git Bash, PowerShell and cmd against a stub `aiboard.mjs` that echoes what it receives; a lint of every documented command line | DX3 | 2–3 | test/static-adapter-policy.test.ts, scripts/release/test-installers.mts, the matrix test | • every documented line runs in Git Bash, PowerShell and cmd<br>• the shim is installed, updated and uninstalled with the rest<br>• the caller recipes are marked "not yet verified" until DX5b |
| DX5b | Caller verification, the owner's part (§18.3): one real headless run per CLI, Codex's sandbox measured, each caller's output limit and kill behaviour recorded | DX5a | owner | the runs recorded in the docs | each CLI runs `aiboard exec` headless with exactly the documented rules; the recipes lose "not yet verified" |
| DX6 | Delegate gate | DX1–DX4, DX5a | 0.5–1 | `npm run typecheck:runner-v2`, root `npx tsc --noEmit`, `npm run lint`, the DX tests, scripts/test-runner-effort-parity.mts; the full `test:runner-v2` by CI or the owner | green, or fixed forward |

**Totals:** SB0–SB9 = 29.5–38 days; HM1–HM6 = 21–29 days; DX1–DX6 = 17–23 days (DX5b is the owner's); **v1 = 67.5–90 days, about 13.5–18 weeks**.

| Milestone | Content | Days |
|---|---|---|
| Prototype | Lite versions of:<br>• SB1: required tools only (the managed process tools included)<br>• SB2: without the recover-only method<br>• SB3: no paging, tombstones or encryption<br>• SB4a: deny-only approvals with the two tiers as the one permissions object, plus the S1a guard on every path-taking tool, with its worktree exemption<br>• SB4b: model-commit fold-back, commit, secret check, ChangeSet, integrate, diffstat and detection; no runner checks<br>• SB5: restart → `interrupted`, plus binding recovery<br>• SB6: admit, get, events, result, cancel, handoff<br>• SB7: keep and discard only<br>• SB8: toggle, plain result card, Keep/Discard | 12.5–15.5 |
| Simple Build v1 | SB0–SB9 | 29.5–38 |
| AIBoard home | HM1–HM6, after SB0 | +21–29 |
| Delegate v1 | DX1–DX6, after SB5, SB7 and the home | +17–23 |
| Home first (the chosen order, OD-33) | SB0, then HM1–HM6: the AIBoard home, `aiboard config`, `keys` and `models`, and every browser model call through the Runner. Then the CLI-workers plan (its own estimate), then SB1–SB9 and DX1–DX6 (§18.1). | 22–30.5 for SB0 and the home |
| Later | NX1 affected-test runner checks (2), NX2 web apply into a dirty tree (2), NX3 MCP task tools over `aiboard exec` (2), NX5 Remote X3 (3), NX6 ACP (4), NX7 outbound executors (separate plan; needs a vendor-terms decision), NX8 schema-shaped output (1), NX9 opt-in auto-resume of web tasks (1), NX10 terminal approvals for an `aiboard exec` run by a person (1), NX11 image inputs (1), NX12 runner-mode smoke and browser checks (1–2), NX13 the web lists a folder's earlier `aiboard exec` tasks (1), NX14 a per-user spending window across `aiboard exec` processes (1–2), NX15 `aiboard` with no project folder, for Settings and Chat only (1), NX16 a Runner that builds runtimes from the home with no push (2), NX17 history in the home or the Runner, so it follows the user across browsers (3–4), NX18 the Runner owns the model catalog and the web reads it from there (2), NX19 the user's line-ending settings for Build's own git (1) | about 29–32, plus NX7 |

## 14. Owner decisions

Recorded and accepted 2026-11-11. "owner" means the owner chose it in the planning conversation. "accepted" means the plan recommended it and the owner accepted it, with every other row, on 2026-11-11 ("we use those decisions"). Changing a row now is a plan change: update the row, the body and §13 together.

| Id | Question | Decision | Source |
|---|---|---|---|
| OD-1 | Handoff rule | The code's rule wins; the three docs are corrected (§7.5, §17). Web tasks auto-apply only under `apply_if_clean`; `aiboard exec` applies to the working tree by default (OD-23). | owner |
| OD-2 | Access levels and defaults | Four levels. Default `workspace_unconfined` for the web and for `aiboard exec`, disclosed before the first model call. Delegates are never more restricted than the web. | owner |
| OD-3 | Full access for delegates | Allowed: the caller picks any level, Full included, as with Codex's or agy's bypass flags | owner |
| OD-4 | Approvals | Web `ui`, 10 minutes (max 60). `aiboard exec` has no approvals: approval-requiring calls are denied and listed. No caller approvals in v1. | accepted |
| OD-5 | Evidence for tasks | Optional | accepted |
| OD-6 | Models for delegates in other folders and linked worktrees | The per-user AIBoard home, read in every folder (§5.8, §9) | owner (models come from saved settings, in a fixed per-user folder) |
| OD-7 | Limits | No opt-in beyond enabling models. Optional per-task ceilings in Settings, off by default; refuse, never clamp. No cumulative window in v1 (NX14). | owner (limits optional) |
| OD-8 | Restart | Web tasks become `interrupted` on restart (§11.3); never auto-resume | accepted |
| OD-9 | MCP idle expiry | Withdrawn: no MCP task tools | owner (no MCP server) |
| OD-10 | MCP tasks scope | Withdrawn: no MCP task tools | owner (no MCP server) |
| OD-11 | Naming | `aiboard exec` with `resume`, `list`, `show`, `diff`, `apply` and `discard`; models through `aiboard models` (§6.6); ids `task_<uuid>` | owner (like `codex exec`) |
| OD-12 | Delegation depth | 1 (cooperative; §11.4) | accepted |
| OD-13 | Non-git folders and repositories with no commit | Refuse unless `--init-git` | accepted |
| OD-14 | Retention | 7 days; a branch with commits is deleted only by an explicit discard | accepted |
| OD-15 | Detached daemon | Withdrawn: `aiboard exec` needs no daemon | owner (one-shot) |
| OD-16 | Sequencing | No gate ordering. Launching a Build of this plan approves every packet in it; packets follow §18.1 and need no further approval | owner |
| OD-17 | Default checks | `agent` | accepted |
| OD-18 | Account-backed runtimes | Web tasks while the account peer is live; not offered to `aiboard exec` | accepted |
| OD-19 | How a delegate runs | One-shot `aiboard exec`: one task per process, no Runner, web app or MCP server; nothing left running | owner |
| OD-20 | Delegation while Remote is active | Withdrawn: a Remote-serving Runner holds its folder, and Runner children are refused by the depth rule (§11.4) | follows from OD-19 and OD-22 |
| OD-21 | Task store payloads | Encrypt (web store and exec task stores) | accepted |
| OD-22 | A Runner and `aiboard exec` on one folder | Mutually exclusive. `aiboard exec` refuses with "This folder is open in AI Board…"; a Runner start refuses while exec tasks run. Any number of `aiboard exec` processes may share a folder. | owner (the exec side); the Runner side accepted |
| OD-23 | Default `aiboard exec` handoff | `apply_worktree`: apply the patch to the working tree, uncommitted, when it applies cleanly and no secret was found; otherwise keep the branch and return the recipe | owner (apply when clean); working-tree form accepted |
| OD-24 | `-m` omitted | The home's default `aiboard exec` model; with none set, the only usable model; otherwise `no_default_model` | accepted |
| OD-25 | Where settings and keys live | The AIBoard home, `~/.aiboard` (`AIBOARD_HOME` overrides), edited by the web through any connected Runner and by the CLI; its encryption key in the user data root, outside the home (§5.8) | owner (a fixed per-user folder, set from a connected web); the location and key placement accepted |
| OD-26 | Settings already in browsers | Start fresh: nothing is copied, and the old keys are deleted from each browser's store on its first load | owner |
| OD-27 | Passphrase encryption | Removed, for the home and for the browser store | owner |
| OD-28 | A browser store that is encrypted today | Unlocked one last time, then saved without encryption after the user confirms, so its history survives. A picked folder, which may be cloud-synced, is rewritten only after that confirmation; if the user declines, it is left untouched and the page starts a new IndexedDB store. | accepted (the confirmation added in review, 2026-11-11) |
| OD-29 | Browser model calls | Through the Runner: Runner Chat with tools as today, and every other call through the model proxy (§9) | owner (chat goes through the Runner); the proxy accepted |
| OD-30 | Model knowledge in the Runner | A generated catalog snapshot and a ported config builder, both under parity scripts (§9) | accepted |
| OD-31 | A delegation switch per model | None: every enabled model that has a key and is not account-backed is usable by `aiboard exec` | accepted (follows from OD-7 and the owner's "enabled" wording) |
| OD-32 | Account-backed and NVIDIA credentials | ChatGPT and Copilot never use the proxy or the home's credentials: the page and its pushes take the account peer's address and token from the launcher at call time, because the token changes with every launch. NVIDIA NIM becomes an OpenAI-compatible provider behind the model proxy, and the Runner calls it directly in Build; the account peer is no longer involved (§9). | follows from OD-25 and OD-29 (review, 2026-11-11) |
| OD-33 | Build order | Home first: SB0 and HM1–HM6, then the CLI-workers plan, both built in Claude Code sessions. Then an AIBoard Build with CLI workers builds SB1–SB9 and DX1–DX6. The `aiboard exec` settings move from HM1, HM4b and HM5 to DX1, and the guidance for CLI workers is in §6.5 (§18.1). | owner (2026-11-12) |

## 15. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Commands at `workspace_unconfined` and `full` are unconfined. They can read the Runner's state and the AIBoard home's keys, and in the web they can approve their own approvals. | The owner's accepted exposure, as with other CLIs run without a sandbox (OD-2, OD-3). The level's name, the composer and the first stderr line of `aiboard exec` say so. The guard covers Runner tools. Real containment comes later (Remote S2). |
| The home makes the user's API keys usable by any process of the user | Stated in Settings and by `aiboard config`, like `~/.codex/auth.json` for Codex. The key file sits outside the home, so a copied or synced `~/.aiboard` carries no usable key (§5.8). CLI workers are such processes too: they run outside the tool broker, so its fixed deny does not bind them. |
| The model proxy spends the user's keys for whoever holds a proxy token | Tokens are per paired session, held in memory, valid only on the proxy port's routes, replaced on request and expired after 12 h, and revoked with the session. The home fixes the upstream; paths, headers and the raw request target are allow-listed and checked; each key is bound to the upstream it was entered for (§5.8, §9). |
| The web deploys before users update their Runner | Health capabilities: an old Runner counts as not connected, and the page says to run `aiboard update`. Old browser secrets stay until a home-capable Runner answers. The Runner release ships before HM4a and HM4b merge (§9, §13). |
| The Runner's catalog snapshot drifts from the web's | Committed, and checked by `--check` in CI; the parity scripts fail on any drift (HM2) |
| A lost or corrupt home key, or keys saved on another computer | `home_unreadable` or `home_key_mismatch` on every surface, saying what to do; transient read errors are retried first; `config.json` is unaffected; exec task stores have their own key (§5.8, §5.10) |
| Web-only use (a phone, another computer) stops working | Accepted by the owner's CLI-first direction; Remote covers it later. The not-connected state says what to start. |
| Two tabs, two Runners and the CLI edit settings at once | Op batches under one lock, with per-section revisions and `home_conflict`; the page retries once on fresh data, and re-reads after saves and when its tab is shown again (§5.8, §6.1) |
| Prompt injection from repository content into the task model | The untrusted-data line; approvals or denials for Runner network and credential tools; facts kept apart from claims |
| Injection from task output into the calling agent | Model-authored strings are neutralized and marked `source: "model"`; a fixed Runner line precedes delegated text; events carry no raw tool output; terminal controls are stripped |
| Build and task lifecycles drift | Share primitives, not orchestration; the same cleanup classes and recovery steps |
| Two hosts of one engine drift | `SoloTaskRuntime` is host-agnostic, and SB4a tests it with no Runner composed; DX2 shares the execution-host composition with `startRunner` |
| A model at an unconfined level commits on the task branch, possibly a secret it later removes | The finish pipeline folds model commits back before its secret-checked commit, and reports `replacedModelCommits` (§12.3) |
| A rejected commit leaves a staged secret in the object store | The index is restored; the blobs stay unreachable until `git gc`, which is disclosed |
| A Runner and `aiboard exec` act on one folder at once | Mutual exclusion through the discovery and lifetime locks plus per-task exec locks. Every writing verb runs the admission steps, and the probe also finds Runners started from a subfolder or with `--state-dir` (§11.1, OD-22) |
| Concurrent `aiboard exec` tasks collide in git or in the working tree | Per-task branches, refs and state roots; scoped cleanup; automatic gc off and `GIT_OPTIONAL_LOCKS=0`; a bounded retry on named git lock errors; the exec-apply lock, `git apply --check` and the apply journal (§11.1, §7.2) |
| A caller's timeout kills `aiboard exec` mid-task | `--deadline` below the caller's timeout, and background runs with `--handoff keep` (§6.3); the task id on the first stderr line; the owner tether stops the task's processes for every kill kind (§11.2); `recover` or `resume` settles the residue under the owner-dead proof and takes a snapshot (§11.3) |
| Windows paths too deep for the exec layout | A 10-character task folder, and a path check at admission that refuses before any model call (§11.1) |
| Every command at the default level needs approval, which `aiboard exec` never gives | SoloApprovalPolicy's tier 1 approves calls inside the worktree without asking (§8.2) |
| The user's working tree changes under a running task | The patch is checked against the current tree before it applies; a conflict keeps the branch and returns the recipe (§7.2) |
| Approvals are posted while no one can see them (web) | The approvals-viewer heartbeat on its own route, and early denial when it lapses (§8.2) |
| A caller's own sandbox blocks `aiboard exec` (state folder outside the workspace, provider network) | DX5a documents each CLI's sandbox settings and DX5b measures them in real runs; the refusal text names what was blocked |
| Callers try `aiboard exec` in a folder open in the web | The `folder_open_in_runner` message says how to close it, with its own message for a Runner that `aiboard mcp serve` started (§6.3) |
| No models enabled, or the wrong id | Typed refusals that list the usable ids and say how to enable one (§9) |
| Account runtimes stay unusable for delegates | Marked unavailable to `aiboard exec` in Settings and by `aiboard models` (OD-18) |
| Delegated spending loops | Per-task limits and optional ceilings; a per-user window later (NX14). Stated in §10. |
| Per-checkpoint cost is linear in transcript size | Keep only the latest few checkpoint artifacts per task; an append-only journal |
| Self-approval by the caller | No caller approvals in v1; `aiboard exec` has none; web `apply` is web-only |
| Cold bind (about 9 s); one-call budget overshoot | A visible `preparing` state, and the first stderr line before it; `prepare()` at admission; the output reserve, disclosed; no tool call outlives the deadline (§10) |
| Re-preparation after `continue` or `resume` | The SB5 test re-prepares an interrupted task twice |

## 16. Rejected alternatives

| Alternative | Why rejected |
|---|---|
| A runtime kind inside NativeBuildManager or the kernel | Completion is Architect-only, and those modules changed often during Task 12. |
| A kernel "light path" that widens lifecycle checks | Weakens invariants implicitly. |
| A one-model crew on the full kernel | Still pays for Architect, review and verifier turns. |
| ToolBench or Chat as-is | Either in-place Full access or read-only; both fail on restart; no claim. |
| Reusing the RemoteAdmissionStore table | Different principals; under Remote Q1 review. Pattern only. |
| One blocking start-and-wait MCP call | Breaks client limits and violates the Remote §4 job rule. |
| Giving callers the `/v2` token | A reusable bearer token in caller hands. |
| The MCP tasks extension or A2A as the core path | No SDK runtime in 2.4.0, beta client support, and no local caller speaks A2A. |
| Keys from environment variables | They leak to children and bypass custody. |
| Effort written into shared config | Races concurrent tasks and changes Build. |
| Outbound CLI executors as the core | Prose quotas, missing results and sandbox failures in the owner's runs; vendor terms (§6.5). |
| Calling the unconfined level `workspace` | It reads like Codex's real `workspace-write` sandbox and hides unconfined commands. |
| A project binding with no commands and mandatory evidence as the only writing level | Cannot run tests on stock installs. |
| `bindRun` before the baseline | The baseline's temporary binding must close first. |
| A `--result-file` flag | A new write owner in the caller's tree. |
| A bindless repository probe at admission | A new process boundary for three git questions; `preparing` already has a binding. |
| A Runner that `aiboard exec` starts in the background, or a detached daemon | Leaves a process running after the delegate exits, which the owner ruled out (OD-19). |
| Routing a linked worktree's `aiboard` to the main repository's Runner | The task would start from the main checkout, not the caller's worktree, and the handoff would target the wrong folder. It also breaks the per-folder identity (launcher.ts:216). |
| `continueFrom` in v1 | A kept branch used as a new baseline makes every later diff partial unless the parent was applied. `continue` on the same task covers follow-ups. |
| Switching `read_only` to another binding when a command fails | A silent fallback. The binding is fixed at preparation. |
| A keep recipe piped into `git apply --3way` | Loses binary changes, re-encodes output in PowerShell 5.1, and fails on unstaged paths. |
| A new denial circuit breaker | The existing stall guard already counts denied calls as unproductive turns (agent-loop.ts:926-947). |
| The full suite as the default check | Takes hours; owner rule. |
| Counting any `/v2` request as approvals liveness | The launcher's health check uses the Runner token, and a page without the dock shows no approvals. |
| An `applyEligibility` result field and a checkout warning | They came only from a review finding that was rejected, and they summarize facts the result already carries. |
| Dropping the state directory from the guard to admit worktrees | The data root that contains it is protected too. An exact, identity-pinned exemption is narrower. |
| The 2026-11-03 Delegate design: `aiboard task` over a running Runner, MCP `task_*` tools, the tasks-scope proxy, `launchKind`, typed idle expiry, signed mint fields | It needs a server the caller must start first, and it adds an MCP process; the owner wants a one-shot command like `codex exec` (OD-19). It also cost about 5–6 more days. |
| `read_only` as the delegate default, and Full refused for delegates | The owner wants delegates no more restricted than the web (OD-2, OD-3). |
| A delegation on/off policy per folder | Enabling models in Settings is the opt-in; a second switch adds nothing the other CLIs have (OD-7). |
| Per-folder `delegate:` runtimes pushed by the web | Delegates run in any folder, linked worktrees included; one AIBoard home covers them all (§5.8). |
| `DelegateProfileV1`, a delegate-only file written from Settings > Delegation (the first 2026-11-11 revision) | A second copy of the user's models and keys beside each browser's; one home serves every surface (OD-25). It also saved about 2.5 days of DX1 that HM now covers. |
| Keeping keys in each browser and pushing them to each folder | No other process can read a browser store, so `aiboard exec` and the CLI could not use them, and each browser held its own settings. |
| A passphrase on the home | `aiboard exec` could not run unattended; Codex and Claude Code rely on the account's file permissions instead (OD-27). |
| The home key inside `~/.aiboard` | A copied or synced home would carry usable keys. |
| Moving each browser engine into the Runner | Rewrites chat, panel, benchmarks, Capability Lab and validation; the proxy keeps their code (OD-29). |
| Handing the paired page the plain keys | Puts every key back in the browser for each session; the proxy keeps them on the computer. |
| Copying old browser settings into the home | The owner chose to start fresh (OD-26). |
| `aiboard exec` applying through `applyToProject` | It requires a clean tree and commits on the user's branch, so a mid-work caller would see almost every apply refused (§7.2). |
| A cumulative spending window in v1 | Needs a per-user ledger shared by concurrent processes; the owner wants limits optional (NX14). |
| Letting a Runner and `aiboard exec` work on one folder at once | The Runner's startup recovery and Build auto-apply assume they own the folder's state; sharing would need a common store and cross-process approvals (OD-22). |

## 17. Doc corrections required
Who applies what:
- **Before the Build starts:** the AGENTS.md and CLAUDE.md parts of items 1, 11, 12, 14 and 15. Both files go into every Architect and worker prompt as instruction sections (project-context.ts:20; native-architect-runtime.ts:768; native-worker-driver.ts:597; agent-prompts.ts:505-513 *(3903fc46)*). While they still order Task 12's gates, list the hours-long suite as a standard check, or forbid every auto-apply, an unattended Build can turn to gate work, edit the status file, run the full suite on every packet, or reject SB7's and DX4's handoffs as breaking a repository rule. **Applied on 2026-11-11 with the owner's approval, and on main since PR #171**, together with CLAUDE.md's Build sentence from item 7 and a legacy label on CLAUDE.md's legacy Build engine test suites. The citations below are at 3903fc46, except the AGENTS.md and CLAUDE.md lines that items 7 and 17 still need, which are given at their new numbers.
- **SB0**, in a docs-only change: the rest of items 1–3 (their Build sentence), items 4–6, 13, 16 and 19–21, and the SB0 parts of items 12, 17 and 18. The task sentence of items 1–3 lands with SB7 (web tasks) and DX4 (`aiboard exec`), so no doc describes a feature before it exists.
- **SB4a**: item 22, and the access-level part of item 17.
- **DX5a**: the `aiboard exec` caller docs in the runner guide, and the exec part of item 18.
- **HM6**, when the web has moved to the home: items 7, 8, 10 and 23, and the HM6 parts of items 17 and 18. It drafts items 9 and 23's policy wording for the owner (§18.3).

1. **AGENTS.md part applied 2026-11-11** (now AGENTS.md:45). AGENTS.md:42. Replace "Final project handoff always pauses for a user choice, including under Full access." with the OD-1 rule (§7.5), worded as "A Build's final project handoff …", so that until SB7 and DX4 add the task sentence the doc forbids no task auto-apply.
2. docs/runner-v2/guide.md:9. Replace "Final project handoff still pauses for the user." with the same rule.
3. docs/runner-v2/evidence-gated-planning.md:39. Replace "Final project handoff always waits for your choice." with the same rule.
4. docs/plans/2026-10-27-aiboard-remote.md:164 (Remote L1). "the same tool surface as P2" is stale.
   - The local door had 17 tools at 16927e5f. At 8e9c6c06 it has 20: 18 `LOCAL_TOOLS` (remote-tool-runtime.ts:411-417) plus `batch_files_read` and `batch_files_patch` (`LOCAL_BATCH_TOOLS`, :425), not P2's 25. SB0 re-counts on current main.
   - It has no job tools, devices or artifacts (:411-425; :506 "job APIs are unavailable").
   - The same applies to Remote :224, which still lists 25 tools including `git_commit` and `browser`, and to docs/remote/r0/remote-tool-surface.md:19.
5. docs/plans/aiboard-unified-cloud-desktop-agent-platform-2026-10-15.md:46, docs/plans/2026-10-27-aiboard-remote.md:163 and docs/plans/2026-10-26-native-tools-and-extension-management-status.md:108. All three say the Runner's control token keys the provider config file. The key chain is:
   - the current stores are `state/credential-stores-v2/<generation>/` (credential-migration.ts:314-324); the legacy `provider-configs.enc` at the state root is what they are migrated from (:284-289);
   - each store's key is an HKDF-sha256 subkey of `state/storage-key` (storage-key.ts:18-24, :61-63; credential-migration.ts:116-119), then scrypt (encrypted-provider-config-store.ts:98, :131).
6. docs/runner-v2/architecture.md:13 and :15.
   - :13 says "fifteen audited low-level boundaries: the fourteen Node boundaries …" plus the Windows Job host script, and omits src/launcher.ts, which test/static-adapter-policy.test.ts:11-27 lists among 15 Node entries. The correct text is sixteen boundaries, fifteen of them Node, src/launcher.ts included.
   - :15 says the launcher "starts only the fixed Runner V2 entrypoint". It also spawns the accounts, legacy and bench peers (launcher.ts:939-953) and the OS URL opener (:1129).
   - DX2 adds `aiboard exec` as a second composition root that runs model-requested commands, and documents it there.
7. CLAUDE.md:43, :53, :57, :62, :66, :88, :99 and :105, and its client-store section; AGENTS.md:31, :35 and :51 (line numbers after the 2026-11-11 edits; :53's Build sentence is already fixed). The app is no longer fully client-side for settings: keys live in the AIBoard home, model calls go through the Runner, and the passphrase is gone. Also: :57's "No SSE, no polling, no server" is false for Runner Chat, which polls (lib/client/runner-chat.ts:11-12, :46-57); :99's new-provider checklist gains the Runner side (the catalog snapshot and parity scripts, OD-30); :105's tab list becomes settings-client.tsx:202-208's.
8. app/settings/page.tsx:7 ("Everything stays in your browser", and "encryption"), and app/settings/settings-client.tsx:196 ("stored locally"), :472 ("Everything stays on your device"), :482-490 (prompts "sent over HTTPS directly from your browser"), :494-500 (the passphrase) and :503-509 ("Build mode requires it": every model call needs the Runner now). Keys now stay on the user's computer, in the home.
9. app/privacy/page.tsx:83-90, :93-95 and :389, app/about/page.tsx:126-129 and app/terms/page.tsx:107. They say keys and settings are stored in the browser, optionally behind a passphrase, and that the browser sends prompts and files directly to the providers, which is already false for Build and Runner Chat. Calls now go through the AI Board Runner on the user's computer, which adds the key. These are privacy-policy and terms texts, so the owner approves the wording.
10. docs/runner-v2/guide.md and app/runner-guide/page.tsx: the home, `aiboard config`, `aiboard keys` and `aiboard models`.
11. **Applied 2026-11-11.** CLAUDE.md:42-44 and AGENTS.md:22-24, the Task 12 mandate ("follow it as the authoritative execution plan", "Gates must be completed in the documented order"). Task 12/P6 is closed (task-12-status.md:214: "T8 and Gate G: ACCEPTED"), and the gate docs are history. Keep the standing rules: never inflate timeouts, never weaken fail-closed process ownership or fencing, keep the affected portable coverage, run targeted tests plus `npm run typecheck:runner-v2`, and leave the full suite to CI or the owner (SB9, HM6, DX6).
12. **AGENTS.md and CLAUDE.md parts applied 2026-11-11; README.md's part is SB0's.** AGENTS.md:12, CLAUDE.md:12 and README.md:93-97 list `npm run test:runner-v2` as a standard check, but it takes hours (package.json:15). The per-change check is `npx tsx --test --test-concurrency=1 runner-v2/test/<file>.test.ts` plus `npm run typecheck:runner-v2`; the full suite is for CI or the owner. CLAUDE.md:12's "no test runner" is wrong for runner-v2, which uses `tsx --test`.
13. docs/runner-v2/task-12-status.md, docs/runner-v2/task-12-bounded-gates.md and docs/runner-v2/t8-handoff.md. Each gets a banner: Task 12/P6 is closed (accepted 2026-10-15); this file is history; do not resume it. The stale "Current gate" and IN_PROGRESS blocks are marked superseded (task-12-status.md:23, :70, :734, :1132, :1195, :1203, :1212, :1228-1230, :1301, :1475; t8-handoff.md:360). The pointers into them are reworded: docs/plans/2026-10-26-native-tools-and-extension-management.md:307 and :353, docs/plans/2026-10-27-aiboard-remote.md:10 (which also still calls REL-1 "NOT STARTED", though signed releases shipped through 0.3.16), docs/plans/aiboard-unified-cloud-desktop-agent-platform-2026-10-15.md:12 and docs/remote/l2-release-review-2026-10-30.md:56.
14. **Applied 2026-11-11.** CLAUDE.md:73. "raw `git commit`/`git add` shell commands are refused (NRW-006 …)" holds only for the legacy benchmark engine (lib/orchestrator/build.ts:2707; lib/client/legacy-build-engine.benchmark.ts:2365, :5295). Runner V2 shells can commit, which is why SB4b folds model commits back (§12.3). Scope the claim to the legacy engine.
15. **Applied 2026-11-11**, by marking them as legacy, with a pointer to Runner V2. CLAUDE.md:8-9, :65-74 and :95-96. `lib/client/build-engine.ts` does not exist; product Build is Runner V2 through lib/client/native-build-engine.ts (AGENTS.md:37-39). lib/build-context serves only the legacy engine, and scripts/runner.mjs is legacy (AGENTS.md:63). `predev` and `prebuild` run publish-downloads (package.json:17, :19), which deletes public/runner.mjs rather than copying it (scripts/publish-downloads.mjs:426-428). Replace these sections with a pointer to Runner V2, or mark them as legacy benchmark code.
16. Superseded notes. docs/plans/aiboard-unified-cloud-desktop-agent-platform-2026-10-15.md:30, :125 and :178-181, and docs/plans/2026-10-27-aiboard-remote.md:269 (delegation depth 3, MCP Build tools in the MVP, Remote X3's `build_*` names) are superseded by this plan (OD-12, OD-19, §6.4, §6.5). docs/plans/2026-10-27-aiboard-remote.md:59, :137 and :211 (device secrets in DPAPI, Keychain and libsecret) get a note that the keys are user-only 0600 files as built (storage-key.ts:19-59; remote-device-store.ts:72-76), and that the home key follows them (§5.8).
17. The handoff rule and access levels elsewhere: app/runner-guide/page.tsx:76-77 ("Final project handoff is always a user choice in every profile"), README.md:12-13, :74 and :76-81, AGENTS.md:41 (its number after the 2026-11-11 edits), docs/runner-v2/extensions.md:3, app/about/page.tsx:88 and docs/runner-v2/rel-1-runbook.md:51. SB0 applies the OD-1 Build rule, and adds to README.md:79 that a Build's apply needs a clean tree and lands a commit (integration-manager.ts:1701, :1724-1733). README.md:12's two profiles become the three in contracts.ts:3 (guarded, project, full); SB4a adds the four task access levels. SB7 and DX4 add the task sentence. HM6 rewrites what the home changes.
18. README.md:8, :33 and :35. SB0 fixes the key-custody sentence (the stores are keyed from the per-state storage key, not the control token, item 5). HM6 rewrites the rest: "optional encryption" (OD-27), "provider settings stay in browser storage … provider requests go directly" (OD-25, OD-29), and "mandatory only for Build mode". docs/account-providers.md:37-41 and :56 and docs/provider-capability-live-tests.md:30 ("the browser stores only the runner URL and runner token") change at HM6; the live scripts that read keys through `AIBOARD_STORE_PATH` (scripts/test-openrouter-structured-output-live.mts, scripts/test-provider-runtime-live*.mts) read the home instead. DX5a adds that account models are not offered to `aiboard exec` (OD-18).
19. docs/runner-v2/guide.md:42 and docs/runner-v2/review-evidence-policy.md:15 ("the wider development suite remains scheduled for the final P6.6 gate"). P6.6 and T8 were accepted; the full suite runs in CI or by the owner.
20. docs/plans/2026-10-27-aiboard-remote-STATUS.md:11 and :274. Stable is 0.3.16 (sequence 18), not 0.3.5; :274's "dashboard approvals … are P4" contradicts :20 ("Dashboard approvals shipped 2026-11-06").
21. The plans that the HM and DX packets supersede in part get a one-line pointer to this plan: docs/plans/2026-10-27-aiboard-remote.md (L1, X3) and docs/plans/aiboard-unified-cloud-desktop-agent-platform-2026-10-15.md (C1).
22. docs/runner-v2/security.md:26. The S1a protected locations no longer bind remote and local-MCP file tools only: SB4a extends the guard to every task broker and every path-taking tool (§8.1), and HM1 adds the home's fixed deny to every broker (§5.8).
23. SECURITY.md:20-27 and CONTRIBUTING.md:31. They describe the client-side model: keys entered in the browser, calls sent straight to providers, optional passphrase encryption, and "no … account system, hosted database", which the Remote relay's accounts already contradict. They become: keys live in the AIBoard home, browser calls go through the local Runner's model proxy, and the proxy token has a narrow scope. The owner approves the wording.

All dated *(3903fc46)*.

## 18. Building this plan with AIBoard

The owner builds the AIBoard home (SB0, HM1–HM6) and then the CLI-workers plan in Claude Code sessions. An AIBoard Build, with CLI workers among its workers, then builds the rest (SB1–SB9, DX1–DX6), which also tests the Runner (OD-33). This section is for every implementer: those sessions, and that Build's Architect.

### 18.1 Order
- **Before launching.** The pre-launch items of §17 are in place: AGENTS.md and CLAUDE.md no longer order Task 12's gates, list the hours-long suite as a standard check, forbid task auto-apply, claim raw commits are refused, or describe the legacy browser Build engine as current. Both files go into every Architect and worker prompt. They are on main since 2026-11-11 (PR #171).
- Dependencies are the "Depends on" column of §13. A packet starts only when all of them are done.
- **Order: home first** (owner decision, 2026-11-12, OD-33):
  1. SB0, HM1, HM2, HM5, in Claude Code sessions;
  2. HM3, HM4a, HM4b, HM6, in Claude Code sessions (HM4a and HM4b merge only after a Runner release with HM1–HM3 and HM5, §13);
  3. CLI workers, in their own plan and in Claude Code sessions (§6.5);
  4. SB1, SB2, SB3, SB4a, SB4b, SB5, SB7, by an AIBoard Build with CLI workers;
  5. DX1, DX2, DX3, DX4, DX5a, DX6, in the same Build (DX5b is the owner's, §18.3);
  6. SB6, SB8, SB9, in the same Build.

  The owner may choose another order that respects the dependencies.
- Packets may share a Build pass, in that order. A packet's acceptance is met before the next packet starts.

### 18.2 Rules for every packet
- **Base.** Work from current main, on a feature branch, never on main. A push to main deploys aiboard.me. Pushes, merges, releases and deploys are the owner's.
- **Verification.**
  - Run the packet's targeted tests from §13, plus `npm run typecheck:runner-v2` for every Runner packet, and root `npx tsc --noEmit` and `npm run lint` for every web packet.
  - Never run the full `npm run test:runner-v2`, which takes hours. CI or the owner runs it at the gates.
  - Never run `npm run build` while a dev server is up: it corrupts the dev server's `.next`.
- **Tests.**
  - Each acceptance bullet is covered by a named test.
  - A new test joins the npm group its packet names, or the closest existing one.
  - A test that pins behaviour a packet deliberately changes is rewritten or removed, never worked around.
  - Tests use stub providers. No live provider calls, and no real keys in tests, fixtures or logs.
- **Repository rules.** AGENTS.md applies. In particular, every new file owner gets a reviewed entry in test/filesystem-mutation-routing.test.ts and a filesystem-owner review record.
- **Not Task 12 work.** This plan is not Runner V2 Task 12 / P6 acceptance work, and the owner considers those gates passed (OD-16). CLAUDE.md's Task 12 mandate does not govern it; §17 item 11 replaced the mandate with standing rules on 2026-11-11.
- **Process ownership.** DX2's owner tether and owner-dead recovery change process ownership and fencing. They never weaken fail-closed semantics. A second model (the Build's reviewer) reviews them for that, the packet's summary records the review, and the owner reviews them again in the pull request.
- **Code moves.** Citations marked *(3903fc46)* were read at that commit, the rest at 16927e5f, and the 2026-11-11 review re-checked the ones it relied on against main at 8e9c6c06 (see the header). On a later main, or for an unmarked citation, find the cited code by its names, not by line numbers.
  - Where the code now differs from the plan, follow the plan's intent, and say so in the packet's summary.
  - Where a packet needs a decision §14 does not cover, stop that packet and report the question. Do not invent an owner decision.
- **Platforms.** Development happens on Windows with PowerShell. Tests pass on Windows; POSIX-only behaviour gets a platform-guarded test.
- **Docs.** Apply only the §17 items the packet names. No other edits outside the packet's files.

### 18.3 Steps that stay with the owner
Before the Build:
- done: the plan and the pre-launch items of §17 (the AGENTS.md and CLAUDE.md parts of items 1, 11, 12, 14 and 15) reached main on 2026-11-11 (PR #171).

During and after the Build:
- DX5b: the real headless runs of Claude Code, Codex and agy, the Codex sandbox measurement, and each caller's output limit and kill behaviour;
- HM5's manual terminal check: the key prompt in Windows Terminal, PowerShell, cmd, Git Bash and macOS Terminal;
- the wording of the privacy, terms and about pages, SECURITY.md and CONTRIBUTING.md (§17 items 9 and 23);
- the release order: a published Runner release with HM1–HM3 and HM5 before HM4a or HM4b merges (§13);
- pushes, merges, releases, deploys, and running the full suite at the gates.

None of these blocks a later packet:
- a gate records "full suite pending (owner or CI)" and passes on its targeted checks (§13);
- DX5a ships each caller recipe marked "not yet verified", with an owner checklist for DX5b;
- HM5 lists the manual terminal check as pending;
- HM6 drafts the new wording for those pages and files in its summary, and leaves them unchanged;
- HM4a and HM4b are built on their branches and only their merge waits for the release.

The Build lists each one in its final report.

### 18.4 Done, per packet
- Every acceptance bullet in §13 has a passing test, or a recorded owner step from §18.3.
- The targeted tests and type checks are green.
- The packet's summary lists the tests run, any difference from the plan, and any open question.

## Appendix: verified-claims ledger

| Claim | Evidence |
|---|---|
| ToolBench: solo, Full access at the project root, fails on restart | toolbench-session.ts:48, :181-182, :108-131 |
| Build auto-applies under finish/budgeted; docs said it always pauses | native-build-manager.ts:1145-1150; AGENTS.md:42 (until 2026-11-11); docs/runner-v2/guide.md:9; docs/runner-v2/evidence-gated-planning.md:39 |
| Worker surface is hardcoded; submission needs evidence | worker-runtime.ts:141-143, :387-391; change-set.ts:143-148 |
| `worker:task` needs Build lifecycle tools | role-capabilities.ts:267-326 |
| Approval rules; approvals never time out; `decide` is idempotent | tool-broker.ts:303-311; permission-store.ts:71-94, :112-140 |
| Non-full profiles need a contained provider; none on stock Windows | execution-isolation-provider.ts:347-362; windows-process-backend.ts:95-105; runner-capabilities-config.ts:80-98 |
| Unconfined commands can read the Runner's state and pair | storage-key.ts:19-24; credential-migration.ts:70-72, :113-121; launcher-instance.ts:393, :399; launcher.ts:519; launcher-ipc.ts:140-143; control-server.ts:360, :384-390, :444-471 |
| The protected-location guard covers only remote and local_mcp file tools | tool-broker.ts:102-104, :562-568; protected-locations.ts:94-126 |
| `process.run` declares no network; hosted tools go on every request | process-tools.ts:139-143; provider-config-store.ts:32; openai-compatible-model.ts:230-237 |
| The baseline initializes git in place, and includes uncommitted work | git-baseline.ts:73-80, :106-108, :16, :244-249 |
| A secret check already exists | submission-guard.ts:24-40, :60-63; submission-guard-git.ts:15-46 |
| Apply recovery is private | integration-manager.ts:2044, :1704 |
| The ChangeSet diff is binary-safe, without renames for submissions | change-set.ts:166-172 |
| Denied calls count as unproductive turns | agent-loop.ts:926-947, :1022-1060 |
| Local MCP door: Full binding, project broker, 17 tools at 16927e5f (20 on main: 18 plus two batch tools), no jobs | runner-start.ts:499-502; remote-tool-runtime.ts:374-376, :388, :411-425, :474-475 |
| Idle expiry, depth limit, no structured content, no abort | local-stdio-mcp.ts:20, :102-103, :215-232, :235-244 |
| A tool-owned Runner gets no pairing ticket when spawned, and stops with its MCP client | launcher.ts:535-536, :632-636; runner-start.ts:155-162 |
| A plain `aiboard` reuses and pairs any healthy Runner; `mcp serve` prepares state and takes the discovery lock before serving | launcher.ts:281-282, :296, :485-519, :622-632 |
| The idle timer deletes the session; one mint per socket; 32 connections | local-stdio-mcp.ts:144-161; launcher-ipc.ts:144-153, :198 |
| The Runner learns its context from the handshake; `instanceFields` are MAC-covered | launcher-ipc.ts:12-23, :95-105, :202-211, :411-414; launcher-instance.ts:359-374 |
| The guard is a deny-list; path-taking tools other than `fs.*` are unguarded; subagents take no guard | remote-path-guard.ts:174-215; tool-broker.ts:102-104; code-intelligence-tools.ts:133-136, :239-241; subagent-tools.ts:78, :170-180, :205 |
| Provider configs are replaced whole and never deleted | control-server.ts:1680-1705 |
| Cleanup deletes every task branch; Runner ref namespaces | workspace-manager.ts:311-316; git-baseline.ts:283; integration-manager.ts:1738, :4212 |
| Evidence commands are not `readOnly`; job.v1 has `blocked_policy` (for X3) | evidence-tools.ts:146-147; remote-admission-store.ts:11-12 |
| The launcher reads depth only for `mcp` | launcher.ts:210 |
| A plain `aiboard` co-launches the account runner | launcher.ts:394-397 |
| Device policy defaults; re-checked per call | remote-principal.ts:37-39; remote-tool-runtime.ts:224-233 |
| Control key read and zeroed per mint; nine actions | launcher.ts:629-633; launcher-ipc.ts:25-27 |
| A worktree is a new identity; storage key per state directory | launcher.ts:216; launcher-instance.ts:32-36; storage-key.ts:18-30 |
| `docs/project` conflict; apply preconditions; unknown effort → "default" | integration-manager.ts:735-743, :1701-1734; reasoning-effort.ts:10-21 |
| Remote-only recovery flag; startup order | runner-start.ts:182-183, :421-439, :499-503 |
| SDK request context has `signal` and `notify` | @modelcontextprotocol/server 2.4.0, dist/mcp-BCJHyo7l.d.mts:2183, :2204 |
| CLI flags and `mcp add` syntax; `claude --bg` and `claude agents` | `--help` of codex-cli 0.166.0, Claude Code 2.1.317 and agy 1.4.12, read on 2026-11-03 |
| The Windows managed install provides only `aiboard.cmd` | AIBoard bin folder listing on this PC, 2026-11-03 |
| The plan branch was merged with main at 3903fc46 (Runner 0.3.16) on 2026-11-11 | `git log` on worktree-simple-build-delegate-plan |
| Provider configs are per folder, merged from pushes, never removed; GET redacts | control-server.ts:583-607, :1680-1705 *(3903fc46)* |
| The storage key file is per state directory; credential stores are opened per state directory | storage-key.ts:23; runner-start.ts:226-235 *(3903fc46)* |
| A per-user secret, separate from the project storage key, already exists | launcher-instance.ts:40-42; remote-device-store.ts:72-76 *(3903fc46)* |
| Folder locks are exclusive SQLite write transactions; the Runner holds `lifetime`; discovery waits up to 10 s | launcher-instance.ts:267-297; runner-start.ts:194-196 *(3903fc46)* |
| The execution host has a factory the Runner calls once | execution-host.ts:206; runner-start.ts:249-260 *(3903fc46)* |
| Task-branch cleanup is scoped to its own run segment | workspace-manager.ts:185-195 *(3903fc46)* |
| `applyToProject` requires a clean tree and lands a commit | integration-manager.ts:1701, :1724-1733 and the commit-tree / update-ref steps after it *(3903fc46)* |
| Build gives Claude models Anthropic's bash tool, GPT models OpenAI's shell tool, and keeps shell sessions between calls | anthropic-bash-tool.ts:1-8; openai-shell-tool.ts:2-9; shell-session.ts:11-18 *(3903fc46)* |
| Settings and keys live in each browser's store | lib/client/store.ts:71-101; lib/db/schema.ts:300-399, :472-499; lib/client/storage-adapter.ts:58, :598-619 *(3903fc46)* |
| Browser model calls read the stored key | lib/client/engine.ts:477; lib/benchmark/certified/model-call.ts:217; lib/client/capability-api.ts:413; lib/client/settings-api.ts:1082; lib/client/providers.ts:350-363 *(3903fc46)* |
| Runner Chat pushes a config with the key every turn; Build pushes before a run | lib/client/runner-chat.ts:35; lib/client/native-build-engine.ts:228, :590, :602 *(3903fc46)* |
| A pushed provider config must carry a secret | provider-config-store.ts:90-101 *(3903fc46)* |
| AIBoard already keeps per-user files in `~/.aiboard` | launcher.ts:235; runner-start.ts:1052; native-build-factory.ts:3930; copilot-runtime.ts:66-70 *(3903fc46)* |
| The guard protects the data root, and on POSIX all of `~/.aiboard` | protected-locations.ts:115-136 *(3903fc46)* |
| The paired session is tab-scoped | lib/client/local-runner-handoff.ts:9-14, :233 *(3903fc46)* |
| Google's SDK is built without a base URL | lib/providers/google.ts:345, :357 *(3903fc46)* |
