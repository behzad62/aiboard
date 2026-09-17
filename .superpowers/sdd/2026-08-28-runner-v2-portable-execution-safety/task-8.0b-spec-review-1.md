# Task 8.0B Specification and Architecture Review

## Verdict

**NOT APPROVED.** The brief is directionally aligned with the governing Task 8 architecture, but five Important ambiguities remain. They affect grant-consumption ordering, durable cleanup ownership, lossless restartable output, packet ownership for MCP discovery, and optional Windows Job semantics. No Critical defect was found.

## Strengths

- The brief correctly preserves Task 7 terminal contracts and the separately versioned, nonterminal 8.0A state machine (`task-8.0b-brief.md:20-28`; `task-8-brief.md:71-76`).
- It explicitly keeps opaque grants ToolBroker-owned, forbids durable/live authority leakage, and requires exact per-operation authorization (`task-8.0b-brief.md:29-33`, `task-8.0b-brief.md:74-84`).
- Pre-adoption crash recovery, unknown launch outcome, exact binding, and no-blind-relaunch rules are materially present (`task-8.0b-brief.md:34-62`).
- The B1 → B2 → B3 dependency direction is broadly correct: contracts/fakes first, real portable adapters second, then OCI/construction/integration (`task-8.0b-brief.md:10-15`, `task-8.0b-brief.md:100-117`, `task-8.0b-brief.md:154-176`, `task-8.0b-brief.md:208-243`).
- Construction-only family boundaries, semantic capability selection, optional Job support, strict OCI failure before fallback, concurrent-run isolation, and residue gates are all explicitly represented (`task-8.0b-brief.md:91-98`, `task-8.0b-brief.md:166-176`, `task-8.0b-brief.md:212-239`, `task-8.0b-brief.md:254-278`).

## Critical issues

None.

## Important issues

### 1. Staged grant consumption is incorrectly conditional and does not define the one-shot finalization contract

The brief requires grant consumption before isolation or backend effects (`task-8.0b-brief.md:29-38`, `task-8.0b-brief.md:131-135`) but says only **“If”** staging requires separation, add an in-memory launch authorization (`task-8.0b-brief.md:50-56`). Separation is not optional under the approved 8.0A API: `SessionAuthority.beginTransfer()` requires the isolation lease and backend binding as inputs and is itself the operation that consumes the opaque grant (`runner-v2/src/session-authority.ts:45-52`, `runner-v2/src/session-authority.ts:171-177`, `runner-v2/src/session-authority.ts:205-224`). Therefore the current API cannot both consume before isolation and finalize after binding.

The brief must unconditionally require a staged contract that:

- consumes the exact grant once before the first isolation/provider effect;
- reserves the exact call key and intended session identity before effects, retaining only immutable consumed claims;
- exposes a non-forgeable, call-scoped launch authorization to private isolation/host code;
- permits exactly one finalization into the exact lease, backend binding, envelope, and session;
- cannot be copied, reused for a second session, or finalized after revocation/expiry;
- seeds 8.0A retained launch claims without calling `consume()` again; and
- defines `beginTransfer()` compatibility as a wrapper over that same state machine rather than a second consumption path.

Without that mandatory API shape, B1 has two plausible but invalid implementations: consume twice at finalization, or defer consumption until after isolation. Mandatory faults do not resolve which contract is authoritative.

### 2. Cleanup ownership transfer between the new host journal and SessionAuthority is not transactionally defined

The brief correctly demands one durable owner for every pre-adoption effect and a journal before backend launch (`task-8.0b-brief.md:34-49`). B1 then expects a new host-control journal/store while also adding to the existing 8.0A session store (`task-8.0b-brief.md:104-126`). It never defines the atomic or two-phase ownership protocol between those durable authorities.

This leaves an unresolved crash window around handshake → `beginTransfer()` → transfer acknowledgement → host-journal settlement. With independent stores, clearing the host owner before the SessionAuthority transition creates an ownerless child; clearing it after creates two apparent cleanup owners. The approved parent requires a fenced, idempotent pending transfer with a sole recovery owner (`task-8-brief.md:77-85`, `task-8-brief.md:113-124`), while the approved implementation persists SessionAuthority state through its own writer (`runner-v2/src/session-authority.ts:198-205`).

The B1 brief must choose and specify one executable design: either a single transactional durable state machine/store for host launch plus session transfer, or an explicit two-phase handoff whose records identify one authoritative cleanup owner and one inert pending recipient at every revision. It must define effect IDs, owner/fence transitions, acknowledgement order, idempotent replay, arbitration when both records exist after a crash, and which record remains authoritative for unknown launch outcome before a backend binding exists. “Crash at every boundary” tests (`task-8.0b-brief.md:131-135`) are not enough when the expected durable state at those boundaries is unspecified.

### 3. The v2 output capability does not close acknowledgement/checkpoint ordering across Runner crash

The brief requires bounded lossless protocol bytes, sequence/length/digest, provider acknowledgement, an independent evidence branch, durable accepted/consumed offsets, and exact reattach or outcome unknown (`task-8.0b-brief.md:63-84`). It does not define the protocol needed to make those claims jointly true.

Specifically, it must state:

- whether sequence and byte offsets are global or per stream, and which streams are protocol-bearing (stdout versus stderr/evidence-only);
- which side acknowledges a chunk and the exact point at which acknowledgement may resolve;
- that provider retention/replay cannot discard bytes merely because they entered an in-memory parser queue;
- how durable “accepted” and “consumed” checkpoints order relative to queue insertion, parser consumption, authorized family delivery, and provider acknowledgement;
- the bounded replay window/backpressure behavior while no family authorization exists; and
- the required disposition for crashes between each checkpoint/ack step.

Today the approved v1 capability has only a void output callback and input-side `nextSequence` (`runner-v2/src/interactive-process-channel.ts:50-77`), so these are new contract semantics, not details recoverable from 8.0A. If a producer drops a chunk after in-memory sink acceptance but before a durable consumed checkpoint, Runner crash creates a permanent gap; if it replays after family/protocol consumption without a durable checkpoint, it creates a duplicate. Because durable payloads are forbidden, safe exact recovery depends on explicit provider retention plus checkpoint ordering. Add RED/GREEN faults for crashes before/after queue acceptance, durable accepted commit, provider ack, parser consumption, durable consumed commit, and authorized delivery. The current gap/duplicate and reattach bullets (`task-8.0b-brief.md:138-143`) do not establish that ordering.

### 4. B3 simultaneously requires MCP protocol discovery and forbids MCP protocol/lifecycle migration

The brief says no MCP protocol migration begins until all 8.0B is green (`task-8.0b-brief.md:13-15`). B3 nevertheless requires a real per-run MCP initialize/`tools/list` discovery child with its own principal and cleanup (`task-8.0b-brief.md:224-228`), while later saying B3 may perform only behavior-neutral MCP construction relocation and that existing family protocol/lifecycle execution remains unchanged until 8.2 (`task-8.0b-brief.md:233-239`). Initialize, `tools/list`, and verified close are protocol and lifecycle execution.

The governing parent does require this closed discovery context as an architecture prerequisite (`task-8-brief.md:204-209`), so B3 should explicitly carve it out: define a distinct Runner-internal discovery executor owned by B3, state that it is wired in production through the new host but cannot call tools or expose the live channel, and identify exactly which public MCP manager behavior remains untouched for 8.2. Alternatively defer discovery execution to 8.2 and limit B3 to construction seams, but then the parent construction/recovery acceptance must be revised. As written, B3 implementers and reviewers cannot consistently decide whether real discovery is required or out of scope.

### 5. Optional Job support and mandatory Windows batch compatibility need separate semantic capabilities

B2 makes extraction of the low-level Windows Job host mandatory, says the portable Windows baseline remains available when Job support is unavailable, and requires semantic probing (`task-8.0b-brief.md:161-169`). It also says `.cmd`/`.bat` argv-only compatibility is preserved through the extracted Job host (`task-8.0b-brief.md:173-174`), matching the parent compatibility requirement (`task-8-brief.md:184-186`). The brief does not say whether exact batch launch remains available when active Job assignment is unavailable, or whether batch support silently becomes conditional on the optional enhancement.

Define independent semantic probe facts for at least portable exact launch/channel support, argv-only batch launch, exact tree ownership/re-attestation, and Job-backed stronger containment. Product selection must depend on those facts, not the module name “Job host.” State explicitly that inability to assign a Job does not remove required portable/batch compatibility when the host can still provide those semantics; otherwise fail typed with a declared compatibility decision. This is necessary to reconcile “Job optional” with “batch compatibility preserved” and to make B2’s current-host positive/fallback tests executable (`task-8.0b-brief.md:187-205`).

## Minor issues

None beyond the Important ambiguities above.

## Packet split assessment

Subject to the fixes above, the split is dependency-correct and testable:

- **B1** should own the mandatory staged-grant API, the single durable launch/transfer state machine or explicit two-phase protocol, the v2 output/checkpoint contract, fake runtime/providers, and all crash-ordering model tests.
- **B2** should implement only real portable/native/POSIX/Windows host/channel adapters and the extracted low-level Windows host behind B1 contracts, with semantic probes separated from mechanism names.
- **B3** should add strict OCI plus the single ExecutionHost/per-run construction graph and real integration. Its narrow Git-preflight and internal MCP-discovery exceptions must be explicit; family-owned live Git/MCP/LSP/managed behavior remains for 8.1–8.4.

No acceptance criterion is inherently impossible once output retention/checkpoint semantics and cleanup handoff are defined. Docker-unavailable and non-current-platform handling are already fail-closed rather than silent weakening (`task-8.0b-brief.md:203-205`, `task-8.0b-brief.md:272-278`).

## Final assessment

**Specification compliance: Needs revision. Architecture quality: NOT APPROVED.** Resolve all five Important ambiguities before dispatching 8.0B1; otherwise the first packet can produce incompatible grant, ownership, and output protocols that later packets cannot safely repair without reopening shared contracts.
