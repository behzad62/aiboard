import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {variants} from '../benchmarks/recoverable-job-service/private/variants.mjs';
import {materialControl} from '../benchmarks/recoverable-job-service/private/qualification-map.mjs';
import {sourceExpectedAssertion} from '../benchmarks/recoverable-job-service/private/source-controls.mjs';
import {scoreInputHashes} from '../benchmarks/recoverable-job-service/private/identity.mjs';
import {categoryNeighborIds,authorityNeighborIds} from '../benchmarks/recoverable-job-service/private/calibration/forbidden-neighbors.mjs';

const base='benchmarks/recoverable-job-service/private/calibration';
const read=async(path:string)=>JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));
const hash=async(path:string)=>createHash('sha256').update(await readFile(path)).digest('hex');
const ledgerPath=base+'/predicate-dependency-ledger-final.json';
const ledger=await read(ledgerPath),controls=await read(base+'/complete-controls/manifest.json');
const expected=await read('benchmarks/recoverable-job-service/private/control-expectations.json');
const packet='.superpowers/sdd/2026-09-08-recoverable-job-service-integration';
const helperReceiptPath=base+'/source-helper-evidence.json';
const oldCommands=packet+'/task-2-reader-wave5-focused-command-results.json',oldLog=packet+'/task-2-reader-wave5-private-logs/reader-attachment-20260912T143027688Z.log';
assert.equal(await hash(oldCommands),'5cce62e38f7b5d8e08f82599739d8a6190288bc026635919a6f319939efec26f');
assert.equal(await hash(oldLog),'e4b099fbd9efb6b4acce81e2fc4fbaa0edf944a77ad03206f899e230a0cd0f16');
const readerCommand=(await read(oldCommands)).find((r:any)=>r.command==='node --import tsx scripts/test-recoverable-job-service-reader-attachment.mts');
assert.equal(readerCommand.exitCode,0);
const delayedPath=base+'/delayed-source-ack-command-result.json',delayed=await read(delayedPath);assert.equal(delayed.exitCode,0);
const producer=await read(packet+'/task-2-integration-assertion-source-freeze-reviewed.json');
const helperSources=['scripts/test-recoverable-job-service-reader-attachment.mts','scripts/test-recoverable-job-service-delayed-source-ack.mts','benchmarks/recoverable-job-service/private/broker.mjs','benchmarks/recoverable-job-service/private/source-adapter.mjs','benchmarks/recoverable-job-service/private/replay.mjs','benchmarks/recoverable-job-service/private/wire-schema.mjs'];
const helperIdentities=[];
for(const path of helperSources){const sha256=await hash(path),old=producer.files.find((f:any)=>f.path===path);if(old)assert.equal(sha256,old.sha256,path+' unchanged raw helper dependency');helperIdentities.push({path,sha256,producerRecorded:!!old});}
await writeFile(helperReceiptPath,JSON.stringify({schemaVersion:1,purpose:'Reuse actual accepted reader runtime; one fresh delayed-ACK run because prior captured log was not readily located',
 sourceClosure:helperIdentities,reader:{command:readerCommand,commands:{path:oldCommands,sha256:await hash(oldCommands)},log:{path:oldLog,sha256:await hash(oldLog)},sourceReview:packet+'/task-2-reader-wave5-source-review.md',rerun:false},
 delayed:{command:delayed,commandFile:{path:delayedPath,sha256:await hash(delayedPath)},log:{path:delayed.log,sha256:await hash(delayed.log)},rerun:true},
 scope:'These raw broker/source helpers do not use the changed C09 predicate or public version strings. This receipt preserves their own runtime identity; it is not final full-suite qualification.'},null,2)+'\n');
const configuration:Record<string,any>={
 'P01-zero-prefix':{control:'algorithm',supplements:['actual prefix adoption during successful start versus later cleanup','zero-origin, never-created, pristine and preserved adopted source proof','healthy retained/buffered suffix has exact bytes and counters']},
 'P02-source-freshness':{control:'algorithm',supplements:['held stale source publication and new explicit observation retry'],trustedHelperEvidence:[
  {path:'scripts/test-recoverable-job-service-reader-attachment.mts',fact:'current versus superseded attachment and observation receipt; old replay does not reinstall; zero source/client/ACK effects'},
  {path:'scripts/test-recoverable-job-service-delayed-source-ack.mts',fact:'real delayed ACK begin/completion advances revision without ABA; stale publication refuses busy'},
 ]},
 'P03-source-obligations':{control:'truthful-outcome',supplements:['pending exact source ACK returns pending after its obligation is durable','unknown source/client retains exact operation ID','before close, actual recover may return a truthful aggregate view with unresolved per-job obligations; close still refuses']},
 'P04-setup-attachment':{control:'algorithm',supplements:['deferred versus setup reader effect, exact reconciliation receipt and detach','expired/reserve actual forbidden attachment controls from the scoped correction freeze'],reusedEvidence:[base+'/correction-proof-2026-09-12T17-06-54-031Z/summary.json',base+'/correction-proof-2026-09-12T17-14-13-149Z/summary.json']},
 'P05-frame-category':{control:'truthful-outcome',supplements:['real range failure chooses integrity; reference chooses gap','actual non-range corruption leaves seq/offset/length unchanged','wrong backend/input/gap neighbors rejected through Scenario.refuse'],forbiddenNeighbors:{codes:['backend','input'],variantIds:categoryNeighborIds},reusedEvidence:[base+'/correction-proof-2026-09-12T17-06-54-031Z/summary.json']},
 'P06-authority-deadline':{control:'truthful-outcome',supplements:['after real takeover plus expired request, reference observes stale and alternate first observes deadline; zero effects/publication','wrong cleanup category for changed authority rejected'],forbiddenNeighbors:{codes:['cleanup'],variantIds:authorityNeighborIds}},
 'P07-owned-accounting':{control:'algorithm',largeCount:1100,heavyWindow:true,supplements:['full 1100-job capacity on maintained index with exact all-owned snapshot/revision accounting','first-page-only index neighbor fails actual B14 all-owned predicate; restored control passes','raw broker 64-row immutable cursor contract unchanged']},
 'P08-reclamation':{control:'algorithm',supplements:['E08 has three actual adopted roots; descending root order and first actual removal then falsy failure','C18 exercises actual absent root idempotence','after E08, an actual retry accounts for the now-absent root and removes only remaining scratch roots','protected retained/foreign/aliased roots and lying partial-result neighbor rejected']},
};
const classes=[];
for(const probe of ledger.probeClasses){
 const config=configuration[probe.id];assert(config);
 const mapped=probe.variants.map((id:string)=>{const v=variants.find((v:any)=>v.id===id);assert(v);return {variantId:id,
  positiveSources:['reference',config.control],material:{selector:materialControl(v),expectedAssertion:expected[id]?.expectedReasonPrefix??sourceExpectedAssertion(v)},restoredSource:config.control};});
 for(const helper of config.trustedHelperEvidence??[])helper.sha256=await hash(helper.path);
 for(const path of config.reusedEvidence??[])assert(await hash(path));
 classes.push({...probe,...config,predicates:mapped,executionStatus:'pending final executable probe evidence'});
}
assert.equal(classes.length,8);
const plan={schemaVersion:1,method:'rjs-simplification-audit-1',status:'finite witness mapping frozen; execution and independent acceptance pending',
 scorerIdentity:await scoreInputHashes(),ledger:{path:ledgerPath,sha256:await hash(ledgerPath)},
 controlManifest:{path:base+'/complete-controls/manifest.json',sha256:await hash(base+'/complete-controls/manifest.json')},controls:controls.controls,
 helperRuntimeEvidence:{path:helperReceiptPath,sha256:await hash(helperReceiptPath)},
 classCount:classes.length,classes,
 fullQualification:{reference:{positive:302,material:302,restored:302,groups:61},completeControls:controls.controls.map((c:any)=>({id:c.id,positive:302})),publicRecipes:78,capacity:1100},
 alternateMaterialScope:{rule:'Execute every named probe-row material and restored contrast on its changed complete control. Reuse the full unchanged reference material qualification for the remaining rows only where its predicate/fault semantics commute with the documented control transformation; source review must approve each mapping.',
  representationExtraVariants:['C01/primary','C03/primary','C04/primary','C06/primary','C09/restore-store.commit.before','C09/restore-store.commit.after','C17/primary','C18/primary','E08/primary'],
  representationRationale:'Namespace/envelope mapping is bijective for private keys/values and preserves CAS revisions/audits; verify concrete artifact-name/layout, missing-byte, metadata-budget and protected-root predicates additionally.',
  algorithmRationale:'Every mapped row exercises the actual staged marker/index/setup reader/reclamation seam; truncate-scan preserves its selector but deliberately limits the maintained index to one page.',
  outcomeRationale:'Alternatives are chosen at their actual validation/admission/obligation branches with matching durable facts. No arbitrary successful or tag-only response is a positive control.'},
 isolation:'The independent public-only candidate remains excluded; controls are reference-derived private qualification inputs, not participant submissions.'};
const path=base+'/probe-plan-final.json';await writeFile(path,JSON.stringify(plan,null,2)+'\n');
console.log(JSON.stringify({path,sha256:await hash(path),classes:classes.length,controls:controls.controls.map((c:any)=>({id:c.id,sha256:c.sha256})),status:plan.status},null,2));
