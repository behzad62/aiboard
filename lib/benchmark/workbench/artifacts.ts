import { createJsonArtifact, createLogArtifact, createPatchArtifact } from "@/lib/benchmark/artifacts";
import type { BenchmarkArtifact } from "@/lib/benchmark/types";
import type { WorkBenchCase } from "./types";

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

const RJS_PUBLIC_CONTRACT_DOCUMENTS = [
  "problem.md",
  "acceptance-contract.md",
  "runtime-contract.md",
  "contract.d.ts",
  "source-bootstrap.md",
] as const;

export function createWorkBenchPublicContractArtifact(input: {
  id: string;
  attemptId: string;
  case: WorkBenchCase;
  createdAt?: string;
}): BenchmarkArtifact {
  if (input.case.trustedPolicy?.kind !== "recoverable-job-service") {
    throw new Error("A Recoverable Job Service case is required for a public contract artifact.");
  }
  const files = input.case.fixtureFiles ?? {};
  const metadata = parseSnapshotObject(files["case-meta.json"], "case metadata");
  const families = parseSnapshotArray(files["families.json"], "family metadata");
  const documents = Object.fromEntries(
    RJS_PUBLIC_CONTRACT_DOCUMENTS.map((path) => {
      const content = files[path];
      if (typeof content !== "string") {
        throw new Error(`Recoverable Job Service fixture is missing ${path}.`);
      }
      return [path, content];
    })
  );
  if (
    metadata.contractHash !== input.case.trustedPolicy.contractHash ||
    metadata.suiteHash !== input.case.trustedPolicy.suiteHash
  ) {
    throw new Error("Recoverable Job Service fixture and trusted policy identities differ.");
  }
  return createJsonArtifact({
    id: input.id,
    attemptId: input.attemptId,
    caseId: input.case.id,
    label: "Recoverable Job Service public contract",
    createdAt: input.createdAt,
    content: {
      schemaVersion: 1,
      benchmark: "recoverable-job-service",
      profile: metadata.profile,
      contractVersion: metadata.contractVersion,
      suiteVersion: metadata.suiteVersion,
      contractHash: metadata.contractHash,
      suiteHash: metadata.suiteHash,
      families,
      documents,
    },
  });
}

function parseSnapshotObject(source: string | undefined, label: string): Record<string, unknown> {
  const value = parseSnapshotJson(source, label);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Recoverable Job Service ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function parseSnapshotArray(source: string | undefined, label: string): unknown[] {
  const value = parseSnapshotJson(source, label);
  if (!Array.isArray(value)) {
    throw new Error(`Recoverable Job Service ${label} must be an array.`);
  }
  return value;
}

function parseSnapshotJson(source: string | undefined, label: string): unknown {
  if (typeof source !== "string") {
    throw new Error(`Recoverable Job Service fixture is missing ${label}.`);
  }
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new Error(`Recoverable Job Service ${label} is malformed.`);
  }
}
