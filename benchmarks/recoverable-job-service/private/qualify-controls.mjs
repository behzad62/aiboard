import {readFile} from 'node:fs/promises';
import {evaluate} from './evaluator.mjs';
import {controls,familyControl} from './controls.mjs';
const source=await readFile(new URL('./reference.js',import.meta.url),'utf8');let failed=0;
for(const [id,name]of Object.entries(familyControl)){if(process.argv[2]&&!process.argv[2].split(',').includes(id))continue;const r=await evaluate(controls[name].mutate(source),{families:[id],variantIds:[id+'/primary'],largeCount:65,wallMs:2000});const caught=r.status==='valid'&&!r.families[0].passed&&!/Invalid public response/.test(r.families[0].reason);if(!caught)failed++;console.log(id,caught?'KILLED':'SURVIVED/INVALID',name,r.families[0].reason,r.error?.message??'');}
if(failed)process.exitCode=1;
