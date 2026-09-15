import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { PermissionProfile } from "./contracts.js";
import type { ExecutionHost, ExecutionHostRunBinding } from "./execution-host.js";
import { captureGitBaseline, type GitBaseline } from "./git-baseline.js";
import type { RunnerCapabilitiesConfig } from "./runner-capabilities-config.js";
import { createRunnerCapabilityContract } from "./runner-capability-contract.js";
import { runnerRunStateSegment } from "./run-state-identity.js";

/** A real run already exists at this boundary. This is not pre-run authority.
 * The temporary bootstrap binding must close before the active factory takes
 * the same run identity; its exact durable history remains recoverable.
 */
export async function captureRunGitBaseline(input: Readonly<{
  host: ExecutionHost;
  projectPath: string;
  stateDirectory: string;
  runId: string;
  permissionProfile: PermissionProfile;
  capabilitiesConfig: RunnerCapabilitiesConfig;
}>): Promise<GitBaseline> {
  const capabilityContract = await createRunnerCapabilityContract(input.capabilitiesConfig, { commandSearchDirectory: input.projectPath });
  let binding: ExecutionHostRunBinding | undefined;
  let failed = false; let primary: unknown; let result: GitBaseline | undefined;
  try {
    binding = await input.host.bindRun({ runId: input.runId, permissionProfile: input.permissionProfile,
      capabilityContract, capabilitiesConfig: input.capabilitiesConfig });
    const indexRoot = join(input.stateDirectory, "git-baselines", runnerRunStateSegment(input.runId));
    await mkdir(indexRoot, { recursive: true });
    result = await captureGitBaseline({ projectPath: input.projectPath, stateDirectory: indexRoot,
      runId: input.runId, execute: binding.git.lifecycle("baseline").run,
      filesystemAuthorization: { authority: binding.executionGrants, permissionProfile: input.permissionProfile } });
  } catch (error) { failed = true; primary = error; }
  try { await binding?.close(); }
  catch (cleanup) { throw new AggregateError(failed ? [primary, cleanup] : [cleanup], "Git baseline ownership cleanup remains unverified."); }
  if (failed) throw primary;
  return result!;
}
