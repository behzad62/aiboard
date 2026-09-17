import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root=process.cwd();
const evidence=path.join(root,'.superpowers','sdd','2026-09-11-p6-completion','task9-git-hardening');
const baseline=JSON.parse(fs.readFileSync(path.join(evidence,'baseline.json'),'utf8'));
const allowedExact=new Set([
  'runner-v2/src/child-environment.ts','runner-v2/src/git-command.ts','runner-v2/src/git-runtime-runner.ts',
  'runner-v2/test/child-environment.test.ts','runner-v2/test/git-runtime-runner.test.ts',
  'runner-v2/test/git-runtime-integration.test.ts','runner-v2/test/git-production-managers.test.ts',
  '.superpowers/sdd/2026-09-11-p6-completion/plan.md'
]);
const allowedPrefix='.superpowers/sdd/2026-09-11-p6-completion/task9-git-hardening/';
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const rows=[];
for(const entry of baseline.protectedFiles){
  const rel=entry.path.replaceAll('\\','/'); const abs=path.join(root,...rel.split('/'));
  const allowed=allowedExact.has(rel)||rel.startsWith(allowedPrefix);
  if(!fs.existsSync(abs)){rows.push({path:rel,status:'missing',allowed});continue;}
  const current=sha(abs); rows.push({path:rel,status:current===entry.sha256?'unchanged':(allowed?'allowed-drift':'unexpected-drift'),baseline:entry.sha256,current,allowed});
}
const receipt={generatedAt:new Date().toISOString(),baselineHead:baseline.head,baselineBranch:baseline.branch,
  protectedCount:baseline.protectedFiles.length,unchanged:rows.filter(r=>r.status==='unchanged').length,
  allowedDrift:rows.filter(r=>r.status==='allowed-drift'),unexpectedDrift:rows.filter(r=>r.status==='unexpected-drift'),
  missing:rows.filter(r=>r.status==='missing'),rows};
fs.writeFileSync(path.join(evidence,'protected-final.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({protectedCount:receipt.protectedCount,unchanged:receipt.unchanged,allowedDrift:receipt.allowedDrift.map(r=>r.path),unexpectedDrift:receipt.unexpectedDrift.map(r=>r.path),missing:receipt.missing.map(r=>r.path)}));
if(receipt.unexpectedDrift.length||receipt.missing.some(r=>!r.allowed)) process.exit(1);
