/**
 * CLI workers' names for display (docs/plans/2026-11-14-cli-workers.md §3.1). CLI providers are not in
 * MODEL_CATALOG or the provider registry: they are Build workers only, never chat models. Pure.
 */
import { isCliRuntimeId } from "@/runner-v2/src/cli-crew-policy";

/** runner-v2/src/cli-worker-adapters.ts `CLI_WORKER_DISPLAY_NAMES`; scripts/test-cli-workers-ui.mts pins them equal. */
export const CLI_WORKER_DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  "codex-cli": "Codex CLI",
  "claude-code": "Claude Code",
  agy: "agy",
});

/** The runtime id's model part for "CLI default" (runner-v2/src/cli-worker-config.ts `CLI_DEFAULT_MODEL_ID`). */
export const CLI_DEFAULT_MODEL_ID = "default";

/** `claude-code:default` → "Claude Code · CLI default"; `codex-cli:gpt-6-codex` → "Codex CLI · gpt-6-codex". */
export function cliRuntimeDisplayName(runtimeId: string): string | null {
  if (!isCliRuntimeId(runtimeId)) return null;
  const separator = runtimeId.indexOf(":");
  const providerId = runtimeId.slice(0, separator);
  const model = runtimeId.slice(separator + 1);
  return `${CLI_WORKER_DISPLAY_NAMES[providerId] ?? providerId} · ${model === CLI_DEFAULT_MODEL_ID ? "CLI default" : model}`;
}
