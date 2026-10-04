"use client";

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { currentPlanningSchedule, displayedPlanStart, nativePlanningView, planningPassRows } from "@/lib/client/native-planning-view";
import type { NativePlanningSchedule } from "@/runner-v2/src/planning-view-contracts";
import { amendNativePlanningSource, exportNativePlanning, getNativeContextManifests, getNativePlanningReadiness, getNativePlanningSchedule, registerNativePlanningSource, setNativeAnswerReview, startNativeReadyPlan, type ApprovedSourceInputV1, type ExplicitStartRequestV1, type NativeBuildProjection, type NativeBuildUsageProjection, type NativeContextManifest, type NativeRunnerConnection, type PlanningReadinessSnapshot } from "@/lib/client/runner-v2";

export function PlanningRecordView({ projection, manifests = [], usage, readiness, schedule }: { projection: NativeBuildProjection; manifests?: NativeContextManifest[]; usage?: NativeBuildUsageProjection | null; readiness?: PlanningReadinessSnapshot; schedule?: NativePlanningSchedule | null }) {
  const view = nativePlanningView(projection);
  const currentSchedule = currentPlanningSchedule(projection, schedule);
  if (projection.planningPolicyVersion !== 1) return <p className="text-xs text-muted-foreground">This run uses its saved legacy policy. Planning coverage was not recorded.</p>;
  const review = view.planning?.coverageReview;
  const coverageReviews = [...(view.planning?.coverageReviewHistory ?? []), ...(review ? [review] : [])];
  const deliveryReviews = [...Object.values(projection.delivery?.reviewHistory ?? {}).flat().map((review) => ({ review, historical: true })), ...Object.values(projection.delivery?.reviews ?? {}).map((review) => ({ review, historical: false }))];
  return <div className="space-y-3">
    <h3 className="font-semibold">{view.label}</h3>
    <p className="text-xs">Recorded policy: evidence-gated planning opted in. Handoff files: {projection.handoffFiles ?? "commit"}; specification copy: {projection.handoffFiles === "export_only" ? "disabled by export-only handoff" : projection.specCopy === false ? "off" : "on"}.</p>
    {view.answered && <><p className="whitespace-pre-wrap">{projection.requestAnswer!.answerText}</p><p className="text-sm">Addressed question parts: {projection.requestAnswer!.addressedParts.join("; ")}</p><p className="text-xs">Answer review: {projection.answerReviewOptIn ? "opted in" : "not requested"}.</p></>}
    {Object.values(projection.answerReviews ?? {}).map((answerReview) => <p key={answerReview.id} className="text-xs">{answerReview.answerSequence === projection.requestAnswer?.sequence ? "Current answer review" : "Historical answer review"} {answerReview.id} (answer sequence {answerReview.answerSequence}): {answerReview.independence}; {answerReview.answerAccurate ? "accurate" : "concerns recorded"}. {answerReview.summary}</p>)}
    {projection.answerReviewUnavailable && <p className="text-sm">Answer reviewer unavailable: {projection.answerReviewUnavailable.reason}. You may withdraw the optional review to continue without it.</p>}
    {!view.answered && <>
      <details><summary>Worker eligibility and active claims</summary>{currentSchedule ? <div className="space-y-2 text-xs"><p>Worker capacity: {currentSchedule.capacityInUse} in use / {currentSchedule.effectiveMax} effective maximum; configured {currentSchedule.configuredMax}; resource capacity {currentSchedule.resourceCapacity ?? "unknown"}.</p>{currentSchedule.blockers.map((reason) => <p key={reason}>{reason}</p>)}{currentSchedule.tasks.map((task) => <p key={task.taskId}>{task.taskId}: {task.active ? "worker active" : task.eligible ? "next eligible worker candidate" : "worker admission blocked"}. Dependencies: {task.dependencies.join(", ") || "none"}. {task.reasons.join("; ")}</p>)}{currentSchedule.activeClaims.map((claim) => <p key={claim.id}>Active claim {claim.id}: packet {claim.packetId}, owner {claim.workerOrSessionId}, generation {claim.ownershipGeneration}; worktree {claim.branchOrWorktree}; writes {claim.writableSurfaces.join(", ")}; exclusions {claim.forbiddenSurfaces.join(", ") || "none"}.</p>)}{currentSchedule.conflicts.map((conflict) => <p key={`${conflict.taskId}:${conflict.otherTaskId}`}>Parallel conflict {conflict.taskId} / {conflict.otherTaskId}: {conflict.detail}</p>)}<p>Worker candidates are advisory, subject to available slots, worktree allocation, source verification and final admission checks. Higher-priority runtime actions may run first.</p></div> : <p className="text-xs">Current worker eligibility is unavailable; refresh to read the scheduler. Historical runs have no live dispatch eligibility.</p>}</details>
      <p className="text-sm">Requirements: {view.accepted.length} accepted / {view.applicable.length} applicable; {view.unresolved.length} unresolved conditional; {view.requirements.length} total.</p>
      {readiness?.blockers.map((blocker) => <p key={blocker} className="text-sm text-amber-700 dark:text-amber-300">{blocker}</p>)}
      {readiness?.unreadSectionIds?.length ? <p className="text-sm">Unread current source sections: {readiness.unreadSectionIds.join(", ")}. Readiness requires their durable reads.</p> : null}
      {view.manifest && <details><summary>Approved source and provenance</summary>{Object.values(view.planning!.source.manifestsById).map((manifest) => <div key={manifest.manifestId} className="my-2 text-xs break-all"><p>{manifest.manifestId === view.manifest?.manifestId ? "Current source" : "Historical source"}: {manifest.manifestId} · source {manifest.sourceId} · {manifest.authority} · {manifest.createdAt}</p><p>Digest: {manifest.artifactDigest}</p>{manifest.amendment && <><p>Amendment {manifest.amendment.id}: {manifest.amendment.rationale}; authorized by {manifest.amendment.authorizedBy}; predecessor {manifest.amendment.priorManifestId}, digest {manifest.amendment.priorArtifactDigest}.</p><p>Recorded impact: {JSON.stringify(manifest.amendment.recordedImpact ?? "not recorded")}</p></>}<ul>{manifest.sections.map((section) => <li key={section.id}>{section.id}: {section.title ?? "Source section"}; bytes {section.startByte}–{section.endByte}; digest {section.digest}</li>)}</ul></div>)}</details>}
      <details><summary>Requirements and owning phases</summary><ul className="space-y-2 text-sm">{view.requirements.map((requirement) => <li key={requirement.id}><strong>{requirement.id}</strong>: {view.accepted.some((accepted) => accepted.id === requirement.id) ? "Requirement accepted" : requirement.applicability.status === "not_applicable" ? "Authorized not applicable" : "Requirement incomplete"} · {requirement.purpose} · {requirement.applicability.status} · owner {requirement.accountablePhaseId}.<br />Outcome: {requirement.observableOutcome}<br />Obligation: {requirement.obligationKind}; source: {requirement.reference.sourceId}.<br />Tasks: {requirement.contributingTaskIds.join(", ")}; source sections: {requirement.reference.sectionIds.join(", ")}.{requirement.applicability.conditionExpression && <p>Condition: {requirement.applicability.conditionExpression}</p>}{requirement.applicability.disposition && <p>Disposition: {requirement.applicability.disposition.rationale}; authorized by {requirement.applicability.disposition.authorizedBy} at {requirement.applicability.disposition.decidedAt}; amendment {requirement.applicability.disposition.amendmentRef ?? "none"}; evidence {requirement.applicability.disposition.evidenceRef ?? "none"}</p>}{requirement.acceptanceConditions.map((condition) => <p key={condition.id}>Acceptance {condition.id}: {condition.description}; gate {condition.responsibleGateId}; evidence kinds {condition.requiredEvidenceKinds.join(", ")}</p>)}</li>)}</ul></details>
      <details><summary>Phase exits and task dependencies</summary>{view.phaseRows.map(({ phase, verified, acceptance }) => <p key={phase.id} className="text-sm">{phase.id}: {verified ? "Phase verified" : "Phase incomplete"}. {phase.purpose} Exit: {phase.exitCriteria.join("; ")}. {acceptance && <>Accepted at {acceptance.acceptedAt}; integration {acceptance.integrationRevision}; task acceptance refs {acceptance.taskAcceptanceRefs.join(", ")}; exit checks {acceptance.exitChecks.map((check) => `${check.checkId} (${check.validation}, ${check.boundaryId})`).join("; ")}.</>}</p>)}{view.revision?.tasks.map((task) => <div key={task.id} className="my-2 text-xs"><strong>{task.id}</strong>: {task.outcome.user}<br />Dependencies: {task.dependencies.join(", ") || "none"}; current state: {projection.tasks[task.id]?.status ?? "not materialized"}.<br />Writes: {task.writableSurfaces.join(", ")}; exclusions: {task.forbiddenSurfaces.join(", ") || "none"}.<br />Acceptance: {task.acceptance.definitionOfDone}<br />Cleanup: {task.cleanup.cleanup}; recovery: {task.cleanup.recovery}; rollback: {task.cleanup.rollback}</div>)}<p className="text-xs">Parallel work also requires non-conflicting resource claims; dependency satisfaction alone does not authorize dispatch.</p></details>
      {coverageReviews.map((record) => <p key={record.id} className="text-xs">{record.id === review?.id && record.planRevisionId === view.revision?.revisionId ? "Current coverage review" : "Historical coverage review"} {record.id}: {record.independence}, reviewer {record.reviewerRuntimeId}; reviewed revision {record.planRevisionId}.</p>)}
      {[...(projection.planCritique?.history ?? []), ...(projection.planCritique?.current ? [projection.planCritique.current] : [])].map((critique) => <p key={critique.critiqueId} className="text-xs">{critique.critiqueId === projection.planCritique?.current?.critiqueId ? "Current plan critique" : "Historical plan critique"} {critique.critiqueId}: {critique.independence ?? "distinct_model (legacy recorded policy)"}; {critique.status}; revision {critique.planRevision}; blocking findings {critique.blockingFindingIds?.join(", ") || "none recorded"}.</p>)}
      {deliveryReviews.map(({ review: deliveryReview, historical }) => <div className="text-xs" key={deliveryReview.reviewId}><p>{historical ? "Historical delivery review" : "Current delivery review"} {deliveryReview.reviewId}: {deliveryReview.independence ?? "independence not recorded"}; tier {deliveryReview.risk?.tier ?? "not recorded"}; {deliveryReview.satisfied === true ? "satisfied" : "pending or findings"}. Selection rung: {deliveryReview.depth?.affectedTests?.selectionRung ?? "not recorded"}; executed scope {deliveryReview.depth?.affectedTests?.executedScope ?? "not recorded"}; evidence {deliveryReview.depth?.affectedTests?.evidenceIds.join(", ") || "none recorded"}.</p>{deliveryReview.depth?.probe && <p>Probe rung: {deliveryReview.depth.probe.rung}; {deliveryReview.depth.probe.partial ? "partial" : "complete"}; generated {deliveryReview.depth.probe.mutantsGenerated}, executed {deliveryReview.depth.probe.mutantsExecuted}, caught {deliveryReview.depth.probe.mutantsCaught}; survivors {deliveryReview.depth.probe.survivors.join(", ") || "none"}; evidence {deliveryReview.depth.probe.evidenceIds.join(", ") || "none"}. {deliveryReview.depth.probe.notes.join("; ")}</p>}</div>)}
      {Object.values(projection.delivery?.boundaries ?? {}).flat().map((boundary) => <p className="text-xs" key={`${boundary.boundaryId}:${boundary.attempt}`}>Boundary {boundary.boundaryId}: {boundary.passed ? "passed" : "incomplete"}; selection rung {boundary.selection.rung}; executed scope {boundary.executedScope}; evidence {boundary.checks.flatMap((check) => check.evidenceIds).join(", ") || "none recorded"}.</p>)}
    </>}
    {view.previousSnapshotEdited && <p className="rounded border p-2 text-sm">This snapshot was edited outside the runner. It can help explain prior work; the runner&apos;s saved records determine readiness and completion.</p>}
    {manifests.length > 0 && <details><summary>Model passes and token cost</summary><ul className="space-y-2 text-xs">{planningPassRows(manifests, usage).map(({ manifest, attributed, inputTokens, outputTokens, tokenQuality, costMicros }) => <li key={manifest.manifestId}><strong>{manifest.purpose}</strong> · {manifest.actor.id} · {manifest.recordedAt}<br />{attributed ? `${inputTokens} input + ${outputTokens} output tokens (${tokenQuality}); ${costMicros !== undefined ? `$${(costMicros / 1_000_000).toFixed(6)} estimated API cost` : "monetary cost unavailable"}` : "Per-pass usage attribution unavailable; see overall model usage."}<br />Context pack: {manifest.estimatedTokens} estimated tokens, {manifest.byteLength} bytes.{manifest.omissions.map((omission) => <p key={omission.id}>Omitted {omission.kind}: {omission.id} ({omission.reason}).</p>)}</li>)}</ul></details>}
  </div>;
}

const isTerminal = (projection: NativeBuildProjection) => ["completed", "failed", "stopped"].includes(projection.status);
const key = (kind: string) => `${kind}:${crypto.randomUUID()}`;

export function NativePlanningPanel({ projection, connection, usage, onProjection }: { projection: NativeBuildProjection | null; connection?: NativeRunnerConnection; usage?: NativeBuildUsageProjection | null; onProjection: (projection: NativeBuildProjection) => void }) {
  return <PlanningControls key={JSON.stringify([projection?.runId, connection?.url, connection?.token])} projection={projection} connection={connection} usage={usage} onProjection={onProjection} />;
}

function PlanningControls({ projection, connection, usage, onProjection }: { projection: NativeBuildProjection | null; connection?: NativeRunnerConnection; usage?: NativeBuildUsageProjection | null; onProjection: (projection: NativeBuildProjection) => void }) {
  const mounted = useRef(true);
  const latestProjection = useRef(projection);
  latestProjection.current = projection;
  const publish = (updated: NativeBuildProjection) => {
    if (mounted.current && updated.runId === latestProjection.current?.runId && updated.lastSequence >= latestProjection.current.lastSequence) onProjection(updated);
  };
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [readiness, setReadiness] = useState<PlanningReadinessSnapshot>();
  const [manifests, setManifests] = useState<NativeContextManifest[]>([]);
  const [schedule, setSchedule] = useState<NativePlanningSchedule | null>(null);
  const [start, setStart] = useState<ExplicitStartRequestV1>();
  const frozenStart = useRef<ExplicitStartRequestV1 | undefined>(undefined);
  const sourceRequest = useRef<{ fingerprint: string; key: string; amendmentId: string } | undefined>(undefined);
  const reviewRequest = useRef<{ optedIn: boolean; key: string } | undefined>(undefined);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [source, setSource] = useState<ApprovedSourceInputV1>(), [preview, setPreview] = useState("");
  const [approved, setApproved] = useState(false), [rationale, setRationale] = useState("");
  const approvedPredecessor = useRef<string | undefined>(undefined);
  const [layout, setLayout] = useState(""), [impact, setImpact] = useState('{"addsSectionIds":[],"retiresSectionIds":[],"addsRequirementIds":[],"retiresRequirementIds":[]}');
  const [exportText, setExportText] = useState(""), [refresh, setRefresh] = useState(0);
  const connectionUrl = connection?.url, connectionToken = connection?.token;
  useEffect(() => {
    setReadiness(undefined); setStart(undefined); setSchedule(null);
    if (!projection || !connectionUrl || !connectionToken || projection.planningPolicyVersion !== 1) return;
    const currentConnection = { url: connectionUrl, token: connectionToken };
    const abort = new AbortController();
    void Promise.all([getNativePlanningReadiness(currentConnection, projection.runId, fetch, abort.signal), getNativeContextManifests(currentConnection, projection.runId, fetch, abort.signal), getNativePlanningSchedule(currentConnection, projection.runId, fetch, abort.signal)]).then(([current, packs, observedSchedule]) => {
      if (abort.signal.aborted || !mounted.current) return;
      setReadiness(current); setManifests(packs); setSchedule(observedSchedule);
      try {
        const candidate = displayedPlanStart(current, key("owner-start"));
        const old = frozenStart.current;
        const same = old && Object.keys(candidate).filter((field) => field !== "idempotencyKey").every((field) => candidate[field as keyof ExplicitStartRequestV1] === old[field as keyof ExplicitStartRequestV1]);
        frozenStart.current = same ? old : candidate; setStart(frozenStart.current);
      } catch { frozenStart.current = undefined; }
    }).catch((error: unknown) => { if (!abort.signal.aborted) setMessage(error instanceof Error ? error.message : "Planning data could not be loaded."); });
    return () => abort.abort();
  }, [projection, connectionUrl, connectionToken, refresh]);
  if (!projection) return null;
  if (projection.planningPolicyVersion !== 1) return <PlanningRecordView projection={projection} />;
  const view = nativePlanningView(projection);
  const predecessor = JSON.stringify([view.manifest?.manifestId, view.manifest?.artifactDigest]);
  const exactSourceApproved = approved && approvedPredecessor.current === predecessor;
  const disabled = busy || !connection || isTerminal(projection);
  const currentStart = start && start.planRevisionId === view.planning?.plan?.currentRevisionId && start.planDigest === view.planning?.plan?.currentDigest && start.sourceManifestId === view.manifest?.manifestId && start.sourceArtifactDigest === view.manifest?.artifactDigest && start.projectDocsPolicyVersion === projection.projectDocsPolicyVersion;
  const act = async (operation: (current: () => boolean) => Promise<void>) => {
    setBusy(true); setMessage("");
    try { await operation(() => mounted.current); }
    catch (error) { if (mounted.current) { setStart(undefined); setApproved(false); frozenStart.current = undefined; setMessage(`${error instanceof Error ? error.message : "Control failed."} Refresh the displayed plan or source, then make a new choice.`); } }
    finally { if (mounted.current) setBusy(false); }
  };
  return <section className="space-y-3 rounded-lg border p-4" aria-label="Evidence-gated planning">
    <PlanningRecordView projection={projection} readiness={readiness} manifests={manifests} usage={usage} schedule={schedule} />
    {message && <p role="alert" className="text-sm">{message}</p>}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={busy || !connection} onClick={() => { setMessage(""); setRefresh((value) => value + 1); }}>Refresh plan details</Button>
      <Button size="sm" variant="outline" disabled={busy || !connection} onClick={() => void act(async (current) => { const document = await exportNativePlanning(connection!, projection.runId); if (current()) setExportText(document.snapshot.text); })}>Inspect export</Button>
      {projection.runPolicy !== "plan_only" && !view.answered && <Button size="sm" disabled={disabled || !currentStart} onClick={() => void act(async (current) => { const displayed = start!; const updated = await startNativeReadyPlan(connection!, projection.runId, displayed); if (!current()) return; setStart(undefined); publish(updated); setRefresh((value) => value + 1); })}>Start current plan</Button>}
      {!isTerminal(projection) && <Button size="sm" variant="outline" disabled={disabled} onClick={() => void act(async (current) => {
        const optedIn = !projection.answerReviewOptIn;
        if (reviewRequest.current?.optedIn !== optedIn) reviewRequest.current = { optedIn, key: key("answer-review") };
        const updated = await setNativeAnswerReview(connection!, projection.runId, optedIn, reviewRequest.current!.key);
        if (current()) publish(updated);
      })}>{projection.answerReviewOptIn ? "Withdraw optional answer review" : "Request independent answer review"}</Button>}
    </div>
    {start && <p className="text-xs break-all">Starting approves the displayed plan {start.planRevisionId} and source {start.sourceManifestId}. Execution has not started through this approval yet.</p>}
    {exportText && <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{exportText}</pre>}
    {!view.answered && <details><summary>{view.manifest ? "Approve a source amendment" : "Approve a specification"}</summary><fieldset disabled={disabled} className="mt-3 space-y-3">
      <label className="block text-sm">Plain text or Markdown specification (up to 512 KiB)<input className="mt-1 block" type="file" accept=".md,.txt,text/plain,text/markdown" onChange={(event) => { const file = event.target.files?.[0]; setSource(undefined); setApproved(false); if (!file) return; void act(async (current) => { const bytes = new Uint8Array(await file.arrayBuffer()); if (!current()) return; if (!bytes.length || bytes.length > 512 * 1024) throw new Error("Choose a nonempty specification of at most 512 KiB."); const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); setSource({ version: 1, approval: "approved_spec", bytesBase64: btoa(binary), mediaType: file.name.toLowerCase().endsWith(".md") ? "text/markdown" : "text/plain", encoding: "utf-8" }); setPreview(text); }); }} /></label>
      {source && <><pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">{preview}</pre><p className="text-xs">Approval preserves the original file bytes, including line endings. The preview decodes the text for reading.</p></>}
      <label className="block text-sm">Section layout (optional JSON array of id, startByte, endByte)<textarea className="mt-1 block w-full rounded border bg-background p-2 text-xs" value={layout} onChange={(event) => { setLayout(event.target.value); setApproved(false); }} /></label>
      {view.manifest && <><label className="block text-sm">Reason for amendment<textarea className="mt-1 block w-full rounded border bg-background p-2" value={rationale} onChange={(event) => { setRationale(event.target.value); setApproved(false); }} /></label><label className="block text-sm">Added and retired section / requirement IDs (JSON)<textarea className="mt-1 block w-full rounded border bg-background p-2 text-xs" value={impact} onChange={(event) => { setImpact(event.target.value); setApproved(false); }} /></label><p className="text-xs break-all">Replaces the displayed source {view.manifest.manifestId}; readiness and prior start approval must be reconsidered.</p></>}
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={exactSourceApproved} onChange={(event) => { approvedPredecessor.current = predecessor; setApproved(event.target.checked); }} />I approve this exact document as the specification{view.manifest ? " amendment and the listed impact" : ""}.</label>
      <Button size="sm" disabled={disabled || !exactSourceApproved || !source || Boolean(view.manifest && !rationale.trim())} onClick={() => void act(async (current) => {
        if (!exactSourceApproved) throw new Error("The displayed source changed; approve the current predecessor explicitly.");
        const approvedSource = { ...source!, ...(layout.trim() ? { sections: JSON.parse(layout) as ApprovedSourceInputV1["sections"] } : {}) };
        const manifest = view.manifest;
        const parsedImpact = manifest ? JSON.parse(impact) : undefined;
        const fingerprint = JSON.stringify({ approvedSource, predecessor: manifest?.manifestId, predecessorDigest: manifest?.artifactDigest, rationale: manifest ? rationale : undefined, impact: parsedImpact });
        if (sourceRequest.current?.fingerprint !== fingerprint) sourceRequest.current = { fingerprint, key: key("source-approval"), amendmentId: key("owner-amendment") };
        const request = sourceRequest.current!;
        const updated = manifest ? await amendNativePlanningSource(connection!, projection.runId, { ...approvedSource, predecessorManifestId: manifest.manifestId, predecessorArtifactDigest: manifest.artifactDigest, amendmentId: request.amendmentId, rationale, impact: parsedImpact, idempotencyKey: request.key }) : await registerNativePlanningSource(connection!, projection.runId, { approvedSource, idempotencyKey: request.key });
        if (!current()) return; setApproved(false); setSource(undefined); publish(updated); setRefresh((value) => value + 1);
      })}>{view.manifest ? "Approve amendment" : "Approve specification"}</Button>
    </fieldset></details>}
  </section>;
}
