import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import {
  createChangeSet,
} from "../src/change-set.js";
import type {
  AcceptanceCriterion,
  CriterionEvidenceLink,
} from "../src/acceptance-contracts.js";
import type { EvidenceRecord } from "../src/evidence-store.js";
import { captureGitBaseline } from "../src/git-baseline.js";
import { WorkspaceManager } from "../src/workspace-manager.js";

test("change sets require exact current criterion evidence mappings", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-change-set-contract-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  writeFileSync(join(project, "value.txt"), "one\n");
  try {
    const baseline = await captureGitBaseline({
      projectPath: project,
      stateDirectory: state,
      runId: "run_contract",
    });
    const workspaces = new WorkspaceManager({
      repositoryRoot: project,
      stateDirectory: state,
      runId: "run_contract",
      baselineRevision: baseline.revision,
    });
    const workspace = await workspaces.createTaskWorkspace("task_contract");
    writeFileSync(join(workspace.path, "value.txt"), "two\n");
    const commit = await workspaces.commitTask("task_contract", "Implement contract");
    const artifacts = new ArtifactStore(join(state, "artifacts"));
    const evidenceArtifact = await artifacts.put(
      Buffer.from("criterion evidence"),
      "text/plain",
      "criterion evidence"
    );
    const criteria: AcceptanceCriterion[] = [
      { id: "behavior", text: "The behavior changes as requested." },
      { id: "verification", text: "The focused check passes." },
    ];
    const evidenceRecords: EvidenceRecord[] = [
      evidenceRecord("run_contract", "evidence_behavior", "task_contract", 1, evidenceArtifact.hash),
      evidenceRecord("run_contract", "evidence_verification", "task_contract", 1, evidenceArtifact.hash),
    ];
    const behaviorLink: CriterionEvidenceLink = {
      criterionId: "behavior",
      evidenceId: "evidence_behavior",
      artifactHashes: [evidenceArtifact.hash],
      taskId: "task_contract",
      attempt: 1,
    };
    const verificationLink: CriterionEvidenceLink = {
      criterionId: "verification",
      evidenceId: "evidence_verification",
      artifactHashes: [evidenceArtifact.hash],
      taskId: "task_contract",
      attempt: 1,
    };

    await assert.rejects(
      () => createChangeSet({
        workspacePath: workspace.path,
        taskCommit: commit,
        artifacts,
        evidenceArtifactHashes: [evidenceArtifact.hash],
        acceptanceCriteria: criteria,
        criterionEvidenceLinks: [behaviorLink],
        evidenceRecords,
        taskId: "task_contract",
        attempt: 1,
      }),
      /Missing evidence mapping for criterion verification/i
    );

    await assert.rejects(
      () => createChangeSet({
        workspacePath: workspace.path,
        taskCommit: commit,
        artifacts,
        evidenceArtifactHashes: [evidenceArtifact.hash],
        acceptanceCriteria: criteria,
        criterionEvidenceLinks: [
          behaviorLink,
          {
            ...verificationLink,
            evidenceId: "evidence_foreign",
          },
        ],
        evidenceRecords,
        taskId: "task_contract",
        attempt: 1,
      }),
      /Evidence record evidence_foreign.*missing/i
    );

    const changeSet = await createChangeSet({
      workspacePath: workspace.path,
      taskCommit: commit,
      artifacts,
      acceptanceCriteria: criteria,
      criterionEvidenceLinks: [behaviorLink, verificationLink],
      evidenceRecords,
      taskId: "task_contract",
      attempt: 1,
    });
    assert.deepEqual(changeSet.criterionEvidenceLinks, [behaviorLink, verificationLink]);
    assert.deepEqual(changeSet.evidenceArtifactHashes, [evidenceArtifact.hash]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("criterion mappings reject evidence from another task or stale attempt", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-change-set-ownership-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  writeFileSync(join(project, "value.txt"), "one\n");
  try {
    const baseline = await captureGitBaseline({
      projectPath: project,
      stateDirectory: state,
      runId: "run_ownership",
    });
    const workspaces = new WorkspaceManager({
      repositoryRoot: project,
      stateDirectory: state,
      runId: "run_ownership",
      baselineRevision: baseline.revision,
    });
    const workspace = await workspaces.createTaskWorkspace("task_owner");
    writeFileSync(join(workspace.path, "value.txt"), "two\n");
    const commit = await workspaces.commitTask("task_owner", "Inspect contract");
    const artifacts = new ArtifactStore(join(state, "artifacts"));
    const evidenceArtifact = await artifacts.put(Buffer.from("evidence"), "text/plain");
    const criteria: AcceptanceCriterion[] = [{ id: "behavior", text: "Behavior is verified." }];
    const link: CriterionEvidenceLink = {
      criterionId: "behavior",
      evidenceId: "foreign",
      artifactHashes: [evidenceArtifact.hash],
      taskId: "task_owner",
      attempt: 2,
    };
    const foreignRecord = evidenceRecord("run_ownership", "foreign", "another_task", 2, evidenceArtifact.hash);
    await assert.rejects(
      () => createChangeSet({
        workspacePath: workspace.path,
        taskCommit: commit,
        artifacts,
        evidenceArtifactHashes: [evidenceArtifact.hash],
        acceptanceCriteria: criteria,
        criterionEvidenceLinks: [link],
        evidenceRecords: [foreignRecord],
        taskId: "task_owner",
        attempt: 1,
      }),
      /belongs to another task|stale for attempt/i
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function evidenceRecord(
  runId: string,
  id: string,
  taskId: string,
  attempt: number,
  artifactHash: string
): EvidenceRecord {
  return {
    id,
    runId,
    taskId,
    actor: { role: "worker", id: "worker_1" },
    status: "observed",
    fact: {
      kind: "browser_screenshot",
      label: "criterion evidence",
      capturedAt: "2026-07-13T00:00:00.000Z",
      screenshotArtifactHash: artifactHash,
      mediaType: "image/png",
      byteLength: 16,
    },
    createdAt: "2026-07-13T00:00:00.000Z",
    idempotencyKey: id,
    attempt,
  };
}
