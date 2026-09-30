import type {
  ResolvedCapabilityEntry,
  ResolvedCapabilityProfile,
} from "./capability-resolution";
import type {
  CapabilityPrerequisite,
  ProviderTransportId,
  ToolReadinessStatus,
} from "./tool-capabilities";

export type ProviderCapabilityStatusLabel =
  | "Available now"
  | "Supported — setup required"
  | "Conditional / not yet verified"
  | "Unsupported";

export interface ProviderCapabilityStatusRow {
  capabilityId: string;
  statusLabel: ProviderCapabilityStatusLabel;
  readiness: ToolReadinessStatus;
  supportSource: ResolvedCapabilityEntry["descriptor"]["supportSource"];
  execution: ResolvedCapabilityEntry["descriptor"]["execution"];
  transports: ProviderTransportId[];
  missingPrerequisites: Array<CapabilityPrerequisite & { reason?: string }>;
  verifiedAt?: string;
  detail?: string;
}

export function capabilityStatusView(input: {
  readiness: ToolReadinessStatus;
}): { label: ProviderCapabilityStatusLabel } {
  switch (input.readiness) {
    case "available":
      return { label: "Available now" };
    case "setup_required":
      return { label: "Supported — setup required" };
    case "unsupported":
      return { label: "Unsupported" };
    case "conditional":
    case "unknown":
      return { label: "Conditional / not yet verified" };
  }
}

export function capabilityStatusRows(
  profile: ResolvedCapabilityProfile,
  options: { allowedTransports?: readonly ProviderTransportId[] } = {},
): ProviderCapabilityStatusRow[] {
  return Object.entries(profile.capabilities)
    .map(([capabilityId, entry]) => {
      const missing = new Set(entry.readiness.missingPrerequisiteIds);
      const transportCompatible =
        options.allowedTransports === undefined ||
        entry.descriptor.transports.some((transport) =>
          options.allowedTransports!.includes(transport),
        );
      const readiness: ToolReadinessStatus =
        entry.readiness.status === "available" && !transportCompatible
          ? "setup_required"
          : entry.readiness.status;
      return {
        capabilityId,
        statusLabel: capabilityStatusView({ readiness }).label,
        readiness,
        supportSource: entry.descriptor.supportSource,
        execution: entry.descriptor.execution,
        transports: [...entry.descriptor.transports],
        missingPrerequisites: (entry.descriptor.prerequisites ?? [])
          .filter((item) => missing.has(item.id))
          .map((item) => ({
            ...item,
            ...(profile.resourceState?.prerequisites[item.id]?.reason
              ? { reason: profile.resourceState.prerequisites[item.id].reason }
              : {}),
          })),
        ...(entry.descriptor.verifiedAt ? { verifiedAt: entry.descriptor.verifiedAt } : {}),
        ...(!transportCompatible
          ? {
              detail: `No compatible transport is currently enabled. Allowed transports: ${options.allowedTransports?.join(", ") ?? "none"}.`,
            }
          : {}),
      } satisfies ProviderCapabilityStatusRow;
    })
    .sort((a, b) => a.capabilityId.localeCompare(b.capabilityId));
}