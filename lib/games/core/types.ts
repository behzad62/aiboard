export type GameId = "chess" | (string & {});

export type GameSessionStatus =
  | "setup"
  | "active"
  | "paused"
  | "complete"
  | "abandoned";

export interface GameParticipant {
  id: string;
  kind: "human" | "ai";
  label: string;
  modelId?: string;
  reasoningEffort?: string;
}

export interface GameAIInteraction {
  actorId: string;
  gesture?:
    | "thinking"
    | "confident"
    | "confused"
    | "celebrating"
    | "apologetic"
    | "neutral";
  utterance?: string;
  confidence?: number;
  diagnostics?: string;
}

export interface GameSessionRecord {
  id: string;
  gameId: GameId;
  title: string;
  status: GameSessionStatus;
  participants: GameParticipant[];
  stateJson: string;
  metadataJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface GenericGameMatchRecord {
  id: string;
  gameId: GameId;
  timestamp: string;
  participants: GameParticipant[];
  resultJson: string;
  statsJson: string;
}

export interface GameExport {
  filename: string;
  mimeType: "text/plain" | "application/json";
  content: string;
}
