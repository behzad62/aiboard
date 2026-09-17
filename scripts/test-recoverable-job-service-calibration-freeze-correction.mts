import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyFile, mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {scoreInputHashes} from '../benchmarks/recoverable-job-service/private/identity.mjs';
import {LIMITS} from '../benchmarks/recoverable-job-service/private/broker.mjs';

const packet = '.superpowers/sdd/2026-09-08-recoverable-job-service-integration';
const base = 'benchmarks/recoverable-job-service/private/calibration';
const proofDir = join(base, 'correction-proof-2026-09-12T17-06-54-031Z');
const reserveDir = join(base, 'correction-proof-2026-09-12T17-14-13-149Z');
const ledgerPath = join(base, 'predicate-dependency-ledger-corrected.json');
const freezePath = join(base, 'correction-source-freeze.json');
const reportPath = join(packet, 'calibration-coupling-correction-report.md');
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const file = async (path: string) => {const bytes = await readFile(path); return {path: path.replaceAll('\\', '/'), bytes: bytes.length, sha256: sha(bytes)};};
const identity = await scoreInputHashes(), proof = await json(join(proofDir, 'summary.json')), reserve = await json(join(reserveDir, 'summary.json'));
assert.deepEqual(proof.identity, identity); assert.deepEqual(reserve.identity, identity); assert(reserve.passed);
assert.deepEqual(proof.checks.filter((c: any) => !c.passed).map((c: any) => c.label), ['forbidden-attach-reserve: B06/primary exact forbidden predicate', 'reserve: forbidden neighbor issued an actual attachment']);
const ledger = await json(ledgerPath);
assert.equal(ledger.counts.variants, 302); assert.equal(ledger.counts.families, 69); assert.equal(ledger.counts.materialGroups, 61);
const changed = ['benchmarks/recoverable-job-service/private/scenarios.mjs', 'benchmarks/recoverable-job-service/private/variants.mjs', 'benchmarks/recoverable-job-service/private/control-expectations.json'];
const producerPath = join(packet, 'task-2-integration-assertion-source-freeze-reviewed.json');
const producer = await json(producerPath), producerFiles = [];
for (const entry of producer.files) {
  const current = await file(entry.path);
  if (!changed.includes(entry.path)) assert.equal(current.sha256, entry.sha256, 'preserve producer source: ' + entry.path);
  producerFiles.push({...current, beforeSha256: entry.sha256, changed: current.sha256 !== entry.sha256});
}
assert.equal(producerFiles.filter(f => f.changed).length, 3);
const beforeExpected = join(base, 'control-expectations-before-correction-2026-09-12T17-08.json');
assert.equal((await file(beforeExpected)).sha256, '15f2e6b1f113262f33e2402f4df1d120ad4799f08458ecc937f824713048213c');
const originalExpectations = await json(beforeExpected), currentExpectations = await json(changed[2]);
const changedExpectations = Object.keys(originalExpectations).filter(id => JSON.stringify(originalExpectations[id]) !== JSON.stringify(currentExpectations[id]));
assert.deepEqual(changedExpectations, ['C09/restore-store.commit.before', 'C09/restore-store.commit.after']);
const sourceScripts = (await readdir('scripts')).filter(name => name.startsWith('test-recoverable-job-service-calibration') && name.endsWith('.mts')).map(name => 'scripts/' + name);
for (const path of [...changed, ...sourceScripts]) {const destination = join(base, 'correction-frozen-source', path); await mkdir(dirname(destination), {recursive: true}); await copyFile(path, destination);}
const paths: string[] = [...changed, ...sourceScripts];
async function walk(path: string) {for (const entry of await readdir(path, {withFileTypes: true})) {const next = join(path, entry.name); if (entry.isDirectory()) await walk(next); else if (entry.isFile() && next.replaceAll('\\','/') !== freezePath) paths.push(next);}}
await walk(base);
const runs = [...proof.runs.filter((r: any) => r.name !== 'forbidden-attach-reserve'), ...reserve.runs];
const measuredRows: any[] = [];
for (const [directory, summaries] of [[proofDir, proof.runs], [reserveDir, reserve.runs]] as const)
  for (const run of summaries) {if (directory === proofDir && run.name === 'forbidden-attach-reserve') continue; const r = await json(join(directory, run.name + '.result.json')); measuredRows.push(...r.families.flatMap((f: any) => f.variants));}
const files = await Promise.all([...new Set(paths.map(p => p.replaceAll('\\','/')))].sort().map(file));
const manifest = {schemaVersion: 1, status: 'scoped correction freeze; independent review and CAL01-05 pending', frozenAt: new Date().toISOString(),
  node: process.versions.node, quickjs: '0.32.0', identity, versions: {contract: 'rjs-contract-2.0.0', suite: 'rjs-suite-2.0.0'},
  producer: await file(producerPath), producerFiles, changedSourcePaths: changed,
  expectationChanges: changedExpectations.map(id => ({id, before: originalExpectations[id], after: currentExpectations[id]})),
  effectiveProof: {runs: runs.length, selected: measuredRows.length, passedLawful: measuredRows.filter(r => r.passed).length,
    rejectedNeighbors: measuredRows.filter(r => !r.passed).length, skipped: measuredRows.filter(r => !r.safetyChecked).length,
    maximumOperationsPerCase: Math.max(...measuredRows.map(r => r.operations)), maximumPromiseJobsPerCase: Math.max(...measuredRows.map(r => r.promiseJobs)),
    source: await file(join(proofDir, 'summary.json')), reserveReplacement: await file(join(reserveDir, 'summary.json'))},
  configuredLimits: LIMITS, files};
await writeFile(freezePath, JSON.stringify(manifest, null, 2) + '\n');
const freeze = await file(freezePath), ledgerFile = await file(ledgerPath);
const changedRows = producerFiles.filter(f => f.changed).map(f => `| ${f.path} | ${f.beforeSha256} | ${f.sha256} |`).join('\n');
const report = `# Calibration coupling correction — scoped evidence report

Status: **one controller-disposed scorer batch implemented; targeted proof complete; independent scoped review and CAL01–05 remain pending.** This report does not admit scoring or assert full production qualification. Implementation ownership remains with rjs_calibration_implementation for the already-authorized private complete-control/probe work; the three scorer files below are frozen for review.

Authority: calibration-coupling-correction-ruling.md, followed by root dispositions b8579d (one diagnosed C09 instrumentation correction), 6fee84 (exactly two C09 material expectation rows), and 8bf37e (one reserve-neighbor construction correction). The launch brief/amendment still govern the remaining packet. Every shell command used D:/repos/ai-discussion-board/.worktrees/runner-v2-robust-build. There were no subagents, provider/model calls, native workloads, staging, commits, publication, archive edits, or isolated independent-candidate access.

## Frozen scope and identities

- Scoped source/evidence manifest: ${freeze.path}, SHA256 **${freeze.sha256}**, ${files.length} exact file entries. Review source copies are under private/calibration/correction-frozen-source/ with their original relative paths.
- Corrected finite ledger: ${ledgerFile.path}, SHA256 **${ledgerFile.sha256}**. It retains 302 exact rows/classes, 69 families, 61 unchanged material selectors, eight probe classes and the historical source/evidence mapping. Every affected row now includes actual targeted positive/material/restored assertions. Full controls and independent acceptance remain pending.
- Contract rjs-contract-2.0.0 / suite rjs-suite-2.0.0; contract hash ${identity.contractHash}; corrected suite hash ${identity.suiteHash}. Final 2.0.1 public/method/version generation has not begun. All 11 public files and public recipes remain unchanged.
- The original 80-file producer manifest is ${manifest.producer.sha256}; all 80 were checked: exactly the authorized three files changed and the other 77 match byte for byte. Reference remains 6a5b142037c60fb9ab480ccd64f307f556685be755878df0aa1ec39d3ceb1cf0. UI, Runner, shared/public/package and runtime/broker/oracle/reference behavior were preserved.
- Material expectation before-copy: ${beforeExpected.replaceAll('\\','/')}, SHA256 15f2e6b1f113262f33e2402f4df1d120ad4799f08458ecc937f824713048213c. It was copied and checked before editing. Root's calibration-audit-before-correction content copies retain original scenarios/variants and the earlier audit packet.

| Source | Before SHA256 | After SHA256 |
| --- | --- | --- |
${changedRows}

The only production edits are two Scenario helpers plus E02 in scenarios.mjs, four attachment schedules/two restore schedules/four categorical rows in variants.mjs, and the two named expectation rows. The separately hashed correction-*.diff files compare against preserved content, not a hash-only manifest. New scripts/ledger/evidence are private calibration support; their complete file inventory is in the manifest.

## Actual corrections and non-vacuous proof

**CAL-SCHEDULE-ATTACH — prior B06 phase history.** The actual attachment fault is armed before setup and remains armed through cleanup. startThenStop inspects whichever real public request encounters it; job/setup identity comes from its public setup-intent audit. Setup/deferred designs both reach the same scheduled attachment. Falsy rejection presence, the original deadline, no expired attachment effect, crash/reopen reconciliation, exact two releases, one final evidence audit and retirement of an actual authenticated attachment remain asserted. The actual reference and setup-reader variant pairs pass; discarded receipt and omitted diagnostic neighbors fail the intended pre-existing assertions. The direct B07 traces retain real attach/detach receipt identity and finality facts. The setup-reader is the original complete reference-derived witness 0f9af49f2f4679e1a0aee684b2820e3b63e7aace80319225bb5b76a1bbdf0963.

The expired-entry neighbor actually performs one attachment using a refreshed effect fence after its original request deadline, then fails B06 at expired entry issues no attach. The reserve neighbor's corrected source b9383530a5dfa7f39d8216ca2a0d2fbd16c9fc9e8eed32e627bb6c8fd38d6ecb preserves the public stop deadline 1000 and grant expiry 1050, deliberately supplies a short effect fence (now+1), physically installs one authenticated reader, returns the actual lease refusal and fails B06 at insufficient reserve issues no work. Its private trace retains the original request, actual fence, receipt and count. These are intentionally forbidden controls, not lawful alternatives.

**CAL-SCHEDULE-PRIVATE-RECORD — existing representation independence history.** C09 now holds the first actual requested store.commit.before/after boundary during restore. It imposes neither private field names nor an empty audit nor artifact-read-before-commit ordering. A request-local durable marker is a legitimate crash boundary; recovery/retry must then execute restore, preserve the exact manifest digest and finality, expose exact retained bytes, and retain one accepted audit. Direct traces locate the actual hold inside restore, show the old guest being disposed and the new restore/evidence calls completing. The envelope witness a6d8411c20f253e4982cbc3ab35db4536b29941b7f6cdef05c4086efef3f3d7b passes the same predicates with all store values wrapped.

Both C09 omit-evidence-write neighbors now reach the actual storage hold, reopen and attempt the real restore; restore then refuses with integrity because the artifact bytes were never written. The causal oracle also reports evidence-before-acceptance. The exact two old expected prefixes were candidate reached lawful store.commit.before/after; safety: evidence-before-acceptance. The new prefixes are restore must progress, which match the observed restore refusal while retaining the same material selector and safety finding. The targeted harness separately requires hold reach, the missing-byte safety finding and the actual public integrity refusal. No unrelated setup/schema/watchdog failure supplies this proof.

**CAL-SCHEDULE-ROOT-TIMING.** E02 injects the original falsy zero rejection at mandatory driver.start.before after all four prescribed acquisitions, then proves failure presence, addressable recovery, zero launches and exactly two releases. Both eager and lazy-root witnesses pass. The lazy witness 6721011cdaeaa9ce543c2cc51069d2a8dd7f736b89977ec226cf7b726410a29d creates retained storage only for actual healthy payload and omits optional scratch storage. C01/E08 positive checks establish actual retention/reclamation behavior. The related B07 acquisition-intent rows for isolation/process/channel/workload, B13 partial setup and E03 post-start crash were executed explicitly (not credited to E02 alone). Relaunch-on-recovery fails at all acquired setup owners close without launching for reference and lazy designs.

**CAL-CATEGORY-NONRANGE — prior A01/A07 category history.** Stream, digest, artifactId and channelId mutations now require integrity. Four intentionally wrong gap neighbors fail exactly at poll categorical blocker. Their actual driver.readChannel traces retain seq=0, offset=0, length=3 and three bytes, establishing no missing or overlapping range. The real sequence/offset mutations still accept either documented gap or integrity; both corresponding outcome controls pass. This conditional outcome witness is only lawful for the demonstrated range mutations and is not called a complete correct control.

## Runtime accounting and evidence

Main evidence: ${proofDir.replaceAll('\\','/')}/. Its summary hash is ${manifest.effectiveProof.source.sha256}. The original run executed 86 bounded variant rows in 23 groups, plus 24 supplementary actual-predicate traces; it ended nonzero only because the first reserve neighbor produced no attachment. All other checks passed. The failed generated neighbor and exact failed harness are retained. Replacement evidence: ${reserveDir.replaceAll('\\','/')}/, summary hash ${manifest.effectiveProof.reserveReplacement.sha256}; it reran exactly one bounded reserve row and its one direct trace, exit 0, with the same scorer/public identity. No unaffected broad run was repeated.

The effective combined proof has **${manifest.effectiveProof.selected} executed rows: ${manifest.effectiveProof.passedLawful} lawful/restored passes, ${manifest.effectiveProof.rejectedNeighbors} intended rejections, zero skipped**, over ${manifest.effectiveProof.runs} groups. This comprises 40 initial lawful rows, 18/18 intended material faults, 18/18 restored rows, four lawful range alternatives, four forbidden non-range categories and two actual forbidden attachment effects. The 24 effective direct traces establish request boundaries, receipts, audit consequences and cleanup. Negative safety findings are expected only where the fault actually violates evidence-before-acceptance. Candidate compilation, setup failure and timeout were never accepted as material proof.

Execution used exact Node ${process.versions.node}, QuickJS 0.32.0, the existing production configuration, 60,000 ms per-case/600,000 ms whole-run limits and unchanged 1,025-job default; these were targeted selections, not whole qualification. Measured maxima in the bounded rows were ${manifest.effectiveProof.maximumOperationsPerCase} operations and ${manifest.effectiveProof.maximumPromiseJobsPerCase} promise jobs. The manifest records unchanged configured limits separately. The 1,100-job capacity run, full 302/302/302 qualification, three full 302 alternate positives and 78 public recipes are still pending on final 2.0.1 bytes.

Each bounded invocation persisted replay-input.private.json before execution, retained its actual private callback tape and checked replayInputFromRecord against that input. Supplementary traces used the same input/schedule and kept actual public calls/effects/audits. evaluateBounded returned after worker termination and its validated temporary-root cleanup. Every direct trace reports allGuestsDisposed=true and remainingTrackedCalls=0. All launched commands and worker sessions ended before this freeze; no heavy process remains.

## Exact command outcomes and preserved history

All commands below used the D: workdir. Logs are in private/calibration/.

| Command | Exit / evidence |
| --- | --- |
| node --import tsx scripts/test-recoverable-job-service-calibration-attachment.mts | 0; correction-attachment.log; reference/setup-reader 6/6 each on first correction identity |
| node --import tsx scripts/test-recoverable-job-service-calibration-representation.mts (first correction) | 1; correction-representation.log; reference/envelope each 2/4 because the predicate sought a nonexistent artifact.read return trace |
| node --import tsx scripts/test-recoverable-job-service-calibration-boundaries.mts | 0; correction-boundaries.log; eager/lazy 3/3 each, reference categories 4/4, all four wrong categories rejected |
| node --import tsx scripts/test-recoverable-job-service-calibration-representation.mts (disposed correction) | 0; correction-representation-second.log; reference/envelope 4/4 each |
| node --import tsx scripts/test-recoverable-job-service-calibration-correction.mts | 1; correction-proof.log; complete intended proofs passed except vacuous reserve-neighbor construction |
| node --import tsx scripts/test-recoverable-job-service-calibration-correction.mts --reserve-only | 0; correction-reserve-only.log; one corrected real reserve effect rejected |
| node --import tsx scripts/test-recoverable-job-service-calibration-ledger.mts --correction-proof ${proofDir.replaceAll('\\','/')} --reserve-proof ${reserveDir.replaceAll('\\','/')} | 0; correction-ledger.log; exact 302/69/61/302/8 and current identity assertions |
| node --import tsx scripts/test-recoverable-job-service-calibration-preserve-correction.mts | First identity check 1, then 0 after restoring the original import line's CRLF; correction-preservation.log; failed source byte identity verified against actually executed d15057f4 suite hash |
| node --import tsx scripts/test-recoverable-job-service-calibration-freeze-correction.mts | Generates this report and verified source/evidence manifest after all runtime commands ended |
| git diff --no-index for the three named scorer files against content copies | 1 means expected differences; retained three correction-*.diff artifacts |

The first C09 scorer attempt is retained at representation-counterexample-2026-09-12T16-56-39-211Z, including both failed results, inputs/tapes/traces and exact verified-attempt-source/ bytes. The original executed suite identity was d15057f4086ee07060d8872d1581e6eefd6858eedb99f949ee12c93c342d622d. A preservation-only checksum initially disagreed because the replaced import line originally retained CRLF; the bounded byte-layout diagnostic found the exact original, and the complete ordered suite hash now matches that actual result. This was bookkeeping and changed no scorer behavior or acceptance predicate.

The four original audit counterexamples and parent audit freeze remain preserved. Histories are not reset: setup attachment stays attached to prior B06 phase assumptions; C09 stays in representation-independence history with one explicitly disposed instrumentation follow-up; category stays attached to prior A01/A07 adjudication; E02 is the one ruled boundary change. The audit ledger mapping correction remains 1/3. CAL-PROBE-RESERVE records construction attempt 1 and correction 1/3; its vacuous evidence is retained, not counted as negative proof. No new scorer repair budget is claimed.

## Remaining packet

No confirmed coupling in the consolidated 11-row batch is left without targeted lawful/forbidden/material/restored proof. Acceptance still requires independent scoped review and the original CAL01–05 full packet. Next work is the three actual complete reference-derived controls and eight fully mapped probe classes. Their generated identities must precede the final public/method/version freeze and coordinated heavy window. No whole production run has started and no admission, UI, package, Runner or reference/runtime changes are included here.
`;
await writeFile(reportPath, report);
console.log(JSON.stringify({freeze, ledger: ledgerFile, report: await file(reportPath), effectiveProof: manifest.effectiveProof, producerPreserved: 77, producerChanged: 3}, null, 2));
