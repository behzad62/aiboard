import {readFile} from 'node:fs/promises';
import {runPublicExamples} from './private/runtime.mjs';
const path=process.argv[2]??new URL('./public/service.js',import.meta.url);
const result=await runPublicExamples(await readFile(path,'utf8'),process.argv[3]?[process.argv[3]]:undefined);
for(const family of result.families)console.log(family.id+' '+(family.passed?'PASS':'FAIL')+' '+family.reason);
process.exitCode=result.status!=='valid'?2:result.families.every(f=>f.passed)?0:1;
