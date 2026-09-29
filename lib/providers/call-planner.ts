import { getProviderCapabilityManifest } from "./capability-manifests";
import { resolveProviderCapabilityProfile } from "./capability-resolution";
import {
  ProviderCallPlanError,
  type CapabilityDecision,
  type NormalizedToolChoice,
  type ProviderCallPlan,
  type ProviderRuntimeContext,
  type ProviderTransportId,
  type ResolvedTool,
  type ToolCapabilityDescriptor,
  type ToolIntent,
  type ToolCombinationConstraint,
} from "./tool-capabilities";

export interface ResolveProviderCallPlanInput {
  context: ProviderRuntimeContext;
  requestedTools: ToolIntent[];
}

interface EvaluatedIntent {
  intent: ToolIntent;
  descriptor?: ToolCapabilityDescriptor;
  readiness?: ResolvedTool["readiness"];
  baseDecision?: CapabilityDecision;
  dedupeDecision?: CapabilityDecision;
}

interface TransportEvaluation {
  transport: ProviderTransportId;
  enabledTools: ResolvedTool[];
  optionalDecisions: CapabilityDecision[];
  requiredDecisions: CapabilityDecision[];
  traceDecisions: CapabilityDecision[];
}

function normalizeToolChoice(context: ProviderRuntimeContext): NormalizedToolChoice {
  return context.features.toolChoice ?? "auto";
}

function partitionEvidence(context: ProviderRuntimeContext) {
  const evidence = context.evidence ?? [];
  return {
    catalogEvidence: evidence.filter((item) => item.source === "provider-catalog"),
    runnerEvidence: evidence.filter((item) => item.source === "runner"),
  };
}

function decisionForResolvedIntent(
  context: ProviderRuntimeContext,
  intent: ToolIntent,
  descriptor: ToolCapabilityDescriptor | undefined,
  readiness: ResolvedTool["readiness"] | undefined,
  missingPrerequisiteIds: string[] = [],
): CapabilityDecision | undefined {
  if (!descriptor) {
    return {
      capabilityId: intent.id,
      code: "unsupported",
      reason: `${intent.id} is not declared by ${context.providerId}.`,
    };
  }

  if (descriptor.support === "unsupported" || readiness === "unsupported") {
    return {
      capabilityId: intent.id,
      code: "unsupported",
      reason: `${intent.id} is unsupported for ${context.providerId}:${context.modelId}.`,
    };
  }
  if (descriptor.support === "unknown" || readiness === "unknown") {
    return {
      capabilityId: intent.id,
      code: "unknown",
      reason: `${intent.id} support is not verified for ${context.providerId}:${context.modelId}.`,
    };
  }
  if (descriptor.support === "conditional" || readiness === "conditional") {
    return {
      capabilityId: intent.id,
      code: "conditional_unverified",
      reason: `${intent.id} remains conditional until provider/model/runner evidence verifies it.`,
    };
  }
  if (readiness === "setup_required") {
    const prerequisiteId = missingPrerequisiteIds[0];
    return {
      capabilityId: intent.id,
      code: "missing_prerequisite",
      reason: prerequisiteId
        ? `${intent.id} requires configured prerequisite ${prerequisiteId}.`
        : `${intent.id} requires additional runtime setup.`,
      ...(prerequisiteId ? { prerequisiteId } : {}),
    };
  }
  return undefined;
}

function featureIsActive(
  context: ProviderRuntimeContext,
  constraint: ToolCombinationConstraint,
): boolean {
  switch (constraint.when) {
    case "structured_output":
      return context.features.structuredOutput === true;
    case "reasoning":
      return context.features.reasoning === true;
    case "attachments":
      return context.features.attachments === true;
    case "parallel_tools":
      return context.features.parallelTools === true;
  }
}

function toolChoiceMatches(value: string | undefined, choice: NormalizedToolChoice): boolean {
  if (!value) return true;
  if (value === "auto" || value === "none" || value === "required") {
    return choice === value;
  }
  if (value === "named") return typeof choice === "object";
  return typeof choice === "object" && choice.name === value;
}

function constraintDecision(
  context: ProviderRuntimeContext,
  descriptor: ToolCapabilityDescriptor,
  transport: ProviderTransportId,
  constraint: ToolCombinationConstraint,
  toolChoice: NormalizedToolChoice,
): CapabilityDecision | undefined {
  if (!featureIsActive(context, constraint)) return undefined;

  if (constraint.effect === "forbid") {
    return {
      capabilityId: descriptor.id,
      code: "combination_forbidden",
      reason: constraint.reason,
      transport,
    };
  }
  if (
    constraint.effect === "requires_transport" &&
    constraint.value !== undefined &&
    constraint.value !== transport
  ) {
    return {
      capabilityId: descriptor.id,
      code: "transport_incompatible",
      reason: constraint.reason,
      transport,
    };
  }
  if (
    constraint.effect === "requires_tool_choice" &&
    !toolChoiceMatches(constraint.value, toolChoice)
  ) {
    return {
      capabilityId: descriptor.id,
      code: "combination_forbidden",
      reason: constraint.reason,
      transport,
    };
  }
  return undefined;
}

function mcpSourceId(intent: ToolIntent): string | undefined {
  const value = intent.parameters?.mcpSourceId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function applyMcpDedupe(items: EvaluatedIntent[]): void {
  const groups = new Map<string, EvaluatedIntent[]>();
  for (const item of items) {
    const sourceId = mcpSourceId(item.intent);
    if (!sourceId || item.baseDecision) continue;
    const group = groups.get(sourceId) ?? [];
    group.push(item);
    groups.set(sourceId, group);
  }

  for (const [sourceId, group] of groups) {
    if (group.length < 2) continue;
    const requiredItems = group.filter((item) => item.intent.requirement === "required");
    const candidates = requiredItems.length > 0 ? requiredItems : group;
    const selected =
      candidates.find((item) => item.intent.id === "remote_mcp") ?? candidates[0];
    for (const item of group) {
      if (item === selected) continue;
      item.dedupeDecision = {
        capabilityId: item.intent.id,
        code: "duplicate_mcp_path",
        reason: `MCP source ${sourceId} is already exposed through ${selected.intent.id}.`,
      };
    }
  }
}

function evaluateTransport(
  context: ProviderRuntimeContext,
  transport: ProviderTransportId,
  items: EvaluatedIntent[],
  toolChoice: NormalizedToolChoice,
  manifestConstraints: readonly ToolCombinationConstraint[],
): TransportEvaluation {
  const enabledTools: ResolvedTool[] = [];
  const optionalDecisions: CapabilityDecision[] = [];
  const requiredDecisions: CapabilityDecision[] = [];
  const traceDecisions: CapabilityDecision[] = [];

  for (const item of items) {
    let decision = item.baseDecision ?? item.dedupeDecision;
    const descriptor = item.descriptor;

    if (!decision && toolChoice === "none") {
      decision = {
        capabilityId: item.intent.id,
        code: "combination_forbidden",
        reason: "Tool choice is none for this call.",
        transport,
      };
    }

    if (!decision && descriptor && !descriptor.transports.includes(transport)) {
      decision = {
        capabilityId: item.intent.id,
        code: "transport_incompatible",
        reason: `${item.intent.id} is not available on ${transport}.`,
        transport,
      };
    }

    if (!decision && descriptor) {
      for (const constraint of [
        ...(descriptor.constraints ?? []),
        ...manifestConstraints,
      ]) {
        decision = constraintDecision(
          context,
          descriptor,
          transport,
          constraint,
          toolChoice,
        );
        if (decision) break;
      }
    }

    if (decision) {
      traceDecisions.push(decision);
      if (item.intent.requirement === "required" && !item.dedupeDecision) {
        requiredDecisions.push(decision);
      } else {
        optionalDecisions.push(decision);
      }
      continue;
    }

    if (!descriptor || !item.readiness) continue;
    enabledTools.push({
      intent: item.intent,
      descriptor,
      transport,
      readiness: item.readiness,
    });
  }

  return {
    transport,
    enabledTools,
    optionalDecisions,
    requiredDecisions,
    traceDecisions,
  };
}

function pickTransport(evaluations: TransportEvaluation[]): TransportEvaluation {
  const compatible = evaluations.find((item) => item.requiredDecisions.length === 0);
  if (compatible) return compatible;
  return evaluations.reduce((best, current) =>
    current.requiredDecisions.length < best.requiredDecisions.length ? current : best,
  );
}

export function resolveProviderCallPlan(
  input: ResolveProviderCallPlanInput,
): ProviderCallPlan {
  const { context, requestedTools } = input;
  const manifest = getProviderCapabilityManifest(context.providerId);
  if (!manifest || manifest.transports.length === 0) {
    throw new ProviderCallPlanError(
      requestedTools
        .filter((intent) => intent.requirement === "required")
        .map((intent) => ({
          capabilityId: intent.id,
          code: "transport_incompatible" as const,
          reason: `No provider transport is registered for ${context.providerId}.`,
        })),
      `No provider transport is registered for ${context.providerId}`,
    );
  }

  const evidence = partitionEvidence(context);
  const profile = resolveProviderCapabilityProfile({
    providerId: context.providerId,
    modelId: context.modelId,
    catalogEvidence: evidence.catalogEvidence,
    runnerEvidence: evidence.runnerEvidence,
    resourceState: context.resourceState,
    customOverrides: context.customOverrides,
  });

  const items: EvaluatedIntent[] = requestedTools.map((intent) => {
    const resolved = profile.capabilities[intent.id];
    const descriptor = resolved?.descriptor;
    const readiness = resolved?.readiness.status;
    return {
      intent,
      descriptor,
      readiness,
      baseDecision: decisionForResolvedIntent(
        context,
        intent,
        descriptor,
        readiness,
        resolved?.readiness.missingPrerequisiteIds,
      ),
    };
  });

  const requiredBaseFailures = items
    .filter((item) => item.intent.requirement === "required" && item.baseDecision)
    .map((item) => item.baseDecision!);
  if (requiredBaseFailures.length > 0) {
    throw new ProviderCallPlanError(requiredBaseFailures);
  }

  applyMcpDedupe(items);
  const toolChoice = normalizeToolChoice(context);
  const evaluations = manifest.transports.map((transport) =>
    evaluateTransport(
      context,
      transport,
      items,
      toolChoice,
      manifest.transportConstraints ?? [],
    ),
  );
  const selected = pickTransport(evaluations);

  if (selected.requiredDecisions.length > 0) {
    throw new ProviderCallPlanError(selected.requiredDecisions);
  }

  const enabledIds = selected.enabledTools.map((tool) => tool.intent.id);
  return {
    transport: selected.transport,
    enabledTools: selected.enabledTools,
    omittedOptionalTools: selected.optionalDecisions,
    toolPolicyTrace: {
      requestedTools: requestedTools.map((intent) => ({
        ...intent,
        ...(intent.parameters ? { parameters: { ...intent.parameters } } : {}),
      })),
      enabledTools: enabledIds,
      omittedTools: selected.optionalDecisions,
      transport: selected.transport,
      decisions: selected.traceDecisions,
    },
    toolChoice,
    parallelToolCalls: context.features.parallelTools === true,
  };
}
