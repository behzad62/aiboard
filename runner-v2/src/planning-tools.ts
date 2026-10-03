import type {
  NativeTool,
  ToolExecutionContext,
  ToolExecutionOutput,
  ValidationResult,
} from "./agent-contracts.js";
import type { ArtifactStore } from "./artifact-store.js";
import {
  buildExecutionPlanRevision,
  validateExecutionPlanRevision,
  validateRequirementLedger,
  type ExecutionPlanPhase,
  type ExecutionPlanRevisionWithoutDigest,
  type SourceRequirement,
  type SourceSectionDisposition,
} from "./planning-contracts.js";
import {
  assertOpenArchitectQuestionAllowsEvent,
  assertPendingUserGuidanceAllowsEvent,
  rebuildSchedulerProjection,
  type NewSchedulerEvent,
  type SchedulerProjection,
  type SchedulerStore,
} from "./scheduler-store.js";
import {
  computeArtifactDigest,
  type ApprovedSourceManifest,
} from "./source-manifest.js";
import { createRequestCoverageReviewTool } from "./planning-review.js";

/**
 * Architect lifecycle tools for evidence-gated planning (Runner V2 P6.6, T3a).
 *
 * These tools drive T2's planning events for a NEW-POLICY run
 * (planningPolicyVersion 1): bounded section-by-section source reads,
 * skeleton-ledger persistence before task generation, plan draft/revise,
 * and coverage review requests. C4 derives the resume index from the
 * durable read index and plan/review state instead of recording planning
 * checkpoints. Every tool validates with T1's validators and
 * appends through T2's events — there is no second authority. The scheduler
 * reducer re-validates everything; tool-side checks only produce clearer
 * errors earlier.
 *
 * Coverage review, the reviewer runtime, and the plan_ready transition live in
 * `planning-review.ts` (T3b): `planning.plan_ready` requires a bound coverage
 * review with durably recorded obligations, and the request tool below is the
 * Architect's step that starts that review.
 */

export const MAX_PLANNING_SOURCE_SECTION_BYTES = 64 * 1024;

/** Stable lifecycle-surface names, in the sorted order the surface asserts. */
export const PLANNING_TOOL_NAMES = Object.freeze([
  "draft_planning_plan",
  "persist_planning_ledger",
  "read_planning_source_section",
  "request_coverage_review",
  "revise_planning_plan",
]);

/** Supplies the original approved-source bytes for a manifest. */
export type PlanningSourceReader = (
  manifest: ApprovedSourceManifest,
) => Promise<Uint8Array>;

export interface PlanningToolsOptions {
  store: SchedulerStore;
  artifacts?: ArtifactStore;
  readSource?: PlanningSourceReader;
  clock?: () => string;
  /**
   * T9 repair cycle 1 (N5): when true, the turn is on the answer path and
   * only the durable read tool is registered — every plan-progressing
   * planning tool always refuses there.
   */
  answerPath?: boolean;
}

interface ReadSourceSectionInput {
  manifestId?: string;
  sectionId?: string;
}

interface PersistLedgerInput {
  id: string;
  requirements: readonly SourceRequirement[];
  phases: readonly ExecutionPlanPhase[];
  nonNormativeSections?: readonly SourceSectionDisposition[];
}

interface DraftPlanInput {
  revision: ExecutionPlanRevisionWithoutDigest;
}

interface RevisePlanInput {
  revision: ExecutionPlanRevisionWithoutDigest;
  expectedRevisionId: string;
  expectedDigest: string;
}

export function createPlanningTools(
  options: PlanningToolsOptions,
): NativeTool<unknown>[] {
  const clock = options.clock ?? (() => new Date().toISOString());
  const readSource = options.readSource ??
    (options.artifacts ? artifactSourceReader(options.artifacts) : undefined);
  // T3b (N2): every full verified read appends a durable
  // `planning.source_section_read` event bound to the manifest revision and
  // section digest. Checkpoint coverage and readiness read the durable
  // projection — there is no in-memory receipt set anymore.
  // T9 repair cycle 1 (N5): answer turns keep only the durable read.
  if (options.answerPath === true) {
    return [readSourceSectionTool(options.store, readSource, clock)];
  }
  return [
    readSourceSectionTool(options.store, readSource, clock),
    persistLedgerTool(options.store, clock),
    draftPlanTool(options.store, clock),
    revisePlanTool(options.store, clock),
    createRequestCoverageReviewTool({ store: options.store, clock }),
  ];
}

function artifactSourceReader(artifacts: ArtifactStore): PlanningSourceReader {
  return async (manifest) => artifacts.get(manifest.artifactDigest);
}

function readSourceSectionTool(
  store: SchedulerStore,
  readSource: PlanningSourceReader | undefined,
  clock: () => string,
): NativeTool<ReadSourceSectionInput> {
  return lifecycleTool({
    name: "read_planning_source_section",
    description:
      "Read one approved-source section in full over the manifest's complete section inventory, " +
      "or list the inventory when sectionId is omitted. Bounded: a section larger than the byte " +
      "cap is refused, never truncated. A full verified read appends a durable read record that " +
      "the derived resume index counts as covered; the inventory listing exposes the full derived index.",
    schema: {
      type: "object",
      properties: {
        manifestId: { type: "string", minLength: 1 },
        sectionId: { type: "string", minLength: 1 },
      },
      required: [],
      additionalProperties: false,
    },
    validate: (input) =>
      validateObject(input, (value) => {
        if (
          value.manifestId !== undefined && !nonEmpty(value.manifestId)
        ) return null;
        if (
          value.sectionId !== undefined && !nonEmpty(value.sectionId)
        ) return null;
        return {
          ...(value.manifestId !== undefined ? { manifestId: value.manifestId } : {}),
          ...(value.sectionId !== undefined ? { sectionId: value.sectionId } : {}),
        };
      }, "manifestId and sectionId must be non-empty strings when provided."),
    execute: async (input, context) => {
      const denied = architectOnly(context);
      if (denied) return denied;
      const projection = rebuildSchedulerProjection(store.readRun(context.runId));
      if (projection.planningPolicyVersion !== 1 || !projection.planning) {
        return errorOutput(
          "planning_not_configured",
          "Source reads require a new-policy run with a registered approved source.",
        );
      }
      const planning = projection.planning;
      const manifest = planning.source.manifestsById[planning.source.currentManifestId];
      if (input.manifestId !== undefined && input.manifestId !== manifest.manifestId) {
        return errorOutput(
          "stale_manifest",
          `Source read cites manifest ${input.manifestId}, but the current manifest is ${manifest.manifestId}.`,
        );
      }
      // Inventory listing: the complete trusted section inventory plus the
      // derived resume index (covered and remaining sections, completed
      // contracts, outstanding work, next action), with no content. The
      // Architect reads every section.
      if (input.sectionId === undefined) {
        return {
          content: [{
            type: "json",
            value: {
              manifestId: manifest.manifestId,
              sourceId: manifest.sourceId,
              artifactDigest: manifest.artifactDigest,
              byteLength: manifest.byteLength,
              sections: manifest.sections.map((section) => ({
                id: section.id,
                ...(section.title !== undefined ? { title: section.title } : {}),
                startByte: section.startByte,
                endByte: section.endByte,
                digest: section.digest,
              })),
              coveredSourceSectionIds: [...planning.resume.coveredSourceSectionIds],
              remainingSourceSectionIds: [...planning.resume.remainingSourceSectionIds],
              ...(planning.resume.nextSourceSectionId !== undefined
                ? { nextSourceSectionId: planning.resume.nextSourceSectionId }
                : {}),
              completedPlanningContractIds: [...planning.resume.completedPlanningContractIds],
              outstandingWork: [...planning.resume.outstandingWork],
              nextAction: planning.resume.nextAction,
            },
          }],
          isError: false,
        };
      }
      const section = manifest.sections.find((candidate) => candidate.id === input.sectionId);
      if (!section) {
        return errorOutput(
          "unknown_manifest_section",
          `Source section ${input.sectionId} is not in the current manifest's complete section inventory.`,
        );
      }
      const spanBytes = section.endByte - section.startByte;
      if (spanBytes > MAX_PLANNING_SOURCE_SECTION_BYTES) {
        return errorOutput(
          "source_section_too_large",
          `Source section ${section.id} spans ${spanBytes} bytes, over the ${MAX_PLANNING_SOURCE_SECTION_BYTES}-byte bound; it cannot be read and never counts as covered.`,
        );
      }
      if (!readSource) {
        return errorOutput(
          "source_bytes_unavailable",
          "Approved-source bytes are not provisioned for this run; the section cannot be read and never counts as covered.",
        );
      }
      let bytes: Uint8Array;
      try {
        bytes = await readSource(manifest);
      } catch (error) {
        return errorOutput(
          "source_bytes_unavailable",
          error instanceof Error ? error.message : String(error),
        );
      }
      if (bytes.length !== manifest.byteLength) {
        return errorOutput(
          "source_bytes_drift",
          `Supplied source bytes have length ${bytes.length}, not the manifest's recorded ${manifest.byteLength} (source drift); nothing is counted as covered.`,
        );
      }
      if (computeArtifactDigest(bytes) !== manifest.artifactDigest) {
        return errorOutput(
          "source_bytes_drift",
          "Supplied source bytes do not match the manifest's recorded artifact digest (source drift); nothing is counted as covered.",
        );
      }
      const slice = bytes.subarray(section.startByte, section.endByte);
      if (slice.length !== spanBytes) {
        return errorOutput(
          "source_section_truncated",
          `Source section ${section.id} could only be read partially (${slice.length} of ${spanBytes} bytes); a truncated section never counts as covered.`,
        );
      }
      if (computeArtifactDigest(slice) !== section.digest) {
        return errorOutput(
          "source_bytes_drift",
          `Source section ${section.id} does not match its recorded digest (source drift); it never counts as covered.`,
        );
      }
      // T3b (N2): the full verified read is durable. Re-reading the same
      // section at the same revision is an idempotent no-op.
      try {
        assertPendingUserGuidanceAllowsEvent(projection, {
          type: "planning.source_section_read",
          actor: { role: "architect", id: context.actor.id },
          payload: {},
        });
        assertOpenArchitectQuestionAllowsEvent(projection, {
          type: "planning.source_section_read",
          actor: { role: "architect", id: context.actor.id },
          payload: {},
        });
        store.append({
          runId: context.runId,
          type: "planning.source_section_read",
          occurredAt: clock(),
          actor: { role: "architect", id: context.actor.id },
          idempotencyKey: `planning-sourceread:${manifest.manifestId}:${section.id}`,
          payload: {
            manifestId: manifest.manifestId,
            manifestDigest: manifest.artifactDigest,
            sectionId: section.id,
            sectionDigest: section.digest,
            readAt: clock(),
          },
        });
      } catch (error) {
        return errorOutput(
          "mechanical_transition_rejected",
          error instanceof Error ? error.message : String(error),
        );
      }
      return {
        content: [{
          type: "json",
          value: {
            manifestId: manifest.manifestId,
            sectionId: section.id,
            startByte: section.startByte,
            endByte: section.endByte,
            byteLength: slice.length,
            digest: section.digest,
            text: Buffer.from(slice).toString("utf8"),
          },
        }],
        isError: false,
      };
    },
  });
}

function persistLedgerTool(
  store: SchedulerStore,
  clock: () => string,
): NativeTool<PersistLedgerInput> {
  return lifecycleTool({
    name: "persist_planning_ledger",
    description:
      "Persist the requirement-ledger skeleton (requirements plus phases) before task generation. " +
      "Every manifest section must be referenced or carry an authorized non-normative disposition.",
    schema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1 },
        requirements: { type: "array", minItems: 1 },
        phases: { type: "array", minItems: 1 },
        nonNormativeSections: { type: "array" },
      },
      required: ["id", "requirements", "phases"],
      additionalProperties: false,
    },
    validate: (input) =>
      validateObject(input, (value) => {
        if (!nonEmpty(value.id)) return null;
        if (!Array.isArray(value.requirements) || value.requirements.length === 0) return null;
        if (!Array.isArray(value.phases) || value.phases.length === 0) return null;
        if (value.nonNormativeSections !== undefined && !Array.isArray(value.nonNormativeSections)) {
          return null;
        }
        return {
          id: value.id,
          requirements: value.requirements as readonly SourceRequirement[],
          phases: value.phases as readonly ExecutionPlanPhase[],
          ...(value.nonNormativeSections !== undefined
            ? { nonNormativeSections: value.nonNormativeSections as readonly SourceSectionDisposition[] }
            : {}),
        };
      }, "id, requirements, and phases are required."),
    execute: async (input, context) => {
      const denied = architectOnly(context);
      if (denied) return denied;
      const projection = rebuildSchedulerProjection(store.readRun(context.runId));
      if (projection.planningPolicyVersion !== 1 || !projection.planning) {
        return errorOutput(
          "planning_not_configured",
          "The requirement ledger requires a new-policy run with a registered approved source.",
        );
      }
      const triage = triageBuildRequired(projection);
      if (triage) return triage;
      const planning = projection.planning;
      if (planning.ledger) {
        return errorOutput(
          "ledger_already_persisted",
          "The initial planning ledger is already persisted.",
        );
      }
      const manifest = planning.source.manifestsById[planning.source.currentManifestId];
      const validation = validateRequirementLedger(
        input.requirements,
        manifest,
        input.phases.map((phase) => (phase as ExecutionPlanPhase).id),
        input.nonNormativeSections ?? [],
        amendmentHistoryOf(planning),
      );
      if (!validation.valid) {
        return errorOutput(
          "invalid_requirement_ledger",
          `Requirement ledger is invalid: ${validation.issues.map((issue) => issue.message).join(" ")}`,
          validation.issues.map((issue) => issue.message),
        );
      }
      return appendEvent(store, {
        runId: context.runId,
        type: "planning.ledger_persisted",
        occurredAt: clock(),
        actor: { role: "architect", id: context.actor.id },
        idempotencyKey: `planning-ledger:${input.id}`,
        payload: {
          id: input.id,
          requirements: structuredClone(input.requirements),
          phases: structuredClone(input.phases),
          nonNormativeSections: structuredClone(input.nonNormativeSections ?? []),
        },
      }, {
        type: "architect_action",
        action: "plan_created",
        referenceId: input.id,
      });
    },
  });
}

// C4 (AR-R13): record_planning_checkpoint is removed from the new-policy surface. The resume index is derived from the durable read index and plan/review state; old checkpoint events still reduce and replay. No replacement bookkeeping tool.
function draftPlanTool(
  store: SchedulerStore,
  clock: () => string,
): NativeTool<DraftPlanInput> {
  return lifecycleTool({
    name: "draft_planning_plan",
    description:
      "Draft the execution plan revision (requirements, phases, complete task contracts, bounded " +
      "investigations) after the requirement ledger is persisted.",
    schema: {
      type: "object",
      properties: {
        revision: { type: "object" },
      },
      required: ["revision"],
      additionalProperties: false,
    },
    validate: (input) =>
      validateObject(input, (value) => {
        if (!isRecord(value.revision) || !nonEmpty(value.revision.revisionId)) return null;
        return { revision: value.revision as ExecutionPlanRevisionWithoutDigest };
      }, "revision with a revisionId is required."),
    execute: async (input, context) => {
      const denied = architectOnly(context);
      if (denied) return denied;
      const projection = rebuildSchedulerProjection(store.readRun(context.runId));
      if (projection.planningPolicyVersion !== 1 || !projection.planning) {
        return errorOutput(
          "planning_not_configured",
          "Plan drafts require a new-policy run with a registered approved source.",
        );
      }
      const triage = triageBuildRequired(projection);
      if (triage) return triage;
      const planning = projection.planning;
      if (!planning.ledger) {
        return errorOutput(
          "ledger_required",
          "The requirement ledger must be persisted before the plan is drafted.",
        );
      }
      if (planning.plan) {
        return errorOutput(
          "plan_already_drafted",
          "An initial planning revision already exists; use revise_planning_plan.",
        );
      }
      const manifest = planning.source.manifestsById[planning.source.currentManifestId];
      const revision = buildExecutionPlanRevision(input.revision);
      const validation = validateExecutionPlanRevision(
        revision,
        manifest,
        amendmentHistoryOf(planning),
      );
      if (!validation.valid) {
        return errorOutput(
          "invalid_plan_revision",
          `Plan revision is invalid: ${validation.issues.map((issue) => issue.message).join(" ")}`,
          validation.issues.map((issue) => issue.message),
        );
      }
      return appendEvent(store, {
        runId: context.runId,
        type: "planning.plan_drafted",
        occurredAt: clock(),
        actor: { role: "architect", id: context.actor.id },
        idempotencyKey: `planning-plan:${revision.revisionId}`,
        payload: {
          revision: structuredClone(revision),
        },
      }, {
        type: "architect_action",
        action: "plan_created",
        referenceId: revision.revisionId,
      });
    },
  });
}

function revisePlanTool(
  store: SchedulerStore,
  clock: () => string,
): NativeTool<RevisePlanInput> {
  return lifecycleTool({
    name: "revise_planning_plan",
    description:
      "Revise the execution plan revision against the exact current revision identity " +
      "(expectedRevisionId plus expectedDigest); a stale base is refused.",
    schema: {
      type: "object",
      properties: {
        revision: { type: "object" },
        expectedRevisionId: { type: "string", minLength: 1 },
        expectedDigest: { type: "string", minLength: 1 },
      },
      required: ["revision", "expectedRevisionId", "expectedDigest"],
      additionalProperties: false,
    },
    validate: (input) =>
      validateObject(input, (value) => {
        if (!isRecord(value.revision) || !nonEmpty(value.revision.revisionId)) return null;
        if (!nonEmpty(value.expectedRevisionId) || !nonEmpty(value.expectedDigest)) return null;
        return {
          revision: value.revision as ExecutionPlanRevisionWithoutDigest,
          expectedRevisionId: value.expectedRevisionId,
          expectedDigest: value.expectedDigest,
        };
      }, "revision, expectedRevisionId, and expectedDigest are required."),
    execute: async (input, context) => {
      const denied = architectOnly(context);
      if (denied) return denied;
      const projection = rebuildSchedulerProjection(store.readRun(context.runId));
      if (projection.planningPolicyVersion !== 1 || !projection.planning) {
        return errorOutput(
          "planning_not_configured",
          "Plan revisions require a new-policy run with a registered approved source.",
        );
      }
      const triage = triageBuildRequired(projection);
      if (triage) return triage;
      const planning = projection.planning;
      if (!planning.ledger) {
        return errorOutput(
          "ledger_required",
          "The requirement ledger must be persisted before the plan is revised.",
        );
      }
      if (!planning.plan) {
        return errorOutput(
          "plan_not_drafted",
          "No initial planning revision exists; use draft_planning_plan first.",
        );
      }
      if (
        input.expectedRevisionId !== planning.plan.currentRevisionId ||
        input.expectedDigest !== planning.plan.currentDigest
      ) {
        return errorOutput(
          "stale_plan_revision",
          "Plan revision uses a stale base revision; re-read the current revision identity first.",
        );
      }
      const manifest = planning.source.manifestsById[planning.source.currentManifestId];
      const revision = buildExecutionPlanRevision(input.revision);
      if (planning.plan.revisionHistoryIds.includes(revision.revisionId)) {
        return errorOutput(
          "duplicate_plan_revision",
          `Planning revision id ${revision.revisionId} is already in the revision history.`,
        );
      }
      const validation = validateExecutionPlanRevision(
        revision,
        manifest,
        amendmentHistoryOf(planning),
      );
      if (!validation.valid) {
        return errorOutput(
          "invalid_plan_revision",
          `Plan revision is invalid: ${validation.issues.map((issue) => issue.message).join(" ")}`,
          validation.issues.map((issue) => issue.message),
        );
      }
      return appendEvent(store, {
        runId: context.runId,
        type: "planning.plan_revised",
        occurredAt: clock(),
        actor: { role: "architect", id: context.actor.id },
        idempotencyKey: `planning-plan:${revision.revisionId}`,
        payload: {
          revision: structuredClone(revision),
          expectedRevisionId: input.expectedRevisionId,
          expectedDigest: input.expectedDigest,
        },
      }, {
        type: "architect_action",
        action: "plan_reconciled",
        referenceId: revision.revisionId,
      });
    },
  });
}

function amendmentHistoryOf(
  planning: NonNullable<ReturnType<typeof rebuildSchedulerProjection>["planning"]>,
) {
  return planning.source.manifestHistoryIds.flatMap((manifestId) => {
    const amendment = planning.source.manifestsById[manifestId]?.amendment;
    return amendment ? [amendment] : [];
  });
}

interface LifecycleToolOptions<T> {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  validate: (input: unknown) => ValidationResult<T>;
  execute: NativeTool<T>["execute"];
}

function lifecycleTool<T>(options: LifecycleToolOptions<T>): NativeTool<T> {
  return {
    definition: {
      name: options.name,
      description: options.description,
      inputSchema: options.schema,
      readOnly: false,
      effect: "none",
      lifecycle: true,
    },
    validate: options.validate,
    execute: options.execute,
  };
}

function validateObject<T>(
  input: unknown,
  parse: (value: Record<string, unknown>) => T | null,
  issue: string,
): ValidationResult<T> {
  if (!isRecord(input)) return { ok: false, issues: [issue] };
  const value = parse(input);
  return value ? { ok: true, value } : { ok: false, issues: [issue] };
}

function appendEvent(
  store: SchedulerStore,
  event: NewSchedulerEvent,
  lifecycle: NonNullable<ToolExecutionOutput["lifecycle"]>,
): ToolExecutionOutput {
  try {
    const events = store.readRun(event.runId);
    const projection = events.length > 0
      ? rebuildSchedulerProjection(events)
      : undefined;
    if (projection) {
      assertPendingUserGuidanceAllowsEvent(projection, event);
      assertOpenArchitectQuestionAllowsEvent(projection, event);
    }
    const appended = store.append(event);
    return {
      content: [{ type: "json", value: appended }],
      isError: false,
      lifecycle,
    };
  } catch (error) {
    return errorOutput(
      "mechanical_transition_rejected",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function architectOnly(context: ToolExecutionContext): ToolExecutionOutput | null {
  return context.actor.role === "architect"
    ? null
    : errorOutput("architect_only", "Only the Architect may use this tool.");
}

/**
 * T9 triage-first ordering (per-tool half): plan-progressing planning tools
 * require a durable triage decision of `build`. The durable read tool is
 * exempt — triage and answer turns may inspect the source. The reducer
 * refuses forged events as well.
 */
function triageBuildRequired(projection: SchedulerProjection): ToolExecutionOutput | null {
  if (projection.planningTriageDecision !== "build") {
    return errorOutput(
      "triage_required",
      "Planning requires a durable triage decision of build; record triage first."
    );
  }
  return null;
}

function errorOutput(code: string, message: string, issues?: string[]): ToolExecutionOutput {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    error: { code, message, ...(issues ? { issues } : {}) },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
