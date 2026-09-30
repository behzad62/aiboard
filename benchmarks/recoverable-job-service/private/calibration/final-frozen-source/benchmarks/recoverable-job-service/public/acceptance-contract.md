# Public acceptance contract

**Executable profile precedence:** [runtime-contract.md](runtime-contract.md) and the packaged contract.d.ts define exact API, event, handoff and fault semantics. Provisional narrative wording below does not introduce additional RPCs or stricter private layouts. Qualification/admission status is recorded separately; documentation alone does not admit a family.


This document accompanies the [problem statement](problem.md) and is delivered to
every candidate before its attempt. It lists every proposed scored behavior family.
The package supplies the complete normative interfaces, limits and examples.
Scoring admission requires producer qualification, a reference-independence
calibration using the simplification audit method rjs-simplification-audit-1, and
end-to-end UI validation. The evaluator's benchmark metadata records calibration
status separately from this contract; documentation alone does not admit scoring.

## Your instructions and your score must match

1. A deduction must identify a public requirement, a public family ID and an
   observable outcome that your submission violated. Linking to a broad clause
   such as 'recover safely' is insufficient if the expected decision is unspecified.
2. Hidden tests may vary data and legal event schedules, not the behavioral contract.
   They cannot require knowledge of another repository, private review, reference
   implementation, unpublished schema or undocumented operating-system behavior.
3. Accepted internal algorithms and representations are unrestricted within the
   published interfaces. No points depend on using a particular loop count, lock,
   map, SQLite table, directory layout, page size or reference patch. A design that
   prevents an intermediate failure state may pass by proving the required outcome;
   it need not recreate that state internally to satisfy a reference-shaped test.
4. Provided adapter responsibilities are not graded as candidate work. The public
   responsibility manifest identifies which decisions you must implement and which
   guarantees you may trust. Failures of promised adapter guarantees are evaluator
   defects unless caused by a documented misuse by your submission.
5. Safety failures need the same explicit public basis as other deductions. No
   broad 'safety' label may introduce new requirements after submission.
6. Reasonable ambiguity or conflicting instructions is a benchmark defect, not a
   candidate mistake. The affected case cannot reduce a score until a clarified
   version is published for future attempts. Any campaign-wide quarantine or
   withdrawal applies consistently to all affected submissions and is disclosed.

## Definitions used in expected outcomes

| Term | Meaning |
| --- | --- |
| Accepted output | Its exact identity/positions and evidence or permitted diagnostic-loss decision have been durably committed. It is not necessarily delivered or consumed. |
| Delivery | Invocation of the external consumer effect under the published delivery protocol. Acceptance alone does not prove this happened. |
| Consumed output | The consumer effect has an authenticated completion record or receipt. A persisted intent with no known result is still ambiguous. |
| Acknowledged output | Permission to retire the exact consumed transport bytes; publication of an ACK and completed retirement are distinct. |
| Diagnostic loss | Only the optional evidence payload may be missing under the published loss policy. It does not permit unexplained loss of required protocol accounting or falsely reporting integrity. |
| Workload quiescent | The authenticated workload/control contract proves no further workload execution. Output may still remain in pipes or retained storage. |
| Output settled | Terminal production, buffered tail, retained bytes, consumer/ACK work and retirement obligations are all accounted under current authority. |
| Blocked | An exact remaining obligation has insufficient authority/evidence to proceed. It is durable and inspectable; it is not successful release. |
| Unknown effect | An operation was issued but its application/completion cannot be established. Neither nonissuance nor success may be invented. |
| Current owner | The owner/epoch authorized at the effect or commit boundary. A new owner may reconcile old authenticated evidence without authorizing the old owner to act. |
| Active handoff | Transfer of a live, eligible setup/checkpoint to its exact running successor. Finalized or ambiguous-consumption checkpoints are not eligible for this operation. |
| Terminal transfer | Preservation of verified final evidence ownership in the released job record while retiring its source checkpoint. This is distinct from active handoff. |
| Atomic transfer | No observable committed state loses both the source obligation and its valid destination. The published storage contract defines the allowed transaction/recovery guarantees; no particular private schema is assumed. |

## Common ordering and timing rules

Persist a setup/resource intent before acquiring that resource. During cleanup,
establish private intake before waiting for quiescence when ACK-dependent
backpressure requires it. Quiescence and final output settlement precede evidence
finalization. Verified final evidence precedes channel detach; detach precedes
process-authority release; process-authority release precedes isolation release.
All applicable terminal facts precede durable job release. Preparatory observation
and reader installation are not the same as certifying a resource's final fact.

Before the absolute deadline, an authorized completion may commit success. At or
after it, ordinary completion records expiry and retains any issued work. A later
explicit reconciliation may verify a completed fact using current authority; it
does not change the earlier operation's timeout result. The release manifest must
define the clock unit, epoch/lease rules and settlement reserve numerically.

If the evaluator supplies valid current authority, intact/reconstructible data,
the required capability/receipt and sufficient declared budget, the progress case
must complete. If one required proof is absent or ambiguous, the corresponding
case must preserve a blocker. Tests cannot demand progress while deliberately
withholding a prerequisite that the public contract says is necessary.

## Faults the evaluator may schedule

The release package must publish the exact driver event/error vocabulary. It may
permit interruption between durable operations; lost responses after issuance;
owner/epoch takeover during awaits; delayed or rejected callbacks; reordered exit,
pipe-close and drain events; storage failure or corrupt/foreign input under supplied
schemas; replaced owned paths/identities; and concurrent jobs and listener changes.
These are the intended fault classes, not permission for arbitrary extra faults.

Tests must create states through supplied public fixtures/adapters or documented
serialization formats. They may not inject a guessed candidate-private database
row or require the implementation to use the reference's intermediate stages.
Process restart, transaction rollback and power-loss durability are different
fault models; only the model explicitly supported by the public storage primitive
may be graded. Native behavior is limited to the declared platform profile.

## Examples of fair observable expectations

| Given and event | Required result |
| --- | --- |
| No running job is listed, but setup still owns a channel. Client closes the batch. | Close reports unresolved ownership; inspection and safe retry remain available. Once the channel obligation is authentically settled, retry can succeed. |
| A stop effect was issued and its caller times out. Its completion arrives after owner takeover. | The timeout retains the exact effect. The old completion cannot borrow the new epoch, start a second stop or change the successor's state. Current-owner receipt-based reconciliation remains possible. |
| For illustrative clock values, deadline is 100 and completion is committed at 99 versus 100. | The first may succeed under valid authority; the second records expiry. A timer callback's incidental scheduling order cannot change that boundary. |
| First listener unsubscribes the second during terminal notification. | The second is not invoked. If the first creates a new registration, that registration awaits fresh observation. |
| Accepted evidence contains bytes `abc`. Restart occurs before consumption; then bytes `de` arrive. | Final retained content is `abcde` once, assuming the profile permits retention and valid consumption. The old prefix is not duplicated or silently omitted. |
| A previously created checkpoint is now absent; compare a provably never-created checkpoint with a fully reconstructible retained stream. | Missing prior evidence blocks. The proven initial case may bootstrap atomically and recover without inventing earlier consumption. |
| Product code fails cleanup; compare a trusted adapter that violates its advertised contract. | The first is a candidate failure when the expectation was published. The second is an evaluator failure, with no candidate deduction for the broken guarantee. |

## Information that must exist before any family is scored

| Required public artifact | What must be exact |
| --- | --- |
| API and adapter types | Methods, parameters, return/exception unions, receipts, event ordering, cancellation and idempotency semantics; compile-ready files and examples. |
| Responsibility manifest | Candidate-owned decisions versus provided guarantees, including process control, holder tracking, authentication, storage and fixture cleanup. |
| State and format contracts | Valid/invalid transitions visible to the API, supported serialized/legacy versions, open/closed field policy, digest/identity rules and lawful fixture construction. |
| Numeric profile | Job capacity, recovery batch behavior if imposed by an adapter, stream/evidence/metadata limits, identifier strength, path constraints, deadlines, leases, reserve, clock precision and progress bounds. |
| Outcome policy | Permitted loss categories, exact blocker/error codes, allowed alternatives and prerequisites for progress versus refusal. |
| Environment and submission | Runtime/platform, dependencies, permitted edits/tools, budget, submission boundary and commands. |
| Public tests/examples | A readable input/event/expected-output example per family, plus progress/refusal controls for distinct decision rules; actual executable examples consistent with the supplied types. |
| Score manifest | Applicable family IDs, mandatory/safety designations, group weights, denominator and invalid-measurement policy, frozen before the attempt. |

These artifacts are not all present yet. A textual example or broad family mapping
does not replace the missing exact adapter contract. The rows below therefore
describe proposed obligations; they do not authorize scoring against this draft.

## Public behavior families

Each row is a candidate-visible expectation. Concrete hidden tests must stay within
that expectation and the released profile. A row marked conditional is either
included or excluded in the public manifest before every compared attempt; it is
never selectively removed after inspecting one model's result.

<!-- GENERATED FAMILIES -->

### Group A

| Family / requirement | Given, event and expected outcome |
| --- | --- |
| <a id="a01"></a>A01 / A1 | Move ownership before, inside and after the protected effect boundary. The old owner performs zero new effects; the current owner progresses. Supervisor remains available. |
| <a id="a02"></a>A02 / A1 | When the coordinator reports temporary unavailability, follow its published retry/readiness contract without unauthorized effects. Distinguish foreign authority from an issued effect whose result is unknown; retain the latter for safe reconciliation. |
| <a id="a03"></a>A03 / A1 | Replace a control request while an older apply/stale-retire operation waits. Only the exact request observed inside the protected boundary may be changed. |
| <a id="a04"></a>A04 / A1–A2 | Validate safe integral next sequence and epoch provenance. Lower former-epoch retirement may resume with current authority; future epoch and same-epoch foreign owner are refused. |
| <a id="a05"></a>A05 / A2 | Pause an ACK transaction between retained-file/checkpoint/ACK changes and read concurrently. Observe coherent before/after state or explicit retry, never a torn mix. |
| <a id="a06"></a>A06 / A2 | Crash after intent publication, payload retirement, cursor commit and ACK update. Restart is exact and idempotent; unfinished intent remains accounted. |
| <a id="a07"></a>A07 / A2 | Change actual payload bytes or fields defined by the published record format: stream, sequence, offset, length, digest or artifact identity. Reject invalid acceptance/retirement; do not enforce an unpublished filename convention. |
| <a id="a08"></a>A08 / A3 | A slow consumer is awaiting while independent output/authority work must advance. Both make permitted progress without synchronization being held across the consumer wait or deadlocking a nested operation. No particular lock design is required. |
| <a id="a09"></a>A09 / A3 | Delay process-identity inspection while output and timers must advance. Observation remains asynchronous and bounded, and rereads authority/output after the wait. |
| <a id="a10"></a>A10 / A3 | For an adapter operation declared exclusive, concurrent terminal observers of the same exact job/epoch share its outstanding inspection. Cancel/detach/replace while cancellation is pending; retain and join the issued work before an incompatible replacement. |
| <a id="a11"></a>A11 / A4 | First terminal callback unsubscribes a later listener or detaches the channel. Later callback is not delivered; shared waiters settle consistently. |
| <a id="a12"></a>A12 / A4 | Callback adds/replaces a subscription and changes durable terminal state. The new registration sees a fresh result; old unsubscribe cannot remove it. |
| <a id="a13"></a>A13 / A4 | Enter output-error handling and re-subscribe once from its terminal callback. Exactly one notification occurs in that dispatch and the event loop can unwind. |
| <a id="a14"></a>A14 / A2–A3 | Queue appears empty while ACK publication, ACK retirement or consumer completion remains in flight. Settlement waits for all required current-epoch facts. |
| <a id="a15"></a>A15 / A1–A3 | Deadline or epoch changes during the final snapshot/attestation or inside an issued ACK callback. No stale/expired success is published. |

### Group B

| Family / requirement | Given, event and expected outcome |
| --- | --- |
| <a id="b01"></a>B01 / B1 | Reopen after running, stopping, input-unavailable, backend-unavailable, unknown, cleanup-pending and cleanup-blocked situations. Every owned unfinished job receives an explicit disposition without relaunch. Internal enum spelling is unrestricted except for published API types. |
| <a id="b02"></a>B02 / B2 | Exercise pending, issued and verified resource outcomes through the supplied storage contract and fresh reopen. Predecessor requirements hold at committed transitions; final release refuses every incomplete conjunction and permits the complete one. No particular number of store implementations is required. |
| <a id="b03"></a>B03 / B2 | Retry cleanup with an old attempt ID, foreign epoch or invalid chronology; also take over a job with legitimate earlier verified facts. Reject forgery while preserving earlier proof under its own owner/time. |
| <a id="b04"></a>B04 / B3 | A held stop/release is requested twice. Join one issued effect and its original deadline. After timeout keep exact ownership until its late result is reconciled. |
| <a id="b05"></a>B05 / B3 | New owner takes over while old callbacks or deadline watchers return. Old completion cannot change successor revision, borrow its epoch or install a channel; new owner uses current authority. |
| <a id="b06"></a>B06 / B3 | Exhaust budget before entry, between resources, during reattachment and at final settlement. Apply the same absolute deadline, including nested reserve/lease rules declared by the interface. |
| <a id="b07"></a>B07 / B2–B3 | Crash after each resource intent and after each verified fact. Preserve completed facts; reconcile only with supported receipts/observations and retain exact unknown attempts otherwise. |
| <a id="b08"></a>B08 / B2 | Backend release occurs before the service records its result, then restart without an exact receipt. Preserve unknown outcome; with an exact supported receipt, safely reconcile. |
| <a id="b09"></a>B09 / B2 | A cleanup call resolves but the durable owned record remains blocked. Reinspect authority before replacement/start/close. |
| <a id="b10"></a>B10 / B4 | Produce a final frame only during the terminal output barrier. Keep intake alive until the barrier and subsequent intake settle, then finalize and detach. |
| <a id="b11"></a>B11 / B4 | Stop the client pump with an accepted, undelivered frame; workload quiescence is gated on its ACK. Install private evidence intake first and complete without client redelivery. |
| <a id="b12"></a>B12 / B4 | After evidence was finalized, reattach with exact consumed replay, new suffix, corrupt bytes, changed checkpoint or missing/blocked terminal barrier. Only admissible authenticated replay settles. |
| <a id="b13"></a>B13 / B5 | No running job exists but setup still owns unresolved resources. Close reports failure; the client can inspect and legitimately retry through the public API. Once exact obligations and recovery failures are settled, retry succeeds. |
| <a id="b14"></a>B14 / B1–B5 | Within published job capacity, place an unfinished record beyond one declared recovery batch, preceded by terminal records. Close accounts for every owned record. A fixed batch size or a particular scan algorithm is not required. |
| <a id="b15"></a>B15 / B1–B5 | A setup record is handed off to a released successor; compare missing, foreign and unfinished successor variants. Accept only its exact released pair. |
| <a id="b16"></a>B16 / B5 | A settlement fails or late-cleanup failure is reported after other jobs become terminal. All recovery work used by close contributes to its outcome, and inspection/retry remains possible. No specific number of recovery passes is required. |
| <a id="b17"></a>B17 / B2–B4, C5 | After setup-channel intent but before initial checkpoint creation, prove current exact authority, no earlier accepted/consumed/retired output and a reconstructible retained stream. Bootstrap one atomic private continuation and progress. A previously created but missing checkpoint, ambiguous retirement or corrupt bytes must block. |

### Group C

| Family / requirement | Given, event and expected outcome |
| --- | --- |
| <a id="c01"></a>C01 / C1–C2 | Accept old bytes, dispose the service, reopen fresh storage/controller objects and append new bytes. Final content is exactly old+new with conserved stream totals. |
| <a id="c02"></a>C02 / C2 | Interrupt between durable evidence publication and its accepted-state commit using documented storage boundaries. Only committed evidence counts; partial/orphaned data is not accepted. A transactional design that avoids separate segment/page states is equally valid. |
| <a id="c03"></a>C03 / C1–C2 | Corrupt/miss an artifact; swap a valid-hash page or segment from another identity; omit an earlier committed segment. Reject the chain. |
| <a id="c04"></a>C04 / C1–C2 | Independently exhaust the published payload and metadata capacities, including many tiny chunks. Keep data/metadata growth bounded and positions/loss accounting exact. Legacy-reference limits apply only when that format/profile was publicly supplied. |
| <a id="c05"></a>C05 / C2 | Supply records invalid under the published schemas: unsupported versions, malformed positions, foreign authority or inconsistent loss. Reject extra fields only for explicitly closed formats; accept documented extensions. A valid integrity signature alone does not make an invalid state admissible. |
| <a id="c06"></a>C06 / C1 | Delay evidence persistence while consumption is requested. Delivery/consumption and ACK wait for their published durable prerequisites. Failed authority commit permits neither invented evidence success nor ACK. |
| <a id="c07"></a>C07 / C1 | Fail artifact writes or privacy permission; separately corrupt protocol bytes or fail checkpoint CAS. Only allowed diagnostic failures produce committed categorized loss. |
| <a id="c08"></a>C08 / C3 | Replay at accepted, consuming-intent, consumed and ACKed boundaries. Exact accepted replay shares the committed bytes; consumed replay causes no repeat effect; uncertain intent stays unknown. |
| <a id="c09"></a>C09 / C2 | Restore is interrupted after some earlier evidence has been reconstructed, or a downstream write has an unknown result. Retry does not duplicate bytes or certify an ambiguous view; safer atomic restoration is permitted. |
| <a id="c10"></a>C10 / C2 | Change evidence head/revision during artifact reads and during restore side effects, including same-epoch stale views. Revalidate before accepting the result. |
| <a id="c11"></a>C11 / C2 | Conditional on a supplied supported legacy format: its prefix cannot be reconstructed, but later bytes and earlier valid evidence remain available. Preserve all provable data with the declared gap; do not claim lossless continuity. |
| <a id="c12"></a>C12 / C2–C4 | Request active handoff with wrong ownership, a finalized checkpoint, ambiguous consumption or another state forbidden by the public transition table. Refuse with no unauthorized effect; a valid active handoff succeeds. Terminal evidence transfer is a different permitted operation. |
| <a id="c13"></a>C13 / C4 | Finalize twice or recover an already finalized exact manifest. Reuse immutable evidence; changed references are rejected; no extra finalization attempt is invented. |
| <a id="c14"></a>C14 / C4 | Valid output/evidence succeeds while channel cleanup fails or stays pending. Persist exact partial success and retain the checkpoint; later channel success permits retirement. |
| <a id="c15"></a>C15 / C4 | Output is claimed successful while another cleanup resource is blocked, but the evidence is unfinalized, contains pending consumption or has mismatched identity/loss. Reject invalid partial success on every storage profile the task actually requires. |
| <a id="c16"></a>C16 / C4 | Interrupt the source-checkpoint retirement and terminal ownership transfer at documented commit boundaries. Committed state retains either the valid source obligation or its authenticated terminal destination. An exact retry is idempotent; a foreign destination rejects. Do not assume reference-specific SQL or physical file deletion. |
| <a id="c17"></a>C17 / C4 | Reopen a released job and read its retained evidence through published APIs; run any declared reclamation operation. All required earlier and final evidence remains reachable. Alternative content/index representations are accepted. |
| <a id="c18"></a>C18 / C4, E4 | Exercise repeated cleanup through public ownership handles where an owned artifact root is already absent. No deletion is needed. An existing root with missing/replaced identity, alias or foreign entry remains protected. The test must not require the candidate to instantiate a particular spool class. |
| <a id="c19"></a>C19 / C4–C5 | Final evidence commits, a later cleanup step fails, then the service restarts. Reuse the exact immutable evidence through effect-free verification and a current-authority atomic observation. Changed revision, accepted bytes, ownership or deadline during the wait refuses stale success; no duplicate finalization is needed. |

### Group D

| Family / requirement | Given, event and expected outcome |
| --- | --- |
| <a id="d01"></a>D01 / D1 | Launch child/descendant group while a separate witness observes output; capture identity before workload release. Force stop targets workload only and preserves terminal observation. |
| <a id="d02"></a>D02 / D1 | Lose/recycle anchor, process birth or group between inspection and effect. Validate exact identity again inside the control boundary; no numeric fallback. |
| <a id="d03"></a>D03 / D2 | At startup or stop, present an authenticated release request with wrong owner, epoch, witness identity or replaced request identity. Only the exact currently authorized request may be consumed. Its on-disk marker representation is not prescribed. |
| <a id="d04"></a>D04 / D2 | Publish release request, then kill/disappear the anchor before consumption; compare exact consumed record with a compatible clean exit. Only the latter is causal natural retirement. |
| <a id="d05"></a>D05 / D3 | Workload exits before stdout/stderr close; tail bytes arrive later. Do not publish terminal stopped/output-settled proof until closure and complete drain. |
| <a id="d06"></a>D06 / D3 | Pipes are closed but unread bytes remain behind retained-output backpressure. Admit/drain and retire ACKs before final settlement; witness stays available. |
| <a id="d07"></a>D07 / D5 | Conditional on the public responsibility manifest assigning holder tracking to the candidate: interrupt a process while it holds a coordination claim. Record its actual birth/holder identity so a proven dead holder can be reclaimed; live, foreign or indeterminate holders block. If an adapter wholly supplies this behavior, it is unscored infrastructure. |
| <a id="d08"></a>D08 / D1, D4 | Conditional on declared identity/legacy formats: current binding and identity must agree; unsupported active control without proof blocks, while documented proven terminal legacy release remains possible. No knowledge of an earlier application format is assumed. |
| <a id="d09"></a>D09 / D3, B3 | ACK or output settlement is held during graceful-to-force stop and timeout. Exact control count, retained witness and late ownership remain correct. |

### Group E

| Family / requirement | Given, event and expected outcome |
| --- | --- |
| <a id="e01"></a>E01 / E1–E2 | Run two batches concurrently with distinct grants, streams, evidence and ownership. Stop/close one while the other progresses. |
| <a id="e02"></a>E02 / B1, E1–E2 | Fail setup after each successfully constructed owner and before a running job is returned. Attempt every owned close in dependency order and retain unresolved obligations. |
| <a id="e03"></a>E03 / B1, C3, E1 | Interrupt the actual service at a documented setup-to-running handoff and later consumption/cleanup boundary. Recovery neither invents a running successor nor launches a duplicate workload; it either progresses from sufficient proof or preserves the required blocker. The evaluator must actually reach the named crash boundary. |
| <a id="e04"></a>E04 / B4, D3, E1 | Produce persistent output larger than retention/spill thresholds; stop with final bytes/ACKs pending. Verify exact bytes or permitted loss plus all release facts. |
| <a id="e05"></a>E05 / E2 | Issue an asynchronous operation that can reject before any subsequent marker wait. Observe it immediately, preserve its error, close owners and join the pending result. |
| <a id="e06"></a>E06 / E2–E3 | Throw at construction, primary work, pre-close, close and proof, including `0`, `false`, `null` and `undefined`. Attempt all required closes/proofs and retain diagnostics on failure. |
| <a id="e07"></a>E07 / E1–E3 | After successful close, a fresh instance using the published reopen/inspection API observes the required durable terminal facts. Failed close preserves inspectability and diagnostics. Disposal occurs only after proof; no specific read-only database handle or reference helper is required. |
| <a id="e08"></a>E08 / E3 | All pre-disposal proofs pass, first removal succeeds and next removal fails. Stop further removals and report exact remaining artifacts plus original failure. |
| <a id="e09"></a>E09 / E4 | Create concurrent identities and nested storage paths within the published capacity, uniqueness and platform path constraints. Actual permitted I/O succeeds without weakening identity. No specific UUID length, directory scheme or SQLite backend is required unless publicly supplied. |


## Authenticated source continuation

B17 additionally covers the exact progress and refusal rules in [source-bootstrap.md](source-bootstrap.md), with concrete mandatory variants in source-variants.json. Its requirement mapping includes B2–B4, C1–C3, C5. Existing family obligations remain mandatory. A source prefix is transport history explicitly accounted as source-prefix-unavailable; consumed counts actual authenticated suffix client or authorized private-retention dispositions, and acked counts exact suffix ACK retirements. Neither includes the unavailable prefix.
