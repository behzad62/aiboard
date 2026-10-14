// Creator-owned Windows inspection scope. No process, Worker or filesystem I/O on import/constructor.
// RUNNER_RAW_PROCESS_BOUNDARY: Spawn only the pinned installed inspection helper; retain its original handle, Worker and streams through bounded owned cleanup.
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { createHash,randomBytes } from 'node:crypto';
import { existsSync,lstatSync,realpathSync,openSync,fstatSync,readFileSync,closeSync } from 'node:fs';
import { win32 } from 'node:path';
import { performance } from 'node:perf_hooks';
import { SLOT,SAB_BYTES,QUEUE_LIMIT,readRequestResult } from './queue.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const hex=(text,size)=>typeof text==='string'&&new RegExp(`^[0-9a-f]{${size}}$`).test(text);
const signal=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const env=()=>({SystemRoot:'C:\\Windows',WINDIR:'C:\\Windows',PATH:'C:\\Windows\\System32',PATHEXT:'.COM;.EXE;.BAT;.CMD',PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'});
export function errorFacts(error,depth=0) {
  const facts={name:String(error?.name??error?.class??'Error').slice(0,80),code:String(error?.code??'UNKNOWN').slice(0,80),message:String(error?.message??error).slice(0,512)};
  if(error?.nativeExit)facts.nativeExit={...error.nativeExit};if(error?.nativeClose)facts.nativeClose={...error.nativeClose};
  if(depth<4&&error?.workerFacts)facts.workerFacts=errorFacts(error.workerFacts,depth+1);
  if(depth<4&&error?.cause)facts.cause=errorFacts(error.cause,depth+1);
  if(depth<4&&Array.isArray(error?.errors))facts.errors=error.errors.slice(0,16).map(value=>errorFacts(value,depth+1));
  return facts;
}
function packet(value) {
  if(!value||Object.keys(value).sort().join(',')!=='base64,sha256'||!hex(value.sha256,64)||typeof value.base64!=='string'||value.base64.length>1000000)throw Error('Fixed source packet schema');
  const bytes=Buffer.from(value.base64,'base64');
  if(bytes.length===0||bytes.toString('base64')!==value.base64||sha(bytes)!==value.sha256||!Buffer.from(bytes.toString('utf8'),'utf8').equals(bytes))throw Error('Fixed source packet bytes');
  return bytes;
}
export function bundleRuntime(sources) {
  if(!sources||Object.keys(sources).sort().join(',')!=='protocol,queue,worker')throw Error('Fixed Worker source set');
  const protocol=packet(sources.protocol),queue=packet(sources.queue).toString('utf8'),worker=packet(sources.worker).toString('utf8');
  const url=bytes=>'data:text/javascript;base64,'+Buffer.from(bytes).toString('base64');
  const replace=(code,operand,target)=>{if(code.split(operand).length!==2)throw Error('Fixed Worker import count');return code.replace(operand,JSON.stringify(target));};
  const protocolUrl=url(protocol),queueUrl=url(replace(queue,"'./protocol.mjs'",protocolUrl));
  return url(replace(replace(worker,"'./protocol.mjs'",protocolUrl),"'./queue.mjs'",queueUrl));
}
async function wait(promise,deadline,label) {
  const remaining=deadline-performance.now();if(remaining<=0){void Promise.resolve(promise).catch(()=>{});throw Error(label+' deadline exhausted');}
  let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' deadline exhausted')),remaining);})]);}finally{clearTimeout(timer);}
}
export class WindowsBirthSession {
  constructor(config) {
    if(!config||Object.keys(config).sort().join(',')!=='binary,buildPins,sources'||!config.binary||Object.keys(config.binary).sort().join(',')!=='path,sha256,sourceSha256'||typeof config.binary.path!=='string'||!win32.isAbsolute(config.binary.path)||!config.binary.path.endsWith('\\helper.exe')||!hex(config.binary.sha256,64)||!hex(config.binary.sourceSha256,64)||!Array.isArray(config.buildPins)||config.buildPins.length<1||config.buildPins.length>16)throw Error('Session creator configuration');
    for(const pin of config.buildPins)if(!pin||Object.keys(pin).sort().join(',')!=='path,sha256'||typeof pin.path!=='string'||!win32.isAbsolute(pin.path)||!hex(pin.sha256,64))throw Error('Session build provenance');
    this.config=Object.freeze({binary:Object.freeze({...config.binary}),buildPins:Object.freeze(config.buildPins.map(p=>Object.freeze({...p}))),sources:Object.freeze(Object.fromEntries(Object.entries(config.sources).map(([name,value])=>[name,Object.freeze({...value})])))});
    this.workerUrl=bundleRuntime(config.sources);
    this.state='NEW';this.registered=false;this.lease=null;this.generationState=new SharedArrayBuffer(4);this.generation=randomBytes(32).toString('hex');
    this.secret=randomBytes(32).toString('hex');this.challenge=randomBytes(16).toString('hex');this.pipeName='aiboard-birth-'+randomBytes(16).toString('hex');
    this.requestId=0;this.pending=new Map();this.consumed=new Set();this.errors=[];this.child=null;this.worker=null;this.descriptor=null;this.closePromise=null;this.preparePromise=null;
    this.bootstrap=signal();this.control=signal();this.transport=signal();this.childExited=signal();this.childClosed=signal();this.workerExited=signal();this.failure=signal();this.firstFailure=null;
    this.stdout=[];this.stderr=[];this.outputBytes=0;this.helperExit=null;this.helperClose=null;this.workerExit=null;this.rescueUsed=false;
    this.counters={helperSpawns:0,workerStarts:0,compilerSpawns:0,queries:0,existenceChecks:0,maximumUnresolvedSlots:0};
  }
  validLease(lease){return lease!==null&&lease===this.lease&&this.state==='READY'&&Atomics.load(new Int32Array(this.generationState),0)===0;}
  registerCleanup(register) {
    if(this.state!=='NEW'||this.registered||typeof register!=='function')throw Error('Creator cleanup registration phase');
    register(deadline=>this.close(deadline));this.registered=true;
  }
  fail(error) {
    const actual=error instanceof Error?error:Error(String(error));this.errors.push(actual);
    if(!this.firstFailure){this.firstFailure=actual;this.failure.resolve(actual);}
    Atomics.compareExchange(new Int32Array(this.generationState),0,0,1);
    if(!['CLOSING','CLOSED'].includes(this.state))this.state='FAILED';
    for(const record of this.pending.values()){const view=new Int32Array(record.sab,0,4);for(const state of [SLOT.QUEUED,SLOT.ADMITTED,SLOT.CANCEL_REQUESTED])Atomics.compareExchange(view,0,state,SLOT.CLOSED);Atomics.notify(view,0);}
  }
  assertPreparing(){if(this.firstFailure)throw this.firstFailure;if(this.state!=='PREPARING'||Atomics.load(new Int32Array(this.generationState),0)!==0)throw Error('Preparation scope already retired');}
  async prepared(promise,deadline,label){
    try{this.assertPreparing();if(deadline<=performance.now())throw Error(label+' deadline exhausted');}catch(error){void Promise.resolve(promise).catch(()=>{});throw error;}
    const value=await wait(Promise.race([promise,this.failure.promise.then(error=>{throw error;})]),deadline,label);this.assertPreparing();return value;
  }
  prepare(deadline) {
    if(!Number.isFinite(deadline)||deadline<=performance.now())return Promise.reject(Error('Explicit preparation deadline required'));
    if(!this.registered)return Promise.reject(Error('Creator must register cleanup before preparation'));
    if(this.validLease(this.lease))return Promise.resolve(this.lease);
    if(this.state==='PREPARING')return wait(this.preparePromise,deadline,'Existing preparation');
    if(this.state!=='NEW')return Promise.reject(Error('Scope cannot prepare/restart a previous generation'));
    this.state='PREPARING';this.preparePromise=this.prepareOnce(Math.min(deadline,performance.now()+30000));return this.preparePromise;
  }
  async prepareOnce(deadline) {
    try {
      if(process.platform!=='win32'||process.arch!=='x64'||!/^v24\./.test(process.version))throw Error('Windows x64 certified Node24 required');
      const binary=this.config.binary;let part=win32.parse(binary.path).root;
      for(const name of binary.path.slice(part.length).split('\\')){part=win32.join(part,name);if(lstatSync(part).isSymbolicLink())throw Error('Binary component alias');}
      if(realpathSync.native(binary.path).toLowerCase()!==binary.path.toLowerCase()||existsSync(binary.path+'.config'))throw Error('Binary path/config substitution');
      for(const pin of this.config.buildPins)if(sha(readFileSync(pin.path))!==pin.sha256)throw Error('Build provenance changed');
      this.descriptor=openSync(binary.path,'r');const stat=fstatSync(this.descriptor);
      if(!stat.isFile()||stat.nlink!==1||stat.size<512||stat.size>10485760)throw Error('Binary descriptor bound/type/link');
      const bytes=readFileSync(this.descriptor);if(bytes.length!==stat.size||sha(bytes)!==binary.sha256)throw Error('Binary descriptor digest');
      if(performance.now()>=deadline)throw Error('Preparation exhausted before child allocation');
      this.child=spawn(binary.path,['--binary-sha256',binary.sha256],{windowsHide:true,detached:true,stdio:['pipe','pipe','pipe'],env:env(),cwd:'C:\\Windows\\System32'});this.counters.helperSpawns++;
      this.child.on('error',error=>this.fail(error));this.child.stdin.on('error',error=>this.fail(error));
      for(const stream of ['stdout','stderr'])this.child[stream].on('error',error=>this.fail(error));
      this.child.once('exit',(code,signal)=>{this.helperExit={code,signal,at:performance.now()};this.childExited.resolve(this.helperExit);if(!['CLOSING','CLOSED'].includes(this.state))this.fail(Object.assign(Error('Helper exited before owned close'),{nativeExit:this.helperExit}));if(this.firstFailure)this.firstFailure.nativeExit??=this.helperExit;});
      this.child.once('close',(code,signal)=>{this.helperClose={code,signal,at:performance.now(),stdoutEnded:this.child.stdout.readableEnded,stderrEnded:this.child.stderr.readableEnded};this.childClosed.resolve(this.helperClose);if(this.firstFailure)this.firstFailure.nativeClose??=this.helperClose;});
      let line='';
      this.child.stdout.on('data',chunk=>{
        this.capture('stdout',chunk);if(chunk.some(b=>b<9||b>126)){this.fail(Error('Helper setup ASCII'));return;}
        line+=chunk.toString('ascii');if(line.length>4096){this.fail(Error('Helper setup bound'));return;}
        let index;while((index=line.indexOf('\n'))>=0){const value=line.slice(0,index).replace(/\r$/,'');line=line.slice(index+1);this.setup(value);}
      });
      this.child.stdout.on('end',()=>{if(line.length)this.fail(Error('Partial helper setup EOF'));});
      this.child.stderr.on('data',chunk=>this.capture('stderr',chunk));
      this.child.stdin.write(['BOOT1','LIVE',this.generation,this.secret,this.pipeName,binary.sha256].join('\t')+'\n');
      await this.prepared(this.bootstrap.promise,deadline,'Helper bootstrap');await this.prepared(this.control.promise,deadline,'Independent helper control reader');
      this.assertPreparing();if(performance.now()>=deadline)throw Error('Preparation exhausted before Worker allocation');
      this.worker=new Worker(new URL(this.workerUrl),{execArgv:[],env:env(),workerData:{generation:this.generation,source:binary.sha256,secret:this.secret,challenge:this.challenge,pipeName:this.pipeName,generationState:this.generationState,timeOrigin:performance.timeOrigin}});this.counters.workerStarts++;
      this.worker.on('error',error=>this.fail(error));this.worker.on('message',message=>{
        if(message?.generation!==this.generation){this.fail(Error('Foreign Worker generation'));return;}
        if(message.type==='ready'&&this.state==='PREPARING'&&message.counters?.wireQueries===0&&!this.workerReady){this.workerReady=true;this.transport.resolve();return;}
        if(message.type==='failure'){const error=Error('Worker transport failure');error.workerFacts=message.facts;this.fail(error);return;}
        this.fail(Error('Unexpected Worker message'));
      });
      this.worker.once('exit',code=>{this.workerExit={code,at:performance.now()};this.workerExited.resolve(this.workerExit);if(!['CLOSING','CLOSED'].includes(this.state))this.fail(Error('Worker actually exited'));});
      await this.prepared(this.transport.promise,deadline,'Authenticated private transport');
      this.assertPreparing();if(performance.now()>=deadline)throw Error('Preparation exhausted before lease publication');
      this.state='READY';this.lease=Object.freeze({kind:'windows-birth-inspection-lease',generation:this.generation,source:binary.sha256});return this.lease;
    }catch(error){this.fail(error);try{await this.close(performance.now()+5000);}catch(cleanup){throw new AggregateError([error,cleanup],'Preparation and helper cleanup failed',{cause:error});}throw error;}
  }
  capture(stream,bytes){this.outputBytes+=bytes.length;if(this.outputBytes>131072){this.fail(Error('Helper output bound'));return;}this[stream].push(Buffer.from(bytes));}
  setup(line) {
    const parts=line.split('|');if(parts[1]!==this.generation||parts.at(-1)!==this.config.binary.sha256){this.fail(Error('Helper setup binding'));return;}
    if(parts[0]==='HELPER_BOOTSTRAP'&&parts.length===4&&parts[2]===String(this.child.pid)&&!this.gotBootstrap){this.gotBootstrap=true;this.bootstrap.resolve();return;}
    if(parts[0]==='CTRL_READY'&&parts.length===3&&this.gotBootstrap&&!this.gotControl){this.gotControl=true;this.control.resolve();return;}
    this.fail(Error('Helper setup phase/duplicate'));
  }
  submit(lease,pid,absoluteDeadline) {
    const started=performance.now();
    if(!this.validLease(lease)||!Number.isSafeInteger(pid)||pid<1||pid>2147483647||!Number.isFinite(absoluteDeadline))return{outcome:{status:'unknown',reason:'unavailable_or_invalid'}};
    const deadline=Math.min(absoluteDeadline,started+2000);if(started>=deadline)return{outcome:{status:'unknown',reason:'deadline'}};
    this.reapConsumed();
    if(this.pending.size>=QUEUE_LIMIT||this.requestId>=Number.MAX_SAFE_INTEGER)return{outcome:{status:'unknown',reason:'capacity'}};
    this.counters.queries++;this.counters.existenceChecks++;
    try{process.kill(pid,0);}catch(error){return{outcome:{status:error?.code==='ESRCH'&&this.validLease(lease)&&performance.now()<deadline?'absent':'unknown',reason:error?.code==='ESRCH'?'ESRCH':'existence_error',error}};}
    if(!this.validLease(lease)||performance.now()>=deadline)return{outcome:{status:'unknown',reason:'deadline_or_generation'}};
    const sab=new SharedArrayBuffer(SAB_BYTES);Atomics.store(new Int32Array(sab,0,4),0,SLOT.QUEUED);
    const record=Object.freeze({type:'request',generation:this.generation,source:this.config.binary.sha256,requestId:++this.requestId,nonce:randomBytes(16).toString('hex'),pid,sab,deadline});
    this.pending.set(record.requestId,record);this.counters.maximumUnresolvedSlots=Math.max(this.counters.maximumUnresolvedSlots,this.pending.size);
    try{this.worker.postMessage(record);}catch(error){this.fail(error);}
    return{record};
  }
  reapConsumed(){for(const id of [...this.consumed]){const record=this.pending.get(id);if(!record||![SLOT.QUEUED,SLOT.ADMITTED,SLOT.CANCEL_REQUESTED].includes(Atomics.load(new Int32Array(record.sab,0,4),0))){this.pending.delete(id);this.consumed.delete(id);}}}
  consume(record){this.consumed.add(record.requestId);this.reapConsumed();}
  collect(record,lease,abort){
    try{
      if(!this.validLease(lease)){const view=new Int32Array(record.sab,0,4);for(const state of [SLOT.QUEUED,SLOT.ADMITTED,SLOT.CANCEL_REQUESTED])Atomics.compareExchange(view,0,state,SLOT.CLOSED);Atomics.notify(view,0);return{status:'unknown',reason:'generation_unavailable'};}
      const value=readRequestResult(record,{generation:this.generation,source:this.config.binary.sha256,generationState:this.generationState},performance.now());
      if(!this.validLease(lease)||performance.now()>=record.deadline||abort?.aborted)return{status:'unknown',reason:'deadline_or_generation'};
      if(value.status!=='unknown'||value.reason!=='native_error')return value;
      // A process may exit between submission's existence check and the native
      // birth read. Confirm absence independently; exception text is not proof.
      this.counters.existenceChecks++;
      let confirmationError,existence='live';
      try{process.kill(record.pid,0);}catch(error){
        confirmationError=error;existence='error';
        try{if(error?.code==='ESRCH')existence='ESRCH';}catch{}
      }
      let confirmationFacts;
      try{confirmationFacts={existence,...(confirmationError?{error:errorFacts(confirmationError)}:{})};}
      catch{confirmationFacts={existence,diagnosticUnavailable:true};}
      const eligible=this.validLease(lease)&&performance.now()<record.deadline&&!abort?.aborted;
      return{...value,absenceConfirmation:{...confirmationFacts,eligible},...(existence==='ESRCH'&&eligible?{status:'absent',reason:'ESRCH_after_native_error'}:{})};
    }catch(error){this.fail(error);return{status:'unknown',reason:'slot_error',error};}finally{this.consume(record);}
  }
  querySync(lease,pid,absoluteDeadline=performance.now()+2000) {
    const item=this.submit(lease,pid,absoluteDeadline);if(item.outcome)return item.outcome;
    const {record}=item,view=new Int32Array(record.sab,0,4);
    while(this.validLease(lease)&&[SLOT.QUEUED,SLOT.ADMITTED,SLOT.CANCEL_REQUESTED].includes(Atomics.load(view,0))&&performance.now()<record.deadline){const state=Atomics.load(view,0);Atomics.wait(view,0,state,Math.min(10,Math.max(0,record.deadline-performance.now())));}
    if([SLOT.QUEUED,SLOT.ADMITTED,SLOT.CANCEL_REQUESTED].includes(Atomics.load(view,0)))this.cancel(record);
    return this.collect(record,lease);
  }
  cancel(record) {
    const view=new Int32Array(record.sab,0,4);
    for(const state of [SLOT.QUEUED,SLOT.ADMITTED])if(Atomics.compareExchange(view,0,state,SLOT.CANCEL_REQUESTED)===state)break;
    Atomics.notify(view,0);
    try{this.worker?.postMessage({type:'cancel',generation:this.generation,requestId:record.requestId});}catch(error){this.fail(error);}
  }
  async queryAsync(lease,pid,abort,absoluteDeadline=performance.now()+2000) {
    if(abort?.aborted)return{status:'unknown',reason:'cancelled'};
    const item=this.submit(lease,pid,absoluteDeadline);if(item.outcome)return item.outcome;
    const {record}=item,view=new Int32Array(record.sab,0,4),cancel=()=>this.cancel(record);
    abort?.addEventListener('abort',cancel,{once:true});
    try {
      while(!abort?.aborted&&this.validLease(lease)&&[SLOT.QUEUED,SLOT.ADMITTED,SLOT.CANCEL_REQUESTED].includes(Atomics.load(view,0))&&performance.now()<record.deadline){const state=Atomics.load(view,0),waiting=Atomics.waitAsync(view,0,state,Math.min(10,Math.max(0,record.deadline-performance.now())));if(waiting.async)await waiting.value;}
      if([SLOT.QUEUED,SLOT.ADMITTED,SLOT.CANCEL_REQUESTED].includes(Atomics.load(view,0)))this.cancel(record);
      return abort?.aborted?{status:'unknown',reason:'cancelled'}:this.collect(record,lease,abort);
    }finally{abort?.removeEventListener('abort',cancel);this.consume(record);}
  }
  batchSync(lease,pids,absoluteDeadline=performance.now()+15000) {
    if(!Array.isArray(pids)||pids.length<1||pids.length>256||pids.some(pid=>!Number.isSafeInteger(pid)||pid<1||pid>2147483647)||new Set(pids).size!==pids.length)return undefined;
    const deadline=Math.min(absoluteDeadline,performance.now()+15000),result=new Map();
    for(const pid of pids){if(performance.now()>=deadline)return undefined;const observed=this.querySync(lease,pid,Math.min(deadline,performance.now()+2000));if(observed.status==='unknown')return undefined;result.set(pid,observed);}
    return performance.now()<deadline?result:undefined;
  }
  close(deadline) {
    if(this.closePromise)return this.closePromise;
    if(!Number.isFinite(deadline))return Promise.reject(Error('Explicit helper cleanup deadline required'));
    const attempt=this.closeOnce(Math.min(deadline,performance.now()+5000));this.closePromise=attempt;
    void attempt.then(()=>{},()=>{if(this.closePromise===attempt)this.closePromise=null;});
    return attempt; // A later explicit cleanup attempt uses the same retained generation/handles.
  }
  async closeOnce(deadline) {
    this.state='CLOSING';Atomics.compareExchange(new Int32Array(this.generationState),0,0,2);
    for(const record of this.pending.values()){const view=new Int32Array(record.sab,0,4);for(const state of [SLOT.QUEUED,SLOT.ADMITTED,SLOT.CANCEL_REQUESTED])Atomics.compareExchange(view,0,state,SLOT.CLOSED);Atomics.notify(view,0);}
    const failures=[];
    if(this.child){if(!this.helperExit){try{this.child.stdin.end();}catch(error){failures.push(error);}try{await wait(this.childExited.promise,deadline,'Helper EOF retirement');}catch(error){failures.push(error);}}
      if(!this.helperExit){this.rescueUsed=true;try{this.child.kill();}catch(error){failures.push(error);}}
      if(!this.helperClose)try{await wait(this.childClosed.promise,deadline,'Helper output settlement');}catch(error){failures.push(error);}
      if(this.helperExit?.code!==125||this.helperExit?.signal!==null||!this.helperClose?.stdoutEnded||!this.helperClose?.stderrEnded)failures.push(Error('Helper retirement/output unverified'));
    }
    if(this.worker&&!this.workerExit){try{this.worker.postMessage({type:'close',generation:this.generation});await wait(this.worker.terminate(),deadline,'Worker termination');if(!this.workerExit)await wait(this.workerExited.promise,deadline,'Worker actual exit');}catch(error){failures.push(error);}}
    if(this.descriptor!==null&&(!this.child||this.helperClose?.stdoutEnded&&this.helperClose?.stderrEnded)){
      try{const stat=lstatSync(this.config.binary.path);if(!stat.isFile()||stat.size<512||stat.size>10485760||existsSync(this.config.binary.path+'.config')||sha(readFileSync(this.config.binary.path))!==this.config.binary.sha256)throw Error('Binary path/config changed during owned generation');}catch(error){failures.push(error);}
      try{closeSync(this.descriptor);this.descriptor=null;}catch(error){failures.push(error);}
    }
    if(this.descriptor!==null)failures.push(Error('Binary descriptor retained while disposition unknown'));
    if(this.rescueUsed)failures.push(Error('Owned helper rescue used'));
    if(failures.length){this.state='FAILED';const error=new AggregateError(failures,'Inspection helper cleanup unknown');this.errors.push(error);throw error;}
    this.state='CLOSED';return this.receipt();
  }
  receipt(){return{state:this.state,generation:this.generation,binarySha256:this.config.binary.sha256,counters:{...this.counters},helperExit:this.helperExit,helperClose:this.helperClose,workerExit:this.workerExit,descriptorReleased:this.descriptor===null,rescueUsed:this.rescueUsed,errors:this.errors.slice(0,64).map(error=>errorFacts(error)),stdoutBase64:Buffer.concat(this.stdout).toString('base64'),stderrBase64:Buffer.concat(this.stderr).toString('base64')};}
}
