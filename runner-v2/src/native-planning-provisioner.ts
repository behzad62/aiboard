import { createHash } from "node:crypto";

import type { NativeBuildSpec } from "./build-spec.js";
import type {
  NewSchedulerEvent,
  SchedulerEvent,
} from "./scheduler-store.js";
import {
  assertApprovedSourceManifest,
  assertManifestMatchesBytes,
  buildSourceManifest,
  computeArtifactDigest,
  validateApprovedSourceManifest,
  type ApprovedSourceManifest,
  type SourceManifestSectionInput,
} from "./source-manifest.js";

/**
 * T7a production planning provisioning (opt-in only, owner decision
 * 2026-10-03). This module is the single authority for explicit-policy
 * provisioning: request-only approved-source validation, deterministic
 * kernel manifest identities, the early docs2/run.initialized/planning.policy1
 * scheduler prefix, idempotent source registration, and the stable original-
 * request identity used for existing-request retries.
 *
 * Fresh product requests missing `planningPolicy` retain their current
 * (legacy) default: nothing here infers a default. An approved source
 * without an explicit `planningPolicy.version: 1` opt-in is refused rather
 * than silently changing the default.
 */

/** T7a kernel actor for user-approved source registration (local control auth). */
export const T7A_APPROVED_SOURCE_ACTOR_ID = "local-user";

/** Supported approved-source media types for initial T7a provisioning. */
export const T7A_SUPPORTED_SOURCE_MEDIA_TYPES = [
  "text/plain",
  "text/markdown",
] as const;
export type T7aSupportedSourceMediaType =
  (typeof T7A_SUPPORTED_SOURCE_MEDIA_TYPES)[number];

/** Only UTF-8 is supported for initial T7a provisioning. */
export const T7A_SUPPORTED_SOURCE_ENCODING = "utf-8";

/** Decoded approved-source bound (512 KiB); the 1 MiB JSON body limit still applies. */
export const T7A_MAX_APPROVED_SOURCE_BYTES = 512 * 1024;

/**
 * Request-only approved-source bytes/intent (transport seam). This is a
 * proposal, never an authority: the caller cannot supply a manifest, digest,
 * or approval identity. The kernel validates the bytes, computes every
 * digest/identity, and persists the kernel-generated manifest on the saved
 * spec. Never persisted as-is.
 */
export type { ApprovedSourceInputV1 } from "./planning-control-contracts.js";
import type { ApprovedSourceInputV1 } from "./planning-control-contracts.js";

export interface ValidatedApprovedSource {
  readonly bytes: Uint8Array;
  readonly mediaType: T7aSupportedSourceMediaType;
  readonly encoding: typeof T7A_SUPPORTED_SOURCE_ENCODING;
  readonly sections: readonly SourceManifestSectionInput[];
}

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Fail-closed validation of request-only approved-source bytes/intent.
 * Refuses unknown shapes, non-approved_spec intent, unsupported media or
 * encoding, non-canonical base64, oversize payloads, invalid UTF-8,
 * non-character-boundary spans, and incomplete section coverage — always
 * before any model call or durable effect. Original bytes (including any
 * BOM and line endings) are never transcoded or truncated.
 */
export function validateApprovedSourceInput(
  input: unknown,
): ValidatedApprovedSource {
  if (!isRecord(input)) fail("Approved source must be an object.");
  for (const key of Object.keys(input)) {
    if (key !== "version" && key !== "approval" && key !== "bytesBase64" && key !== "mediaType" && key !== "encoding" && key !== "sections") {
      fail(`Approved source has an unknown field: ${key}.`);
    }
  }
  if (input.version !== 1) fail("Approved source version must be 1.");
  if (input.approval !== "approved_spec") {
    fail("Approved source requires explicit approval 'approved_spec'.");
  }
  const mediaType = input.mediaType;
  if (mediaType !== "text/plain" && mediaType !== "text/markdown") {
    fail(
      "Approved source mediaType must be text/plain or text/markdown.",
    );
  }
  if (input.encoding !== "utf-8") fail("Approved source encoding must be utf-8.");
  if (typeof input.bytesBase64 !== "string" || input.bytesBase64.length === 0) {
    fail("Approved source bytesBase64 must be a non-empty string.");
  }
  if (
    input.bytesBase64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(input.bytesBase64)
  ) {
    fail("Approved source bytesBase64 must be canonical base64.");
  }
  const bytes = Buffer.from(input.bytesBase64, "base64");
  if (bytes.toString("base64") !== input.bytesBase64) {
    fail("Approved source bytesBase64 must be canonical base64.");
  }
  if (bytes.length === 0) fail("Approved source must not be empty.");
  if (bytes.length > T7A_MAX_APPROVED_SOURCE_BYTES) {
    fail(
      `Approved source exceeds the ${T7A_MAX_APPROVED_SOURCE_BYTES}-byte decoded limit.`,
    );
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("Approved source bytes are not valid UTF-8.");
  }
  const sections = normalizeSourceSections(input.sections, bytes.length);
  for (const boundary of sections.flatMap((section) => [
    section.startByte,
    section.endByte,
  ])) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, boundary),
      );
    } catch {
      fail(
        "Approved source section boundaries must fall on UTF-8 character boundaries.",
      );
    }
  }
  return {
    bytes: new Uint8Array(bytes),
    mediaType,
    encoding: "utf-8",
    sections,
  };
}

function normalizeSourceSections(
  sections: unknown,
  byteLength: number,
): SourceManifestSectionInput[] {
  if (sections === undefined) {
    return [{ id: "section-1", startByte: 0, endByte: byteLength }];
  }
  if (!Array.isArray(sections) || sections.length === 0) {
    fail("Approved source sections must be a non-empty array when provided.");
  }
  const normalized: SourceManifestSectionInput[] = [];
  const seen = new Set<string>();
  let expectedNext = 0;
  for (const entry of sections) {
    if (!isRecord(entry)) fail("Approved source section must be an object.");
    for (const key of Object.keys(entry)) {
      if (key !== "id" && key !== "title" && key !== "startByte" && key !== "endByte") {
        fail(`Approved source section has an unknown field: ${key}.`);
      }
    }
    const { id, title, startByte, endByte } = entry as {
      id: unknown;
      title: unknown;
      startByte: unknown;
      endByte: unknown;
    };
    if (typeof id !== "string" || !id.trim()) {
      fail("Approved source section id must be a non-empty string.");
    }
    if (seen.has(id)) fail(`Approved source has a duplicate section id ${id}.`);
    seen.add(id);
    if (title !== undefined && typeof title !== "string") {
      fail(`Approved source section ${id} title must be a string.`);
    }
    if (
      !Number.isSafeInteger(startByte) ||
      !Number.isSafeInteger(endByte) ||
      (startByte as number) < 0 ||
      (endByte as number) <= (startByte as number) ||
      (endByte as number) > byteLength
    ) {
      fail(`Approved source section ${id} has an invalid byte span.`);
    }
    if ((startByte as number) !== expectedNext) {
      fail(
        "Approved source sections must completely and contiguously cover byte 0 through the document length in order.",
      );
    }
    expectedNext = endByte as number;
    normalized.push({
      id,
      ...(title !== undefined ? { title: title as string } : {}),
      startByte: startByte as number,
      endByte: endByte as number,
    });
  }
  if (expectedNext !== byteLength) {
    fail(
      "Approved source sections must completely and contiguously cover byte 0 through the document length in order.",
    );
  }
  return normalized;
}

/**
 * Deterministic kernel identities for an approved source. The sourceId is
 * stable and run-scoped across the source's amendment chain; the manifestId
 * binds the exact run, artifact digest, supported media/encoding, and the
 * canonical section layout. Recomputed — never accepted from a caller.
 */
export function deriveApprovedSourceIdentities(input: {
  runId: string;
  artifactDigest: string;
  mediaType: string;
  encoding: string;
  sections: readonly SourceManifestSectionInput[];
}): { sourceId: string; manifestId: string } {
  const sourceId = `src-${createHash("sha256")
    .update(`t7a-approved-source/v1/${input.runId}`, "utf8")
    .digest("hex")
    .slice(0, 32)}`;
  const canonicalSections = input.sections.map((section) => [
    section.id,
    section.title ?? null,
    section.startByte,
    section.endByte,
  ]);
  const manifestId = `manifest-${createHash("sha256")
    .update(
      JSON.stringify([
        "t7a-approved-source-manifest/v1",
        input.runId,
        input.artifactDigest,
        input.mediaType,
        input.encoding,
        canonicalSections,
      ]),
      "utf8",
    )
    .digest("hex")
    .slice(0, 32)}`;
  return { sourceId, manifestId };
}

/**
 * Builds the kernel-approved manifest for validated bytes. Every digest and
 * identity derives mechanically from the actual bytes; authority records the
 * authenticated user (never a caller-chosen value); createdAt is the original
 * saved spec creation time (never regenerated on retry).
 */
export function buildApprovedSourceManifest(input: {
  runId: string;
  validated: ValidatedApprovedSource;
  artifactDigest: string;
  approvedBy?: string;
  createdAt: string;
}): ApprovedSourceManifest {
  const { sourceId, manifestId } = deriveApprovedSourceIdentities({
    runId: input.runId,
    artifactDigest: input.artifactDigest,
    mediaType: input.validated.mediaType,
    encoding: input.validated.encoding,
    sections: input.validated.sections,
  });
  const approver =
    input.approvedBy === undefined
      ? T7A_APPROVED_SOURCE_ACTOR_ID
      : validateApproverName(input.approvedBy);
  return buildSourceManifest(input.validated.bytes, input.validated.sections, {
    manifestId,
    sourceId,
    mediaType: input.validated.mediaType,
    encoding: input.validated.encoding,
    authority: `user:${approver}`,
    createdAt: input.createdAt,
  });
}

/**
 * Reads the authenticated user id out of a kernel manifest authority
 * (`user:<id>`). Anything else � missing prefix, empty id, non-user
 * provenance � is refused; callers must never silently fall back to a
 * default approver.
 */
export function parseApprovedSourceAuthority(authority: string, manifestId: string): string {
  if (typeof authority !== "string" || !authority.startsWith("user:")) {
    throw new Error(
      `Approved source ${manifestId} carries no authenticated user approval authority.`,
    );
  }
  const id = authority.slice("user:".length);
  if (!id || /[\s:]/.test(id)) {
    throw new Error(
      `Approved source ${manifestId} carries an invalid approval authority.`,
    );
  }
  return id;
}

/**
 * Validates an approver name for the typed preparation seam. The value comes
 * from the authenticated route (never request bytes); malformed values are
 * refused before any effect.
 */
export function validateApproverName(approvedBy: unknown): string {
  if (typeof approvedBy !== "string" || !approvedBy || /[\s:]/.test(approvedBy)) {
    throw new Error("Approved-source approver must be a non-empty name without whitespace or colons.");
  }
  return approvedBy;
}

/**
 * Enforces the supported initial-source rules over actually stored bytes and
 * the manifest layout: supported media/encoding, decoded size bound, valid
 * UTF-8, and section boundaries on UTF-8 character boundaries. Original bytes
 * (BOM, newlines) are never transcoded or truncated.
 */
export function assertSupportedInitialSourceBytes(
  bytes: Uint8Array,
  manifest: ApprovedSourceManifest,
): void {
  if (
    manifest.mediaType !== "text/plain" &&
    manifest.mediaType !== "text/markdown"
  ) {
    throw new Error(
      `Approved source ${manifest.manifestId} mediaType ${manifest.mediaType} is not supported for initial provisioning.`,
    );
  }
  if (manifest.encoding !== T7A_SUPPORTED_SOURCE_ENCODING) {
    throw new Error(
      `Approved source ${manifest.manifestId} encoding ${manifest.encoding} is not supported for initial provisioning.`,
    );
  }
  if (bytes.length > T7A_MAX_APPROVED_SOURCE_BYTES) {
    throw new Error(
      `Approved source ${manifest.manifestId} exceeds the ${T7A_MAX_APPROVED_SOURCE_BYTES}-byte decoded limit.`,
    );
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(
      `Approved source ${manifest.manifestId} bytes are not valid UTF-8.`,
    );
  }
  for (const section of manifest.sections) {
    for (const boundary of [section.startByte, section.endByte]) {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, boundary),
        );
      } catch {
        throw new Error(
          `Approved source ${manifest.manifestId} section ${section.id} boundary does not fall on a UTF-8 character boundary.`,
        );
      }
    }
  }
}

/**
 * Verifies a prepared spec's kernel manifest against the actually stored
 * artifact bytes and the deterministic kernel identities. Used when a saved
 * prepared spec is passed internally: identity is verified, never
 * regenerated and never trusted from an external field.
 */
export function verifyPreparedApprovedSource(input: {
  runId: string;
  manifest: ApprovedSourceManifest;
  storedBytes: Uint8Array;
  createdAt: string;
}): void {
  assertApprovedSourceManifest(input.manifest);
  if (input.manifest.amendment) {
    throw new Error(
      "A prepared build spec carries the initial approved source only; amendments travel as planning events.",
    );
  }
  assertSupportedInitialSourceBytes(input.storedBytes, input.manifest);
  assertManifestMatchesBytes(input.manifest, input.storedBytes);
  if (input.manifest.createdAt !== input.createdAt) {
    throw new Error(
      `Approved source ${input.manifest.manifestId} is not bound to the saved spec creation time.`,
    );
  }
  parseApprovedSourceAuthority(input.manifest.authority, input.manifest.manifestId);
  if (computeArtifactDigest(input.storedBytes) !== input.manifest.artifactDigest) {
    throw new Error(
      `Approved source ${input.manifest.manifestId} does not match the stored artifact bytes (source drift).`,
    );
  }
  const { sourceId, manifestId } = deriveApprovedSourceIdentities({
    runId: input.runId,
    artifactDigest: input.manifest.artifactDigest,
    mediaType: input.manifest.mediaType,
    encoding: input.manifest.encoding,
    sections: input.manifest.sections.map((section) => ({
      id: section.id,
      ...(section.title !== undefined ? { title: section.title } : {}),
      startByte: section.startByte,
      endByte: section.endByte,
    })),
  });
  if (
    sourceId !== input.manifest.sourceId ||
    manifestId !== input.manifest.manifestId
  ) {
    throw new Error(
      `Approved source ${input.manifest.manifestId} is not the kernel identity for this run and artifact.`,
    );
  }
}

export interface ProvisioningSchedulerStore {
  readRun(runId: string, afterSequence?: number): SchedulerEvent[];
  append(input: NewSchedulerEvent): SchedulerEvent;
}

export type PlanningProvisioningMode = "legacy" | "provisioned" | "reused";

const RUNNER_PROVISIONING_ACTOR = { role: "runner", id: "build-runtime" } as const;
const DOCS_POLICY_KEY = "project-docs-policy";
const RUN_INITIALIZED_KEY = "run-initialized";
const PLANNING_POLICY_KEY = "planning-policy";

/**
 * Shared provisioning initializer: the single authority for the early
 * scheduler prefix. Called by NativeBuildFactory immediately after opening
 * scheduler storage (before any factory consumer reads planning/docs policy
 * or creates run integration/context resources) and reused by BuildRuntime
 * for standalone construction (a second call validates and reuses).
 *
 * New-policy (explicit `planningPolicy.version: 1`) prefix: docs policy v2
 * at sequence 1, run.initialized at sequence 2, planning.policy_configured
 * v1 at sequence 3, before the existing run/verifier/repair/critique setup.
 * Empty, docs-only, and docs+init prefixes recover in order; a full matching
 * prefix (or a longer log opening with it) is reused. Any mismatched
 * policy/objective/actor or unrelated-event partial prefix is refused before
 * consumers or model calls. Legacy specs (no planningPolicy) are untouched:
 * old recorded logs are never restamped and a new-policy spec never recovers
 * against a legacy scheduler prefix.
 */
export function ensurePlanningProvisioningPrefix(
  store: ProvisioningSchedulerStore,
  spec: Pick<NativeBuildSpec, "runId" | "planningPolicy"> & {
    readonly objective?: string;
  },
  clock: () => string = () => new Date().toISOString(),
): { mode: PlanningProvisioningMode } {
  if (spec.planningPolicy?.version !== 1) {
    const prior = store.readRun(spec.runId);
    if (prior.some((event) => event.type === "planning.policy_configured" ||
      (event.type === "project_docs.policy_configured" && event.payload.version === 2))) {
      fail("Planning provisioning refuses a policy downgrade: a run without the explicit planningPolicy version 1 opt-in cannot recover against a recorded docs2/planning1 prefix.");
    }
    return { mode: "legacy" };
  }
  const events = store.readRun(spec.runId);
  if (events.length === 0) {
    appendDocsPolicy(store, spec.runId, clock());
    appendRunInitialized(store, spec, clock());
    appendPlanningPolicy(store, spec.runId, clock());
    return { mode: "provisioned" };
  }
  const [docs, init, planning, ...rest] = events;
  assertProvisioningDocsEvent(docs, spec.runId);
  if (init === undefined) {
    if (rest.length > 0) fail("Planning provisioning refuses an ambiguous scheduler prefix.");
    appendRunInitialized(store, spec, clock());
    appendPlanningPolicy(store, spec.runId, clock());
    return { mode: "provisioned" };
  }
  assertProvisioningInitEvent(init, spec);
  if (planning === undefined) {
    if (rest.length > 0) fail("Planning provisioning refuses an ambiguous scheduler prefix.");
    appendPlanningPolicy(store, spec.runId, clock());
    return { mode: "provisioned" };
  }
  assertProvisioningPlanningEvent(planning, spec.runId);
  return { mode: "reused" };
}

function appendDocsPolicy(
  store: ProvisioningSchedulerStore,
  runId: string,
  occurredAt: string,
): void {
  store.append({
    runId,
    type: "project_docs.policy_configured",
    occurredAt,
    actor: { ...RUNNER_PROVISIONING_ACTOR },
    idempotencyKey: DOCS_POLICY_KEY,
    payload: { version: 2 },
  });
}

function appendRunInitialized(
  store: ProvisioningSchedulerStore,
  spec: Pick<NativeBuildSpec, "runId"> & { readonly objective?: string },
  occurredAt: string,
): void {
  store.append({
    runId: spec.runId,
    type: "run.initialized",
    occurredAt,
    actor: { ...RUNNER_PROVISIONING_ACTOR },
    idempotencyKey: RUN_INITIALIZED_KEY,
    payload: {
      testIntegrityPolicyVersion: 1,
      submissionScopePolicyVersion: 1,
      reviewIntegrityPolicyVersion: 1,
      ...(spec.objective !== undefined ? { objective: spec.objective } : {}),
    },
  });
}

function appendPlanningPolicy(
  store: ProvisioningSchedulerStore,
  runId: string,
  occurredAt: string,
): void {
  store.append({
    runId,
    type: "planning.policy_configured",
    occurredAt,
    actor: { ...RUNNER_PROVISIONING_ACTOR },
    idempotencyKey: PLANNING_POLICY_KEY,
    payload: { version: 1 },
  });
}

function assertProvisioningDocsEvent(event: SchedulerEvent | undefined, runId: string): void {
  if (
    !event ||
    event.runId !== runId ||
    event.sequence !== 1 ||
    event.type !== "project_docs.policy_configured" ||
    event.actor.role !== "runner" ||
    event.actor.id !== "build-runtime" ||
    event.idempotencyKey !== DOCS_POLICY_KEY ||
    !isRecord(event.payload) ||
    event.payload.version !== 2 ||
    Object.keys(event.payload).length !== 1
  ) {
    fail(
      "Planning provisioning refuses a non-matching scheduler prefix: a new-policy run cannot recover against a legacy or foreign prefix.",
    );
  }
}

function assertProvisioningInitEvent(
  event: SchedulerEvent,
  spec: { readonly runId: string; readonly objective?: string },
): void {
  if (
    event.runId !== spec.runId ||
    event.sequence !== 2 ||
    event.type !== "run.initialized" ||
    event.actor.role !== "runner" ||
    event.actor.id !== "build-runtime" ||
    event.idempotencyKey !== RUN_INITIALIZED_KEY ||
    !isRecord(event.payload)
  ) {
    fail("Planning provisioning refuses a non-matching scheduler prefix.");
  }
  const payload = event.payload as Record<string, unknown>;
  const keys = Object.keys(payload).filter((key) => key !== "testIntegrityPolicyVersion" && key !== "submissionScopePolicyVersion" && key !== "reviewIntegrityPolicyVersion");
  if (payload.reviewIntegrityPolicyVersion !== undefined && payload.reviewIntegrityPolicyVersion !== 1) fail("Planning provisioning refuses an unsupported review-integrity policy version.");
  if (payload.submissionScopePolicyVersion !== undefined && payload.submissionScopePolicyVersion !== 1) {
    fail("Planning provisioning refuses an unsupported submission-scope policy version.");
  }
  if (payload.testIntegrityPolicyVersion !== undefined && payload.testIntegrityPolicyVersion !== 1) {
    fail("Planning provisioning refuses an unsupported test-integrity policy version.");
  }
  if (spec.objective !== undefined) {
    if (keys.length !== 1 || payload.objective !== spec.objective || typeof payload.objective !== "string") {
      fail("Planning provisioning refuses a scheduler prefix for a different objective.");
    }
  } else if (keys.length !== 0) {
    fail("Planning provisioning refuses a scheduler prefix carrying an objective the saved request does not have.");
  }
}

function assertProvisioningPlanningEvent(event: SchedulerEvent, runId: string): void {
  if (
    event.runId !== runId ||
    event.sequence !== 3 ||
    event.type !== "planning.policy_configured" ||
    event.actor.role !== "runner" ||
    event.actor.id !== "build-runtime" ||
    event.idempotencyKey !== PLANNING_POLICY_KEY ||
    !isRecord(event.payload) ||
    event.payload.version !== 1 ||
    Object.keys(event.payload).length !== 1
  ) {
    fail("Planning provisioning refuses a non-matching scheduler prefix.");
  }
}

/**
 * Idempotent registration of the kernel-approved source, after the matching
 * planning prefix is established. The event carries a deterministic
 * idempotency key tied to the manifest identity: an exact repeat reuses the
 * recorded registration (verified), while a conflicting manifest is refused —
 * there is no second initial registration (amendments are a later control).
 * Callers must have verified the stored artifact bytes first.
 */
export function registerApprovedSource(
  store: ProvisioningSchedulerStore,
  runId: string,
  manifest: ApprovedSourceManifest,
  approvedBy: string = T7A_APPROVED_SOURCE_ACTOR_ID,
): { mode: "registered" | "reused" } {
  const validation = validateApprovedSourceManifest(manifest);
  if (!validation.valid) {
    fail(
      `Approved source manifest is invalid: ${validation.issues.map((issue) => issue.code).join(", ")}.`,
    );
  }
  if (manifest.amendment) {
    fail("The first source registration cannot be an amendment.");
  }
  const authorityId = parseApprovedSourceAuthority(manifest.authority, manifest.manifestId);
  if (approvedBy !== authorityId) {
    fail(
      `Planning source registration actor ${approvedBy} does not match the manifest approval authority ${manifest.authority}; approval is never manufactured on recovery.`,
    );
  }
  const expectedKey = `source-registered:${manifest.manifestId}`;
  const existing = store
    .readRun(runId)
    .filter((event) => event.type === "planning.source_registered");
  if (existing.length > 0) {
    if (existing.length > 1) fail("Planning source cannot be registered twice.");
    const recorded = (existing[0]!.payload as Record<string, unknown>).manifest;
    if (
      existing[0]!.actor.role !== "user" ||
      existing[0]!.actor.id !== authorityId ||
      existing[0]!.idempotencyKey !== expectedKey ||
      JSON.stringify(recorded) !== JSON.stringify(manifest)
    ) {
      fail("Planning source cannot be registered twice.");
    }
    return { mode: "reused" };
  }
  store.append({
    runId,
    type: "planning.source_registered",
    occurredAt: manifest.createdAt,
    actor: { role: "user", id: authorityId },
    idempotencyKey: expectedKey,
    payload: { manifest: JSON.parse(JSON.stringify(manifest)) as Record<string, unknown> },
  });
  return { mode: "registered" };
}

/**
 * Fail-closed validation of the typed preparation seam itself: unknown
 * option keys are refused and the approver name is validated before any
 * capability, artifact, or save effect.
 */
export function validateProvisioningPrepareOptions(
  options: ProvisioningPrepareOptions | undefined,
): void {
  if (options === undefined) return;
  for (const key of Object.keys(options)) {
    if (key !== "approvedSourceInput" && key !== "approvedBy") {
      throw new Error(`Provisioning preparation has an unknown option: ${key}.`);
    }
  }
  if (options.approvedBy !== undefined) validateApproverName(options.approvedBy);
}

/**
 * Typed preparation seam for first creation. Carries request-only
 * approved-source bytes/intent plus the authenticated approver — never a
 * caller-chosen manifest, digest, or authority.
 */
export interface ProvisioningPrepareOptions {
  readonly approvedSourceInput?: ApprovedSourceInputV1;
  readonly approvedBy?: string;
}

/**
 * Reads the authenticated approver back out of a kernel manifest authority
 * (`user:<id>`). Never accepts an external actor field as trusted.
 */
export function approvedSourceApprover(manifest: ApprovedSourceManifest): string {
  return parseApprovedSourceAuthority(manifest.authority, manifest.manifestId);
}

export interface StableProvisioningRequest {
  readonly runId: string;
  readonly projectId: string;
  readonly objective: string;
  readonly architectRuntimeId: string;
  readonly workerRuntimeIds: readonly string[];
  readonly verifierRuntimeIds: readonly string[];
  readonly alwaysRequireIndependentVerifier: boolean;
  readonly repairPlanLimit: number | null;
  readonly maxConcurrency: number;
  readonly permissionProfile: string;
  readonly runPolicy: string;
  readonly specCopy: boolean;
  readonly answerReview: boolean;
  readonly handoffFiles: string;
  readonly contextRecording: string | null;
  readonly planCritique: string | null;
  readonly verifierTwoPass: boolean | null;
  readonly budgetLimits: string;
  readonly planningPolicy: number | null;
  readonly benchmark: string | null;
  readonly idempotencyKey: string;
  readonly source: null | {
    readonly approval: "approved_spec";
    readonly mediaType: string;
    readonly encoding: string;
    readonly artifactDigest: string;
    readonly sections: readonly {
      readonly id: string;
      readonly title?: string;
      readonly startByte: number;
      readonly endByte: number;
    }[];
  };
}

/**
 * The persisted-or-reconstructible canonical identity of an original creation
 * request. Kernel-owned generated fields (createdAt clock, capability
 * contract) are excluded: retry reuses the saved authority rather than
 * regenerating it. Missing stable optionals compare under effective defaults,
 * never under today's defaults.
 */
export function stableProvisioningRequestIdentity(
  spec: NativeBuildSpec,
  sourceInput?: ApprovedSourceInputV1,
): StableProvisioningRequest {
  let source: StableProvisioningRequest["source"] = null;
  if (sourceInput !== undefined) {
    const validated = validateApprovedSourceInput(sourceInput);
    source = {
      approval: "approved_spec",
      mediaType: validated.mediaType,
      encoding: validated.encoding,
      artifactDigest: computeArtifactDigest(validated.bytes),
      sections: validated.sections.map((section) => ({ ...section })),
    };
  } else if (spec.approvedSource !== undefined) {
    source = {
      approval: "approved_spec",
      mediaType: spec.approvedSource.mediaType,
      encoding: spec.approvedSource.encoding,
      artifactDigest: spec.approvedSource.artifactDigest,
      sections: spec.approvedSource.sections.map((section) => ({
        id: section.id,
        ...(section.title !== undefined ? { title: section.title } : {}),
        startByte: section.startByte,
        endByte: section.endByte,
      })),
    };
  }
  return {
    runId: spec.runId,
    projectId: spec.projectId,
    objective: spec.objective,
    architectRuntimeId: spec.architectRuntimeId,
    workerRuntimeIds: [...spec.workerRuntimeIds],
    verifierRuntimeIds: [...spec.verifierRuntimeIds],
    alwaysRequireIndependentVerifier: spec.alwaysRequireIndependentVerifier,
    repairPlanLimit: spec.repairPlanLimit ?? null,
    maxConcurrency: spec.maxConcurrency,
    permissionProfile: spec.permissionProfile,
    runPolicy: spec.runPolicy,
    specCopy: spec.specCopy ?? true,
    answerReview: spec.answerReview === true,
    handoffFiles: spec.handoffFiles ?? "commit",
    contextRecording: spec.contextRecording ?? null,
    planCritique: spec.planCritique ?? null,
    verifierTwoPass: spec.verifierTwoPass ?? null,
    budgetLimits: JSON.stringify(spec.budgetLimits),
    planningPolicy: spec.planningPolicy?.version ?? null,
    benchmark: spec.benchmark ? JSON.stringify(spec.benchmark) : null,
    idempotencyKey: spec.idempotencyKey,
    source,
  };
}

/**
 * Exact-match retry check for an existing saved run: the saved authority
 * governs, so a byte-identical repeat reuses it while any changed request
 * (including a newly added policy default or a different source) conflicts
 * before any effect. Never adds today's defaults to an old saved run.
 */
export function stableProvisioningRequestsMatch(
  saved: NativeBuildSpec,
  candidate: NativeBuildSpec,
  candidateSourceInput?: ApprovedSourceInputV1,
): boolean {
  const left = stableProvisioningRequestIdentity(saved);
  const right = stableProvisioningRequestIdentity(candidate, candidateSourceInput);
  return JSON.stringify(left) === JSON.stringify(right);
}
