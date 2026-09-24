# Private evaluator catalogue — Recoverable Job Service

Status: 69 scoring-admitted behavioral families implemented as 302 mandatory
variants for the frozen modeled profile.
Do not include this document, the source map or historical reports in the model's
starter project. The [public problem](problem.md) contains the normative contract.
The [public acceptance contract](acceptance-contract.md) also publishes every
candidate family and expected outcome. This private file provides provenance and
fault ideas; it cannot add scoring obligations beyond those public documents.

The admission checks in `scoring-admission.json` are fulfilled for
`rjs-contract-2.0.1` / `rjs-suite-2.0.1`. A public clause link alone was not used
as qualification: the accepted calibration also establishes predicate sensitivity,
complete controls, replay identity, capacity, determinism, and restored controls.

These scenarios generalize the C1–C5 experience without reusing its implementation.
Each row can contain several variants, but earns at most one family result. Group
weights are equal as specified in the [benchmark design](../../superpowers/specs/2026-09-08-recoverable-job-service-benchmark-design.md).
Source keys refer to the private historical map at the end. A historical accepted
fix did not by itself admit a standalone benchmark case. Final admission required
the separate frozen reference, complete controls, and material predicate probes.

`Required` means candidate behavior in the stated profile. `Infrastructure` means
qualification of the trusted evaluator, with no candidate points. `Unresolved source`
means the historical diagnosis/reference is incomplete; the standalone requirement
must be proven independently and must not use the old failure as its answer key.

## A — Ownership and streaming

| ID / public clause | Trigger and required observable outcome | Fault that the oracle must reject | Source |
| --- | --- | --- | --- |
| A01 / A1 | Move ownership before, inside and after the protected effect boundary. The old owner performs zero new effects; the current owner progresses. Supervisor remains available. | Check epoch only before awaiting, or turn ordinary staleness into fatal observer exit. | S01 |
| A02 / A1 | When the coordinator reports temporary unavailability, follow its published retry/readiness contract without unauthorized effects. Distinguish foreign authority from an issued effect whose result is unknown; retain the latter for safe reconciliation. | Blanket-catch every error as stale/success; continue the same ACK pass after a deferred mutation. | S01 |
| A03 / A1 | Replace a control request while an older apply/stale-retire operation waits. Only the exact request observed inside the protected boundary may be changed. | Old request completion deletes the successor's request. | S01 |
| A04 / A1–A2 | Validate safe integral next sequence and epoch provenance. Lower former-epoch retirement may resume with current authority; future epoch and same-epoch foreign owner are refused. | Accept gaps/fractional sequence or a plausible but foreign retirement intent. | S01 |
| A05 / A2 | Pause an ACK transaction between retained-file/checkpoint/ACK changes and read concurrently. Observe coherent before/after state or explicit retry, never a torn mix. | Combine an old filename list with new cursor state. | S01 |
| A06 / A2 | Crash after intent publication, payload retirement, cursor commit and ACK update. Restart is exact and idempotent; unfinished intent remains accounted. | Treat a partly applied transaction as complete or decrement retained bytes twice. | S01 |
| A07 / A2 | Change actual payload bytes or fields defined by the published record format: stream, sequence, offset, length, digest or artifact identity. Reject invalid acceptance/retirement; do not enforce an unpublished filename convention. | Trust metadata or a matching filename without authenticating actual bytes. | S01, S04 |
| A08 / A3 | A slow consumer is awaiting while independent output/authority work must advance. Both make permitted progress without synchronization being held across the consumer wait or deadlocking a nested operation. No particular lock design is required. | Hold the lock across the consumer, or reacquire the same non-reentrant lock. | S01 |
| A09 / A3 | Delay process-identity inspection while output and timers must advance. Observation remains asynchronous and bounded, and rereads authority/output after the wait. | Synchronous inspection repeatedly starves the loop or uses its stale snapshot as effect authority. | S02 |
| A10 / A3 | For an adapter operation declared exclusive, concurrent terminal observers of the same exact job/epoch share its outstanding inspection. Cancel/detach/replace while cancellation is pending; retain and join the issued work before an incompatible replacement. | Drop the handle on abort and launch overlapping inspection. | S02 |
| A11 / A4 | First terminal callback unsubscribes a later listener or detaches the channel. Later callback is not delivered; shared waiters settle consistently. | Deliver every listener copied before the first callback without lifetime rechecks. | S02, S03 |
| A12 / A4 | Callback adds/replaces a subscription and changes durable terminal state. The new registration sees a fresh result; old unsubscribe cannot remove it. | Same-callback identity merges generations or dispatches the predecessor's result. | S03 |
| A13 / A4 | Enter output-error handling and re-subscribe once from its terminal callback. Exactly one notification occurs in that dispatch and the event loop can unwind. | Live collection iteration immediately visits appended registrations indefinitely. | S03 |
| A14 / A2–A3 | Queue appears empty while ACK publication, ACK retirement or consumer completion remains in flight. Settlement waits for all required current-epoch facts. | Treat ACK publication alone, coordination unavailability or a momentarily empty snapshot as settlement. | S04 |
| A15 / A1–A3 | Deadline or epoch changes during the final snapshot/attestation or inside an issued ACK callback. No stale/expired success is published. | Only check the deadline/epoch at method entry. | S04 |

## B — Cleanup and recovery

| ID / public clause | Trigger and required observable outcome | Fault that the oracle must reject | Source |
| --- | --- | --- | --- |
| B01 / B1 | Reopen after running, stopping, input-unavailable, backend-unavailable, unknown, cleanup-pending and cleanup-blocked situations. Every owned unfinished job receives an explicit disposition without relaunch. Internal enum spelling is unrestricted except for published API types. | Filter recovery to running jobs and silently omit the rest. | S04 |
| B02 / B2 | Exercise pending, issued and verified resource outcomes through the supplied storage contract and fresh reopen. Predecessor requirements hold at committed transitions; final release refuses every incomplete conjunction and permits the complete one. No particular number of store implementations is required. | Let a generic boolean, out-of-order begin or alternate command bypass resource facts. | S04 |
| B03 / B2 | Retry cleanup with an old attempt ID, foreign epoch or invalid chronology; also take over a job with legitimate earlier verified facts. Reject forgery while preserving earlier proof under its own owner/time. | Compare historical proof only to latest takeover time, reuse attempt IDs or accept signed but invalid facts. | S04 |
| B04 / B3 | A held stop/release is requested twice. Join one issued effect and its original deadline. After timeout keep exact ownership until its late result is reconciled. | Start a second effect because the first caller stopped waiting. | S04 |
| B05 / B3 | New owner takes over while old callbacks or deadline watchers return. Old completion cannot change successor revision, borrow its epoch or install a channel; new owner uses current authority. | Join promises across ownership generations or accept a stale late success. | S04 |
| B06 / B3 | Exhaust budget before entry, between resources, during reattachment and at final settlement. Apply the same absolute deadline, including nested reserve/lease rules declared by the interface. | Reset nested timeouts or permit a last effect just after deadline. | S04 |
| B07 / B2–B3 | Crash after each resource intent and after each verified fact. Preserve completed facts; reconcile only with supported receipts/observations and retain exact unknown attempts otherwise. | Repeat detach/release blindly or invent completion from absent metadata. | S04 |
| B08 / B2 | Backend release occurs before the service records its result, then restart without an exact receipt. Preserve unknown outcome; with an exact supported receipt, safely reconcile. | Treat an absent backend directory as proof or repeat the release. | S04 |
| B09 / B2 | A cleanup call resolves but the durable owned record remains blocked. Reinspect authority before replacement/start/close. | Trust promise resolution and replace an unreleased resource. | S04, S07 |
| B10 / B4 | Produce a final frame only during the terminal output barrier. Keep intake alive until the barrier and subsequent intake settle, then finalize and detach. | Finalize evidence after an empty in-memory snapshot before the final frame arrives. | S05 |
| B11 / B4 | Stop the client pump with an accepted, undelivered frame; workload quiescence is gated on its ACK. Install private evidence intake first and complete without client redelivery. | Sequentially wait for quiescence before creating the reader needed to unblock it. | S06 |
| B12 / B4 | After evidence was finalized, reattach with exact consumed replay, new suffix, corrupt bytes, changed checkpoint or missing/blocked terminal barrier. Only admissible authenticated replay settles. | Fabricate evidence for new bytes or detach before checking the latest checkpoint/barrier. | S04, S05 |
| B13 / B5 | No running job exists but setup still owns unresolved resources. Close reports failure; the client can inspect and legitimately retry through the public API. Once exact obligations and recovery failures are settled, retry succeeds. | Close stores and unregister because the running-session list is empty. | S07 |
| B14 / B1–B5 | Within published job capacity, place an unfinished record beyond one declared recovery batch, preceded by terminal records. Close accounts for every owned record. A fixed batch size or a particular scan algorithm is not required. | Equate completion of one bounded recovery pass with all ownership being released; do not require a fixed 1,024-row implementation. | S07 |
| B15 / B1–B5 | A setup record is handed off to a released successor; compare missing, foreign and unfinished successor variants. Accept only its exact released pair. | Reject every handed-off record, or accept handed-off status without validating the successor. | S07 |
| B16 / B5 | A settlement fails or late-cleanup failure is reported after other jobs become terminal. All recovery work used by close contributes to its outcome, and inspection/retry remains possible. No specific number of recovery passes is required. | Ignore recovery failures because the final durable scan looks terminal. | S07 |
| B17 / B2–B4, C5 | After setup-channel intent but before initial checkpoint creation, prove current exact authority, no earlier accepted/consumed/retired suffix output and a reconstructible retained stream or authenticated source prefix. Bootstrap one atomic private continuation and progress. A previously created but missing checkpoint, ambiguous retirement or corrupt bytes must block. | Unconditionally reject all such recovery, reset an authenticated nonzero source position to zero, or initialize an empty checkpoint from absence alone. Qualified by the final authenticated-source controls and probes. | S17 |

## C — Durable evidence

| ID / public clause | Trigger and required observable outcome | Fault that the oracle must reject | Source |
| --- | --- | --- | --- |
| C01 / C1–C2 | Accept old bytes, dispose the service, reopen fresh storage/controller objects and append new bytes. Final content is exactly old+new with conserved stream totals. | In-memory-only evidence, duplicate prefix, reordered streams or silent loss. | S08 |
| C02 / C2 | Interrupt between durable evidence publication and its accepted-state commit using documented storage boundaries. Only committed evidence counts; partial/orphaned data is not accepted. A transactional design that avoids separate segment/page states is equally valid. | Advance accepted state before its bytes are durable. | S08 |
| C03 / C1–C2 | Corrupt/miss an artifact; swap a valid-hash page or segment from another identity; omit an earlier committed segment. Reject the chain. | Trust a root digest without identity, order, completeness and actual-byte verification. | S08 |
| C04 / C1–C2 | Independently exhaust the published payload and metadata capacities, including many tiny chunks. Keep data/metadata growth bounded and positions/loss accounting exact. Legacy-reference limits apply only when that format/profile was publicly supplied. | Enforce only parser bounds, permit unbounded writes, or lose position accounting at capacity. | S08 |
| C05 / C2 | Supply records invalid under the published schemas: unsupported versions, malformed positions, foreign authority or inconsistent loss. Reject extra fields only for explicitly closed formats; accept documented extensions. A valid integrity signature alone does not make an invalid state admissible. | Assume a valid MAC makes a semantically invalid state valid, or impose an unpublished closed-object policy. | S08 |
| C06 / C1 | Delay evidence persistence while consumption is requested. Delivery/consumption and ACK wait for their published durable prerequisites. Failed authority commit permits neither invented evidence success nor ACK. | Deliver early or ACK after failed authority CAS. | S08 |
| C07 / C1 | Fail artifact writes or privacy permission; separately corrupt protocol bytes or fail checkpoint CAS. Only allowed diagnostic failures produce committed categorized loss. | Convert every storage/integrity error into successful optional loss. | S08 |
| C08 / C3 | Replay at accepted, consuming-intent, consumed and ACKed boundaries. Exact accepted replay shares the committed bytes; consumed replay causes no repeat effect; uncertain intent stays unknown. | Repeat consumption or reject a legitimate exact accepted replay as a gap. | S08 |
| C09 / C2 | Restore is interrupted after some earlier evidence has been reconstructed, or a downstream write has an unknown result. Retry does not duplicate bytes or certify an ambiguous view; safer atomic restoration is permitted. | Replay restoration writes blindly after partial failure. | S08 |
| C10 / C2 | Change evidence head/revision during artifact reads and during restore side effects, including same-epoch stale views. Revalidate before accepting the result. | Authenticate a stale result with a newer head. | S08 |
| C11 / C2 | Conditional on a supplied supported legacy format: its prefix cannot be reconstructed, but later bytes and earlier valid evidence remain available. Preserve all provable data with the declared gap; do not claim lossless continuity. | Drop the healthy suffix or claim lossless continuity. | S08 |
| C12 / C2–C4 | Request active handoff with wrong ownership, a finalized checkpoint, ambiguous consumption or another state forbidden by the public transition table. Refuse with no unauthorized effect; a valid active handoff succeeds. Terminal evidence transfer is a different permitted operation. | Adopt a superficially matching but semantically ineligible checkpoint. | S08 |
| C13 / C4 | Finalize twice or recover an already finalized exact manifest. Reuse immutable evidence; changed references are rejected; no extra finalization attempt is invented. | Mutate finalized authority or re-run side effects. | S08, S11 |
| C14 / C4 | Valid output/evidence succeeds while channel cleanup fails or stays pending. Persist exact partial success and retain the checkpoint; later channel success permits retirement. | Roll back legitimate partial progress or delete the last reader's source. | S09 |
| C15 / C4 | Output is claimed successful while another cleanup resource is blocked, but the evidence is unfinalized, contains pending consumption or has mismatched identity/loss. Reject invalid partial success on every storage profile the task actually requires. | Return early for the blocked channel and skip evidence validation. | S09 |
| C16 / C4 | Interrupt the source-checkpoint retirement and terminal ownership transfer at documented commit boundaries. Committed state retains either the valid source obligation or its authenticated terminal destination. An exact retry is idempotent; a foreign destination rejects. Do not assume reference-specific SQL or physical file deletion. | Release a job despite failed deletion, or accept a different destination on retry. | S08, S09 |
| C17 / C4 | Reopen a released job and read its retained evidence through published APIs; run any declared reclamation operation. All required earlier and final evidence remains reachable. Alternative content/index representations are accepted. | Delete predecessor artifacts because only the final digest is referenced. | S08 |
| C18 / C4, E4 | Exercise repeated cleanup through public ownership handles where an owned artifact root is already absent. No deletion is needed. An existing root with missing/replaced identity, alias or foreign entry remains protected. The test must not require the candidate to instantiate a particular spool class. | Blanket-suppress ENOENT or delete a recreated directory with a cloned marker. | S10 |
| C19 / C4–C5 | Final evidence commits, a later cleanup step fails, then the service restarts. Reuse the exact immutable evidence through effect-free verification and a current-authority atomic observation. Changed revision, accepted bytes, ownership or deadline during the wait refuses stale success; no duplicate finalization is needed. | Finalize twice, reset attempt count, trust a digest alone or settle after facts changed during verification. | S11 |

## D — Process lifecycle

| ID / public clause | Trigger and required observable outcome | Fault that the oracle must reject | Source |
| --- | --- | --- | --- |
| D01 / D1 | Launch child/descendant group while a separate witness observes output; capture identity before workload release. Force stop targets workload only and preserves terminal observation. | Kill the supervisor together with the workload or discover identity only after execution. | S12 |
| D02 / D1 | Lose/recycle anchor, process birth or group between inspection and effect. Validate exact identity again inside the control boundary; no numeric fallback. | Signal by PID/PGID after the witness is gone. | S12 |
| D03 / D2 | At startup or stop, present an authenticated release request with wrong owner, epoch, witness identity or replaced request identity. Only the exact currently authorized request may be consumed. Its on-disk marker representation is not prescribed. | Accept syntactically nonempty authority fields or stale markers. | S12 |
| D04 / D2 | Publish release request, then kill/disappear the anchor before consumption; compare exact consumed record with a compatible clean exit. Only the latter is causal natural retirement. | Infer consumption from request publication plus empty group membership. | S12 |
| D05 / D3 | Workload exits before stdout/stderr close; tail bytes arrive later. Do not publish terminal stopped/output-settled proof until closure and complete drain. | Use exit status and a momentarily empty output queue as proof. | S12 |
| D06 / D3 | Pipes are closed but unread bytes remain behind retained-output backpressure. Admit/drain and retire ACKs before final settlement; witness stays available. | Treat closed pipes as fully drained. | S12 |
| D07 / D5 | Conditional on the public responsibility manifest assigning holder tracking to the candidate: interrupt a process while it holds a coordination claim. Record its actual birth/holder identity so a proven dead holder can be reclaimed; live, foreign or indeterminate holders block. If an adapter wholly supplies this behavior, it is unscored infrastructure. | Record the supervisor as actual holder, or award candidate points for behavior wholly implemented by a provided adapter. | S12 |
| D08 / D1, D4 | Conditional on declared identity/legacy formats: current binding and identity must agree; unsupported active control without proof blocks, while documented proven terminal legacy release remains possible. No knowledge of an earlier application format is assumed. | Blanket-enable unsafe old control or blanket-reject valid terminal compatibility. | S12 |
| D09 / D3, B3 | ACK or output settlement is held during graceful-to-force stop and timeout. Exact control count, retained witness and late ownership remain correct. | Release process authority/witness before terminal output is accounted. | S12, S05 |

## E — Service composition

| ID / public clause | Trigger and required observable outcome | Fault that the oracle must reject | Source |
| --- | --- | --- | --- |
| E01 / E1–E2 | Run two batches concurrently with distinct grants, streams, evidence and ownership. Stop/close one while the other progresses. | Cross-batch cleanup, reads, evidence references or authority reuse. | S18 |
| E02 / B1, E1–E2 | Fail setup after each successfully constructed owner and before a running job is returned. Attempt every owned close in dependency order and retain unresolved obligations. | Lose partial-construction ownership or skip later closes after an earlier exception. | S15, S18 |
| E03 / B1, C3, E1 | Interrupt the actual service at a documented setup-to-running handoff and later consumption/cleanup boundary. Recovery neither invents a running successor nor launches a duplicate workload; it either progresses from sufficient proof or preserves the required blocker. The evaluator must actually reach the named crash boundary. | Crash fixture misses its intended boundary yet reports success, or recovery relaunches to obtain a clean result. | S18 |
| E04 / B4, D3, E1 | Produce persistent output larger than retention/spill thresholds; stop with final bytes/ACKs pending. Verify exact bytes or permitted loss plus all release facts. | Declare close successful from absence alone or drop the tail to unblock it. | S18 |
| E05 / E2 | Issue an asynchronous operation that can reject before any subsequent marker wait. Observe it immediately, preserve its error, close owners and join the pending result. | Unhandled rejection after case end or primary failure overwritten by cleanup error. | S13, S15 |
| E06 / E2–E3 | Throw at construction, primary work, pre-close, close and proof, including `0`, `false`, `null` and `undefined`. Attempt all required closes/proofs and retain diagnostics on failure. | Truthiness drops a primary failure, or the first rejection short-circuits remaining owners. | S15 |
| E07 / E1–E3 | After successful close, a fresh instance using the published reopen/inspection API observes the required durable terminal facts. Failed close preserves inspectability and diagnostics. Disposal occurs only after proof; no specific read-only database handle or reference helper is required. | Query disposed handles, trust close resolution, swallow absence errors or delete before proof. | S15 |
| E08 / E3 | All pre-disposal proofs pass, first removal succeeds and next removal fails. Stop further removals and report exact remaining artifacts plus original failure. | Promise impossible multi-directory rollback, hide the failure or continue destructive cleanup. | S15 |
| E09 / E4 | Create concurrent identities and nested storage paths within the published capacity, uniqueness and platform path constraints. Actual permitted I/O succeeds without weakening identity. No specific UUID length, directory scheme or SQLite backend is required unless publicly supplied. | Add needless suffix length, weaken uniqueness or 'fix' only a string-length assertion. | S16 |

Candidate E families apply to the service's own ownership and exported lifecycle,
not to hidden-test implementation details. When only an evaluator fixture can
trigger a particular bookkeeping failure, classify it under H instead of charging
the model for infrastructure it does not control.

## H — Evaluator qualification, never candidate points

| ID | Infrastructure rule and qualification test | Source |
| --- | --- | --- |
| H01 | Assert exact selected case IDs before execution; keep native tests in separate entry points. Demonstrate that file/suite ancestor matching cannot silently select a forbidden native test. | S07 |
| H02 | Log exact newly acquired fixture roots/capabilities before later effects, terminal command exits and every cleanup disposition. Missing names are unknown, not reconstructed by prefix or replaced by a later rerun. | S07, S15 |
| H03 | Attach child `error`/`close` observation immediately; timeout cancellation must await the owned wrapper's actual close. Test this timeout branch with a bounded fake child. A kill request alone is not a joined handle. **Historical gap remains unproved.** | S18 |
| H04 | Record nested aggregate causes, primary and cleanup failures, and falsy thrown values. An assertion failure must not erase the causal exception needed for triage. | S13, S15, S18 |
| H05 | Distinguish durable acceptance, consumer readiness and consumption. Wait on the actual public readiness boundary; don't invent unrelated marker deadlines. Fixture watchdog sums declared bounded stages without enlarging product deadlines. | S13, S14 |
| H06 | Full known-good control, meaningful faulty-core failure and restored pass must share test/environment identity. Missing imports, invalid fixtures, overwritten logs and setup timeout cannot be counted as causal proof. | S08, S11, S13, S15 |
| H07 | After a case, verify ownership/resource facts before disposal and preserve failed attempts. A later successful fixture cannot retroactively prove or erase an earlier failed crash scenario. | S15, S18 |
| H08 | Qualify Windows/Linux and optional container primitives independently. Use exact evaluator-owned identities; no broad process/label/prefix cleanup that could make inventory falsely green. | S12, S15, S16 |
| H09 | Score immutable submissions with private tests and trusted invocation, validate denominator/mandatory cases, and test scorer behavior for unsafe, incomplete, skipped and infrastructure-invalid outcomes. | Benchmark design |

## Source qualification and known limits

- A/B/C/D rows derive from documented mechanisms, tests and independent reviews,
  including both initially defective fixes and their subsequent corrections. They
  are requirements for a new core, not claims that old source is copied or fully
  validated in this benchmark.
- B17 has an accepted successful reference. Its standalone positive and negative
  source-guard cases are represented in the final predicate ledger and admitted
  independently; historical native residue is not an evaluator input.
- The original native acquisition exception was not retained. Do not assert that
  path length, observation starvation or checkpoint initialization caused it merely
  because those defects were found elsewhere.
- E03's intended pre-transfer crash must be reached and observed by the new fixture.
  An earlier setup failure is a failed/inapplicable execution of that scenario.
- E09 generalizes a real SQLite path failure caused by test identifier expansion.
  It does not establish that every long path is invalid or that a specific compact
  naming scheme is required. Publish supported limits and test actual behavior.
- H03 records a separate timeout/wrapper ownership concern. It needs a new
  deterministic reproduction rather than a claim of an already observed failure.
- Missing historical provenance, corrected impossible disposal promises and
  withdrawn/duplicate review concerns are retained in the source audit. They are
  not additional product bugs or points against a candidate.

## Private source keys

All files below are in the local historical packet
`.superpowers/sdd/2026-09-05-runner-v2-cleanup-coordination/`. The source-map JSON
records exact paths and hashes. These are maintainer research references only.

| Key | Historical documents / relevant finding sections |
| --- | --- |
| S01 | `task-1-report.md`: requirement/proof map, rounds 1–3, material fault matrix. |
| S02 | `task-1-round4-report.md`, `task-1-round4-review.md`: asynchronous observation, retained inspection and reentrant removal/detach. |
| S03 | `task-1-round5-report.md`, `task-1-round5-review.md`, `task-1-cap-review.md`: unique registrations and output-error dispatch. |
| S04 | `task-2-report.md`, `task-2-review-round3.md`, `task-2-review-round4.md`, `task-2-review-round5.md`: schema/chronology, all-state recovery, exact attempts, deadlines, post-evidence replay and settlement. |
| S05 | `task-2-round6-review.md`, `task-3-review-round1.md`: retained reader and terminal barrier for live/pre-session cleanup. |
| S06 | `task-2-round7-report.md`, `task-2-round7-review.md`: private intake before ACK-gated quiescence. |
| S07 | `task-2-close-conjunction-report.md`, `task-2-close-conjunction-review.md`: truthful close, bounded scan, handoff pair and unintended test selection. |
| S08 | `task-3-report.md`: original and repair fault matrices, continuity, bounded storage, atomic transfer and reachability. |
| S09 | `task-3-review-round1.md`, `task-3-round1-review.md`, `task-3-round2-review.md`: partial progress, early-return validation bypass and both-store repair. |
| S10 | `task-3-round3-review.md`: shared spool root already absent versus existing invalid ownership. |
| S11 | `task-3-round4-review.md`: immutable finalized evidence observation and atomic fresh revalidation. |
| S12 | `task-4-report.md`, `task-4-review.md`, `task-4-rereview-round1.md`, `task-4-rereview-round2.md`: workload/witness separation, causal markers, drain, child lock holder and real platform qualifications. |
| S13 | `task-5-report.md`: immediate promise observation, primary-error preservation, marker/call ordering and fixture deadline. |
| S14 | `task-5-round3-report.md`, `task-5-round3-review.md`: accepted output versus delivery-ready state. |
| S15 | `task-5-round4-report.md`, `task-5-round4-review.md`, `task-5-disposal-policy-ruling.md`: all-owner finalization, read-only proof, error retention and feasible disposal semantics. |
| S16 | `task-5-round5-report.md`, `task-5-round5-review.md`, `task-5-strict-path-diagnostic.md`: compact unique IDs and actual SQLite open boundary. |
| S17 | `task-5-precheckpoint-recovery-assessment.md`: never-initialized versus missing checkpoint, authority, bytes and atomic private bootstrap. |
| S18 | `task-5-native-after-round4-summary.md`, `task-5-final-review-preparation.md`: exact integration cases, failed crash/recovery and wrapper timeout concern. |

## Admission record for each executable case

For release, expand each row into concrete case records with: stable family/case IDs;
public clause; complete initial state and event schedule; deterministic seed; expected
durable/effect/byte outcomes; trusted oracle; positive/negative controls; native or
modeled profile; reference/faulty-control hashes and exact commands; finalizer/resource
records; weight/applicability; source finding and disposition; independent review.

No row is admitted until these fields contain real artifacts and the reference and
faulty controls demonstrate the intended behavior. The release audit must also map
every historical review finding to a row or a justified non-scoring disposition.
The number of rows here is a design inventory, not the number of implemented tests.
