export interface UserGuidanceSubmission {
  guidanceId: string;
  text: string;
  version: number;
}

export interface UserGuidanceAcknowledgement {
  guidanceId: string;
  expectedVersion: number;
  acknowledgement: string;
}

export interface ArchitectQuestionRequest {
  questionId: string;
  question: string;
  version: number;
}

export interface ArchitectQuestionAnswer {
  questionId: string;
  expectedVersion: number;
  answer: string;
}

export interface UserGuidanceItem extends UserGuidanceSubmission {
  status: "submitted" | "acknowledged";
  acknowledgement?: string;
}

export interface ArchitectQuestionItem extends ArchitectQuestionRequest {
  status: "open" | "answered";
  answer?: string;
}

export function parseUserGuidanceSubmission(payload: Record<string, unknown>): UserGuidanceSubmission {
  assertExactKeys(payload, ["guidanceId", "text", "version"]);
  return {
    guidanceId: requiredText(payload, "guidanceId"),
    text: requiredText(payload, "text"),
    version: requiredPositiveInteger(payload, "version"),
  };
}

export function parseUserGuidanceAcknowledgement(payload: Record<string, unknown>): UserGuidanceAcknowledgement {
  assertExactKeys(payload, ["guidanceId", "expectedVersion", "acknowledgement"]);
  return {
    guidanceId: requiredText(payload, "guidanceId"),
    expectedVersion: requiredPositiveInteger(payload, "expectedVersion"),
    acknowledgement: requiredText(payload, "acknowledgement"),
  };
}

export function parseArchitectQuestionRequest(payload: Record<string, unknown>): ArchitectQuestionRequest {
  assertExactKeys(payload, ["questionId", "question", "version"]);
  return {
    questionId: requiredText(payload, "questionId"),
    question: requiredText(payload, "question"),
    version: requiredPositiveInteger(payload, "version"),
  };
}

export function parseArchitectQuestionAnswer(payload: Record<string, unknown>): ArchitectQuestionAnswer {
  assertExactKeys(payload, ["questionId", "expectedVersion", "answer"]);
  return {
    questionId: requiredText(payload, "questionId"),
    expectedVersion: requiredPositiveInteger(payload, "expectedVersion"),
    answer: requiredText(payload, "answer"),
  };
}

function assertExactKeys(payload: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(payload).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`Unknown user-steering payload field(s): ${unknown.join(", ")}.`);
}

function requiredText(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required.`);
  return value;
}

function requiredPositiveInteger(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${key} must be a positive integer.`);
  }
  return value as number;
}
