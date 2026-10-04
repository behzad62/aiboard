import type { SchedulerProjection, FinalVerificationGenerationProjection } from "./scheduler-store.js";
import type { PlanningReferenceExport } from "./planning-export-contracts.js";
import { isSensitiveKey, redactSensitiveText } from "./sensitive-redaction.js";
import { neutralizeSnapshotText } from "./handoff-snapshot.js";

const LIST_LIMIT = 20;
const TEXT_LIMIT = 3500;
const REFERENCE_BYTES = 80 * 1024;
/** Sanitize every rendered leaf, including dictionary keys, before copying. */
function safe(value: unknown): unknown {
  if (typeof value === "string") return neutralizeSnapshotText(redactSensitiveText(value), Number.MAX_SAFE_INTEGER).replace(/\s+/g, " ");
  if (Array.isArray(value)) return value.map(safe);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, leaf]) => [String(safe(key)), isSensitiveKey(key) ? "[REDACTED]" : safe(leaf)]));
  return value;
}
function display(value: string): string { const text = String(safe(value)); return text.length > 180 ? `${text.slice(0, 180)} [truncated display reference; inspect the canonical run]` : text; }
function record(id: string, value: unknown, reference: PlanningReferenceExport["cards"][number]["reference"]) {
  const text = JSON.stringify(safe(value), null, 2);
  const truncated = text.length > TEXT_LIMIT;
  return { id: display(id), reference, text: truncated ? `${text.slice(0, TEXT_LIMIT)}\n[truncated — inspect the authenticated GET reference and JSON Pointer]` : text, truncated };
}

/** Whitelist mechanical identities/results; profiles, facts and diagnostics stay in runner state. */
function finalReference(generation: FinalVerificationGenerationProjection) {
  return {
    taskId: generation.taskId, generationId: generation.generationId, targetRevision: generation.targetRevision,
    planVersion: generation.planVersion, state: generation.state,
    invalidatedByRevision: generation.invalidatedByRevision, invalidatedByGuidanceId: generation.invalidatedByGuidanceId,
    plan: generation.plan, failure: generation.failure, submission: generation.submission, review: generation.review,
    repairTaskIds: generation.repairTaskIds,
    completedChecks: generation.completedChecks?.map((check) => ({
      category: check.category, status: check.status, green: check.green, attempt: check.attempt,
      evidenceIds: check.evidenceIds, startedAt: check.startedAt, finishedAt: check.finishedAt,
      factCount: check.facts.length, issueCount: check.issues.length,
    })),
    completedCheckCount: generation.completedChecks?.length ?? 0,
    cleanup: generation.cleanup && { status: generation.cleanup.status, attempt: generation.cleanup.attempt,
      startedAt: generation.cleanup.startedAt, finishedAt: generation.cleanup.finishedAt },
  };
}

/** Only explicit contract/authority records; no source bodies, model transcripts or environment. */
export function buildPlanningReferenceExport(projection: SchedulerProjection, maxBytes = REFERENCE_BYTES): PlanningReferenceExport {
  const planning = projection.planning;
  const revision = planning?.plan?.revisionsById[planning.plan.currentRevisionId];
  const requirements = revision?.requirements ?? planning?.ledger?.requirements ?? [];
  const tasks = revision?.tasks ?? [];
  const phases = revision?.phases ?? planning?.ledger?.phases ?? [];
  const manifest = planning?.source.manifestsById[planning.source.currentManifestId];
  const categories: PlanningReferenceExport["categories"] = [];
  const pointer = (value: string) => value.replace(/~/g, "~0").replace(/\//g, "~1");
  const reference = (selector: string) => {
    // References are literal keys, not rendered prose. Never normalize their whitespace or markup.
    const redactedRun = redactSensitiveText(projection.runId);
    const redactedSelector = redactSensitiveText(selector);
    return redactedRun !== projection.runId || redactedSelector !== selector || selector.length > 2048
      ? { method: "GET" as const, path: "", selector: "", unavailableReason: "Exact reference withheld because it contains sensitive or oversized identity text. Inspect the current run through the authenticated runner UI." }
      : { method: "GET" as const, path: `/v2/runs/${encodeURIComponent(projection.runId)}/build`, selector };
  };
  const revisionPointer = `/planning/plan/revisionsById/${pointer(revision?.revisionId ?? "")}`;
  const category = (id: string, title: string, entries: { id: string; value: unknown; selector?: string }[], selector = "") => {
    categories.push({ id, title, reference: reference(selector), recordCount: entries.length, omittedCount: Math.max(0, entries.length - LIST_LIMIT), items: entries.slice(0, LIST_LIMIT).map((entry) => record(entry.id, entry.value, reference(entry.selector ?? selector))) });
  };
  category("state", "Durable state, resume and next actions", [{ id: "state-index", value: { runId: projection.runId, lastSequence: projection.lastSequence, status: projection.status, planningPolicyVersion: projection.planningPolicyVersion, projectDocsPolicyVersion: projection.projectDocsPolicyVersion, sourceManifestId: manifest?.manifestId, sourceArtifactDigest: manifest?.artifactDigest, planRevisionId: revision?.revisionId, planDigest: revision?.digest, resume: planning?.resume, pauseReason: projection.pauseReason, finalVerificationGeneration: projection.finalVerification?.current?.generationId, stateReference: "The companion C1 snapshot is the STATE view; durable run events determine authority." } }]);
  category("traceability", "Source, requirement, task and evidence traceability", requirements.map((requirement, index) => ({ id: requirement.id, selector: revision ? `${revisionPointer}/requirements/${index}` : `/planning/ledger/requirements/${index}`, value: { ...requirement, taskAcceptanceRefs: requirement.contributingTaskIds.map((taskId) => projection.delivery?.taskAcceptances[taskId]).filter(Boolean) } })), revision ? `${revisionPointer}/requirements` : "/planning/ledger/requirements");
  const sources = Object.values(planning?.source.manifestsById ?? {}).sort((a, b) => Number(b.manifestId === manifest?.manifestId) - Number(a.manifestId === manifest?.manifestId));
  category("source", "Source revisions and durable reads", sources.map((source) => ({ id: source.manifestId, selector: `/planning/source/manifestsById/${pointer(source.manifestId)}`, value: { ...source, readsReference: reference(`/planning/sourceReadIndex/${pointer(source.manifestId)}`), reads: planning?.sourceReadIndex[source.manifestId] } })), "/planning/source/manifestsById");
  category("phases", "Phases and accountable phase ownership", phases.map((phase, index) => ({ id: phase.id, selector: revision ? `${revisionPointer}/phases/${index}` : `/planning/ledger/phases/${index}`, value: { ...phase, acceptance: revision && projection.delivery?.phaseAcceptances[`${revision.revisionId}:${phase.id}`] } })), revision ? `${revisionPointer}/phases` : "/planning/ledger/phases");
  category("contracts", "Task contracts, dependency graph and serialized surfaces", tasks.map((task, index) => ({ id: task.id, selector: `${revisionPointer}/tasks/${index}`, value: { ...task, schedulerStatus: projection.tasks[task.id]?.status, claimReferences: Object.values(planning?.assignments ?? {}).filter((entry) => entry.claim.packetId === task.id).map((entry) => ({ id: entry.claim.id, status: entry.status, owner: entry.claim.workerOrSessionId, generation: entry.claim.ownershipGeneration, reference: reference(`/planning/assignments/${pointer(entry.claim.id)}`) })) } })), `${revisionPointer}/tasks`);
  category("ownership", "Recorded claims and ownership", Object.entries(planning?.assignments ?? {}).map(([key, entry]) => ({ id: entry.claim.id, selector: `/planning/assignments/${pointer(key)}`, value: entry })), "/planning/assignments");
  category("evidence", "Evidence references and report template", [
    { id: "report-template", value: { fields: ["run/source/plan/task identity", "accepted base and integration revision", "claim owner/generation", "criterion and requirement references", "commands and recorded test counts", "artifact/evidence IDs", "independent review and dispositions", "cleanup/recovery and exact blocked handoff"], standingOrder: "Reference durable artifacts; do not duplicate transcripts or credentials." } },
    ...Object.values(projection.tasks).map((task) => ({ id: task.id, selector: `/tasks/${pointer(task.id)}`, value: { criterionEvidenceLinks: task.criterionEvidenceLinks, reviewReference: reference(`/reviews/${pointer(task.id)}`), boundariesReference: reference(`/delivery/boundaries/${pointer(task.id)}`), review: projection.reviews[task.id], boundaries: projection.delivery?.boundaries[task.id] } })),
  ], "/tasks");
  category("reviews", "Review findings, dispositions and independence", [
    ...(planning?.coverageReview ? [{ id: planning.coverageReview.id, selector: "/planning/coverageReview", value: { current: true, ...planning.coverageReview } }] : []),
    ...Object.entries(projection.delivery?.reviews ?? {}).map(([key, review]) => ({ id: review.reviewId, selector: `/delivery/reviews/${pointer(key)}`, value: { current: true, ...review } })),
    ...Object.entries(projection.answerReviews ?? {}).map(([key, review]) => ({ id: key, selector: `/answerReviews/${pointer(key)}`, value: review })),
    ...Object.entries(projection.answerReviewFindings ?? {}).map(([key, findings]) => ({ id: `findings:${key}`, selector: `/answerReviewFindings/${pointer(key)}`, value: findings })),
    ...Object.entries(projection.answerReviewReleases ?? {}).map(([key, release]) => ({ id: `release:${key}`, selector: `/answerReviewReleases/${pointer(key)}`, value: release })),
    ...(projection.verifier?.current ? [{ id: `verifier:${projection.verifier.current.reviewId}`, selector: "/verifier/current", value: projection.verifier.current }] : []),
    ...(planning?.coverageReviewHistory ?? []).map((review, index) => ({ id: review.id, selector: `/planning/coverageReviewHistory/${index}`, value: { current: false, ...review } })),
    ...Object.entries(projection.delivery?.reviewHistory ?? {}).flatMap(([key, reviews]) => reviews.map((review, index) => ({ id: review.reviewId, selector: `/delivery/reviewHistory/${pointer(key)}/${index}`, value: { current: false, ...review } }))),
    ...(projection.verifier?.history ?? []).map((review, index) => ({ id: `verifier-history:${review.reviewId}`, selector: `/verifier/history/${index}`, value: review })),
  ]);
  const policyFields = ["verifierPolicy", "verifierSelection", "buildRisk", "repairCycles", "planCritique", "handoffFiles", "specCopy", "integrationRevision", "answerReviewOptIn", "answerReviewUnavailable"] as const;
  category("policies", "Validation, reuse, review, integration, repair and final verification", [
    { id: "workflow", selector: revisionPointer, value: { workflowPolicyVersion: revision?.workflowPolicyVersion, interpretation: "Only recorded checks and exact applicable evidence count. Cards neither grant assignment nor accept work; current kernel gates decide admission and acceptance." } },
    ...(projection.finalVerification?.current ? [{ id: "final-current", selector: "/finalVerification/current", value: finalReference(projection.finalVerification.current) }] : []),
    ...policyFields.flatMap((key) => projection[key] === undefined ? [] : [{ id: key, selector: `/${key}`, value: projection[key] }]),
    ...(revision?.validationObligations ?? []).map((value, index) => ({ id: `validation:${index}`, selector: `${revisionPointer}/validationObligations/${index}`, value })),
    ...Object.entries(planning?.validations ?? {}).map(([key, value]) => ({ id: `validation:${key}`, selector: `/planning/validations/${pointer(key)}`, value })),
    ...Object.entries(planning?.references ?? {}).map(([key, value]) => ({ id: `evidence-reference:${key}`, selector: `/planning/references/${pointer(key)}`, value })),
    ...Object.entries(projection.repairIssues ?? {}).map(([key, value]) => ({ id: key, selector: `/repairIssues/${pointer(key)}`, value })),
    ...(projection.finalVerification?.history ?? []).map((value, index) => ({ id: `final-history:${value.generationId}`, selector: `/finalVerification/history/${index}`, value: finalReference(value) })),
  ]);
  category("decisions", "Recorded planning decisions", (revision?.planningDecisions ?? []).map((decision, index) => ({ id: decision.id, selector: `${revisionPointer}/planningDecisions/${index}`, value: decision })), `${revisionPointer}/planningDecisions`);
  const identity = `AIBoard run ${display(projection.runId)}; source ${display(manifest?.manifestId ?? "not recorded")} / ${manifest?.artifactDigest ?? "not recorded"}; plan ${display(revision?.revisionId ?? "not recorded")} / ${revision?.digest ?? "not recorded"}; event sequence ${projection.lastSequence}.`;
  const cards: PlanningReferenceExport["cards"] = [{ id: "controller", kind: "controller", reference: reference(""), text: `${identity}\nController / integrator: inspect the companion C1 STATE snapshot, current claims, contract dependencies, source resume index, reviews and evidence references before acting. Assign only with verified base, exclusive current ownership and available resources; respect serialized surfaces. Integrate in dependency order and accept only after the complete current gate conjunction. Never launch from plan readiness or from this card. Persist exact blockers, owner action and next eligible work in the durable handoff.` }];
  for (const [index, task] of tasks.slice(0, LIST_LIMIT).entries()) {
    const claims = Object.entries(planning?.assignments ?? {}).filter(([, entry]) => entry.claim.packetId === task.id).sort(([, a], [, b]) => Number(b.status === "claimed") - Number(a.status === "claimed"));
    const current = claims.filter(([, entry]) => entry.status === "claimed");
    const status = projection.tasks[task.id]?.status ?? "not allocated";
    const accepted = projection.delivery?.taskAcceptances[task.id];
    const nextAction = accepted ? "Task acceptance is recorded. Inspect acceptance and dependent contracts; do not resume this accepted task."
      : ["submitted", "architect_review", "approved", "integrating", "integrated"].includes(status) ? "Inspect the recorded submission, independent review and integration/acceptance gates; do not self-accept."
      : ["waiting_guidance", "integration_resolution", "rejected", "failed", "cancelled"].includes(status) ? "Inspect this task's durable blocker/failure and obtain the Architect's recorded resolution before resuming."
      : current.length !== 1 ? "Obtain one verified current exclusive claim and resolve ownership/recovery gates before execution."
      : !planning?.executionAuthorization ? "Wait for the owner's explicit start of this exact ready plan."
      : "Inspect the recorded task status, dependency readiness, ownership/recovery and resource admission gates; continue only if all current gates admit this assigned task.";
    const claimText = claims.length ? claims.slice(0, LIST_LIMIT).map(([key, entry]) => `${entry.status === "claimed" ? "Claimed; verify recovery before use" : "Historical/non-executable"}: claim ${display(entry.claim.id)}; lane ${display(entry.claim.laneId)}; worktree ${display(entry.claim.branchOrWorktree)}; base ${display(entry.claim.acceptedBaseRevision)}; owner ${display(entry.claim.workerOrSessionId)}; generation ${entry.claim.ownershipGeneration}; status ${entry.status}; recovery ${entry.recoveryStatus}; GET ${reference("").path} ${reference(`/planning/assignments/${pointer(key)}`).selector}`).join("\n") + (claims.length > LIST_LIMIT ? `\n${claims.length - LIST_LIMIT} additional claims omitted; inspect /planning/assignments.` : "") : "No assignment claim recorded; obtain a current exclusive claim before execution. No execution lane is assigned.";
    const contract = reference(`${revisionPointer}/tasks/${index}`);
    cards.push({ id: display(task.id), kind: "worker", reference: contract, text: `${identity}\nWorker reference; accountable phase ${display(task.accountablePhaseId)}; task ${display(task.id)}; recorded scheduler status ${display(status)}.\nContract reference: authenticated GET ${contract.path}, JSON Pointer ${contract.selector}.\nRequired base: ${display(task.requiredBase)}.\n${claimText}\nScope, dependencies, validation, report and cleanup: inspect this exact contract and /tasks/${display(pointer(task.id))}, /reviews/${display(pointer(task.id))}, /delivery/boundaries/${display(pointer(task.id))}.\nNext action: ${nextAction}\nStanding orders: continue only eligible assigned packets; submit evidence for independent review and integration; never self-accept. When blocked or ending, persist a precise handoff with actual state, evidence, unresolved blocker and next action. This reference card grants no start or assignment authority.` });
  }
  if (planning?.readiness !== "ready" && projection.planningPolicyVersion === 1) cards.push({ id: "resume-planning", kind: "resume_planning", reference: reference("/planning/resume"), text: `${identity}\nResume planning: read the current source manifest, sourceReadIndex, derived planning.resume index and review findings. Reconcile original artifact/section hashes and current plan bindings. Next planning action: ${display(planning?.resume.nextAction ?? "Triage the request; approve a source only for a build request.")}\nPlanning inspection and contract corrections only. No implementation code, implementation tests, workloads, migrations or execution workers. Complete outstanding sections and scoped review corrections through durable planning records. No execution base or worker claim is granted by this card.` });
  for (const card of cards) card.text += card.reference.unavailableReason
    ? `\nReference unavailable: ${card.reference.unavailableReason}`
    : `\nAuthenticated GET ${card.reference.path}; JSON Pointer ${card.reference.selector || "(whole projection)"}.`;
  const result: PlanningReferenceExport = { version: 1, categories, cards, omittedCardCount: Math.max(0, tasks.length - LIST_LIMIT), nativeLaunch: { status: "not_applicable", rationale: "This Runner control plane exposes no non-executing native launch-chip preparation API. Use copy-ready references; no task is created or dispatched by export." } };
  // Remove complete low-priority records, retaining exact counts and visible omissions.
  while (Buffer.byteLength(JSON.stringify(result), "utf8") > Math.min(maxBytes, REFERENCE_BYTES)) {
    const largest = [...categories].filter((entry) => entry.items.length > 0 && entry.id !== "state" && !(entry.id === "source" && entry.items.length === 1)).sort((a, b) => JSON.stringify(b.items).length - JSON.stringify(a.items).length)[0];
    if (largest) { largest.items.pop(); largest.omittedCount++; continue; }
    const workerIndex = cards.findLastIndex((card) => card.kind === "worker");
    if (workerIndex >= 0) { cards.splice(workerIndex, 1); result.omittedCardCount++; continue; }
    throw new Error("Planning reference export exceeds its bounded document limit.");
  }
  return result;
}
