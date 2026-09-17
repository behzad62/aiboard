import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const base=new URL('../',import.meta.url);
export const contractPaths=['public/contract.d.ts','public/runtime-contract.md','public/problem.md','public/acceptance-contract.md','public/families.json','public/service.js','public/examples.mjs','public/public-test.mjs','public/source-bootstrap.md','public/source-variants.json','public/source-examples.mjs'];
export const suitePaths=['private/replay.mjs','private/source-adapter.mjs','private/source-cases.mjs','private/public-controls.mjs','private/quickjs-memory-shim.mjs','private/wire-schema.mjs','private/variants.mjs','private/provenance.mjs','private/dependency-provenance.json','private/public-evaluator.mjs','private/broker.mjs','private/guest.mjs','private/oracle.mjs','private/scenarios.mjs','private/evaluator.mjs','private/runtime.mjs','private/evaluation-worker.mjs','private/response-schema.mjs','private/identity.mjs','private/verify-template.mjs'];
const hash=async paths=>{const h=createHash('sha256');for(const path of paths){h.update(path+'\0');h.update(await readFile(new URL(path,base)));h.update('\0');}return h.digest('hex');};
export async function scoreInputHashes(){return {contractHash:await hash(contractPaths),suiteHash:await hash([...contractPaths,...suitePaths])};}
