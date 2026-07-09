export type SkillActor = "architect" | "worker" | "reviewer" | "all";

export type SkillLifecyclePhase =
  | "define"
  | "plan"
  | "build"
  | "verify"
  | "review"
  | "ship"
  | "meta";

export type SkillActivationPhase =
  | "intake"
  | "plan"
  | "worker"
  | "review"
  | "summary"
  | "ship";

export type SkillPersistence = "always" | "session" | "phase" | "task" | "review";

export type SkillSource = "aiboard" | "agent-skills" | "superpowers" | "custom";

export type BuildSkillMode = "fast" | "balanced" | "strict" | "safe";

export interface SkillCard {
  id: string;
  source: SkillSource;
  title: string;
  phase: SkillLifecyclePhase;
  actors: SkillActor[];
  persistence: SkillPersistence;
  triggers: string[];
  conflicts?: string[];
  dependencies?: string[];
  compact: string;
  fullMarkdown?: string;
  references?: string[];
  riskLevel?: "low" | "medium" | "high";
  evidenceRequirements?: string[];
}

export interface SkillTaskLike {
  id?: string;
  title?: string;
  kind?: "modify" | "audit" | "verify" | "repo";
  completionMode?: "files" | "evidence" | "either";
  verificationPolicy?: "architect" | "tool" | "external" | "none";
  instructions?: string;
  contextFiles?: string[];
  outputPaths?: string[];
  testOutputPaths?: string[];
  expectedOutputs?: string;
  status?: string;
}

export interface SkillActivationInput {
  phase: SkillActivationPhase;
  actor: SkillActor;
  userRequest: string;
  skillMode?: BuildSkillMode;
  requestedSkillIds?: string[];
  task?: SkillTaskLike;
  touchedPaths?: string[];
  runnerAvailable: boolean;
  repoAvailable: boolean;
  mcpServers?: string[];
  riskFlags: string[];
}

export interface SkillActivation {
  always: string[];
  index: string[];
  overlays: string[];
  evidenceRequired: string[];
  warnings: string[];
}

export interface SkillEvidence {
  taskId?: string;
  skillId: string;
  actor: string;
  required: string[];
  reportedEvidence: string[];
  missingEvidence: string[];
  violations: string[];
}

export interface BuildSkillEvent {
  scope: string;
  phase: SkillActivationPhase;
  actor: SkillActor;
  activeSkills: string[];
  evidence?: SkillEvidence[];
  warnings?: string[];
}
