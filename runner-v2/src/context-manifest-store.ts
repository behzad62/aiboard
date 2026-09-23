import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type { AgentActor } from "./agent-contracts.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { ModelCallRole } from "./budget-ledger.js";
import type {
  ContextLimits,
  ContextOmission,
  ContextPack,
  IncludedContextSection,
} from "./context-assembler.js";

export type ContextManifestSection = IncludedContextSection;

export interface ContextManifestInput {
  runId: string;
  sessionId: string;
  actor: AgentActor;
  role: ModelCallRole;
  /** Stable purpose label, e.g. "architect:review_required", "worker:task", "verifier:verdict". */
  purpose: string;
  taskId?: string;
  attempt?: number;
  repositoryRevision?: string;
  limits: ContextLimits;
  pack: ContextPack;
  packArtifactHash?: string;
  recordedAt: string;
}

export interface ContextManifest {
  manifestId: string;
  runId: string;
  sessionId: string;
  actor: AgentActor;
  role: ModelCallRole;
  purpose: string;
  taskId?: string;
  attempt?: number;
  repositoryRevision?: string;
  limits: ContextLimits;
  packDigest: string;
  byteLength: number;
  estimatedTokens: number;
  sections: ContextManifestSection[];
  omissions: ContextOmission[];
  packArtifactHash?: string;
  recordedAt: string;
}

export interface ContextManifestStore {
  record(input: ContextManifestInput): ContextManifest;
  get(manifestId: string): ContextManifest | undefined;
  listRun(runId: string): ContextManifest[];
  close(): void;
}

export class ContextManifestParseError extends Error {
  constructor(readonly manifestId: string, cause?: unknown) {
    super(`Context manifest ${manifestId} contains invalid payload JSON.`);
    this.name = "ContextManifestParseError";
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/** Total attempts, including the first. A locked SQLite file, a full disk, or an antivirus handle is retried inside this bound. */
export const CONTEXT_MANIFEST_RECORD_MAX_ATTEMPTS = 3;

/** Sleep after each failed attempt, before the next one. Two delays cover the three-attempt bound. */
export const CONTEXT_MANIFEST_RECORD_BACKOFF_MS = [50, 150] as const;

export class ContextManifestRecordingError extends Error {
  readonly runId: string;
  readonly sessionId: string;
  readonly purpose: string;
  readonly attempts: number;

  constructor(
    details: {
      runId: string;
      sessionId: string;
      purpose: string;
      attempts: number;
    },
    cause: unknown,
  ) {
    super(
      `Context manifest recording failed after ${details.attempts} attempts (run ${details.runId}, purpose ${details.purpose}).`,
    );
    this.name = "ContextManifestRecordingError";
    this.runId = details.runId;
    this.sessionId = details.sessionId;
    this.purpose = details.purpose;
    this.attempts = details.attempts;
    this.cause = cause;
  }
}

export function parseContextManifestPayload(
  payloadJson: string,
  manifestId: string,
): ContextManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch (error) {
    throw new ContextManifestParseError(manifestId, error);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ContextManifestParseError(manifestId);
  }
  return parsed as ContextManifest;
}

export function contextManifestId(
  input: Pick<ContextManifestInput, "runId" | "sessionId" | "purpose" | "taskId" | "attempt" | "repositoryRevision"> & {
    pack: Pick<ContextPack, "digest">;
  },
): string {
  return createHash("sha256")
    .update(JSON.stringify([
      input.runId,
      input.sessionId,
      input.purpose,
      input.taskId ?? null,
      input.attempt ?? null,
      input.repositoryRevision ?? null,
      input.pack.digest,
    ]))
    .digest("hex");
}

export function toContextManifest(input: ContextManifestInput): ContextManifest {
  return {
    manifestId: contextManifestId(input),
    runId: input.runId,
    sessionId: input.sessionId,
    actor: { ...input.actor },
    role: input.role,
    purpose: input.purpose,
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
    ...(input.repositoryRevision !== undefined ? { repositoryRevision: input.repositoryRevision } : {}),
    limits: { ...input.limits },
    packDigest: input.pack.digest,
    byteLength: input.pack.byteLength,
    estimatedTokens: input.pack.estimatedTokens,
    sections: input.pack.sections.map((section) => ({ ...section })),
    omissions: input.pack.omissions.map((omission) => ({ ...omission })),
    ...(input.packArtifactHash ? { packArtifactHash: input.packArtifactHash } : {}),
    recordedAt: input.recordedAt,
  };
}

export interface RecordContextPackInput extends Omit<ContextManifestInput, "packArtifactHash"> {
  store?: ContextManifestStore;
  artifacts?: ArtifactStore;
  recordPackText?: boolean;
  /** Injected by tests. Call sites omit it; the default waits the backoff schedule. */
  sleep?: (milliseconds: number) => Promise<void>;
  /** Injected by tests. Call sites omit it; the default is CONTEXT_MANIFEST_RECORD_MAX_ATTEMPTS. */
  attemptBound?: number;
}

/**
 * Process-local recording suspension. Not durable: B2 re-derives it from the
 * waiver event whenever a runtime is constructed.
 */
const contextRecordingSuspensions = new Map<string, string>();

export function suspendContextRecording(runId: string, reason: string): void {
  contextRecordingSuspensions.set(runId, reason);
}

export function isContextRecordingSuspended(runId: string): boolean {
  return contextRecordingSuspensions.has(runId);
}

export function clearContextRecordingSuspension(runId: string): void {
  contextRecordingSuspensions.delete(runId);
}

function defaultContextManifestRetrySleep(milliseconds: number): Promise<void> {
  return delay(milliseconds);
}

function resolveAttemptBound(attemptBound: number): number {
  if (Number.isSafeInteger(attemptBound) && attemptBound >= 1) return attemptBound;
  return CONTEXT_MANIFEST_RECORD_MAX_ATTEMPTS;
}

function retryBackoff(failedAttempt: number): number {
  const index = Math.min(failedAttempt - 1, CONTEXT_MANIFEST_RECORD_BACKOFF_MS.length - 1);
  return CONTEXT_MANIFEST_RECORD_BACKOFF_MS[index];
}

/** No-op without a store; stores the rendered text as an artifact only when asked. */
export async function recordContextPack(
  input: RecordContextPackInput,
): Promise<ContextManifest | undefined> {
  if (isContextRecordingSuspended(input.runId)) return undefined;
  const {
    store,
    artifacts,
    recordPackText,
    sleep = defaultContextManifestRetrySleep,
    attemptBound = CONTEXT_MANIFEST_RECORD_MAX_ATTEMPTS,
    ...manifest
  } = input;
  if (!store) return undefined;
  const attempts = resolveAttemptBound(attemptBound);
  let lastCause: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const packArtifactHash = recordPackText && artifacts
        ? (await artifacts.put(Buffer.from(manifest.pack.text, "utf8"), "text/markdown", "context-pack")).hash
        : undefined;
      return store.record({
        ...manifest,
        ...(packArtifactHash ? { packArtifactHash } : {}),
      });
    } catch (cause) {
      lastCause = cause;
      if (attempt < attempts) await sleep(retryBackoff(attempt));
    }
  }
  throw new ContextManifestRecordingError(
    {
      runId: manifest.runId,
      sessionId: manifest.sessionId,
      purpose: manifest.purpose,
      attempts,
    },
    lastCause,
  );
}
