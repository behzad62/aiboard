/** Recoverable Job Service modeled-core-v2; ES2022, JSON RPC only. */
export type Id = string;
export type Json = null | boolean | number | string | Json[] | {[key: string]: Json};
export type Stream = 'stdout' | 'stderr';
export type Resource = 'isolation' | 'process' | 'channel' | 'workload';
export type Fact = 'quiescent' | 'output' | 'evidence' | 'channel' | 'process' | 'isolation';
export interface Grant {scopeId: Id; ownerId: Id; epoch: number; expiresAt: number; token: string; holder: Binding}
export interface Binding {id: Id; birth: Id; kind: 'workload' | 'witness' | 'agent'; token: string}
export interface Op {requestId: Id; deadline: number}
export interface Fence {grant: Grant; deadline: number}
export interface FrameKey {jobId: Id; channelId: Id; stream: Stream; seq: number; offset: number; length: number; digest: string; artifactId: Id}
export interface Frame {key: FrameKey; bytes: number[]}
export interface Receipt {id: Id; operationId: Id; effect: string; resourceId: Id; ownerId: Id; epoch: number; appliedAt: number; payload: Json; token: string}
export type Code = 'authority' | 'identity' | 'busy' | 'deadline' | 'lease' | 'unknown-effect' | 'consumer-unknown' | 'integrity' | 'gap' | 'missing-checkpoint' | 'missing-receipt' | 'capacity' | 'dependency' | 'backend' | 'input' | 'unsupported' | 'cleanup' | 'owned-path' | 'privacy';
export interface Blocker {code: Code; jobId?: Id; setupId?: Id; resource?: Resource; operationId?: Id}
export interface Failure {present: true; phase: string; value: Json | {tag:'undefined'}}
export type Result<T = Json> = {kind:'ok'; value:T} | {kind:'blocked'; blockers:Blocker[]; failures:Failure[]} | {kind:'stale'; ownerId:Id; epoch:number} | {kind:'pending' | 'unknown'; operationId:Id; blockers:Blocker[]};
export type Loss = 'payload-budget' | 'metadata-budget' | 'privacy' | 'diagnostic-io' | 'legacy-gap' | 'source-prefix-unavailable';
export interface Span {stream:Stream; start:number; end:number; kind:'bytes'|'loss'; digest?:string; artifactId?:Id; root?:Root; name?:string; reason?:Loss}
export interface Evidence {version:3; batchId:Id; jobId:Id; generation:Id; revision:number; final:boolean; spans:Span[]; totals:Record<Stream,{produced:number;accepted:number;consumed:number;acked:number;sourcePrefix:number}>; sourceProof:Receipt|null; manifestDigest:string}
export interface JobView {batchId:Id; jobId:Id; setupId:Id; ownerId:Id; epoch:number; state:'setup'|'running'|'stopping'|'recovering'|'blocked'|'released'; successorJobId?:Id; facts:Partial<Record<Fact,Receipt[]>>; obligations:{resource:string;attemptId:Id;state:'intent'|'issued'|'unknown'|'verified'}[]; blockers:Blocker[]; failures:Failure[]; evidence?:Evidence}
export interface BatchView {batchId:Id;state:'open'|'closing'|'closed';jobs:JobView[]}
export interface Root {id:Id;birth:Id;path:string;owner:Id;token:string;retained:boolean}
export interface Versioned {revision:number;value:Json|null}
export interface Mutation {key:string;expected:number;value:Json|null}
export interface Audit {type:'setup-intent'|'resource-intent'|'effect-result'|'source-bootstrap'|'checkpoint-created'|'accepted'|'consume-intent'|'consumed'|'ack-intent'|'acked'|'cleanup-fact'|'evidence-final'|'terminal-transfer'|'released'|'closed'|'handoff';jobId?:Id;batchId?:Id;operationId?:Id;frame?:FrameKey;receipt?:Receipt;fact?:Fact;manifest?:Evidence;data?:Json}
export interface Checkpoint {generation:Id;createdAt:number;authority:{ownerId:Id;epoch:number};accepted:FrameKey[];consumed:Receipt[];retirement:Receipt[];retiredThrough:Record<Stream,{seq:number;offset:number;receipt:Receipt|null}>;finalManifest?:Evidence}
export interface Capsule {format:3;scopeId:Id;batchId:Id;jobId:Id;setupId:Id;ownerId:Id;epoch:number;revision:number;checkpointEverCreated:boolean;checkpoint:Checkpoint|null;evidence:Evidence|null;bindings:{workload:Binding;witness:Binding}|null;receipts:Receipt[];extensions:Record<string,Json>;seal:string}
export interface LegacyEvidence {format:1;kind:'evidence';scopeId:Id;batchId:Id;jobId:Id;acceptedThrough:Record<Stream,number>;knownPrefix:Span[];retainedSuffix:Span[];seal:string}
export interface LegacyIdentity {format:1;kind:'identity';scopeId:Id;batchId:Id;jobId:Id;numericId:number;terminalReceipt?:Receipt;seal:string}
export type Request =
 | ({type:'createBatch'} & Op)
 | ({type:'start';batchId:Id;workloadId:Id} & Op)
 | ({type:'poll'|'stop';jobId:Id} & Op)
 | ({type:'consume';jobId:Id;frame:FrameKey;consumerId:Id} & Op)
 | ({type:'acknowledge';jobId:Id;frame:FrameKey;consumed:Receipt} & Op)
 | ({type:'recover'|'closeBatch';batchId:Id} & Op)
 | ({type:'close'|'reclaim'} & Op)
 | {type:'inspectJob'|'exportCapsule'|'readEvidence';jobId:Id}
 | {type:'inspectBatch';batchId:Id}
 | ({type:'restore';capsule:Capsule|LegacyEvidence|LegacyIdentity} & Op)
 | ({type:'handoff';setupId:Id;successorJobId:Id} & Op)
 | ({type:'replaceRelease';jobId:Id;expectedRequestId:Id;nextRequestId:Id|null} & Op)
 | ({type:'claim';name:string} & Op)
 | ({type:'ownScratch';jobId:Id;root:Root} & Op);
export interface Event {type:'output'|'terminal'|'error';frame?:Frame;job?:JobView;blockers?:Blocker[]}
export interface Subscription {id:Id;unsubscribe():void}
export interface Reclamation {removed:Id[];remaining:Id[];failure?:Failure}
export interface EvidenceRead {manifest:Evidence;pieces:{span:Span;bytes:number[]}[]}
export interface SuccessMap {createBatch:{batchId:Id};start:{jobId:Id;setupId:Id};poll:JobView;stop:JobView;inspectJob:JobView;inspectBatch:BatchView;recover:BatchView;closeBatch:BatchView;close:BatchView[];consume:Receipt;acknowledge:null;replaceRelease:Receipt;exportCapsule:Capsule;restore:JobView;handoff:JobView;readEvidence:EvidenceRead;claim:{holder:Binding;logicalOwner:Id;epoch:number};reclaim:Reclamation;ownScratch:Root}
export interface Service {run<R extends Request>(request:R):Promise<Result<SuccessMap[R['type']]>>;subscribe(jobId:Id,listener:(event:Event)=>void):Subscription}
export type Primitive<T> = {kind:'applied';value:T}|{kind:'busy';retryAt:number}|{kind:'stale'}|{kind:'not-applied';code:Code}|{kind:'unknown';operationId:Id};
export interface SourceCursor {seq:number;offset:number}
export interface UnavailableSourcePrefix extends SourceCursor {reason:'source-prefix-unavailable'}
export interface SourceStreamObservation {advanced:SourceCursor;produced:number;retainedBytes:number;bufferedBytes:number;unavailablePrefix:UnavailableSourcePrefix|null}
export interface PendingSourceAck {operationId:Id;stream:Stream;through:SourceCursor;state:'pending'|'unknown'}
export interface SourceObservation {version:1;scopeId:Id;channelId:Id;attachmentOperationId:Id;sourceRevision:number;streams:Record<Stream,SourceStreamObservation>;pendingAcks:PendingSourceAck[]}
export interface AttachedSourcePayload {privateReader:boolean;observationDeadline:number;source:SourceObservation}
export interface SourceGuard {observation:Receipt}
export interface SourceAckPayload {channelId:Id;stream:Stream;through:SourceCursor}
export interface ProcessFacts {revision:number;workload:Binding;witness:Binding;workloadState:'not-started'|'running'|'exited'|'unknown';witnessState:'alive'|'exited'|'unknown';exit?:{code:number;natural:boolean};consumedRelease?:Receipt;pipes:Record<Stream,{closed:boolean;bufferedBytes:number;produced:number}>}
export interface ChannelView {revision:number;sourceRevision:number;frame:Frame|null;retainedBytes:number;retirement:Receipt|null;terminalProduction:boolean;pipesDrained:boolean}
/** All calls are asynchronous. Host rejection values can be falsy. See RPC schema table. */
export interface Ports {
 call(method:'now'|'newId',args?:{}):Promise<number|string>;
 call(method:'digest',args:{bytes:number[]}):Promise<string>;
 call(method:'verify',args:{receipt:Receipt}):Promise<boolean>;
 call(method:'authority',args:{grant:Grant}):Promise<{current:Grant;valid:boolean;now:number}>;
 call(method:'waitUntil',args:{at:number}):Promise<void>;
 call(method:'store.read',args:{key:string}):Promise<Versioned>;
 call(method:'store.scan',args:{prefix:string;cursor?:string}):Promise<{revision:number;rows:{key:string;revision:number;value:Json}[];next?:string}>;
 call(method:'store.commit',args:{operationId:Id;fence:Fence;writes:Mutation[];audit:Audit[];sourceGuards?:SourceGuard[]}):Promise<Primitive<Receipt>>;
 call(method:'artifact.create',args:{path:string;owner:Id;retained:boolean;operationId:Id;fence:Fence}):Promise<Primitive<Root>>;
 call(method:'artifact.write',args:{root:Root;name:string;bytes:number[];operationId:Id;fence:Fence}):Promise<Primitive<Receipt>>;
 call(method:'artifact.read',args:{root:Root;name:string}):Promise<number[]|'missing'>;
 call(method:'artifact.inspect',args:{root:Root}):Promise<'absent'|{birth:Id;owner:Id;aliases:boolean;foreignEntries:boolean}>;
 call(method:'artifact.remove',args:{root:Root;operationId:Id;fence:Fence}):Promise<Primitive<Receipt>>;
 call(method:'driver.acquire',args:{resource:Resource;jobId:Id;operationId:Id;fence:Fence}):Promise<Primitive<Receipt>>;
 call(method:'driver.start',args:{jobId:Id;workloadId:Id;workload:Binding;witness:Binding;operationId:Id;fence:Fence}):Promise<Primitive<Receipt>>;
 call(method:'driver.inspect',args:{jobId:Id;epoch:number}):Promise<ProcessFacts>;
 call(method:'driver.inspectBinding',args:{binding:Binding}):Promise<'alive'|'dead'|'unknown'|'foreign'>;
 call(method:'driver.readChannel',args:{jobId:Id}):Promise<ChannelView>;
 call(method:'driver.receipt',args:{operationId:Id}):Promise<Receipt|'not-applied'|'unknown'>;
 // A newly applied attach replaces the channel's one current reader across both privateReader values; exact replay returns history without reinstalling it.
 call(method:'driver.attach'|'driver.barrier',args:{jobId:Id;operationId:Id;fence:Fence;privateReader?:boolean}):Promise<Primitive<Receipt>>;
 call(method:'driver.observeSource',args:{jobId:Id;reader:Receipt;operationId:Id;fence:Fence}):Promise<Primitive<Receipt>>;
 call(method:'driver.privateRetain',args:{jobId:Id;frame:FrameKey;operationId:Id;fence:Fence}):Promise<Primitive<Receipt>>;
 call(method:'driver.publishAck',args:{jobId:Id;frame:FrameKey;consumed:Receipt;operationId:Id;fence:Fence}):Promise<Primitive<Receipt>>;
 call(method:'driver.retireAck',args:{jobId:Id;ack:Receipt;operationId:Id;fence:Fence}):Promise<Primitive<Receipt>>;
 call(method:'driver.publishRelease',args:{jobId:Id;witness:Binding;requestId:Id;operationId:Id;fence:Fence}):Promise<Primitive<Receipt>>;
 call(method:'driver.replaceRelease',args:{jobId:Id;expectedRequestId:Id;nextRequestId:Id|null;operationId:Id;fence:Fence}):Promise<Primitive<Receipt>>;
 call(method:'driver.control',args:{jobId:Id;target:Binding;signal:'graceful'|'force';operationId:Id;fence:Fence}):Promise<Primitive<Receipt>>;
 call(method:'driver.detach',args:{jobId:Id;reader:Receipt;operationId:Id;fence:Fence}):Promise<Primitive<Receipt>>;
 call(method:'driver.release',args:{jobId:Id;resource:'process'|'isolation';acquired:Receipt;operationId:Id;fence:Fence}):Promise<Primitive<Receipt>>;
 call(method:'consumer.consume',args:{consumerId:Id;frame:Frame;deliveryId:Id}):Promise<Receipt>;
 call(method:'consumer.query',args:{consumerId:Id;deliveryId:Id}):Promise<Receipt|'not-applied'|'unknown'>;
 call(method:'capsule.seal',args:{capsule:Json}):Promise<string>;
 call(method:'capsule.verify',args:{capsule:Json}):Promise<boolean>;
 call(method:'claims.read',args:{name:string}):Promise<Versioned>;
 call(method:'claims.cas',args:{operationId:Id;name:string;expected:number;value:{holder:Binding;logicalOwner:Id;epoch:number}|null;fence:Fence}):Promise<Primitive<Receipt>>;
}
export declare function createService(ports:Ports,grant:Grant):Promise<Service>;
