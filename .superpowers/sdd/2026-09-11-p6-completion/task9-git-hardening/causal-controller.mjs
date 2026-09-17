import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
const decodeArg=value=>value?.startsWith('b64:')?Buffer.from(value.slice(4),'base64').toString('utf8'):value;
const [id,pattern,sentinel,expected,...replacementArgs]=process.argv.slice(2).map(decodeArg);
if(!id||!pattern||!sentinel||expected===undefined||replacementArgs.length===0||replacementArgs.length%2) throw new Error('usage: id pattern sentinel expected old new [old new...]');
const root=process.cwd();
const evidence=path.join(root,'.superpowers','sdd','2026-09-11-p6-completion','task9-git-hardening');
const source=path.join(root,'runner-v2','src','git-execution-policy.ts');
const original=fs.readFileSync(source);
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const beforeHash=hash(original);
let mutated=original.toString('utf8');
const replacements=[];
for(let i=0;i<replacementArgs.length;i+=2){
  const oldValue=replacementArgs[i], newValue=replacementArgs[i+1];
  const count=mutated.split(oldValue).length-1;
  if(count!==1) throw new Error(`mutation ${i/2} expected one occurrence, got ${count}: ${JSON.stringify(oldValue)}`);
  mutated=mutated.replace(oldValue,newValue);
  replacements.push({oldValue,newValue});
}
const specPath=path.join(evidence,`${id}.spec.json`);
fs.writeFileSync(specPath,JSON.stringify({id,tests:['runner-v2/test/git-indirect-execution-policy.test.ts'],pattern},null,2)+'\n');
let childExit=null, controllerError=null, terminal=null, sentinelProof=null;
try{
  fs.writeFileSync(source,mutated);
  const child=spawn(process.execPath,[path.join(evidence,'gate.mjs'),specPath],{cwd:root,stdio:'inherit',windowsHide:true});
  childExit=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>resolve(code));});
  const terminalPath=path.join(evidence,id,'terminal.json');
  if(fs.existsSync(terminalPath)) terminal=JSON.parse(fs.readFileSync(terminalPath,'utf8'));
  const roots=terminal?.retainedRoots??[];
  const matches=[];
  for(const retained of roots){
    const candidate=path.join(retained,sentinel);
    if(fs.existsSync(candidate)) matches.push({path:candidate,content:fs.readFileSync(candidate,'utf8').trim()});
  }
  sentinelProof={matches};
  if(childExit!==1) throw new Error(`expected hostile RED exit 1, got ${childExit}`);
  if(!terminal?.inputsUnchanged) throw new Error('gate inputs changed during hostile RED');
  if(matches.length===0) throw new Error(`sentinel ${sentinel} did not appear in retained RED roots`);
  if(!matches.some(m=>m.content===expected)) throw new Error(`sentinel content mismatch: ${JSON.stringify(matches)}`);
}catch(error){controllerError=String(error?.stack??error);}
finally{
  fs.writeFileSync(source,original);
}
const after=fs.readFileSync(source); const afterHash=hash(after);
const receipt={id,pattern,sentinel,expected,beforeHash,afterHash,restoredExact:beforeHash===afterHash,mutatedHash:hash(Buffer.from(mutated)),replacements,childExit,terminal,sentinelProof,controllerError,finishedAt:new Date().toISOString()};
fs.writeFileSync(path.join(evidence,`${id}-controller.json`),JSON.stringify(receipt,null,2)+'\n');
if(controllerError||beforeHash!==afterHash){console.error(JSON.stringify(receipt));process.exit(1);} console.log(JSON.stringify({id,childExit,beforeHash,afterHash,sentinelProof}));
