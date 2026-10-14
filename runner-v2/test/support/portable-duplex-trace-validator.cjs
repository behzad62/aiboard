'use strict';
// Shared pure validator used by controls and the hosted workflow. Never native authority.
const ROLES = ['tsx-launcher', 'test', 'scenario', 'supervisor'];
const COMMON = ['ordinal', 'elapsedMs', 'tick', 'event'];
const FIELDS = {
  'observer.installed': [], 'exit.flush': [], 'spawn.inject': ['childRole'], 'bootstrap.spawn.return': [],
  'fs.enter': ['operation', 'span', 'ownedId', 'file', 'sequence', 'destination'],
  'fs.return': ['operation', 'span', 'exists'], 'fs.throw': ['operation', 'span', 'code'],
  'stdin.write.enter': ['span'], 'stdin.write.return': ['span', 'acceptedWithoutBackpressure'],
  'stdin.write.throw': ['span', 'code'], 'stdin.callback.enter': ['span', 'outcome', 'code'],
  'stdin.callback.return': ['span'], 'stdin.callback.throw': ['span', 'code'],
  'tick.register': ['intervalMs'], 'tick.enter': [], 'tick.return': [], 'tick.throw': ['code'],
};
const OPERATIONS = ['readFileSync', 'writeFileSync', 'renameSync', 'unlinkSync', 'readdirSync', 'existsSync', 'openSync', 'closeSync', 'lstatSync', 'appendFileSync'];
const CODES = ['ENOENT', 'EACCES', 'EPERM', 'EBUSY', 'EPIPE', 'ERR_STREAM_DESTROYED', 'other'];
const FILE = /^(?:channel\/(?:input|ack|output)(?:\/(?:input|stdout|stderr)-:sequence\.json(?:\.:temporary\.tmp)?)?|(?:state\.json|fence\.json|lock-holder\.json|control\.json|child-go|child-status\.json|child-prepared\.json|stdout\.log|stderr\.log|\.fence\.lock|channel\/output-checkpoint\.json|channel\/output-retirement\.json)(?:\.:temporary\.tmp)?)$/;
function invalid() { throw new Error('Invalid or incomplete passive duplex trace'); }
function need(condition) { if (!condition) invalid(); }
const integer = value => Number.isSafeInteger(value) && value >= 0;
function validateTraces(traces) {
  need(Array.isArray(traces) && traces.length === 5);
  const counts = Object.create(null);
  for (const trace of traces) {
    need(trace && typeof trace === 'object' && trace.schema === 't8-passive-duplex/v1' && trace.qualification === 'UNQUALIFIED');
    need(ROLES.includes(trace.role) && trace.cap === 32768 && trace.incomplete === false && trace.overflow === 0 && trace.captureErrors === 0);
    need(Number.isFinite(trace.wallAnchorMs) && trace.wallAnchorMs >= 0);
    need(trace.beforeBodyError === 'UNOBSERVED: no hook before original fixture cleanup');
    need(Array.isArray(trace.facts) && trace.facts.length >= 2 && trace.facts.length <= trace.cap);
    need(trace.facts[0]?.event === 'observer.installed' && trace.facts.at(-1)?.event === 'exit.flush');
    counts[trace.role] = (counts[trace.role] || 0) + 1;
    let lastElapsed = -Infinity;
    const injections = [];
    for (let index = 0; index < trace.facts.length; index += 1) {
      const fact = trace.facts[index];
      need(fact && typeof fact === 'object' && Object.hasOwn(FIELDS, fact.event));
      need(fact.ordinal === index + 1 && Number.isFinite(fact.elapsedMs) && fact.elapsedMs >= 0 && fact.elapsedMs >= lastElapsed && integer(fact.tick));
      lastElapsed = fact.elapsedMs;
      need(Object.keys(fact).every(key => COMMON.includes(key) || FIELDS[fact.event].includes(key)));
      if (fact.event === 'observer.installed') need(index === 0);
      if (fact.event === 'exit.flush') need(index === trace.facts.length - 1);
      if (fact.event.startsWith('fs.')) need(OPERATIONS.includes(fact.operation));
      if (FIELDS[fact.event].includes('span')) need(integer(fact.span) && fact.span > 0);
      if (fact.event === 'fs.enter') {
        need(integer(fact.ownedId) && fact.ownedId > 0 && typeof fact.file === 'string' && FILE.test(fact.file));
        if (Object.hasOwn(fact, 'sequence')) need(integer(fact.sequence) && fact.sequence > 0);
        if (Object.hasOwn(fact, 'destination')) need(typeof fact.destination === 'string' && FILE.test(fact.destination));
      }
      if (Object.hasOwn(fact, 'exists')) need(typeof fact.exists === 'boolean' && fact.operation === 'existsSync');
      if (Object.hasOwn(fact, 'acceptedWithoutBackpressure')) need(typeof fact.acceptedWithoutBackpressure === 'boolean');
      if (Object.hasOwn(fact, 'code')) need(CODES.includes(fact.code));
      if (fact.event.endsWith('.throw')) need(CODES.includes(fact.code));
      if (fact.event === 'stdin.callback.enter') need(fact.outcome === 'no-error' || fact.outcome === 'error');
      if (fact.event === 'stdin.callback.enter' && fact.outcome === 'error') need(CODES.includes(fact.code));
      if (fact.event === 'tick.register') need(trace.role === 'supervisor' && fact.intervalMs === 10);
      if (['tick.enter', 'tick.return', 'tick.throw'].includes(fact.event)) need(fact.tick > 0);
      if (fact.event.startsWith('tick.') || fact.event.startsWith('stdin.') || fact.event === 'bootstrap.spawn.return') need(trace.role === 'supervisor');
      if (fact.event === 'spawn.inject') injections.push(fact.childRole);
    }
    const expected = { 'tsx-launcher': 'tsx-descendant', test: 'scenario-launcher', scenario: 'supervisor' }[trace.role];
    need(expected ? injections.length === 1 && injections[0] === expected : injections.length === 0);
    // No tick/stdin facts are required: a genuine original failure may precede them.
  }
  need(counts['tsx-launcher'] === 2 && counts.test === 1 && counts.scenario === 1 && counts.supervisor === 1);
  return Object.freeze({ qualification: 'UNQUALIFIED', traceCount: 5, facts: traces.reduce((sum, trace) => sum + trace.facts.length, 0) });
}
module.exports = { validateTraces };
if (require.main === module) {
  const fs = require('node:fs'), path = require('node:path');
  const directory = path.resolve(__dirname, '../../../qualification-evidence/passive-duplex');
  const files = fs.readdirSync(directory).filter(name => name.endsWith('.json'));
  need(files.every(name => /^(?:tsx-launcher|test|scenario|supervisor)-\d+\.json$/.test(name)));
  const result = validateTraces(files.map(name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
