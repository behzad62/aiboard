export interface ModelPricingOverride {
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  cachedInputUsdPer1M?: number | null;
  updatedAt: string;
}

export interface UserSettings {
  id: string;
  defaultEffort: EffortLevel;
  defaultMode: DiscussionMode;
  judgeModelId: string | null;
  defaultVerbosity?: Verbosity;
  defaultStyleNote?: string;
  defaultReasoningEffort?: ReasoningEffort;
  modelPricingOverrides?: Record<string, ModelPricingOverride>;
}

export interface ProviderKey {
  providerId: string;
  // Server representation: AES-encrypted at rest with ENCRYPTION_SECRET.
  encryptedKey?: string;
  iv?: string;
  authTag?: string;
  // Client representation: plaintext key, protected by the store-level passphrase
  // envelope (see lib/client/crypto-box.ts). Set after the browser-side migration.
  apiKey?: string;
  defaultModel: string | null;
  enabled: boolean;
  keyHint: string | null;
  lastValidationSucceeded?: boolean | null;
  lastValidatedAt?: string | null;
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
  /** Build mode: display name of the granted project folder (handle lives in IndexedDB). */
  projectFolderName?: string | null;
  /** Build mode: optional local command runner (user-started; opt-in). */
  runnerUrl?: string | null;
  runnerToken?: string | null;
  /** "ask" = approve each command in the UI; "full" = run without asking. */
  runnerAccess?: "ask" | "full" | null;
  currentRound: number;
  maxRounds: number;
  convergenceScore: number | null;
  verbosity?: Verbosity;
  styleNote?: string | null;
  reasoningEffort?: ReasoningEffort;
  createdAt: string;
  updatedAt: string;
}

/**
 * A user-defined, OpenAI-API-compatible model endpoint (e.g. a local Gemma via
 * Ollama/LM Studio, or any hosted OpenAI-compatible server). Reached with the
 * OpenAI SDK pointed at `baseURL`. Treated as text-only.
 */
export interface CustomModel {
  id: string;
  label: string;
  baseURL: string;
  model: string;
  encryptedKey?: string | null;
  iv?: string | null;
  authTag?: string | null;
  /** Client representation: plaintext key, protected by the store-level envelope. */
  apiKey?: string;
  hasKey: boolean;
  /** Which non-text inputs this endpoint accepts. Defaults to all false. */
  capabilities?: {
    image: boolean;
    document: boolean;
    audio: boolean;
    video: boolean;
  };
  lastValidationSucceeded?: boolean | null;
  lastValidatedAt?: string | null;
  createdAt: string;
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

export type DiscussionMode = "panel" | "debate" | "specialist" | "build";
export type EffortLevel = "low" | "medium" | "high";
export type Verbosity = "brief" | "balanced" | "comprehensive" | "exhaustive";
/** Per-model reasoning effort, mapped to each provider's parameter. */
export type ReasoningEffort = "default" | "low" | "medium" | "high" | "max";

// Legacy schema export for imports
export const schema = {};
