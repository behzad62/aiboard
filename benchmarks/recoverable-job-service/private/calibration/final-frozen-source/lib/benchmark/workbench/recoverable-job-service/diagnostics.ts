import {RECOVERABLE_JOB_SERVICE_PRODUCTION_PROVENANCE,RECOVERABLE_JOB_SERVICE_METADATA,RECOVERABLE_JOB_SERVICE_FAMILIES} from './assets.generated';
export type RecoverableJobServiceGroup = 'A' | 'B' | 'C' | 'D' | 'E';
export interface RecoverableJobServiceCaseInputIdentity {version:string;rootCommitment:string;variantId:string;caseCommitment:string;fixtureCommitment:string;fixtureAllocations:number;authenticationCommitment:string;}
export interface RecoverableJobServiceFamilyResult {
  variants: {inputIdentity:RecoverableJobServiceCaseInputIdentity|null;id:string;passed:boolean;safetyChecked:boolean;reason:string;assertions:{label:string;passed:boolean}[];operations:number;promiseJobs:number}[];
  id: string; group: RecoverableJobServiceGroup; passed: boolean; safetyChecked: boolean; mandatory: true;
  scheduleId: string; assertions: {label: string; passed: boolean}[];
  reason: string; operations: number; promiseJobs: number;
}
export interface RecoverableJobServiceDiagnostics {
  schemaVersion: 2; benchmark: 'recoverable-job-service'; profile: string;
  contractVersion: string; suiteVersion: string; candidateHash: string;
  contractHash?: string; suiteHash?: string;
  inputIdentity:{version:string;rootCommitment:string;cases:RecoverableJobServiceCaseInputIdentity[]}|null;
  provenance:{mode:string;seed:string;familyWallMs:number;totalWallMs:number;largeCount:number;operations:number;promiseJobs:number;variantIds:string[];scheduleHash:string;configurationHash:string};
  status: 'valid' | 'invalid_harness' | 'invalid_environment'; resolved: boolean;
  families: RecoverableJobServiceFamilyResult[];
  groups: Record<RecoverableJobServiceGroup,{passed:number;total:number;coverage:number}>;
  macroCoverage: number;
  safetyFailures: {code:string;jobId:string|null;detail:string;familyId:string;variantId?:string}[];
  error?: {kind:string;message:string;familyId:string|null};
}
export const RECOVERABLE_JOB_SERVICE_FAMILY_IDS:readonly string[] = RECOVERABLE_JOB_SERVICE_FAMILIES.map(f=>f.id);
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const integer=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const text=(v:unknown,limit=8192)=>typeof v==='string'&&v.length<=limit;
const near=(a:unknown,b:number)=>typeof a==='number'&&Number.isFinite(a)&&Math.abs(a-b)<1e-12;
const hex=(x:unknown):x is string=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
function caseIdentity(x:unknown):x is RecoverableJobServiceCaseInputIdentity{return record(x)&&Object.keys(x).sort().join(',')==='authenticationCommitment,caseCommitment,fixtureAllocations,fixtureCommitment,rootCommitment,variantId,version'&&x.version===RECOVERABLE_JOB_SERVICE_METADATA.derivationVersion&&text(x.variantId,256)&&integer(x.fixtureAllocations)&&['rootCommitment','caseCommitment','fixtureCommitment','authenticationCommitment'].every(k=>hex(x[k]));}
/** Browser-safe strict semantic validation; score is recomputed from trusted family/safety facts. */
export function parseRecoverableJobServiceDiagnostics(input:unknown):{ok:true;value:RecoverableJobServiceDiagnostics}|{ok:false;error:string}{
 try{
  const value:unknown=typeof input==='string'?JSON.parse(input):input;
  if(!record(value)||value.schemaVersion!==RECOVERABLE_JOB_SERVICE_METADATA.schemaVersion||value.benchmark!=='recoverable-job-service'||value.profile!==RECOVERABLE_JOB_SERVICE_METADATA.profile||value.contractVersion!==RECOVERABLE_JOB_SERVICE_METADATA.contractVersion||value.suiteVersion!==RECOVERABLE_JOB_SERVICE_METADATA.suiteVersion)throw Error('Unsupported diagnostics contract/profile');
  const allowed=new Set(['schemaVersion','benchmark','profile','contractVersion','suiteVersion','candidateHash','contractHash','suiteHash','status','resolved','families','groups','macroCoverage','safetyFailures','error','provenance','inputIdentity']);if(Object.keys(value).some(k=>!allowed.has(k)))throw Error('Unexpected diagnostics field');
  if(!text(value.candidateHash,64)||!/^[a-f0-9]{64}$/.test(value.candidateHash as string))throw Error('Invalid candidate hash');
  for(const key of ['contractHash','suiteHash'])if(value[key]!==undefined&&(!text(value[key],64)||!/^[a-f0-9]{64}$/.test(value[key] as string)))throw Error('Invalid input hash');
  if(!['valid','invalid_harness','invalid_environment'].includes(value.status as string)||typeof value.resolved!=='boolean'||!Array.isArray(value.families)||value.families.length!==RECOVERABLE_JOB_SERVICE_METADATA.familyCount||!record(value.groups)||!Array.isArray(value.safetyFailures))throw Error('Invalid diagnostics shape');

  const provenance=value.provenance;if(!record(provenance)||!['production','development','public'].includes(provenance.mode as string)||!text(provenance.seed,256)||!Array.isArray(provenance.variantIds)||new Set(provenance.variantIds).size!==provenance.variantIds.length||provenance.variantIds.some(id=>!text(id,256))||!['familyWallMs','totalWallMs','largeCount','operations','promiseJobs'].every(k=>integer(provenance[k])&&(provenance[k] as number)>0)||!['scheduleHash','configurationHash'].every(k=>typeof provenance[k]==='string'&&/^[a-f0-9]{64}$/.test(provenance[k] as string)))throw Error('Invalid effective scoring provenance');
  if(provenance.mode==='production')for(const key of Object.keys(RECOVERABLE_JOB_SERVICE_PRODUCTION_PROVENANCE)){const expected=RECOVERABLE_JOB_SERVICE_PRODUCTION_PROVENANCE[key as keyof typeof RECOVERABLE_JOB_SERVICE_PRODUCTION_PROVENANCE];if(JSON.stringify(provenance[key])!==JSON.stringify(expected))throw Error('Changed production scoring provenance');}

  const inputIdentity=value.inputIdentity;const actualCases:unknown[]=[];
  if(inputIdentity!==null){if(!record(inputIdentity)||Object.keys(inputIdentity).sort().join(',')!=='cases,rootCommitment,version'||inputIdentity.version!==RECOVERABLE_JOB_SERVICE_METADATA.derivationVersion||!hex(inputIdentity.rootCommitment)||!Array.isArray(inputIdentity.cases))throw Error('Invalid executed input identity');for(const c of inputIdentity.cases){if(!caseIdentity(c)||c.rootCommitment!==inputIdentity.rootCommitment||!provenance.variantIds.includes(c.variantId))throw Error('Invalid executed case identity');}if(new Set(inputIdentity.cases.map(c=>c.variantId)).size!==inputIdentity.cases.length)throw Error('Duplicate executed case identity');}else if(value.status==='valid')throw Error('Valid result lacks accepted replay identity');
  const seen=new Set<string>();for(const row of value.families){if(!record(row)||typeof row.id!=='string'||!RECOVERABLE_JOB_SERVICE_FAMILY_IDS.includes(row.id)||seen.has(row.id)||row.group!==row.id[0]||row.mandatory!==true||typeof row.passed!=='boolean'||typeof row.safetyChecked!=='boolean'||!text(row.scheduleId,256)||!text(row.reason)||!integer(row.operations)||!integer(row.promiseJobs)||!Array.isArray(row.assertions)||row.assertions.length===0||row.assertions.length>20000)throw Error('Invalid or duplicate family row');seen.add(row.id);if(!Array.isArray(row.variants))throw Error('Missing variant evidence');const expected=provenance.variantIds.filter(id=>(id as string).startsWith(row.id+'/'));if(row.variants.length!==expected.length||new Set(row.variants.map(v=>v.id)).size!==row.variants.length)throw Error('Incomplete mandatory variant evidence');for(const variant of row.variants){if(!record(variant)||!expected.includes(variant.id)||typeof variant.passed!=='boolean'||typeof variant.safetyChecked!=='boolean'||!text(variant.reason)||!integer(variant.operations)||!integer(variant.promiseJobs)||!Array.isArray(variant.assertions)||!variant.assertions.length||variant.assertions.some(a=>!record(a)||!text(a.label,1024)||typeof a.passed!=='boolean')||variant.passed&&(!variant.safetyChecked||variant.assertions.some(a=>!a.passed)))throw Error('Invalid mandatory variant result');if(variant.inputIdentity!==null){if(!caseIdentity(variant.inputIdentity)||variant.inputIdentity.variantId!==variant.id)throw Error('Invalid variant input identity');actualCases.push(variant.inputIdentity);}else if(variant.safetyChecked||variant.passed)throw Error('Executed variant lacks input identity');}if(row.passed!==(row.variants.length>0&&row.variants.every(v=>v.passed)))throw Error('Inconsistent family variant outcome');if(row.assertions.some(a=>!record(a)||!text(a.label,1024)||typeof a.passed!=='boolean'))throw Error('Invalid assertion');if(row.passed&&(!row.safetyChecked||row.assertions.some(a=>!a.passed)))throw Error('Passing family contains a failed assertion');}
  if(inputIdentity!==null&&JSON.stringify(actualCases)!==JSON.stringify(inputIdentity.cases))throw Error('Actual case identities do not match variant rows');
  let sum=0;for(const group of ['A','B','C','D','E']){const rows=value.families.filter(r=>r.group===group),passed=rows.filter(r=>r.passed).length,g=value.groups[group];if(!record(g)||g.passed!==passed||g.total!==rows.length||!near(g.coverage,passed/rows.length))throw Error('Inconsistent group score');sum+=passed/rows.length;}
  if(Object.keys(value.groups).length!==5||!near(value.macroCoverage,sum/5))throw Error('Inconsistent macro coverage');
  for(const failure of value.safetyFailures)if(!record(failure)||!text(failure.code,128)||!(failure.jobId===null||text(failure.jobId,64))||!text(failure.detail)||!seen.has(failure.familyId as string))throw Error('Invalid safety failure');
  if(value.status!=='valid'&&(!record(value.error)||!text(value.error.message)))throw Error('Invalid evaluation requires error evidence');
  const resolved=provenance.mode==='production'&&value.status==='valid'&&value.families.every(f=>f.passed)&&value.safetyFailures.length===0;if(value.resolved!==resolved)throw Error('Inconsistent binary resolved outcome');
  return {ok:true,value:value as unknown as RecoverableJobServiceDiagnostics};
 }catch(error){return {ok:false,error:error instanceof Error?error.message:'Malformed diagnostics'};}
}
export function recoverableJobServiceVerifierResult(diagnostics:RecoverableJobServiceDiagnostics){
 const parsed=parseRecoverableJobServiceDiagnostics(diagnostics);if(!parsed.ok)throw new Error(parsed.error);
 return {passed:diagnostics.resolved,score:diagnostics.resolved?1:0,summary:diagnostics.status==='valid'?(diagnostics.resolved?'Recoverable Job Service resolved':'Recoverable Job Service not resolved'):'Recoverable Job Service evaluation invalid',assertions:diagnostics.families.map(f=>({id:f.id,label:f.id+' — '+f.reason,passed:f.passed,weight:1})),recoverableJobService:diagnostics};
}
