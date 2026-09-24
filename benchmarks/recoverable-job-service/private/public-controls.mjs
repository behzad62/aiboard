import {HarnessError} from './broker.mjs';
import {id,nat,obj} from './wire-schema.mjs';
const primitive=new Set('store.commit artifact.create artifact.write artifact.remove driver.acquire driver.start driver.attach driver.observeSource driver.barrier driver.privateRetain driver.publishAck driver.retireAck driver.publishRelease driver.replaceRelease driver.control driver.detach driver.release claims.cas'.split(' '));
const raw=new Set('store.read store.scan artifact.read artifact.inspect driver.inspect driver.inspectBinding claims.read consumer.query consumer.consume'.split(' '));
const claims=new Set('missing invalid-token foreign-job foreign-channel foreign-reader foreign-scope foreign-owner future-epoch negative fractional unsafe impossible false-zero cross-stream future-time at-proof-deadline expired stale missing-prefix wrong-range legacy-reason production window'.split(' '));
const codes=new Set('authority identity busy deadline lease unknown-effect consumer-unknown integrity gap missing-checkpoint missing-receipt capacity dependency backend input unsupported cleanup owned-path privacy'.split(' '));
const observations=['source-observation.before','source-observation.after'];
const closed=(a,required,optional=[])=>obj(a)&&required.every(k=>Object.hasOwn(a,k))&&Object.keys(a).every(k=>required.includes(k)||optional.includes(k));
const reject=()=>{throw new HarnessError('Invalid closed public controller input');};
const json=x=>x===null||['string','boolean'].includes(typeof x)||typeof x==='number'&&Number.isFinite(x)||Array.isArray(x)&&x.every(json)||obj(x)&&Object.values(x).every(json);
export function validateFault(a,hold=false){
 if(!obj(a)||typeof a.method!=='string')reject();
 const optional=['jobId','sourceId','occurrence'];if(a.jobId!==undefined&&!id(a.jobId)||a.sourceId!==undefined&&!id(a.sourceId)||a.jobId!==undefined&&a.sourceId!==undefined||a.occurrence!==undefined&&(!nat(a.occurrence)||!a.occurrence))reject();
 if(hold){if(![...observations,'driver.attach.before','driver.attach.after','driver.observeSource.before','driver.observeSource.after','driver.start.after','store.commit.before','store.commit.after'].includes(a.method)||!closed(a,['method'],[...optional,'observationMethod','sourceGuardOnly'])||a.sourceGuardOnly!==undefined&&(typeof a.sourceGuardOnly!=='boolean'||!a.method.startsWith('store.commit.')))reject();}
 else {const phase=a.method.split('.').at(-1),method=a.method.slice(0,-phase.length-1),source=observations.includes(a.method),claim=a.method==='source-observation.claim';if(!source&&!claim&&(!['before','after'].includes(phase)||!primitive.has(method)&&!raw.has(method)))reject();const fields={hold:[],throw:['value'],busy:['delay'],'not-applied':['code'],unknown:[],claim:['claim']}[a.action];if(!fields)reject();const extras=[...optional,...(source||claim?['observationMethod']:[]),...(a.action==='unknown'?['receiptVisibility']:[])];if(!closed(a,['method','action',...fields],extras))reject();if(claim){if(a.action!=='claim'||!claims.has(a.claim))reject();}else if(a.action==='claim')reject();if(a.action==='busy'&&(phase!=='before'||!source&&!primitive.has(method)||!nat(a.delay)))reject();if(a.action==='not-applied'&&(phase!=='before'||!source&&!primitive.has(method)||!codes.has(a.code)))reject();if(a.action==='unknown'&&(phase!=='after'||!source&&!primitive.has(method)||source&&a.receiptVisibility===undefined||a.receiptVisibility!==undefined&&!['available','unknown'].includes(a.receiptVisibility)))reject();if(a.action==='throw'&&!json(a.value))reject();}
 if(a.observationMethod!==undefined&&(!observations.includes(a.method)&&a.method!=='source-observation.claim'||!['driver.attach','driver.observeSource'].includes(a.observationMethod)))reject();
 return {...a,...(a.action==='throw'&&obj(a.value)&&Object.keys(a.value).length===1&&a.value.tag==='undefined'?{value:undefined}:{})};
}
/** Fixture-only controls; guest code never receives this function or controller state. */
export function sourceControls(b,invoke,reopen,setAutoClock=()=>{}){
 const holds=new Map(),calls=new Map();
 return (type,a={})=>b.entropy.run('fixture',async()=>{
  if(type==='fault'){const f=validateFault(a);b.fault(f.method,f.action,f);return null;}
  if(type==='sourcePrelude')return b.sourcePrelude(a);
  if(type==='sourceState'){if(!closed(a,['sourceId'])||!id(a.sourceId))reject();return b.sourceState(a);}
  if(type==='sourceAckOutcome')return b.sourceAckOutcome(a);
  if(type==='sourceAckBegin')return b.sourceAckBegin(a);
  if(type==='begin'){if(!closed(a,['request'])||!obj(a.request))reject();const callId=b.id(),pending=invoke(a.request);pending.catch(()=>{});calls.set(callId,pending);return {callId};}
  if(type==='join'){if(!closed(a,['callId'])||!calls.has(a.callId))reject();return calls.get(a.callId);}
  if(type==='hold'){validateFault(a,true);setAutoClock(false);const faultId=b.id();let settle;const reached=new Promise(r=>settle=r);holds.set(faultId,reached);b.fault(a.method,'hold',{...a,onHold:heldId=>{const held=b.held.get(heldId);settle({heldId,method:held.name,jobId:held.args.jobId??null,operationId:held.args.operationId??null});}});return {faultId};}
  if(type==='waitBoundary'){if(!closed(a,['faultId'])||!holds.has(a.faultId))reject();return holds.get(a.faultId);}
  if(type==='release'){if(!closed(a,['heldId'])||!id(a.heldId))reject();b.resume(a.heldId);setAutoClock(true);return null;}
  if(type==='advance'){if(!closed(a,['now']))reject();b.tick(a.now);return null;}
  if(type==='reopen'){if(!closed(a,[]))reject();await reopen();return null;}
  throw new HarnessError('Unknown public source controller '+type);
 });
}
