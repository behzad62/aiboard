import {readFile,writeFile} from 'node:fs/promises';
import {evaluateFileBounded,toVerifierResult} from '__RJS_TRUSTED_RUNTIME_URL__';
const diagnostics=await evaluateFileBounded(new URL('./service.js',import.meta.url));
await writeFile(new URL('./verifier-result.json',import.meta.url),JSON.stringify(toVerifierResult(diagnostics),null,2));
console.log(diagnostics.status+'; resolved='+diagnostics.resolved);
process.exitCode=diagnostics.status==='valid'?(diagnostics.resolved?0:1):2;
