import type { BudgetLimits } from "./budget-ledger.js";
import type { NativeBuildUsageProjection } from "./model-usage-projection.js";
import type { EvidenceRecord } from "./evidence-store.js";

export interface ToolBenchSessionRequest {
  sessionId: string;
  runtimeId: string;
  prompt: string;
  allowedCommands: string[];
  hiddenPaths: string[];
  protectedPaths: string[];
  editablePaths: string[];
  budget: BudgetLimits;
  maxWallClockMs: number;
  browser?: boolean;
  skills?: boolean;
}

export interface ToolBenchSessionSnapshot {
  sessionId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  reason: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: { status: string; reason?: string; error?: string; errorCode?: string; turns: number };
  usage?: NativeBuildUsageProjection;
  /** Tool names offered to the model in this session (what was available, not what was used). */
  availableTools?: string[];
  tools: Array<{ sequence: number; sessionId: string; callId: string; toolName: string; status: "started" | "completed"; occurredAt: string; isError?: boolean; errorCode?: string }>;
  evidence: EvidenceRecord[];
  toolEvidence: { runId: string; tools: Array<{ sequence: number; callId: string; toolName: string; isError: boolean; errorCode?: string; input: ToolBenchEvidenceInput; outputText: string }> };
}

/** Recorded call facts used by hidden deterministic qualification (never model prose). */
export interface ToolBenchEvidenceInput {
  path?: string;
  startLine?: number;
  endLine?: number;
  editCount?: number;
  /** artifact.read: requested byte offset. */
  offset?: number;
  /** fs.search: the call continued an earlier search with its cursor. */
  continued?: boolean;
}
