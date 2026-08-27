import type { ArtifactStore } from "./artifact-store.js";
import type {
  CapabilityRegistry,
  RegisteredExtensionTool,
} from "./capability-registry.js";
import type {
  ContextAssembler,
  ContextPack,
  ContextSection,
} from "./context-assembler.js";
import type {
  RunnerExtensionContextContribution,
  RunnerExtensionContextContributor,
  RunnerExtensionContextRequest,
} from "./runner-extension.js";
import type { ToolBroker } from "./tool-broker.js";

const DEFAULT_CONTRIBUTOR_TIMEOUT_MS = 5_000;
const SHA256 = /^[a-f0-9]{64}$/;
const CONTRIBUTION_KEYS = new Set(["content", "sourceDigest", "artifactHash"]);

export type ExtensionContextContributionStatus =
  | "included"
  | "omitted"
  | "rejected"
  | "empty";

export type ExtensionContextContributionReason =
  | "byte_budget"
  | "token_budget"
  | "no_contribution"
  | "contributor_byte_limit"
  | "invalid_contribution"
  | "invalid_source_digest"
  | "invalid_artifact_hash"
  | "artifact_store_unavailable"
  | "artifact_not_found_or_invalid"
  | "timeout"
  | "contributor_error";

export interface ExtensionContextContributionRecord {
  extensionId: string;
  contributorId: string;
  sectionId: string;
  status: ExtensionContextContributionStatus;
  reason?: ExtensionContextContributionReason;
  byteLength?: number;
  sourceDigest?: string;
  artifactHash?: string;
}

export interface ExtensionContextAssembly {
  pack: ContextPack;
  contributions: ExtensionContextContributionRecord[];
}

export interface AssembleContextWithExtensionsOptions {
  registry: CapabilityRegistry;
  assembler: ContextAssembler;
  baseSections: readonly ContextSection[];
  request: RunnerExtensionContextRequest;
  artifacts?: ArtifactStore;
  contributorTimeoutMs?: number;
}

export interface RegisterExtensionCapabilitiesOptions {
  includeTool?(registration: RegisteredExtensionTool): boolean;
}

interface PendingContribution {
  extensionId: string;
  contributorId: string;
  section: ContextSection;
}

class ExtensionContextTimeoutError extends Error {}

export function registerExtensionCapabilities(
  registry: CapabilityRegistry,
  broker: ToolBroker,
  options: RegisterExtensionCapabilitiesOptions = {},
): void {
  const registrations = registry.tools().filter((registration) =>
    options.includeTool?.(registration) ?? true,
  );
  const names = new Set(broker.definitions().map((definition) => definition.name));
  for (const registration of registrations) {
    const name = registration.tool.definition.name;
    if (names.has(name)) {
      throw new Error(`Extension ${registration.extensionId} tool ${name} conflicts with a registered tool.`);
    }
    names.add(name);
  }
  for (const registration of registrations) {
    broker.registerExtensionTool(registration.extensionId, registration.tool);
  }
}

export async function assembleContextWithExtensions(
  options: AssembleContextWithExtensionsOptions,
): Promise<ExtensionContextAssembly> {
  const timeoutMs = options.contributorTimeoutMs ?? DEFAULT_CONTRIBUTOR_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("contributorTimeoutMs must be a positive integer.");
  }
  throwIfAborted(options.request.signal);

  const slots: Array<ExtensionContextContributionRecord | PendingContribution> = [];
  const sections: ContextSection[] = [];
  for (const registration of options.registry.contextContributors()) {
    throwIfAborted(options.request.signal);
    const sectionId = extensionSectionId(
      registration.extensionId,
      registration.contributor.id,
    );
    const contribution = await invokeContributor(
      registration.contributor,
      options.request,
      timeoutMs,
    );
    throwIfAborted(options.request.signal);
    if (contribution.status === "error") {
      slots.push({
        extensionId: registration.extensionId,
        contributorId: registration.contributor.id,
        sectionId,
        status: "rejected",
        reason: contribution.reason,
      });
      continue;
    }
    if (contribution.value === null) {
      slots.push({
        extensionId: registration.extensionId,
        contributorId: registration.contributor.id,
        sectionId,
        status: "empty",
        reason: "no_contribution",
      });
      continue;
    }
    let validated: Awaited<ReturnType<typeof validateContribution>>;
    try {
      validated = await validateContribution(
        contribution.value,
        registration.contributor,
        options.artifacts,
      );
    } catch {
      slots.push({
        extensionId: registration.extensionId,
        contributorId: registration.contributor.id,
        sectionId,
        status: "rejected",
        reason: "contributor_error",
      });
      continue;
    }
    if (!validated.ok) {
      slots.push({
        extensionId: registration.extensionId,
        contributorId: registration.contributor.id,
        sectionId,
        status: "rejected",
        reason: validated.reason,
      });
      continue;
    }
    const section: ContextSection = {
      id: sectionId,
      kind: `extension.${registration.extensionId}.${registration.contributor.kind}`,
      required: false,
      priority: registration.contributor.priority,
      content: validated.value.content,
      ...(validated.value.sourceDigest
        ? { sourceDigest: validated.value.sourceDigest }
        : {}),
      ...(validated.value.artifactHash
        ? { artifactHash: validated.value.artifactHash }
        : {}),
    };
    sections.push(section);
    slots.push({
      extensionId: registration.extensionId,
      contributorId: registration.contributor.id,
      section,
    });
  }

  const pack = options.assembler.assemble([
    ...options.baseSections,
    ...sections,
  ]);
  const included = new Set(pack.sections.map((section) => section.id));
  const omissions = new Map(pack.omissions.map((omission) => [omission.id, omission]));
  const contributions = slots.map((slot): ExtensionContextContributionRecord => {
    if ("status" in slot) return Object.freeze({ ...slot });
    const omission = omissions.get(slot.section.id);
    return Object.freeze({
      extensionId: slot.extensionId,
      contributorId: slot.contributorId,
      sectionId: slot.section.id,
      status: included.has(slot.section.id) ? "included" : "omitted",
      ...(!included.has(slot.section.id) && omission
        ? { reason: omission.reason }
        : {}),
      byteLength: Buffer.byteLength(slot.section.content),
      ...(slot.section.sourceDigest
        ? { sourceDigest: slot.section.sourceDigest }
        : {}),
      ...(slot.section.artifactHash
        ? { artifactHash: slot.section.artifactHash }
        : {}),
    });
  });
  return { pack, contributions };
}

async function invokeContributor(
  contributor: RunnerExtensionContextContributor,
  request: RunnerExtensionContextRequest,
  timeoutMs: number,
): Promise<
  | { status: "ok"; value: unknown }
  | {
      status: "error";
      reason: "timeout" | "contributor_error";
    }
> {
  const timeoutController = new AbortController();
  const signal = AbortSignal.any([request.signal, timeoutController.signal]);
  const frozenRequest = Object.freeze({
    ...request,
    actor: Object.freeze({ ...request.actor }),
    signal,
  });
  let timeout: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const cancellation = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(request.signal.reason ?? new Error("Context assembly was cancelled."));
      request.signal.addEventListener("abort", onAbort, { once: true });
    });
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new ExtensionContextTimeoutError());
        timeoutController.abort(new ExtensionContextTimeoutError());
      }, timeoutMs);
    });
    const value = await Promise.race([
      Promise.resolve().then(() => contributor.contribute(frozenRequest)),
      cancellation,
      deadline,
    ]);
    throwIfAborted(request.signal);
    return { status: "ok", value };
  } catch (error) {
    if (request.signal.aborted) throw request.signal.reason ?? error;
    return {
      status: "error",
      reason: error instanceof ExtensionContextTimeoutError
        ? "timeout"
        : "contributor_error",
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    if (onAbort) request.signal.removeEventListener("abort", onAbort);
  }
}

async function validateContribution(
  input: unknown,
  contributor: RunnerExtensionContextContributor,
  artifacts?: ArtifactStore,
): Promise<
  | { ok: true; value: RunnerExtensionContextContribution }
  | { ok: false; reason: ExtensionContextContributionReason }
> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, reason: "invalid_contribution" };
  }
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !CONTRIBUTION_KEYS.has(key))) {
    return { ok: false, reason: "invalid_contribution" };
  }
  if (typeof value.content !== "string" || value.content.length === 0) {
    return { ok: false, reason: "invalid_contribution" };
  }
  if (Buffer.byteLength(value.content) > contributor.maxBytes) {
    return { ok: false, reason: "contributor_byte_limit" };
  }
  if (
    value.sourceDigest !== undefined &&
    (typeof value.sourceDigest !== "string" || !SHA256.test(value.sourceDigest))
  ) {
    return { ok: false, reason: "invalid_source_digest" };
  }
  if (
    value.artifactHash !== undefined &&
    (typeof value.artifactHash !== "string" || !SHA256.test(value.artifactHash))
  ) {
    return { ok: false, reason: "invalid_artifact_hash" };
  }
  if (value.artifactHash !== undefined) {
    if (!artifacts) return { ok: false, reason: "artifact_store_unavailable" };
    try {
      await artifacts.verify(value.artifactHash as string);
    } catch {
      return { ok: false, reason: "artifact_not_found_or_invalid" };
    }
  }
  return {
    ok: true,
    value: {
      content: value.content,
      ...(typeof value.sourceDigest === "string"
        ? { sourceDigest: value.sourceDigest }
        : {}),
      ...(typeof value.artifactHash === "string"
        ? { artifactHash: value.artifactHash }
        : {}),
    },
  };
}

function extensionSectionId(extensionId: string, contributorId: string): string {
  return `extension:${extensionId}:${contributorId}`;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new Error("Context assembly was cancelled.");
  }
}
