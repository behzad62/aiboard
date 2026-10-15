// Worker-owned production scheduling proposal. Importing performs no I/O or launches.
import { encodeFrame, decodeFrame, normalizeUtc7, parseNativeError } from './protocol.mjs';
export const SAB_BYTES=8192, QUEUE_LIMIT=256;
export const SLOT=Object.freeze({QUEUED:1,RESULT:2,EXPIRED:3,CLOSED:4,CANCEL_REQUESTED:5,ADMITTED:6,CANCEL_DRAINED:7,REFUSED:8});
const hex=(s,n)=>typeof s==='string'&&new RegExp(`^[0-9a-f]{${n}}$`).test(s);
const states=r=>new Int32Array(r.sab,0,4);
const terminal=new Set([SLOT.RESULT,SLOT.EXPIRED,SLOT.CLOSED,SLOT.CANCEL_DRAINED,SLOT.REFUSED]);

export class BirthRequestQueue {
  constructor(config,hooks) {
    if(!config||Object.keys(config).sort().join(',')!=='challenge,generation,generationState,secret,source'||!hex(config.challenge,32)||!hex(config.generation,64)||!hex(config.secret,64)||!hex(config.source,64)||!(config.generationState instanceof SharedArrayBuffer)||config.generationState.byteLength!==4||!hooks||typeof hooks.now!=='function'||typeof hooks.send!=='function'||typeof hooks.failed!=='function')throw Error('Queue configuration');
    this.config=Object.freeze({...config});this.hooks=hooks;this.ready=false;this.closed=false;this.failure=null;
    this.pending=new Map();this.fifo=[];this.active=null;this.lastRequestId=0;this.wireSeq=0;this.usedPendingNonces=new Set();
    this.counters={submitted:0,wireQueries:0,cancelledBeforeAdmission:0,cancelledAfterAdmission:0,expiredBeforeAdmission:0,refused:0,completed:0,maximumPending:0};
    this.hello=Object.freeze({type:'HELLO',source:config.source,generation:config.generation,seq:0,nonce:config.challenge,pid:0,payload:'-'});
  }
  startFrame() {
    if(this.closed||this.ready||this.pending.size)throw Error('Handshake phase');
    return encodeFrame(this.hello,this.config.secret,'c2s');
  }
  generationOpen(){return !this.closed&&!this.failure&&Atomics.load(new Int32Array(this.config.generationState),0)===0;}
  now(){const value=this.hooks.now();if(!Number.isFinite(value)||value<0)throw Error('Queue clock');return value;}
  finish(record,state) {
    const view=states(record);let current=Atomics.load(view,0);
    while(!terminal.has(current)) {
      const before=Atomics.compareExchange(view,0,current,state);
      if(before===current)break;current=before;
    }
    Atomics.notify(view,0);
    this.pending.delete(record.requestId);this.usedPendingNonces.delete(record.nonce);
  }
  poison(error) {
    const first=this.failure===null;
    this.failure??=error instanceof Error?error:Error(String(error));
    Atomics.compareExchange(new Int32Array(this.config.generationState),0,0,1);
    for(const record of [...this.pending.values()])this.finish(record,SLOT.CLOSED);
    this.active=null;this.fifo=[];this.ready=false;
    if(first)try{this.hooks.failed(this.failure);}catch(diagnosticError){this.failure=new AggregateError([this.failure,diagnosticError],'Queue failure and diagnostic publication failed',{cause:this.failure});}
    throw this.failure;
  }
  enqueue(message) {
    try {
      if(!message||Object.keys(message).sort().join(',')!=='deadline,generation,nonce,pid,requestId,sab,source,type'||message.type!=='request'||message.generation!==this.config.generation||message.source!==this.config.source||!hex(message.nonce,32)||!Number.isSafeInteger(message.requestId)||message.requestId<=this.lastRequestId||!Number.isSafeInteger(message.pid)||message.pid<1||message.pid>2147483647||!Number.isFinite(message.deadline)||!(message.sab instanceof SharedArrayBuffer)||message.sab.byteLength!==SAB_BYTES)throw Error('Queue request binding/schema');
      const now=this.now(),view=states(message),state=Atomics.load(view,0);
      if(!Number.isFinite(now)||message.deadline>now+2000||![SLOT.QUEUED,SLOT.CANCEL_REQUESTED,SLOT.EXPIRED].includes(state)||Atomics.load(view,1)!==0||Atomics.load(view,2)!==0||Atomics.load(view,3)!==0||this.usedPendingNonces.has(message.nonce))throw Error('Queue slot/deadline/nonce authority');
      if(!this.generationOpen()||!this.ready){this.finish(Object.freeze({...message}),SLOT.CLOSED);throw Error('Queue generation not ready');}
      this.lastRequestId=message.requestId;this.counters.submitted++;
      const record=Object.freeze({...message});
      if(state===SLOT.CANCEL_REQUESTED){this.counters.cancelledBeforeAdmission++;this.finish(record,SLOT.CANCEL_DRAINED);return false;}
      if(state===SLOT.EXPIRED||now>=record.deadline){this.counters.expiredBeforeAdmission++;this.finish(record,SLOT.EXPIRED);return false;}
      if(this.pending.size>=QUEUE_LIMIT){this.counters.refused++;this.finish(record,SLOT.REFUSED);return false;}
      this.pending.set(record.requestId,record);this.usedPendingNonces.add(record.nonce);this.fifo.push(record);
      this.counters.maximumPending=Math.max(this.counters.maximumPending,this.pending.size);
      this.dispatch();return true;
    }catch(error){return this.poison(error);}
  }
  expireQueued(now) {
    this.fifo=this.fifo.filter(record=>{
      const state=Atomics.load(states(record),0);
      if(state===SLOT.CANCEL_REQUESTED){this.counters.cancelledBeforeAdmission++;this.finish(record,SLOT.CANCEL_DRAINED);return false;}
      if(state===SLOT.EXPIRED||now>=record.deadline){this.counters.expiredBeforeAdmission++;this.finish(record,SLOT.EXPIRED);return false;}
      if(state!==SLOT.QUEUED)throw Error('Queued slot mutated outside cancellation');
      return true;
    });
  }
  dispatch() {
    try {
      if(!this.generationOpen())throw Error('Dispatch to terminal generation');
      const now=this.now();this.expireQueued(now);
      if(this.active||this.fifo.length===0)return;
      const record=this.fifo.shift(),view=states(record);
      if(Atomics.compareExchange(view,0,SLOT.QUEUED,SLOT.ADMITTED)!==SLOT.QUEUED){this.fifo.unshift(record);this.expireQueued(this.now());return this.dispatch();}
      if(this.wireSeq>=999999999)throw Error('Wire sequence exhausted');
      const tuple=Object.freeze({type:'QUERY',source:this.config.source,generation:this.config.generation,seq:++this.wireSeq,nonce:record.nonce,pid:record.pid,payload:'-'});
      Atomics.store(view,2,tuple.seq);
      this.active=Object.freeze({record,tuple});
      if(this.now()>=record.deadline)throw Error('Admitted request deadline exhausted before wire write');
      this.counters.wireQueries++;
      this.hooks.send(encodeFrame(tuple,this.config.secret,'c2s'));
    }catch(error){return this.poison(error);}
  }
  accept(raw) {
    try {
      if(!this.generationOpen())throw Error('Reply to terminal generation');
      const tuple=decodeFrame(raw,this.config.secret,'s2c'),same=e=>tuple.source===this.config.source&&tuple.generation===this.config.generation&&tuple.seq===e.seq&&tuple.nonce===e.nonce&&tuple.pid===e.pid;
      if(!this.ready){if(tuple.type!=='READY'||!same(this.hello)||tuple.payload!=='0:0')throw Error('Foreign handshake');this.ready=true;return;}
      if(!this.active||tuple.type!=='RESULT'||!same(this.active.tuple))throw Error('Unsolicited/replayed/foreign native result');
      const {record}=this.active,now=this.now(),view=states(record);
      if(now>=record.deadline)throw Error('Native reply after original deadline');
      const value=tuple.payload.startsWith('SAME:')?{status:'same',fingerprint:normalizeUtc7(tuple.payload.slice(5)),utc7:tuple.payload.slice(5)}:{status:'unknown',reason:'native_error',nativeErrorFacts:parseNativeError(tuple.payload)};
      const state=Atomics.load(view,0);
      if(state===SLOT.CANCEL_REQUESTED){this.counters.cancelledAfterAdmission++;this.finish(record,SLOT.CANCEL_DRAINED);}
      else {
        if(state!==SLOT.ADMITTED)throw Error('Result to unavailable admitted slot');
        const result={...value,generation:this.config.generation,source:this.config.source,requestId:record.requestId,wireSeq:tuple.seq,nonce:tuple.nonce,pid:tuple.pid,publishedAt:now};
        const bytes=Buffer.from(JSON.stringify(result),'utf8');if(bytes.length>SAB_BYTES-16)throw Error('Slot result bound');
        new Uint8Array(record.sab,16).set(bytes);Atomics.store(view,1,bytes.length);
        if(!this.generationOpen())throw Error('Generation changed before result publication');
        if(Atomics.compareExchange(view,0,SLOT.ADMITTED,SLOT.RESULT)!==SLOT.ADMITTED){
          if(Atomics.load(view,0)!==SLOT.CANCEL_REQUESTED)throw Error('Result publication lost to invalid mutation');
          this.counters.cancelledAfterAdmission++;this.finish(record,SLOT.CANCEL_DRAINED);
        }else{this.counters.completed++;this.finish(record,SLOT.RESULT);}
      }
      this.active=null;this.dispatch();
    }catch(error){return this.poison(error);}
  }
  tick() {
    try {
      if(!this.generationOpen())throw Error('Timer after terminal generation');
      const now=this.now();if(this.active&&now>=this.active.record.deadline)throw Error('Native request watchdog expired');
      this.expireQueued(now);this.dispatch();
    }catch(error){return this.poison(error);}
  }
  nextDeadline(){return Math.min(this.active?.record.deadline??Infinity,...this.fifo.map(record=>record.deadline));}
  close() {
    if(this.closed)return;
    this.closed=true;this.ready=false;Atomics.compareExchange(new Int32Array(this.config.generationState),0,0,2);
    for(const record of [...this.pending.values()])this.finish(record,SLOT.CLOSED);
    this.active=null;this.fifo=[];
  }
}

export function readRequestResult(record,lease,now) {
  if(!Number.isFinite(now)||now<0)throw Error('Result clock');
  if(!record||!lease||record.generation!==lease.generation||record.source!==lease.source||Atomics.load(new Int32Array(lease.generationState),0)!==0)return{status:'unknown',reason:'generation_unavailable'};
  const view=states(record),state=Atomics.load(view,0);
  if(state!==SLOT.RESULT)return{status:'unknown',reason:state===SLOT.CANCEL_DRAINED?'cancelled':state===SLOT.EXPIRED?'queue_expired':state===SLOT.REFUSED?'queue_full':'not_complete'};
  if(now>=record.deadline)return{status:'unknown',reason:'late_delivery'}; // Does not mutate/poison healthy transport.
  const length=Atomics.load(view,1);if(length<1||length>SAB_BYTES-16)throw Error('Slot result length');
  const bytes=Buffer.from(new Uint8Array(record.sab,16,length)),text=bytes.toString('utf8');if(!Buffer.from(text,'utf8').equals(bytes))throw Error('Slot result UTF8');
  const result=JSON.parse(text);
  if(JSON.stringify(result)!==text)throw Error('Slot result JSON encoding');
  if(result.generation!==record.generation||result.source!==record.source||result.requestId!==record.requestId||result.nonce!==record.nonce||result.pid!==record.pid||result.wireSeq!==Atomics.load(view,2)||result.wireSeq<1||!Number.isFinite(result.publishedAt)||result.publishedAt>=record.deadline||result.publishedAt>now||!['same','unknown'].includes(result.status))throw Error('Slot result request/wire binding');
  if(result.publishedAt<0||!Number.isSafeInteger(result.wireSeq)||result.wireSeq>999999999)throw Error('Slot publication/sequence bound');
  if(result.status==='same') {
    if(Object.keys(result).sort().join(',')!=='fingerprint,generation,nonce,pid,publishedAt,requestId,source,status,utc7,wireSeq'||normalizeUtc7(result.utc7)!==result.fingerprint)throw Error('Slot native timestamp schema');
  }else {
    const facts=result.nativeErrorFacts;
    if(Object.keys(result).sort().join(',')!=='generation,nativeErrorFacts,nonce,pid,publishedAt,reason,requestId,source,status,wireSeq'||result.reason!=='native_error'||!facts||Object.keys(facts).sort().join(',')!=='class,code,message'||!['code','class','message'].every(k=>typeof facts[k]==='string')||facts.code.length>80||facts.class.length>80||facts.message.length>160)throw Error('Slot native error schema');
  }
  if(Atomics.load(new Int32Array(lease.generationState),0)!==0||Atomics.load(view,0)!==SLOT.RESULT||Atomics.load(view,2)!==result.wireSeq)return{status:'unknown',reason:'generation_or_slot_changed'};
  return result;
}
