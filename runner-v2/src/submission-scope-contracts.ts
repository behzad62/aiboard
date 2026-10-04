import { createHash } from "node:crypto";
import type { AssignmentClaim } from "./planning-contracts.js";
import type { TaskContractRef } from "./task-contracts.js";
import type { SubmissionScopeFinding } from "./submission-guard.js";

export interface SubmissionScopeIdentity {
  version: 1;
  runId: string;
  taskId: string;
  attempt: number;
  sessionId: string;
  workerId: string;
  baselineRevision: string;
  contractRef: TaskContractRef;
  claim: AssignmentClaim;
}
export interface SubmissionScopeRecord extends SubmissionScopeIdentity {
  changeSetId: string;
  taskRevision: string;
  files: Array<{ path: string; added: boolean }>;
  findings: SubmissionScopeFinding[];
}

/** Bind mechanical fact IDs to exactly one submission, claim and ready plan. */
export function bindSubmissionScope(identity: SubmissionScopeIdentity, changeSetId: string, taskRevision: string, findings: readonly SubmissionScopeFinding[], files: readonly { path: string; added: boolean }[]): SubmissionScopeRecord {
  const binding = { ...structuredClone(identity), changeSetId, taskRevision, files: files.map((file) => ({ ...file })) };
  return { ...binding, findings: findings.map((finding) => ({ ...finding,
    id: `submission-scope:${createHash("sha256").update(JSON.stringify([binding, finding.code, finding.path])).digest("hex")}`,
  })) };
}
