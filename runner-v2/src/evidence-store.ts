import type { AgentActor } from "./agent-contracts.js";
import type { ProcessCleanupStatus } from "./execution-safety-contracts.js";
import type {
  EvidenceApplicabilityDecision,
  ValidationObservation,
} from "./planning-contracts.js";

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
  outputLossy?: boolean;
  errorCode?: string;
  cleanup?: ProcessCleanupStatus;
  enforcement?: "write_confinement_exact_grant" | "unconfined_explicit_full";
  disclosure?: "provider_specific_not_universal_boundary" | "unconfined_explicit_full";
  providerId?: string;
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
  /** Attempt identity for new records; omitted on legacy evidence rows. */
  attempt?: number;
}

export interface RecordEvidenceInput {
  runId: string;
  taskId: string;
  actor: AgentActor;
  fact: EvidenceFact;
  createdAt: string;
  idempotencyKey: string;
  attempt?: number;
}

export interface ListEvidenceInput {
  runId: string;
  taskId?: string;
  limit?: number;
}

export interface GetEvidenceByIdsInput {
  runId: string;
  ids: readonly string[];
  taskId?: string;
}

export interface EvidenceStore {
  record(input: RecordEvidenceInput): EvidenceRecord;
  list(input: ListEvidenceInput): EvidenceRecord[];
  /** Resolve only the requested immutable IDs; missing IDs are omitted. */
  getByIds(input: GetEvidenceByIdsInput): EvidenceRecord[];
  close(): void;
}

// ---------------------------------------------------------------------------
// T5 (P6.6): durable validation observations and applicability decisions.
// Additive only: the EvidenceStore interface above is unchanged so every
// existing fake/consumer keeps compiling and existing tests stay green.
// New code requiring observation/applicability storage depends on
// ExtendedEvidenceStore instead.
// ---------------------------------------------------------------------------

/**
 * T5 acceptance-identity envelope: the fields acceptance needs after a
 * restart that live alongside (not inside) T1's frozen ValidationObservation
 * (capability fingerprint, dirty-content digest, artifact hashes, skip
 * rationale). Config/dependency fingerprints and per-assertion lists already
 * live inside the frozen observation.
 */
export interface ValidationObservationEnvelope {
  capabilityFingerprint: string;
  uncommittedContentDigest?: string;
  artifactHashes: readonly string[];
  skipRationale?: string;
}

export interface StoredValidationObservation extends Partial<ValidationObservationEnvelope> {
  id: string;
  runId: string;
  observation: ValidationObservation;
  createdAt: string;
  idempotencyKey: string;
}

export interface RecordObservationInput extends Partial<ValidationObservationEnvelope> {
  runId: string;
  observation: ValidationObservation;
  /** Required: acceptance re-runs from durable state after a restart. */
  capabilityFingerprint: string;
  /** Required: substituted-artifact checks need them after a restart. */
  artifactHashes: readonly string[];
  createdAt: string;
  idempotencyKey: string;
}

export interface ListObservationsInput {
  runId: string;
  limit?: number;
}

export interface StoredApplicabilityDecision {
  id: string;
  runId: string;
  decision: EvidenceApplicabilityDecision;
  createdAt: string;
  idempotencyKey: string;
}

export interface RecordApplicabilityInput {
  runId: string;
  decision: EvidenceApplicabilityDecision;
  createdAt: string;
  idempotencyKey: string;
}

export interface ListApplicabilityInput {
  runId: string;
  limit?: number;
}

export interface ExtendedEvidenceStore extends EvidenceStore {
  recordObservation(input: RecordObservationInput): StoredValidationObservation;
  listObservations(input: ListObservationsInput): StoredValidationObservation[];
  recordApplicability(input: RecordApplicabilityInput): StoredApplicabilityDecision;
  listApplicability(input: ListApplicabilityInput): StoredApplicabilityDecision[];
}
