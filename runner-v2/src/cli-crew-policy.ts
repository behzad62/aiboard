/**
 * CLI workers' crew rules that need no host facts (docs/plans/2026-11-14-cli-workers.md §3.12, §3.13, packet CW4).
 *
 * Pure and import-free: the web imports this module (lib/client/native-build-policy.ts), as it does
 * budget-enforceability.ts.
 * The Runner applies the same rules with its configs' `transport: "cli"` (cli-worker-crew.ts), and adds the
 * per-OS and root refusals, which need host facts.
 */

/** cli-worker-config.ts `CLI_WORKER_PROVIDER_IDS`; a test pins the two lists together. */
export const CLI_CREW_PROVIDER_IDS: readonly string[] = Object.freeze(["codex-cli", "claude-code", "agy"]);

/** A CLI runtime named as Architect, reviewer or verifier: CLI runtimes are workers only (§3.13). */
export const CLI_RUNTIME_ROLE_REFUSED = "cli_runtime_role_refused";
/** A Build whose crew has a CLI worker starts only under the `full` permission profile (§3.12, OD-36). */
export const CLI_WORKERS_REQUIRE_FULL_ACCESS = "cli_workers_require_full_access";

export type CliCrewPolicyRefusalCode = typeof CLI_RUNTIME_ROLE_REFUSED | typeof CLI_WORKERS_REQUIRE_FULL_ACCESS;

export interface CliCrewPolicyRefusal {
  code: CliCrewPolicyRefusalCode;
  message: string;
  runtimeId: string;
  /** For `cli_runtime_role_refused`: the role the CLI runtime was named for. */
  role?: "architect" | "reviewer" | "verifier";
}

export interface CliCrewPolicyInput {
  architectRuntimeId: string;
  reviewerRuntimeId?: string | null;
  workerRuntimeIds: readonly string[];
  verifierRuntimeIds: readonly string[];
  permissionProfile: "guarded" | "project" | "full";
}

/**
 * Whether a runtime id names a CLI worker. A CLI runtime is always `<providerId>:<model or "default">` (CW1's
 * validator refuses any other name), so the web can tell one apart before the Runner has its config.
 */
export function isCliRuntimeId(runtimeId: string): boolean {
  const separator = runtimeId.indexOf(":");
  return separator > 0 && CLI_CREW_PROVIDER_IDS.includes(runtimeId.slice(0, separator));
}

/**
 * The first rule a crew breaks, or null. `isCliRuntime` says which runtimes are CLI workers: the Runner reads it
 * from each config's transport, the web from the runtime id.
 * - The Architect, the reviewer and every verifier must be API models: a CLI cannot run AIBoard's own tool loop.
 * - A crew with a CLI worker needs Full access: the CLI runs with its own permission prompts turned off.
 */
export function nativeBuildCliCrewRefusal(
  crew: CliCrewPolicyInput,
  isCliRuntime: (runtimeId: string) => boolean = isCliRuntimeId,
): CliCrewPolicyRefusal | null {
  const roles: { role: "architect" | "reviewer" | "verifier"; runtimeIds: readonly string[] }[] = [
    { role: "architect", runtimeIds: [crew.architectRuntimeId] },
    { role: "reviewer", runtimeIds: crew.reviewerRuntimeId ? [crew.reviewerRuntimeId] : [] },
    { role: "verifier", runtimeIds: crew.verifierRuntimeIds },
  ];
  for (const { role, runtimeIds } of roles) {
    const runtimeId = runtimeIds.find(isCliRuntime);
    if (runtimeId !== undefined) {
      return {
        code: CLI_RUNTIME_ROLE_REFUSED,
        role,
        runtimeId,
        message: `${runtimeId} is a CLI worker and cannot be ${role === "verifier" ? "a verifier" : `the ${role === "architect" ? "Architect" : "reviewer"}`}: CLI runtimes are workers only.`,
      };
    }
  }
  const cliWorker = crew.workerRuntimeIds.find(isCliRuntime);
  if (cliWorker !== undefined && crew.permissionProfile !== "full") {
    return {
      code: CLI_WORKERS_REQUIRE_FULL_ACCESS,
      runtimeId: cliWorker,
      message: `${cliWorker} is a CLI worker, and CLI workers need Full access: the CLI runs any command as you, with its own permission prompts turned off. This Build's access is ${crew.permissionProfile === "project" ? "Project" : "Guarded"}.`,
    };
  }
  return null;
}
