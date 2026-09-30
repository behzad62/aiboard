import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createCalibrationControl} from '../benchmarks/recoverable-job-service/private/calibration/controls.mjs';
import {evaluateBounded} from '../benchmarks/recoverable-job-service/private/runtime.mjs';

const reference=await readFile('benchmarks/recoverable-job-service/private/reference.js','utf8');
const control=createCalibrationControl('truthful-outcome',reference);
const result=await evaluateBounded(control.source,{families:['B14'],variantIds:['B14/primary'],largeCount:1025});
const row=result.families[0]?.variants[0];

assert.equal(result.provenance.operations,100000,'the production broker operation limit stays fixed');
assert.equal(result.status,'valid');
assert.equal(row?.passed,true,row?.reason??'B14/primary did not execute');
assert.equal(row?.safetyChecked,true);
assert.equal(result.safetyFailures.length,0);
console.log('truthful-outcome B14/primary passes at 1025 records:',row.operations,'operations');
