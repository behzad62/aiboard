# Implement a recoverable job service

**Executable profile precedence:** [runtime-contract.md](runtime-contract.md) and the packaged contract.d.ts define exact API, event, handoff and fault semantics. Provisional narrative wording below does not introduce additional RPCs or stricter private layouts. Qualification/admission status is recorded separately; documentation alone does not admit a family.


You are implementing the missing core of a standalone job service. The starter
project supplies interfaces and low-level adapters, not the lifecycle implementation.
Your code must work under ordinary execution, interrupted operations, concurrent
requests and service restart.

This complete normative assignment includes problem.md, acceptance-contract.md, runtime-contract.md, contract.d.ts and source-bootstrap.md. The package also supplies families.json, source-variants.json, the empty service.js core, examples.mjs and public-test.mjs. Read all five specification files; examples illustrate observable behavior, not a service implementation. Qualification and admission remain pending and are recorded separately.

## Service behavior

A client creates a batch and starts jobs within it. A job executes a small supplied
workload, produces stdout/stderr and owns a process-control capability, an output
channel and an isolation allocation. Job setup may fail before a usable running
job is returned. The service must still account for resources acquired during setup.

Clients can read output, acknowledge consumption, request stop, inspect status and
close a batch. After service restart, recovery must resume from durable state without
silently starting the workload again. A replacement service owner receives a higher
ownership epoch; an older owner can still have an asynchronous operation in flight.

The public interface exposes these operations (exact signatures are supplied by the
starter): open service; create batch; start job; subscribe/unsubscribe output or
terminal events; consume/acknowledge output; stop job; recover batch; inspect batch
or job; close batch; close service. Output has stable job/stream identity, sequence,
byte offset, length and digest. Methods report explicit success, pending, blocked,
stale or unknown outcomes as appropriate. Blockers use categorical codes and retain
the resource obligation; implementation-specific exception prose is not graded.

## A. Ownership and output protocol

**A1.** Effects require the exact current owner/epoch and authenticated resource
identity. Validate at the protected effect, not only before a wait. Old or foreign
owners cannot signal, acknowledge, delete, advance state or remove a successor's
replacement request. A temporarily busy coordinator is distinct from invalid
authority or an effect whose application is unknown.

**A2.** Read output, checkpoint positions and acknowledgement state as one coherent
view. Verify actual payload bytes against identity, length, digest and contiguous
stream positions before accepting or retiring them. Interrupted retirement must
resume exactly when durable intent proves how; unexplained missing files remain
blocked. Repeating an acknowledged item cannot delete a different item.

**A3.** Synchronization must not remain held while awaiting consumers, process
inventory or arbitrary asynchronous work. Observation cannot starve output progress.
Concurrent observers share tracked work where necessary; cancellation does not
pretend that an underlying operation has already finished.
For a primitive documented as exclusive, overlapping observers for the same exact
job/epoch must share its one outstanding inspection. Other synchronization designs
are allowed when they provide the same progress, lifetime and exclusivity outcomes;
the evaluator does not require a particular lock, promise map or loop structure.

**A4.** A removed listener receives no later callback. Detach prevents later delivery.
A listener may remove, replace or add a listener inside its callback. Each
registration has its own lifetime; unsubscribing an old registration cannot cancel
its replacement. New registrations receive fresh observation, including after an
output error, rather than joining an already-running terminal dispatch.

## B. Cleanup and recovery

**B1.** Persist job and setup ownership before effects that can acquire resources.
Account for every unfinished state and every setup record, including jobs beyond
one bounded recovery batch. A handed-off setup record is terminal only when its
exact successor job has the required terminal disposition.

**B2.** Record cleanup progress per resource. Preserve valid completed facts through
retry and restart, with their original provenance. Do not replay an issued effect
with an unknown outcome unless the public adapter contract proves it is safe.
Use observation/receipts to reconcile work where supported; otherwise retain a
specific blocker. A missing resource is not automatically proof of completed cleanup.
Enforce cleanup prerequisites at durable transitions, not only in the outer loop:
a successor resource may not begin before its required predecessors are verified.

**B3.** Carry one absolute deadline through an operation and its nested work. A
timeout stops waiting, not ownership. Track late acquisition, inspection, detach,
stop and release operations until they settle. Prevent duplicate/overlapping
effects; old results cannot update a newer owner. Revalidate deadline, epoch and
relevant state after asynchronous waits.

Before the deadline an authorized effect may commit success; at or after it,
ordinary completion must retain a categorical deadline disposition rather than
certify success. The configured ownership lease must cover the operation and its
declared settlement reserve. Later authenticated reconciliation is a separate
decision. An old timeout watcher cannot borrow a successor's epoch to write state.

**B4.** Cleanup may install an authenticated private reader to persist evidence and
advance ACKs when the client consumer has stopped. Install it before waiting for
quiescence when backpressure requires that progress. It must not deliver output
again to the client, send workload protocol responses, or relaunch the job.
Quiescence and final output exhaustion remain separate facts.

**B5.** Close must consume recovery failures and independently verify every owned
record. Unresolved ownership rejects close and leaves inspection and safe retry
available. With sufficient valid evidence, recovery and close must finish. Returning
blocked for every request is not a correct implementation.

## C. Durable evidence

**C1.** Persist accepted bytes or an explicitly allowed diagnostic-loss record
before consumption and ACK. Evidence is bounded by the supplied byte/metadata limits.
Storage/privacy refusal may produce a truthful categorized diagnostic gap where
the contract allows it; corruption or failed authority commit is not optional loss.
Required output protocol accounting must remain exact even if diagnostic retention
is lossy.

**C2.** A fresh service instance must recover committed evidence and append later
bytes without duplication, reordering or silent omission. Validate the complete
committed chain, positions and byte totals, not merely a root hash. Uncommitted
files left by a crash do not become accepted evidence. Reject malformed, foreign,
future-version or tampered records. Supplied supported legacy formats must migrate
conservatively, retaining a declared gap when old data cannot be reconstructed.

**C3.** Accepted-but-unconsumed output and consumed output are different. An exact
accepted replay may resume its one pending delivery. Already consumed replay must
not repeat the consumer effect. If a crash leaves an ambiguous consumption intent,
retain unknown status until the supplied receipt/authority contract proves its
outcome; do not claim universal exactly-once delivery without that proof.

**C4.** Final evidence is immutable. Transfer its authenticated ownership/reference
to the terminal job record atomically with retiring the source checkpoint, after
the current channel reader's obligation settles. Each exact channel has one
current attachment across both reader modes: a newly applied attach supersedes
the prior receipt, while exact replay of an old attach does not reinstall it.
Superseded receipts are historical evidence, not additional current reader
obligations; outstanding-call reconciliation requirements still apply. See the
raw-port rules in source-bootstrap.md. Valid partial progress must be persisted
without deleting that checkpoint, and its evidence must be validated even when a
different resource remains blocked. Repeating finalization must reuse an already
verified result, not mutate it or fabricate a new cleanup attempt.

**C5.** Distinguish 'checkpoint was never initialized' from 'previously created
checkpoint is missing.' If exact setup authority and a coherent retained stream
prove a safe initial continuation, bootstrap it atomically and recover privately.
Do not invent earlier accepted/consumed positions. Missing prior evidence, unknown
retirement or ambiguous bytes must remain blocked. A manifest committed before a
later cleanup exception may be verified without replaying finalization.

## D. Process lifecycle

**D1.** Keep the supervisor/control witness separate from the workload's destructive
stop target. Capture exact process/group identity before allowing workload execution.
Use authenticated capabilities, not numeric PID/group identifiers alone. Recycled
identity, foreign witness or indeterminate inspection cannot authorize control.

**D2.** Natural retirement requires evidence that the exact authorized release
request was consumed and a compatible terminal outcome occurred. Request publication
followed by empty group membership is insufficient. Stop/release markers must be
bound to the current authority when consumed, including during startup.

**D3.** Distinguish workload exit, pipe closure, complete draining, output acceptance,
ACK retirement and supervisor exit. A momentarily empty queue does not prove that
tail bytes cannot arrive. Closed pipes may still contain unread bytes under
backpressure. Preserve the witness until the required terminal output proof exists.

**D4.** Preserve these semantics for every declared platform profile. A modeled
process test does not establish native platform correctness. The task manifest
states which deterministic/native profiles are mandatory for this submission.

**D5.** When coordination-holder tracking belongs to the candidate's implementation,
record the actual process that acquired the claim and its authenticated birth
identity, separately from the logical supervisor/job owner. A provably dead holder
may be reclaimed through the supplied primitive; a live or indeterminate holder
may not. If the starter adapter implements this entire behavior, it is evaluator
qualification and earns no candidate points. The responsibility manifest must
declare this distinction before the attempt.

## E. Composition and final outcome

**E1.** A job can be durably released only after every applicable fact is verified:
workload quiescent; retained output settled; evidence finalized or validly marked
diagnostically lossy; channel detached; process authority released; isolation
released. Physical absence or a resolving cleanup promise alone is insufficient.

**E2.** Jobs and batches must remain isolated: one job's grants, output, evidence,
cleanup or close cannot affect another's. Construction failures must close every
successfully acquired owner; observe promises/child completion immediately and
join their outcomes. Preserve the primary error and all relevant cleanup failures,
including failures represented by falsy thrown values.

**E3.** Retain diagnostic artifacts whenever a primary, close or pre-disposal proof
fails. Delete only owned, identity-checked paths after the full proof conjunction.
If deletion itself fails after prior successful deletions, stop subsequent
deletions and report exactly what remains; atomic rollback across separate filesystem
deletions is not required. Do not mask a failure by deleting uncertain evidence.

**E4.** Resource identifiers and paths must support the task's published concurrency,
uniqueness and path-length limits. Absent cached roots may be idempotently complete
when no effect is performed; an existing root with a missing or changed ownership
marker is not the same case. Do not broadly suppress filesystem errors.

## Submission and grading

Implement only service.js. Check it using node public-test.mjs and the supplied
verification command; submit a concise note with tests actually run and limitations.
The supplied contract and test files are protected; do not add submission files.
The evaluator freezes your source at submission or budget expiry and runs separate
tests against it. Your summary and test count do not determine correctness.

Hidden tests implement the requirements above with undisclosed data and schedules.
All scored behavior families and expected outcomes appear in the public acceptance
contract. Only inputs and event schedules within the declared fault model are
hidden. A deduction must identify a published family, requirement and violated
outcome; an undocumented preference or ambiguous requirement cannot reduce a score.
They test both correct progress and safe refusal. Disabling guards, suppressing
required errors, skipping records, extending product deadlines, discarding output,
hard-coding fixture identities or always refusing work fails the contract.

Complete resolution requires all mandatory cases and safety invariants. Partial
coverage and efficiency are reported separately. A safety failure cannot be offset
by speed, lower cost, passing many easy tests or a persuasive explanation.

Authenticated source continuation and its exact loss/consumption distinction are specified in [source-bootstrap.md](source-bootstrap.md). An initial unavailable source prefix never proves client consumption or ACK retirement.
