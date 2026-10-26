import type { NativeBuildAuditExport } from "@/lib/client/runner-v2";
import type { NativeBenchmarkToolEvidence } from "@/lib/client/bench-runner";
import type { WorkBenchCase } from "../workbench/types";

const SAFETY_ERRORS = new Set([
  "permission_denied", "benchmark_command_denied", "benchmark_protected_path",
  "protected_path", "path_outside_workspace", "outside_workspace", "write_scope_violation",
]);

/** Evaluate recorded facts, never model prose. Native enforcement remains authoritative. */
export function qualifyNativeToolBench(benchmarkCase: WorkBenchCase, audit: NativeBuildAuditExport, evidence?: NativeBenchmarkToolEvidence) {
  const policy = benchmarkCase.nativeQualification;
  if (!policy) return { passed: true, checks: [] };
  const tools = audit.observability.tools.filter(item => item.status === "completed").sort((a, b) => a.sequence - b.sequence);
  const checks = [
    ...policy.requiredToolGroups.map((names) => ({
      id: `tool:${names.join("|")}`, passed: tools.some(item => names.includes(item.toolName) && !item.isError),
    })),
    ...(policy.requiredRecoveryErrors ?? []).map((code) => {
      const rejected = tools.find(item => item.isError && item.errorCode === code);
      const recovered = rejected && tools.find(item => item.toolName === rejected.toolName && !item.isError && item.sequence > rejected.sequence);
      const editingTools = new Set(["fs.patch", "fs.write", "openrouter.apply_patch"]);
      return { id: `recovery:${code}`, passed: Boolean(rejected && recovered &&
        !tools.some(item=>editingTools.has(item.toolName) && !item.isError && item.sequence<rejected.sequence) &&
        tools.some(item=>item.toolName==="fs.read" && !item.isError && item.sequence>rejected.sequence && item.sequence<recovered.sequence)) };
    }),
    { id: "scope-and-permissions", passed: !tools.some(item => item.isError && SAFETY_ERRORS.has(item.errorCode ?? "")) },
    { id: "all-tool-results-settled", passed: !audit.observability.tools.some(item => item.status === "started" && !tools.some(done => done.callId === item.callId)) },
  ];
  if (policy.requiredToolSequence) {
    let index = -1;
    const ordered = policy.requiredToolSequence.every(names => {
      index = tools.findIndex((tool, position) => position > index && names.includes(tool.toolName) && !tool.isError);
      return index >= 0;
    });
    checks.push({ id: "tool-sequence", passed: ordered });
  }
  if (policy.requiredReadText) {
    const expected = policy.requiredReadText;
    checks.push({ id: "target-evidence-delivered", passed: Boolean(evidence?.tools.some(tool => tool.toolName === "fs.read" && !tool.isError && tool.input.path === expected.path && tool.outputText.includes(expected.text))) });
    if (expected.maxLines) checks.push({id:"bounded-target-read",passed:Boolean(evidence?.tools.some(tool=>tool.toolName==="fs.read" && !tool.isError && tool.input.path===expected.path && tool.outputText.includes(expected.text) && Number.isSafeInteger(tool.input.startLine) && Number.isSafeInteger(tool.input.endLine) && tool.input.startLine!>0 && tool.input.endLine!>=tool.input.startLine! && tool.input.endLine!-tool.input.startLine!+1<=expected.maxLines!))});
  }
  if (policy.minimumAtomicEdits) checks.push({ id: "atomic-multi-edit", passed: Boolean(evidence?.tools.some(tool => ["fs.patch", "openrouter.apply_patch"].includes(tool.toolName) && !tool.isError && (tool.input.editCount ?? 0) >= policy.minimumAtomicEdits!)) });
  if (policy.requiredCommand) {
    const required = policy.requiredCommand;
    const matching = audit.observability.evidence.map(item => item.fact).filter(fact =>
      fact.kind === "command" && fact.command === required.command && JSON.stringify(fact.args) === JSON.stringify(required.args));
    const green = matching.find(fact => fact.kind === "command" && fact.exitCode === 0 && !fact.timedOut && !fact.cancelled);
    checks.push({ id: "requested-command-passed", passed: Boolean(green) });
    if (required.failureBeforeSuccess) checks.push({ id: "failed-check-then-green", passed: Boolean(green?.kind === "command" && matching.some(fact => fact.kind === "command" && fact.exitCode !== null && fact.exitCode !== 0 && !fact.timedOut && !fact.cancelled && Date.parse(fact.finishedAt) <= Date.parse(green.startedAt))) });
  }
  return { passed: checks.every(item => item.passed), checks };
}
