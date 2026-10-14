'use strict';
// One diagnostic invocation of the unchanged owning script entrypoint. Raw
// stdout/stderr go directly to exclusive files; no watchdog or rescue action.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const repository = path.resolve(__dirname, '..', '..');
const output = path.join(repository, 'benchmark-startup-diagnostic-results');
const bindings = JSON.parse(fs.readFileSync(path.join(__dirname, 'benchmark-startup-diagnostic-bindings.json'), 'utf8'));
if (process.version !== 'v24.18.0' || bindings.nodeVersion !== process.version || bindings.baseCommit !== '361be91bf0687c0111cf8c37b249dbf0953c7f3c') throw Error('Diagnostic runtime/base binding mismatch');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const receipts = [];
for (const pin of bindings.files) {
  if (!/^(?:scripts\/|package(?:-lock)?\.json$|public\/)/.test(pin.path) || pin.path.split('/').includes('..')) throw Error('Invalid diagnostic input pin');
  const bytes = fs.readFileSync(path.join(repository, ...pin.path.split('/')));
  const canonicalBytes = pin.canonicalText ? Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n')) : bytes;
  const actual = sha(canonicalBytes);
  if (actual !== pin.canonicalSha256) throw Error('Diagnostic input binding mismatch');
  receipts.push({ path: pin.path, bytes: bytes.length, rawSha256: sha(bytes), canonicalSha256: actual });
}
fs.mkdirSync(output);
fs.writeFileSync(path.join(output, 'input-bindings.json'), JSON.stringify({ schema: 1,
  qualification: 'UNQUALIFIED_DIAGNOSTIC', baseCommit: bindings.baseCommit,
  checkoutRevision: process.env.GITHUB_SHA ?? null, nodeVersion: process.version, files: receipts }) + '\n', { flag: 'wx' });
const stdoutFd = fs.openSync(path.join(output, 'stdout.log'), 'wx');
const stderrFd = fs.openSync(path.join(output, 'stderr.log'), 'wx');
const start = process.hrtime.bigint();
const record = { schema: 1, qualification: 'UNQUALIFIED_DIAGNOSTIC', command: 'original-workbench-runner-bundle-once',
  attempts: 1, exitObserved: false, exitCode: null, exitSignal: null,
  closeObserved: false, closeCode: null, closeSignal: null, launchError: false,
  launchErrorCode: null, capturePresent: false, captureComplete: false, captureError: false, elapsedMs: null };
const knownSignals = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV', 'SIGHUP', 'SIGBREAK']);
const safeSignal = (value) => value === null ? null : knownSignals.has(value) ? value : 'unknown';
const safeCode = (value) => Number.isInteger(value) ? value : null;
const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/test-workbench-runner-bundle.tsx'], {
  cwd: repository, stdio: ['ignore', stdoutFd, stderrFd],
  env: { ...process.env, RUNNER_V2_BENCHMARK_STARTUP_DIAGNOSTIC_FILE: path.join(output, 'health.json') },
});
child.once('error', (error) => {
  record.launchError = true;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  record.launchErrorCode = descriptor && ['ENOENT', 'EACCES', 'EPERM', 'EINVAL'].includes(descriptor.value) ? descriptor.value : 'unknown';
});
child.once('exit', (code, signal) => { record.exitObserved = true; record.exitCode = safeCode(code); record.exitSignal = safeSignal(signal); });
child.once('close', (code, signal) => {
  record.closeObserved = true; record.closeCode = safeCode(code); record.closeSignal = safeSignal(signal);
  record.elapsedMs = Number(process.hrtime.bigint() - start) / 1000000;
  try { fs.closeSync(stdoutFd); } catch { record.captureError = true; }
  try { fs.closeSync(stderrFd); } catch { record.captureError = true; }
  try {
    const capture = JSON.parse(fs.readFileSync(path.join(output, 'health.json'), 'utf8'));
    record.capturePresent = capture.schema === 1 && capture.qualification === 'UNQUALIFIED_DIAGNOSTIC';
    const events = Array.isArray(capture.events) ? capture.events : [];
    const attempts = events.filter((entry) => entry.kind === 'fetch_enter');
    const terminalKinds = events.filter((entry) => entry.kind === 'loop_exit');
    record.captureComplete = record.capturePresent && capture.complete === true &&
      capture.role === 'extracted-bench-health-parent' && Number.isInteger(capture.selectedPort) &&
      capture.selectedPort >= 40000 && capture.selectedPort <= 49999 &&
      capture.preCleanup !== null && typeof capture.preCleanup === 'object' &&
      capture.afterStop !== null && typeof capture.afterStop === 'object' &&
      ['returned', 'threw'].includes(capture.rootCleanup) && capture.droppedEvents === 0 && capture.observationFailures === 0 &&
      capture.stdout?.scanTruncated === false && capture.stderr?.scanTruncated === false &&
      attempts.length >= 1 && attempts.length <= 80 && attempts.every((entry, index) => entry.attempt === index) &&
      events.filter((entry) => entry.kind === 'child_returned_from_spawn').length === 1 &&
      events.filter((entry) => entry.kind === 'original_stop_enter').length === 1 &&
      events.filter((entry) => entry.kind === 'original_stop_settled').length === 1 && terminalKinds.length === 1 &&
      (terminalKinds[0].reason !== 'health_decoded' || events.filter((entry) => entry.kind === 'json_decoded').length === 1) &&
      (terminalKinds[0].reason !== 'exhausted' || attempts.length === 80) &&
      ['health_decoded', 'exhausted', 'child_exit'].includes(terminalKinds[0].reason);
  } catch { record.captureError = true; }
  try { fs.writeFileSync(path.join(output, 'terminal.json'), JSON.stringify(record) + '\n', { flag: 'wx' }); }
  catch { record.captureError = true; }
  const nativeFailure = record.exitCode !== 0 || record.closeCode !== 0 || record.exitSignal !== null || record.closeSignal !== null || record.launchError;
  process.exitCode = nativeFailure || !record.exitObserved || !record.closeObserved || !record.captureComplete || record.captureError ? 1 : 0;
});
