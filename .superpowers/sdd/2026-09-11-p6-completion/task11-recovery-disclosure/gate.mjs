import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn, execFileSync} from 'node:child_process';
const root=process.cwd(), here=path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/,''));
const spec=JSON.parse(fs.readFileSync(process.argv[2],'utf8').replace(/^\uFEFF/,''));
if(!/^[a-z0-9_-]+$/i.test(spec.id)) throw new Error('Invalid run ID');
const dir=path.join(here,spec.id); fs.mkdirSync(dir); // Never overwrite an earlier run.
const save=(name,value)=>fs.writeFileSync(path.join(dir,name),JSON.stringify(value,null,2)+'\n');
const walk=p=>fs.readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(p+'/'+e.name):[p+'/'+e.name]);
const paths=[...new Set([...walk('runner-v2/src'),...walk('runner-v2/test'),...(spec.inputPaths??[]),...['package.json','package-lock.json','tsconfig.json','runner-v2/tsconfig.json','eslint.config.mjs','node_modules/tsx/package.json','node_modules/typescript/package.json','node_modules/eslint/package.json'].filter(p=>fs.existsSync(p)),path.relative(root,process.argv[1]),path.relative(root,process.argv[2])])].sort();
const snapshot=()=>paths.map(p=>({path:p,sha256:crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}));
const startedAt=new Date().toISOString(); const before=snapshot(); save('inputs-before.json',before);
const identity=pid=>{try{return JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',`Get-Process -Id ${pid} -ErrorAction Stop | Select-Object Id,@{Name='StartTimeUtc';Expression={$_.StartTime.ToUniversalTime().ToString('o')}},Path | ConvertTo-Json -Compress`],{encoding:'utf8'}));}catch{return {pid,unavailable:true};}};
const args=spec.args??['--import','./runner-v2/test/support/cli-root-observer.mjs','--import','tsx','--test','--test-concurrency=1','--test-reporter=tap',...(spec.pattern?['--test-name-pattern='+spec.pattern]:[]),...spec.tests];
const command=spec.executable??process.execPath;
save('wrapper.json',{pid:process.pid,identity:identity(process.pid),startedAt,root,argv:process.argv,command:[command,...args],spec});
const out=fs.openSync(path.join(dir,'stdout.log'),'wx'),err=fs.openSync(path.join(dir,'stderr.log'),'wx');
const child=spawn(command,args,{cwd:root,env:{...process.env,AIBOARD_C5_CAPTURE_ROOTS:'1',...spec.env},stdio:['ignore',out,err],windowsHide:true});
save('child.json',{pid:child.pid,identity:identity(child.pid),wrapperPid:process.pid,spawnedAt:new Date().toISOString(),command:[command,...args]});
let spawnError;
child.on('error',error=>{spawnError=String(error);});
child.on('close',(code,signal)=>{
 fs.closeSync(out);fs.closeSync(err);
 let after,hashError;try{after=snapshot();save('inputs-after.json',after);}catch(error){hashError=String(error);}
 const unchanged=JSON.stringify(before)===JSON.stringify(after);
 const text=fs.readFileSync(path.join(dir,'stdout.log'),'utf8')+'\n'+fs.readFileSync(path.join(dir,'stderr.log'),'utf8');
 const rootEvents=[...text.matchAll(/C5 CLI root: (\{[^\r\n]+\})/g)].flatMap(m=>{try{return [JSON.parse(m[1])];}catch{return [];}});
 const roots=[...new Set(rootEvents.map(e=>e.path))].map(p=>({path:p,existsAtReceipt:fs.existsSync(p)}));
 save('roots.json',{events:rootEvents,roots,note:'Existence observation only; verified ownership/cleanup is asserted by each fixture, not inferred from absence.'});
 const result={id:spec.id,startedAt,finishedAt:new Date().toISOString(),wrapperPid:process.pid,testPid:child.pid,exitCode:code,signal,spawnError,hashError,inputsUnchanged:unchanged,inputCount:paths.length,command:[command,...args],rootCount:roots.length,retainedRoots:roots.filter(r=>r.existsAtReceipt).map(r=>r.path)};
 save('terminal.json',result); console.log(JSON.stringify(result));process.exitCode=unchanged?(code??98):97;
});