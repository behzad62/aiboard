import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const evidence = path.join(root,'.superpowers','sdd','2026-09-11-p6-completion','task9-git-hardening');
const accepted = new Set([
  'hostile-matrix-final16-green','hostile-matrix-post-causal-green','affected-git-final2-green','git-bootstrap-safe-green',
  'integration-manager-focused-green','affected-native-acceptance','git-production-managers-external-diff-green',
  'policy-baseline-final-green','external-diff-policy-green','git-runtime-integration-green','editor-argv-green',
  'child-env-delete-green','hook-green','static-tsc-final-green','static-eslint-final-green','static-whitespace-final-green'
]);
const rows=[];
for(const ent of fs.readdirSync(evidence,{withFileTypes:true})){
  if(!ent.isDirectory()) continue;
  const terminalPath=path.join(evidence,ent.name,'terminal.json');
  if(!fs.existsSync(terminalPath)) continue;
  const t=JSON.parse(fs.readFileSync(terminalPath,'utf8'));
  const acceptedGreen=accepted.has(ent.name);
  const retained=(t.retainedRoots??[]).map(p=>({path:p,exists:fs.existsSync(p)}));
  const classification=acceptedGreen?'accepted-green':(t.exitCode===0?'non-accepted-diagnostic-or-superseded-green':'preserved-red-or-failed');
  rows.push({id:ent.name,classification,acceptedGreen,exitCode:t.exitCode,inputsUnchanged:t.inputsUnchanged,
    rootCount:t.rootCount??0,retainedRoots:retained});
}
rows.sort((a,b)=>a.id.localeCompare(b.id));
const acceptedRows=rows.filter(r=>r.acceptedGreen);
const receipt={generatedAt:new Date().toISOString(),terminalReceipts:rows.length,
  acceptedGreen:{runs:acceptedRows.length,rootCount:acceptedRows.reduce((n,r)=>n+r.rootCount,0),
    retained:acceptedRows.flatMap(r=>r.retainedRoots),allExitZero:acceptedRows.every(r=>r.exitCode===0),
    allInputsUnchanged:acceptedRows.every(r=>r.inputsUnchanged===true)},rows};
fs.writeFileSync(path.join(evidence,'resource-ledger.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify(receipt.acceptedGreen));
