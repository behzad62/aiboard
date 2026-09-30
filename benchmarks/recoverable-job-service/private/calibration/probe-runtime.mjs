import {Scenario,AssertionFailure} from '../scenarios.mjs';
import {variants,exerciseVariant} from '../variants.mjs';
import {effectiveProvenance,schedulePlan} from '../provenance.mjs';
import {PROFILE,CONTRACT_VERSION,SUITE_VERSION} from '../evaluator.mjs';
import {LIMITS,CandidateError} from '../broker.mjs';
import {inspectSafety} from '../oracle.mjs';

// Supplementary trusted calibration observations. This changes no production
// predicate, port result, private candidate record, or runtime behavior.
export async function actualPredicate(source,variantId,{replayInput,largeCount,beforeRequest,afterExercise}={}){
 const provenance=effectiveProvenance({variantIds:[variantId],...(largeCount?{largeCount}:{})});
 const v=schedulePlan(provenance.seed,variants.filter(row=>row.id===variantId))[0];
 if(!v)throw Error('unknown actual calibration predicate: '+variantId);
 const definition={contractVersion:CONTRACT_VERSION,suiteVersion:SUITE_VERSION,profile:PROFILE,
  variant:{id:v.id,family:v.family,kind:v.kind,args:v.args},seed:provenance.seed,schedule:v.schedule,
  largeCount:provenance.largeCount,limits:{...LIMITS,wallMs:provenance.familyWallMs}};
 const s=new Scenario(source,v.family,{replayInput,variantId,caseDefinition:definition,seed:provenance.seed,
  schedule:v.schedule,largeCount:provenance.largeCount,wallMs:provenance.familyWallMs});
 const publicCalls=[],run=s.run.bind(s);let insideHook=false;
 s.run=async(method,args={})=>{
  if(beforeRequest&&!insideHook){insideHook=true;try{await beforeRequest({s,method,args,publicCalls});}finally{insideHook=false;}}
  const call={method,args,traceStart:s.b.trace.length};publicCalls.push(call);
  try{const result=await run(method,args);call.result=structuredClone(result);return result;}
  catch(error){call.error=String(error);throw error;}finally{call.traceEnd=s.b.trace.length;}
 };
 let failure=null;
 try{await s.open();await exerciseVariant(s,v);if(afterExercise)await afterExercise({s,publicCalls});}
 catch(error){if(!(error instanceof AssertionFailure||error instanceof CandidateError))throw error;failure=error.message;}
 finally{await s.dispose();}
 const safety=inspectSafety(s.b),effects=s.b.trace.filter(e=>e.type==='effect');
 const roots=[...s.b.roots.values()].map(r=>({handle:r.handle,absent:r.absent,names:[...r.files.keys()]}));
 const summary={variantId,failure,safety,assertions:s.assertions,operations:s.b.operations,
  promiseJobs:s.guests.reduce((n,g)=>n+g.jobs,0),
  effects:Object.fromEntries([...new Set(effects.map(e=>e.method))].map(m=>[m,effects.filter(e=>e.method===m).length])),
  publicCalls:publicCalls.map(c=>({method:c.method,kind:c.result?.kind??null,blockers:c.result?.blockers??[],error:c.error??null})),
  faults:s.b.trace.flatMap((e,index)=>e.type==='fault'?[{boundary:e.boundary,index,during:publicCalls.filter(c=>c.traceStart<=index&&index<c.traceEnd).map(c=>c.method)}]:[]),
  physicalRemovals:s.b.physicalRemovals,
  strategyObservations:{recordCount:s.b.docs.size,envelopedRecords:[...s.b.docs.values()].filter(r=>r.value!==null&&Object.hasOwn(r.value,'record')).length,
   keyPrefixes:[...new Set([...s.b.docs.keys()].map(k=>k.split('/').slice(0,2).join('/')))],
   ownershipIndex:s.b.docs.get('membership/head')?.value??null,roots,
   removedRootOrder:effects.filter(e=>e.method==='artifact.remove').map(e=>e.receipt.resourceId)},
  allGuestsDisposed:s.guests.every(g=>!g.live),remainingTrackedCalls:s.calls.size};
 return {summary,privateTrace:{publicCalls,trace:s.b.trace,audit:s.b.audit,input:s.b.executedInput()}};
}
