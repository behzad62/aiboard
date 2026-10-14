'use strict';
// Test-only, supplemental, UNQUALIFIED. No product authority or recovery effect.
const path = require('node:path');
const { errorMonitor } = require('node:events');
const WINDOWS_TREE_SCRIPT = "$ErrorActionPreference='Stop';Get-CimInstance Win32_Process|ForEach-Object{\"$($_.ProcessId),$($_.ParentProcessId),$($_.CreationDate.ToUniversalTime().ToString('o'))\"}";

function createObserver(deps) {
  const { cp, fs, proc, timers, syncBuiltinESMExports, root, preload, tmpdir } = deps;
  const cap = 32768; // Finite prefix; ~23s at illustrative 1400 facts/s, never a completeness guarantee.
  const monoAnchor = deps.now();
  const wallAnchorMs = deps.wall();
  const facts = [];
  let ordinal = 0, overflow = 0, captureErrors = 0, tick = 0, activeTick = 0, span = 0;
  let flushed = false;
  const owned = new Map();
  const normalize = value => typeof value === 'string' ? value.replace(/\\/g, '/').toLowerCase() : '';
  const absolute = value => typeof value === 'string' && path.isAbsolute(value);
  const same = (a, b) => normalize(a) === normalize(b);
  const scenario = path.join(root, 'runner-v2/test/qualification/scenarios/windows-portable.ts');
  const testModule = path.join(root, 'runner-v2/test/qualification/windows-portable-channel.test.ts');
  const tsx = path.join(root, 'node_modules/tsx/dist/cli.mjs');
  const preflight = path.join(root, 'node_modules/tsx/dist/preflight.cjs');
  const loader = require('node:url').pathToFileURL(path.join(root, 'node_modules/tsx/dist/loader.mjs')).href;
  const supervisor = path.join(root, 'runner-v2/src/portable-process-supervisor.mjs');
  const bootstrap = path.join(root, 'runner-v2/src/portable-process-child.mjs');
  const systemRoot = typeof deps.systemRoot === 'string' ? deps.systemRoot : proc.env?.SystemRoot;
  const treeInspector = typeof systemRoot === 'string' && absolute(systemRoot)
    ? path.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe') : undefined;
  const treeArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_TREE_SCRIPT];
  const argv = proc.argv;
  const entry = Array.isArray(argv) ? argv[1] : undefined;
  const target = Array.isArray(argv) ? argv.at(-1) : undefined;
  // Node --test preloads both coordinator and worker. Only the coordinator retains
  // literal --test in execArgv; exclude it without serializing flags or environment.
  const testRunnerParent = same(entry, testModule) && Array.isArray(proc.execArgv) && proc.execArgv.includes('--test');
  const role = same(entry, supervisor) ? 'supervisor'
    : same(entry, scenario) ? 'scenario'
    : same(entry, testModule) && !testRunnerParent ? 'test'
    : same(entry, tsx) && (same(target, scenario) || same(target, testModule)) ? 'tsx-launcher' : 'inactive';
  const enabled = role !== 'inactive';
  const rawFs = {};
  for (const name of ['mkdirSync', 'writeFileSync']) rawFs[name] = fs[name];
  function captureFailure() { captureErrors += 1; }
  function fact(event, fields = {}) {
    try {
      ordinal += 1;
      if (facts.length === cap) { overflow += 1; return; }
      facts.push(Object.freeze({ ordinal, elapsedMs: deps.now() - monoAnchor, tick: activeTick, event, ...fields }));
    } catch { captureFailure(); }
  }
  function code(error) {
    // Own data descriptor only. Never invoke getters, stringification, message or stack.
    try {
      const descriptor = error && (typeof error === 'object' || typeof error === 'function')
        ? Object.getOwnPropertyDescriptor(error, 'code') : undefined;
      return descriptor && typeof descriptor.value === 'string'
        && /^(ENOENT|EACCES|EPERM|EBUSY|EPIPE|ERR_STREAM_DESTROYED)$/.test(descriptor.value)
        ? descriptor.value : 'other';
    } catch { captureFailure(); return 'other'; }
  }
  function snapshot() {
    return Object.freeze({ schema: 't8-passive-duplex/v1', qualification: 'UNQUALIFIED', role,
      wallAnchorMs, clock: 'elapsed monotonic per process; wall anchor is not clock synchronization',
      cap, overflow, captureErrors, incomplete: overflow !== 0 || captureErrors !== 0,
      beforeBodyError: 'UNOBSERVED: no hook before original fixture cleanup',
      unobserved: Object.freeze(['command deadline start/final-read identity', 'ACK semantic validation/status',
        'fence acquisition/validation disposition and SQLite spans', 'client reattestation',
        'inspection semantic results/native work and synchronous waits', 'pending input admission/state',
        'stdin destroyed flag', 'exact original cleanup completion']),
      facts: Object.freeze(facts.slice()) });
  }
  function classifyFile(value) {
    if (typeof value !== 'string' || !absolute(value)) return undefined;
    const text = normalize(value), temp = normalize(path.resolve(tmpdir));
    if (!text.startsWith(`${temp}/aiboard-qual-portable-duplex-`)) return undefined;
    const relative = text.slice(temp.length + 1);
    const match = /^(aiboard-qual-portable-duplex-[a-z0-9]+\/owned-[0-9a-f-]{36})\/(.+)$/.exec(relative);
    if (!match) return undefined;
    const leaf = match[2];
    function identity(fields) {
      if (!owned.has(match[1])) owned.set(match[1], owned.size + 1);
      return { ownedId: owned.get(match[1]), ...fields };
    }
    const channel = /^channel\/(input|ack|output)\/(input|stdout|stderr)-(\d{12})\.json(?:\.(?:[0-9a-f-]+)\.tmp)?$/.exec(leaf);
    if (channel && ((channel[1] === 'input' && channel[2] === 'input') || channel[1] === 'ack' || (channel[1] === 'output' && channel[2] !== 'input')))
      return identity({ file: `channel/${channel[1]}/${channel[2]}-:sequence.json${leaf.endsWith('.tmp') ? '.:temporary.tmp' : ''}`, sequence: Number(channel[3]) });
    const directory = /^channel\/(input|ack|output)$/.exec(leaf);
    if (directory) return identity({ file: `channel/${directory[1]}` });
    const known = /^(state\.json|fence\.json|lock-holder\.json|control\.json|child-go|child-status\.json|child-prepared\.json|stdout\.log|stderr\.log|\.fence\.lock|channel\/output-checkpoint\.json|channel\/output-retirement\.json)(?:\.[0-9a-f-]+\.tmp)?$/.exec(leaf);
    return known ? identity({ file: known[1] + (leaf.endsWith('.tmp') ? '.:temporary.tmp' : '') }) : undefined;
  }
  function wrapFs(name) {
    const original = fs[name];
    if (typeof original !== 'function') return;
    fs[name] = function (...args) {
      let admitted;
      try { admitted = classifyFile(args[0]); } catch { captureFailure(); }
      // Rename destination is recorded separately without exposing either path.
      let destination;
      if (name === 'renameSync') { try { destination = classifyFile(args[1]); } catch { captureFailure(); } }
      if (!admitted && !destination) return Reflect.apply(original, this, args);
      const id = ++span;
      fact('fs.enter', { operation: name, span: id, ...(admitted || destination), ...(destination ? { destination: destination.file } : {}) });
      try {
        const result = Reflect.apply(original, this, args);
        fact('fs.return', { operation: name, span: id, ...(name === 'existsSync' && typeof result === 'boolean' ? { exists: result } : {}) });
        return result;
      } catch (error) {
        fact('fs.throw', { operation: name, span: id, code: code(error) });
        throw error;
      }
    };
  }
  function nodeArgs(args) {
    if (!Array.isArray(args) || !args.every(item => typeof item === 'string')) return false;
    // exact tsx 4.x source composition: preflight, loader, then forwarded arguments.
    if (args[0] !== '--require' || !same(args[1], preflight) || args[2] !== '--import' || args[3] !== loader) return false;
    // Installed tsx prepends this one automatic flag to its test reexec. Admit
    // only its exact first position once; all remaining original shapes stay exact.
    const tail = args.slice(args[4] === '--enable-source-maps' ? 5 : 4);
    return (tail.length === 1 && same(tail[0], scenario))
      || (tail.length === 4 && tail[0] === '--test' && tail[1] === '--test-concurrency=1'
        && tail[2] === '--test-name-pattern=^qualification: portable-duplex$' && same(tail[3], testModule));
  }
  function inject(args) {
    // Only one injected --require. Node test-worker execArgv inherits this unchanged.
    if (args.some((value, index) => value === '--require' && same(args[index + 1], preload))) return args;
    return ['--require', preload, ...args];
  }
  function watchStdin(child) {
    try {
      const stream = child.stdin;
      if (!stream || typeof stream.write !== 'function') { captureFailure(); return; }
      const original = stream.write;
      stream.write = function (...args) {
        const id = ++span;
        fact('stdin.write.enter', { span: id });
        const callback = args.at(-1);
        let passed = args;
        if (typeof callback === 'function') {
          passed = args.slice();
          passed[passed.length - 1] = function (...callbackArgs) {
            fact('stdin.callback.enter', { span: id, outcome: callbackArgs[0] == null ? 'no-error' : 'error', ...(callbackArgs[0] == null ? {} : { code: code(callbackArgs[0]) }) });
            try { const result = Reflect.apply(callback, this, callbackArgs); fact('stdin.callback.return', { span: id }); return result; }
            catch (error) { fact('stdin.callback.throw', { span: id, code: code(error) }); throw error; }
          };
        }
        try {
          const result = Reflect.apply(original, this, passed);
          fact('stdin.write.return', { span: id, ...(typeof result === 'boolean' ? { acceptedWithoutBackpressure: result } : {}) });
          return result;
        } catch (error) { fact('stdin.write.throw', { span: id, code: code(error) }); throw error; }
      };
    } catch { captureFailure(); }
  }
  function watchTreeInspector(child, id) {
    function result(codeValue, signalValue) {
      let exitCode = null;
      if (codeValue !== null && codeValue !== undefined) {
        if (Number.isSafeInteger(codeValue) && codeValue >= -2147483648 && codeValue <= 4294967295) exitCode = codeValue;
        else captureFailure();
      }
      const signal = signalValue == null ? null : signalValue === 'SIGKILL' || signalValue === 'SIGTERM' ? signalValue : 'other';
      return { span: id, exitCode, signal };
    }
    // errorMonitor observes without installing an 'error' handler or suppressing throw.
    try { child.on(errorMonitor, error => fact('tree-inspector.errorMonitor', { span: id, code: code(error) })); } catch { captureFailure(); }
    try { child.on('exit', (exitCode, signal) => fact('tree-inspector.exit', result(exitCode, signal))); } catch { captureFailure(); }
    try { child.on('close', (exitCode, signal) => fact('tree-inspector.close', result(exitCode, signal))); } catch { captureFailure(); }
    try {
      const original = child.kill;
      if (typeof original !== 'function') { captureFailure(); return; }
      child.kill = function (...args) {
        if (args.length !== 1 || args[0] !== 'SIGKILL') return Reflect.apply(original, this, args);
        fact('tree-inspector.kill.enter', { span: id, signal: 'SIGKILL' });
        try {
          const result = Reflect.apply(original, this, args);
          fact('tree-inspector.kill.return', { span: id, ...(typeof result === 'boolean' ? { delivered: result } : {}) });
          return result;
        } catch (error) { fact('tree-inspector.kill.throw', { span: id, code: code(error) }); throw error; }
      };
    } catch { captureFailure(); }
  }
  function install() {
    if (!enabled) return;
    fact('observer.installed');
    const originalSpawn = cp.spawn;
    try { cp.spawn = function (...args) {
      let passed = args, selected = 'none', watch = false, inspectorSpan;
      try {
        const [executable, childArgs] = args;
        if (role === 'supervisor' && treeInspector && same(executable, treeInspector)
          && Array.isArray(childArgs) && childArgs.length === treeArgs.length && childArgs.every((arg, index) => arg === treeArgs[index])) {
          inspectorSpan = ++span;
          fact('tree-inspector.spawn.enter', { span: inspectorSpan });
        }
        if (same(executable, proc.execPath) && Array.isArray(childArgs)) {
          if (role === 'test' && childArgs.length === 2 && same(childArgs[0], tsx) && same(childArgs[1], scenario)) selected = 'scenario-launcher';
          else if (role === 'tsx-launcher' && nodeArgs(childArgs)) selected = 'tsx-descendant';
          else if (role === 'scenario' && childArgs.length === 2 && same(childArgs[0], supervisor) && typeof childArgs[1] === 'string') selected = 'supervisor';
          else if (role === 'supervisor' && childArgs.length === 2 && same(childArgs[0], bootstrap) && typeof childArgs[1] === 'string') watch = true;
          if (selected !== 'none') { passed = args.slice(); passed[1] = inject(childArgs); fact('spawn.inject', { childRole: selected }); }
        }
      } catch { captureFailure(); }
      // Original called once, same options, same receiver, same result/error.
      let child;
      try { child = Reflect.apply(originalSpawn, this, passed); }
      catch (error) { if (inspectorSpan !== undefined) fact('tree-inspector.spawn.throw', { span: inspectorSpan, code: code(error) }); throw error; }
      if (inspectorSpan !== undefined) { fact('tree-inspector.spawn.return', { span: inspectorSpan }); watchTreeInspector(child, inspectorSpan); }
      if (watch) { fact('bootstrap.spawn.return'); watchStdin(child); }
      return child;
    }; } catch { captureFailure(); }
    for (const name of ['readFileSync', 'writeFileSync', 'renameSync', 'unlinkSync', 'readdirSync', 'existsSync', 'openSync', 'closeSync', 'lstatSync', 'appendFileSync']) {
      try { wrapFs(name); } catch { captureFailure(); }
    }
    if (role === 'supervisor') {
      const originalInterval = timers.setInterval;
      try { timers.setInterval = function (...args) {
        const callback = args[0];
        if (typeof callback !== 'function' || callback.name !== 'tick' || args.length !== 2 || args[1] !== 10) return Reflect.apply(originalInterval, this, args);
        const passed = args.slice();
        fact('tick.register', { intervalMs: 10 });
        passed[0] = function (...callbackArgs) {
          const prior = activeTick; activeTick = ++tick;
          fact('tick.enter');
          try { const result = Reflect.apply(callback, this, callbackArgs); fact('tick.return'); return result; }
          catch (error) { fact('tick.throw', { code: code(error) }); throw error; }
          finally { activeTick = prior; }
        };
        return Reflect.apply(originalInterval, this, passed);
      }; } catch { captureFailure(); }
    }
    try { syncBuiltinESMExports(); } catch { captureFailure(); }
    try { proc.on('exit', flush); } catch { captureFailure(); }
  }
  function flush() {
    if (flushed || !enabled) return;
    flushed = true;
    // Exit listener runs on natural/explicit exit after the original path, never a rescue.
    try {
      const expected = path.resolve(root, 'qualification-evidence');
      if (!same(proc.env.RUNNER_V2_QUALIFICATION_EVIDENCE_ROOT, expected)) { captureFailure(); return; }
      const destination = path.join(expected, 'passive-duplex');
      Reflect.apply(rawFs.mkdirSync, fs, [destination, { recursive: true }]);
      fact('exit.flush');
      const output = JSON.stringify(snapshot());
      Reflect.apply(rawFs.writeFileSync, fs, [path.join(destination, `${role}-${proc.pid}.json`), output, { flag: 'wx', mode: 0o600 }]);
    } catch { captureFailure(); } // Cannot mask original exit/error; workflow detects missing/incomplete files.
  }
  return { install, snapshot, flush, classifyFile, role };
}

module.exports = { createObserver };
if (process.env.T8_PASSIVE_DUPLEX_DIAGNOSTIC === '1') {
  // Required packaged placement; root is derived from this module, never an env-controlled destination.
  const root = path.resolve(__dirname, '../../..');
  const observer = createObserver({ cp: require('node:child_process'), fs: require('node:fs'), proc: process,
    timers: globalThis, syncBuiltinESMExports: require('node:module').syncBuiltinESMExports,
    root, preload: __filename, tmpdir: require('node:os').tmpdir(),
    now: () => Number(process.hrtime.bigint()) / 1e6, wall: () => Date.now() });
  observer.install();
}
