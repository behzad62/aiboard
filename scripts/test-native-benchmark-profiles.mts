import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getNativeBenchmarkPack, HARNESSBENCH_SUITE, NATIVE_TOOLBENCH_SUITE, NATIVE_TOOLBENCH_BROWSER_CAPABILITY_SUITE, WORKBENCH_SMOKE_SUITE } from "../lib/benchmark/native-suites";
import { nativeToolBenchReferenceFiles } from "../lib/benchmark/toolreliability/native-cases";
import { LEGACY_NATIVE_TOOLBENCH_SUITE, NATIVE_TOOLBENCH_VARIANT_SUITE, NATIVE_TOOLBENCH_SKILLS_SUITE } from "../lib/benchmark/toolreliability/native-cases";
import { scoreWorkBenchAttempt } from "../lib/benchmark/scoring/workbench";
import { SkillCatalog } from "../runner-v2/src/skill-catalog";
import { createSkillTools } from "../runner-v2/src/skill-tools";
import { qualifyNativeToolBench } from "../lib/benchmark/toolreliability/native-qualification";
import { toBenchmarkCaseV2 } from "../lib/benchmark/workbench/case-loader";
import { nativeBenchmarkAttemptId } from "../lib/benchmark/workbench/certified-runner";
import { listWorkBenchChallenges } from "../lib/benchmark/workbench/corpus";
import { listCertifiedSuiteOptions } from "../lib/benchmark/certified/suite-options";
import { BENCHMARK_PRESETS } from "../lib/benchmark/certified/run-presets";
import { isRetiredBenchmarkCase } from "../lib/benchmark/retired";
import { benchmarkResultConfigurationKey } from "../lib/benchmark/certified/result-set-identity";
import type { BenchmarkResultConfiguration } from "../lib/benchmark/types";
import type { NativeBuildAuditExport, NativeBuildObservability } from "../lib/client/runner-v2";
import { runAgentLoop } from "../runner-v2/src/agent-loop";
import { createFilesystemTools } from "../runner-v2/src/filesystem-tools";
import { ToolBroker } from "../runner-v2/src/tool-broker";
import { ArtifactStore } from "../runner-v2/src/artifact-store";
import { SqliteToolLedger } from "../runner-v2/src/sqlite-tool-ledger";
import { runnerRunStateSegment } from "../runner-v2/src/run-state-identity";
import { readNativeToolEvidence } from "./bench-native-tool-evidence.mjs";
import { OpenAICompatibleModel } from "../runner-v2/src/openai-compatible-model";
import { createOpenRouterApplyPatchTool } from "../runner-v2/src/openrouter-apply-patch-tool";
import { createToolNameCodec } from "../runner-v2/src/provider-model-utils";
import type { ModelTurn, ToolResult } from "../runner-v2/src/agent-contracts";

const pack = getNativeBenchmarkPack("toolreliability", LEGACY_NATIVE_TOOLBENCH_SUITE)!;
const compact = getNativeBenchmarkPack("toolreliability", NATIVE_TOOLBENCH_SUITE)!;
assert.equal(compact.caseCount, 7);
assert.deepEqual(listCertifiedSuiteOptions("toolreliability").map(option => option.id), [NATIVE_TOOLBENCH_SUITE]);
assert.ok(compact.cases.every(option => option.case.budget.maxModelCalls === 300 && option.case.budget.maxWallClockSeconds === 4500 && option.case.budget.maxInputTokens === 5_000_000));
assert.equal(compact.cases.filter(option => option.case.nativeQualification?.requiresBrowser).length, 1);
assert.ok(compact.caseIds.some(id => id.includes("interactive-browser-process-v7")));
assert.ok(compact.cases.every(option => option.id.endsWith("-v7")));
assert.ok(!compact.caseIds.some(id => /variant-b|atomic-edits|bounded-output|command-args|investigate/.test(id)));
assert.equal(pack.caseCount, 6);
const browserPack = getNativeBenchmarkPack("toolreliability", NATIVE_TOOLBENCH_BROWSER_CAPABILITY_SUITE)!;
assert.equal(browserPack.id, compact.id, "the browser-inclusive pack is the only new-run ToolBench");
const historicalWithoutBrowser = getNativeBenchmarkPack("toolreliability", "toolbench-native-capability-v7")!;
assert.equal(historicalWithoutBrowser.caseCount, 7);
assert.equal(historicalWithoutBrowser.cases.filter(option => option.case.nativeQualification?.requiresBrowser).length, 0);
assert.deepEqual(compact.caseIds.filter(id => !id.includes("interactive-browser-process")), historicalWithoutBrowser.caseIds.filter(id => !id.includes("interactive-process")));
for (const option of pack.cases) {
  assert.deepEqual(option.case.budget, {maxWallClockSeconds:4500,maxModelCalls:300,maxToolCalls:900,maxInputTokens:5000000,maxOutputTokens:750000});
  assert.equal(option.case.environment.timeoutSeconds,4500);
  assert.ok(option.case.allowedCommands.includes("node check.mjs"));
  assert.equal(JSON.parse(option.case.fixtureFiles!["package.json"]).scripts.test,"node check.mjs");
}
assert.equal(listCertifiedSuiteOptions("harnessbench")[0].id, HARNESSBENCH_SUITE);
const signature = getNativeBenchmarkPack("harnessbench", HARNESSBENCH_SUITE)!;
assert.equal(toBenchmarkCaseV2(signature.cases[0].case).track, "harnessbench");
assert.equal(signature.cases[0].case.budget.maxModelCalls, 120);
assert.equal(signature.cases[0].case.scoring.scoringVersion, "recoverable-job-service-binary-v2");
assert.equal(getNativeBenchmarkPack("workbench", signature.id), null);
assert.ok(BENCHMARK_PRESETS.every(preset => preset.legs.every(leg => leg.requires === "bench-runner" && leg.mode === (leg.track === "harnessbench" ? "team" : "solo"))));
assert.ok(BENCHMARK_PRESETS.every(preset => !preset.legs.some(leg => leg.track === "teamiq" || leg.track === "workbench")));
const smoke = getNativeBenchmarkPack("workbench", WORKBENCH_SMOKE_SUITE)!;
assert.equal(smoke.caseCount, 3);
assert.notEqual(await nativeBenchmarkAttemptId("long-run-".repeat(20), "long-case-".repeat(20), "member-a"), await nativeBenchmarkAttemptId("long-run-".repeat(20), "long-case-".repeat(20), "member-b"), "bounded native attempt identities preserve distinct owners after long shared prefixes");
assert.ok(smoke.cases.every(option => listWorkBenchChallenges().find(item => item.id === option.id)?.verifier.behavioralChecks?.length));

const roots: string[] = [];
function workspace(files: Record<string, string>) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "native-benchmark-profile-")));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content);
  }
  return root;
}
function verify(root: string) {
  try { execFileSync(process.execPath, ["verifier.mjs"], { cwd: root, stdio: "pipe", timeout: 10_000, windowsHide: true }); }
  catch { /* A candidate failure writes its result before nonzero exit. */ }
  return JSON.parse(readFileSync(join(root, "verifier-result.json"), "utf8")) as { passed: boolean; score: number };
}
function audit(tools: NativeBuildObservability["tools"], evidence: NativeBuildObservability["evidence"] = []) {
  return { observability: { tools, evidence } } as NativeBuildAuditExport;
}
function completed(name: string, sequence: number, errorCode?: string): NativeBuildObservability["tools"][number] {
  return { toolName: name, callId: `call-${sequence}`, sessionId: "worker", sequence, status: "completed", occurredAt: new Date(0).toISOString(), isError: Boolean(errorCode), errorCode };
}

try {
  // The compact artifact case must enforce the two distinct process argv values,
  // rather than accepting a shell-like string split into three arguments.
  const exactArgCase = compact.cases.find(option => option.id.endsWith("artifact-retrieval-v7"))!.case;
  const exactArgRoot = workspace(exactArgCase.fixtureFiles!);
  assert.throws(() => execFileSync(process.execPath, ["emit-report.mjs", "alpha", "beta", "gamma"], {
    cwd: exactArgRoot, stdio: "pipe", timeout: 10_000, windowsHide: true,
  }), "a split first argument must be rejected by the actual fixture command");
  assert.match(execFileSync(process.execPath, ["emit-report.mjs", "alpha beta", "gamma"], {
    cwd: exactArgRoot, stdio: "pipe", timeout: 10_000, windowsHide: true,
  }).toString(), /INCIDENT_ID=inc-89fea6fda378/);
  for (const option of [...pack.cases, ...getNativeBenchmarkPack("toolreliability", NATIVE_TOOLBENCH_VARIANT_SUITE)!.cases, ...getNativeBenchmarkPack("toolreliability", NATIVE_TOOLBENCH_SKILLS_SUITE)!.cases]) {
    const root = workspace(option.case.fixtureFiles!);
    assert.equal(verify(root).passed, false, `${option.id}: untouched/inaction control must fail`);
    for (const [path, content] of Object.entries(nativeToolBenchReferenceFiles(option.id))) writeFileSync(join(root, path), content);
    const result = verify(root);
    assert.equal(result.passed, true, `${option.id}: valid implementation passes real verifier`);
    assert.equal(result.score, 1);
    execFileSync(process.execPath,["check.mjs"],{cwd:root,stdio:"pipe",timeout:10000,windowsHide:true});
    assert.equal(toBenchmarkCaseV2(option.case).track, "toolreliability");
    assert.ok(!isRetiredBenchmarkCase(toBenchmarkCaseV2(option.case)));
  }
  const skillCase = getNativeBenchmarkPack("toolreliability", NATIVE_TOOLBENCH_SKILLS_SUITE)!.cases[0].case;
  const skillRoot = workspace(skillCase.fixtureFiles!);
  const skillBroker = new ToolBroker({ permissionProfile: "full", workspacePath: skillRoot });
  for (const tool of createSkillTools(new SkillCatalog({ projectRoot: skillRoot }))) skillBroker.register(tool);
  const skillContext = { runId: "skill-run", sessionId: "skill-session", actor: { role: "worker" as const, id: "worker" }, workspacePath: skillRoot };
  const list = await skillBroker.invoke({ type: "tool_call", callId: "list", name: "list_skills", arguments: {} }, skillContext);
  const metadata = list.content.find(block => block.type === "json");
  assert.ok(metadata?.type === "json");
  const discovered = metadata.value as Array<{ id: string; name: string }>;
  assert.ok(discovered.some(skill => skill.name === "port-policy"));
  const read = await skillBroker.invoke({ type: "tool_call", callId: "read", name: "read_skill", arguments: { id: discovered.find(skill => skill.name === "port-policy")!.id } }, skillContext);
  assert.ok(read.content.some(block => block.type === "text" && block.text.includes("9217")));

  const scored = (calls: number) => scoreWorkBenchAttempt({ verifierScore: 1, verifierPassed: true, actualCostUsd: null, targetCostUsd: null, actualDurationMs: 1000, targetDurationMs: 180000, validToolCalls: calls, totalToolCalls: calls, targetToolCalls: 24 });
  assert.equal(scored(22).verifiedQuality, scored(42).verifiedQuality);
  assert.ok(scored(22).efficiencyScore > scored(42).efficiencyScore, "twenty extra valid requests reduce efficiency without changing quality");
  const verifyCase = pack.cases.find(item => item.id.includes("-verify-"))!.case;
  const commentRoot = workspace(verifyCase.fixtureFiles!);
  writeFileSync(join(commentRoot, "normalize.mjs"), "export function normalizeId(raw) {\n // .trim()\n return raw.toLowerCase();\n}\n");
  assert.equal(verify(commentRoot).passed, false, "comment-only fix fails executed behavior");

  const validTools = [completed("fs.read", 1), completed("fs.patch", 2), completed("run_evidence_command", 3)];
  assert.equal(qualifyNativeToolBench(verifyCase, audit(validTools)).passed, false, "wrong/missing command evidence cannot pass");
  const commandFact = { kind: "command", label: "check", command: "node", args: ["check.mjs"], cwd: ".", startedAt: "2026-10-26T00:00:02Z", finishedAt: "2026-10-26T00:00:03Z", exitCode: 0, signal: null, timedOut: false, cancelled: false, outputTruncated: false, stdoutArtifactHash: "a", stderrArtifactHash: "b" } as const;
  const evidence = [{ id: "e1", runId: "run", taskId: "task", actor: { role: "worker", id: "worker" }, status: "observed", fact: commandFact, createdAt: "", idempotencyKey: "e1" }] as unknown as NativeBuildObservability["evidence"];
  assert.equal(qualifyNativeToolBench(verifyCase, audit(validTools, evidence)).passed, false, "a verification recovery profile must encounter the failing check");
  evidence.unshift({ ...evidence[0], id: "red", fact: { ...commandFact, exitCode: 1, startedAt: "2026-10-26T00:00:00Z", finishedAt: "2026-10-26T00:00:01Z" } });
  assert.equal(qualifyNativeToolBench(verifyCase, audit(validTools, evidence)).passed, true);
  assert.equal(qualifyNativeToolBench(verifyCase, audit([...validTools, completed("process.run", 4, "benchmark_command_denied")], evidence)).passed, false, "later forbidden action disqualifies an otherwise passing session");
  assert.equal(qualifyNativeToolBench(verifyCase, audit([...validTools, completed("fs.write", 4, "benchmark_protected_path")], evidence)).passed, false, "attempted scope violation is a hard failure");
  assert.equal(qualifyNativeToolBench(verifyCase, audit([completed("not_a_real_tool", 1)], evidence)).passed, false);

  const investigation = pack.cases.find(item => item.id.includes("investigate"))!.case;
  const investigationTools = [completed("fs.search", 1), completed("fs.read", 2), completed("fs.write", 3)];
  assert.equal(qualifyNativeToolBench(investigation, audit(investigationTools)).passed, false, "guessing the answer after an unrelated read does not pass");
  assert.equal(qualifyNativeToolBench(investigation, audit(investigationTools), { runId: "run", tools: [{ sequence: 2, callId: "read", toolName: "fs.read", input: { path: "src/config/limits.mjs" }, isError: false, outputText: "export const MAX_RETRY_BUDGET = 263;" }] }).passed, true);

  const bounded = pack.cases.find(item=>item.id.includes("bounded-output"))!.case;
  const boundedRoot = workspace(bounded.fixtureFiles!);
  const boundedBroker = new ToolBroker({permissionProfile:"full",workspacePath:boundedRoot});
  for (const tool of createFilesystemTools({protectedPaths:bounded.executionPolicy!.protectedPaths,hiddenPaths:bounded.executionPolicy!.hiddenPaths})) boundedBroker.register(tool);
  const boundedResult = await boundedBroker.invoke({type:"tool_call",callId:"bounded-read",name:"fs.read",arguments:{path:"source.mjs",startLine:1750,endLine:1780}}, {runId:"bounded",sessionId:"worker",actor:{role:"worker",id:"worker"},workspacePath:boundedRoot});
  const boundedText = boundedResult.content.filter(block=>block.type==="text").map(block=>block.text).join("\n");
  assert.equal(boundedResult.isError,false);
  assert.ok(boundedText.includes(bounded.nativeQualification!.requiredReadText!.text));
  assert.ok(Buffer.byteLength(boundedText)<4000,"target evidence fits in one small read; large output copying adds no value");
  assert.ok(JSON.stringify(nativeToolBenchReferenceFiles(bounded.id)).length<150,"bounded output produces a tiny answer instead of echoing filler");
  assert.equal(qualifyNativeToolBench(bounded,audit([completed("fs.read",1),completed("fs.write",2)]),{runId:"bounded",tools:[{sequence:1,callId:"bounded-read",toolName:"fs.read",input:{path:"source.mjs",startLine:1750,endLine:1780},isError:false,outputText:boundedText}]}).passed,true);
  assert.equal(qualifyNativeToolBench(bounded,audit([completed("fs.read",1),completed("fs.write",2)]),{runId:"bounded",tools:[{sequence:1,callId:"unbounded-read",toolName:"fs.read",input:{path:"source.mjs"},isError:false,outputText:boundedText}]}).passed,false,"an unbounded read cannot certify bounded navigation");

  const recovery = pack.cases.find(item => item.id.includes("revision-recovery"))!.case;
  const root = workspace(recovery.fixtureFiles!);
  const state = workspace({});
  const ledger = new SqliteToolLedger(join(state, "builds", runnerRunStateSegment("run"), "tool-ledger.sqlite"));
  const broker = new ToolBroker({ permissionProfile: "full", workspacePath: root, ledger, artifacts: new ArtifactStore(join(root, ".artifacts")) });
  for (const tool of createFilesystemTools({ protectedPaths: recovery.executionPolicy!.protectedPaths, hiddenPaths: recovery.executionPolicy!.hiddenPaths })) broker.register(tool);
  let turn = 0;
  const loop = await runAgentLoop({
    registry: broker, context: { runId: "run", sessionId: "worker", actor: { role: "worker", id: "worker" }, workspacePath: root },
    initialMessages: [{ id: "task", role: "user", content: recovery.prompt.userRequest }], maxTurns: 7,
    model: { async complete(request): Promise<ModelTurn> {
      assert.ok(request.tools.some(tool => tool.name === "fs.patch"));
      assert.ok(!request.tools.some(tool => tool.name === "patch"));
      turn++;
      if (turn === 6) return { blocks: [{ type: "text", text: "Done" }], stopReason: "end_turn" };
      const toolMessages = request.messages.filter(message => message.role === "tool");
      if (turn === 2) assert.equal((toolMessages[0].content as ToolResult).error?.code, "revision_conflict");
      const read = toolMessages.map(message => message.content as ToolResult).find(result => result.toolName === "fs.read");
      const revision = read?.content.find(block => block.type === "json");
      const sha256 = revision?.type === "json" ? (revision.value as { sha256: string }).sha256 : "0".repeat(64);
      const readTurn = turn === 2 || turn === 4;
      return { stopReason: "tool_calls", blocks: [{ type: "tool_call", callId: `step-${turn}`, name: readTurn ? "fs.read" : "fs.patch", arguments: readTurn ? { path: "normalize.mjs" } : { path: "normalize.mjs", expectedSha256: sha256, search: turn === 3 ? "raw.toLocaleLowerCase()" : "raw.toLowerCase()", replace: "raw.trim().toLowerCase()" } }] };
    } },
  });
  assert.equal(loop.status, "suspended", "prose alone never completes the native task lifecycle");
  assert.equal(verify(root).passed, true, "production agent loop and fs tools recover and produce working software");
  const recorded = broker.auditRecords().map((item, index) => completed(item.toolName, index + 1, item.errorCode));
  assert.equal(qualifyNativeToolBench(recovery, audit(recorded)).passed, true);
  assert.equal(qualifyNativeToolBench(recovery, audit(recorded.filter(item => item.errorCode !== "ambiguous_patch"))).passed, false, "a recovery profile cannot pass without encountering the fault");
  assert.equal(qualifyNativeToolBench(recovery, audit([completed("fs.patch",0),...recorded])).passed,false,"a successful edit before the deliberate fault cannot qualify as recovery-first behavior");
  const faultSequence = recorded.find(item=>item.errorCode==="ambiguous_patch")!.sequence;
  assert.equal(qualifyNativeToolBench(recovery,audit(recorded.filter(item=>!(item.toolName==="fs.read" && item.sequence>faultSequence)))).passed,false,"recovery must read current context before retrying");
  const exported = await readNativeToolEvidence(state, "run");
  assert.ok(exported.tools.some(tool => tool.toolName === "fs.read" && tool.outputText.includes("raw.toLowerCase()")));
  assert.ok(exported.tools.some(tool => tool.toolName === "fs.patch" && tool.input.editCount === 1));
  await assert.rejects(readNativeToolEvidence(state, "../run"), /Invalid/);
  ledger.close();

  // Exercise the actual DeepSeek Responses adapter, which intentionally hides
  // fs.patch/fs.write and dispatches its custom apply_patch through the broker.
  const nativeRoot = workspace(recovery.fixtureFiles!);
  const nativeState = workspace({});
  const nativeLedger = new SqliteToolLedger(join(nativeState, "builds", runnerRunStateSegment("native-run"), "tool-ledger.sqlite"));
  try {
  const nativeBroker = new ToolBroker({ permissionProfile: "full", workspacePath: nativeRoot, ledger: nativeLedger });
  const fsTools = createFilesystemTools();
  for (const tool of [...fsTools, createOpenRouterApplyPatchTool()]) nativeBroker.register(tool);
  const codec = createToolNameCodec(fsTools.map(tool => tool.definition));
  let nativeTurn = 0;
  const nativeModel = new OpenAICompatibleModel({ providerId: "deepseek", protocol: "responses", modelId: "test", apiKey: "test", baseUrl: "https://test.invalid", fetch: async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    assert.ok(body.tools.some((tool: { type: string; name?: string }) => tool.type === "custom" && tool.name === "apply_patch"));
    assert.ok(!body.tools.some((tool: { name?: string }) => [codec.wireFor("fs.patch"), codec.wireFor("fs.write")].includes(tool.name ?? "")));
    nativeTurn++;
    const patch = `*** Begin Patch\n*** Update File: normalize.mjs\n@@\n-  return raw.${nativeTurn === 1 ? "toLocaleLowerCase" : "toLowerCase"}();\n+  return raw.trim().toLowerCase();\n*** End Patch`;
    const output = nativeTurn === 2 ? [{ type: "function_call", call_id: "read-current", name: codec.wireFor("fs.read"), arguments: JSON.stringify({ path: "normalize.mjs" }) }]
      : nativeTurn === 4 ? [{ type: "message", content: [{ type: "output_text", text: "Done" }] }]
      : [{ type: "custom_tool_call", call_id: `native-${nativeTurn}`, name: "apply_patch", input: patch }];
    const response = { output, usage: { input_tokens: 10, output_tokens: 10 } };
    return body.stream ? new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`, { headers: { "content-type": "text/event-stream" } })
      : new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } });
  } });
  await runAgentLoop({ registry: nativeBroker, context: { runId: "native-run", sessionId: "worker", actor: { role: "worker", id: "worker" }, workspacePath: nativeRoot }, initialMessages: [{ id: "task", role: "user", content: recovery.prompt.userRequest }], maxTurns: 5, model: nativeModel });
  const nativeRecords = nativeBroker.auditRecords().map((item, index) => completed(item.toolName, index + 1, item.errorCode));
  assert.ok(nativeRecords.some(item => item.errorCode === "ambiguous_patch"), JSON.stringify(nativeRecords));
  assert.equal(verify(nativeRoot).passed, true);
  assert.equal(qualifyNativeToolBench(recovery, audit(nativeRecords)).passed, true, "provider-native edits qualify only after a real failed context and successful retry");
  const nativeEvidence = await readNativeToolEvidence(nativeState, "native-run");
  assert.ok(nativeEvidence.tools.some(tool => tool.toolName === "openrouter.apply_patch" && !tool.isError && tool.input.editCount === 1));
  const atomicCase = pack.cases.find(item => item.id.includes("atomic-edits"))!.case;
  const atomicRoot = workspace(atomicCase.fixtureFiles!);
  const atomicBroker = new ToolBroker({ permissionProfile: "full", workspacePath: atomicRoot, ledger: nativeLedger });
  for (const tool of [...createFilesystemTools(), createOpenRouterApplyPatchTool()]) atomicBroker.register(tool);
  const atomicContext = { runId: "native-run", sessionId: "atomic", actor: { role: "worker" as const, id: "worker" }, workspacePath: atomicRoot };
  await atomicBroker.invoke({ type: "tool_call", callId: "atomic-read", name: "fs.read", arguments: { path: "prices.mjs" } }, atomicContext);
  const atomicResult = await atomicBroker.invoke({ type: "tool_call", callId: "atomic-patch", name: "openrouter.apply_patch", arguments: { operation: { type: "update_file", path: "prices.mjs", diff: "@@\n-export function net(cents) { return Math.round(cents * 0.9); }\n-export function gross(cents) { return Math.round(cents * 1.03); }\n+export function net(cents) { return Math.round(cents * 0.8); }\n+export function gross(cents) { return Math.round(cents * 1.05); }\n" } } }, atomicContext);
  assert.equal(atomicResult.isError, false);
  assert.equal(verify(atomicRoot).passed, true);
  const atomicRecords = atomicBroker.auditRecords().map((item, index) => completed(item.toolName, index + 1, item.errorCode));
  const atomicEvidence = await readNativeToolEvidence(nativeState, "native-run");
  assert.equal(qualifyNativeToolBench(atomicCase, audit(atomicRecords), atomicEvidence).passed, true);
  assert.equal(qualifyNativeToolBench(atomicCase, audit(atomicRecords), { ...atomicEvidence, tools: atomicEvidence.tools.map(tool => ({ ...tool, input: { ...tool.input, editCount: 1 } })) }).passed, false, "a single change cannot fabricate a coordinated edit");
  } finally { nativeLedger.close(); }

  const configuration: BenchmarkResultConfiguration = { subjectKind: "model", displayName: "control", roles: [], tracks: [], executionEnvironment: { runnerSourceDigest: "a".repeat(64), nodeVersion: "24.18.0", platform: "win32" } };
  assert.notEqual(benchmarkResultConfigurationKey(configuration), benchmarkResultConfigurationKey({ ...configuration, executionEnvironment: { ...configuration.executionEnvironment!, runnerSourceDigest: "b".repeat(64) } }));
  console.log("PASS native benchmark profiles, real verifiers, negative controls, and production agent/tool recovery");
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}
