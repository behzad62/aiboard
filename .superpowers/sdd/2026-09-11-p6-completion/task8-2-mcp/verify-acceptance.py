"""Verify Task8.2 acceptance from immutable receipts and current repository bytes. No test/process cleanup or Git writes."""
from pathlib import Path
import json,re,hashlib,subprocess,datetime
R=Path(r'D:\repos\ai-discussion-board\.worktrees\runner-v2-robust-build');B=R/'.superpowers/sdd/2026-09-11-p6-completion';D=B/'task8-2-mcp'
def load(p):return json.loads(p.read_text(encoding='utf-8-sig'))
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def verify_inputs(entries):
 bad=[e['path'] for e in entries if not (R/e['path']).is_file() or sha(R/e['path'])!=e['sha256']]
 assert not bad,('source drift',bad)
def counts(text):
 return {k:int(re.findall(r'^# '+k+r' (\d+)$',text,re.M)[-1]) for k in ['tests','pass','fail','cancelled','skipped','todo']}
head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=R,text=True).strip();assert head=='8ef74b463c9087bdc6a9e5947cef7cb2d858615c'
assert not subprocess.check_output(['git','diff','--cached','--name-only'],cwd=R,text=True).strip(),'Index must be unchanged before staging'
protected=load(D/'resume-protected-inputs.json');verify_inputs(protected['files']);assert len(protected['files'])==222
final=load(B/'task82-final-delta-terminal.json');assert final['exitCode']==0 and final['sourcesUnchanged'];verify_inputs(load(B/'task82-final-delta-sources-after.json'))
text=(B/'task82-final-delta.tap.log').read_text(encoding='utf-8');c=counts(text);assert c==dict(tests=503,**{'pass':503},fail=0,cancelled=0,skipped=0,todo=0)
required=['CLI closes discovery without launching live MCP','MCP discovery close during-launch','MCP real host stays lazy','strict public MCP uses','public MCP manager crash recovery','MCP schema replacement retires every live','MCP processes an already pending schema invalidation','round4 startup retains its original semantic deadline after 20ms','MCP request scope sqlite','MCP isolation cleanup ownership durable-transfer','real persistent output stays private between calls and spill failure','MCP worker architect and subagent loops explicitly join','MCP RPC never reports success or replays after a write rejection']
for title in required:assert re.search(r'^ok \d+ - '+re.escape(title),text,re.M),('missing required case',title)
broad=load(B/'task82-affected1-terminal.json');assert broad['sourcesUnchanged']
broadtext=(B/'task82-affected1.tap.log').read_text(encoding='utf-8');bc=counts(broadtext);assert bc==dict(tests=1927,**{'pass':1924},fail=2,cancelled=0,skipped=1,todo=0)
expectedDelta=set(load(D/'final-delta-impact.json')['modifiedAcceptedInputs'])
actualDelta={e['path'] for e in load(B/'task82-affected1-sources-after.json') if sha(R/e['path'])!=e['sha256']}
assert actualDelta==expectedDelta,(actualDelta,expectedDelta)
linux=load(D/'linux-mcp-final-terminal.json');assert linux['exitCode']==0 and linux['containerRemoved'] and linux['sourcesUnchanged'] and linux['tmpCopyExit']==0
verify_inputs(load(D/'linux-mcp-final-source-manifest.json'))
lt=(D/'linux-mcp-final.tap.log').read_text(encoding='utf-8');assert [int(x) for x in re.findall(r'^# pass (\d+)$',lt,re.M)]==[117,14,1]
assert re.search(r'^ok 1 - POSIX native session fixture owns descendants after launcher exit',lt,re.M)
assert re.findall(r'^# fail (\d+)$',lt,re.M)==['0','0','0']
static=load(D/'static-final-terminal.json');assert static['sourcesUnchanged'] and all(x['exitCode']==0 for x in static['checks']);verify_inputs(static['sourceInputs'])
material=load(D/'material-accepted.json');assert material['detected']==material['planned']==16 and material['sourcesRestored'];verify_inputs(load(D/'material-source-baseline.json'))
for fault in material['cases']:
 log=D/('material-'+fault['label']+'.tap.log');s=log.read_text(encoding='utf-8');assert 'not ok ' in s and ('ERR_ASSERTION' in s or fault['label']=='exact-first-authorization' and "code: 'authorization_forged'" in s)
resources=load(D/'resource-observations.json');rr=resources['accepted']['task82-final-delta'];assert rr['acquiredRoots']==518 and rr['retainedNow']==0
assert all(not Path(row['path']).exists() for row in rr['roots'])
retained=[row for row in resources['accepted']['task82-affected1']['roots'] if row['existsNow']]
assert len(retained)==57
for row in retained:
 if Path(row['path']).name.startswith('c2r9-'):row['classification']='unchanged C2 round9 synthetic/no-native-execution fixture; intentionally retained by that test'
 else:
  assert not row.get('backendWitnesses') and all(all(n==0 for n in db['tables'].values()) for db in row.get('databases',[]))
  row['classification']='closed no-public-launch diagnostic; read-only process/session tables empty; not a cleanup-by-PID inference'
historical=resources['priorFailedNativeGateRetentions'];witnesses=[row for row in historical if row.get('backendWitnesses')]
ledger=dict(observedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),finalWindows={'created':518,'absent':518,'retained':0,'authority':'successful tests verify owned cleanup before removal; observer/current absence is supplementary, never sole proof'},broadRunRetainedDiagnostics=retained,priorFailedRoots=len(historical),priorNativeWitnesses=witnesses,historicalDisposition='Preserve original failed gates and exact roots. Three older cleanup-blocked native sessions have stopped durable workload state but are NOT claimed released; no historical signals, deletion, retries or state rewriting performed.',linuxContainerRemoved=True)
(D/'accepted-resource-ledger.json').write_text(json.dumps(ledger,indent=2),encoding='utf-8')
changed=set(subprocess.check_output(['git','diff','--name-only','--','runner-v2'],cwd=R,text=True).splitlines()+subprocess.check_output(['git','ls-files','--others','--exclude-standard','--','runner-v2'],cwd=R,text=True).splitlines())
assert all(p.startswith('runner-v2/') for p in changed)
source=[dict(path=p.relative_to(R).as_posix(),sha256=sha(p)) for base in ['runner-v2/src','runner-v2/test'] for p in sorted((R/base).rglob('*')) if p.is_file()]
source.append(dict(path='runner-v2/MCP.md',sha256=sha(R/'runner-v2/MCP.md')))
(D/'accepted-inputs.json').write_text(json.dumps(source,indent=2),encoding='utf-8')
receiptFiles=[B/'task82-affected1-terminal.json',B/'task82-affected1.tap.log',B/'task82-final-delta-terminal.json',B/'task82-final-delta.tap.log',D/'linux-mcp-final-terminal.json',D/'linux-mcp-final.tap.log',D/'static-final-terminal.json',D/'material-accepted.json',D/'material-source-baseline.json',D/'resource-observations.json']+[D/('material-'+x['label']+'.tap.log') for x in material['cases']]
evidence=[dict(path=p.relative_to(R).as_posix(),sha256=sha(p)) for p in receiptFiles]
(D/'evidence-index.json').write_text(json.dumps(evidence,indent=2),encoding='utf-8')
result=dict(verifiedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),status='TASK 8.2 VERIFIED COMPLETE — TASK 8.3 LSP MAY BEGIN',baseCommit=head,Task82Complete=True,P6Complete=False,P6_5Unlocked=False,nextTask='8.3 LSP',laterTasksStarted=False,selfReviewAccepted=True,independentReviewRequired=False,windowsFinal=c,windowsFinalCompleteTestFiles=len(load(D/'final-delta-spec.json')['tests']),broaderPriorCounts=bc,broaderPriorFindingsCorrectedAndReverified=True,broaderOriginalSnapshotDrift=sorted(actualDelta),linuxPassed=132,linuxScope=linux['scope'],materialFaultsDetected=16,staticChecks=[dict(name=x['name'],exitCode=x['exitCode']) for x in static['checks']],acceptedInputs=len(source),protectedFilesUnchanged=222,finalWindowsAcquisitions=518,finalWindowsRetentions=0,historicalCleanupExclusions=3,historicalExclusionsNotClaimedReleased=True,changedRunnerFiles=sorted(changed),pushed=False,report='task8-2-mcp/report.md')
(D/'task8-2-gate.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
print(json.dumps({k:v for k,v in result.items() if k!='changedRunnerFiles'},indent=2))
