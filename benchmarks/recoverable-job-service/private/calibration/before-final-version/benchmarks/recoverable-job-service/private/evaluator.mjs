import {createReplayInput,validateReplayInput,DERIVATION_VERSION} from './replay.mjs';
import {variants,exerciseVariant} from './variants.mjs';
import {effectiveProvenance,schedulePlan} from './provenance.mjs';
import {scoreInputHashes} from './identity.mjs';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Scenario,scenarios,AssertionFailure} from './scenarios.mjs';
import {inspectSafety} from './oracle.mjs';
import {CandidateError,HarnessError,LIMITS} from './broker.mjs';
export const PROFILE='modeled-core-v2+legacy-capsule-v1+modeled-holder-v1+authenticated-source-bootstrap-v1';
export const CONTRACT_VERSION='rjs-contract-2.0.0';
export const SUITE_VERSION='rjs-suite-2.0.0';
export async function evaluate(source,options={}) {
 const replayInput=validateReplayInput(options.replayInput===undefined?createReplayInput():options.replayInput),caseInputs=[],executedInputs=[];
 const ids=options.families??Object.keys(scenarios).sort();if(new Set(ids).size!==ids.length||ids.some(id=>!scenarios[id]))throw new HarnessError('duplicate or unknown family');
 let provenance;try{provenance=effectiveProvenance(options);}catch(e){throw new HarnessError(e.message);}const plan=schedulePlan(provenance.seed,variants.filter(v=>provenance.variantIds.includes(v.id)));
 const families=[],safetyFailures=[];let invalid=null,terminated=false;const began=Date.now();
 for(const id of ids){const rows=[];options.onFamilyStart?.(id);
  for(const variant of plan.filter(v=>v.family===id)){if(invalid||terminated||Date.now()-began>=provenance.totalWallMs){terminated=terminated||!invalid;rows.push({id:variant.id,passed:false,safetyChecked:false,assertions:[{label:'Not executed after evaluation termination',passed:false}],reason:'Not executed',inputIdentity:null,operations:0,promiseJobs:0});continue;}
   const caseDefinition={contractVersion:CONTRACT_VERSION,suiteVersion:SUITE_VERSION,profile:PROFILE,variant:{id:variant.id,family:variant.family,kind:variant.kind,args:variant.args},seed:provenance.seed,schedule:variant.schedule,largeCount:provenance.largeCount,limits:{...LIMITS,wallMs:provenance.familyWallMs}};const s=new Scenario(source,id,{...options,replayInput,variantId:variant.id,caseDefinition,seed:provenance.seed,largeCount:provenance.largeCount,wallMs:provenance.familyWallMs,schedule:variant.schedule});options.onVariantStart?.({familyId:id,variantId:variant.id,execution:{variant:{id:variant.id,family:variant.family,kind:variant.kind,args:structuredClone(variant.args)},seed:s.options.seed,brokerSeed:s.b.seed,schedule:{partition:s.b.partition,delay:s.b.time},largeCount:s.options.largeCount,limits:{...LIMITS,wallMs:s.options.wallMs}}});let passed=false,reason='',safetyChecked=false;
   try{await s.open();await exerciseVariant(s,variant);if(s.assertions.length<2)throw new HarnessError('missing behavioral assertions '+variant.id);passed=true;reason='Observed public behavior and durable consequences.';}catch(e){if(e instanceof AssertionFailure||e instanceof CandidateError){reason=e.message;if(!s.assertions.some(a=>!a.passed))s.assertions.push({label:'Candidate operation completed within public contract: '+e.message.slice(0,700),passed:false});}else{invalid={kind:'invalid_harness',message:e?.stack??String(e),familyId:id};reason='Evaluator failure';}}
   finally{try{await s.dispose();if(s.b.trace.length){const safety=inspectSafety(s.b);safetyChecked=true;safetyFailures.push(...safety.map(f=>({...f,familyId:id,variantId:variant.id})));s.assertions.push({label:'Trusted causal oracle checked observed trace',passed:safety.length===0});if(safety.length){passed=false;reason+='; safety: '+safety.map(f=>f.code).join(', ');}}}catch(e){invalid={kind:'invalid_harness',message:e?.stack??String(e),familyId:id};passed=false;} }
   const inputIdentity=s.b.inputIdentity();caseInputs.push(inputIdentity);const tape=s.b.executedInput();executedInputs.push(tape);options.onCaseInput?.(tape);const row={inputIdentity,id:variant.id,passed:passed&&safetyChecked,safetyChecked,assertions:s.assertions,reason:String(reason).slice(0,8000),safetyFailures:safetyFailures.filter(f=>f.variantId===variant.id),operations:s.b.operations,promiseJobs:s.guests.reduce((n,g)=>n+g.jobs,0)};rows.push(row);options.onVariant?.({familyId:id,...row});
  }
  const family={id,group:id[0],passed:rows.length>0&&rows.every(v=>v.passed),safetyChecked:rows.length>0&&rows.every(v=>v.safetyChecked),mandatory:true,scheduleId:SUITE_VERSION+'/'+id+'/'+provenance.configurationHash,variants:rows,assertions:rows.flatMap(v=>v.assertions.map(a=>({...a,label:v.id+': '+a.label}))),reason:rows.every(v=>v.passed)?'All mandatory variants passed.':rows.filter(v=>!v.passed).map(v=>v.id+': '+v.reason).join('; ').slice(0,8000),operations:rows.reduce((n,v)=>n+v.operations,0),promiseJobs:rows.reduce((n,v)=>n+v.promiseJobs,0)};families.push(family);options.onFamily?.(family);
 }
 const groups=Object.fromEntries(['A','B','C','D','E'].map(g=>{const rows=families.filter(f=>f.group===g);return [g,{passed:rows.filter(f=>f.passed).length,total:rows.length,coverage:rows.length?rows.filter(f=>f.passed).length/rows.length:0}];}));
 options.onReplayRecord?.({...replayInput,cases:caseInputs,executedInputs});
 return {inputIdentity:{version:DERIVATION_VERSION,rootCommitment:replayInput.commitment,cases:caseInputs},...await scoreInputHashes(),schemaVersion:2,benchmark:'recoverable-job-service',profile:PROFILE,contractVersion:CONTRACT_VERSION,suiteVersion:SUITE_VERSION,candidateHash:createHash('sha256').update(source).digest('hex'),provenance,status:invalid?'invalid_harness':'valid',resolved:provenance.mode==='production'&&!invalid&&families.length===69&&families.every(f=>f.passed&&f.safetyChecked)&&!safetyFailures.length,families,groups,macroCoverage:Object.values(groups).reduce((n,g)=>n+g.coverage,0)/5,safetyFailures,...(invalid?{error:invalid}:{})};
}
export async function evaluateFile(path,options){return evaluate(await readFile(path,'utf8'),options);}
