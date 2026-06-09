export interface UserSettings {
  id: string;
  defaultEffort: EffortLevel;
  defaultMode: DiscussionMode;
  judgeModelId: string | null;
}

export interface ProviderKey {
  providerId: string;
  encryptedKey: string;
  iv: string;
  authTag: string;
  defaultModel: string | null;
  enabled: boolean;
  keyHint: string | null;
  updatedAt: string;
}

export interface Discussion {
  id: string;
  topic: string;
  mode: DiscussionMode;
  effort: EffortLevel;
  status: DiscussionStatus;
  modelIds: string;
  judgeModelId: string | null;
  attachmentIds: string | null;
  currentRound: number;
  maxRounds: number;
  convergenceScore: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  discussionId: string;
  round: number;
  modelId: string;
  role: string;
  content: string;
  createdAt: string;
}

export interface FinalResult {
  discussionId: string;
  answer: string;
  confidence: number;
  dissent: string | null;
  createdAt: string;
}

export type DiscussionStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed";

export type DiscussionMode = "panel" | "debate" | "specialist";
export type EffortLevel = "low" | "medium" | "high";

// Legacy schema export for imports
export const schema = {};
