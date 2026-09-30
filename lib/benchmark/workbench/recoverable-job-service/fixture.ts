import {RECOVERABLE_JOB_SERVICE_PUBLIC_FILES,RECOVERABLE_JOB_SERVICE_INPUT_HASHES,RECOVERABLE_JOB_SERVICE_FAMILIES,RECOVERABLE_JOB_SERVICE_METADATA,RECOVERABLE_JOB_SERVICE_PRODUCTION_PROVENANCE} from './assets.generated';
export {RECOVERABLE_JOB_SERVICE_PUBLIC_FILES,RECOVERABLE_JOB_SERVICE_INPUT_HASHES,RECOVERABLE_JOB_SERVICE_FAMILIES,RECOVERABLE_JOB_SERVICE_METADATA,RECOVERABLE_JOB_SERVICE_PRODUCTION_PROVENANCE};
export const RECOVERABLE_JOB_SERVICE_PACK_ID='workbench-recoverable-job-service-v1';
export const RECOVERABLE_JOB_SERVICE_CASE_ID='workbench-recoverable-job-service-0001';
export const RECOVERABLE_JOB_SERVICE_PROFILE=RECOVERABLE_JOB_SERVICE_METADATA.profile;
export const RECOVERABLE_JOB_SERVICE_CONTRACT_VERSION=RECOVERABLE_JOB_SERVICE_METADATA.contractVersion;
export const RECOVERABLE_JOB_SERVICE_SUITE_VERSION=RECOVERABLE_JOB_SERVICE_METADATA.suiteVersion;
export const RECOVERABLE_JOB_SERVICE_EDITABLE_FILES=['service.js'] as const;
export const RECOVERABLE_JOB_SERVICE_HIDDEN_FILES=['verify.mjs','case-meta.json','package.json'] as const;
export const RECOVERABLE_JOB_SERVICE_PROTECTED_FILES=[...Object.keys(RECOVERABLE_JOB_SERVICE_PUBLIC_FILES).filter(name=>name!=='service.js'),'case-meta.json','package.json'] as const;
export const RECOVERABLE_JOB_SERVICE_PUBLIC_COMMAND='node public-test.mjs';
export const RECOVERABLE_JOB_SERVICE_PUBLIC_SOURCE_RECIPE_IDS=[
 'B17/source-zero','B17/source-stdout','B17/source-stderr','B17/source-both','B17/source-tail',
 'B17/source-pending','B17/source-unknown','B17/source-missing-old','B17/source-changed-ack',
] as const;
export const RECOVERABLE_JOB_SERVICE_PUBLIC_RECIPE_IDS=[
 ...RECOVERABLE_JOB_SERVICE_FAMILIES.map(family=>family.id),
 ...RECOVERABLE_JOB_SERVICE_PUBLIC_SOURCE_RECIPE_IDS,
] as const;
export const RECOVERABLE_JOB_SERVICE_PUBLIC_COMMANDS=[
 RECOVERABLE_JOB_SERVICE_PUBLIC_COMMAND,
 ...RECOVERABLE_JOB_SERVICE_PUBLIC_RECIPE_IDS.map(id=>`${RECOVERABLE_JOB_SERVICE_PUBLIC_COMMAND} ${id}`),
] as const;
export const RECOVERABLE_JOB_SERVICE_VERIFY_COMMAND='node verify.mjs';
export const RECOVERABLE_JOB_SERVICE_RUNTIME_MODULE='benchmarks/recoverable-job-service/private/runtime.mjs';
/** Browser safe: candidate fixture contains public contract/starter/example wrapper, never controls or oracle source. */
export function createRecoverableJobServiceFixture(runtimeModuleUrl?:string):Record<string,string>{
 const files:Record<string,string>={...RECOVERABLE_JOB_SERVICE_PUBLIC_FILES};
 if(runtimeModuleUrl){if(!runtimeModuleUrl.startsWith('file:'))throw new Error('Trusted evaluator must be a local file URL');for(const path of ['public-test.mjs','verify.mjs'])files[path]=files[path].replace('__RJS_TRUSTED_RUNTIME_URL__',runtimeModuleUrl);}
 files['package.json']=JSON.stringify({name:'recoverable-job-service-candidate',version:'1.0.0',private:true,type:'module',scripts:{test:RECOVERABLE_JOB_SERVICE_PUBLIC_COMMAND}},null,2)+'\n';
 files['case-meta.json']=JSON.stringify({benchmark:'recoverable-job-service',profile:RECOVERABLE_JOB_SERVICE_PROFILE,contractVersion:RECOVERABLE_JOB_SERVICE_CONTRACT_VERSION,suiteVersion:RECOVERABLE_JOB_SERVICE_SUITE_VERSION,...RECOVERABLE_JOB_SERVICE_INPUT_HASHES},null,2)+'\n';
 return files;
}
