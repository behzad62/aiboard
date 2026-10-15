/** Browser-safe planning protocol shapes; server validation owns authority. */
export interface ApprovedSourceInputV1 {
  readonly version: 1;
  /** Explicit owner intent: these exact bytes are the approved specification. */
  readonly approval: "approved_spec";
  /** Canonical base64 of the original bytes (strict round-trip). */
  readonly bytesBase64: string;
  readonly mediaType: "text/plain" | "text/markdown";
  readonly encoding: "utf-8";
  /**
   * Ordered section layout over byte offsets. Omitted only when the approved
   * document carries no inventory: the whole document is then one complete
   * section (honest, no invented classification).
   */
  readonly sections?: readonly {
    readonly id: string;
    readonly title?: string;
    readonly startByte: number;
    readonly endByte: number;
  }[];
}

export interface ExplicitStartIdentityV1 {
  readonly planRevisionId: string;
  readonly planDigest: string;
  readonly sourceManifestId: string;
  readonly sourceArtifactDigest: string;
  readonly planningPolicyVersion: 1;
  readonly projectDocsPolicyVersion: number;
}

export interface ExplicitStartAuthorizationV1 extends ExplicitStartIdentityV1 {
  readonly version: 1;
  /** The owner's explicit choice (wording owned by T7c; bound exactly). */
  readonly ownerChoice: "execute";
}

export interface ExplicitStartRequestV1 extends ExplicitStartAuthorizationV1 {
  readonly idempotencyKey: string;
}

export interface SourceAmendmentImpactV1 {
  readonly addsSectionIds: readonly string[];
  readonly retiresSectionIds: readonly string[];
  readonly addsRequirementIds: readonly string[];
  readonly retiresRequirementIds: readonly string[];
}

export interface PlanningReadinessSnapshot {
  readonly version: 1;
  readonly runId: string;
  readonly status: PlanningReadinessStatus;
  readonly planningPolicyVersion?: 1;
  readonly projectDocsPolicyVersion?: number;
  readonly triageDecision?: string;
  readonly runPolicy?: string;
  readonly planRevisionId?: string;
  readonly planDigest?: string;
  readonly sourceManifestId?: string;
  readonly sourceArtifactDigest?: string;
  readonly sourceSectionIds?: readonly string[];
  /** Sections at the current manifest no durable read covers. */
  readonly unreadSectionIds?: readonly string[];
  readonly explicitStartRequired: boolean;
  readonly explicitStartAuthorized: boolean;
  /** Owner-actionable blockers; source omissions appear here, never hidden. */
  readonly blockers: readonly string[];
}

export interface PlanningExportDocument {
  readonly version: 1;
  readonly references?: import("./planning-export-contracts.js").PlanningReferenceExport;
  readonly runId: string;
  readonly exportedAt: string;
  /** IDs are display text; use the live readiness endpoint for exact control identities. */
  readonly readiness: Omit<PlanningReadinessSnapshot, "sourceSectionIds" | "unreadSectionIds" | "blockers"> & {
    readonly sourceSectionIds: ExportList<string>;
    readonly unreadSectionIds: ExportList<string>;
    readonly blockers: ExportList<string>;
    readonly blocked: boolean;
  };
  readonly snapshot: { readonly text: string; readonly digestValid: boolean; readonly byteLength: number };
  readonly sourceManifests: ExportList<{
    readonly manifestId: string;
    readonly artifactDigest: string;
    readonly current: boolean;
    readonly sections: ExportList<{ readonly id: string; readonly digest: string }>;
  }>;
  readonly requirements: ExportList<{ readonly id: string; readonly status: string }>;
  readonly phases: ExportList<{ readonly id: string }>;
  readonly tasks: ExportList<{ readonly id: string; readonly status: string }>;
}

export type PlanningReadinessStatus =
  | "not_opted_in"
  | "source_missing"
  | "not_ready"
  | "ready_start_required"
  | "ready_authorized"
  | "ready"
  | "planning_not_applicable"
  | "triage_pending"
  | "clarification_required";

type ExportList<T> = { readonly items: readonly T[]; readonly omittedCount: number };
