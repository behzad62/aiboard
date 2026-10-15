import type { ExplicitStartRequestV1, NativeBuildProjection, NativeBuildUsageProjection, NativeContextManifest, PlanningReadinessSnapshot } from "./runner-v2";
import type { NativePlanningSchedule } from "../../runner-v2/src/planning-view-contracts";

export function currentPlanningSchedule(projection: NativeBuildProjection, schedule?: NativePlanningSchedule | null): NativePlanningSchedule | undefined {
  const plan = projection.planning?.plan;
  const manifest = projection.planning?.source.manifestsById[projection.planning.source.currentManifestId];
  return schedule?.runId === projection.runId && schedule.lastSequence === projection.lastSequence && schedule.planRevisionId === plan?.currentRevisionId && schedule.planDigest === plan?.currentDigest && schedule.sourceManifestId === manifest?.manifestId && schedule.sourceArtifactDigest === manifest?.artifactDigest ? schedule : undefined;
}

/** Freeze the exact approval shown on screen. Never obtain authority at click time. */
export function displayedPlanStart(readiness: PlanningReadinessSnapshot, idempotencyKey: string): ExplicitStartRequestV1 {
  if (readiness.status !== "ready_start_required" || !readiness.explicitStartRequired || readiness.explicitStartAuthorized || readiness.runPolicy === "plan_only" || readiness.triageDecision !== "build" || (readiness.unreadSectionIds?.length ?? 0) > 0) throw new Error("The displayed plan is not ready for an owner start.");
  if (!readiness.planRevisionId || !readiness.planDigest || !readiness.sourceManifestId || !readiness.sourceArtifactDigest || readiness.planningPolicyVersion !== 1 || readiness.projectDocsPolicyVersion === undefined) throw new Error("The displayed plan identity is incomplete.");
  return Object.freeze({ version: 1, planRevisionId: readiness.planRevisionId, planDigest: readiness.planDigest, sourceManifestId: readiness.sourceManifestId, sourceArtifactDigest: readiness.sourceArtifactDigest, planningPolicyVersion: 1, projectDocsPolicyVersion: readiness.projectDocsPolicyVersion, ownerChoice: "execute", idempotencyKey });
}

export function nativePlanningView(projection: NativeBuildProjection) {
  const planning = projection.planning;
  const revision = planning?.plan?.revisionsById[planning.plan.currentRevisionId];
  const requirements = revision?.requirements ?? planning?.ledger?.requirements ?? [];
  const phases = revision?.phases ?? planning?.ledger?.phases ?? [];
  const phaseRows = phases.map((phase) => {
    const acceptance = revision && projection.delivery?.phaseAcceptances[`${revision.revisionId}:${phase.id}`];
    return { phase, acceptance, verified: Boolean(acceptance && acceptance.planRevisionId === revision?.revisionId) };
  });
  const accepted = requirements.filter((requirement) => requirement.applicability.status === "applicable" && phaseRows.some((row) => row.phase.id === requirement.accountablePhaseId && row.verified && row.acceptance?.requirementIds.includes(requirement.id)));
  const unresolved = requirements.filter((requirement) => requirement.applicability.status === "conditional_pending");
  const applicable = requirements.filter((requirement) => requirement.applicability.status === "applicable");
  const answered = projection.planningTriageDecision === "answer" && projection.requestAnswer !== undefined;
  const complete = projection.status === "completed" && projection.planningTriageDecision === "build" && Boolean(revision) && phaseRows.length > 0 && phaseRows.every((row) => row.verified) && unresolved.length === 0 && accepted.length === applicable.length;
  return { planning, revision, requirements, phaseRows, accepted, unresolved, applicable, answered, complete,
    label: answered ? "Answered request" : complete ? "Delivery complete" : planning?.readiness === "ready" ? "Plan ready — delivery incomplete" : "Planning in progress",
    manifest: planning?.source.manifestsById[planning.source.currentManifestId],
    previousSnapshotEdited: projection.projectDocs?.snapshots?.at(-1)?.previousSnapshotEdited === true,
  };
}

/** A session can contain several calls. Attribute settled usage only when
 * its manifest identifies one purpose, never split totals by guessing. */
export function planningPassRows(manifests: readonly NativeContextManifest[], usage?: NativeBuildUsageProjection | null) {
  return manifests.map((manifest) => {
    const peers = manifests.filter((other) => other.sessionId === manifest.sessionId);
    const calls = Object.values(usage?.reservations ?? {}).filter((reservation) => reservation.kind === "model" && reservation.attribution?.sessionId === manifest.sessionId && reservation.status === "settled");
    const attributed = peers.length === 1 && calls.length > 0 && calls.every((call) => Number.isSafeInteger(call.actual?.inputTokens) && Number.isSafeInteger(call.actual?.outputTokens) && call.actual!.inputTokens! >= 0 && call.actual!.outputTokens! >= 0);
    return { manifest, attributed,
      inputTokens: attributed ? calls.reduce((sum, call) => sum + (call.actual?.inputTokens ?? 0), 0) : undefined,
      outputTokens: attributed ? calls.reduce((sum, call) => sum + (call.actual?.outputTokens ?? 0), 0) : undefined,
      costMicros: attributed && calls.every((call) => call.costBasis?.kind === "api_estimate" && Number.isSafeInteger(call.actual?.estimatedCostMicros) && call.actual!.estimatedCostMicros! >= 0) ? calls.reduce((sum, call) => sum + (call.actual?.estimatedCostMicros ?? 0), 0) : undefined,
      tokenQuality: attributed && calls.every((call) => call.tokenSources?.inputTokens === "reported" && call.tokenSources?.outputTokens === "reported") ? "reported" : "estimated or mixed",
    };
  });
}
