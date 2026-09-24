/** Private qualification comparisons of actual tapes, never exported diagnostics. */
import assert from 'node:assert/strict';
import {replayInputFromRecord} from './replay.mjs';
import {canonical,jsonDigest} from './broker.mjs';
export function compareExecutedInputs(positive,other,variantId,{exact=false}={}){
 assert.ok(canonical(replayInputFromRecord(positive))===canonical(replayInputFromRecord(other)),'private roots match');
 const a=positive.cases.find(c=>c.variantId===variantId),b=other.cases.find(c=>c.variantId===variantId);assert(a&&b,'both corresponding cases actually executed');
 for(const key of ['version','rootCommitment','variantId','caseCommitment','authenticationCommitment'])assert.equal(a[key],b[key],variantId+' '+key);
 const x=positive.executedInputs.find(c=>c.variantId===variantId).events,y=other.executedInputs.find(c=>c.variantId===variantId).events;
 const xi=x.filter(e=>e.type==='id'),yi=y.filter(e=>e.type==='id');for(let n=0;n<Math.min(xi.length,yi.length);n++)assert.ok(canonical(xi[n])===canonical(yi[n]),variantId+' independently allocated concrete fixture ID '+n);
 assert.ok(canonical(x.find(e=>e.type==='grant'))===canonical(y.find(e=>e.type==='grant')),variantId+' actual initial authority authentication bytes');
 let common=0;while(common<Math.min(x.length,y.length)&&canonical(x[common])===canonical(y[common]))common++;
 assert(common>0,variantId+' common actual causal input prefix');
 if(exact)assert.ok(canonical(y)===canonical(x),variantId+' complete actual corresponding restored tape');
 return {variantId,positiveEvents:x.length,comparedEvents:y.length,commonPrefixEvents:common,sharedFixtureIds:Math.min(xi.length,yi.length),positiveRequests:x.filter(e=>e.type==='request').length,comparedRequests:y.filter(e=>e.type==='request').length,commonPrefixRequests:x.slice(0,common).filter(e=>e.type==='request').length,relation:common===x.length&&common===y.length?'exact':common===Math.min(x.length,y.length)?'causal-prefix':'candidate-dependent-continuation',firstDifference:common<Math.min(x.length,y.length)?{positiveType:x[common].type,comparedType:y[common].type,positiveEventCommitment:jsonDigest(x[common]),comparedEventCommitment:jsonDigest(y[common])}:null};
}
