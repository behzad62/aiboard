import fs from 'node:fs';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
const out='.superpowers/sdd/2026-09-11-p6-completion/task8-3-lsp/acceptance-final-20260913';
const file='runner-v2/test/support/linked-output-spill-storage.ts',hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const green=JSON.parse(fs.readFileSync(out+'/linux-linked-regression-green-controller/terminal.json','utf8'));
if(green.exitCode!==0||!green.inputsUnchanged)throw new Error('Missing unchanged green prerequisite');
const original=fs.readFileSync(file),fault=fs.readFileSync(out+'/linked-fixture-change/before/'+file);
const result={startedAt:new Date().toISOString(),file,originalHash:hash(original),faultHash:hash(fault)};
try {
 fs.writeFileSync(file,fault);
 const child=spawnSync(process.execPath,[out+'/gate.mjs',out+'/linux-linked-regression-reverse-red-controller.spec.json'],{encoding:'utf8',maxBuffer:1024*1024});
 process.stdout.write(child.stdout??'');process.stderr.write(child.stderr??'');
 const receipt=JSON.parse(fs.readFileSync(out+'/linux-linked-regression-reverse-red/terminal.json','utf8'));
 const log=fs.readFileSync(out+'/linux-linked-regression-reverse-red/test.stdout.log','utf8');
 result.exitCode=receipt.exitCode;result.behavioralRed=receipt.exitCode===1&&receipt.inputsUnchanged&&/^# fail 2$/m.test(log)&&/ENOENT.*lstat/.test(log)&&!/TransformError|SyntaxError|ERR_MODULE_NOT_FOUND/.test(log);
 if(!result.behavioralRed)throw new Error('Linked fixture fault was not causally detected');
} finally {
 fs.writeFileSync(file,original);result.restoredHash=hash(fs.readFileSync(file));result.finishedAt=new Date().toISOString();
 fs.writeFileSync(out+'/linked-fixture-reverse-result.json',JSON.stringify(result,null,2),{flag:'wx'});
}
if(result.restoredHash!==result.originalHash)throw new Error('Source restoration failed');
console.log(JSON.stringify(result));
