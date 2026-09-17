import {readFile} from 'node:fs/promises';
import {evaluate} from './evaluator.mjs';
const source=await readFile(new URL('./reference.js',import.meta.url),'utf8');
const result=await evaluate(source,{families:process.argv[2]?.split(','),largeCount:65,wallMs:15000,onFamily:f=>console.log(f.id,f.passed?'PASS':'FAIL',f.reason,f.operations)});
console.log(result.status,result.error??'',result.families.filter(f=>f.passed).length+'/'+result.families.length);
