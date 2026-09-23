import type { PermissionProfile } from "./contracts.js";
import type { ExecutionLifecycleScope } from "./execution-safety-contracts.js";
import { createHash } from "node:crypto";

/** Trusted, closed lifecycle requirement flags. Never inferred from argv/model text. */
export type ExecutionLifecycleRequirements = Readonly<{
  readonly requireCompleteCleanup?: boolean;
  readonly knownUnavoidableDetachment?: boolean;
}>;

export interface ExecutionLifecyclePolicyInput {
  readonly permissionProfile: PermissionProfile;
  readonly lifecycleRequirements?: ExecutionLifecycleRequirements;
}

/** Freeze only explicitly true flags; omit empty objects so omission stays representable. */
export function freezeExecutionLifecycleRequirements(
  value: ExecutionLifecycleRequirements | undefined,
): ExecutionLifecycleRequirements | undefined {
  if (value === undefined) return undefined;
  const requireCompleteCleanup = value.requireCompleteCleanup === true;
  const knownUnavoidableDetachment = value.knownUnavoidableDetachment === true;
  if (!requireCompleteCleanup && !knownUnavoidableDetachment) return undefined;
  return Object.freeze({
    ...(requireCompleteCleanup ? { requireCompleteCleanup: true as const } : {}),
    ...(knownUnavoidableDetachment ? { knownUnavoidableDetachment: true as const } : {}),
  });
}

/** Exact identity for optional trusted lifecycle requirements bound into descriptors. */
export function lifecycleRequirementsDigest(
  value: ExecutionLifecycleRequirements | undefined,
): string {
  const frozen = freezeExecutionLifecycleRequirements(value);
  return createHash("sha256")
    .update(JSON.stringify({
      requireCompleteCleanup: frozen?.requireCompleteCleanup === true,
      knownUnavoidableDetachment: frozen?.knownUnavoidableDetachment === true,
    }))
    .digest("hex");
}

/** Central policy for the workload boundary requested before provider/backend selection. */
export function resolveRequiredLifecycleScope(
  input: ExecutionLifecyclePolicyInput,
): ExecutionLifecycleScope {
  const requirements = freezeExecutionLifecycleRequirements(input.lifecycleRequirements);
  return input.permissionProfile !== "full" ||
    requirements?.requireCompleteCleanup === true ||
    requirements?.knownUnavoidableDetachment === true
    ? "contained_workload"
    : "process_group";
}
