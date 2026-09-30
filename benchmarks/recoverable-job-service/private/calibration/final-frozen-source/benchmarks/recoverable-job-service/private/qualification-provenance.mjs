/** Qualification evidence only; never imported by the trusted scoring runtime. */
import assert from 'node:assert/strict';
import {canonical,LIMITS} from './broker.mjs';
import {effectiveProvenance,schedulePlan,sha} from './provenance.mjs';

export function comparisonIdentity(result,observation){
 const p=result.provenance;
 assert.deepEqual(p,effectiveProvenance({mode:p.mode,seed:p.seed,variantIds:p.variantIds,wallMs:p.familyWallMs,totalWallMs:p.totalWallMs,largeCount:p.largeCount}),'actual selected-run provenance is internally consistent');
 assert(p.variantIds.includes(observation.variantId),'observed variant belongs to actual selected run');
 const row=schedulePlan(p.seed).find(v=>v.id===observation.variantId);
 assert.equal(observation.familyId,row.family);
 assert.deepEqual(observation.execution,{variant:{id:row.id,family:row.family,kind:row.kind,args:row.args},seed:p.seed,brokerSeed:'rjs-suite-1/'+row.family+'/'+p.seed,schedule:row.schedule,largeCount:p.largeCount,limits:{...LIMITS,wallMs:p.familyWallMs}},'actual Scenario inputs match selected-run provenance and canonical production schedule');
 assert.deepEqual(observation.runtime,{entryPoint:'evaluateBounded',node:'24.18.0',familyWallMs:p.familyWallMs,totalWallMs:p.totalWallMs,externalVariantAllowanceMs:250,workerResourceLimits:{maxOldGenerationSizeMb:1024,stackSizeMb:8}},'actual bounded entry point and effective limits match run provenance');
 for(const key of ['contractHash','suiteHash'])assert.match(result[key],/^[a-f0-9]{64}$/);
 const environment={contractHash:result.contractHash,suiteHash:result.suiteHash,profile:result.profile,contractVersion:result.contractVersion,suiteVersion:result.suiteVersion,execution:observation.execution,runtime:observation.runtime};
 // Keep the canonical string as well: some internal variant args contain an
 // explicit undefined member which ordinary JSON serialization would omit.
 return {comparisonHash:sha(environment),canonicalEnvironment:canonical(environment),environment};
}
