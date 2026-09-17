import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Broker,CandidateError,HarnessError} from '../benchmarks/recoverable-job-service/private/broker.mjs';

assert.equal(process.versions.node,'24.18.0');
const packet='.superpowers/sdd/2026-09-08-recoverable-job-service-integration';
const rows:any[]=[];
const commit=async(b:any,writes:any[])=>{
 const result=await b.call('store.commit',{writes,audit:[],operationId:b.id(),fence:{grant:b.grant,deadline:10000}});
 assert.equal(result.kind,'applied','test fixture transaction applies');
 return result.value.payload.revision;
};
const key=(n:number)=>'rows/'+String(n).padStart(3,'0');
const value=(n:number)=>({number:n,nested:{label:'original-'+n,list:[n,n+1]}});
const expected=(from:number,to:number)=>Array.from({length:to-from},(_,i)=>{
 const n=from+i;return {key:key(n),revision:n<65?1:2,value:value(n)};
});
const test=async(name:string,run:(b:any)=>Promise<void>)=>{
 const b=new Broker('wave4-scan');
 try{await run(b);rows.push({name,passed:true,operations:b.operations});}
 catch(error){rows.push({name,passed:false,error:error instanceof Error?error.message:String(error),operations:b.operations});throw error;}
 finally{await b.shutdown();}
};

try{
 // Catches live-map pagination, in-place updates/tombstones, and skipped/de-duplicated cursors.
 await test('pinned scan preserves values, revisions and order across replacements, deletion and insertion',async b=>{
  const firstWrites=Array.from({length:65},(_,n)=>({key:key(n),expected:0,value:value(n)}));
  await commit(b,firstWrites);
  await commit(b,Array.from({length:65},(_,i)=>({key:key(i+65),expected:0,value:value(i+65)})));
  await commit(b,[{key:'other/000',expected:0,value:{outside:true}},{key:'rows/deleted',expected:0,value:null}]);
  firstWrites[0].value.nested.label='mutated commit argument';
  firstWrites[1].value.nested.list.push(999);
  const first=await b.call('store.scan',{prefix:'rows/'});
  assert.equal(first.revision,3);assert.deepEqual(first.rows,expected(0,64));assert.equal(typeof first.next,'string');
  const cursor=first.next;
  const returnedRead=await b.call('store.read',{key:key(66)});
  returnedRead.value.nested.label='mutated read';returnedRead.value.nested.list.push(999);returnedRead.revision=900;
  first.rows[0].value.nested.label='mutated page';first.rows[1].value.nested.list.push(999);
  first.rows[2].key='other/changed';first.rows[3].revision=900;first.rows.length=4;
  assert.deepEqual(await b.call('store.read',{key:key(0)}),{revision:1,value:value(0)});
  assert.deepEqual(await b.call('store.read',{key:key(1)}),{revision:1,value:value(1)});
  assert.deepEqual(await b.call('store.read',{key:key(66)}),{revision:2,value:value(66)});
  const replacement={number:6400,nested:{label:'replacement',list:[6400]}};
  await commit(b,[{key:key(1),expected:1,value:{replaced:true}},{key:key(64),expected:1,value:replacement},
   {key:key(65),expected:2,value:null},{key:'rows/063a',expected:0,value:{inserted:'middle'}},
   {key:key(130),expected:0,value:{inserted:'last'}}]);
  replacement.nested.label='mutated replacement argument';
  const second=await b.call('store.scan',{prefix:'rows/',cursor});
  assert.equal(second.revision,3);assert.deepEqual(second.rows,expected(64,128));assert.equal(typeof second.next,'string');
  const continuation=second.next;
  assert.deepEqual(await b.call('store.scan',{prefix:'rows/',cursor}),second,'continuation is repeatable');
  second.rows[0].value.nested.label='mutated continuation';second.rows[2].value.nested.list.push(999);
  second.rows[3].revision=900;second.rows.splice(4,1);
  const repeated=await b.call('store.scan',{prefix:'rows/',cursor});
  assert.equal(repeated.revision,3);assert.deepEqual(repeated.rows,expected(64,128));assert.equal(repeated.next,continuation);
  const third=await b.call('store.scan',{prefix:'rows/',cursor:continuation});
  assert.deepEqual(third,{revision:3,rows:expected(128,130)});
  third.rows[0].value.nested.list.push(999);
  assert.deepEqual(await b.call('store.scan',{prefix:'rows/',cursor:continuation}),{revision:3,rows:expected(128,130)});
  assert.deepEqual(await b.call('store.read',{key:key(64)}),{revision:4,value:{number:6400,nested:{label:'replacement',list:[6400]}}});
  assert.deepEqual(await b.call('store.read',{key:key(65)}),{revision:4,value:null});
  assert.deepEqual(await b.call('store.read',{key:key(66)}),{revision:2,value:value(66)});
  const fresh:any[]=[];let next:string|undefined;
  do{const page=await b.call('store.scan',{prefix:'rows/',...(next?{cursor:next}:{})});assert.equal(page.revision,4);fresh.push(...page.rows);next=page.next;}while(next);
  assert.equal(fresh.length,131);
  assert.deepEqual(fresh.map(r=>r.key),[...Array.from({length:64},(_,n)=>key(n)),'rows/063a',key(64),...Array.from({length:65},(_,i)=>key(i+66))]);
  assert.deepEqual(fresh.find(r=>r.key===key(64)),{key:key(64),revision:4,value:{number:6400,nested:{label:'replacement',list:[6400]}}});
  assert.deepEqual(fresh.find(r=>r.key==='rows/063a'),{key:'rows/063a',revision:4,value:{inserted:'middle'}});
 });
 // Catches aliasing between an already pinned page and writes before its response settles.
 await test('held first page remains pinned while its records are replaced and deleted',async b=>{
  await commit(b,[{key:'rows/a',expected:0,value:{nested:{value:'old-a'}}},{key:'rows/b',expected:0,value:{nested:{value:'old-b'}}}]);
  let heldId:string='';let announce!:()=>void;const held=new Promise<void>(resolve=>announce=resolve);
  b.fault('store.scan.after','hold',{onHold:(id:string)=>{heldId=id;announce();}});
  const pending=b.call('store.scan',{prefix:'rows/'});await held;
  await commit(b,[{key:'rows/a',expected:1,value:{nested:{value:'new-a'}}},{key:'rows/b',expected:1,value:null},{key:'rows/c',expected:0,value:{nested:{value:'new-c'}}}]);
  b.resume(heldId);
  assert.deepEqual(await pending,{revision:1,rows:[{key:'rows/a',revision:1,value:{nested:{value:'old-a'}}},{key:'rows/b',revision:1,value:{nested:{value:'old-b'}}}]});
  assert.deepEqual(await b.call('store.scan',{prefix:'rows/'}),{revision:2,rows:[{key:'rows/a',revision:2,value:{nested:{value:'new-a'}}},{key:'rows/c',revision:2,value:{nested:{value:'new-c'}}}]});
 });
 // Catches loss of cursor scope/identity validation. Store revision changes do not expire a snapshot.
 await test('malformed, wrong-prefix, foreign and reopened-store cursors reject without consuming the valid cursor',async b=>{
  await commit(b,Array.from({length:65},(_,n)=>({key:key(n),expected:0,value:n})));
  const first=await b.call('store.scan',{prefix:'rows/'}),cursor=first.next,snapshotId=cursor.split(':')[0];
  const rejection=(args:any)=>assert.rejects(b.call('store.scan',args),(e:any)=>e instanceof CandidateError&&e.message==='invalid scan cursor');
  await rejection({prefix:'other/',cursor});
  for(const malformed of ['missing',snapshotId+':-1',snapshotId+':1.5',snapshotId+':NaN',snapshotId+':9007199254740992'])await rejection({prefix:'rows/',cursor:malformed});
  const foreign=new Broker('wave4-foreign');
  try{
   await commit(foreign,Array.from({length:65},(_,n)=>({key:key(n),expected:0,value:n})));
   const foreignCursor=(await foreign.call('store.scan',{prefix:'rows/'})).next;
   await rejection({prefix:'rows/',cursor:foreignCursor});
   await assert.rejects(foreign.call('store.scan',{prefix:'rows/',cursor}),(e:any)=>e instanceof CandidateError&&e.message==='invalid scan cursor');
  }finally{await foreign.shutdown();}
  const reopened=new Broker('wave4-scan');
  try{await assert.rejects(reopened.call('store.scan',{prefix:'rows/',cursor}),(e:any)=>e instanceof CandidateError&&e.message==='invalid scan cursor');}finally{await reopened.shutdown();}
  await commit(b,[{key:key(64),expected:1,value:6400}]);
  assert.deepEqual(await b.call('store.scan',{prefix:'rows/',cursor}),{revision:1,rows:[{key:key(64),revision:1,value:64}]});
  assert.deepEqual(await b.call('store.scan',{prefix:'rows/',cursor}),{revision:1,rows:[{key:key(64),revision:1,value:64}]});
  await b.shutdown();await assert.rejects(b.call('store.scan',{prefix:'rows/',cursor}),HarnessError);
 });
 console.log('Real Broker scan snapshot isolation, returned-value isolation and cursor boundaries: '+rows.length+'/'+rows.length+' pass.');
}finally{
 const source=await readFile('benchmarks/recoverable-job-service/private/broker.mjs');
 await writeFile(packet+'/task-2-wave4-scan-'+new Date().toISOString().replaceAll(':','-')+'.json',JSON.stringify({node:process.versions.node,brokerHash:createHash('sha256').update(source).digest('hex'),rows},null,2)+'\n');
}
