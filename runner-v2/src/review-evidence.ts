import type { ToolInvocationLedger } from "./tool-ledger.js";
import type { EvidenceStore } from "./evidence-store.js";
import { evidenceFactArtifactHashes } from "./evidence-store.js";

export type ReviewCitation = { path: string; line: number } | { evidenceId: string };
export interface ReviewReadFact {
  invocationKey: string;
  completedSequence: number;
  toolName: "fs.read" | "inspect_evidence" | "artifact.read";
  path?: string;
  startLine?: number;
  endLine?: number;
  evidenceId?: string;
  artifactHash?: string;
}
export interface ReviewReadCapture {
  runId: string; taskId: string; reviewId: string; changeSetId: string; submissionAttempt: number;
  reviewerRuntimeId: string; reviewerModelIdentity: string; sessionId: string;
  reads: ReviewReadFact[];
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

/** Derive authority exclusively from successful completed native tool results.
 * The returned content, rather than requested ranges, bounds a location read.
 * Large/opaque outputs and partial artifacts conservatively grant no authority.
 */
export function captureReviewReads(ledger: ToolInvocationLedger, binding: Omit<ReviewReadCapture, "reads">, evidence?: EvidenceStore): ReviewReadCapture {
  const events = ledger.listRun(binding.runId);
  const reads: ReviewReadFact[] = [];
  for (const completed of events) {
    if (completed.type !== "tool.completed" || completed.runId !== binding.runId || completed.sessionId !== binding.sessionId || !completed.result || completed.result.isError) continue;
    // A replay-safe retry is a new actual invocation; never borrow its earlier actor.
    const started = events.filter((e) => e.key === completed.key && e.fingerprint === completed.fingerprint && e.sequence < completed.sequence && (e.type === "tool.started" || e.type === "tool.retry_started")).sort((a, b) => b.sequence - a.sequence)[0];
    if (!started || started.runId !== binding.runId || started.sessionId !== binding.sessionId || started.toolName !== completed.result.toolName || started.effect !== "none" || started.extensionId || started.outsideWorkspace || started.actor?.role !== "verifier" || started.actor.id !== binding.reviewerRuntimeId) continue;
    const result = completed.result;
    const values = result.content.filter((b) => b.type === "json").map((b) => b.value);
    const text = result.content.filter((b) => b.type === "text").map((b) => b.text);
    const base = { invocationKey: completed.key, completedSequence: completed.sequence };
    if (result.toolName === "fs.read") {
      const meta = values[0];
      if (!record(meta) || typeof meta.path !== "string" || text.length !== 1 || !text[0] || result.content.some((b) => b.type === "artifact")) continue;
      const content = text[0];
      const startLine = meta.startLine ?? 1;
      const endLine = meta.endLine ?? content.split("\n").length;
      if (!positive(startLine) || !positive(endLine) || endLine < startLine) continue;
      // Whole reads must be byte-complete; ranged reads must contain their actual returned range.
      if (meta.startLine === undefined ? Buffer.byteLength(content) !== meta.byteLength : content.split("\n").length < endLine - startLine + 1) continue;
      reads.push({ ...base, toolName: "fs.read", path: meta.path, startLine, endLine });
    } else if (result.toolName === "inspect_evidence") {
      if (!Array.isArray(values[0])) continue;
      for (const item of values[0]) {
        if (record(item) && typeof item.id === "string" && item.runId === binding.runId && item.taskId === binding.taskId && evidence?.getByIds({ runId: binding.runId, ids: [item.id] }).some((e) => e.id === item.id && e.taskId === binding.taskId)) reads.push({ ...base, toolName: "inspect_evidence", evidenceId: item.id });
      }
    } else if (result.toolName === "artifact.read") {
      const meta = values[0];
      if (!record(meta)) continue;
      // Bound to a const: property narrowing does not survive into closures over the evidence list.
      const hash = meta.hash;
      if (typeof hash !== "string" || meta.encoding !== "utf8" || meta.offset !== 0 || meta.truncated !== false || !positive(meta.returnedBytes) || meta.returnedBytes !== meta.byteLength || text.length !== 1 || Buffer.byteLength(text[0]!) !== meta.returnedBytes) continue;
      for (const item of evidence?.list({ runId: binding.runId, taskId: binding.taskId }) ?? []) {
        if (evidenceFactArtifactHashes(item.fact).includes(hash)) reads.push({ ...base, toolName: "artifact.read", evidenceId: item.id, artifactHash: hash });
      }
    }
  }
  return { ...binding, reads };
}

export function validateReadCapture(value: unknown, binding: Omit<ReviewReadCapture, "reads">): ReviewReadCapture {
  if (!record(value) || Object.entries(binding).some(([key, expected]) => value[key] !== expected) || !Array.isArray(value.reads)) throw new Error("Review read capture must bind the exact current review, submission, reviewer and session.");
  const reads: ReviewReadFact[] = value.reads.map((read) => {
    if (!record(read) || typeof read.invocationKey !== "string" || !read.invocationKey.startsWith(`${binding.runId}\0${binding.sessionId}\0`) || !positive(read.completedSequence)) throw new Error("Invalid completed review read identity.");
    if (read.toolName === "fs.read") {
      if (typeof read.path !== "string" || !read.path || !positive(read.startLine) || !positive(read.endLine) || read.endLine < read.startLine) throw new Error("Invalid review read range.");
      return { invocationKey: read.invocationKey, completedSequence: read.completedSequence, toolName: "fs.read", path: read.path, startLine: read.startLine, endLine: read.endLine };
    }
    if ((read.toolName !== "inspect_evidence" && read.toolName !== "artifact.read") || typeof read.evidenceId !== "string" || !read.evidenceId || (read.toolName === "artifact.read" && (typeof read.artifactHash !== "string" || !/^[a-f0-9]{64}$/.test(read.artifactHash)))) throw new Error("Invalid evidence content read.");
    return { invocationKey: read.invocationKey, completedSequence: read.completedSequence, toolName: read.toolName, evidenceId: read.evidenceId, ...(read.toolName === "artifact.read" ? { artifactHash: read.artifactHash as string } : {}) };
  });
  return { ...binding, reads };
}

export function validateCitations(value: unknown, capture: ReviewReadCapture | undefined): ReviewCitation[] {
  if (!capture || !Array.isArray(value) || value.length === 0) throw new Error("A verified claim requires a citation actually read in this review session.");
  return value.map((citation) => {
    if (!record(citation)) throw new Error("Invalid review citation.");
    if (typeof citation.path === "string" && positive(citation.line) && Object.keys(citation).every((key) => key === "path" || key === "line")) {
      const line = citation.line;
      if (!capture.reads.some((read) => read.path === citation.path && read.startLine! <= line && read.endLine! >= line)) throw new Error("Citation location was not read in this review session.");
      return { path: citation.path, line: citation.line };
    }
    if (typeof citation.evidenceId === "string" && Object.keys(citation).length === 1 && capture.reads.some((read) => read.evidenceId === citation.evidenceId)) return { evidenceId: citation.evidenceId };
    throw new Error("Citation evidence was not read in this review session.");
  });
}

/**
 * W3 (AR-R29/AR-3): the canonical Architect turn session for a run. Every
 * Architect turn runs under this session id, so same-session read authority
 * binds to it; notes and other roles use different sessions.
 */
export function architectTurnSessionId(runId: string): string {
  return `architect:${runId}`;
}

/**
 * W3: one Architect-session evidence read, captured from actual successful
 * ledger facts (never model-provided). inspect_evidence proofs always bind an
 * evidence id; artifact.read proofs bind the exact bytes read, plus the
 * owning evidence id when the hash belongs to same-task evidence.
 */
export interface ArchitectReadProof {
  toolName: "inspect_evidence" | "artifact.read";
  invocationKey: string;
  completedSequence: number;
  evidenceId?: string;
  artifactHash?: string;
}

export interface ArchitectEvidenceReadBinding {
  runId: string;
  sessionId: string;
  actorId: string;
  taskId: string;
}

/**
 * W3: derive Architect-session evidence reads exclusively from successful
 * completed native tool results, mirroring captureReviewReads. Only
 * inspect_evidence and complete artifact.read facts count; failed, foreign
 * session/actor, partial/truncated, or non-architect reads grant nothing.
 * Complete artifact reads whose hash belongs to no same-task evidence are
 * still returned (artifactHash only): the kernel matches them against the
 * submitted diff for evidence-less claims.
 */
export function captureArchitectEvidenceReads(
  ledger: ToolInvocationLedger,
  binding: ArchitectEvidenceReadBinding,
  evidence?: EvidenceStore,
): ArchitectReadProof[] {
  const events = ledger.listRun(binding.runId);
  const proofs: ArchitectReadProof[] = [];
  for (const completed of events) {
    if (completed.type !== "tool.completed" || completed.runId !== binding.runId || completed.sessionId !== binding.sessionId || !completed.result || completed.result.isError) continue;
    const started = events.filter((e) => e.key === completed.key && e.fingerprint === completed.fingerprint && e.sequence < completed.sequence && (e.type === "tool.started" || e.type === "tool.retry_started")).sort((a, b) => b.sequence - a.sequence)[0];
    if (!started || started.runId !== binding.runId || started.sessionId !== binding.sessionId || started.toolName !== completed.result.toolName || started.effect !== "none" || started.extensionId || started.outsideWorkspace || started.actor?.role !== "architect" || started.actor.id !== binding.actorId) continue;
    const result = completed.result;
    const values = result.content.filter((b) => b.type === "json").map((b) => b.value);
    const text = result.content.filter((b) => b.type === "text").map((b) => b.text);
    if (result.toolName === "inspect_evidence") {
      if (!Array.isArray(values[0])) continue;
      for (const item of values[0]) {
        if (record(item) && typeof item.id === "string" && item.runId === binding.runId && item.taskId === binding.taskId && evidence?.getByIds({ runId: binding.runId, ids: [item.id] }).some((e) => e.id === item.id && e.taskId === binding.taskId)) {
          proofs.push({ toolName: "inspect_evidence", invocationKey: completed.key, completedSequence: completed.sequence, evidenceId: item.id });
        }
      }
    } else if (result.toolName === "artifact.read") {
      const meta = values[0];
      if (!record(meta)) continue;
      // Bound to a const: property narrowing does not survive into the filter closure below.
      const hash = meta.hash;
      if (typeof hash !== "string" || meta.encoding !== "utf8" || meta.offset !== 0 || meta.truncated !== false || !positive(meta.returnedBytes) || meta.returnedBytes !== meta.byteLength || text.length !== 1 || Buffer.byteLength(text[0]!) !== meta.returnedBytes) continue;
      const owners = (evidence?.list({ runId: binding.runId, taskId: binding.taskId }) ?? [])
        .filter((item) => evidenceFactArtifactHashes(item.fact).includes(hash));
      if (owners.length === 0) {
        proofs.push({ toolName: "artifact.read", invocationKey: completed.key, completedSequence: completed.sequence, artifactHash: hash });
      }
      for (const item of owners) {
        proofs.push({ toolName: "artifact.read", invocationKey: completed.key, completedSequence: completed.sequence, evidenceId: item.id, artifactHash: hash });
      }
    }
  }
  return proofs;
}

/**
 * W3: structural validation of a runner-attested read proof (the kernel side;
 * the tool side derives proofs from the ledger, never from model input).
 */
export function validateArchitectReadProof(value: unknown, runId: string, sessionId: string): ArchitectReadProof {
  if (!record(value)) throw new Error("Architect read proof is invalid.");
  if (value.toolName !== "inspect_evidence" && value.toolName !== "artifact.read") throw new Error("Architect read proof names an unknown read primitive.");
  if (typeof value.invocationKey !== "string" || !value.invocationKey.startsWith(`${runId}\0${sessionId}\0`)) throw new Error("Architect read proof is not bound to this Architect session.");
  if (!positive(value.completedSequence)) throw new Error("Architect read proof has no completed sequence.");
  if (value.toolName === "inspect_evidence") {
    if (typeof value.evidenceId !== "string" || !value.evidenceId) throw new Error("Architect inspect_evidence proof requires its evidence id.");
    return { toolName: "inspect_evidence", invocationKey: value.invocationKey, completedSequence: value.completedSequence, evidenceId: value.evidenceId };
  }
  if (typeof value.artifactHash !== "string" || !/^[a-f0-9]{64}$/.test(value.artifactHash)) throw new Error("Architect artifact.read proof requires the exact bytes read.");
  if (value.evidenceId !== undefined && (typeof value.evidenceId !== "string" || !value.evidenceId)) throw new Error("Architect artifact.read proof carries an invalid evidence id.");
  return {
    toolName: "artifact.read",
    invocationKey: value.invocationKey,
    completedSequence: value.completedSequence,
    ...(value.evidenceId !== undefined ? { evidenceId: value.evidenceId as string } : {}),
    artifactHash: value.artifactHash,
  };
}

/** W3: cited evidence ids with no covering read proof. */
export function architectReadProofsCoverEvidence(
  proofs: readonly ArchitectReadProof[],
  evidenceIds: readonly string[],
): string[] {
  return evidenceIds.filter((id) => !proofs.some((proof) => proof.evidenceId === id));
}

/** A fix review carries open findings without changing their authority. */
export function isMutationSurvivorFindingId(id: string): boolean {
  return id.replace(/^(?:carried:)+/, "").startsWith("mutation-survivor:");
}
