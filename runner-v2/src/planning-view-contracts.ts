/** Browser-safe read-only subsets of the canonical scheduler HTTP projection.
 * These describe recorded facts, never compute or persist server authority. */
export interface NativeSourceSection { readonly id: string; readonly title?: string; readonly startByte: number; readonly endByte: number; readonly digest: string }
export interface NativeSourceManifest {
  readonly manifestId: string; readonly sourceId: string; readonly artifactDigest: string; readonly authority: string; readonly createdAt: string;
  readonly sections: readonly NativeSourceSection[];
  readonly amendment?: { readonly id: string; readonly rationale: string; readonly priorManifestId: string; readonly priorArtifactDigest: string; readonly authorizedBy: string; readonly recordedImpact?: { readonly addsSectionIds: readonly string[]; readonly retiresSectionIds: readonly string[]; readonly addsRequirementIds: readonly string[]; readonly retiresRequirementIds: readonly string[] } };
}
export interface NativeSourceRequirement {
  readonly id: string; readonly purpose: string; readonly observableOutcome: string;
  readonly reference: { readonly sourceId: string; readonly sectionIds: readonly string[] };
  readonly obligationKind: string;
  readonly acceptanceConditions: readonly { readonly id: string; readonly description: string; readonly responsibleGateId: string; readonly requiredEvidenceKinds: readonly string[] }[];
  readonly applicability: { readonly status: "applicable" | "conditional_pending" | "not_applicable"; readonly conditionExpression?: string; readonly disposition?: { readonly rationale: string; readonly authorizedBy: string; readonly decidedAt: string; readonly amendmentRef?: string; readonly evidenceRef?: string } };
  readonly accountablePhaseId: string; readonly contributingTaskIds: readonly string[];
}
export interface NativePlanPhase {
  readonly id: string; readonly purpose: string; readonly requirementIds: readonly string[]; readonly exitCriteria: readonly string[];
}
export interface NativePlanTask {
  readonly id: string; readonly outcome: { readonly user: string }; readonly dependencies: readonly string[];
  readonly writableSurfaces: readonly string[]; readonly forbiddenSurfaces: readonly string[];
  readonly acceptance: { readonly definitionOfDone: string };
  readonly cleanup: { readonly cleanup: string; readonly recovery: string; readonly rollback: string };
}
export interface NativePlanRevision {
  readonly revisionId: string; readonly digest: string; readonly requirements: readonly NativeSourceRequirement[];
  readonly phases: readonly NativePlanPhase[]; readonly tasks: readonly NativePlanTask[];
}
export interface NativePlanningProjection {
  readonly readiness: "ready" | "not_ready";
  readonly source: { readonly currentManifestId: string; readonly manifestsById: Readonly<Record<string, NativeSourceManifest>> };
  readonly ledger?: { readonly requirements: readonly NativeSourceRequirement[]; readonly phases: readonly NativePlanPhase[] };
  readonly plan?: { readonly currentRevisionId: string; readonly currentDigest: string; readonly revisionsById: Readonly<Record<string, NativePlanRevision>> };
  readonly coverageReview?: { readonly id: string; readonly independence: "distinct_model" | "fresh_context"; readonly reviewerRuntimeId: string; readonly planRevisionId: string };
  readonly coverageReviewHistory: readonly NonNullable<NativePlanningProjection["coverageReview"]>[];
}
export interface NativeDeliveryReview {
  readonly reviewId: string; readonly independence?: "distinct_model" | "fresh_context"; readonly satisfied?: boolean; readonly risk?: { readonly tier: string };
  readonly depth?: { readonly affectedTests?: { readonly selectionRung: string; readonly executedScope: string; readonly evidenceIds: readonly string[] }; readonly probe?: { readonly rung: string; readonly partial: boolean; readonly mutantsGenerated: number; readonly mutantsExecuted: number; readonly mutantsCaught: number; readonly survivors: readonly string[]; readonly evidenceIds: readonly string[]; readonly notes: readonly string[] } };
}
export interface NativeDeliveryProjection {
  readonly phaseAcceptances: Readonly<Record<string, { readonly planRevisionId: string; readonly requirementIds: readonly string[]; readonly integrationRevision: string; readonly acceptedAt: string; readonly taskAcceptanceRefs: readonly string[]; readonly exitChecks: readonly { readonly checkId: string; readonly validation: string; readonly boundaryId: string }[] }>>;
  readonly reviews: Readonly<Record<string, NativeDeliveryReview>>;
  readonly reviewHistory: Readonly<Record<string, readonly NativeDeliveryReview[]>>;
  readonly boundaries: Readonly<Record<string, readonly { readonly boundaryId: string; readonly attempt: number; readonly passed: boolean; readonly selection: { readonly rung: string }; readonly executedScope: string; readonly checks: readonly { readonly evidenceIds: readonly string[] }[] }[]>>;
}
export interface NativeRequestAnswer { readonly answerText: string; readonly addressedParts: readonly string[]; readonly sequence: number }
export interface NativeAnswerReview { readonly id: string; readonly independence: "distinct_model" | "fresh_context"; readonly answerAccurate: boolean; readonly summary: string; readonly answerSequence: number }

/** Advisory observation of existing scheduler admission, never dispatch authority. */
export interface NativePlanningSchedule {
  version: 1; runId: string; lastSequence: number;
  planRevisionId?: string; planDigest?: string; sourceManifestId?: string; sourceArtifactDigest?: string;
  blockers: string[]; configuredMax: number; effectiveMax: number; capacityInUse: number; resourceCapacity?: number;
  tasks: { taskId: string; status: string; eligible: boolean; active: boolean; reasons: string[]; dependencies: string[]; contractId?: string }[];
  activeClaims: { id: string; packetId: string; workerOrSessionId: string; ownershipGeneration: number; state: string; branchOrWorktree: string; writableSurfaces: readonly string[]; forbiddenSurfaces: readonly string[] }[];
  conflicts: { taskId: string; otherTaskId: string; detail: string }[];
}
