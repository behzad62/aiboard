import type { AgentActor } from "./agent-contracts.js";

export interface CommandEvidenceFact {
  kind: "command";
  label: string;
  command: string;
  args: string[];
  cwd: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  outputTruncated: boolean;
  stdoutArtifactHash: string;
  stderrArtifactHash: string;
  repositoryRevision?: string;
}

export interface BrowserSnapshotEvidenceFact {
  kind: "browser_snapshot";
  label: string;
  url: string;
  title: string;
  capturedAt: string;
  htmlArtifactHash: string;
  htmlBytes: number;
  truncated: boolean;
}

export interface BrowserScreenshotEvidenceFact {
  kind: "browser_screenshot";
  label: string;
  capturedAt: string;
  screenshotArtifactHash: string;
  mediaType: "image/png";
  byteLength: number;
}

export interface BrowserEventsEvidenceFact {
  kind: "browser_events";
  label: string;
  capturedAt: string;
  eventsArtifactHash: string;
  consoleEventCount: number;
  consoleErrorCount: number;
  networkEventCount: number;
  networkFailureCount: number;
}

export type EvidenceFact =
  | CommandEvidenceFact
  | BrowserSnapshotEvidenceFact
  | BrowserScreenshotEvidenceFact
  | BrowserEventsEvidenceFact;

export function evidenceFactArtifactHashes(fact: EvidenceFact): string[] {
  switch (fact.kind) {
    case "command":
      return [fact.stdoutArtifactHash, fact.stderrArtifactHash];
    case "browser_snapshot":
      return [fact.htmlArtifactHash];
    case "browser_screenshot":
      return [fact.screenshotArtifactHash];
    case "browser_events":
      return [fact.eventsArtifactHash];
  }
}

export function evidenceFactSummary(fact: EvidenceFact): string {
  switch (fact.kind) {
    case "command":
      return `${fact.command} exited ${fact.exitCode}`;
    case "browser_snapshot":
      return `browser snapshot "${fact.title}" at ${fact.url}`;
    case "browser_screenshot":
      return `browser screenshot (${fact.byteLength} bytes)`;
    case "browser_events":
      return `browser events: ${fact.consoleErrorCount} console errors, ${fact.networkFailureCount} network failures`;
  }
}

export interface EvidenceRecord {
  id: string;
  runId: string;
  taskId: string;
  actor: AgentActor;
  status: "observed";
  fact: EvidenceFact;
  createdAt: string;
  idempotencyKey: string;
}

export interface RecordEvidenceInput {
  runId: string;
  taskId: string;
  actor: AgentActor;
  fact: EvidenceFact;
  createdAt: string;
  idempotencyKey: string;
}

export interface ListEvidenceInput {
  runId: string;
  taskId?: string;
  limit?: number;
}

export interface EvidenceStore {
  record(input: RecordEvidenceInput): EvidenceRecord;
  list(input: ListEvidenceInput): EvidenceRecord[];
  close(): void;
}
