# Task 8.0B2 — Portable Native/POSIX/Windows Channel Hosts

## Authority and entry gate

This brief executes only internal Packet 8.0B2 from
`task-8.0b-brief.md`, whose architecture was approved by
`task-8.0b-spec-review-2.md`. Packet 8.0B1 is independently approved and
controller-verified in `task-8.0b1-controller-evidence.md`.

Entry head is `cb597496`. Preserve all prior authority, durability, output,
cleanup, and error-provenance invariants. Node support remains maintained Node
22 and 24; never pin exact `24.18.0`.

## Purpose

Supply real portable native/POSIX/Windows host-control and bounded duplex
channel implementations behind the frozen B1 and Task 5 contracts. Reuse the
existing Task 5 ownership, birth-fingerprint, attestation, escalation,
reconciliation, and verified-emptiness machinery. Do not create family-owned
process lifecycle or a second ownership model.

## Exact scope

1. Implement a real native backpressured interactive channel for the portable
   supervisor. It must support exact binding acquisition/reattachment, ordered
   writes, input close, bounded retained stdout/stderr replay, provider
   acknowledgement only after the Runner sink acknowledges the identical
   metadata, graceful stop, terminal observation/wait, and idempotent detach.
   The supervisor must pause/backpressure upstream at the declared aggregate
   byte/chunk window; it may not use tail-only delivery for the new streaming
   capability. Existing Task 5 terminal observation behavior remains compatible.
2. Extend the existing portable supervisor/child protocol rather than adding a
   parallel process owner. The exact Task 5 opaque identity, supervisor birth,
   target birth, process group/tree, and durable evidence directory remain the
   ownership source. Every attach, reattach, input/control, signal, terminal,
   empty-verification, and release operation re-attests the exact identity and
   current writer/fence immediately before the effect. PID alone is never
   authority.
3. POSIX continues to launch a new session/process group, validate independent
   birth identity, signal the owned negative group only after re-attestation,
   escalate TERM then KILL under bounded control, and prove the group empty.
   A launcher/supervisor exit does not prove descendants absent.
4. Windows portable baseline remains usable without Job Objects. It must expose
   only semantics it can prove through its deterministic supervisor and exact
   birth-validated membership. Enumeration/inspection uncertainty fails closed
   and preserves cleanup evidence.
5. Mandatorily extract the authenticated low-level Windows Job host/service from
   `ManagedProcessService`. The extracted host owns native Job/supervisor,
   command resolution, exact argv, batch compatibility, authenticated control,
   output, reconciliation, and release mechanics. It accepts explicit internal
   ownership identifiers and never imports agent/model contracts or fabricates
   an `AgentActor`.
6. `WindowsJobObjectProcessBackend` and its interactive channel depend only on
   the extracted low-level host contract. They must not import/call the public
   managed facade. `ManagedProcessService` may delegate to that host while
   preserving its current public records, tool authorization, errors, snapshots,
   ownership behavior, and tests until Packet 8.4.
7. Preserve attested `.cmd`/`.bat` argv-only compatibility in the extracted
   low-level Windows host independently of active Job assignment. Arguments
   remain data, unsafe command-shell metacharacters remain typed-refused, and no
   shell-source concatenation/evaluation is introduced. If batch argv behavior
   cannot be separately attested, only a batch request fails typed before target
   creation; verified portable native launches remain available.
8. Add independent immutable semantic probe facts, each with closed
   unavailable/partial/verified or equivalent states, for:
   - portable exact launch plus bounded duplex channel;
   - argv-only Windows batch launch;
   - exact tree ownership plus birth re-attestation;
   - optional Job-backed stronger containment/crash cleanup.
   Constructors and future selection seams consume each fact independently.
   No fact may be inferred from platform/module/backend names or from another
   fact. Job support is `verified` only after an honest active Job create/close
   probe; module/file presence is insufficient.
9. Keep all new low-level raw process signalling/control in the exact approved
   adapter/host/supervisor surfaces. No family, model tool, or product layer may
   branch on `process.platform`, call `process.kill`/`taskkill`, or select Job by
   name.

## Explicit exclusions

- No strict OCI/container implementation or `interactiveAttach` capability.
- No CLI `ExecutionHost` graph activation or production backend registration.
- No Git, MCP, LSP, managed-process, or other production child-family migration.
- No behavior change to the public managed-process tool/facade.
- No model call, model-visible native capability, fabricated actor, live channel
  in durable state, second database, payload in SQLite, or persisted secret.
- No exact Node patch pin, Windows-only product requirement, shell fallback, or
  weakening of B1 output/checkpoint ordering.

## Expected surfaces

- Modify `runner-v2/src/native-process-backend.ts`.
- Modify `runner-v2/src/posix-process-backend.ts`.
- Modify `runner-v2/src/windows-process-backend.ts`.
- Modify `runner-v2/src/portable-process-supervisor.mjs`.
- Modify `runner-v2/src/portable-process-child.mjs` only as required for exact
  held launch/stdio ownership.
- Add one or more narrowly named extracted Windows Job host/service TypeScript
  files; retain `managed-process-job-host.ps1` as the native helper unless a
  compatible split is mechanically required.
- Modify `runner-v2/src/managed-process.ts` only to remove/delegate the extracted
  backend-private mechanics while preserving its public facade.
- Minimal additive changes to `interactive-process-channel.ts`,
  `process-backend.ts`, or B1 runtime types only when required for the real
  capability; no B1 semantic rewrite.
- Add focused portable-channel/host fixtures and extend
  `posix-process-backend.test.ts`, `windows-process-backend.test.ts`,
  `process-backend-contract.test.ts`, `managed-process.test.ts`, and the B1
  runtime integration surface as impact requires.

## Work packets in execution order

### B2.1 — Semantic probes and dependency boundary

PREPARE by inventorying current adapter construction/imports and raw process
allowlist. Add tests first for the four independent probe facts, active Job
probing, partial/unavailable combinations, portable/batch usability without Job,
and dependency recursion. Prove RED. Implement the smallest immutable probe and
host contracts. Statically prove the Job backend cannot import the managed
facade or agent/model contracts and cannot construct an actor.

### B2.2 — Extract low-level Windows host

Add compatibility tests around current managed start/signal/reconcile/release,
output, native executable argv, `.cmd`/`.bat` argv, unsafe batch refusal, restart,
and Job-unavailable behavior. Extract backend-private mechanics behind the new
low-level host. Make `ManagedProcessService` delegate without public behavior
change. Make Job backend depend only on this host. Prove launch failure after
target creation either cleans the exact owner or returns a typed blocker with
recoverable evidence.

### B2.3 — Portable bounded duplex protocol

Define the smallest authenticated supervisor protocol for writes, input-close,
control, output retention/ack, terminal state, and detach/reattach. Protocol
files/endpoints live only under the exact owned evidence directory. Metadata is
per stream and must match B1 sequence/offset/length/digest contracts. Retain
chunks until identical acknowledgement; bound aggregate bytes/chunks and pause
upstream when full. Add real current-host tests RED before implementation for
partial output, backpressure, write order, close, stop, terminal wait, detach,
reattach/replay, stale writer/fence, sequence loss, host crash, and disappearance.

### B2.4 — POSIX/Windows integration and adversarial lifecycle

Wire the channel to the existing native owner without changing production
family routing. On the current Windows host, run the portable baseline and, only
when the active probe verifies it, Job-enhanced fixtures. Non-current POSIX
native fixtures must have an explicit host skip while platform-neutral contracts
and static proofs still run. Cover surviving descendants, launcher exit,
TERM-refusal then exact escalation, birth/PID mismatch, enumeration failure,
backend disappearance, attach/reattach refusal, output loss, cleanup uncertainty,
and verified-empty-before-release.

### B2.5 — Repair, mutation, compatibility, and cleanup gate

For every failure, rerun the exact check first, then affected files/contracts.
Automatically repair determinable defects without expanding scope. Required
prove-red mutations include at minimum:

- signal only the root PID or accept launcher exit as empty;
- bypass birth re-attestation immediately before control/release;
- acknowledge/delete an output chunk before the sink acknowledgement;
- remove the aggregate retained-window backpressure bound;
- accept a stale writer/fence or output sequence gap;
- report Job verified from file/module presence without active probe;
- couple portable or batch availability to Job availability;
- reintroduce a managed-facade dependency or fabricated actor into the Job
  backend/host path.

Each mutation must be RED, reverted, and GREEN. Inspect and remove only exact
owned test processes, supervisors, helpers, ports/endpoints, chunk files, and
temporary roots. Preserve blocker evidence when identity/emptiness is uncertain.

## Acceptance criteria

- Current-host real portable launch/channel roundtrip is green, including
  partial stdout/stderr, bounded backpressure, input write/close, graceful stop,
  terminal wait, detach, and exact reattach/replay.
- Producer retention and B1 acknowledgement/checkpoint behavior cannot lose or
  duplicate protocol bytes across detach/restart boundaries.
- Every control/release operation is preceded by exact identity/birth and
  writer/fence re-attestation. Mismatch/unknown never signals or releases.
- POSIX exact group and Windows exact birth-validated tree semantics remain
  truthful; Job absence does not disable independently verified portable or
  batch behavior.
- Job containment/crash cleanup is claimed only after active verification.
- `.cmd`/`.bat` compatibility preserves argv boundaries without shell-source
  evaluation and fails typed before launch when unattested.
- Job backend/channel have no dependency path to `ManagedProcessService`,
  managed tools, agent contracts, or model actor construction.
- Public managed-process behavior remains compatible; no production family or
  CLI graph is routed to the new channel yet.
- Launch cleanup, terminal cleanup, and release either prove exact emptiness or
  preserve a typed durable blocker/evidence; no owned residue remains after
  successful tests.

## Required validation

Run exact new tests first, then:

- complete POSIX/Windows/native backend and portable-channel tests;
- `process-backend-contract.test.ts`, `subprocess-runtime.test.ts`, and
  `managed-process.test.ts`;
- complete Packet 8.0B1: staged launch, streaming output checkpoint/v2, and
  streaming runtime;
- complete Packet 8.0A: streaming store, SessionAuthority, interactive channel,
  and execution grants;
- affected Task 7/Task 3 terminal runtime and bounded spool tests;
- `npm run typecheck:runner-v2`;
- targeted ESLint over every changed source/test file;
- scoped and current `git diff --check`;
- static dependency/raw-launch/product-platform-branch/Node-pin audit;
- exact current-host process/endpoint/temp-root residue audit.

Do not rerun an unaffected broad suite after every repair. Previously green
results may be reused only when the changed surface and dependency graph prove
them unaffected.

## Required evidence

Append `task-8.0b2-report.md` with packet-by-packet RED/GREEN commands/results,
root causes, design decisions, mutation results, active probe facts, native
skip reasons, complete validation counts, static import/call audit, process and
filesystem cleanup evidence, residual concerns, and the focused implementation
commit. The report is implementation evidence, not approval.

## Definition of Done and exit gate

Every applicable real-adapter fault is green on the current host; non-current
adapters have contract/static proof; all required mutations are RED/reverted/
GREEN; dependency recursion and fabricated actors are impossible; Job remains
optional and independently probed; the public managed facade is compatible;
all affected gates are current; and exact owned residue is zero.

Then obtain a fresh independent review. Only zero Critical/Important findings
plus controller verification may declare:

**PACKET 8.0B2 VERIFIED 100% COMPLETE — PACKET 8.0B3 MAY BEGIN**

Otherwise the only valid outcome is:

**PACKET 8.0B2 BLOCKED — GENUINE USER DECISION REQUIRED**
