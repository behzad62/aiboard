import { createHash } from "node:crypto";
import type { ArtifactStore } from "./artifact-store.js";
import type { ChildEnvironmentIdentity, WorkingTreeIdentity } from "./command-evidence-identity.js";
import type { EvidenceRecord, EvidenceStore, CommandEvidenceFact } from "./evidence-store.js";
import type { GenericProcessResult } from "./execution-safety-contracts.js";
import type { OneShotCommandRequest, OneShotCommandResult } from "./one-shot-command-executor.js";

export interface CommandExecutionSnapshot { readonly key: string; readonly process: GenericProcessResult }

/** Literal launch context. No path/argv/environment normalization to manufacture hits. */
export function commandReuseKey(request: Pick<OneShotCommandRequest, "executable" | "arguments" | "workingDirectory" | "timeoutMs" | "lifecycleRequirements">, tree: WorkingTreeIdentity, environment: ChildEnvironmentIdentity, executionContext?: {requiredLifecycleScope: string; implementationDigest: string; configDigest: string}): string | undefined {
  if (!executionContext || !/^[a-f0-9]{64}$/.test(executionContext.implementationDigest) || !/^[a-f0-9]{64}$/.test(executionContext.configDigest)) return undefined;
  if (tree.status !== "known" || !tree.treeId || environment.status !== "known" || !environment.fingerprint || !environment.runtime || !environment.runtime.version || environment.runtime.kind !== "node" || environment.runtime.versionSource !== "runner_node_same_executable" || !/^[a-f0-9]{64}$/.test(environment.runtime.executableDigest) || !environment.environmentDigest || !environment.lockfileDigest || environment.provider || environment.unavailable.length !== 0) return undefined;
  return createHash("sha256").update(JSON.stringify([tree.treeId, request.executable, [...request.arguments], request.workingDirectory, request.timeoutMs, request.lifecycleRequirements ?? null, environment.fingerprint, environment.environmentDigest, environment.lockfileDigest, environment.runtime, executionContext])).digest("hex");
}

export async function findReusableCommand(store: EvidenceStore, artifacts: ArtifactStore, runId: string, key: string): Promise<EvidenceRecord | undefined> {
  // Query is run-scoped; reused rows never become independent original executions.
  let records: EvidenceRecord[];
  try {records = store.list({runId, limit: 1_000});} catch {return undefined;}
  for (const record of records) {
    const fact = record.fact;
    if (record.runId !== runId || record.status !== "observed" || fact.kind !== "command" || fact.reused_from || fact.executionSnapshot?.key !== key || fact.workingTreeIdentity?.status !== "known" || fact.childEnvironmentIdentity?.status !== "known") continue;
    const process = fact.executionSnapshot.process;
    if (fact.exitCode !== 0 || fact.signal || fact.timedOut || fact.cancelled || fact.outputTruncated || fact.outputLossy !== false || fact.errorCode || fact.cleanup?.state !== "verified_empty" || process.outcome !== "exited" || process.exitCode !== 0 || process.signal || process.cleanup.state !== "verified_empty" || process.output.length !== 2 || process.startedAt !== fact.startedAt || process.finishedAt !== fact.finishedAt) continue;
    try {
      for (const stream of ["stdout", "stderr"] as const) {
        const outputs = process.output.filter((output) => output.stream === stream);
        if (outputs.length !== 1) throw new Error("Incomplete output snapshot.");
        const output = outputs[0]!;
        const hash = stream === "stdout" ? fact.stdoutArtifactHash : fact.stderrArtifactHash;
        const artifact = await artifacts.verify(hash);
        if (output.truncated || output.lossyBytes !== 0 || output.totalBytes !== artifact.byteLength || createHash("sha256").update(output.tail).digest("hex") !== hash) throw new Error("Incomplete immutable output.");
      }
      return record;
    } catch { /* Missing/substituted/lossy source is a conservative execution miss. */ }
  }
  return undefined;
}

/** Preserve original observation timing and output; reuse records add only provenance. */
export function commandReuseMetadata(result: OneShotCommandResult): Partial<CommandEvidenceFact> {
  const source = result.reuseSource;
  const fact = source?.fact;
  return {
    ...(result.executionSnapshot ? {executionSnapshot: result.executionSnapshot, ...(result.executionSnapshot.process.startedAt ? {startedAt: result.executionSnapshot.process.startedAt} : {}), finishedAt: result.executionSnapshot.process.finishedAt} : {}),
    ...(source && fact?.kind === "command" ? {reused_from: source.id, startedAt: fact.startedAt, finishedAt: fact.finishedAt, stdoutArtifactHash: fact.stdoutArtifactHash, stderrArtifactHash: fact.stderrArtifactHash} : {}),
  };
}
