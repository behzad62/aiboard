'use strict';

// Test-owned, passive metadata only. No network, process launch, stream reads,
// timers, retries, environment enumeration, or per-event filesystem writes.
const { errorMonitor } = require('node:events');
const { performance } = require('node:perf_hooks');
const { writeFileSync } = require('node:fs');

const CODES = new Set([
  'EADDRINUSE', 'EADDRNOTAVAIL', 'EACCES', 'EPERM', 'ENOENT', 'EINVAL',
  'ENOMEM', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND',
  'EAI_AGAIN', 'ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND',
  'ERR_INVALID_ARG_TYPE', 'ERR_UNSUPPORTED_ESM_URL_SCHEME',
  'ERR_UNKNOWN_FILE_EXTENSION', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);
const CLASSES = new Set(['Error', 'TypeError', 'SyntaxError', 'RangeError', 'AbortError', 'AggregateError']);
const SIGNALS = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV', 'SIGHUP', 'SIGBREAK']);
const MAX_STREAM_SCAN_BYTES = 65536;
const MAX_CHUNK_SCAN_BYTES = 8192;
const MAX_COUNT = 1073741824;
const MAX_EVENTS = 512;
const MAX_REPORT_BYTES = 65536;
// Invoke the known native getter rather than reading arbitrary response fields
// or evaluating the original response.ok getter a second time.
const responseStatusGetter = typeof Response === 'function'
  ? Object.getOwnPropertyDescriptor(Response.prototype, 'status')?.get : undefined;

function ownData(value, key) {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
}
function sanitizedError(error) {
  const code = ownData(error, 'code');
  const cause = ownData(error, 'cause');
  const causeCode = ownData(cause, 'code');
  const ownName = ownData(error, 'name');
  // Only known prototypes are inspected; arbitrary name/message/stack getters
  // are never evaluated, and no unknown scalar is retained.
  let errorClass = 'unknown';
  if (CLASSES.has(ownName)) errorClass = ownName;
  else {
    try {
      for (const candidate of [TypeError, SyntaxError, RangeError, AggregateError, Error]) {
        if (Object.getPrototypeOf(error) === candidate.prototype) {
          errorClass = candidate.name;
          break;
        }
      }
    } catch { /* hostile objects stay unknown */ }
  }
  return {
    class: errorClass,
    code: typeof code === 'string' && CODES.has(code) ? code : 'unknown',
    causeCode: typeof causeCode === 'string' && CODES.has(causeCode) ? causeCode : 'unknown',
  };
}
function freezeTree(value) {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) freezeTree(entry);
    Object.freeze(value);
  }
  return value;
}

function createBenchmarkStartupDiagnostic(options = {}) {
  const outputPath = options.outputPath === undefined
    ? process.env.RUNNER_V2_BENCHMARK_STARTUP_DIAGNOSTIC_FILE
    : options.outputPath;
  if (typeof outputPath !== 'string' || outputPath.length === 0) {
    const noop = () => undefined;
    return Object.freeze({ selectedPort: noop, observeChild: noop, attempt: noop,
      fetched: noop, decoded: noop, rejected: noop, waitStart: noop, waitEnd: noop,
      loopExit: noop, beforeStop: noop, afterStop: noop, rootCleanup: noop, publish: noop });
  }
  const origin = performance.now();
  const state = {
    schema: 1, qualification: 'UNQUALIFIED_DIAGNOSTIC', role: 'extracted-bench-health-parent',
    limits: { maxEvents: MAX_EVENTS, streamScanBytes: MAX_STREAM_SCAN_BYTES,
      chunkScanBytes: MAX_CHUNK_SCAN_BYTES, maxReportBytes: MAX_REPORT_BYTES },
    selectedPort: null, events: [], droppedEvents: 0, observationFailures: 0,
    stdout: { observedPushes: 0, bytes: 0, scannedBytes: 0, scanTruncated: false,
      startupBanner: false, managedUnavailable: false, pasteBanner: false },
    stderr: { observedPushes: 0, bytes: 0, scannedBytes: 0, scanTruncated: false,
      categories: [] },
    child: { spawnObserved: false, errorMonitorObserved: false, exitObserved: false,
      exitCode: null, exitSignal: null, closeObserved: false, closeCode: null, closeSignal: null },
    preCleanup: null, afterStop: null, rootCleanup: 'not_observed',
    publication: 'exclusive_terminal_write_attempt',
  };
  let ordinal = 0;
  let published = false;
  let preCleanupTaken = false;
  const disposers = [];
  const tails = { stdout: '', stderr: '' };
  function now() { return Math.max(0, Math.round((performance.now() - origin) * 1000) / 1000); }
  function safe(action) {
    try { return action(); }
    catch { state.observationFailures = Math.min(MAX_COUNT, state.observationFailures + 1); return undefined; }
  }
  function event(kind, fields = {}) {
    safe(() => {
      if (state.events.length >= MAX_EVENTS) {
        state.droppedEvents = Math.min(MAX_COUNT, state.droppedEvents + 1);
        return;
      }
      state.events.push({ ordinal: ++ordinal, ms: now(), kind, ...fields });
    });
  }
  function count(value) { return Number.isInteger(value) && value >= 0 && value < 80 ? value : null; }
  function code(value) { return Number.isInteger(value) && value >= 0 && value <= 4294967295 ? value : null; }
  function signal(value) { return typeof value === 'string' && SIGNALS.has(value) ? value : value === null ? null : 'unknown'; }
  function childFacts(child) {
    // ChildProcess owns these data properties; getters are not evaluated.
    return { exitCode: code(ownData(child, 'exitCode')), killed: ownData(child, 'killed') === true,
      signalCode: signal(ownData(child, 'signalCode')) };
  }
  function streamChunk(role, chunk) {
    safe(() => {
      const stream = state[role];
      if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk)) return;
      const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      stream.observedPushes = Math.min(MAX_COUNT, stream.observedPushes + 1);
      stream.bytes = Math.min(MAX_COUNT, stream.bytes + bytes);
      const room = Math.max(0, MAX_STREAM_SCAN_BYTES - stream.scannedBytes);
      const scanBytes = Math.min(bytes, room, MAX_CHUNK_SCAN_BYTES);
      if (scanBytes < bytes) stream.scanTruncated = true;
      if (scanBytes === 0) return;
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      const text = tails[role] + buffer.subarray(0, scanBytes).toString('utf8');
      stream.scannedBytes += scanBytes;
      tails[role] = text.slice(-128);
      if (role === 'stdout') {
        stream.startupBanner ||= text.includes('AI Board - bench runner');
        stream.managedUnavailable ||= text.includes('Managed Runner V2: unavailable');
        stream.pasteBanner ||= text.includes('Paste the URL and token');
      } else {
        for (const category of [...CODES, 'SyntaxError', 'TypeError', 'RangeError']) {
          if (new RegExp(`\\b${category}\\b`).test(text) && !stream.categories.includes(category)) {
            stream.categories.push(category);
          }
        }
      }
    });
  }
  function observeStream(stream, role) {
    safe(() => {
      if (!stream || typeof stream.push !== 'function') { state.observationFailures++; return; }
      const original = stream.push;
      const ownDescriptor = Object.getOwnPropertyDescriptor(stream, 'push');
      function observedPush(...args) {
        // Original push executes first. Its exact receiver, argument identities,
        // return and throw are preserved. No additional stream read/listener.
        const result = Reflect.apply(original, this, args);
        streamChunk(role, args[0]);
        return result;
      }
      stream.push = observedPush;
      if (stream.push !== observedPush) { state.observationFailures++; return; }
      disposers.push(() => {
        if (stream.push !== observedPush) return;
        if (ownDescriptor) Object.defineProperty(stream, 'push', ownDescriptor);
        else delete stream.push;
      });
    });
  }
  function listener(child, name, handler) {
    safe(() => {
      child.on(name, handler);
      disposers.push(() => child.removeListener(name, handler));
    });
  }
  const api = {
    selectedPort(port) {
      safe(() => { state.selectedPort = Number.isInteger(port) && port >= 40000 && port <= 49999 ? port : null; });
      event('port_selected');
    },
    observeChild(child) {
      event('child_returned_from_spawn');
      listener(child, 'spawn', () => { state.child.spawnObserved = true; event('child_spawn'); });
      listener(child, errorMonitor, (error) => { state.child.errorMonitorObserved = true; event('child_error_monitor', sanitizedError(error)); });
      listener(child, 'exit', (exitCode, exitSignal) => {
        state.child.exitObserved = true; state.child.exitCode = code(exitCode); state.child.exitSignal = signal(exitSignal);
        event('child_exit', { exitCode: code(exitCode), signal: signal(exitSignal) });
      });
      listener(child, 'close', (closeCode, closeSignal) => {
        state.child.closeObserved = true; state.child.closeCode = code(closeCode); state.child.closeSignal = signal(closeSignal);
        event('child_close', { exitCode: code(closeCode), signal: signal(closeSignal) });
      });
      safe(() => observeStream(child.stdout, 'stdout'));
      safe(() => observeStream(child.stderr, 'stderr'));
    },
    attempt(attempt) { event('fetch_enter', { attempt: count(attempt) }); },
    fetched(attempt, response) {
      safe(() => {
        const status = typeof responseStatusGetter === 'function' ? Reflect.apply(responseStatusGetter, response, []) : null;
        event('fetch_headers', { attempt: count(attempt), status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
          okFromStatus: Number.isInteger(status) && status >= 200 && status <= 299 });
      });
    },
    decoded(attempt) { event('json_decoded', { attempt: count(attempt) }); },
    rejected(attempt, error) { event('attempt_rejected', { attempt: count(attempt), ...sanitizedError(error) }); },
    waitStart(attempt) { event('original_wait_enter', { attempt: count(attempt) }); },
    waitEnd(attempt) { event('original_wait_return', { attempt: count(attempt) }); },
    loopExit(reason, child) {
      if (reason === 'child_exit' || reason === 'exhausted' || reason === 'health_decoded') event('loop_exit', { reason, ...childFacts(child) });
    },
    beforeStop(child) {
      event('original_stop_enter', childFacts(child));
      safe(() => {
        if (preCleanupTaken) { state.observationFailures++; return; }
        preCleanupTaken = true;
        state.preCleanup = freezeTree(JSON.parse(JSON.stringify({ ms: now(), child: state.child,
          originalChildProperties: childFacts(child), stdout: state.stdout, stderr: state.stderr,
          eventCount: state.events.length, lastEventOrdinal: ordinal,
          droppedEvents: state.droppedEvents, observationFailures: state.observationFailures })));
      });
    },
    afterStop(child, returned) {
      event('original_stop_settled', { returned: returned === true, ...childFacts(child) });
      safe(() => { state.afterStop = freezeTree({ ms: now(), returned: returned === true, ...childFacts(child) }); });
    },
    rootCleanup(returned) { state.rootCleanup = returned === true ? 'returned' : 'threw'; event('original_root_cleanup_settled', { returned: returned === true }); },
    publish() {
      if (published) return;
      published = true;
      for (const dispose of disposers.reverse()) safe(dispose);
      tails.stdout = ''; tails.stderr = '';
      safe(() => {
        const attempts = state.events.filter((entry) => entry.kind === 'fetch_enter');
        const terminals = state.events.filter((entry) => entry.kind === 'loop_exit');
        const terminal = terminals.length === 1 ? terminals[0] : null;
        const positiveFacts = state.selectedPort !== null &&
          state.events.filter((entry) => entry.kind === 'child_returned_from_spawn').length === 1 &&
          attempts.length >= 1 && attempts.length <= 80 && attempts.every((entry, index) => entry.attempt === index) &&
          terminal !== null &&
          (terminal.reason !== 'health_decoded' || state.events.filter((entry) => entry.kind === 'json_decoded').length === 1) &&
          (terminal.reason !== 'exhausted' || attempts.length === 80) &&
          (terminal.reason !== 'child_exit' || state.preCleanup?.originalChildProperties.exitCode !== null) &&
          state.events.filter((entry) => entry.kind === 'original_stop_enter').length === 1 &&
          state.events.filter((entry) => entry.kind === 'original_stop_settled').length === 1 &&
          state.rootCleanup !== 'not_observed';
        state.complete = state.droppedEvents === 0 && state.observationFailures === 0 &&
          !state.stdout.scanTruncated && !state.stderr.scanTruncated && state.preCleanup !== null && state.afterStop !== null && positiveFacts;
        const body = JSON.stringify(state) + '\n';
        if (Buffer.byteLength(body) > MAX_REPORT_BYTES) return;
        writeFileSync(outputPath, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      });
    },
  };
  return Object.freeze(api);
}

module.exports = { createBenchmarkStartupDiagnostic, sanitizedError };
