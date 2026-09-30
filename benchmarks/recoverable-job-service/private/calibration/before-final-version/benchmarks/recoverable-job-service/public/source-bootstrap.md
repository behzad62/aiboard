# Authenticated source bootstrap — normative rjs-contract-2.0.0

## Source observations and raw guards

The following are wire contracts, not candidate implementation code. Existing IDs, safe-integer rules, JSON arrays, receipt verification and ordinary request/result unions remain in force. A `seq` is always the next per-stream frame sequence, and an `offset` is always the end byte offset of that contiguous prefix.

```ts
interface SourceCursor { seq: number; offset: number }
interface UnavailableSourcePrefix extends SourceCursor {
  reason: 'source-prefix-unavailable';
}
interface SourceStreamObservation {
  advanced: SourceCursor;
  produced: number;
  retainedBytes: number;
  bufferedBytes: number;
  unavailablePrefix: UnavailableSourcePrefix | null;
}
interface PendingSourceAck {
  operationId: Id;
  stream: Stream;
  through: SourceCursor;
  state: 'pending' | 'unknown';
}
interface SourceObservation {
  version: 1;
  scopeId: Id;
  channelId: Id;
  attachmentOperationId: Id;
  sourceRevision: number;
  streams: Record<Stream, SourceStreamObservation>;
  pendingAcks: PendingSourceAck[];
}
interface AttachedSourcePayload {
  privateReader: boolean;
  observationDeadline: number;
  source: SourceObservation;
}
interface SourceGuard { observation: Receipt }
```

1. The closed payload of a successful `driver.attach` receipt becomes `AttachedSourcePayload`. Its `source.attachmentOperationId` equals that receipt's `operationId`. Each exact channel has at most one current attachment across both `privateReader` values; acquisition installs none. Each newly applied attach atomically replaces that channel's prior current attachment with the returned exact receipt. Superseded receipts remain historical evidence. The receipt records reader installation, not output acceptance, consumption, ACK or cleanup success.
2. Add `driver.observeSource({jobId, reader: Receipt, operationId, fence}) -> Promise<Primitive<Receipt>>`. The receipt has `effect='driver.observeSource'`, `resourceId=jobId`, and the same closed `AttachedSourcePayload`. Its `source.attachmentOperationId` equals the exact supplied attachment receipt's operation ID. This method requires that exact reader to remain attached, under the current authorized attachment identity. It installs no reader and has no output/control effect. Repeating an observation is safe, but reuse of its operation ID is an exact receipt replay; changed arguments reject `input`.
3. Add optional `sourceGuards: SourceGuard[]` to `store.commit`. Each guard compares one exact channel's current source revision and active attachment with an authenticated attachment/source-observation receipt, at the same atomic boundary as the ordinary CAS. Duplicate channel guards reject `input`. Omission does not cause the broker to infer a lifecycle rule or add a guard. First adoption of a nonzero source prefix must be supported by this comparison; candidate choices that never require that adoption may use their equivalent ordinary continuation.
4. Add `sourceRevision:number` to `ChannelView`. Its existing `revision` remains the channel snapshot revision. The new field identifies the source state containing that frame/window; it is not a consumer or ACK receipt. `driver.readChannel` retains its existing snapshot behavior. Neither attachment nor `observeSource` calls it, dequeues a frame, drains a pipe, or triggers intake on the candidate's behalf.

`SourceObservation` and its listed subobjects are closed, as part of the effect-discriminated receipt payload. The valid receipt effect, scope, job (`resourceId`), channel (from the exact acquisition), reader operation, owner/epoch, `appliedAt` and observation deadline must agree. For `observeSource`, the outer receipt operation identifies the observation, while the nested operation identifies the installed reader. These identities are deliberately different.

`observationDeadline` is the fence deadline used by that attachment/observation operation. `0 <= appliedAt < observationDeadline`, and a new bootstrap publication must occur before both its own unchanged operation deadline and the observation deadline. The current grant must also cover the published 100-ms settlement reserve. Authority, expiry and lease validation remain necessary after the wait. An older receipt is historical evidence; it does not extend an earlier deadline or authorize an old owner to publish now.

`driver.receipt(operationId)` returns the byte-identical attachment or observation receipt when its response was lost and the receipt is available. `unknown` remains unknown; `not-applied` positively proves nonapplication. Receipt lookup is effect-free and does not obtain a newer source snapshot. A later explicit reconciliation can recover a known attachment and obtain a fresh observation under a new request's deadline. It cannot change the old request's timeout result. Do not repeat an unknown attachment to obtain a snapshot.

The source revision is monotonic for the exact channel. It changes when any observed source cursor, prefix descriptor, produced/retained/buffered byte count or pending-source-ACK fact changes. It is independent from the candidate's checkpoint/evidence revision. The primitive compares the exact current value, not `>=`. A valid guard with a changed source revision returns `not-applied/busy`, without writes/audits. Changed attachment/channel identity returns `not-applied/identity`, including a superseded attachment even if its source revision is unchanged; changed scope authority returns the existing stale outcome; an expired observation returns `not-applied/deadline`. Invalid proof shape/authentication returns `not-applied/integrity`. These raw failures never substitute for the candidate's semantic validation.

### Current attachment and exact replay

`driver.detach` and each new `driver.observeSource` operation require the exact current attachment receipt. A superseded receipt refuses `not-applied/identity` and cannot detach or observe its successor. Exact replay of a prior attach operation returns its original receipt without reinstalling it; changed arguments with that operation ID refuse `input`. Exact observation replay likewise remains historical. Receipt lookup and replay do not acquire a fresh source snapshot. Ordinary authority, deadline and applied-but-response-lost/unknown rules still apply: a failed response alone does not establish whether an attach replaced the current reader.

The following raw-port sequence uses one exact acquired channel, unchanged valid authority/deadlines, and no source-state change. `A1` and `A2` are distinct attach operation IDs; `R1` and `R2` are their exact returned receipts. Observe/detach/guard rows use fresh operation IDs.

| Raw call | Outcome | Current attachment afterward |
| --- | --- | --- |
| `driver.attach` with `A1`, `privateReader:false` | `applied`, receipt `R1` | `R1` |
| `driver.attach` with `A2`, `privateReader:true` | `applied`, receipt `R2`; atomically supersedes `R1` | `R2` |
| `driver.observeSource` or `driver.detach` with reader `R1` | `not-applied/identity` | `R2` |
| `store.commit` guarded by `R1` or an observation of `R1` | `not-applied/identity`, even at the same source revision | `R2` |
| Exact original `driver.attach` call with `A1` | `applied`, original historical `R1`; no new attach effect | `R2` |
| Reuse `A1` with a changed `privateReader` value | `not-applied/input` | `R2` |
| `driver.observeSource` with reader `R2` | `applied`, observation of `R2` | `R2` |
| `driver.detach` with reader `R2` | `applied`, detach receipt identifying `R2` | None |

The current reader's settlement is the modeled channel obligation; superseded receipts do not create extra current reader obligations. Existing outstanding-call and historical-receipt reconciliation requirements remain applicable. Subscriptions/listeners are separate from this reader slot. These rules prescribe observable primitive behavior, not candidate storage or cleanup layout.

### Provided guarantees and candidate decisions

The broker owns faithful snapshots of its raw source facts, isolation of returned JSON values, receipt authenticity/recovery, exact primitive fencing, and atomic comparison of source revisions. The snapshot operation itself causes zero new output reads, client calls, private-retention calls, ACK publications/retirements, source ACK effects or output events. The active attachment is a prerequisite even for an all-zero snapshot. Qualification must verify these adapter guarantees without awarding them as candidate work.

The candidate owns proving a checkpoint never existed, distinguishing missing prior state, validating source semantics and identity, reconciling its existing accepted/client/ACK history, choosing a current observation, requesting the required raw comparison, selecting permitted evidence, preserving provenance, and deciding every cleanup fact. The adapter does not choose a continuation, create a checkpoint, fill evidence, infer absence of candidate consumer intents or calculate a released verdict. `verify` authenticates bytes, not admissibility. A `sourceGuards` success checks raw identity/revision only; it does not approve counters or loss.

**Ordinary zero-origin path:** every attachment includes the new source fields in its existing response, but an ordinary zero-origin job needs no additional mandatory per-job RPC, no positive-prefix audit, no sourceProof publication and no source guard. Exported v3 totals simply have `sourcePrefix:0` and `sourceProof:null`. A still-valid attachment response can also supply the nonzero proof directly; `observeSource` is needed only when a fresh observation is necessary, such as after initialization, revision change, expiry or recovery of an older attachment. Ordinary per-job RPC requirements therefore remain unchanged; final qualification must still demonstrate the 1,100-job case within 100,000 broker calls. No candidate caching/optimization is prescribed and no limit is raised. Existing ordinary output, deadline and authority obligations remain unchanged.

## 3. Source positions, evidence and capsule rules

### What the source cursor means

`advanced` describes bytes already passed by this transport source, including its initial unavailable prefix and any later exact candidate ACK retirements. It is not an external client position. `unavailablePrefix` describes only the broker's one supplied initialization prefix: range `[0,offset)`, ending at the next sequence `seq`. It cannot grow in response to later candidate output errors or ACKs. Once the supplied workload initialization has occurred, that descriptor is immutable for the exact channel.

For each stream in a coherent observation:

- All numbers are nonnegative safe integers within the existing joint frame/byte limits; `seq=0` iff `offset=0`; for a nonempty prefix, `seq <= offset <= 4096*seq`.
- `produced = advanced.offset + retainedBytes + bufferedBytes`. Per-stream produced values match exact process pipe production at the same raw source state. The sum of retained counts is the declared live window count; the sum of buffered counts respects the modeled pipe capacity. The fixture's unavailable prefix frames count toward the existing frame/workload/case bounds.
- A null `unavailablePrefix` means no initial unavailable bytes. A nonnull prefix is positive, begins at zero, has only the named loss reason, and does not exceed `advanced` in sequence or offset. For an initial bootstrap with no candidate history, `advanced` must equal that prefix, or be zero/zero when the descriptor is null.
- Pending source ACK identities are unique, exact, channel-bound and per-stream. Each `through` is coherent with that stream's advanced prefix. The array enumerates all such outstanding source operations at this revision. Absence of them proves nothing about candidate client-consumption intents.
- The first later frame of a stream begins exactly at the accepted source baseline's `seq/offset`; later frames remain contiguous under the ordinary frame rules. stdout and stderr never borrow one another's sequence, offset or loss.

A retained window may be empty while either advanced cursor is nonzero. A source-only observation of that condition is sufficient to learn those positions; it is not permission to manufacture frames or call a consumer/ACK port for the prefix. Later frames still require normal actual-byte validation, durable evidence, legitimate client or private disposition, and exact ACK retirement.

### Evidence version 3

Change `Loss` to include exactly one new member: **`source-prefix-unavailable`**. It is legal only for the exact initial range authenticated by the adopted source proof, and only when no conflicting accepted/client/ACK history exists. Neither `legacy-gap` nor a storage/privacy loss category is an alternative for this prefix. A missing descriptor or mismatched range is a blocker, never discretionary diagnostic loss.

The current Evidence fields remain, with these exact changes:

```ts
interface StreamTotalsV3 {
  produced: number;
  accepted: number;
  consumed: number;
  acked: number;
  sourcePrefix: number;
}
// EvidenceV3 retains the other Evidence fields:
// version: 3;
// totals: Record<Stream, StreamTotalsV3>;
// sourceProof: Receipt | null;
```

`sourceProof` is the exact adopted attachment/observation receipt. If either `sourcePrefix` is positive it must be present, valid and have an empty `pendingAcks` array at its adopted revision. Per-stream `sourcePrefix` equals that receipt's unavailable-prefix offset, or zero for its null descriptor. For zero-prefix ordinary evidence, `sourceProof=null` is permitted. Retain a historical source proof under its original owner/epoch/time; later authority does not rewrite it. A source proof preserved with a committed prefix establishes its provenance, not perpetual freshness for a new decision.

Let `B=sourcePrefix`, `P=produced`, `A=accepted`, `C=consumed`, and `K=acked`, per stream. Evidence spans cover exactly `[0,A)`; all existing digest, loss-span, metadata and retained-root rules apply. The unavailable initial range is one loss span `[0,B)` when `B>0`, with empty bytes from `readEvidence`. Remaining spans preserve actual suffix positions. There is no zero-length prefix span.

`A` includes the durably accounted prefix plus accepted suffix bytes. `C` and `K` are byte counts of the suffix's actual authenticated consumption dispositions and completed ACK retirements; neither includes `B`. Existing authorized private-retention receipts remain distinct from client receipts and may settle suffix output as currently required. The acceptance definition must explicitly describe that existing private disposition, rather than implying every `consumed` total is a client callback.

The exact invariants become:

- Before finality: `0 <= K <= C`, and `B + C <= A <= P`.
- At finality: `A=P`, `B+C=P`, and `B+K=P`.
- `B` cannot replace or erase any prior accepted, consumed or ACKed suffix history. Once a positive source prefix is adopted, its amount and proof are immutable; counters remain monotonic. A pristine zero checkpoint created before source initialization may first adopt the prefix only while its accepted bytes, consumption/ACK history and related pending intents are all empty.

Example: stdout source cursor `{seq:2,offset:5}`, stderr `{seq:1,offset:2}`, both windows empty. At prefix adoption, stdout totals are `{produced:5,accepted:5,consumed:0,acked:0,sourcePrefix:5}` and stderr totals are `{produced:2,accepted:2,consumed:0,acked:0,sourcePrefix:2}`. After later stdout bytes `[31,32,33]` at seq 2/offset 5 and stderr `[41]` at seq 1/offset 2 are privately settled, final totals are respectively `{produced:8,accepted:8,consumed:3,acked:3,sourcePrefix:5}` and `{produced:3,accepted:3,consumed:1,acked:1,sourcePrefix:2}`. No receipt claims client consumption of the five or two prefix bytes.

The existing `facts.output` rule must use these equations, the positive terminal barrier and empty final retained/buffered state. Equality of the old four totals is retained for `B=0`, not imposed by falsely filling counters for `B>0`. Every other resource prerequisite remains applicable; source observation alone cannot establish final output, evidence, detach or release.

### Capsule version 3 and public audit

The current Capsule top-level fields remain closed, with `format:3` and EvidenceV3 in `evidence` and `checkpoint.finalManifest`. Keep `checkpointEverCreated`. A present checkpoint requires matching present evidence; an ever-created checkpoint that is now absent is still `missing-checkpoint`. A never-created setup may retain null checkpoint/evidence and revision zero; it has absent historical counters, not invented zero history.

`checkpoint.accepted`, `consumed` and `retirement` continue to contain only the ordinary outstanding suffix frames/receipts and at most the last per-stream retirement receipts. For a source baseline `{seq:q,offset:B}` with no later ACK retirement, `retiredThrough` may be `{seq:q,offset:B,receipt:null}` only when the exact EvidenceV3 source proof certifies that baseline. This means the transport continuation starts there; it is explicitly not an ACK claim. With a retired suffix, `retiredThrough` has the exact last suffix retirement receipt and its next sequence/end offset. Without a source baseline, the existing null-receipt zero/zero rule remains unchanged. Do not synthesize retired prefix FrameKeys, client receipts, ACK receipts or artifact identities.

Add the audit type `source-bootstrap`, requiring `jobId`, `receipt` (the adopted source proof) and `data.evidenceRevision`. Its atomic supporting state includes the exact EvidenceV3 prefix accounting and continuation identity. A positive prefix's first adoption emits it once; retries/restart reuse it. An implementation that already created a pristine checkpoint need not emit another `checkpoint-created`. Do not emit ordinary `accepted`, `consume-intent`, `consumed`, `ack-intent` or `acked` events for fictitious prefix frames. Ordinary suffix events retain their existing prerequisites. Zero-prefix bootstrap is covered by the existing checkpoint/attachment evidence and does not require a positive-prefix audit.

Manifest hashing includes the new fields. Capsule seal authentication does not validate these semantic rules. Restore rechecks source identity, counters, full range coverage, source proof, suffix receipt provenance, immutable final evidence and the existing head/authority rules. Import never deletes existing delivery history or turns an unknown client effect into a source gap.

## 4. Exact progress and refusal outcomes

Mandatory progress requires all of: an exact owned setup/channel; current authority and adequate remaining deadline/lease after attachment; a provably never-created checkpoint or a lawful existing continuation; exact authenticated attachment/source proof; coherent safe positions, production and window; no unresolved source ACKs; no conflicting or ambiguous candidate consumption/ACK history; an exact permitted disposition for the full earlier prefix; and a matching source revision at its first publication. Both retained and buffered windows are empty at source initialization and in the mandatory basic empty-window recipe, while either stream cursor may be nonzero. First adoption also permits a coherent healthy retained or buffered suffix: advanced must equal the exact immutable authenticated unavailable-prefix endpoint (or zero for a null descriptor), and all the same history, authority, deadline and source-revision prerequisites apply. Only the authenticated initial prefix is loss; suffix frames must be validated, durably accounted and settled normally. This includes suffix arrival before recovery or during a held first publication, and does not require adoption before an interruption.

A previously present but now missing checkpoint never becomes the positive case. A current, present pristine checkpoint may adopt the source initialization prefix because no earlier protocol history is being replaced. A candidate that has already incorporated it before the interruption must preserve that result. Qualification accepts both prevention of the intermediate state and recovery from it, using the same external source input and interruption boundary. It cannot require delayed checkpoint creation, a private key or a reference-specific stage.

Published refusal alternatives, for the affected job:

| Condition | Permitted public disposition |
| --- | --- |
| Current authority changed | `stale` with observed current owner/epoch, or `blocked/authority` if no current identity is available; zero old-owner publication/effect. |
| Original request reaches `now >= deadline` | `blocked/deadline`; if an issued operation is still unresolved, `pending` or `unknown` with its exact ID and a `deadline` blocker is also permitted. The original request cannot later turn successful. |
| Insufficient lease reserve | `blocked/lease` before dependent effect; deadline/authority may take precedence when also invalid as already published. |
| Exact active attachment absent, rejected or foreign | `blocked/identity`; unknown attachment outcome instead retains `unknown`/`unknown-effect` with the attachment operation ID. No fresh duplicate attach for an unknown result. |
| Proof absent although its outcome is known | `blocked/missing-receipt`; malformed/authentication-invalid/semantically incoherent proof uses `blocked/integrity` (an absent/overlapping prefix range may use `gap`). |
| Source revision changed | Retry from a fresh coherent source observation within the same remaining deadline, or `blocked/busy`; while waiting, `pending` with the exact outstanding observation ID is allowed. The old snapshot cannot certify the new state. |
| Source ACK remains pending | `pending` with that source operation ID and `dependency`, or `blocked/dependency` retaining that exact operation ID in its blocker/obligation. |
| Source ACK outcome unknown | `unknown` with its exact source operation ID and `unknown-effect`. The source snapshot and operation remain inspectable. |
| Client consumption intent unknown | `unknown` with the delivery ID and `consumer-unknown`, or `blocked/consumer-unknown` retaining that exact ID. Source observation/private retention cannot resolve it. |
| Previously created checkpoint missing | `blocked/missing-checkpoint`; no source-gap substitution. |
| Unexplained advanced prefix, missing disposition or retained-frame gap | `blocked/gap` or `blocked/integrity`; no invented consumed/ACKed positions. |
| Explicit unsupported public version | `blocked/unsupported`; no partial import. |

For aggregate `recover`, an `ok` result is permissible as a completed traversal report only if its BatchView truthfully contains the unresolved job and the exact above blockers/obligations. It does not mean that job is released. `closeBatch`/`close` cannot report successful closure while such an obligation remains. This distinction must be frozen in the public response text and tests, rather than letting an assertion on the outer tag alone decide safety.

If a held source operation settles before the unchanged deadline and all other prerequisites become available, retry/reconciliation must progress. When a proof fault is permanent or exact receipts remain unavailable, safe persistent refusal is required; a hidden schedule cannot demand progress by a deadline while withholding those prerequisites.

## 5. Lawful public source fixture and observation faults

### One new source-construction input

Publish `control('sourcePrelude', {streams:{stdout:number[][],stderr:number[][]}, pendingAcks?:{stream:Stream,state:'pending'|'unknown'}[]})`, returning `{sourceId:Id,workloadId:Id}`. `sourceId` is a fixture handle, not a capability delivered to the candidate. Inputs obey existing byte/frame/case bounds; each inner frame is 1–4096 bytes. Empty arrays give zero positions. A pending ACK seed targets the complete supplied prefix of its named stream and requires that prefix to be nonempty; the broker allocates its exact operation ID. No candidate documents or receipts are supplied as fixture input.

On the first successful `driver.start` for that exact supplied workload ID, the broker records those real finite-workload output bytes, advances its source to the end of each supplied frame list, and makes that prefix unavailable. It sets produced counts, both initially empty windows, the immutable prefix descriptors, source revision and any exact source ACK obligations before publishing the start result. It issues no client/private-retention/ACK effect and does not write candidate state. The modeled workload has actually started; no nonzero workload output is invented for a never-started process. An ordinary `driver.start.after` fault can lose the response or the guest can be interrupted there. This is the named **`source-initialization`** boundary, occurring at most once per supplied workload. It cannot discard later ordinary output or be invoked by candidate code.

The seed is installed by workload identity, not by guessing when the candidate creates a checkpoint. A reader attached before start must obtain a post-initialization observation; its earlier zero snapshot is stale after the source revision changes. A checkpoint initialized early remains eligible only under the pristine-state rule above. No fixture deletes that checkpoint to manufacture the never-created case.

Add effect-free `control('sourceState',{sourceId})`, returning `{workloadId,jobId:Id|null,channelId:Id|null,sourceRevision:number|null,streams:Record<Stream,SourceStreamObservation>|null,pendingAcks:PendingSourceAck[],counts:{sourceInitializations:number,outputReads:number,clientConsumes:number,privateRetains:number,ackPublications:number,ackRetirements:number,sourceAckEffects:number,attachments:number}}`. Counts are for the associated exact job and expose actual raw events, not candidate audit claims. `outputReads` counts `driver.readChannel` calls, including an empty result. Source snapshots are not output reads. Attachment and observation perform zero driver.readChannel calls. Any adapter read made to construct the observation violates the trusted guarantee and invalidates the harness. Candidate explicit reads are attributed separately in the trace. Observation-alone cases compare counts during that observation boundary; they do not forbid a later candidate-chosen poll/barrier/intake during actual cleanup.

Add `control('sourceAckOutcome',{sourceId,operationId,outcome:'applied'})` to complete an exact outstanding source-owned operation and increase the source revision. This is a controller event, never a candidate ACK API. `driver.receipt` can then expose an authenticated `effect='source.ack'`, `resourceId=jobId`, payload `{channelId,stream,through}` with the original source operation identity/owner/epoch. It certifies only that source operation; it is never a client or `driver.retireAck` receipt. Until that event, pending/unknown remains as supplied. A new source observation, not receipt lookup alone, must establish that no source ACKs remain.

### Named fault boundaries

Keep all current R2 fault restrictions. Add only these disclosed source-specific boundaries:

- **`source-observation.before/after`**: the source-snapshot part of `driver.attach` or `driver.observeSource`, selectable by exact job or fixture source handle after source initialization. Existing hold/release, rejection and legal before/after Primitive outcomes apply. A held attachment cannot produce an authenticated completed observation before its actual attachment effect settles. An after-response fault may set that operation's receipt visibility to `available` or `unknown`; this determines the ordinary nonfaultable `driver.receipt` answer and does not inject a fault into the query itself.
- **`source-observation.claim`**: a narrowly declared untrusted observation-claim boundary. It may return a missing proof; an invalid-token proof; a valid foreign job/channel/reader proof; a valid older observation; or a signed claim with a listed, externally checkable schema/arithmetic/provenance inconsistency. Examples are a negative/fractional/unsafe position, future epoch/time, same-epoch foreign owner, cross-stream prefix, impossible sequence/offset, or mismatched unavailable range/production/window. Receipt authentication proves claim bytes, not semantic consistency. The fault cannot fabricate an internally consistent authenticated alternative physical history that the candidate has no means to distinguish.
- **`store.commit.before` with source guard**: while that call is held, controller output or a source ACK completion may change source revision; the raw guard must refuse the obsolete comparison. The broker cannot quietly update the candidate's expected revision.
- **Existing public boundaries**: ordinary consumer/ACK holds or unknown delivery results; output/tail events; authority takeover and clock advance; lost effect response; actual guest destruction/reopen; and capsule faults only through public export/seal/restore.

The public harness must document callable hold/release/wait-boundary/clock/reopen controls used in its readable recipes, including exact method selectors and IDs. These are fixture controllers, never candidate Ports. A schedule that depends on a candidate-private checkpoint write or on an unadvertised malformed port return is unlawful. Mutation of a returned JS object cannot change authoritative source facts; any bridge aliasing is `invalid_harness`.


## Closed fixture and fault grammar

The following types are executable controller inputs, not candidate Ports. Objects are closed at every named level; absent optional fields use the listed defaults. Unknown fields/discriminators or an illegal boundary/action pair are harness errors. JSON rejection values use {tag:'undefined'} only to request an actual undefined rejection; other JSON values are passed unchanged. Fault occurrence defaults to 1, is a positive safe integer, and counts matching calls. A source selector matches only after that source's initialization; a job selector matches its exact job. Neither selector is required, and they cannot be combined. No function/predicate/private document selector is public.

```ts
type SourcePreludeInput = {streams:Record<Stream,number[][]>;pendingAcks?:{stream:Stream;state:'pending'|'unknown'}[]};
type SourcePreludeResult = {sourceId:Id;workloadId:Id};
type SourceStateInput = {sourceId:Id};
type SourceStateResult = {workloadId:Id;jobId:Id|null;channelId:Id|null;sourceRevision:number|null;streams:Record<Stream,SourceStreamObservation>|null;pendingAcks:PendingSourceAck[];counts:{sourceInitializations:number;outputReads:number;clientConsumes:number;privateRetains:number;ackPublications:number;ackRetirements:number;sourceAckEffects:number;attachments:number}};
type SourceAckBeginInput = {sourceId:Id;stream:Stream;state:'pending'|'unknown'};
type SourceAckBeginResult = {operationId:Id};
type SourceAckOutcomeInput = {sourceId:Id;operationId:Id;outcome:'applied'};
type SourceAckOutcomeResult = {receipt:Receipt};
type Selector = {jobId?:Id;sourceId?:never}|{sourceId:Id;jobId?:never};
type FaultablePrimitive = 'store.commit'|'artifact.create'|'artifact.write'|'artifact.remove'|'driver.acquire'|'driver.start'|'driver.attach'|'driver.observeSource'|'driver.barrier'|'driver.privateRetain'|'driver.publishAck'|'driver.retireAck'|'driver.publishRelease'|'driver.replaceRelease'|'driver.control'|'driver.detach'|'driver.release'|'claims.cas';
type FaultableRaw = 'store.read'|'store.scan'|'artifact.read'|'artifact.inspect'|'driver.inspect'|'driver.inspectBinding'|'claims.read'|'consumer.query'|'consumer.consume';
type GenericFault = Selector & {occurrence?:number} & (
 | {method:`${FaultablePrimitive|FaultableRaw}.${'before'|'after'}`;action:'hold'}
 | {method:`${FaultablePrimitive|FaultableRaw}.${'before'|'after'}`;action:'throw';value:Json}
 | {method:`${FaultablePrimitive}.before`;action:'busy';delay:number}
 | {method:`${FaultablePrimitive}.before`;action:'not-applied';code:Code}
 | {method:`${FaultablePrimitive}.after`;action:'unknown';receiptVisibility?:'available'|'unknown'});
type SourceBoundary = 'source-observation.before'|'source-observation.after';
type ObservationMethod = 'driver.attach'|'driver.observeSource';
type Claim = 'missing'|'invalid-token'|'foreign-job'|'foreign-channel'|'foreign-reader'|'foreign-scope'|'foreign-owner'|'future-epoch'|'negative'|'fractional'|'unsafe'|'impossible'|'false-zero'|'cross-stream'|'future-time'|'at-proof-deadline'|'expired'|'stale'|'missing-prefix'|'wrong-range'|'legacy-reason'|'production'|'window';
type SourceFault = Selector & {method:SourceBoundary;observationMethod?:ObservationMethod;occurrence?:number} & (
 | {action:'hold'} | {action:'throw';value:Json}
 | {action:'busy';delay:number} | {action:'not-applied';code:Code}
 | {action:'unknown';receiptVisibility:'available'|'unknown'});
type SourceClaimFault = Selector & {method:'source-observation.claim';observationMethod?:ObservationMethod;occurrence?:number;action:'claim';claim:Claim};
type HoldInput = Selector & {method:SourceBoundary|'driver.attach.before'|'driver.attach.after'|'driver.observeSource.before'|'driver.observeSource.after'|'driver.start.after'|'store.commit.before'|'store.commit.after';observationMethod?:ObservationMethod;sourceGuardOnly?:boolean;occurrence?:number};
type HoldResult = {faultId:Id};
type WaitBoundaryInput = {faultId:Id};
type WaitBoundaryResult = {heldId:Id;method:string;jobId:Id|null;operationId:Id|null};
type ReleaseInput = {heldId:Id}; // returns null; settles normally, with fencing rechecked
type BeginInput = {request:Request}; // returns {callId:Id}; request defaults match h.run
type JoinInput = {callId:Id}; // returns the exact Service.run Result for that call
type AdvanceInput = {now:number}; // returns null; monotonic virtual clock
// control('sourcePrelude', SourcePreludeInput): SourcePreludeResult
// control('sourceState', SourceStateInput): SourceStateResult
// control('sourceAckBegin', SourceAckBeginInput): SourceAckBeginResult
// control('sourceAckOutcome', SourceAckOutcomeInput): SourceAckOutcomeResult
// control('fault', GenericFault|SourceFault|SourceClaimFault): null
// control('hold', HoldInput): HoldResult
// control('waitBoundary', WaitBoundaryInput): WaitBoundaryResult
// control('release', ReleaseInput): null
// control('begin', BeginInput): {callId:Id}
// control('join', JoinInput): Result
// control('advance', AdvanceInput): null
// control('reopen', {}): null; destroys guest; committed store/physical source remain
```

The existing fixture controls remain: id/now/scope/consumer/events take {}; output and tail take {jobId,stream,bytes}; takeover/reopen take {}; seal takes {capsule}; root takes {jobId}; dead takes {binding}; listen takes {jobId,replace?:boolean}. Output returns the first retained FrameKey (null if none); tail returns null. Exact public Requests may omit requestId/deadline in h.run or begin; the fixture supplies a fresh ID and now+1000. This convenience does not change a supplied deadline or ID. h.expect is an assertion only. h.run returns the candidate result, not a fixture verdict.

For every generic or source unknown-after fault, receiptVisibility='available' returns unknown to the candidate while preserving the exact completed receipt for driver.receipt; 'unknown' keeps receipt lookup unknown. The generic default is 'available'. The spelling hideReceipt is not part of the public controller grammar. Fault registration returns null. Faults select the exact named RPC boundary, optionally exact job/source and occurrence, with the same selector rules above. Nonfaultable R2 methods have no GenericFault variant. delay is a nonnegative safe integer; code is a member of Code; source-specific observationMethod selects only the corresponding attach/refresh observation. busy and not-applied are legal before only; unknown is legal after only. Source claim runs after a real attachment/observation raw snapshot and returns an applied result whose value is the disclosed claim (null for missing). The raw authoritative receipt remains stored. The claim boundary alone permits signed but incoherent bytes. Outside this active fault, any incoherent authenticated snapshot or returned-object alias mutation is invalid_harness. Source guard success authenticates and compares raw channel/reader/revision facts only; it never accepts source-prefix eligibility, counters, loss or cleanup.

Claim transformations are exact, use stdout unless named otherwise, and leave unmentioned fields unchanged. missing returns null; invalid-token replaces token by 64 zeroes; foreign-job/channel/reader/scope replace the corresponding resourceId/channelId/attachmentOperationId/scopeId with another fixture-issued ID; foreign-owner replaces ownerId with another fixture-issued ID at the same epoch; future-epoch adds one to epoch. negative sets advanced.offset=-1; fractional sets advanced.offset=0.5; unsafe sets advanced.offset=9007199254740992; impossible sets advanced.seq=advanced.offset+1; false-zero sets advanced to {seq:0,offset:0} while retaining the exact positive prefix/production. cross-stream swaps only the stdout/stderr unavailablePrefix descriptors; unequal supplied data makes the mismatch observable. future-time sets appliedAt=now+1; at-proof-deadline sets appliedAt=observationDeadline; expired sets observationDeadline=appliedAt (thus is detectably invalid). stale returns the previously cached real observation for the exact attachment, requiring one exists and raw source revision has since changed. missing-prefix sets unavailablePrefix=null; wrong-range increments unavailablePrefix.offset; legacy-reason changes its reason to legacy-gap; production increments produced; window increments retainedBytes. Except missing/invalid-token/stale, claims are signed with the receipt domain after this listed transformation; authentication is not semantic validation. Missing prerequisites for a transformation invalidate the fixture. No coherent alternative physical history may be invented.

Claim refusal categories are frozen in source-variants.json. Identity fields permit identity or integrity (scope/owner/epoch also authority/stale as applicable). Numeric/range/stream/production/window claims permit integrity or gap; missing proof permits missing-receipt; token permits integrity; invalid time permits integrity or deadline. A stale valid proof requires a fresh eligible observation or busy; missing/stale/unknown never earns lifecycle success. Once the one-shot fault is consumed, later explicit reconciliation with a real current proof may progress; a permanently unavailable attachment remains unknown. Recover may return ok only as a truthful traversal containing unresolved job obligations; closeBatch/close cannot close with those obligations.

sourcePrelude permits at most one pending ACK seed per stream, and requires a positive prefix for each seeded stream. sourceAckOutcome is idempotent for the exact completed ID; it does not change advanced or credit candidate ACK bytes. It removes that pending/unknown source fact and increments source revision once. Source initialization is one event per supplied workload ID; duplicate successful start remains a candidate lifecycle defect, never another prefix installation. Prefix frames consume the published frame/byte quotas. Source guard duplicate channels reject input; absent/null invalid proof rejects integrity. Exact repeated successful observation operationId replays original bytes; changed arguments reject input. A held observation rechecks its active exact reader, fence and source at settlement.

The concrete mandatory extension inventory is source-variants.json. Its outcomes are per-job alternatives subject to the aggregate rule above. All prior 69 families and 227 variants remain mandatory. Limits are unchanged; ordinary zero-origin jobs add no observation call, guard or positive-prefix audit. Format 2 is unsupported; format 1 compatibility remains mandatory and produces EvidenceV3 without source loss. This package is a complete assignment; producer qualification, independent implementation admission and AI Board integration are separate pending gates.


## Delayed source ACK issuance

control('sourceAckBegin',{sourceId,stream,state:'pending'|'unknown'}) returns {operationId}, a newly allocated fixture-domain identity for an external source operation covering exactly that stream's immutable unavailable prefix. Inputs and output are closed. It is legal only after source initialization, while that exact channel is still owned and unreleased, and only for a stream with a positive immutable initialization prefix. At most one source ACK may be issued per stream across sourcePrelude pendingAcks seeds and sourceAckBegin; completion does not reset this lifetime bound. Invalid fixture preconditions are harness errors. This control never writes candidate state or invents client delivery.

Issuance appends the exact PendingSourceAck and advances sourceRevision. It causes no output read, cursor advancement, prefix change, production/window change, client consumption, private retention, candidate ACK publication/retirement, or source ACK application. sourceAckOutcome(applied) later completes it once, removes the pending/unknown fact, advances sourceRevision and provides the existing source.ack receipt; repeated exact completion is idempotent. Candidate pending/unknown refusal and exact-ID retention remain unchanged. A source ACK receipt is still not a candidate consumption or retirement receipt.

B17/source-changed-ack holds a first-adoption source-guarded commit after an eligible empty-pending observation, issues then completes one delayed source ACK while held, and releases the commit. The old revision must fail the raw comparison even though pendingAcks is empty again. A fresh eligible observation permits normal progress. The public source-changed-ack recipe demonstrates this external event; it does not prescribe checkpoint timing or private representation.

The source-changed-ack recipe arms its sourceId/sourceGuardOnly hold before start. It drives public start and, when needed, stop while waiting, so an eager first adoption is equally supported. An obsolete comparison may return blocked/busy or pending with the exact outstanding observation ID; the recipe then uses a new public recovery request before asserting final release. No automatic retry inside one request is required.
