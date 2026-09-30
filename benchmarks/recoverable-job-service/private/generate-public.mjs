import {readFile,writeFile} from 'node:fs/promises';
const acceptance=await readFile('docs/benchmarks/recoverable-job-service/acceptance-contract.md','utf8');
const families=[...acceptance.matchAll(/\| <a id="([a-e]\d\d)"><\/a>([A-E]\d\d) \/ ([^|]+)\| ([^|]+)\|/g)].map(m=>({id:m[2],group:m[2][0],requirement:m[3].trim(),expectation:m[4].trim(),mandatory:true,contract:'acceptance-contract.md#'+m[1]}));
if(families.length!==69)throw Error('69 public rows required');
await writeFile('benchmarks/recoverable-job-service/public/families.json',JSON.stringify(families,null,2)+'\n');
await writeFile('benchmarks/recoverable-job-service/public/acceptance-contract.md',acceptance);
await writeFile('benchmarks/recoverable-job-service/public/problem.md',await readFile('docs/benchmarks/recoverable-job-service/problem.md'));
