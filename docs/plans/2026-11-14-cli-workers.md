# CLI Workers: Codex CLI, Claude Code and agy as Build Workers — Implementation Plan
Date: 2026-11-14
Status: **Waiting for the owner's approval.** No packet starts before it. It runs after the AIBoard home (done 2026-11-12) and the build verification plan (VF1–VF9, done 2026-11-14), and before the AIBoard Build of Simple Build and `aiboard exec` (OD-33, OD-34, VD-1).
Audience: the owner, and whoever implements the packets: a person or a Claude Code session.
Primary repository: D:\repos\ai-discussion-board, read at bb35b8e4 (main, 2026-11-14). Bare file names are under `runner-v2/src/`; `test/...` is `runner-v2/test/...`; other paths are repo-relative.
Sources: docs/plans/2026-11-03-simple-build-and-delegate.md (§2, §6.5, §9, §11.4, §12.3, OD-33–OD-36); docs/plans/2026-11-13-build-verification.md (§4.5, §4.8, §9); the design session "Worker delegation with local CLI tools" (2026-11-11). That session's citations predate the home and the verification plan; every one used here was re-read at bb35b8e4, and the ones that moved are listed in §2.6.

## 0. TL;DR

- **What.** The owner's Codex CLI, Claude Code and agy run as Build workers next to API-model workers. The Architect, its prompts and its tools do not change (OD-33).
- **Why it is a small change.** The scheduler talks to a worker through one call, `WorkerRuntimeDriver.run(assignment) → WorkerOutcome` (task-scheduler.ts:72). `NativeWorkerDriver.run` picks the runtime, creates the task's worktree and builds the context, then calls `runWorkerTask` (native-worker-driver.ts:199-424). A CLI worker replaces only that call. Everything after a submission (review, verification, integration) already works on the worktree's git diff, whoever produced it.
- **How a CLI worker runs.** The Runner starts the CLI headless (`codex exec`, `claude -p`, `agy -p`) as a managed process it owns, in the task's worktree, with the task prompt on stdin and a JSON result schema. When the CLI exits, the Runner proves every process it started is stopped, undoes the CLI's own commits, re-runs the checks the CLI reports as evidence, and submits through the same code path as `submit_task`.
- **What the Runner trusts.** Only what it ran itself: the worktree's diff, its re-runs of the reported checks (with their output files, VF6), and its own final check. The CLI's report is a claim, shown to the Architect as one.
- **Failures.** Each CLI's quota, login, rate-limit and crash messages map to the provider-health kinds the Runner already uses. The existing failover hands the same task, in the same worktree, to another healthy worker, API or CLI, with a handoff summary in both directions (native-worker-driver.ts:457-487).
- **Settings.** CLI worker settings live in the AIBoard home (§6.5 of the 2026-11-03 plan). Settings shows the free checks (installed, logged in, models) and a Test button that sends one tiny prompt. The CLI's login stays in the CLI's own files; AIBoard never reads them.
- **Safety.** Full access only (OD-36). The CLI runs under the Runner's process ownership, and nothing in it is weakened: an unverified stop never submits, and it pauses the run with the worktree claim kept. A launch, stop or browser start the Runner cannot prove is the Runner's failure, never the CLI's (§3.11). The CLI browses with the Playwright CLI session the Runner starts for it (VF7b).
- **Estimate:** 17–23 days in eleven packets (§5). The 2026-11-11 design estimated 13.5–17.5 days plus 1–2 for browser replay; §5.1 reconciles the two.

## 1. Goals and non-goals

### 1.1 Goals
1. A Build crew can include Codex CLI, Claude Code and agy workers next to API-model workers, chosen in the same crew picker.
2. The Architect is unchanged. It plans, reviews and decides exactly as today, and sees a CLI worker's submission in the same shape as any worker's.
3. A CLI worker's work meets the same evidence rule as any worker's: a criterion is supported only by evidence the Runner recorded for the assigned worker (acceptance-contracts.ts:302-306).
4. The owner can check each CLI before a Build: installed, logged in, models, and a Test button that shows why a CLI cannot work (not installed, not logged in, out of usage, model unavailable, timed out).
5. A CLI that runs out of usage or is logged out mid-Build hands its task to another worker automatically, as an API worker does today. A passing Settings test ends its cooldown.
6. Settings for CLI workers are home settings, saved through the Runner as op batches like every other setting.
7. Process ownership stays fail-closed: every process a CLI starts is owned, stopped and proven stopped like any managed process, on Windows, macOS and Linux.
8. PR CI stays at about 3 minutes per job: CLI tests use fake CLIs, never a real one.

### 1.2 Non-goals
- A CLI as Architect, reviewer, plan critic or verifier. A CLI cannot run AIBoard's own tool loop.
- Simple Build tasks or `aiboard exec` run by a CLI. That is NX7 of the 2026-11-03 plan; admission refuses a CLI runtime with `runtime_unsupported` until then (2026-11-03 plan §9).
- AIBoard's tools exposed to a CLI over MCP. Rejected in the design session: the CLIs' MCP time limits (Codex 60 s per call, Claude Code moves calls over 120 s to the background where `-p` loses them) break long test runs, and it would open a new way into the Runner.
- Answering a CLI's own permission prompts, or any access level below Full (OD-36).
- Questions to the Architect in the middle of a CLI's run. A CLI asks only at the end, through its result.
- Reading, storing or forwarding a CLI's credentials, or running a CLI in API-key mode from the home. The CLI uses the user's own login (OD-35).
- Other CLIs (opencode, gemini-cli, aider). The adapter interface allows them later.
- The legacy browser Build engine and the benchmark tracks.

## 2. Current state (bb35b8e4)

### 2.1 The worker seam
| What | Where | Use for CLI workers |
|---|---|---|
| The scheduler's worker call | task-scheduler.ts:72 (`WorkerRuntimeDriver`) | unchanged |
| Runtime selection on first assignment | native-worker-driver.ts:210-224 (`selectWorker`, pause `no_healthy_capability_match`) | unchanged; CLI runtimes are candidates like any worker |
| One session id per task attempt, kept across runtimes | native-worker-driver.ts:203-209; reassigned at :484-486 | the handoff key in both directions (§3.9) |
| Worktree per task | native-worker-driver.ts:256-265 (`createTaskWorkspace`); workspace-manager.ts:105 | unchanged; the CLI works in it |
| The model call this plan replaces | native-worker-driver.ts:312-424 (`runWorkerTask`) | a branch for a `cli` runtime |
| Outcome mapping | native-worker-driver.ts:425-444 (submitted), :445-450 (`waiting_for_architect`), :451-456 (`replan_requested`), :457-487 (provider failure and failover), :488-514 (other suspensions) | reused as is: the CLI path returns the same loop statuses |
| Worker system prompt | native-worker-driver.ts:113-134 (`docs/project/**` rule at :118, evidence rule at :119, impact-first verification at :125) | the CLI preamble restates these rules (§3.5) |
| Resume message | native-worker-driver.ts:752-772 (`workerContinuationMessages`) | the API side of the CLI→API handoff |
| Worker spreading and demotion | native-worker-driver.ts:784-812 (`workerSelectionPreference`); runtime-router.ts:135-156 | unchanged; a CLI that keeps failing is demoted like any worker |

### 2.2 Submission and its checks
| What | Where |
|---|---|
| The `submit_task` handler: contract gate, validation scope, validation budget, evidence lookup, guarded commit, ChangeSet | worker-runtime.ts:337-463 |
| Evidence required: with no criteria, at least one record by this worker and attempt; with criteria, one link per criterion | worker-runtime.ts:372-394; acceptance-contracts.ts:302-306 |
| Evidence must match the submitted tree (`current`, `stale`, `unknown`) | change-set.ts:130-136 |
| Guarded commit: refuses an unsettled merge or rebase, stages with `git add -A`, inspects the immutable tree, `commit-tree` on the previous head | workspace-manager.ts:171-183, :330-395 |
| The guard checks only that the baseline is an ancestor of HEAD | workspace-manager.ts:405-410 |
| `ask_architect` and `request_replan` | worker-lifecycle-tools.ts:302, :357 |
| Evidence records carry actor and attempt | evidence-store.ts:126-137; command fact :8-43 (with VF6 `outputs` at :38-42) |
| `run_evidence_command`, no shell, with `outputs` | evidence-tools.ts:147-148 |

So a CLI's own `git commit` moves HEAD, and the guard's tree inspection sees only baseline..candidate. A secret the CLI committed and then removed would never show. That is the commit-undo step of §3.7, which SB4b reuses (2026-11-03 plan §12.3).

### 2.3 Providers, health and failover
| What | Where |
|---|---|
| Failure kinds: `usage_limit`, `rate_limit`, `authentication`, `provider_unavailable`, `transient`, `invalid_request`, `cancelled` | provider-health.ts:1-8 |
| Cooldowns: usage_limit 1 h, rate_limit 1 min, authentication 24 h, provider_unavailable 5 min, transient 30 s | provider-health.ts:40-46 |
| A provider-supplied `retryAfterMs` wins; a monthly limit is inferred as 24 h | provider-health.ts:78-87, :131-133 |
| `transient` cools down only after two in a row | provider-health.ts:98, :127-130 |
| Health is per `providerId`, not per runtime | provider-health.ts:111-145; runtime-router.ts:279-285 |
| `recordSuccess` is the only way back to healthy before expiry | provider-health.ts:147-157 |
| Failover to another runtime, same task and worktree; pause `all_worker_runtimes_unavailable` when none is left | native-worker-driver.ts:457-487 |
| `invalid_request` and `cancelled` never fail over | native-worker-driver.ts:814-816 |
| Health changes are durable scheduler events | native-worker-driver.ts:556-569 |

### 2.4 Configs, the home and Settings
| What | Where |
|---|---|
| Transports: `account-runner`, `openai-compatible`, `anthropic`, `google` | provider-config-store.ts:3-7 |
| A config needs a secret unless it is home-backed | provider-config-store.ts:106-127 (:116) |
| `billingBasis: "account_not_metered"` exists | provider-config-store.ts:9-12 |
| Pushed configs that take no key from the home pass through | home-provider-configs.ts:23-25, :36-40 |
| The home's settings are an explicit allow-list; unknown top-level sections are kept verbatim | aiboard-home-store.ts:51-62, :129-139 |
| Settings validators | aiboard-home-store.ts:855-865 |
| Testing a provider: a short real prompt, the outcome saved to the home | lib/client/settings-api.ts:1068-1135 |
| Routes the web uses for Runner-side tools: `/v2/home`, `/v2/browser` | control-server.ts:552-563; browser-install.ts:114 |
| Every selected config gets an `AgentModel` | native-build-factory.ts:1262-1269 |
| Architect, worker and verifier routers | native-build-factory.ts:1235-1247 |
| The web puts every configured runtime in the verifier list | lib/client/native-build-engine.ts:491-519 (:518) |

### 2.5 Processes, environment and browsing
| What | Where |
|---|---|
| Managed processes: `start`, `writeInput` (with `closeInput`), `readOutput`, `signal`, `closeAgent(owner)`, `stopRun` | managed-process.ts:154, :210, :265, :489, :514-516, :504; managed-process-contracts.ts:37-46 (`interactive`), :119-124 |
| One-shot commands have no stdin | one-shot-command-executor.ts:38-61 |
| Child environments drop sensitive names (`*_TOKEN`, `*_API_KEY`, `*AUTH*`, …) and set `AIBOARD_MCP_DEPTH` | child-environment.ts:130-136, :171, :302-305; sensitive-redaction.ts:15-30 |
| The local MCP door refuses depth 2 and above | child-environment.ts:87; local-stdio-mcp.ts:102-103 |
| Playwright CLI sessions: one per owner, env and PATH for every process the Runner starts for that owner | playwright-cli.ts:1-18, :39, :413-428 |
| The tool inventory, with an 8 s probe timeout | verification-inventory.ts:10-19, :32 |
| Permission profiles | contracts.ts:3 (`"guarded" | "project" | "full"`) |
| "Local agents" is already a Runner term for Build and Chat | local-agents-availability.ts:1-13 |

### 2.6 Citations that moved since the 2026-11-11 design session
- `all_worker_runtimes_unavailable` is in native-worker-driver.ts:482, not task-scheduler.ts:590.
- The submit handler is worker-runtime.ts:337, not :336.
- The models map is native-build-factory.ts:1262, not :1208.
- The verifier list is lib/client/native-build-engine.ts:518, not :515.
- The browser evidence the design session discussed (`browser.*` tools, browser-tools.ts:406, the built-in browser final check) is retired for new runs (VF7b, VD-6). §3.10 replaces the "browser replay" idea.
- CLI versions on this PC moved in three days: codex-cli 0.166.0 → 0.167.1, Claude Code 2.1.322 → 2.1.325, agy 1.4.12 → 1.5.6 (§3.2).

## 3. Design

### 3.1 Names and the runtime config
- Call them **CLI workers**, with a `cli` transport (2026-11-03 plan §6.5). "Delegate" means `aiboard exec`.
- Provider ids: `codex-cli`, `claude-code`, `agy`. Health is per provider id (§2.3), so one Codex login out of usage cools every Codex worker, which matches how CLI quotas work.
- Runtime ids: `<providerId>:<model or "default">`, for example `claude-code:default`, `codex-cli:gpt-6-codex`. A crew may hold several workers of one CLI, each in its own worktree.
- `RunnerProviderConfig` gains `transport: "cli"` and an optional `cli: { reasoningEffort?: string }` block. A `cli` config:
  - has no secret, no base URL, no `runnerToken` and no `secretSource`; `validateProviderConfigs` accepts an empty `secret` for it and refuses any of the others;
  - passes through HM3 as pushed (`takesKeyFromHome` is false for it), and is never sent through the model proxy;
  - has `billingBasis: "account_not_metered"`, and `supportsTools: false`.
- The model id and effort are checked against a small character set (`[A-Za-z0-9._:/-]`, at most 128 characters), because they become arguments.
- CLI providers are not in `MODEL_CATALOG` or the provider registry: they are worker-only, never chat models. The Runner's catalog snapshot (OD-30) is unchanged.

### 3.2 Detection and the free checks
Free checks cost no quota. Run on this PC on 2026-11-14 (version and login commands only, no prompt):

| | Codex CLI | Claude Code | agy |
|---|---|---|---|
| Installed here | `codex.exe` 0.167.1 | `claude.exe` 2.1.325 | `agy.exe` 1.5.6 |
| Version | `codex --version` | `claude --version` | `agy --version` |
| Logged in | `codex login status`: exit 0, "Logged in using ChatGPT" | `claude auth status`: exit 0, JSON with `loggedIn`, `authMethod`, `subscriptionType`, `loginExpiresAt` (also account fields, which AIBoard never stores or shows) | no status command; `agy models` exits 0 only when logged in |
| Models | none; the CLI's default, or a typed id | none; the CLI's default, or a typed id | `agy models`: one id and name per line (18 here) |
| Headless | `codex exec` | `claude -p` | `agy -p` |

- **Lookup.** The executable is resolved once on PATH with the same lookup VF2 uses for checks (check-tool-lookup.ts), and the resolved path is recorded. An `executablePath` in the home overrides it.
- **Windows launch form.** All three are `.exe` files here. An npm-installed CLI is a `.cmd` shim, which runs through `cmd.exe`. The Runner never puts model text in argv (the prompt goes on stdin, §3.5), and the remaining arguments are Runner-built and charset-checked, so a `.cmd` shim is safe to launch. A path that is neither `.exe` nor `.cmd` is refused on Windows.
- **Where they run.**
  - When Settings opens, and on its Refresh button, through `GET /v2/cli-workers` (CW3). Results are cached for 60 s.
  - Before planning, for every CLI in the crew, recorded with the tool inventory (VF1) as one `cli_workers.checked` event. A CLI that fails a free check is recorded as unhealthy with the matching failure kind (§3.8) before any task is assigned, so a logged-out CLI is caught before work begins.
- **Bounds.** 8 s per probe (the inventory's timeout, verification-inventory.ts:32), no network beyond what the CLI itself does for `agy models`, no file written. Output is cut to the first lines the parser needs. The parsers keep only the fields named above.

### 3.3 Settings and the home
- A new top-level home section, `cliWorkers`, added to the home's validators like DX1's `exec` (aiboard-home-store.ts:129-139). Writers that predate it keep it verbatim.

~~~ts
interface HomeCliWorkersV1 {
  [providerId in "codex-cli" | "claude-code" | "agy"]?: {
    enabled: boolean;
    executablePath?: string;          // overrides the PATH lookup
    models: { id: string | null; reasoningEffort?: string }[];  // null = the CLI's own default
    maxMinutesPerAttempt?: number;    // 5–240, default 45 (CWD-6)
    consentedAt?: string;             // the Full-access note was accepted (§3.12)
    lastTest?: {
      at: string; cliVersion: string; modelId: string | null;
      outcome: "passed" | "not_installed" | "not_logged_in" | "usage_limit" | "model_unavailable" | "timed_out" | "unreadable_result";
      resetsAt?: string;              // only from a time the CLI stated
      message?: string;               // redacted, at most 300 characters
    };
  };
}
~~~

- Op paths: `cliWorkers.<providerId>` (set, merge, remove), through the home's conflict-checked op batches. `home-client.ts` stays the only web module that writes settings (`scripts/test-settings-home.mts`).
- No secret is ever stored. A canary test proves the free checks' account fields (e-mail, organization) never reach the home, a log or an event.
- The web pushes a `cli` config for each enabled CLI model when a Build starts, as it pushes API models today.

### 3.4 The Test button
- `POST /v2/cli-workers/<providerId>/test` with a model and effort. It sends one tiny prompt asking for a fixed JSON reply under the result schema, in an empty folder the Runner owns (`state/cli-worker-tests/<random>/`, removed after), in the CLI's most restricted mode: Codex `-s read-only --skip-git-repo-check --ephemeral`, Claude Code `--permission-mode plan --no-session-persistence`, agy `--mode plan`. Timeout 120 s.
- It confirms the model is available, there is usage left, and the result can be parsed. None of the CLIs reports remaining usage, so a real prompt is the only test. The button says it uses a tiny amount of the CLI's usage, as testing an API key does.
- The outcome classes are `lastTest.outcome` (§3.3), with the reset time when the CLI states one. The result is saved to the home and shown in Settings and the crew picker.
- **A passing test ends a cooldown.** The Runner records success for that provider id in every non-terminal Build it owns: a running Build's registry gets `recordSuccess` (provider-health.ts:147-157) and a durable `provider.health_changed` event; a paused Build gets the event, which its registry reads on resume. The same applies to a passing API key test, through the same route (CWD-4).
- The test runs as a Runner-internal owner under the same process ownership as a worker (§3.11); an unverified stop reports `timed_out` and keeps the folder for the Runner's residue cleanup.

### 3.5 The worker loop
For a runtime whose config has `transport: "cli"`, `NativeWorkerDriver.run` takes a CLI branch in place of `runWorkerTask` (native-worker-driver.ts:312). Everything before it (selection, contract check, worktree, context pack, context manifest) is unchanged. The branch lives in a new `cli-worker-runtime.ts`; the per-CLI details live in `cli-worker-adapters.ts`.

1. **Prompt.** The same context pack text an API worker gets (native-worker-driver.ts:269-290), then a preamble that restates the worker rules for a CLI:
   - work only in this folder (the worktree); do not commit, push, install packages globally, or change Git config;
   - `docs/project/**` is the Architect's;
   - verify by impact, narrowest first; never weaken a test; run each check as its own command;
   - for UI work, use the running Playwright CLI session (§3.10);
   - end with the JSON result below, and list every check you ran.

   A handoff section follows when another worker worked on this attempt before (§3.9). On a fix round, the prompt is the re-run results instead (§3.6).

   ~~~ts
   interface CliWorkerResultV1 {
     outcome: "done" | "needs_decision" | "cannot_do";
     summary: string;                        // at most 4,000 characters
     question?: string;                      // needs_decision
     replanReason?: string;                  // cannot_do
     checks: { label: string; executable: string; args: string[]; cwd?: string;
               outputs?: string[]; criterionIds?: string[] }[];   // at most 12
     notRun?: { what: string; why: string }[];
     concerns?: string[];
   }
   ~~~

2. **Launch.** Through `ManagedProcessService.start` with the worker's owner (run id, session id, worker actor), `interactive: true`, cwd = the worktree. The prompt is written to stdin and stdin is closed (`closeInput`). The result schema and the CLI's output file go to a Runner-owned folder outside the worktree (`state/cli-workers/<runSegment>/<sessionSegment>/`).

   | | Arguments (all Runner-built) | Prompt | Result | Resume |
   |---|---|---|---|---|
   | Codex CLI | `exec --json --output-schema <file> -o <file> [-m <model>] [-c model_reasoning_effort=<e>] --dangerously-bypass-approvals-and-sandbox -C <worktree> -` | stdin (`-`) | `-o` file; usage and the thread id from `--json` events | `exec resume <threadId> -` |
   | Claude Code | `-p --output-format json --json-schema <schema> [--model <m>] [--effort <e>] --dangerously-skip-permissions --session-id <uuid>` | stdin | the JSON result on stdout (`structured_output`, `usage`, `is_error`) | `-p --resume <uuid>` |
   | agy | `-p --input-format stream-json --output-format json --json-schema <file> [--model <m>] [--effort <e>] --dangerously-skip-permissions --print-timeout 0` | one NDJSON message on stdin | JSON on stdout | `--conversation <id>` |

   Every flag above is in the CLI's own `--help` on this PC (2026-11-14). The result field names and the agy conversation id are confirmed by CW0 before CW2 pins them.
3. **Environment.** The Runner's child environment for that owner (child-environment.ts), so sensitive names are dropped and the Playwright CLI variables and PATH entries are set (playwright-cli.ts:413-428). The CLI keeps the user's own configuration (its skills, MCP servers, hooks, project instruction files), as when the user runs it. `AIBOARD_MCP_DEPTH` is set to 2 for a CLI process (§3.11).
4. **Wait.** Until the CLI exits, the attempt's deadline (`maxMinutesPerAttempt`, inside the Build's time budget), or the assignment's abort signal. A deadline or abort signals the process and then stops the owner (§3.11). Output is read in bounded pages and streamed to Run details as a live tail (live-model-output.ts).
5. **Stop.** `closeAgent(owner)` stops everything the CLI left running (a dev server, a watcher, the Playwright CLI session). Only a verified stop continues. An unverified stop never submits: the run pauses with `process_stop_unproven:<taskId>` and keeps the worktree claim (§3.11, case 2).
6. **Collect.**
   - Undo the CLI's commits (§3.7).
   - Restore any `docs/project/**` change from the baseline and add a concern naming the paths (CWD-7).
   - Compare the project folder's HEAD, index and status with the snapshot taken before the launch. A change is recorded as `projectChangedDuringAttempt` on the attempt and shown to the Architect; it is a fact, not a refusal.
   - Record a durable `worker.cli_attempt_recorded` event: provider, CLI version, model, CLI session id, exit code, outcome or failure kind, the bounded summary, `replacedCliCommits`, `restoredProjectDocs`, `projectChangedDuringAttempt`, token usage when the CLI reported it.
7. **Map the outcome.**
   - `done` → re-run the checks (§3.6), then submit through the shared submit function.
   - `needs_decision` → the shared `ask_architect` path; the loop status is `waiting_for_architect`. After the answer, the next run resumes the CLI session with the Architect's guidance from the new context pack.
   - `cannot_do` → the shared `request_replan` path.
   - No result, or an unreadable one → a CLI failure (§3.8).
   - A failure → `suspended` with `provider_error`, which the driver's existing failover handles (native-worker-driver.ts:457-487).
8. **Shared lifecycle functions.** The bodies of `submit_task` (worker-runtime.ts:337-463), `ask_architect` and `request_replan` (worker-lifecycle-tools.ts:302, :357) move into functions both paths call. The API worker's tools call them unchanged, so their tests stay as they are.
9. **Usage.** One budget-ledger entry per CLI run: tokens when the CLI reports them, cost 0 under `account_not_metered`. The USD cap does not bind CLI work; the time limits do (CWD-5). Re-runs count as validation time, as any worker's evidence commands do.
10. **Restart.** After a Runner restart, the driver runs the persisted assignment again (native-worker-driver.ts:201-209). For a CLI it starts a new process that resumes the recorded CLI session, or starts fresh with the handoff section when none was recorded. The previous process's residue is reconciled by the existing startup recovery; nothing new. One exception: an attempt with a recorded `worker.cli_stop_unproven` and its claim still kept never starts a new CLI process. It retries the stop first (§3.11, case 2).

### 3.6 Runner re-runs for evidence
The CLI's checks are claims. The Runner re-runs each one, after the CLI stopped and after §3.5 step 6, so the evidence matches the tree it submits (change-set.ts:130-136).
- Each check runs through the same path as `run_evidence_command` (evidence-tools.ts:147): one executable with arguments, no shell, cwd inside the worktree, with its `outputs` kept as artifacts (VF6). The record's actor is the assigned worker and its attempt (evidence-store.ts:126-137), so the submission rule holds (acceptance-contracts.ts:302-306), and the fact carries `source: "runner_rerun_of_cli_claim"`, so the Architect sees who ran it.
- A check whose executable is missing is `not_run: tool_missing` through VF2's lookup, never a failure.
- A check that is a shell line (`a && b`, pipes, redirection) is not run; the result lists it as "not re-run: shell line" and the next prompt asks for single commands.
- Each re-run gets the task's remaining validation budget as its timeout, capped at 10 minutes. A long suite, such as this repository's `npm run test:runner-v2` (hours), times out and is recorded as timed out. The Runner names no project command; the preamble asks for targeted checks (2026-11-03 plan §6.5; principle 1 of the verification plan).
- **Criterion links.** A check with `criterionIds` links its evidence to those criteria. When a criterion has no linked re-run, or a re-run failed, the CLI gets a **fix round**: its session resumes with the re-run results and the missing criteria. One fix round by default (CWD-3). If the gap remains, the attempt fails with `cli_checks_unsupported` or `cli_checks_failing`, and the existing attempt rules requeue the task (another worker, demotion after two failed attempts, native-worker-driver.ts:784-812).
- A re-run that changes tracked files is recorded, and those files are restored before the commit, so the submitted tree is the one the CLI left.
- The CLI's `summary`, `notRun` and `concerns` become the submission's summary and `unresolvedConcerns`, and the validation-scope claim, marked as the CLI's report.

### 3.7 Commit handling
At Full access the CLI can commit on the task branch, because the worktree's HEAD is that branch; "do not commit" is only a prompt rule.
- Before the launch, the Runner records the branch tip: the baseline, or its own last commit on that attempt.
- After the stop, a new WorkspaceManager method `undoForeignCommits(workspace, recordedTip)`:
  - refuses an unsettled merge, rebase, cherry-pick or revert (the same list as workspace-manager.ts:335-338);
  - refuses when HEAD is detached, is not the task branch, or `recordedTip` is not an ancestor of HEAD (the CLI rewrote history or switched branches): the attempt fails with `cli_history_rewritten`, nothing is submitted, and the worktree is kept for the next attempt;
  - otherwise moves the branch back to `recordedTip` with a compare-and-set `update-ref` and leaves the index and working files as they are, so the whole change goes through the guarded commit and its secret check;
  - reports the number of replaced commits as `replacedCliCommits`.
- SB4b reuses this method for its model-commit fold-back (2026-11-03 plan §12.3); it gets a filesystem-owner review entry like WorkspaceManager's other methods.
- Pushes, tags and other refs the CLI created are outside the worktree's commit. The preamble forbids them; the Runner cannot stop them at Full access (§6, risk 6).

### 3.8 Failure mapping and cooldowns
Each adapter classifies a CLI failure into a `ProviderFailure` (provider-health.ts:10-15). The driver then records it, cools the provider down and fails over exactly as for an API worker.

| CLI signal | Kind | Cooldown |
|---|---|---|
| Codex "You've hit your usage limit" (prose, exit 1, no `-o` file; owner logs); agy exit 3 with "Resets in 4h53m36s" or a weekly cap; Claude Code `is_error` with a usage-limit message or `rate_limit_event` naming a reset | `usage_limit` | the stated reset, else 1 h |
| `codex login status` or `claude auth status` not logged in; agy `models` failing with a login message; an auth error in the run | `authentication` | 24 h, ended by a passing Test |
| The model is not available (Codex `model_not_found`, an unknown Claude or agy model) | `authentication` | 24 h, ended by a passing Test: the owner must fix the setup |
| A rate-limit (429) message | `rate_limit` | 1 min |
| A server error or overload message | `provider_unavailable` | 5 min |
| A crash, a non-zero exit with no result, or an unreadable result | `transient` | 30 s after two in a row |
| The executable is gone mid-Build | `authentication` | 24 h, ended by a passing Test |
| The attempt's deadline, or the Build was cancelled | not a provider failure: the attempt fails, or `cancelled` | — |

- A reset time counts only when the CLI stated it (a duration or a clock time in its own output). It sets `retryAfterMs`. agy's `retryable: true` is ignored. A guessed reset never sets one (2026-11-03 plan §5.5).
- Mapping a model error to `authentication` rather than `invalid_request` is deliberate: `invalid_request` never fails over (native-worker-driver.ts:814-816), and a mistyped CLI model should hand the task to another worker, not fail it.
- Patterns are pinned against fixtures captured from real output in CW0. A message no pattern matches is `transient`, never a silent success.

### 3.9 Handoff in both directions
Failover keeps the task, the attempt, the worktree and the session id (native-worker-driver.ts:203-209, :484-486). An API worker that takes over from another API worker inherits the conversation. Across a CLI boundary neither side can read the other's conversation, so the Runner writes a handoff summary from facts it holds.
- **API → CLI** (and CLI → another CLI): the CLI prompt gets an "Earlier work on this task" section: the previous worker and why it stopped; its last assistant text or CLI summary, at most 2,000 characters; the changed files with line counts from `git diff --numstat <baseline>` in the worktree; the evidence ids already recorded for this attempt; and "do not repeat completed work".
- **CLI → API**: the driver adds one continuation message, built from the latest `worker.cli_attempt_recorded` event, with the same fields. The API worker then continues on the existing resume path (native-worker-driver.ts:752-772).
- **The same CLI again**, after its cooldown or a fix round: the recorded CLI session resumes (§3.5 step 2), so that CLI keeps its own context.
- The handoff summary is a claim, labelled as written by the previous worker; the file list and evidence ids are facts.

### 3.10 Browsing
CLI workers browse like every other role, with the Playwright CLI the Runner ships (VF7b, VD-6). The Runner trusts only what it re-runs and its own final check (verification plan §4.8).
- A CLI cannot run the Runner's `process.start`, and a session it started from its own shell is not recognized as the session process, so on POSIX its browser is checked only at the run's removal (verification plan §9, VF7b item 6b). So the Runner starts the worker owner's session, `playwright-cli-session`, as a managed process for that owner before it launches the CLI, when the inventory recorded a browser the CLI can use (CWD-2). The CLI's `playwright-cli` commands then reach it through the environment and PATH the Runner sets for the owner (playwright-cli.ts:413-428).
- The preamble says the session is running, points to the AIBoard skill file the Runner ships for it (runner-v2/skills/playwright-cli/SKILL.md, by its absolute path in the Runner install), and asks for screenshots and snapshots as check `outputs`, so a re-run keeps them as evidence (VF6).
- The session stops with the owner (§3.5 step 5), with VF7b's POSIX browser check unchanged. Session ownership is unchanged: it is the same owner the CLI runs as.
- The CLI's own server, if it started one, stops when the attempt stops. The Architect can start the app in its own copy during review (VF5).

### 3.11 Process ownership and cleanup
No fencing rule changes. One ownership rule gets stricter: a CLI attempt whose stop is not proven keeps its worktree claim (case 2 below), where today every pause and every failure releases the claim. A CLI is one more managed process; what is new is that it starts many descendants.
- **Ownership.** The CLI is started by `ManagedProcessService.start` for the worker's owner, so it runs in the backend's containment: a Windows job object, or a POSIX process group under the portable supervisor. Its descendants (shells, test runners, MCP servers, dev servers) inherit it.
- **Stop.** After every exit, deadline, abort or Runner shutdown, `closeAgent(owner)` stops the owner's processes, and the attempt continues only on a verified stop. Nothing outside the owned containment is ever signalled, and the host's processes are never enumerated (DECISION 2026-09-19 §8).
- **Escapes.** A POSIX descendant that leaves the process group (setsid, daemonizing) is outside what the Runner can prove or stop, as for a command an API worker starts at Full access today. CW0 measures whether any of the three CLIs does this in normal use. If one does by design, CLI workers for that CLI are refused on that OS until a design amendment, which fails closed.
- **Recursion.** The CLI process gets `AIBOARD_MCP_DEPTH=2`, the local MCP door's limit (child-environment.ts:87), instead of the Runner's depth + 1. So a user-configured `aiboard mcp serve` inside the CLI refuses with `local_mcp_recursion_limit` (local-stdio-mcp.ts:102-103), and a later `aiboard exec` refuses by depth (2026-11-03 plan §11.4), and no AIBoard → CLI → AIBoard loop forms. It is a Runner-set value: a tool cannot override it (child-environment.ts:171). This binds cooperating processes only, like every depth rule.
- **Review.** CW5 and CW8 touch process ownership: each gets an independent review, recorded in its pull request, and keeps the affected portable coverage. CW5's review covers the scheduler's claim-keeping pause (case 2) as an ownership change.
- **A Runner failure is not a CLI failure.** A launch, stop or browser session start the Runner cannot prove (a fence claim that runs out of time, a launch blocker, an unknown descendant inspection, a session start that fails its wait) is recorded on the attempt as the Runner's own failure. It never goes to the CLI's provider health, so it never cools a CLI down or fails its task over to another worker.
- **What main does today.** A worker attempt whose cleanup throws `process_cleanup_unverified` reaches the scheduler's catch-all, which records the task `failed` with the error's message (task-scheduler.ts:484-487). Recording a failure releases the packet claim as `"stopped_fenced"` (task-scheduler.ts:606-616), and the Architect then gets `task_failure_resolution_required` (build-runtime.ts:2125-2135). A `paused` outcome also releases the claim as `"stopped_fenced"` before it appends `run.paused` (task-scheduler.ts:590-604). There is no pause for worker attempts that keeps a claim. The CLI design uses the three cases below instead and never relies on that release (risk 11).
- **Case 1: the launch is not proven and nothing started.** For example, the fence claim at launch runs out of time, or a launch blocker refuses the start. The attempt ends `failed` with `process_launch_unproven:<code>`, and the CLI's health is untouched. The claim release is correct here, because no process ran. The Architect gets the failed task as for any failure and can retry it. With health untouched and the task's affinity kept, a retry usually goes to the same CLI, which is right, because the CLI did not fail. A second `process_launch_unproven` in the same run pauses the run with `process_launch_unproven_repeated:<code>` instead of failing again. On a loaded host the owner sees the cause in "Needs you" instead of attempts being spent.
- **Case 2: the stop is not proven.** The CLI or something it started may still be running and writing to the worktree. Nothing is submitted. Before pausing, the driver records `worker.cli_stop_unproven` (task, attempt, owner, the CLI's exit or deadline so far). The run then pauses with `process_stop_unproven:<taskId>`, and the scheduler keeps the worktree claim: this reason is the one pause that does not call `releasePacketClaim`. On resume, the driver runs `closeAgent(owner)` again before anything else, and does not start a new CLI process. A proven stop releases the claim as `"stopped_fenced"`, and the attempt continues from Collect (§3.5 step 6) with the outcome it had. A stop still not proven leaves the run paused, with the claim kept. Retrying the task on another worker while the stray process may still write is the risk this case exists to prevent.
- **Case 3: the browser session start fails.** For example, the `until.pattern` wait trips (§3.11a). The run does not pause. The failure is recorded on the attempt, the CLI runs without a browser and the preamble says so, and the CLI's browser checks are `not_run`. The start is never retried with a longer bound.

### 3.11a Open process follow-ups that touch CLI workers
Three follow-ups are open on main (#205's body; docs/plans/2026-11-13-build-verification.md §9). CLI workers add load and launches, so they meet them more often. This plan does not fix them, raises no bound to avoid them, and treats each as fail-closed behavior to report, not to work around.

| Follow-up | Where | What a CLI worker sees | How this plan handles it |
|---|---|---|---|
| The Windows owned-fence claim's 2 s default can run out in the SQLite open on a loaded host (`open 1750 ms`, one case in 32 on main) | owned-fence-lock.mjs, used by the Windows Job host | A CLI, its tests, the Runner's re-runs, a browser session and parallel CLI workers load the host; a claim at launch or stop then fails closed | A claim that fails at launch is case 1 (§3.11): the attempt fails with `process_launch_unproven`, and a second one pauses the run. A claim that fails at stop is case 2: the run pauses with `process_stop_unproven` and keeps the worktree claim. Neither counts against the CLI. CW0 records how often claims fail with several CLI workers on Windows. CW5 pins the mapping with an injected fence failure at launch and at stop. If CW0 shows it often, it is raised with the owner as a fencing change with its own review, not folded into a CLI packet. |
| `process.start`'s `until.pattern` 50 ms evaluation bound is wall-clock time, so a plain pattern can trip it on a loaded host and fail a session start | managed-process-wait.ts:100, :115-118 | The Runner-started Playwright CLI session waits on "Daemon listening on" (§3.10), on a host the CLI is loading | Case 3 (§3.11): no pause. A failed session start is recorded on the attempt, and the CLI runs without a browser; the preamble says so, and the CLI's browser checks are then `not_run`. It is never retried with a longer bound. The CLI's own launch waits for exit and uses no pattern. |
| The Windows launch cleanup reads `handledControl` outside its fence | native-process-backend.ts:890-891 | A CLI cancelled or failing during its launch on Windows; one force request can be dropped as already handled, which leaves the stop unproven | Case 2 (§3.11): the stop fails closed, nothing is submitted, and the run pauses with `process_stop_unproven` and keeps the worktree claim. CW5's Windows "cancel during launch" test accepts either a proven stop or that pause until the follow-up lands, and records which one it saw. |

VF4b (a final-check browser session) is being built in parallel and is not on main. This plan cites none of it. CW8 starts the CLI worker's session through the worker's own owner, which VF7b already supports; if VF4b changes how owners map to sessions, CW8 rebases on it.

### 3.12 Full access only
- A Build whose crew has a CLI worker starts only under the `full` permission profile (contracts.ts:3). Otherwise the start is refused with `cli_workers_require_full_access`, and the web shows CLI rows as unavailable with that reason (OD-36).
- The CLI runs with its own permissions bypassed (`--dangerously-bypass-approvals-and-sandbox`, `--dangerously-skip-permissions`), because a headless CLI's prompts cannot be answered through AIBoard. Settings says so once, before the first enable: "This CLI runs any command as you, in the task's worktree, with its own permission prompts turned off." The acceptance is stored as `consentedAt`.
- The submission's scope, secret and `docs/project` checks still run. Writes outside the worktree are not caught; the project-folder comparison of §3.5 step 6 records the obvious case.

### 3.13 Crew rules
- CLI runtimes are workers only. The factory refuses a CLI runtime as Architect or reviewer with `cli_runtime_role_refused`, and leaves CLI runtimes out of the Architect and verifier routers and the verifier list (native-build-factory.ts:1235-1247; lib/client/native-build-engine.ts:518). No `AgentModel` is built for them (native-build-factory.ts:1262-1269); the driver's CLI branch runs before its model lookup (native-worker-driver.ts:227-231).
- A crew of only CLI workers is allowed; the Architect is an API model.
- Capabilities: a CLI runtime declares the worker capabilities a task can require; image input is off (the prompt is text).

## 4. What does not change
- The Architect's prompts, tools, planning, plan critique and review.
- The scheduler, worktrees, integration, final checks, verifiers and the handoff snapshot. The one exception is the scheduler's claim-keeping pause for `process_stop_unproven` (§3.11, case 2); every other pause and failure releases the claim as today.
- The evidence rule for submissions, and the Architect's override with a reason.
- Fencing, containment and cleanup rules. Ownership changes only by getting stricter in case 2.
- API workers: their tools, prompts and tests. The shared lifecycle functions keep their behavior byte for byte.
- The provider-health kinds and their default cooldowns.

## 5. Packets

Verification rules for every packet:
- The targeted tests named below, plus `npm run typecheck:runner-v2`. Packets that add imports in runner-v2/src also run `npx tsx scripts/release/test-bundle-closure.mts`. Web packets also run root `npx tsc --noEmit` and `npm run lint`.
- The full `test:runner-v2` runs only at the gate (CW10), by CI or the owner.
- Tests use fake CLIs: small Node scripts that read argv and stdin and print recorded output shapes (CW0's fixtures). No test starts a real CLI or sends a prompt. A fake CLI that leaves a grandchild running joins the portable contract job, kept to a few seconds, so PR CI stays near 3 minutes per job.
- A module that newly imports a mutation-capable `node:fs` API updates test/filesystem-mutation-routing.test.ts and adds a filesystem-owner review record (AGENTS.md).
- Each packet is a pull request against main, reviewed and merged before the packets that depend on it start.

| Id | Title | Depends on | Days | Targeted tests | Acceptance |
|---|---|---|---|---|---|
| CW0 | Spike, no product code: each CLI run headless under the Runner's managed-process containment on Windows, macOS and Linux (Docker) on a toy repository; a written report with the result and usage shapes, the session or conversation id and resume, the exit codes, which descendants each CLI starts and whether any leaves the POSIX process group, and recorded output fixtures (success, needs-decision, a crash; a real usage-limit or logged-out output when one is available, else the owner's logs) | owner's go to spend quota (CWD-1) | 0.5–1 | a throwaway harness outside runner-v2/src | • the report confirms every flag in §3.5 or names the replacement<br>• fixtures for each CLI, scrubbed of account fields<br>• the descendant and process-group finding per CLI and OS<br>• on Windows, how often a fence claim fails at launch or stop with two and four CLI workers at once (§3.11a) |
| CW1 | Contracts and home settings: `transport: "cli"` in `RunnerProviderConfig` with its validation and HM3 pass-through; the home `cliWorkers` section, validators, op paths, and `capabilities.cliWorkers` on `/v2/home` | — | 1.5–2 | new test/cli-worker-config.test.ts, test/aiboard-home-store.test.ts, test/control-server-home.test.ts, scripts/test-settings-home.mts | • a `cli` config with a secret, base URL, token or `secretSource` is refused; one without them is stored as pushed<br>• the `cliWorkers` section round-trips; a writer that predates it keeps it verbatim<br>• a model id or effort outside the charset is refused<br>• no secret field exists in the section |
| CW2 | CLI adapters (pure): lookup, free-check parsers, argument and prompt builders, result and usage parsers, failure classifier, for Codex CLI, Claude Code and agy; the fake CLIs | CW0, CW1 | 2.5–3 | new test/cli-worker-adapters.test.ts with fixtures under test/fixtures/cli-workers/ | • every row of §3.8 pinned on a fixture; an unknown message is `transient`<br>• a reset is set only from a stated time; agy's `retryable` ignored<br>• argv never contains prompt text; arguments match §3.5<br>• the free-check parsers keep only the named fields; a canary e-mail never leaves the parser |
| CW3 | Detection and the Test button: `GET /v2/cli-workers` (free checks, 60 s cache), `POST /v2/cli-workers/<id>/test` in a Runner-owned empty folder, the result saved to the home, a passing test ending the provider's cooldown in the Runner's Builds (and for API key tests, CWD-4) | CW2 | 1.5–2 | new test/control-server-cli-workers.test.ts, test/native-build-manager.test.ts, test/filesystem-mutation-routing.test.ts | • each `lastTest.outcome` reached with a fake CLI<br>• the test folder is removed after a verified stop and kept on an unverified one<br>• a cooldown ends in a running and in a paused Build, through a durable event<br>• the test runs in the CLI's restricted mode, never with the bypass flags |
| CW4 | Crew rules and the Build start: workers only (`cli_runtime_role_refused`), out of the Architect and verifier routers and the verifier list, no `AgentModel`; `cli_workers_require_full_access`; the free checks before planning (`cli_workers.checked`) feeding provider health | CW1, CW2 | 1–1.5 | test/native-build-initialization.test.ts, test/native-build-capabilities.test.ts, test/runtime-router.test.ts, test/verification-inventory.test.ts, scripts/test-native-build-policy.mts | • a CLI as Architect or reviewer is refused; never a verifier<br>• a Build with a CLI worker under `project` or `guarded` is refused before planning<br>• a logged-out CLI is unhealthy before the first assignment, and the Build proceeds on its other workers |
| CW5 | The CLI worker loop: the driver branch, prompt and preamble, launch as the worker's owner with stdin, wait and deadline, verified stop, `undoForeignCommits`, `docs/project` restore, the project-folder comparison, `worker.cli_attempt_recorded`, shared submit, ask and replan functions, usage entries, live tail, restart resume, `AIBOARD_MCP_DEPTH=2` for the CLI; an independent review | CW2, CW4 | 4–5 | new test/cli-worker-runtime.test.ts, test/native-worker-driver.test.ts, test/task-scheduler.test.ts, test/build-runtime.test.ts, test/worker-runtime.test.ts, test/workspace-manager.test.ts, test/child-environment.test.ts, test/local-stdio-mcp.test.ts, test/live-model-output.test.ts, test/filesystem-mutation-routing.test.ts | • each outcome (done, needs_decision, cannot_do, no result) reaches the matching loop status<br>• a fake CLI that leaves a grandchild: stopped and proven stopped; an unverified stop never submits<br>• a CLI commit is undone and its content submitted through the guarded commit; a secret committed and removed is caught; a rewritten history fails the attempt<br>• `docs/project` restored and reported<br>• `aiboard mcp serve` under the CLI refuses<br>• case 1: an injected fence failure at launch ends the attempt `failed` with `process_launch_unproven:<code>`, the CLI's health unchanged, and the Architect gets `task_failure_resolution_required`; a second one in the same run pauses the run with `process_launch_unproven_repeated`<br>• case 2: an injected fence failure at stop submits nothing, records `worker.cli_stop_unproven`, pauses the run with `process_stop_unproven:<taskId>`, and keeps the worktree claim (no `"stopped_fenced"` release); on resume the stop is retried before anything else and no new CLI process starts; a proven stop releases the claim and continues from Collect; a stop still unproven stays paused with the claim kept<br>• case 3: a failed browser session start does not pause; the CLI runs without a browser and its browser checks are `not_run`<br>• in all three cases the CLI's provider health is unchanged (§3.11, §3.11a)<br>• every other pause and failure still releases the claim as today (task-scheduler.ts:590-616)<br>• Windows cancel during launch: a verified stop, or the case 2 pause until the `handledControl` follow-up lands, never a submission<br>• API worker tests unchanged<br>• the independent review recorded |
| CW6 | Evidence re-runs: the CLI's checks through the `run_evidence_command` path as the assigned worker, with `outputs` and `source`; `tool_missing`; shell lines not run; the timeout rule; criterion links; the fix round; restoring files a re-run changed | CW5 | 1–1.5 | new test/cli-worker-evidence.test.ts, test/evidence-tools.test.ts, test/worker-runtime.test.ts | • a CLI-reported check becomes Runner evidence that satisfies the submission rule; an unreported criterion triggers one fix round, then `cli_checks_unsupported`<br>• a failing re-run after the fix round fails the attempt and requeues the task<br>• a missing tool is `not_run`, never a failure<br>• the submitted tree equals the tree the evidence was recorded on |
| CW7 | Failure mapping into failover, and the handoff both ways: the adapter's failure through `provider_error`; the API → CLI prompt section and the CLI → API continuation message; same-CLI session resume | CW5 | 1.5–2 | new test/cli-worker-handoff.test.ts, test/native-worker-driver.test.ts, test/runtime-router.test.ts | • a CLI out of usage hands the task, in the same worktree, to an API worker that gets the summary and the file list<br>• an API worker out of usage hands it to a CLI that gets the same<br>• no healthy worker left: `all_worker_runtimes_unavailable`<br>• every Codex worker cools down together |
| CW8 | Browsing: the owner's Playwright CLI session started before the CLI when the inventory has a browser, the preamble's browsing lines and skill path, stopped with the owner; an independent review | CW5 | 1–1.5 | test/playwright-cli-session.test.ts, test/cli-worker-runtime.test.ts, test/runner-resource-cleanup.test.ts | • a fake CLI's `playwright-cli` call reaches the owner's session; its screenshot becomes evidence through a re-run's `outputs`<br>• no browser left after the attempt on every stop kind<br>• no session when no browser was recorded<br>• a session start that fails (an injected `until.pattern` bound error) is recorded, the CLI runs without a browser, and its browser checks are `not_run`; the bound is not raised<br>• the independent review recorded |
| CW9 | Web: Settings > Providers "CLI workers" group (free checks, Refresh, model and effort, consent note, Test with its reasons, saved through `home-client.ts`); the crew picker's CLI rows (workers only, Full access, health); Run details' CLI attempt card with the live tail, version, outcome, replaced commits and re-runs | CW1, CW3, CW5 | 2–2.5 | new scripts/test-cli-workers-ui.mts, scripts/test-settings-home.mts, scripts/test-build-live-state.mts, scripts/test-build-ui-overhaul.mts, `npx tsc --noEmit`, `npm run lint` | • a CLI cannot be picked as Architect or reviewer, or under less than Full access<br>• the Test reasons and the reset time are shown<br>• `home-client.ts` stays the only settings writer<br>• no account field is shown |
| CW10 | Gate and docs: the Runner guide's CLI workers section, AGENTS.md and CLAUDE.md lines, this plan's status, the 2026-11-03 plan's §6.5 note; the owner's real Build with each CLI | CW1–CW9 | 0.5–1 | `npm run typecheck:runner-v2`, root `npx tsc --noEmit`, `npm run lint`, the targeted tests above; the full `test:runner-v2` by CI or the owner | green, or fixed forward; the owner's real run per CLI listed as done or pending |

### 5.1 Estimate
17–23 days: the sum of the packet rows above (lows 0.5 + 1.5 + 2.5 + 1.5 + 1 + 4 + 1 + 1.5 + 1 + 2 + 0.5 = 17, highs 1 + 2 + 3 + 2 + 1.5 + 5 + 1.5 + 2 + 1.5 + 2.5 + 1 = 23). The 2026-11-11 design estimated 13.5–17.5 days, plus 1–2 for browser replay, so 14.5–19.5 in all; this plan is +2.5–3.5 days over it. The differences:
- the home section and its op paths (CW1, about +0.5–1), which the design predates;
- the spike (CW0, +0.5–1), because three CLIs' output shapes and process trees drive the parsers and the ownership review;
- browsing through the Runner-started Playwright CLI session (CW8, 1–1.5), which replaces the 1–2 days of browser replay (0 to −0.5);
- the independent reviews of CW5 and CW8, and the docs gate (CW10, +0.5–1);
- the three Runner-failure cases (§3.11) in CW5, about +0.5: the scheduler's one claim-keeping pause, `worker.cli_stop_unproven` and its resume path, and the repeated-launch counter, with their tests in task-scheduler.test.ts and build-runtime.test.ts.

Those items add +2–2.5. The design gave only a total, not a split per packet, so the remaining +0.5–1 can't be traced to one item: the packet rows here were set from this plan's scope, not by adjusting the design's figures.

### 5.2 Order
- CW0 first; it needs the owner's go (CWD-1). CW1 can run beside it.
- Then CW2, then CW3 and CW4 in parallel (different files).
- Then CW5, then CW6, CW7 and CW8 in parallel, each in its own worktree; CW6 and CW7 both touch native-worker-driver.ts lightly, so the second rebases on the first.
- CW9 after CW5 (it can start on CW1 and CW3 for Settings).
- CW10 last.

### 5.3 Steps that stay with the owner
- The go for CW0's real prompts (CWD-1).
- A real Build with each CLI as a worker, on a toy project, before CW10 closes.
- Pushes, merges, releases, and the full suite at the gate.
None of these blocks a later packet's code; CW10 lists the ones still pending.

## 6. Risks
1. **CLI output drifts.** All three CLIs changed versions within three days on this PC. Parsers keep to documented JSON fields where they exist, record the CLI version on every attempt, and fail to `transient` on anything unknown, never to success. The Test button shows a broken parser at once.
2. **Quota messages are prose.** Codex reports its usage limit only as prose with exit 1, and agy marks even its weekly cap retryable (2026-11-03 plan §2.1, owner logs). A missed pattern costs a 30 s cooldown and a retry, not a wrong result; CW0's fixtures pin the known ones.
3. **Descendants that leave the POSIX process group.** The Runner cannot prove them stopped. CW0 measures it; a CLI that does it by design is refused on that OS.
4. **Tests run twice.** The CLI runs its checks, then the Runner re-runs them. This is the price of recording facts; the preamble asks for targeted checks, and re-runs are bounded by the validation budget.
5. **Prompt rules a CLI ignores.** At Full access a CLI can commit, push, edit `docs/project`, or write outside the worktree. Commits are undone, `docs/project` is restored, the project folder is compared, and the secret check runs on the whole change. Pushes and writes elsewhere are disclosed, not prevented (OD-36).
6. **Credentials in reach.** A Full-access CLI runs as the user and can read the user's files, as an API worker's shell can at Full. AIBoard adds no credential to its environment, and drops sensitive names from it (child-environment.ts:302-305).
7. **The user's own CLI configuration.** Hooks, plugins and MCP servers the user configured run inside Builds. That is how the user runs the CLI (OD-35); the depth rule keeps AIBoard's own MCP door out.
8. **USD budgets.** CLI use is unmetered, so a USD cap does not bind it. The crew picker says so; the time limits apply.
9. **Open process follow-ups under more load.** The Windows fence's 2 s SQLite open, the wall-clock `until.pattern` bound and the Windows launch cleanup's unfenced `handledControl` read (§3.11a) all fail closed, so the cost is attempts that fail (case 1), runs that pause (cases 1 and 2), or attempts that run without a browser (case 3), not unowned processes. CW0 measures how often; a fix is a fencing change with its own review, outside this plan.
10. **Vendor terms.** Settled by OD-35: each CLI is used as its vendor supports, for delegated work, with the user's own CLI and login, on the user's machine, never over Remote.
11. **The `"stopped_fenced"` release after a thrown cleanup error.** On main, any error a worker driver throws, `process_cleanup_unverified` included, is recorded as `failed` (task-scheduler.ts:484-487). Recording it then calls `releasePacketClaim(taskId, "stopped_fenced", …)` (task-scheduler.ts:606-616), so a stop that was not proven is labelled stopped. Whether that is fail-open is being investigated separately for API workers; this plan changes no product code for it. The CLI design never relies on that release: an unproven CLI stop returns the case 2 pause, which keeps the claim (§3.11), and never throws into the catch-all. If the investigation changes the release for every worker, CW5 rebases on it, and case 2 stays the CLI's path.

## 7. Owner decisions still open

| Id | Question | Recommendation |
|---|---|---|
| CWD-1 | Who runs CW0's real prompts, which spend a little quota on each CLI? | The owner says "go" in words to the CW0 session, for at most ten short prompts per CLI on a toy repository with the owner's own logins. The alternative is the owner running the harness by hand. |
| CWD-2 | When does the Runner start a CLI worker's browser session? | Before every CLI attempt when the inventory recorded a usable browser. It costs a second or two and some memory per attempt, and it keeps the browser under the Runner's ownership. The alternative, the CLI starting `playwright-cli-session` from its own shell, is checked only at the run's removal on POSIX. |
| CWD-3 | How many fix rounds after a failing or missing re-run? | One. A second round rarely helps a CLI that ignored the first; the task then moves to another worker. |
| CWD-4 | Does a passing Settings test also end an API provider's cooldown? | Yes, for both, through the same route: today nothing ends an `authentication` cooldown early, so a fixed key stays skipped for 24 hours. |
| CWD-5 | A Build with a USD cap and CLI workers: allow or refuse? | Allow, with a note in the crew picker that CLI use is not counted toward the USD cap and the time limits apply. |
| CWD-6 | The default time limit for one CLI attempt? | 45 minutes, editable per CLI in the home (5–240), always inside the Build's time budget. The owner's Codex runs took 8–27 minutes per success. |
| CWD-7 | A CLI edits `docs/project/**`: restore and report, or fail the attempt? | Restore from the baseline and report it as a concern. Failing the attempt would throw away the rest of the work. |
| CWD-8 | Where does Settings show CLI workers? | A "CLI workers" group in the Providers tab, because the free checks and the Test button work like a provider's. |
| CWD-9 | Model choice for Codex CLI and Claude Code, which cannot list models | "CLI default" (no model flag) plus a typed id, checked only by the Test button. agy lists its models. |

## 8. Status

| Packet | State | Pull request |
|---|---|---|
| CW0–CW10 | Waiting for the owner's approval of this plan | — |
