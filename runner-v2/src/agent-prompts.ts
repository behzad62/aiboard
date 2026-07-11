import {
  ContextAssembler,
  type ContextLimits,
  type ContextPack,
  type ContextSection,
} from "./context-assembler.js";
import type { ProjectInstructionSource } from "./project-context.js";
import type { ProjectMemoryEntry } from "./project-memory.js";
import type { SchedulerProjection } from "./scheduler-store.js";
import type { SkillDocument } from "./skill-catalog.js";
import type { BuildTask } from "./task-contracts.js";

export const RUNNER_KERNEL_INVARIANTS = [
  "Use native tools for actions and lifecycle changes.",
  "Prose, verifier output, command text, and stream termination never complete work.",
  "The Architect owns task meaning, review decisions, integration intent, and completion.",
  "The kernel enforces mechanics and permissions only; it does not reinterpret intent.",
  "Inspect current repository state before editing and preserve unrelated user changes.",
].join("\n");

export interface PromptEvidence {
  id: string;
  summary: string;
  artifactHashes: string[];
}

export interface WorkerGuidanceContext {
  requestId: string;
  answer: string;
  version: number;
}

export interface BuildWorkerContextInput {
  limits: ContextLimits;
  task: BuildTask;
  guidance: WorkerGuidanceContext[];
  instructions: ProjectInstructionSource[];
  skills: SkillDocument[];
  memories: ProjectMemoryEntry[];
  repositorySnapshot: string;
  evidence: PromptEvidence[];
  recentHistory: string[];
  pendingToolResults?: string[];
}

export function buildWorkerContext(input: BuildWorkerContextInput): ContextPack {
  const sections: ContextSection[] = [
    required("kernel-invariants", "system", RUNNER_KERNEL_INVARIANTS),
    required("current-task", "task", JSON.stringify(input.task, null, 2)),
  ];
  if (input.guidance.length > 0) {
    sections.push(
      required("architect-guidance", "guidance", JSON.stringify(input.guidance, null, 2))
    );
  }
  for (const [index, result] of (input.pendingToolResults ?? []).entries()) {
    sections.push(required(`pending-tool-${index + 1}`, "tool-result", result));
  }
  for (const instruction of input.instructions) {
    sections.push({
      id: `instruction:${instruction.relativePath}`,
      kind: "instructions",
      required: false,
      priority: 900,
      sourceDigest: instruction.digest,
      content: `Source: ${instruction.relativePath}\nScope: ${instruction.scopeDirectory || "."}\n${instruction.content}`,
    });
  }
  for (const skill of input.skills) {
    sections.push({
      id: `skill:${skill.id}`,
      kind: "skill",
      required: false,
      priority: 800,
      sourceDigest: skill.digest,
      content: `Source: ${skill.relativePath}\n${skill.content}`,
    });
  }
  for (const memory of input.memories) {
    sections.push({
      id: `memory:${memory.id}`,
      kind: "memory",
      required: false,
      priority: 700,
      content: `Memory ID: ${memory.id}\nConcepts: ${memory.concepts.join(", ")}\n${memory.content}`,
    });
  }
  if (input.repositorySnapshot) {
    sections.push(optional("repository-snapshot", "repository", 600, input.repositorySnapshot));
  }
  for (const evidence of input.evidence) {
    sections.push({
      id: `evidence:${evidence.id}`,
      kind: "evidence",
      required: false,
      priority: 500,
      artifactHash: evidence.artifactHashes[0],
      content: `Evidence ID: ${evidence.id}\nArtifacts: ${evidence.artifactHashes.join(", ")}\n${evidence.summary}`,
    });
  }
  for (const [index, history] of input.recentHistory.entries()) {
    sections.push(optional(`history:${index + 1}`, "history", 100, history));
  }
  return new ContextAssembler(input.limits).assemble(sections);
}

export interface BuildArchitectContextInput {
  limits: ContextLimits;
  objective: string;
  reason: unknown;
  projection: SchedulerProjection;
  instructions: ProjectInstructionSource[];
  skills: SkillDocument[];
  memories: ProjectMemoryEntry[];
  evidence: PromptEvidence[];
  recentHistory: string[];
}

export function buildArchitectContext(
  input: BuildArchitectContextInput
): ContextPack {
  const sections: ContextSection[] = [
    required("kernel-invariants", "system", RUNNER_KERNEL_INVARIANTS),
    required("build-objective", "user-intent", input.objective),
    required("architect-action", "architect", JSON.stringify(input.reason, null, 2)),
    required(
      "task-graph",
      "task-graph",
      JSON.stringify(
        {
          status: input.projection.status,
          planRevision: input.projection.planRevision,
          tasks: input.projection.tasks,
          guidance: input.projection.guidance,
          reviews: input.projection.reviews,
        },
        null,
        2
      )
    ),
  ];
  for (const instruction of input.instructions) {
    sections.push({
      id: `instruction:${instruction.relativePath}`,
      kind: "instructions",
      required: false,
      priority: 900,
      sourceDigest: instruction.digest,
      content: `Source: ${instruction.relativePath}\n${instruction.content}`,
    });
  }
  for (const skill of input.skills) {
    sections.push({
      id: `skill:${skill.id}`,
      kind: "skill",
      required: false,
      priority: 800,
      sourceDigest: skill.digest,
      content: `Source: ${skill.relativePath}\n${skill.content}`,
    });
  }
  for (const memory of input.memories) {
    sections.push(optional(`memory:${memory.id}`, "memory", 700, memory.content));
  }
  for (const evidence of input.evidence) {
    sections.push({
      id: `evidence:${evidence.id}`,
      kind: "evidence",
      required: false,
      priority: 750,
      artifactHash: evidence.artifactHashes[0],
      content: `${evidence.summary}\nArtifacts: ${evidence.artifactHashes.join(", ")}`,
    });
  }
  for (const [index, history] of input.recentHistory.entries()) {
    sections.push(optional(`history:${index + 1}`, "history", 100, history));
  }
  return new ContextAssembler(input.limits).assemble(sections);
}

function required(id: string, kind: string, content: string): ContextSection {
  return { id, kind, required: true, priority: 1000, content };
}

function optional(
  id: string,
  kind: string,
  priority: number,
  content: string
): ContextSection {
  return { id, kind, required: false, priority, content };
}
