import {readFile} from 'node:fs/promises';
// The WorkBench runner specializes this protected URL to the bundled evaluator.
import {runPublicExamples} from '__RJS_TRUSTED_RUNTIME_URL__';
const source=await readFile(new URL('./service.js',import.meta.url),'utf8');
const family=process.argv[2];
const result=await runPublicExamples(source,family?[family]:undefined);
for(const row of result.families)console.log(row.id+' '+(row.passed?'PASS':'FAIL')+' '+row.reason);
if(result.status!=='valid'){console.error(result.error?.message??result.status);process.exitCode=2;}
else if(result.families.some(f=>!f.passed))process.exitCode=1;
