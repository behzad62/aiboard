import { createHash } from "node:crypto";

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
}

/** No-op without a store; stores the rendered text as an artifact only when asked. */
export async function recordContextPack(
  input: RecordContextPackInput,
): Promise<ContextManifest | undefined> {
  const { store, artifacts, recordPackText, ...manifest } = input;
  if (!store) return undefined;
  const packArtifactHash = recordPackText && artifacts
    ? (await artifacts.put(Buffer.from(manifest.pack.text, "utf8"), "text/markdown", "context-pack")).hash
    : undefined;
  return store.record({
    ...manifest,
    ...(packArtifactHash ? { packArtifactHash } : {}),
  });
}
