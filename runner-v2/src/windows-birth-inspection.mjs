// Creator-owned Windows birth observation. Installation code/assets are trusted.
// Hash/descriptor checks do not make path execution atomic against installation writers.
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync, openSync, fstatSync, readSync, closeSync, readdirSync } from 'node:fs';
import { dirname, join, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const ASSETS = Object.freeze({
  'protocol.mjs':'83d22d9baa526547059122186e5ffb21171f99a5866aa8aacc16779e1fa849e6',
  'queue.mjs':'51cfea81aee122fd92e1a241ae435e96de83e1987aa55eec5efd16f6b17d8788',
  'runtime-worker.mjs':'3f35034f63a56c2727dab0459af05449177424a0b652e64667506dc96f3e45ce',
  'session.mjs':'4d590ec9c8974e07c5dfc1518db61bfb2d824f1327cc7dc3d0167366ee55576b',
  'helper-live.cs':'05e35d52f59eee05427c2f09d28a9aa233439d39e342aad55e553710c832dd38',
  'provenance.json':'55ac94658e15524ad020d6dcf87e13b3835cde08504f6a44fe68b92809fe0595',
  'native/win-x64/helper.exe':'ce317a9f8694c2f5b4c99ceb6062bd893cd34fad78310015991d317c48543750',
});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const unknown = () => ({state:'unknown'});
const normalize = birth => birth.replace(/(\.\d{6})\d+(Z)$/, '$1$2');
const inspection = result => result?.status === 'same' && typeof result.fingerprint === 'string'
  ? {state:'present',fingerprint:result.fingerprint}
  : result?.status === 'absent' ? {state:'absent'} : unknown();

function monotonicDeadline(epoch, maximum) {
  if (!Number.isFinite(epoch)) throw Error('Inspection absolute deadline required');
  const remaining = Math.min(maximum, epoch - Date.now());
  if (remaining <= 0) throw Error('Inspection deadline exhausted');
  return performance.now() + remaining;
}
async function until(promise, deadline, label) {
  const remaining = deadline - performance.now();
  if (remaining <= 0) { void Promise.resolve(promise).catch(()=>{}); throw Error(label+' deadline exhausted'); }
  let timer;
  try { return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' deadline exhausted')),remaining);})]); }
  finally { clearTimeout(timer); }
}

function readAsset(path, expected) {
  let component = win32.parse(path).root;
  if (!/^[A-Za-z]:\\$/.test(component)) throw Error('Inspection requires a local trusted installation');
  for (const name of path.slice(component.length).split('\\')) {
    component=win32.join(component,name);
    if (lstatSync(component).isSymbolicLink()) throw Error('Inspection asset component alias');
  }
  if (realpathSync.native(path).toLowerCase() !== path.toLowerCase()) throw Error('Inspection asset canonical identity');
  const fd=openSync(path,'r');
  try {
    const stat=fstatSync(fd);
    if (!stat.isFile() || stat.nlink!==1 || stat.size<1 || stat.size>10485760) throw Error('Inspection asset type/link/size');
    const buffer=Buffer.alloc(stat.size+1);let length=0;
    while(length<buffer.length){const read=readSync(fd,buffer,length,buffer.length-length,length);if(read===0)break;length+=read;}
    const bytes=buffer.subarray(0,length);
    if (length!==stat.size || hash(bytes)!==expected) throw Error('Inspection asset bytes');
    return bytes;
  } finally { closeSync(fd); }
}
async function loadInstalledSession() {
  if (process.platform!=='win32' || process.arch!=='x64' || !/^v24\./.test(process.version)) throw Error('Windows x64 certified Node24 required');
  const root=join(dirname(fileURLToPath(import.meta.url)),'windows-birth'), held={};
  for (const [relative,sha256] of Object.entries(ASSETS)) {
    const path=join(root,...relative.split('/'));
    held[relative]={path,sha256,bytes:readAsset(path,sha256)};
  }
  const binary=held['native/win-x64/helper.exe'];
  // Managed configuration, DLL probing and .local redirection are not selected.
  if (JSON.stringify(readdirSync(dirname(binary.path)).sort())!==JSON.stringify(['helper.exe'])) throw Error('Unexpected native helper sidecar');
  const sources={};
  for (const [name,file] of [['protocol','protocol.mjs'],['queue','queue.mjs'],['worker','runtime-worker.mjs']]) {
    sources[name]={sha256:held[file].sha256,base64:held[file].bytes.toString('base64')};
  }
  const config={binary:{path:binary.path,sha256:binary.sha256,sourceSha256:held['helper-live.cs'].sha256},
    buildPins:['helper-live.cs','provenance.json'].map(file=>({path:held[file].path,sha256:held[file].sha256})),sources};
  // All four modules are checked before their first standard module import.
  const {WindowsBirthSession}=await import(pathToFileURL(held['session.mjs'].path).href);
  return {Session:WindowsBirthSession,config};
}

export class WindowsBirthInspectionOwner {
  #state='NEW'; #registered=false; #load; #session=null; #lease=null;
  #preparePromise=null; #closePromise=null; #cleanup=null; #operations=null; #holderBirth=null;
  #observationSequence=0; #observations=[]; #observationsDropped=0; #diagnosticFailures=0;
  // The loader seam is for trusted injected tests, never runtime user configuration.
  constructor(load=loadInstalledSession) {
    if (typeof load!=='function') throw Error('Trusted inspection loader required');
    this.#load=load;
  }
  registerCleanup(register) {
    if (this.#state!=='NEW' || this.#registered || typeof register!=='function') throw Error('Inspection cleanup registration phase');
    register(deadline=>this.closeInspection(deadline)); this.#registered=true;
  }
  async prepareInspection(absoluteDeadline=Date.now()+30000) {
    if (!this.#registered) throw Error('Creator must register inspection cleanup');
    const deadline=monotonicDeadline(absoluteDeadline,30000);
    if (this.#state==='READY') {
      if (this.#session.validLease(this.#lease)) return;
      this.#state='FAILED';
      throw this.#session.firstFailure ?? Object.assign(Error('Inspection generation is terminal'),{inspectionReceipt:this.#session.receipt()});
    }
    if (this.#state==='PREPARING') return await until(this.#preparePromise,deadline,'Existing inspection preparation');
    if (this.#state!=='NEW') throw Error('Inspection owner cannot restart a generation');
    this.#state='PREPARING'; this.#preparePromise=this.#prepareOnce(deadline);
    return await this.#preparePromise;
  }
  async #prepareOnce(deadline) {
    try {
      const loaded=await until(this.#load(),deadline,'Inspection assets');
      if (this.#state!=='PREPARING' || performance.now()>=deadline) throw Error('Inspection preparation retired');
      this.#session=new loaded.Session(loaded.config);
      this.#session.registerCleanup(cleanup=>{this.#cleanup=cleanup;});
      const session=this.#session, lease=await session.prepare(deadline);
      if (this.#state!=='PREPARING' || !session.validLease(lease) || performance.now()>=deadline) throw Error('Inspection preparation retired');
      this.#lease=lease;
      const ready=()=>this.#state==='READY' && session.validLease(lease);
      const sync=(pid,platform,attemptMs=2000)=>{
        if (platform!=='windows' || !ready() || !Number.isFinite(attemptMs) || attemptMs<=0) return unknown();
        const observation=this.#startObservation(pid,'sync');
        try { const result=session.querySync(lease,pid,performance.now()+Math.min(2000,attemptMs)),observed=inspection(result);this.#recordObservation(observation,result);return observed; }
        catch (error) {this.#recordObservation(observation,{status:'unknown',reason:'exception'},error);return unknown();}
      };
      this.#operations=Object.freeze({
        inspectProcessBirth:sync,
        inspectProcessBirthAsync:async(pid,platform,signal)=>{
          if (platform!=='windows' || !ready()) return unknown();
          const observation=this.#startObservation(pid,'async');
          try { const result=await session.queryAsync(lease,pid,signal),observed=inspection(result);this.#recordObservation(observation,result);return observed; }
          catch (error) {this.#recordObservation(observation,{status:'unknown',reason:'exception'},error);return unknown();}
        },
        inspectProcessBirths:(pids,platform)=>{
          if (platform!=='windows' || !ready()) return undefined;
          try { const rows=session.batchSync(lease,pids,performance.now()+15000);return rows && new Map([...rows].map(([pid,result])=>[pid,inspection(result)])); } catch { return undefined; }
        },
      });
      this.#state='READY';
    } catch (error) {
      if (!['CLOSING','CLOSED'].includes(this.#state)) this.#state='FAILED';
      throw error;
    }
  }
  operations() {
    if (this.#state!=='READY' || !this.#operations) throw Error('Inspection must be explicitly prepared');
    return this.#operations;
  }
  fenceOptions(absoluteDeadline=Date.now()+2000) {
    if(!Number.isFinite(absoluteDeadline) || absoluteDeadline<=Date.now()) throw Error('Owned fence inspection deadline exhausted');
    const operations=this.operations();
    if (!this.#holderBirth) {
      const result=operations.inspectProcessBirth(process.pid,'windows',absoluteDeadline-Date.now());
      if (result.state!=='present') throw Error('Owned fence holder birth is unavailable');
      this.#holderBirth=result.fingerprint;
    }
    const remaining=absoluteDeadline-Date.now();
    if(remaining<=0) throw Error('Owned fence inspection deadline exhausted');
    return Object.freeze({holderPid:process.pid,holderBirth:this.#holderBirth,deadlineMs:Math.ceil(remaining),deadlineAt:absoluteDeadline,inspectHolder:(pid,birth,remainingMs=2000)=>{
      const budget=Math.min(remainingMs,absoluteDeadline-Date.now());
      if(!Number.isFinite(budget) || budget<=0)return 'unknown';
      const result=operations.inspectProcessBirth(pid,'windows',budget);
      return result.state==='absent' ? 'absent' : result.state==='present' ? normalize(result.fingerprint)===normalize(birth) ? 'same' : 'birth_mismatch' : 'unknown';
    }});
  }
  async closeInspection(absoluteDeadline=Date.now()+5000) {
    if (this.#state==='CLOSED') return;
    const deadline=monotonicDeadline(absoluteDeadline,5000);
    if (this.#closePromise) return await until(this.#closePromise,deadline,'Existing inspection cleanup');
    this.#state='CLOSING';
    const attempt=(async()=>{
      try { if(this.#cleanup) await this.#cleanup(deadline);this.#state='CLOSED'; }
      catch(error) {this.#state='FAILED';throw error;}
    })();
    this.#closePromise=attempt;
    // If asset import is still pending, its state recheck prevents allocation.
    if (this.#preparePromise) void this.#preparePromise.catch(()=>{});
    try {await attempt;} finally {if(this.#closePromise===attempt)this.#closePromise=null;}
  }
  #startObservation(pid,mode) {
    try{return {sequence:++this.#observationSequence,generation:String(this.#session.generation).slice(0,64),pid,mode,startedAt:performance.now()};}
    catch{this.#diagnosticFailures++;return null;}
  }
  #recordObservation(observation,result,error) {
    // Diagnostic context only: completion order is not query/control authority.
    // Failure to capture facts must not alter the original inspection outcome.
    if(!observation)return;
    const completedAt=performance.now();
    try {
      let remaining=1024;
      const text=(value,maximum)=>{const original=String(value),length=Math.min(remaining,maximum,original.length);remaining-=length;return Object.freeze({value:original.slice(0,length),originalLength:original.length,truncated:length<original.length});};
      const facts=(value,depth=0)=>{
        if(depth>=2)return Object.freeze({truncated:true});
        const fact={name:text(value?.name??value?.class??'Error',80),code:text(value?.code??'UNKNOWN',80),message:text(value?.message??value,160)};
        if(value?.cause!==undefined)fact.cause=facts(value.cause,depth+1);
        if(Array.isArray(value?.errors)){fact.errors=Object.freeze(value.errors.slice(0,2).map(item=>facts(item,depth+1)));fact.errorCount=value.errors.length;fact.errorsTruncated=value.errors.length>2;}
        for(const key of ['nativeExit','nativeClose'])if(value?.[key])fact[key]=Object.freeze(Object.fromEntries(['code','signal','at','stdoutEnded','stderrEnded'].filter(name=>value[key][name]===null||['number','boolean','string'].includes(typeof value[key][name])).map(name=>[name,typeof value[key][name]==='string'?text(value[key][name],80):value[key][name]])));
        return Object.freeze(fact);
      };
      const outcome={status:text(result?.status??'unknown',40)};
      for(const key of ['reason','fingerprint'])if(result?.[key]!==undefined)outcome[key]=text(result[key],80);
      if(result?.nativeErrorFacts)outcome.nativeErrorFacts=Object.freeze(Object.fromEntries(['code','class','message'].map(key=>[key,text(result.nativeErrorFacts[key],key==='message'?160:80)])));
      if(result?.absenceConfirmation)outcome.absenceConfirmation=Object.freeze({existence:text(result.absenceConfirmation.existence,40),eligible:result.absenceConfirmation.eligible===true,...(result.absenceConfirmation.diagnosticUnavailable?{diagnosticUnavailable:true}:{}),...(result.absenceConfirmation.error?{error:facts(result.absenceConfirmation.error)}:{})});
      if(result?.error)outcome.error=facts(result.error);
      if(error!==undefined)outcome.error=facts(error);
      const record=Object.freeze({...observation,completedAt,result:Object.freeze(outcome)});
      if(this.#observations.length===16){this.#observations.shift();this.#observationsDropped++;}
      this.#observations.push(record);
    }catch{this.#diagnosticFailures++;}
  }
  receipt() { return {state:this.#state,session:this.#session?.receipt()??null,observations:Object.freeze({scope:'completed individual sync/async queries; batch internals excluded; context only',started:this.#observationSequence,dropped:this.#observationsDropped,unavailable:this.#diagnosticFailures,records:Object.freeze(this.#observations.slice())})}; }
}
