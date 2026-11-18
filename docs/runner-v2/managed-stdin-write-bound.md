# Managed stdin write bound

`MANAGED_INPUT_WRITE_CEILING_MS` (`runner-v2/src/managed-process-contracts.ts`) bounds one managed stdin write. It replaced the fixed 15 s `MANAGED_INPUT_WRITE_TIMEOUT_MS` on 2026-11-18.

## Why a write waits

A write waits only while the pipe buffer is full. That means the reader has not started reading yet, or it reads more slowly than the write. CLI workers (CW5) send the prompt on stdin in writes under 64 KiB, so a prompt bigger than the pipe buffer waits until the CLI starts reading. A CLI that is slow to start on a busy host used to fail every attempt with `cli_stdin_undelivered`.

## What the limit was, per backend (before)

| Backend | Where the wait was cut | Effective limit |
| --- | --- | --- |
| Windows Job | `WindowsJobProcessHost.writeOwnedInput`: one supervisor `/write` request under the writer fence, bounded by the control deadline (5 s + 250 ms). The channel ignored the caller's `timeoutMs`. | about 5.25 s |
| Portable (POSIX process group, Windows portable) | `PortableProcessChannel.command` polls the supervisor's acknowledgement file until `timeoutMs`. | 15 s |

Two couplings made a longer limit unsafe:

- On the Windows Job backend, the write held the process's writer fence while it waited. Stop, output reads and output acknowledgements take the same fence, so they queued behind it. Measured: a stop issued 1 s into a blocked write took 4.6–4.7 s.
- On every backend, the session's stop (`relinquishAttachmentForCleanupTakeover` in `streaming-process-session-runtime.ts`) joins the in-flight write before it takes over and kills the tree. With the limit raised to 60 s alone, a stop took 59.3–59.5 s (Windows).

## The bound now

- **Ceiling:** 60 s per write (`MANAGED_INPUT_WRITE_CEILING_MS`). A service may lower it (`inputWriteCeilingMs`) but never raise it.
- **Fast path:** a write that the pipe takes settles in tens of ms and returns at once, on every backend.
- **Windows Job:** admission stays one fenced `/write` request. The supervisor hands the bytes to the pipe exactly once, then replies when the write settles or after 250 ms (`pending`). The Runner then waits for the drain outside the fence, through `GET /input-status` long-polls of 1 s each. Between polls it re-reads the record's ownership. The wait ends at the first of:
  - acknowledged;
  - failed (the reader closed stdin or exited, or the tree was stopped);
  - the record released or no longer owned;
  - the supervisor gone;
  - the ceiling;
  - the session stopping.
- **Portable:** unchanged polling, now also ended by the drain signal. One final reconciliation still reports an acknowledgement that already landed.
- **Who ends a drain wait early.** The write's drain signal fires on any of these, and the write then ends `outcome_unknown`, as at its own deadline, and is never resent:
  - **Stop and close** (`relinquishAttachmentForCleanupTakeover`, `closeAttachment`). They close input, then abandon the drains before joining the write tail. A write that passed its admission check just before that is still admitted, and the join waits for it. No write is admitted after the join.
  - **Graceful shutdown** (`gracefulInputClose`, `gracefulProtocolSettlement`). It abandons the drains already waiting, but its own shutdown writes are still admitted.
  - **The caller's cancellation:** the tool call's signal, or an MCP or LSP request's own deadline.

  Admission itself is never cancelled.
- **Sequence after an unacknowledged write (Windows Job).**
  - A write that was admitted but not acknowledged throws `WindowsJobInputUnacknowledgedError`, and the channel moves to the next sequence, as the host and the runtime already have. When the reader has drained it, the next write works again.
  - While it still drains, the supervisor refuses a later write (409 `input_pending`). It also refuses any sequence that is not above the last one it admitted (`input_sequence_stale`). So bytes are never queued, reordered or sent twice.
  - A write refused before admission (any 409 from the supervisor, a stopping session, or a caller that already gave up) sent nothing. It is typed as `InteractiveInputRefusedError`, the runtime hands its sequence back, and the tool reports it `rejected` (`process_input_rejected`), never `outcome_unknown`. Input stays usable: the next write takes the same sequence. The portable channel refuses the same way (see "Portable: unconsumed input acknowledgements", below).
  - Not covered (follow-up): if the reply to an admitted write is lost and the session is reattached, the host's next sequence is the one the supervisor already admitted. Every later write is then refused `input_sequence_stale`: reported `rejected` and never sent twice, but input stays unusable. Before this change that write would have been sent again. The host's own refusals (input unavailable, a stale fence) are still untyped and report `outcome_unknown`, as before.
- **Lease:** the write path renews the session's ownership lease through the write's bound, as a read's wait does.
- **Every ending other than acknowledged** is `process_input_outcome_unknown` (or a refusal before delivery), never a guess.

Why 60 s:
- **The upper limit.** The tool broker gives a call 120 s by default. `process.interact` also needs its pre-read and up to 30 s of read wait inside that. So 60 s is the largest write bound that keeps a turn inside one call with margin.
- **The measured real cases (CW0, below).** On an idle PC, the slowest real CLI's start-to-first-read is at most 7.7 s (agy on Windows). 60 s is 7.8x that. That leaves room for a busy host, a cold start or an antivirus scan, which are not measured for the real CLIs.

## Measurements

Fake reader (`node`) that sleeps before it reads stdin. Writes of 48 KiB each, through the real `ManagedProcessService` and execution host. Windows: Ryzen 7 7700X (16 threads), Job backend. Linux: Docker `node:24-bookworm-slim` on the same PC (WSL2), POSIX process group.

Start to first read of a reader that reads at once (Windows, 10 runs each):

| Load | min / median / max |
| --- | --- |
| idle | 66 / 114 / 263 ms |
| 32 CPU burners (2x the threads) | 63 / 116 / 231 ms |

The blocked write by reader delay. Windows used 2 writes (96 KiB); Linux used 3 writes (144 KiB), because its effective buffer holds 96 KiB.

| Reader sleeps | Windows before | Windows after | Linux after (before: cut at 15 s) |
| --- | --- | --- | --- |
| 0 | acknowledged, 56 ms | acknowledged, 56 ms | acknowledged, 84 ms |
| 3 s | acknowledged, 3.0 s | acknowledged, 3.0 s | acknowledged, 2.9 s |
| 8 s | **outcome_unknown at 5.4 s** | acknowledged, 8.1 s | acknowledged, 7.8 s |
| 20 s | **outcome_unknown at 5.3 s** | acknowledged, 20.1 s | acknowledged, 19.9 s |
| 45 s | (not run) | acknowledged, 44.9 s | acknowledged, 44.9 s |

Stop issued 1 s into a write the reader never drains:

| | Windows | Linux |
| --- | --- | --- |
| before (5.25 s limit) | 4.6–4.7 s | (15 s limit, joined the same way) |
| ceiling raised alone | 59.3–59.5 s | n/a |
| after | 0.32–0.49 s; the write ends `outcome_unknown` about 60 ms after the stop | 0.68–1.55 s |

A stop with no write pending takes about 0.45 s on the same Windows PC.

### Real CLIs: upper bounds from CW0's recorded runs

CW0 (`runner-v2/test/fixtures/cli-workers/`, 2026-11-17, idle Windows 10 PC and Linux Docker) recorded each run's whole duration from the managed launch to the stop. Some runs end right after the CLI reads its prompt, with a refusal or an error before or at the first model request. Their duration is therefore an upper bound on the CLI's start-to-first-read, launch included:

| CLI | Run (fixture) | What happens after the read | Duration (upper bound) |
| --- | --- | --- | --- |
| agy 1.5.10 | `stream-input-missing-event.windows` | the stream-json line is refused, exit 1 | 7.7 s |
| agy 1.5.10 | `model-unavailable.windows` | one model request, refused | 6.8 s |
| Claude Code 2.1.326 | `logged-out.linux` | `Not logged in`, no request | 2.0 s |
| Claude Code 2.1.326 | `model-unavailable.windows` | one model request, refused | 10.8 s |

- Managed launches of the real CLIs took 1.0–3.2 s on Windows (CW0 report §7). They load the user's own MCP servers and hooks.
- So on the idle PC, agy could already take longer than the old Windows Job limit of 5.25 s to start reading a prompt larger than the pipe buffer.
- Claude Code's `result.time_to_request_ms` (176–1,193 ms) is not used. Its phases (`process_user_input`, `input_hooks`, ...) suggest it counts from the prompt's arrival, not from the process start.

Not measured: real-CLI start-to-first-read on a busy host, and on a cold start. That needs the owner's go in words. A no-model method:
- Fill the CLI's stdin past the pipe buffer with bytes that hold no newline and are not JSON.
- Time the drain.
- Kill the CLI before EOF, so no turn starts.

## Portable: unconsumed input acknowledgements (fixed 2026-11-18)

**The bug.** Some portable input acknowledgements were never consumed by the channel:
- a `failed` one: `settleAcknowledgement` threw without removing it;
- one that lands after the channel stopped waiting, at its deadline or when abandoned.

When one was left, the session's later cleanup ended `cleanup_blocked` ("Streaming operation exceeded its recovery bound") after the 60 s stop-cleanup bound. This affected POSIX, and the portable backend on Windows too. Measured in Linux Docker before the fix:

| Case | Unchanged main | #238's branch |
| --- | --- | --- |
| a write the reader's exit failed (EPIPE) | 4 of 10 runs | 2 of 5 runs, then 4 of 4 |
| a write that drained after its deadline (main: 15 s; #238: a 2 s test ceiling) | 2 of 2 | 1 of 1 |

**The cause (confirmed).** The supervisor publishes every input proof as `channel/ack/input-<sequence>.json`, next to the output ACKs. Only the channel's wait removes one. Output settlement (`observeOutputSettlement`, which the stop's cleanup awaits) settled only when that whole directory was empty. With a stopped process, no output left and only `input-000000000003.json` in `channel/ack/`, it waited out its deadline. Settlement then reported `blocked`, and cleanup ended `cleanup_blocked`.

**The fix** (`portable-process-channel.ts`):
- **Settlement.** Output settlement and the idle output poll count only output ACKs (`stdout-*`, `stderr-*`), as the terminal observation already did. An input proof is not output evidence. Each fenced snapshot still validates every proof in `channel/ack/`, input proofs included, and fails closed on a malformed one. A proof no wait consumed stays until the record is released.
- **Failed proofs.** The wait that reads a `failed` proof now consumes it, under the same `ack_consume` effect as an acknowledged one, before it reports the failure.
- **Refusal before admission.** A write is refused while an earlier command of the same exact fence is still unsettled, for example a write still waiting for its reader. "Unsettled" means its file is still in `channel/input/`: the supervisor retires a command's file only when it settles it, in order. The refusal is checked inside the write's fenced effect, before anything is published, and throws `InteractiveInputRefusedError`. No sequence is spent, so the tool reports `rejected`. This matches the Windows Job's `input_pending`. Before the fix, the retry was queued behind the pending write and later delivered, although the caller had been told its outcome was unknown.
- **A prior owner's command** (after a takeover) does not cause a refusal. It queues as before, because the supervisor retires it as stale unless it was admitted before the takeover.
- **No supervisor change.** The supervisor and the fence protocol are unchanged.

**Measured after the fix (Linux Docker).**
- "the reader that exits" and "a write past its ceiling ... works again" each passed 8 of 8 runs.
- Each run took 1.1–2.3 s and 3.4–6.4 s, not the 60 s bound.
- Both tests now run on every platform.
