import assert from 'node:assert/strict';
import {Broker,HarnessError} from '../benchmarks/recoverable-job-service/private/broker.mjs';
import {sourceControls} from '../benchmarks/recoverable-job-service/private/public-controls.mjs';
const b=new Broker(),control=sourceControls(b,async()=>({kind:'ok',value:null}),async()=>{});
for(const args of [{method:'driver.receipt.before',action:'throw',value:null},{method:'driver.start.before',action:'unknown'},{method:'driver.start.after',action:'unknown',hideReceipt:true},{method:'source-observation.claim',action:'claim',claim:'invent-history'},{method:'driver.start.after',action:'unknown',occurrence:0}])await assert.rejects(()=>control('fault',args),HarnessError);
assert.equal(await control('fault',{method:'driver.start.after',action:'unknown'}),null);
await assert.rejects(()=>control('sourceState',{sourceId:b.id(),extra:true}),HarnessError);
console.log('Closed public fault/controller grammar rejects illegal fault surfaces and preserves documented defaults.');
