// Test-only preload. Only the private, source-pinned batch bootstrap is observed.
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { syncBuiltinESMExports } = require('node:module');

const CHILD_SOURCE_SHA256 = '5442b67125fef0564b894349b7833f9942ee4e5d973c3b8a434c3b850e1f7d7b';
const BRIDGE_PREFIX = Object.freeze(['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
const PHASES = Object.freeze(['script_entered', 'json_ready', 'args_ready', 'before_invoke', 'after_invoke']);
const CONTRACT = 'bridge-observation-contract.json';
const RESULT = 'bridge-observation-result.json';
const FAULT = 'bridge-observation-fault.json';
const phaseName = index => `bridge-phase-${index + 1}.txt`;
const phaseFaultName = index => `bridge-phase-${index + 1}.fault.txt`;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function contextForBootstrap(argv, platform = process.platform) {
  // The capture Node and every unrelated descendant inherit NODE_OPTIONS.
  // They return here before any file read, patch, or phase write.
  if (platform !== 'win32' || path.basename(argv[1] || '') !== 'portable-process-child.mjs') return;
  let config;
  try { config = JSON.parse(Buffer.from(argv[2] || '', 'base64url').toString('utf8')); }
  catch { return; }
  if (path.basename(config.executable || '') !== 'capture-argv.cmd') return;
  const expectedChild = path.resolve(__dirname, '../../src/portable-process-child.mjs');
  if (!samePath(argv[1], expectedChild)) throw new Error('Batch phase observer rejected a foreign bootstrap path.');
  if (!Array.isArray(config.arguments) || config.arguments.some(value => typeof value !== 'string'))
    throw new Error('Batch phase observer rejected malformed arguments.');
  const workspace = path.resolve(config.workingDirectory);
  const root = path.dirname(workspace);
  const directory = path.dirname(path.resolve(config.statusPath));
  if (path.basename(workspace) !== 'workspace' || !/^aiboard-windows-semantic-batch-[A-Za-z0-9]+$/.test(path.basename(root)) ||
      !samePath(path.dirname(root), os.tmpdir()) || !/^owned-[0-9a-f-]{36}$/.test(path.basename(directory)) ||
      !samePath(path.dirname(directory), path.join(root, 'state')) ||
      !samePath(config.executable, path.join(workspace, 'capture-argv.cmd')) ||
      path.basename(config.statusPath) !== 'child-status.json' || !samePath(config.goPath, path.join(directory, 'child-go')))
    throw new Error('Batch phase observer rejected a foreign private fixture.');
  const canonicalTemp = fs.realpathSync(os.tmpdir());
  for (const dir of [root, workspace, path.join(root, 'state'), directory]) {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Batch phase observer refused an indirect directory.');
  }
  const canonicalRoot = path.join(canonicalTemp, path.basename(root));
  if (!samePath(fs.realpathSync(root), canonicalRoot) ||
      !samePath(fs.realpathSync(workspace), path.join(canonicalRoot, 'workspace')) ||
      !samePath(fs.realpathSync(directory), path.join(canonicalRoot, 'state', path.basename(directory))))
    throw new Error('Batch phase observer refused a non-confined directory.');
  const childBytes = fs.readFileSync(argv[1]);
  if (sha(Buffer.from(childBytes.toString('utf8').replace(/\r\n/g, '\n'))) !== CHILD_SOURCE_SHA256)
    throw new Error('Batch phase observer child source changed.');
  const fencePath = path.join(directory, 'fence.json');
  const fenceStat = fs.lstatSync(fencePath);
  if (!fenceStat.isFile() || fenceStat.isSymbolicLink() || fenceStat.nlink !== 1)
    throw new Error('Batch phase observer refused indirect fence evidence.');
  const fence = JSON.parse(fs.readFileSync(fencePath, 'utf8'));
  if (fence.ownerId !== 'windows-semantic-probe' || fence.fencingToken !== 1 || !/^[0-9a-f]{48}$/.test(fence.nonce || ''))
    throw new Error('Batch phase observer rejected foreign fence provenance.');
  const systemRoot = config.environment.SystemRoot ?? config.environment.SYSTEMROOT;
  if (typeof systemRoot !== 'string' || !path.isAbsolute(systemRoot)) throw new Error('Batch phase observer requires the pinned Windows helper.');
  return {
    directory: fs.realpathSync(directory), nonce: fence.nonce, goPath: config.goPath, fencePath,
    command: path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    expectedCommand: path.resolve(config.executable), expectedArguments: [...config.arguments],
  };
}

function bridgeExpressions(command, args) {
  const payload = Buffer.from(JSON.stringify({ command, args })).toString('base64');
  return [
    `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json`,
    '$a=@($p.args|ForEach-Object{[string]$_})',
    '& ([string]$p.command) @a',
    'if($null-eq$LASTEXITCODE){exit 0}else{exit $LASTEXITCODE}',
  ];
}

function instrumentBridge(encoded, context) {
  const originalBytes = Buffer.from(encoded, 'base64');
  const original = originalBytes.toString('utf16le');
  const expressions = bridgeExpressions(context.expectedCommand, context.expectedArguments);
  if (original !== expressions.join(';') || Buffer.from(original, 'utf16le').toString('base64') !== encoded)
    throw new Error('Batch phase observer rejected a changed encoded bridge.');
  const statements = [];
  for (let index = 0; index < PHASES.length; index++) {
    const leaf = path.join(context.directory, phaseName(index));
    const faultLeaf = path.join(context.directory, phaseFaultName(index));
    if (/[\r\n\0]/.test(leaf + faultLeaf)) throw new Error('Batch phase observer refused control characters in phase paths.');
    const literal = value => `'${value.replace(/'/g, "''")}'`;
    // CreateNew refuses an existing link or file. Every stage has one fixed leaf.
    // Direct .NET calls introduce no additional PowerShell module/cmdlet load.
    const write = (file, value) => `$runnerStream=[IO.File]::Open(${literal(file)},[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read);try{$runnerBytes=[Text.Encoding]::UTF8.GetBytes(${value});$runnerStream.Write($runnerBytes,0,$runnerBytes.Length)}finally{$runnerStream.Dispose()}`;
    const phaseValue = `${literal(PHASES[index])}+'|'+[DateTime]::UtcNow.ToString('o')+'|'+$PID`;
    const faultValue = `${literal(PHASES[index])}+'|'+$_.Exception.GetType().FullName`;
    statements.push(`try{${write(leaf, phaseValue)}}catch{try{${write(faultLeaf, faultValue)}}catch{}}`);
  }
  const changed = [statements[0], expressions[0], statements[1], expressions[1], statements[2], statements[3], expressions[2], statements[4], expressions[3]].join(';');
  return { encoded: Buffer.from(changed, 'utf16le').toString('base64'), originalSha256: sha(originalBytes), instrumentedSha256: sha(Buffer.from(changed, 'utf16le')), expressions };
}

function observeSpawn(original, receiver, args, context, record, fault) {
  const [command, argv] = args;
  let forwarded = args;
  try {
    if (!samePath(command, context.command) || !Array.isArray(argv) || argv.length !== BRIDGE_PREFIX.length + 1 ||
        BRIDGE_PREFIX.some((value, index) => argv[index] !== value))
      throw new Error('Batch phase observer rejected an unexpected natural spawn.');
    if (context.goPath) {
      const goStat = fs.lstatSync(context.goPath);
      const fenceStat = fs.lstatSync(context.fencePath);
      if (!goStat.isFile() || goStat.isSymbolicLink() || goStat.nlink !== 1 ||
          !fenceStat.isFile() || fenceStat.isSymbolicLink() || fenceStat.nlink !== 1)
        throw new Error('Batch phase observer refused indirect startup provenance.');
      const fence = JSON.parse(fs.readFileSync(context.fencePath, 'utf8'));
      if (fs.readFileSync(context.goPath, 'utf8') !== context.nonce || fence.nonce !== context.nonce ||
          fence.ownerId !== 'windows-semantic-probe' || fence.fencingToken !== 1)
        throw new Error('Batch phase observer rejected changed startup provenance.');
    }
    const bridge = instrumentBridge(argv[BRIDGE_PREFIX.length], context);
    record(CONTRACT, {
      protocol: 'aiboard-test-windows-batch-bridge/v1', nonce: context.nonce,
      bootstrapPid: process.pid, bootstrapAt: new Date().toISOString(),
      childSourceNormalizedSha256: CHILD_SOURCE_SHA256,
      originalScriptSha256: bridge.originalSha256, instrumentedScriptSha256: bridge.instrumentedSha256,
      expectedPhases: PHASES,
      limitations: 'Test-only NODE_OPTIONS addition and encoded argument modification; phase I/O perturbs scheduling. No extra native query or spawn.',
    });
    forwarded = [command, [...BRIDGE_PREFIX, bridge.encoded], ...args.slice(2)];
  } catch (error) { fault(error); }
  // Invalid instrumentation still forwards the original operation. Its fault
  // remains mandatory diagnostic failure; no synthetic process result is made.
  let child;
  try { child = Reflect.apply(original, receiver, forwarded); }
  catch (error) { try { record(RESULT, { spawnThrew: true, errorName: error?.name, errorCode: error?.code }); } catch (failure) { fault(failure); } throw error; }
  // Registered before the original bootstrap's process.exit-on-exit listener.
  // Close can occur too late to publish because that original listener exits.
  child.once('exit', (code, signal) => {
    try { record(RESULT, { exitedAt: new Date().toISOString(), code, signal, pipeCloseObserved: false }); }
    catch (error) { fault(error); }
  });
  return child;
}

function install(context) {
  let faultRecorded = false;
  const record = (name, value) => {
    value = { ...value, nonce: context.nonce, ...(name === RESULT ? { diagnosticFaultOccurred: faultRecorded } : {}) };
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    if (bytes.length > 4096) throw new Error('Batch phase observer record exceeded its bound.');
    const file = path.join(context.directory, name);
    // Fixed file and exclusive creation: never truncate or follow an existing leaf.
    fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
  };
  const fault = error => {
    if (faultRecorded) return;
    faultRecorded = true;
    try { record(FAULT, { errorName: error?.name, errorCode: error?.code, errorMessageSha256: sha(Buffer.from(String(error?.message))), retainedFaultLimit: 1 }); }
    catch { /* A missing mandatory contract/fault/result remains unknown, never healthy proof. */ }
  };
  const descriptor = Object.getOwnPropertyDescriptor(cp, 'spawn');
  const original = cp.spawn;
  const restore = () => { Object.defineProperty(cp, 'spawn', descriptor); syncBuiltinESMExports(); };
  try {
    Object.defineProperty(cp, 'spawn', { ...descriptor, value: function (...args) {
      try { return observeSpawn(original, this, args, context, record, fault); }
      finally {
        // A restoration fault is retained as a mandatory diagnostic failure.
        // It cannot replace the original spawn result/error object.
        try { restore(); } catch (error) { fault(error); }
      }
    } });
    syncBuiltinESMExports();
  } catch (error) {
    fault(error);
    try { restore(); } catch (restoration) { fault(restoration); }
  }
}

module.exports = { contextForBootstrap, bridgeExpressions, instrumentBridge, observeSpawn, PHASES, phaseName, phaseFaultName, CONTRACT, RESULT, FAULT, BRIDGE_PREFIX };
const context = contextForBootstrap(process.argv);
if (context) install(context);
