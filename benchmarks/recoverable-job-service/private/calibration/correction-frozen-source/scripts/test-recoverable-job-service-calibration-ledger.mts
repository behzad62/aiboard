import assert from 'node:assert/strict';
import ts from 'typescript';
import {createHash} from 'node:crypto';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {dirname, join, posix} from 'node:path';
import {variants} from '../benchmarks/recoverable-job-service/private/variants.mjs';
import {materialControl} from '../benchmarks/recoverable-job-service/private/qualification-map.mjs';
import {controls} from '../benchmarks/recoverable-job-service/private/controls.mjs';
import {sourceExpectedAssertion} from '../benchmarks/recoverable-job-service/private/source-controls.mjs';
import {contractPaths, suitePaths, scoreInputHashes} from '../benchmarks/recoverable-job-service/private/identity.mjs';
import {effectiveProvenance, schedulePlan} from '../benchmarks/recoverable-job-service/private/provenance.mjs';

// Finite source/dependency inventory, not a semantic calibration certificate.
// Conservative closure keeps every runtime-dependent sub-branch. Only conditions
// determined entirely by the frozen variant arguments are eliminated.
const base = 'benchmarks/recoverable-job-service';
const option = (name: string) => {const n = process.argv.indexOf(name); return n < 0 ? null : process.argv[n + 1];};
const correctionPath = option('--correction-proof'), reservePath = option('--reserve-proof');
assert.equal(!!correctionPath, !!reservePath, 'correction proof and scoped reserve correction must be supplied together');
const target = join(base, 'private/calibration', correctionPath ? 'predicate-dependency-ledger-corrected.json' : 'predicate-dependency-ledger.json');
const sha = (x: string | Buffer) => createHash('sha256').update(x).digest('hex');
const correctionEvidence: any[] = [];
const currentProof = new Map<string, any[]>();
for (const directory of [correctionPath, reservePath].filter(Boolean) as string[]) {
  const bytes = await readFile(join(directory, 'summary.json'));
  const proof = JSON.parse(bytes.toString());
  assert.deepEqual(proof.identity, await scoreInputHashes(), 'targeted proof matches actual current scorer/public identity');
  if (directory === reservePath) assert.equal(proof.passed, true, 'real reserve effect correction passes');
  else assert.deepEqual(proof.checks.filter((c: any) => !c.passed).map((c: any) => c.label), [
    'forbidden-attach-reserve: B06/primary exact forbidden predicate', 'reserve: forbidden neighbor issued an actual attachment',
  ], 'only the separately corrected vacuous reserve probe is excluded from reuse');
  correctionEvidence.push({path: join(directory, 'summary.json'), sha256: sha(bytes), identity: proof.identity,
    scope: directory === reservePath ? 'actual forbidden reserve attachment' : 'coherent correction proof; vacuous reserve neighbor superseded explicitly'});
  for (const run of proof.runs) {
    if (directory === correctionPath && run.name === 'forbidden-attach-reserve') continue;
    const path = join(directory, run.name + '.result.json'), resultBytes = await readFile(path);
    const result = JSON.parse(resultBytes.toString());
    for (const family of result.families) for (const row of family.variants) currentProof.set(row.id, [
      ...currentProof.get(row.id) ?? [], {path, sha256: sha(resultBytes), run: run.name, sourceHash: run.sourceHash,
        expectation: run.expectation, passed: row.passed, assertions: row.assertions, reason: row.reason,
        safetyFailures: row.safetyFailures, operations: row.operations, promiseJobs: row.promiseJobs},
    ]);
  }
}
const parsed = new Map<string, {text: string; ast: ts.SourceFile}>();
const read = async (path: string) => {
  if (!parsed.has(path)) {const text = await readFile(join(base, path), 'utf8'); parsed.set(path, {
    text, ast: ts.createSourceFile(path, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)});}
  return parsed.get(path)!;
};
const files = [...new Set([...contractPaths, ...suitePaths, 'private/controls.mjs', 'private/source-controls.mjs',
  'private/qualification-map.mjs', 'private/control-expectations.json', 'private/material-failure.mjs',
  'private/qualification-provenance.mjs', 'private/replay-comparison.mjs'])];
for (const file of files) await read(file);
const dependencies: any[] = [];
for (const file of files) {
  const {text, ast} = parsed.get(file)!;
  const imports: string[] = [];
  ast.forEachChild(node => {if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
    const name = node.moduleSpecifier.text;
    if (name.startsWith('.')) imports.push(posix.normalize(posix.join(posix.dirname(file), name)));
    else imports.push(name);
  }});
  for (const name of imports) if (name.startsWith('private/') || name.startsWith('public/'))
    assert(files.includes(name), 'dependency inventory is closed: ' + file + ' -> ' + name);
  const disposition = file.startsWith('public/') || /(?:wire-schema|response-schema)/.test(file)
    ? 'published wire/audit requirement'
    : /(?:broker|source-adapter|replay|guest|runtime|memory-shim|evaluation-worker|dependency-provenance)/.test(file)
      ? 'trusted physical fact or bounded transport/scheduling mechanism'
      : /(?:scenarios|variants|source-cases)/.test(file)
        ? 'published predicate and fixture schedule; row findings override classification'
        : 'trusted evaluation or qualification bookkeeping; not candidate implementation';
  dependencies.push({path: file, sha256: sha(text), bytes: Buffer.byteLength(text), imports, disposition});
}
const units = new Map<string, any>();
const astNodes = new Map<string, {path: string; node: ts.Node}>();
function unit(id: string, path: string, node: ts.Node) {
  const source = parsed.get(path)!;
  const text = node.getText(source.ast);
  const result = {id, path, startLine: source.ast.getLineAndCharacterOfPosition(node.getStart(source.ast)).line + 1,
    endLine: source.ast.getLineAndCharacterOfPosition(node.end).line + 1, sha256: sha(text), source: text};
  units.set(id, result); astNodes.set(id, {path, node}); return id;
}
for (const path of ['private/scenarios.mjs', 'private/source-cases.mjs', 'private/variants.mjs']) {
  const {ast} = parsed.get(path)!;
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name) unit(path + '#' + node.name.text, path, node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
        ts.isArrowFunction(node.initializer) && ts.isVariableDeclarationList(node.parent) &&
        ts.isVariableStatement(node.parent.parent) && ts.isSourceFile(node.parent.parent.parent))
      unit(path + '#' + node.name.text, path, node.initializer);
    if (ts.isClassDeclaration(node) && node.name?.text === 'Scenario') for (const member of node.members)
      if (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member))
        unit('Scenario.' + (member.name?.getText(ast) ?? 'constructor'), path, member);
    if (ts.isPropertyAssignment(node) && /^[A-E]\d\d$/.test(node.name.getText(ast)) && ts.isArrowFunction(node.initializer))
      unit('scenario.' + node.name.getText(ast), path, node.initializer);
    ts.forEachChild(node, visit);
  }
  visit(ast);
}
const unknown = Symbol('runtime-value');
function value(node: ts.Expression | undefined, env: Record<string, any>): any {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isIdentifier(node)) return Object.hasOwn(env, node.text) ? env[node.text] : node.text === 'undefined' ? undefined : unknown;
  if (ts.isParenthesizedExpression(node)) return value(node.expression, env);
  if (ts.isArrayLiteralExpression(node)) {const result = node.elements.map(n => value(n as ts.Expression, env)); return result.includes(unknown) ? unknown : result;}
  if (ts.isPropertyAccessExpression(node)) {const object = value(node.expression, env); return object === unknown || object === null ? unknown : object?.[node.name.text];}
  if (ts.isElementAccessExpression(node)) {const object = value(node.expression, env), key = value(node.argumentExpression, env); return object === unknown || key === unknown || object === null ? unknown : object?.[key];}
  if (ts.isPrefixUnaryExpression(node)) {const v = value(node.operand, env); if (v === unknown) return unknown; if (node.operator === ts.SyntaxKind.ExclamationToken) return !v; if (node.operator === ts.SyntaxKind.MinusToken) return -v;}
  if (ts.isBinaryExpression(node)) {
    const a = value(node.left, env), b = value(node.right, env), op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return a === false || b === false ? false : a === unknown || b === unknown ? unknown : a && b;
    if (op === ts.SyntaxKind.BarBarToken) return a === true || b === true ? true : a === unknown || b === unknown ? unknown : a || b;
    if (a === unknown || b === unknown) return unknown;
    if (op === ts.SyntaxKind.EqualsEqualsEqualsToken) return a === b;
    if (op === ts.SyntaxKind.ExclamationEqualsEqualsToken) return a !== b;
    if (op === ts.SyntaxKind.PlusToken) return a + b;
  }
  if (ts.isConditionalExpression(node)) {const test = value(node.condition, env); return test === unknown ? unknown : value(test ? node.whenTrue : node.whenFalse, env);}
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const object = value(node.expression.expression, env), method = node.expression.name.text;
    const args = node.arguments.map(n => value(n, env));
    if (object === unknown || args.includes(unknown) || object == null) return unknown;
    if (['startsWith', 'endsWith', 'slice'].includes(method) && typeof object === 'string') return (object as any)[method](...args);
    if (method === 'includes' && (Array.isArray(object) || typeof object === 'string')) return object.includes(args[0]);
  }
  return unknown;
}
function selectedStatements(body: ts.Block, env: Record<string, any>) {
  const selected: ts.Node[] = [];
  for (const statement of body.statements) {
    if (ts.isIfStatement(statement)) {
      const test = value(statement.expression, env);
      if (test === false) {if (statement.elseStatement) selected.push(statement.elseStatement); continue;}
      if (test === true) {
        selected.push(statement.thenStatement);
        if (ts.isReturnStatement(statement.thenStatement) || ts.isBlock(statement.thenStatement) && statement.thenStatement.statements.some(ts.isReturnStatement)) break;
        continue;
      }
    }
    selected.push(statement);
  }
  return selected;
}
const callData = (nodes: ts.Node[], path: string, env: Record<string, any>) => {
  const ast = parsed.get(path)!.ast;
  const predicates: any[] = [], schedules: any[] = [], observations: any[] = [], helpers = new Set<string>();
  const seenObservations = new Set<string>();
  const arg = (n: ts.Expression | undefined) => {const result = value(n, env); return {expression: n?.getText(ast) ?? null,
    ...(result === unknown ? {runtimeDependent: true} : {resolved: result === undefined ? {tag: 'undefined'} : result})};};
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(ast);
      const location = {path, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1};
      if (/^(?:s|this)\.(check|ok|refuse|missing)$/.test(name)) predicates.push({...location, call: name,
        expression: node.getText(ast), arguments: node.arguments.map(arg)});
      if (name === 's.hold' || name === 'heldSource' || name === 's.b.fault' || name === 'this.b.fault')
        schedules.push({...location, expression: node.getText(ast), arguments: node.arguments.map(arg),
          classification: 'published external boundary unless finding marks optional phase/private layout'});
      if (/^(?:s|this)\.(\w+)$/.test(name)) {
        const key = 'Scenario.' + name.split('.').at(-1); if (astNodes.has(key)) helpers.add(key);
      }
      const local = path + '#' + name; if (astNodes.has(local)) helpers.add(local);
    }
    if (ts.isPropertyAccessExpression(node) && /^(?:s\.b|this\.b)\./.test(node.getText(ast))) {
      const expression = node.getText(ast);
      if (!seenObservations.has(expression)) {seenObservations.add(expression); observations.push({expression,
        classification: expression.includes('.docs') ? 'candidate-private; requires finding' : 'trusted fixture state, actual public audit, or physical-effect trace'});}
    }
    ts.forEachChild(node, visit);
  }
  for (const node of nodes) visit(node);
  return {predicates, schedules, observations, helpers: [...helpers]};
};
const priorPath = 'private/task2-2026-09-12T15-32-10-563Z/reference.json';
const priorBytes = await readFile(join(base, priorPath));
const prior = JSON.parse(priorBytes.toString());
const observed = new Map(prior.diagnostics.families.flatMap((f: any) => f.variants.map((v: any) => [v.id, v])));
const families = JSON.parse((await read('public/families.json')).text);
const expected = JSON.parse((await read('private/control-expectations.json')).text);
const findings: Record<string, string[]> = {
  'CAL-SCHEDULE-ATTACH': ['B01/recover-driver.attach.before', 'B06/deadline-driver.attach.before', 'B07/issued-driver.attach.before', 'B07/resource-intent-reader'],
  'CAL-SCHEDULE-PRIVATE-RECORD': ['C09/restore-store.commit.before', 'C09/restore-store.commit.after'],
  'CAL-SCHEDULE-ROOT-TIMING': ['E02/primary'],
  'CAL-CATEGORY-NONRANGE': ['A07/invalid-stream', 'A07/invalid-digest', 'A07/invalid-artifactId', 'A07/invalid-channelId'],
};
const commonVerdictUnitIds = ['private/evaluator.mjs', 'private/runtime.mjs', 'private/guest.mjs',
  'private/broker.mjs', 'private/source-adapter.mjs', 'private/replay.mjs', 'private/provenance.mjs',
  'private/oracle.mjs', 'private/response-schema.mjs', 'private/wire-schema.mjs'].map(path =>
    unit(path + '#module', path, parsed.get(path)!.ast));
const oracleAssertions: any[] = [];
const oracleAst = parsed.get('private/oracle.mjs')!.ast;
function oracleVisit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(oracleAst) === 'error')
    oracleAssertions.push({code: node.arguments[0]?.getText(oracleAst),
      line: oracleAst.getLineAndCharacterOfPosition(node.getStart(oracleAst)).line + 1,
      invocation: node.getText(oracleAst), disposition: 'trusted causal facts against public R4/R5/R8/R9 and source-bootstrap rules'});
  ts.forEachChild(node, oracleVisit);
}
oracleVisit(oracleAst);
const probeClasses = [
  {id: 'P01-zero-prefix', variants: ['B17/primary', 'B17/source-zero', 'B17/source-both', 'B17/source-pristine-early', 'B17/source-tail', 'B17/source-fresh-restart'],
    choices: 'never-created/pristine/adopted; zero origin; authenticated nonzero prefix; retained/buffered suffix', neighbor: 'nonzero prefix/loss without exact current authenticated proof'},
  {id: 'P02-source-freshness', variants: ['B17/source-changed-ack', 'B17/source-changed-output', 'B17/source-proof-stale', 'B17/source-observation-response-unknown'],
    choices: 'current/superseded attachment; delayed source ACK begin/completion; new explicit request with new observation', neighbor: 'adopt superseded/stale proof or repeat unresolved attachment'},
  {id: 'P03-source-obligations', variants: ['B17/source-pending-ack-stdout', 'B17/source-unknown-ack-stderr', 'B17/source-consumer-unknown'],
    choices: 'exact pending/unknown source and client IDs; truthful aggregate recover with per-job obligations', neighbor: 'release/close with unresolved exact intent'},
  {id: 'P04-setup-attachment', variants: ['B06/primary', ...findings['CAL-SCHEDULE-ATTACH'], 'B10/primary'],
    choices: 'reader during setup; acquisition installs none; required reader in later cleanup', neighbor: 'new attachment during expired/insufficient-reserve stop'},
  {id: 'P05-frame-category', variants: ['A04/primary', 'A04/sequence-unsafe', 'A07/primary', ...findings['CAL-CATEGORY-NONRANGE'], 'A07/invalid-seq', 'A07/invalid-offset'],
    choices: 'real integrity versus gap only for continuity/range error', neighbor: 'backend/input or gap for non-range corruption; successful admission'},
  {id: 'P06-authority-deadline', variants: ['A01/primary', 'A01/takeover-before', 'A01/takeover-after', 'B06/primary'],
    choices: 'current/successor authority and simultaneous-invalid deadline precedence', neighbor: 'cleanup for changed authority; effect/success after expired entry'},
  {id: 'P07-owned-accounting', variants: ['B14/primary'], choices: 'all 1100 owned jobs; maintained index versus paged scan; snapshot continuation', neighbor: 'drop later owned records or close before all accounted'},
  {id: 'P08-reclamation', variants: ['C18/primary', 'E08/primary', 'C17/primary', 'C18/root-birth', 'C18/root-retained'],
    choices: 'three adopted roots, absent root, non-reference order, first-error partial result', neighbor: 'delete retained/foreign/aliased root or misreport remaining after failure'},
];
const knownIds = new Set(variants.map((v: any) => v.id));
for (const probe of probeClasses) for (const id of probe.variants) assert(knownIds.has(id), 'probe maps to exact actual variant: ' + id);
const rows: any[] = [];
for (const variant of schedulePlan(effectiveProvenance().seed)) {
  const v: any = variant, env = {v, a: v.args, name: v.id.slice('B17/source-'.length)};
  const path = v.kind === 'primary' ? 'private/scenarios.mjs' : v.kind === 'source-bootstrap' ? 'private/source-cases.mjs' : 'private/variants.mjs';
  const rootId = v.kind === 'primary' ? 'scenario.' + v.family : path + '#' + (v.kind === 'source-bootstrap' ? 'exerciseSourceVariant' : 'exerciseVariant');
  const rootNode: any = astNodes.get(rootId)?.node;
  assert(rootNode?.body, 'actual predicate exists for ' + v.id);
  const selected = v.kind === 'primary' ? [rootNode] : selectedStatements(rootNode.body, env);
  const selectionIds = selected.map((node: ts.Node, n: number) => unit('variant.' + v.id + '.' + n, path, node));
  const data = callData(selected, path, env);
  const helperIds = new Set<string>(['Scenario.constructor', 'Scenario.open', 'Scenario.dispose', ...data.helpers]);
  if (v.kind === 'source-bootstrap' && env.name.startsWith('legacy-'))
    helperIds.add('scenario.' + (v.args.kind === 'evidence' ? 'C11' : 'D08'));
  // All invoked Scenario/source helpers, including setup, schema, hold races,
  // active-call tracking, evidence checks and finalizer disposal, are explicit.
  for (const helper of helperIds) {
    const definition = astNodes.get(helper); assert(definition, helper);
    const nested = callData([definition.node], definition.path, env);
    for (const id of nested.helpers) helperIds.add(id);
  }
  const baseline: any = observed.get(v.id); assert(baseline?.passed && baseline.safetyChecked, 'accepted positive row ' + v.id);
  const material = materialControl(v); assert(controls[material], 'declared material ' + v.id);
  const expectedFailure = expected[v.id]?.expectedReasonPrefix ?? (v.kind === 'source-bootstrap' ? sourceExpectedAssertion(v) : null);
  assert(expectedFailure, 'material assertion ' + v.id);
  const issues = Object.entries(findings).filter(([, ids]) => ids.includes(v.id)).map(([id]) => id);
  const family = families.find((f: any) => f.id === v.family); assert(family, v.family);
  rows.push({id: v.id, family: v.family, kind: v.kind, args: v.args, mandatory: v.mandatory,
    publicClauses: [family.contract, ...(v.kind === 'source-bootstrap' ? ['source-bootstrap.md', 'source-variants.json#' + v.id] : [])],
    familyRequirement: family.requirement, publicExpectation: family.expectation, variantClause: v.clause,
    exactSchedule: v.schedule, predicateUnitIds: selectionIds, helperUnitIds: [...helperIds].sort(),
    ...data, commonDependencyPaths: suitePaths, commonVerdictUnitIds,
    allowedResults: data.predicates.filter(p => /\.(ok|refuse)$/.test(p.call)),
    progressPrerequisites: {publicRule: 'runtime-contract.md: common progress plus R1-R12; exact selected fixture below',
      requiredProgressExpressions: data.predicates.filter(p => /\.ok$/.test(p.call)).map(p => p.expression),
      runtimeDependentPrerequisitesPreservedIn: selectionIds},
    physicalFacts: {observations: data.observations, oracle: 'private/oracle.mjs#inspectSafety',
      responseValidation: 'private/response-schema.mjs#validateResponse'},
    finalizer: {dependency: 'Scenario.dispose', order: ['dispose every Guest', 'Broker.shutdown resumes held operations and clocks', 'join all Scenario calls', 'inspectSafety over completed actual trace'],
      hostFinally: 'private/runtime.mjs: terminate worker then delete only its validated temporary root'},
    material: {name: material, description: controls[material].description, intendedAssertionPrefix: expectedFailure},
    priorPositive: {evidence: priorPath, sourceHash: prior.diagnostics.candidateHash,
      assertions: baseline.assertions, operations: baseline.operations, promiseJobs: baseline.promiseJobs,
      scope: 'Historical exact frozen reference evidence only; does not establish alternative acceptance'},
    equivalenceClass: 'V:' + v.id, witness: {positive: ['reference', 'representation', 'algorithm', 'truthful-outcome'].map(control => ({control, variantId: v.id})),
      material: {control: material, variantId: v.id}, restored: {control: 'reference', variantId: v.id},
      probes: probeClasses.filter(p => p.variants.includes(v.id)).map(p => p.id)},
    targetedCorrectionProof: currentProof.get(v.id) ?? [],
    ...(v.id === 'E02/primary' ? {setupSubsetCoverage: {
      currentBoundary: 'driver.start.before after four prescribed acquisitions; original falsy failure and no relaunch retained',
      relatedRows: ['B13/primary', 'E03/primary', ...['isolation', 'process', 'channel', 'workload'].map(r => 'B07/acquire-intent-' + r)],
      scope: 'Each partial acquisition boundary and post-start crash has its own actual predicate. E02 alone does not stand in for these subsets.',
    }} : {}),
    disposition: issues.length ? correctionPath ? 'controller-ruled correction with targeted runtime proof; independent review and full calibration pending' : 'unjustified reference assumption; calibration pending' : 'public wire/audit and trusted physical facts; source audit only', findings: issues});
}
assert.equal(rows.length, 302); assert.equal(new Set(rows.map(r => r.id)).size, 302);
assert.equal(new Set(rows.map(r => r.family)).size, 69);
assert.equal(new Set(rows.map(r => r.material.name)).size, 61);
assert(rows.every(r => r.predicateUnitIds.length && r.helperUnitIds.includes('Scenario.dispose')));
const ledger = {schemaVersion: 1, method: 'rjs-simplification-audit-1', status: correctionPath ? 'corrected inventory with targeted proof; independent review and complete calibration pending' : 'audit inventory; not qualified',
  freeze: {producer: '.superpowers/sdd/2026-09-08-recoverable-job-service-integration/task-2-integration-assertion-source-freeze-reviewed.json',
    sha256: '80357ec3ab38a59738a74113fe4e2890c5ee53291f1be1868b6c96d0863c4f9e', ...(await scoreInputHashes()),
    priorReferenceEvidenceSha256: sha(priorBytes)},
  selection: effectiveProvenance(), counts: {variants: rows.length, families: 69, materialGroups: 61, predicateEquivalenceClasses: 302, probeClasses: probeClasses.length},
  equivalencePolicy: 'No classes merged. Each exact argument/schedule row is its own class until independent semantic review proves shared predicate/dependency equivalence. No family-prefix inference.',
  correctionEvidence,
  correctionDisposition: correctionPath ? {ruling: '.superpowers/sdd/2026-09-08-recoverable-job-service-integration/calibration-coupling-correction-ruling.md',
    histories: {attachment: 'Prior B06 setup-phase history; one coherent correction', privateRecord: 'Existing representation-independence history; first instrumentation failure retained, one controller-disposed correction',
      rootTiming: 'Mandatory pre-launch boundary; one coherent correction', category: 'Prior A01/A07 categorical history; one coherent correction', reserveProbe: 'CAL-PROBE-RESERVE construction defect; correction 1/3', mappingTool: 'Prior audit mapping correction remains 1/3'},
    pending: ['Independent scoped review', 'Three complete controls/eight probe classes', 'Final public/version identity and mandatory full qualification'],
  } : null,
  reviewLimits: ['AST extraction identifies exact selected clauses and conservative transitive code; it is source review, not runtime proof.',
    'All runtime-dependent branches remain in hashed predicate units. Historical reached assertions supplement, not replace, those branches.',
    correctionPath ? 'The coherent correction has targeted lawful/material/restored evidence only. Final full reference/alternate qualification and independent review remain pending.' : 'Confirmed findings block acceptance. Required alternate/probe runtime witnesses remain pending until root adjudication.'],
  dependencies, units: [...units.values()], oracleAssertions, probeClasses, findings, rows};
await mkdir(dirname(target), {recursive: true});
await writeFile(target, JSON.stringify(ledger, null, 2) + '\n');
console.log(JSON.stringify({target, sha256: sha(await readFile(target)), counts: ledger.counts, confirmedAffectedRows: rows.filter(r => r.findings.length).length}, null, 2));
