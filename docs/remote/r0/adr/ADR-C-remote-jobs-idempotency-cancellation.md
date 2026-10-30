# ADR-C: Remote jobs, idempotency and cancellation

## Status

Proposed.

## Context

`SqliteToolLedger.begin` transactionally fingerprints a run/session/call and reports an unfinished non-replay-safe invocation as `in_doubt`; it is not a principal-scoped remote job store (`runner-v2/src/sqlite-tool-ledger.ts:53`, `runner-v2/src/tool-ledger.ts:68`). `SqliteEventStore` supplies per-run increasing sequences and after-sequence reads, but its duplicate key returns the prior event without comparing a payload digest (`runner-v2/src/sqlite-event-store.ts:68`, `runner-v2/src/sqlite-event-store.ts:86`, `runner-v2/src/sqlite-event-store.ts:139`). Managed input persists a write ID and digest before delivery and turns pending writes into uncertainty on restart (`runner-v2/src/managed-process.ts:135`, `runner-v2/src/managed-process.ts:320`).

## Decision

The Runner is authoritative for admitted jobs and effects. Add a remote-jobs SQLite store under Runner state with job, principal/idempotency, encrypted request, event, cancellation and device-epoch tables. The admission identity, initial job and first event **must commit in one SQLite transaction** before dispatch or an admitted acknowledgment. Reuse the `SqliteToolLedger` fingerprint/in-doubt pattern, `SqliteEventStore` sequence/cursor pattern, `SqlitePermissionStore` for human decisions, `ArtifactStore` for local results, and the existing `openSqliteDurableProcessKernel`, streaming-session store and `ManagedProcessService` for owned process evidence. These are distinct stores; their current APIs do not give one atomic cross-store admission transaction. Integrate remote job/event writes in one database/transaction and reconcile links to the tool/process stores rather than asserting atomicity they do not have (`runner-v2/src/permission-store.ts:48`, `runner-v2/src/artifact-store.ts:65`, `runner-v2/src/durable-process-store.ts:792`, `runner-v2/src/streaming-session-store.ts:517`, `runner-v2/src/managed-process.ts:81`).

| Rule | Contract |
| --- | --- |
| Idempotency | Unique key is `(accountId, clientId, deviceId, idempotencyKey)`; the principal is verified locally, never trusted from payload text. The Runner independently computes and verifies SHA-256 over UTF-8 RFC 8785 canonical JSON of `{protocolVersion, deviceId, toolId, operationClass, scopeRef, payload}` using the validated payload as supplied. Reject duplicate JSON keys and non-finite/unsupported values; version any normalization or defaults. Exclude request ID, trace, nonce, timestamps and transport epoch so a retry can identify the same operation. Same principal/key/digest returns the original job; different digest returns `idempotency_conflict` without dispatch. Concurrent submissions serialize on the uniqueness constraint. Distinct principals never learn each other's jobs. |
| Before effect | Persist the request and policy identity locally, then a durable dispatch/attempt marker before calling `ToolBroker.invoke`. Preserve the broker's own ledger and grant checks; neither an HTTP acknowledgment nor a socket frame is proof of execution. A queued job with no dispatch marker may resume after fresh authorization; once the marker exists, a crash between stores is reconciled from durable evidence. Absent proof that an effect did not start means `outcome_unknown`, never a blind replay. |
| Scheduling | Limit queue depth and concurrent jobs per device/principal, apply deadlines and fair scheduling, and revalidate current grant, entitlement, scope and approval immediately before dispatch. Persist only enough encrypted request data to resume an undispatched job; clear it when no longer needed. No remote model loop. |
| Relay | Store only account/device/session/job index, last known redacted state and timestamps, the pending-cancel index marker below, usage and redacted audit. Do not store request arguments, output, artifacts or screenshots. Online replies stream through it. If no Runner acknowledgment is available, return `awaiting_device` with `admitted: false` and no job ID; this means **no admission was acknowledged**, not proof that an earlier forwarded attempt failed to commit. Report `admission_unknown` when a prior acknowledgment may have been lost, and retry the same key after reconnect. The relay does not queue payloads or invent an authoritative admission. |

### State and event journal

Use the plan's job states: `queued`, `awaiting_device`, `awaiting_approval`, `running`, `completed`, `failed`, `cancelled`, `outcome_unknown`, `blocked_policy`, `blocked_quota` (`docs/plans/2026-10-27-aiboard-remote.md:128`). A Runner-admitted job starts queued; it can wait for approval, run, or become blocked/cancelled before dispatch. Running settles to completed, failed, cancelled, or outcome_unknown; terminal states never return to running. A quota rejection at relay admission is non-admitted `blocked_quota`; a later local policy/quota block can be a durable job state. Approval denial is `blocked_policy`, not an execution failure.

While the device is unreachable, `awaiting_device` is a **relay availability projection**, with the last known Runner state separately labeled; the offline relay cannot change authoritative job state. On reconnect the Runner reconciles and publishes the actual state. HTTP timeout, chat disconnect or a lost response cancels only the wait, never the job.

Within the job transaction allocate a strictly increasing, never-reused per-job sequence and append each transition, cancellation request, stop observation and uncertainty. Event polling accepts an opaque cursor bound to job/principal and last sequence; return ordered pages plus the next cursor. Cursor possession is not authorization. If retention removed a prefix, return an explicit gap and earliest available sequence; never imply complete history. Status, events, result and cancel reauthorize principal/device and current local policy independently.

**Device epoch:** the relay durably increments a per-device epoch only after authenticated proof-of-possession and fences older sockets. The Runner persists the highest authenticated epoch under its per-device owner lock before accepting frames; reject lower epochs and stale responses/cancel/dispatch. On a new connection, revalidate any queued dispatch at the last pre-effect boundary. Work already admitted by the same live Runner remains owned by the local job, not by a socket epoch; it can finish through a network flap, and the new socket may report its journal. A transport epoch is distinct from the existing session/process ownership fence. Epochs cannot undo effects already started: on lock loss, crash or duplicate-owner suspicion stop new dispatch, revoke authority, reconcile exact owned work, and mark ambiguity unknown. A local lock only excludes competing Runners sharing that lock; it cannot prevent a copied key/state on another host from executing an already admitted effect. Detected cloning suspends the device and requires re-pairing or stronger independently verified fencing; do not claim split-brain safety from the socket epoch alone.

### Cancellation and failure

| Situation | Required result |
| --- | --- |
| Cancel queued or awaiting approval | Atomically record `cancel_requested` and prevent dispatch; cancel or detach any pending permission wait and fence late approvals. Report `stopped` only once no execution can start, then `cancelled` with `no_effect`. |
| Cancel running | Persist the request before signaling; propagate `AbortSignal`, the relevant MCP cancellation notification, and owned process stop/signal as applicable. `cancel_requested` is not proof of stop. Record `stopped` only with the relevant runtime's verified stop/cleanup evidence; separately report `effect_outcome_unknown` when an external or partial effect cannot be determined, even if the process is stopped. If completion won the race, report the proven completed/failed result. |
| Wait/stop fails or deadline expires | Keep stop unverified and/or effect unknown; do not report clean cancellation, rollback, or termination of descendants outside the proven lifecycle scope. `outcome_unknown` is terminal until an explicit, evidence-backed reconciliation records a resolution; no automatic replay of a side-effecting call. |
| Revocation | Block new admissions and operation authorizations immediately. Persist cancellation requests for affected in-flight jobs and reconcile owned effects; retain unknown results and audit. Revocation cannot reverse an effect already in progress. |
| Sleep, shutdown or crash | The relay shows offline/`awaiting_device` with last known state. Sleeping pauses local execution; do not infer cancellation or completion. On wake/restart, restore only evidence-backed owned work, reconcile durable process/session and tool records, and publish `running`, terminal, or `outcome_unknown` as proven. Never restart an ambiguous mutation merely because the connection returned. Safe reads may be retried only after fresh authorization. |

An authorized cancel while the device is offline may set an idempotent pending-cancel marker on the relay's job index, containing only job ID, requesting principal, cancellation request ID and timestamp. Return `pending_device`, not `cancel_requested` at the Runner or `stopped`. On reconnect deliver the marker over the authenticated, fenced channel; the Runner rechecks authorization, durably records the request before signaling, and acknowledges or rejects it. Repeated cancellation uses the same request ID. If the job already settled, return its proven state; a pending marker never overwrites that result.

Managed `process.write_stdin` retains its own `writeId`/digest/acknowledgment contract in addition to the job key; a lost acknowledgment is not resent. Its history is bounded, so remote job tombstones must prevent replay even after that history is pruned (`runner-v2/src/managed-process-contracts.ts:84`, `runner-v2/src/managed-process-contracts.ts:92`, `runner-v2/src/managed-process-tools.ts:61`).

### Retention

Default result TTL is **7 days after terminal settlement**, configurable locally. Expiry deletes result access and eligible local payload/artifact references with shared-artifact reachability checks, emits a result-expired event, and returns `result_expired`; it never changes a known outcome to failed. Retain process ownership and reconciliation evidence while an effect or cleanup is unresolved, even after result access expires. A content hash or output reference is not authorization: artifact reads must recheck the job principal, scope and TTL. Keep a compact principal/key/digest/job/outcome tombstone indefinitely until explicit local device-state erasure; reject new admissions if bounded storage is exhausted rather than forgetting a key and replaying it. Job/event retention may be bounded with explicit cursor gaps. State loss, rollback, cloned device keys or explicit erasure ends this local guarantee and must be surfaced, not described as global exactly-once execution.

### Minimal TypeScript contract sketches

These are types for T4 to encode and constrain as versioned JSON Schemas; values are proposed, not implemented. All timestamps are UTC RFC 3339; digests are lowercase SHA-256 hex; sequences are positive decimal integer strings and cursors are opaque strings on the wire.

```ts
type RemoteJobState =
  | "queued" | "awaiting_device" | "awaiting_approval" | "running"
  | "completed" | "failed" | "cancelled" | "outcome_unknown"
  | "blocked_policy" | "blocked_quota";

interface RemotePrincipal {
  accountId: string; clientId: string; deviceId: string;
}

interface RemoteRequestEnvelope extends RemotePrincipal {
  protocolVersion: string; requestId: string; deviceEpoch: string;
  toolId: string; operationClass: string; scopeRef: string;
  issuedAt: string; expiresAt: string; nonce: string;
  idempotencyKey: string; payloadDigest: string; traceId: string;
  payload: unknown;
}

type RemoteResponse = {
  requestId: string; traceId: string; outputRef?: string;
  errorCode?: string; uncertainty?: string;
} & (
  | { admitted: true; jobId: string; status: RemoteJobState }
  | { admitted: false; jobId?: never; status: "awaiting_device";
      uncertainty: "admission_unknown" | "not_dispatched" }
  | { admitted: false; jobId?: never;
      status: "blocked_policy" | "blocked_quota" | "rejected" }
);

interface RemoteJob {
  protocolVersion: string; jobId: string; principal: RemotePrincipal;
  idempotencyKey: string; payloadDigest: string; toolId: string;
  operationClass: string; scopeRef: string;
  state: Exclude<RemoteJobState, "awaiting_device">;
  createdAt: string; updatedAt: string; resultExpiresAt?: string;
  cancellation?: RemoteCancellation; outputRef?: string;
}

type RemoteJobView =
  | { authoritative: true; job: RemoteJob }
  | { authoritative: false; jobId: string; state: "awaiting_device";
      lastKnownState?: Exclude<RemoteJobState, "awaiting_device">;
      lastKnownAt?: string };

interface RemoteCancellation {
  requestedAt: string;
  stop: "pending" | "stopped" | "unverified" | "not_applicable";
  effect: "pending" | "no_effect" | "known" | "effect_outcome_unknown";
}

interface RemoteCancelReceipt {
  jobId: string; cancelRequestId: string; traceId: string;
  delivery: "pending_device" | "recorded" | "rejected";
  cancellation?: RemoteCancellation;
}

type RemoteJobEventKind =
  | "state_changed" | "cancel_requested" | "stopped"
  | "effect_outcome_unknown" | "result_expired" | "reconciled";

interface RemoteJobEvent {
  protocolVersion: string; jobId: string; sequence: string;
  occurredAt: string; kind: RemoteJobEventKind;
  state: Exclude<RemoteJobState, "awaiting_device">;
  cancellation?: RemoteCancellation; traceId: string;
}

interface RemoteEventPage {
  jobId: string; events: RemoteJobEvent[]; nextCursor: string;
  gap?: { earliestSequence: string };
}
```

The authenticated transport envelope and response from plan §4 carry request ID, principal IDs, device epoch, tool ID, operation class, scope reference, issuance/expiry, nonce, idempotency key, payload digest, trace ID and `admitted/jobId/status/outputRef/errorCode/uncertainty`; T4 must distinguish a non-admitted response from an admitted job and a local authoritative snapshot from an offline projection (`docs/plans/2026-10-27-aiboard-remote.md:126`). Device epochs are positive decimal integer strings on the wire, compared numerically and never reset for a provisioned identity.

## Consequences

Exactly-once **admission** is local and durable while its tombstone and device identity survive. Exactly-once external effects are not promised. The implementation needs atomic remote admission, encrypted local request retention, recovery integration and a transport protocol beyond the v1 frame correlation map.

Focused qualification must race same-key submissions and conflicts, crash before/after dispatch and after a side effect, reconnect with stale epochs, cancel during effect/stop, simulate sleep, and verify TTL and cursor gaps. Assertions must inspect durable outcomes and physical stop evidence, not just HTTP responses.

## Alternatives rejected

- Relay-only deduplication or an in-memory pending map: loses authority on restart and cannot prove a local effect.
- Replaying every timed-out call: risks duplicate writes, commands and external effects.
- Treating a cancellation request or process signal as proof of effect rollback.

## Open questions

None.

## Plan corrections

The existing broker records `tool_timeout` and `tool_cancelled` as completed ledger results after an abort; those records alone do not prove the underlying effect stopped or had no effect. Remote job reconciliation must preserve independent uncertainty and verified stop evidence rather than equate that ledger result with job cancellation (`runner-v2/src/tool-broker.ts:453`, `runner-v2/src/tool-broker.ts:473`). The tunnel registry's timeout sends a cancel frame, but the connector only drops its pending reply; that is not effect cancellation (`D:/repos/aiboard-tunnel/packages/relay/src/registry.ts:242`, `D:/repos/aiboard-tunnel/packages/connector/src/connector.ts:207`).

## Evidence

- `runner-v2/src/sqlite-tool-ledger.ts:53`; `runner-v2/src/sqlite-event-store.ts:68`; `runner-v2/src/permission-store.ts:71`; `runner-v2/src/artifact-store.ts:65`.
- `runner-v2/src/durable-process-store.ts:23`; `runner-v2/src/durable-process-store.ts:792`; `runner-v2/src/streaming-session-store.ts:517`; `runner-v2/src/managed-process.ts:135`; `runner-v2/src/managed-process.ts:255`; `runner-v2/src/managed-process.ts:320`.
- `runner-v2/src/tool-broker.ts:374`; `runner-v2/src/tool-broker.ts:453`; `docs/runner-v2/security.md:27`; `D:/repos/aiboard-tunnel/packages/relay/src/registry.ts:228`.

