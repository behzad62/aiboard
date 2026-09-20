import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
const here=path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/,''));
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
for(const id of ['windows-affected-acceptance','linux-controller'])if(!fs.existsSync(path.join(here,id,'terminal.json')))throw new Error('Source verification is still active: '+id);
const dir=path.join(here,'causal-refresh-mutations');fs.mkdirSync(dir);
const faults=[
 {id:'current-shutdown-budget',file:'runner-v2/src/lsp-client.ts',old:'this.shutdownTimeoutMs + this.writeTimeoutMs).then',replacement:'this.shutdownTimeoutMs).then',test:'lsp-shared-client',pattern:'^LSP shared shutdown budgets response and acknowledged exit as serial bounded phases$'},
 {id:'current-chunk-limit',file:'runner-v2/src/execution-host-lsp-transport.ts',old:'const MAX_SHARED_LSP_WRITE_BYTES = 1024 * 1024;',replacement:'const MAX_SHARED_LSP_WRITE_BYTES = 4 * 1024 * 1024;',test:'lsp-transport-authority',pattern:'^LSP shared transport uses the real launching call and fresh exact language request authority$'},
 {id:'current-portable-callback',file:'runner-v2/src/portable-process-supervisor.mjs',old:'try { child.stdin.write(bytes, (error) => { pending.status = error ? "failed" : "acknowledged"; pending.settled = true; }); }',replacement:'try { child.stdin.write(bytes); pending.status = "acknowledged"; pending.settled = true; }',test:'portable-supervisor-input'},
 {id:'current-raw-launch-policy',file:'runner-v2/src/lsp-client.ts',append:'\nimport { spawn as task83ForbiddenSpawn } from "node:child_process";\nfunction task83ControlledUncalledLaunch() { return task83ForbiddenSpawn("task83-never-executed"); }\n',test:'lsp-caller-audit',pattern:'^LSP migrated family contains no direct launch signal shell or ambient environment fallback$'}
];
const results=[];
function run(fault,phase){const id=fault.id+'-'+phase,spec={id,tests:['runner-v2/test/'+fault.test+'.test.ts'],...(fault.pattern?{pattern:fault.pattern}:{})};const specPath=path.join(here,id+'.spec.json');fs.writeFileSync(specPath,JSON.stringify(spec,null,2),{flag:'wx'});const child=spawnSync(process.execPath,[path.join(here,'gate.mjs'),specPath],{encoding:'utf8',maxBuffer:1024*1024});process.stdout.write(child.stdout??'');process.stderr.write(child.stderr??'');const receipt=JSON.parse(fs.readFileSync(path.join(here,id,'terminal.json'),'utf8')),log=fs.readFileSync(path.join(here,id,'stdout.log'),'utf8');if(child.status!==receipt.exitCode||!receipt.inputsUnchanged)throw new Error('Invalid causal terminal receipt');return {id,exitCode:receipt.exitCode,sourceInputs:receipt.inputCount,retainedRoots:receipt.retainedRoots,failedTests:log.split(/\r?\n/).filter(l=>/^not ok /.test(l)),parseError:/TransformError|SyntaxError|ERR_MODULE_NOT_FOUND/.test(log)};}
for(const fault of faults){
 const original=fs.readFileSync(fault.file),text=original.toString('utf8');
 if(!fault.append&&text.split(fault.old).length!==2)throw new Error('Mutation anchor is not unique: '+fault.id);
 const mutant=Buffer.from(fault.append?text+fault.append:text.replace(fault.old,fault.replacement));
 const item={...fault,originalHash:hash(original),faultHash:hash(mutant)};
 fs.writeFileSync(path.join(dir,fault.id+'.before'),original,{flag:'wx'});
 try{fs.writeFileSync(fault.file,mutant);item.red=run(fault,'red');}finally{fs.writeFileSync(fault.file,original);item.restoredHash=hash(fs.readFileSync(fault.file));fs.writeFileSync(path.join(dir,fault.id+'.json'),JSON.stringify(item,null,2));}
 if(item.restoredHash!==item.originalHash||item.red.exitCode===0||item.red.parseError||item.red.failedTests.length===0)throw new Error('Causal fault was not behaviorally detected: '+fault.id);
 item.green=run(fault,'green');if(item.green.exitCode!==0)throw new Error('Restored source did not pass: '+fault.id);
 results.push(item);fs.writeFileSync(path.join(here,'causal-refresh-results.json'),JSON.stringify(results,null,2));
}
console.log(JSON.stringify({verifiedPairs:results.length,allRestored:results.every(r=>r.originalHash===r.restoredHash)}));
