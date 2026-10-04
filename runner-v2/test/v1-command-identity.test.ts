import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter, dirname, relative } from "node:path";
import { createChildEnvironmentFactory } from "../src/child-environment.js";
import { createChangeSet } from "../src/change-set.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { runGit, runGitBytes } from "./support/git-fixture.js";
import type { EvidenceRecord } from "../src/evidence-store.js";

test("V1 runner-only PATH and npm environment scrub", () => {
  const runner = join(tmpdir(), "v1-runner-install");
  const system = dirname(process.execPath);
  const factory = createChildEnvironmentFactory({ credentialResolver: { consume: () => { throw new Error("no grant"); } }, runnerInstallRoot: runner });
  const prepared = factory.prepare({ ambient: { Path: [join(runner, "node_modules", ".bin"), system].join(delimiter), npm_config_cache: "private", INIT_CWD: runner } });
  factory.withChildEnvironment(prepared.capability, (env) => {
    assert.equal(env.npm_config_cache, undefined);
    assert.equal(env.INIT_CWD, undefined);
    assert.equal(env.Path, system);
  });
  assert.ok(prepared.audit.decisions.some((decision) => decision.kind === "removed_ambient" && decision.name === "npm_config_cache"));
});

for (const editAfter of [false,true]) test(`V1 ${editAfter?"stale link after later tree edit":"same-tree current link"} preserves original evidence`, async () => {
  const root = mkdtempSync(join(tmpdir(), "v1-tree-red-")); const project = join(root, "project"); mkdirSync(project);
  try {
    await runGit({cwd: project, args: ["init"]}); writeFileSync(join(project, "value.txt"), "before\n");
    await runGit({cwd: project, args: ["add", "-A"]}); await runGit({cwd: project, args: ["commit", "-m", "base"]});
    const base = (await runGit({cwd: project,args:["rev-parse","HEAD"]})).stdout.trim();
    const tree = (await runGit({cwd: project,args:["rev-parse","HEAD^{tree}"]})).stdout.trim();
    const artifacts = new ArtifactStore(join(root,"artifacts")); const out = await artifacts.put(Buffer.from("pass"),"text/plain","tests");
    const record = {status:"observed",idempotencyKey:"e1",id:"e1",runId:"r",taskId:"T1",attempt:1,actor:{role:"worker",id:"w"},createdAt:"2026-10-05T00:00:00Z",fact:{kind:"command",label:"tests",command:"node",args:[],cwd:project,startedAt:"2026-10-05T00:00:00Z",finishedAt:"2026-10-05T00:00:00Z",exitCode:0,signal:null,timedOut:false,cancelled:false,outputTruncated:false,stdoutArtifactHash:out.hash,stderrArtifactHash:out.hash,workingTreeIdentity:{status:"known",treeId:tree}}} as EvidenceRecord;
    if (editAfter) {writeFileSync(join(project,"value.txt"),"after\n"); await runGit({cwd:project,args:["add","-A"]}); await runGit({cwd:project,args:["commit","-m","candidate"]});}
    const revision=(await runGit({cwd:project,args:["rev-parse","HEAD"]})).stdout.trim();
    const change=await createChangeSet({execute:runGit,workspacePath:project,artifacts,taskCommit:{runId:"r",taskId:"T1",baselineRevision:base,revision,commits:[revision],changedPaths:["value.txt"]},acceptanceCriteria:[{id:"c",text:"pass"}],criterionEvidenceLinks:[{criterionId:"c",evidenceId:"e1",artifactHashes:[out.hash],freshness:{status:"current",submittedTreeId:"forged"}}],evidenceRecords:[record],attempt:1,assignedWorkerId:"w"});
    assert.equal((change.criterionEvidenceLinks![0] as unknown as {freshness?:{status:string}}).freshness?.status,editAfter?"stale":"current");
    assert.equal((record.fact as unknown as {workingTreeIdentity:{treeId:string}}).workingTreeIdentity.treeId,tree);
    const options={execute:runGit,workspacePath:project,artifacts,taskCommit:{runId:"r",taskId:"T1",baselineRevision:base,revision,commits:[revision],changedPaths:["value.txt"]},acceptanceCriteria:[{id:"c",text:"pass"}],criterionEvidenceLinks:[{criterionId:"c",evidenceId:"e1",artifactHashes:[out.hash]}],evidenceRecords:[record],attempt:1,assignedWorkerId:"w"};
    if (!editAfter && record.fact.kind==="command") {
      record.fact.workingTreeIdentity={status:"unknown",reason:"capture_failed"};
      assert.equal((await createChangeSet(options)).criterionEvidenceLinks![0]!.freshness?.status,"unknown");
      delete record.fact.workingTreeIdentity;
      assert.equal((await createChangeSet(options)).criterionEvidenceLinks![0]!.freshness,undefined,"historical absent identity shape is preserved");
    }
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("V1 temporary-index identity captures dirty full tree, preserves index and cleans parallel snapshots", async () => {
  const { createRunGitExecutionContext, gitWorkingRootsForRun } = await import("../src/git-run-context.js");
  const { createExecutionGrantAuthority } = await import("../src/execution-grants.js");
  const root=mkdtempSync(join(tmpdir(),"v1-owned-tree-")); const project=join(root,"project"); const state=join(root,"state"); mkdirSync(project);mkdirSync(state);
  let privateEffects=0;
  let closed=false;let authorityNow=Date.now();let raceMode: "revoke"|"cancel"|"expire"|"close"|undefined;let racingAbort:AbortController|undefined;
  let cancelDuringIdentityIssue=false; let parentToRevoke: import("../src/execution-grants.js").OpaqueExecutionGrant | undefined;
  const authority=createExecutionGrantAuthority({clock:()=>new Date(authorityNow),beforeIssueCommit:async()=>{if(cancelDuringIdentityIssue && parentToRevoke){cancelDuringIdentityIssue=false;if(raceMode==="revoke") await authority.revoke(parentToRevoke,"cancelled");if(raceMode==="cancel")racingAbort!.abort();if(raceMode==="expire")authorityNow+=120001;if(raceMode==="close")closed=true;}}});
  const contexts: import("../src/agent-contracts.js").ToolExecutionContext[]=[];
  try {
    await runGit({cwd:project,args:["init"]}); await runGit({cwd:project,args:["config","core.autocrlf","false"]});
    writeFileSync(join(project,"value.txt"),"before\n");await runGit({cwd:project,args:["add","-A"]});await runGit({cwd:project,args:["commit","-m","base"]});
    writeFileSync(join(project,"value.txt"),"staged\n"); await runGit({cwd:project,args:["add","value.txt"]});
    const ownerIndex=readFileSync(join(project,".git","index"));
    writeFileSync(join(project,"value.txt"),"dirty\n");writeFileSync(join(project,"untracked.txt"),"untracked\r\n");
    const execution: import("../src/one-shot-command-executor.js").OneShotCommandExecutor = {execute:async(request)=> {
      if(request.context.toolName==="runner.git.identity")privateEffects++;
      if (!request.context.executionGrant) throw new Error("fixture requires grant");
      authority.consume(request.context.executionGrant,{...request.context,permissionProfile:"full"});
      const joined=await runGitBytes({cwd:request.workingDirectory,args:request.arguments,env:request.explicitEnvironment,allowFailure:true});
      const stdout=joined.stdout;const stderr=Buffer.from(joined.stderr);
      return {enforcement:"unconfined_explicit_full",disclosure:"unconfined_explicit_full",capturedOutput:{stdout,stderr,complete:true},process:{logicalProcessId:request.context.callId,outcome:"exited",exitCode:joined.exitCode,finishedAt:new Date().toISOString(),cleanup:{state:"verified_empty",verifiedAt:new Date().toISOString()},output:(["stdout","stderr"] as const).map((stream)=>{const bytes=stream==="stdout"?stdout:stderr;return {stream,tail:bytes.toString(),totalBytes:bytes.length,truncated:false,spillBytes:0,lossyBytes:0};})}} as import("../src/one-shot-command-executor.js").OneShotCommandResult;
    }};
    const git=createRunGitExecutionContext({runId:"r",projectRoot:project,stateDirectory:state,permissionProfile:"full",execution,executionGrants:authority,artifacts:{stat:async()=>{throw new Error("unused");},get:async()=>{throw new Error("unused");}},assertOpen:()=>{if(closed)throw new Error("run closed");}});
    const context=async(callId:string,path=project,signal?:AbortSignal)=> {
      const binding={runId:"r",sessionId:"s",actor:{role:"worker" as const,id:"w"},callId,toolName:"run_evidence_command",permissionProfile:"full" as const};
      const executionGrant=await authority.issue({...binding,workspacePath:project,access:[{path,mode:"write"}],externalApproved:false,destructiveApproved:false,networkApproved:false,credentialNames:[]});
      const value={...binding,workspacePath:project,executionGrant,...(signal?{signal}:{})};contexts.push(value);return value;
    };
    const [first,second]=await Promise.all([context("a"),context("b")]);
    const snapshots=await Promise.all([git.workingTreeForCall!(first,project),git.workingTreeForCall!(second,project)]);
    assert.equal(snapshots[0]!.status,"known");assert.deepEqual(snapshots[0],snapshots[1]);
    assert.deepEqual(readFileSync(join(project,".git","index")),ownerIndex);
    const captured=snapshots[0]!;
    if(captured.status==="known") assert.equal((await runGit({cwd:project,args:["show",`${captured.treeId}:value.txt`]})).stdout,"dirty\n");
    const indexRoot=gitWorkingRootsForRun(project,state,"r").at(-1)!;assert.deepEqual(readdirSync(indexRoot),[]);
    mkdirSync(join(project,"sub")); const subContext=await context("sub",join(project,"sub"));
    assert.equal((await git.workingTreeForCall!(subContext,join(project,"sub"))).status,"unknown","subdirectory grants cannot omit dirty files outside their scope and claim a complete tree");
    writeFileSync(join(project,"value.txt"),"later\n");const changed=await git.workingTreeForCall!(await context("later"),project);
    assert.equal(changed.status,"known");assert.notDeepEqual(captured,changed);
    assert.deepEqual(readFileSync(join(project,".git","index")),ownerIndex);assert.deepEqual(readdirSync(indexRoot),[]);
    for(const mode of ["revoke","cancel","expire","close"] as const) {
      closed=false;authorityNow=Date.now();racingAbort=new AbortController();const racing=await context(`racing-${mode}`,project,racingAbort.signal);parentToRevoke=racing.executionGrant;raceMode=mode;cancelDuringIdentityIssue=true;const effectsBefore=privateEffects;
      assert.equal((await git.workingTreeForCall!(racing,project)).status,"unknown",`${mode} during private grant issue denies every identity effect`);
      assert.equal(privateEffects,effectsBefore,`${mode} launches no private Git effect after authority loss`);
      assert.deepEqual(readdirSync(indexRoot),[]);
      await authority.revoke(racing.executionGrant!,"cleanup");
    }
    closed=false;authorityNow=Date.now();
    await authority.revoke(first.executionGrant!,"cancelled");assert.equal((await git.workingTreeForCall!(first,project)).status,"unknown");
  } finally {await authority.revokeAll("cleanup");rmSync(root,{recursive:true,force:true});}
});

test("V1 effective environment fingerprints are immutable, secret safe and incomplete for unsupported runtime/provider", async()=> {
  const {fingerprintChildEnvironment,settleWorkingTreeIdentity}=await import("../src/command-evidence-identity.js");
  const root=mkdtempSync(join(tmpdir(),"v1-fingerprint-"));
  try {
    const input={environment:{PATH:dirname(process.execPath),NODE_OPTIONS:"",API_TOKEN:"never-record-me"},executable:process.execPath,cwd:root};
    const base=await fingerprintChildEnvironment(input);const same=await fingerprintChildEnvironment(input);assert.deepEqual(base,same);assert.equal(base.status,"known");assert.ok(base.fingerprint);assert.doesNotMatch(JSON.stringify(base),/never-record-me/);
    writeFileSync(join(root,"package-lock.json"),"first");const lock=await fingerprintChildEnvironment(input);assert.notEqual(base.fingerprint,lock.fingerprint);
    writeFileSync(join(root,"package-lock.json"),"second");assert.notEqual(lock.fingerprint,(await fingerprintChildEnvironment(input)).fingerprint);
    assert.notEqual(lock.fingerprint,(await fingerprintChildEnvironment({...input,environment:{...input.environment,NODE_OPTIONS:"--no-warnings"}})).fingerprint);
    assert.notEqual(lock.fingerprint,(await fingerprintChildEnvironment({...input,environment:{...input.environment,API_TOKEN:"changed-secret"}})).fingerprint);
    const python=await fingerprintChildEnvironment({...input,executable:"python"});assert.equal(python.status,"unknown");assert.equal(python.runtime,undefined);assert.equal(python.fingerprint,undefined);
    const provider=await fingerprintChildEnvironment({...input,provider:{providerId:"oci",implementationDigest:"a".repeat(64),immutableImageId:"sha256:image"}});assert.equal(provider.status,"unknown");assert.equal(provider.runtime,undefined);assert.equal(provider.environmentDigest,undefined);assert.ok(provider.preparedEnvironmentDigest);assert.equal(provider.fingerprint,undefined);
    const before={status:"known" as const,treeId:"a".repeat(40)};const after={status:"known" as const,treeId:"b".repeat(40)};
    assert.deepEqual(settleWorkingTreeIdentity(before,before),before);const edited=settleWorkingTreeIdentity(before,after);assert.equal(edited.status,"unknown");if(edited.status==="unknown"){assert.equal(edited.capturedTreeId,before.treeId);assert.equal(edited.settledTreeId,after.treeId);}
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("V1 PATH case, explicit override, junction and parent-like in-root names cannot reintroduce runner tools",()=> {
  const root=mkdtempSync(join(tmpdir(),"v1-path-")); const runner=join(root,"runner");const dependencies=join(root,"actual-dependencies");const project=join(root,"project");mkdirSync(runner);mkdirSync(join(dependencies,".bin"),{recursive:true});mkdirSync(join(project,"node_modules",".bin"),{recursive:true});mkdirSync(join(runner,"..tools"));
  try {
    symlinkSync(dependencies,join(runner,"node_modules"),process.platform==="win32"?"junction":"dir");
    const factory=createChildEnvironmentFactory({runnerInstallRoot:runner,credentialResolver:{consume:()=>{throw new Error("no grant");}}});
    const prepared=factory.prepare({workingDirectory:project,ambient:{PATH:dirname(process.execPath),NPM_CONFIG_CACHE:"secret",Init_Cwd:runner,RUNNER_SECRET:"secret",API_TOKEN:"secret"},explicitOverrides:{pAtH:[relative(project,join(dependencies,".bin")),relative(project,join(runner,"..tools")),join(project,"node_modules",".bin"),dirname(process.execPath)].join(delimiter),nPm_config_cache:"secret",INIT_cwd:"secret"}});
    factory.withChildEnvironment(prepared.capability,(env)=>{assert.equal(env.pAtH,[join(project,"node_modules",".bin"),dirname(process.execPath)].join(delimiter));for(const name of ["NPM_CONFIG_CACHE","Init_Cwd","RUNNER_SECRET","API_TOKEN","nPm_config_cache","INIT_cwd"]) assert.equal(env[name],undefined);});
    assert.ok(prepared.audit.decisions.some((entry)=>entry.kind==="removed_runner_path"&&entry.count===2));assert.doesNotMatch(JSON.stringify(prepared.audit),/secret|actual-dependencies/);
    assert.throws(()=>factory.withChildEnvironment(prepared.capability,()=>undefined),/invalid/);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("V1 actual native project child cannot resolve runner-only tsx while system Node/Git paths remain", async()=> {
  const {createExecutionHost}=await import("../src/execution-host.js");
  const {snapshotNativeBuildAmbientEnvironment}=await import("../src/native-build-factory.js");
  const {emptyRunnerCapabilitiesConfig}=await import("../src/runner-capabilities-config.js");
  const {createRunnerCapabilityContract}=await import("../src/runner-capability-contract.js");
  const {outputFor}=await import("../src/one-shot-command-executor.js");
  const root=mkdtempSync(join(tmpdir(),"v1-native-env-"));const project=join(root,"project");const state=join(root,"state");mkdirSync(project);mkdirSync(state);
  const install=join(process.cwd(),"node_modules",".bin");
  assert.ok(readFileSync(join(install,process.platform==="win32"?"tsx.cmd":"tsx")).length,"runner-only binary exists before scrub");
  const ambient=snapshotNativeBuildAmbientEnvironment();
  const pathName=Object.keys(ambient).find((name)=>name.toUpperCase()==="PATH")??"PATH";
  const environment={...ambient,[pathName]:[install,ambient[pathName]??""].join(delimiter),npm_config_cache:"private-v1",INIT_CWD:process.cwd()};
  const host=createExecutionHost({projectRoot:project,stateDirectory:state,artifacts:new ArtifactStore(join(state,"artifacts")),ambientEnvironment:environment});
  try {
    const config=emptyRunnerCapabilitiesConfig();const capabilityContract=await createRunnerCapabilityContract(config);
    const binding=await host.bindRun({runId:"env-r",permissionProfile:"full",capabilityContract,capabilitiesConfig:config});
    const request={executable:process.execPath,workingDirectory:project,timeoutMs:30000,context:{runId:"env-r",sessionId:"env-s",actor:{role:"worker" as const,id:"w"},callId:"runner-only",toolName:"run_evidence_command",runnerInternal:true as const}};
    const probe=await binding.commandExecution.execute({...request,arguments:["-e","const cp=require('node:child_process'); const r=cp.spawnSync('tsx',['--version'],{shell:true,encoding:'utf8'}); process.exit(r.status===0?0:17);"]});
    assert.equal(probe.process.exitCode,17,"actual project child script fails because tsx exists only in runner PATH");
    assert.ok(probe.childEnvironmentAudit?.decisions.some((entry)=>entry.kind==="removed_runner_path"));
    assert.ok(probe.childEnvironmentAudit?.removedNames.includes("npm_config_cache"));
    assert.ok(probe.childEnvironmentAudit?.removedNames.includes("INIT_CWD"));
    assert.doesNotMatch(JSON.stringify(probe.childEnvironmentAudit),/private-v1/);
    assert.equal(probe.childEnvironmentIdentity?.status,"known");
    const control=await binding.commandExecution.execute({...request,context:{...request.context,callId:"system-control"},arguments:["-e","const cp=require('node:child_process'); const r=cp.spawnSync('git',['--version'],{encoding:'utf8'}); process.stdout.write(JSON.stringify({node:process.version,git:r.status,npm:Object.keys(process.env).some(k=>/^npm_|^INIT_CWD$/i.test(k))})); process.exit(r.status===0?0:18);"]});
    assert.equal(control.process.exitCode,0,"legitimate system Git and absolute Node still execute");
    const stdout=outputFor(control.process,"stdout").tail; assert.match(stdout,/"git":0/);assert.match(stdout,/"npm":false/);
    assert.equal(control.childEnvironmentIdentity?.runtime?.version,process.version);
    const {openSqliteDurableProcessKernel}=await import("../src/durable-process-store.js");
    const reopened=openSqliteDurableProcessKernel(binding.snapshot().subprocessStatePath,readFileSync(join(binding.runRoot,"subprocess-runtime.key")),{readOnly:true});
    try {
      const records=reopened.store.listRowIds().map((id)=>reopened.store.readByInvocation(id)!);
      assert.equal(records.length,2);
      for(const record of records) {
        assert.ok(record.environmentAudit.removedNames.includes("npm_config_cache"));
        assert.ok(record.environmentAudit.removedNames.includes("INIT_CWD"));
        assert.ok(record.environmentAudit.scrubDecisions?.some((entry)=>entry.kind==="removed_runner_path"));
        assert.doesNotMatch(JSON.stringify(record.environmentAudit),/private-v1/);
      }
    } finally {reopened.store.close();}
  } finally {await host.close();rmSync(root,{recursive:true,force:true});}
});

test("V1 reserved npm credentials cannot bypass scrub but legitimate credentials remain single-use",()=> {
  const make=(name:string)=>createChildEnvironmentFactory({credentialResolver:{consume:(grantId)=>({grantId,runId:"r",invocationId:"i",names:[name],values:{[name]:"private-granted-value"}})}});
  assert.throws(()=>make("NPM_TOKEN").prepare({ambient:{},runId:"r",invocationId:"i",credentialGrantId:"g"}),/invalid/);
  const factory=make("API_TOKEN");const prepared=factory.prepare({ambient:{},runId:"r",invocationId:"i",credentialGrantId:"g"});
  factory.withChildEnvironment(prepared.capability,env=>assert.equal(env.API_TOKEN,"private-granted-value"));
  assert.doesNotMatch(JSON.stringify(prepared.audit),/private-granted-value/);assert.throws(()=>factory.withChildEnvironment(prepared.capability,()=>undefined),/invalid/);
});
