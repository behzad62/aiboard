import { createJsonArtifact, createLogArtifact, createPatchArtifact } from "@/lib/benchmark/artifacts";
import type { BenchmarkArtifact } from "@/lib/benchmark/types";

export function createWorkBenchVerifierArtifact(input: {
  id: string;
  attemptId: string;
  caseId: string;
  result: unknown;
  createdAt?: string;
}): BenchmarkArtifact {
  return createJsonArtifact({
    id: input.id,
    attemptId: input.attemptId,
    caseId: input.caseId,
    label: "WorkBench verifier result",
    content: input.result,
    createdAt: input.createdAt,
  });
}

export function createWorkBenchPatchArtifact(input: {
  id: string;
  attemptId: string;
  caseId: string;
  diff: string;
  createdAt?: string;
}): BenchmarkArtifact {
  return createPatchArtifact({
    id: input.id,
    attemptId: input.attemptId,
    caseId: input.caseId,
    label: "WorkBench patch",
    content: input.diff,
    createdAt: input.createdAt,
  });
}

export function createWorkBenchLogArtifact(input: {
  id: string;
  attemptId: string;
  caseId: string;
  label: string;
  content: string;
  createdAt?: string;
}): BenchmarkArtifact {
  return createLogArtifact({
    id: input.id,
    attemptId: input.attemptId,
    caseId: input.caseId,
    label: input.label,
    content: input.content,
    createdAt: input.createdAt,
  });
}

export function createWorkBenchRetainedStateArtifact(input: {
  id: string;
  attemptId: string;
  caseId: string;
  projectPath: string;
  statePath: string;
  createdAt?: string;
}): BenchmarkArtifact {
  return createJsonArtifact({
    id: input.id,
    attemptId: input.attemptId,
    caseId: input.caseId,
    label: "Retained WorkBench Runner V2 state",
    content: {
      projectPath: input.projectPath,
      statePath: input.statePath,
    },
    createdAt: input.createdAt,
  });
}
