# AIBoard Remote T1: interaction UX for running processes (pre-beta)

Date: 2026-11-03
Status: NOT STARTED. Owner decision D19 (2026-11-03): T1 lands before the Stage 1 closed beta.
Design: `docs/superpowers/specs/2026-11-03-runner-v2-interactive-sessions-design.md`, Leads 1–2. That file is gitignored and local only; this plan restates everything an implementer needs.
Parent plan: `docs/plans/2026-10-27-aiboard-remote.md` (T1 is added to the Q3 Stage 1 gate).

## 0. Rules for implementers

- Read `CLAUDE.md`, §0 of the parent plan, N1/N2 in `docs/plans/2026-10-26-native-tools-and-extension-management.md:50` and this file in full.
- Runner authority does not change. Everything stays inside ToolBroker → ExecutionHost → the existing supervisors. Add no new process host, no shell route and no raw handle or PID access. N1's write semantics (`acknowledged | rejected | outcome_unknown`, never replayed) are untouched.
- Everything is additive. A `process.read_output` call without `until` behaves exactly as it does today (it returns on any new byte), so Build workers and existing clients don't change.
- Pipes only. T1 adds no PTY.
- Run targeted tests per slice. Run the broad Runner matrix only at the planned gates; never run the full `test:runner-v2` unasked.
- Security review is mandatory, because T1 touches process input and remote effect admission.

## 1. Why

On this PC, Desktop Commander (DC) 0.3.1 was measured on 2026-11-03 against AIBoard as it stands today:
- **DC misses a program's own prompt.** For `[y/N]` it waited the full timeout.
- **DC misreads progress output.** It took `progress 45% ` for a prompt after 173 ms.
- **AIBoard spends too many calls.** One REPL turn costs at least two calls, and `process_read_output` returns on every new byte, so a build that streams output costs one billed call every few lines (`runner-v2/src/managed-process-output.ts:109`).
- **The common path is run, then poll.** DC's usage stats here show 16,951 `start_process`, 11,936 `read_process_output` and 113 `interact_with_process` calls. Under D6 every call is billed.

T1 fixes all of this with one-call turns and waits that are based on evidence.

## 2. Contract

### 2.1 `until` and `completion`

`until` is optional on `process.start`, `process.interact` and `process.read_output`. Any condition that is met ends the wait, and so does process exit:

```ts
until?: {
  exit?: true;            // only exit (and waitMs) ends the wait
  pattern?: string;       // §2.4 safe regex over the plain view of the new tail
  port?: number;          // 1..65535: something accepts TCP on 127.0.0.1 or ::1
  idleMs?: number;        // 250..10000; enables input_wait / idle (§2.3)
}
waitMs?: number;          // 0..MANAGED_OUTPUT_WAIT_MAX_MS (30 000, unchanged in T1)
```

Every result that waited returns:

```ts
completion: {
  source: "exited" | "pattern" | "port" | "input_wait" | "idle" | "known_prompt" | "changed" | "timeout";
  confidence: "certain" | "likely" | "heuristic" | null;   // null for changed/timeout
  quietMs?: number; cpuDeltaMs?: number; preexistingPort?: true; matched?: string;
}
state: "running" | "awaiting_input" | "idle" | "exited";
```

`changed` is today's behavior (any new byte). It is the source only when no `until` was given.

### 2.2 `process.interact` (new; remote and local MCP name `process_interact`)

Input: `processId`, `data?`, `appendNewline?` (default `true`), `closeInput?`, `until?`, `waitMs?` (default 15 000), `cursor?`, `stream?`, `maxBytes?`, `view?`. The remote and local MCP callers also pass `idempotencyKey`.

Behavior:
1. **Start offsets.** If `cursor` is omitted, the reader starts from the stream totals observed just before the write, so the result holds output produced from this turn on.
2. **Write.** The write goes through `ManagedProcessService.writeInput` with all N1 semantics. The `writeId` is derived from the call identity: `sha256(idempotencyKey)`, truncated to the `writeId` pattern. The model supplies one ID, not two. Locally, inside Build, `callId` takes the same role.
3. **A write that isn't acknowledged ends the call.** The result is identical to `process.write_stdin`'s result today (`isError: true`, the same error codes). It carries no output and no completion. Remote admission therefore settles it exactly as it settles stdin today.
4. **An acknowledged write is followed by a read.** The read goes through `readOutput` with the `until` predicate. Default `until`: `{ idleMs: 1500 }`.
5. **A read failure after an acknowledged write stays in-band.** The result is `isError: false`, `write` is acknowledged, `read: { error: { code, message } }` and `completion: null`. A read failure must never surface as `result.error` with `process_cancelled` or `tool_timeout`. That would turn a delivered write into `outcome_unknown` (`runner-v2/src/remote-admission-store.ts:1022`).

Output: `{ processId, write, status, exitCode, output (per view), cursor, completion, state, read? }`.

Capability and policy are those of `process.write_stdin`: `assessAccess` returns `{ capability: "process.write_stdin" }`. Read-only mode, shell OFF and per-command approval gate it exactly as they gate stdin. The approval summary shows `data` the same way it does for stdin.

### 2.3 Input-wait evidence

- **`input_wait`** (`likely`) requires all of these at once:
  - the process is running;
  - there has been no new byte on any stream for `idleMs`;
  - the tree's CPU time grew by ≤ 2 % of one core over that window;
  - the last retained byte is not `\n`.
- **Linux upgrade.** On Linux, it becomes `certain` when a tree member is blocked in `read` on the owned stdin pipe. The check matches `/proc/<pid>/syscall` against a readlink of `/proc/<pid>/fd/<n>` to the pipe inode, where permitted. This part is optional in T1.
- **`idle`** (`heuristic`): the same, but either no CPU evidence is available or the tail ends in `\n`.
- **`known_prompt`** (`heuristic`): DC's prompt list (§2.5), and only after `idleMs/2` of quiet. It never fires on the first chunk, which is exactly how DC got its 173 ms false positive.
- **A known limit, stated honestly.** A process sleeping after printing text without a newline looks like `input_wait` (`likely`) after `idleMs` on Windows and macOS. It is never `certain` there, and never reported within `idleMs`. The result carries `quietMs` and `cpuDeltaMs`. Callers that must not stop early pass `until: { exit: true }`.

CPU evidence is a new optional `cpu?: { totalMs: number; sampledAt: string }` on the backend snapshot and evidence. When it's absent, `input_wait` is unavailable and `idle` is the best result.
- **Windows.** The job host's run loops already query `JOBOBJECT_BASIC_ACCOUNTING_INFORMATION` for `ActiveProcesses` (`runner-v2/src/managed-process-job-host.ps1:448`). Add an `accounting` event carrying `TotalUserTime + TotalKernelTime` (in 100 ns units). Emit it at most every 250 ms, and only when the value changed. Do this in both `Run` and `RunInteractive`. The supervisor keeps the latest value in its status, and the transport maps it into evidence.
  - Regenerate the pinned helper assembly hash (`helperAssemblySha256`; see `scripts/runner-v2-package-hashes.mjs`).
- **Linux.** The portable supervisor sums `utime + stime` from `/proc/<pid>/stat` across the process group on its existing tick (`runner-v2/src/portable-process-supervisor.mjs:249`), at most every 250 ms.
- **macOS.** Best effort, CI only. Sample `ps -o time= -g <pgid>` no more than once a second, and only while output has been quiet for ≥ 250 ms. When unavailable, report `cpu` as absent.

### 2.4 `pattern` safety

- **Limits.** At most 256 characters; flags are fixed (`u`, plus an optional case-insensitive variant through `patternFlags: "i"`).
- **Rejected at validation** with `invalid_arguments`: backreferences, lookbehind, and nested quantifiers (`(…+)+`, `(…*)*`, `(…+)*` and similar).
- **Input.** Evaluated on at most the last 4 KiB of the plain view of output produced since the wait began, never on the whole journal.
- **Tests** include the classic catastrophic patterns, which must be rejected rather than run.

### 2.5 Views and process start

- **`view` on `read_output` and `interact`:**
  - `raw` (default, today's slices);
  - `plain`: ANSI CSI/OSC sequences stripped, each line after a `\r` keeps only its final segment, runs of more than 3 identical lines folded to `… (N identical lines)`, invalid UTF-8 replaced;
  - `lines: { start, count }`, where a negative `start` counts from the tail, computed over the retained plain text and reporting `totalLines` and `firstRetainedLine`.
- **`process.run`** gains `view: "summary"` for output larger than 8 KiB: the first 40 and last 80 lines, up to 30 `file:line[:col]` error-looking lines with their line numbers, and the artifact or cursor reference for the rest.
- **`process.start`** accepts `until` and `waitMs` (default 0, which is today's behavior). It does the start, then one read in the same call, and returns snapshot, output, cursor and completion. A wait failure after a successful start stays in-band, with the same rule as §2.2(5).
- **`process.list`** adds `state` and `lastCompletion` from the latest evidence it saw.
- **`process.signal`'s description** says plainly that every signal stops the process (SIGINT is not an interrupt-and-continue in pipe mode).
- **The known-prompt list** reuses DC's public list (`>>> `, `... `, `> `, `$ `, `# `, `% `, `mysql> `, `=# `, `redis> `, the PowerShell `PS …> ` and cmd `X:\…>` forms). It lives in one module with its provenance noted.

## 3. Touch points (grounded at `16927e5f`)

| Area | Files |
| --- | --- |
| Contracts | `runner-v2/src/managed-process-contracts.ts` (evidence `cpu`, completion and state types), `managed-process-transport.ts` |
| Wait predicates, views | `runner-v2/src/managed-process-output.ts`: today's `hasNewOutput` stays as the `changed` predicate; new pure `untilSatisfied`, plain/lines/summary renderers and the pattern validator go in a new `managed-process-wait.ts` |
| Service | `runner-v2/src/managed-process.ts`: `readOutput` passes the predicate into `runtime.readOutput`'s existing `satisfied` hook (`:197`); new `interact`; `start` plus an optional wait |
| Tools | `runner-v2/src/managed-process-tools.ts`: `process.interact` definition, schemas and validators; extended start/read/list/signal |
| Transport | `runner-v2/src/execution-host-managed-transport.ts`: the `assertCall` tool lists at `:48`, `:202` and `:222` accept `process.interact` (and `process.start` for its read); evidence carries `cpu` |
| Windows host | `runner-v2/src/managed-process-job-host.ps1` (accounting event), `managed-process-supervisor.mjs` (status field), `windows-job-process-host.ts` (status validation near `:1239`), helper hash |
| POSIX host | `runner-v2/src/portable-process-supervisor.mjs`, `posix-process-backend.ts` |
| Roles | `runner-v2/src/role-capabilities.ts`: every list holding `process.write_stdin` (`:67`, `:96`, `:105`, `:319`) gets `process.interact`; `runner-extension.ts:79` |
| Remote / local MCP | `remote-connector.ts` (`:145` tool table, `:161` `EFFECT_TOOL_IDS`), `remote-admission-store.ts` (`:957` `REMOTE_EFFECT_NAMES`; at `:1025` the write-status check also matches `process.interact`), `remote-approval.ts` (`APPROVAL_TOOLS`, payload allowlist, summary), `remote-tool-runtime.ts` (`SHELL_TOOLS`, `MUTATING_TOOLS`, `LOCAL_TOOLS` `:345`), `launcher-ipc.ts:309` |
| Docs | `docs/remote/r0/remote-tool-surface.md` (26th tool, gap row `:95`), `docs/remote/r0/runner-tool-catalog.json`, `docs/runner-v2/guide.md` if it lists process tools |

## 4. Slices and staffing

Staffing follows the delegation memory: Codex can't spawn tests on this PC, so the architect runs every test.

| Slice | Scope | Delegate | Depends on |
| --- | --- | --- | --- |
| T1a | Contracts, the wait module (predicates, pattern validator, plain/lines/summary renderers) as pure functions with unit tests | Muse (easy, test-iterative); fallback: architect | — |
| T1b | CPU evidence: Windows accounting event + supervisor + host validation + hash; Linux `/proc` sampling; macOS best effort | Codex (medium, code-centric) | T1a contracts |
| T1c | Service and tools: `until` on read/start, `process.interact`, list state, signal text; transport tool lists; role lists | Codex | T1a |
| T1d | Remote and local MCP wiring: tables, admission unknown-detection, approvals, surface docs and catalog | Codex or Muse Wonder | T1c |
| T1e | Acceptance replays (§5) on real Windows processes, plus WSL2 Ubuntu; calls-per-task measurement; independent review | architect, plus an independent reviewer | T1b–T1d |

Each slice goes on its own worktree and branch, `remote/t1x-…`.

## 5. Acceptance (real processes; Windows and WSL2 locally, macOS in CI)

| # | Scenario | Pass |
| --- | --- | --- |
| A1 | `python -c "input('Proceed with deploy? [y/N] ')"` started with `until.idleMs: 1500` | `input_wait` (`likely`; `certain` on Linux with the syscall check) within 2.5 s; then `interact data:"y"` ends with `exited` |
| A2 | Prints `progress 45% ` with no newline, then a 5 s CPU-busy loop | No early stop: `exited` at about 5 s |
| A3 | The same, but `time.sleep(5)` instead of a busy loop | Windows: `input_wait` `likely`, never before `idleMs`; Linux with the syscall check: `exited`. Both stated in the docs |
| A4 | A node HTTP server listening after 2 s; `process.start` with `until.port` | One call returns `port` `certain`. A port already open before start gives `preexistingPort: true`, `heuristic` |
| A5 | 20 s of streaming output, read with `until.exit` | 1 call (2 calls if it outlasts the 30 s cap). Today's behavior, recorded as the baseline, is one call per chunk |
| A6 | `python -i`: start with `until.idleMs`, then three interact turns, one of which raises | One call per turn; the banner and `>>>` are returned; `known_prompt` or `input_wait` |
| A7 | Write `outcome_unknown` (fault-injected) | No output or completion in the result; the remote job settles `outcome_unknown`, identical to `write_stdin` |
| A8 | Read cancelled after an acknowledged write | `isError: false`, `read.error` set; the remote job is `completed`, not `outcome_unknown` |
| A9 | Catastrophic `pattern` (`(a+)+$`), backreference, 257 characters | `invalid_arguments` at validation; nothing evaluated |
| A10 | `read_output` without `until` | Byte-identical to today's results (regression test against the existing `managed-interactive-io` and output suites) |
| A11 | Policies: read-only, shell OFF, approvals ON | `process_interact` is blocked or approved exactly like `process_write_stdin`; the approval shows the input |
| A12 | `plain` view of a `\r` progress bar (100 updates) and ANSI color output | One final progress line; no escape bytes; `lines` paging consistent with `totalLines` |

Regression suites to run: `managed-interactive-io`, `managed-interactive-native`, `managed-lifecycle-requirements`, `managed-observation-authority`, `streaming-output-v2`, `role-capabilities`, `remote-approvals`, `remote-jobs`, `remote-admission`, `remote-fake-relay`, `local-stdio-mcp`, plus the new suites. Also `npm run typecheck:runner-v2` and `npm run lint`.

## 6. Done means

- A1–A12 pass on Windows and WSL2, with commands and revisions recorded in the STATUS ledger.
- An independent review signs off on the input-effect and admission changes.
- The surface doc and catalog list `process_interact`.
- A staging check with a real Claude or ChatGPT connector replays A1 and A6 through the relay.
