import {createHash,createHmac,randomBytes} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
export const DERIVATION_VERSION='rjs-input-hmac-sha256-v1';
const canonical=x=>x===null||typeof x!=='object'?JSON.stringify(x):Array.isArray(x)?'['+x.map(canonical).join(',')+']':'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
const sha=x=>createHash('sha256').update(canonical(x)).digest('hex');
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
export function createReplayInput(){const root=randomBytes(32).toString('hex');return {schemaVersion:1,derivationVersion:DERIVATION_VERSION,root,commitment:sha({domain:'rjs-replay-root-v1',root})};}
export function validateReplayInput(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='commitment,derivationVersion,root,schemaVersion'||value.schemaVersion!==1||value.derivationVersion!==DERIVATION_VERSION||!hex(value.root)||!hex(value.commitment))throw Error('Invalid private replay input');
 if(value.commitment!==sha({domain:'rjs-replay-root-v1',root:value.root}))throw Error('Private replay commitment mismatch');
 return structuredClone(value);
}
export function replayInputFromRecord(record){
 if(!record||typeof record!=='object'||Object.keys(record).sort().join(',')!=='cases,commitment,derivationVersion,executedInputs,root,schemaVersion'||!Array.isArray(record.cases))throw Error('Invalid private replay record');
 const {cases,executedInputs,...input}=record;validateReplayInput(input);
 if(new Set(cases.map(c=>c.variantId)).size!==cases.length)throw Error('Duplicate private replay case');
 for(const c of cases)if(!c||Object.keys(c).sort().join(',')!=='authenticationCommitment,caseCommitment,fixtureAllocations,fixtureCommitment,rootCommitment,variantId,version'||c.version!==DERIVATION_VERSION||c.rootCommitment!==input.commitment||typeof c.variantId!=='string'||!['caseCommitment','fixtureCommitment','authenticationCommitment'].every(k=>hex(c[k]))||!Number.isSafeInteger(c.fixtureAllocations)||c.fixtureAllocations<0)throw Error('Invalid private replay case identity');
 if(!Array.isArray(executedInputs)||executedInputs.length!==cases.length)throw Error('Invalid private replay tapes');
 for(let n=0;n<cases.length;n++){const tape=executedInputs[n];if(!tape||Object.keys(tape).sort().join(',')!=='events,variantId'||tape.variantId!==cases[n].variantId||!Array.isArray(tape.events)||!tape.events.every(validEvent))throw Error('Invalid private replay tape');if(sha(tape.events)!==cases[n].fixtureCommitment)throw Error('Private executed input commitment mismatch');if(tape.events.filter(e=>e.type==='id').length!==cases[n].fixtureAllocations)throw Error('Private allocation count mismatch');}
 return input;
}
const eventKeys={'source-observation':['type','method','receipt'],id:['type','ordinal','id'],request:['type','request'],grant:['type','grant'],binding:['type','binding'],receipt:['type','receipt'],output:['type','jobId','stream','bytes'],sourcePrelude:['type','sourceId','workloadId','args'],'source-initialization':['type','sourceId','workloadId','jobId','channelId','streams','pending'],sourceAckBegin:['type','args','operationId'],sourceAckOutcome:['type','args','receipt']};
const jsonValue=x=>x===null||typeof x==='boolean'||typeof x==='string'||typeof x==='number'&&Number.isFinite(x)||Array.isArray(x)&&x.every(jsonValue)||x&&typeof x==='object'&&Object.getPrototypeOf(x)===Object.prototype&&Object.values(x).every(jsonValue);
function validEvent(e){return !!e&&typeof e==='object'&&!Array.isArray(e)&&eventKeys[e.type]?.slice().sort().join(',')===Object.keys(e).sort().join(',')&&jsonValue(e);}
export class ReplayEntropy {
 constructor(input,variantId,definition={}){this.input=validateReplayInput(input===undefined?createReplayInput():input);if(typeof variantId!=='string'||!variantId||variantId.length>256)throw Error('Invalid replay variant identity');this.variantId=variantId;this.definition=structuredClone(definition);this.context=new AsyncLocalStorage();this.counters=new Map();this.fixtureEvents=[];this.fixtureAllocations=0;this.key=this.derive(Buffer.from(this.input.root,'hex'),'case',{variantId,definition:this.definition});this.authenticationKey=this.derive(this.key,'authentication',DERIVATION_VERSION).toString('hex');}
 derive(key,domain,value){return createHmac('sha256',key).update(canonical({version:DERIVATION_VERSION,domain,value})).digest();}
 run(namespace,work){return this.context.run(namespace,work);}
 id(){const namespace=this.context.getStore()??'fixture',ordinal=this.counters.get(namespace)??0;this.counters.set(namespace,ordinal+1);const id=this.derive(this.key,'id/'+namespace,ordinal).subarray(0,16).toString('hex');if(namespace==='fixture'){this.fixtureAllocations++;this.record({type:'id',ordinal,id});}return id;}
 record(event){if(!validEvent(event))throw Error('Invalid executed fixture event');this.fixtureEvents.push(structuredClone(event));}
 identity(){return {version:DERIVATION_VERSION,rootCommitment:this.input.commitment,variantId:this.variantId,caseCommitment:sha({version:DERIVATION_VERSION,rootCommitment:this.input.commitment,variantId:this.variantId,definition:this.definition}),fixtureCommitment:sha(this.fixtureEvents),fixtureAllocations:this.fixtureAllocations,authenticationCommitment:sha({domain:'rjs-authentication-commitment-v1',key:this.authenticationKey})};}
}
