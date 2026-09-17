import {evaluatePublic} from './public-evaluator.mjs';
import {parentPort,workerData} from 'node:worker_threads';
import {evaluate} from './evaluator.mjs';
try {const value=await (workerData.options.publicExamples?evaluatePublic:evaluate)(workerData.source,{...workerData.options,onCaseInput:value=>parentPort.postMessage({type:'private-case-input',value}),onFamilyStart:id=>parentPort.postMessage({type:'family-start',id}),onVariantStart:value=>parentPort.postMessage({type:'variant-start',value}),onVariant:value=>parentPort.postMessage({type:'variant',value}),onFamily:value=>parentPort.postMessage({type:'family',value})});parentPort.postMessage({type:'result',value});}catch(error){parentPort.postMessage({type:'error',message:error?.stack??String(error)});}finally{parentPort.close();}
