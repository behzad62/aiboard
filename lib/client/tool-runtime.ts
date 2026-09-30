import type {
  RemoteMcpServerSettings,
  ToolRuntimeRunnerSettings,
  ToolRuntimeSettings,
} from "@/lib/db/schema";
import type {
  ToolIntent,
  ToolResourceState,
} from "@/lib/providers/tool-capabilities";
import {
  buildProviderToolRequest,
  type ProviderToolRequest,
} from "@/lib/providers/tool-request";
import { getNativeRunnerHealth } from "./runner-v2";
import {
  NATIVE_RUNNER_NODE_POLICY_DESCRIPTION,
  supportsNativeRunnerNodeVersion,
} from "./native-build-policy";
import { getUserSettings, updateUserSettings } from "./store";

export interface ToolRuntimeSignal {
  configured?: boolean;
  ready: boolean;
  detail?: string;
}

export interface ToolRuntimeSignals {
  runner: ToolRuntimeSignal;
  remoteMcp: ToolRuntimeSignal;
  computerExecutor: ToolRuntimeSignal;
  browserExecutor: ToolRuntimeSignal;
}

export function buildToolResourceState(signals: ToolRuntimeSignals): ToolResourceState {
  const entry = (signal: ToolRuntimeSignal) => ({
    ready: signal.ready,
    ...(!signal.ready && signal.detail ? { reason: signal.detail } : {}),
  });
  return {
    prerequisites: {
      local_shell_executor: entry(signals.runner),
      local_editor_executor: entry(signals.runner),
      remote_mcp_server: entry(signals.remoteMcp),
      computer_executor: entry(signals.computerExecutor),
      browser_executor: entry(signals.browserExecutor),
    },
  };
}

export function configuredRemoteMcpIntent(
  server: RemoteMcpServerSettings | null | undefined,
): ToolIntent | undefined {
  const name = server?.name?.trim();
  const url = server?.url?.trim();
  if (!server?.enabled || !name || !url || !/^https?:\/\//i.test(url)) return undefined;
  const authorizationToken = server.authorizationToken?.trim();
  return {
    id: "remote_mcp",
    requirement: "optional",
    parameters: {
      // Provider adapters normalize different names from this shared intent.
      serverName: name,
      serverLabel: name,
      serverUrl: url,
      ...(authorizationToken
        ? { authorizationToken, authorization: authorizationToken }
        : {}),
    },
  };
}

export function applyToolRuntimeToRequest(
  request: ProviderToolRequest,
  settings: ToolRuntimeSettings = getToolRuntimeSettings(),
): ProviderToolRequest {
  const remoteMcpIntent = configuredRemoteMcpIntent(settings.remoteMcpServer);
  return buildProviderToolRequest({
    toolIntents: [
      ...request.toolIntents,
      ...(remoteMcpIntent ? [remoteMcpIntent] : []),
    ],
    toolInventory: request.toolInventory,
    functionTools: request.functionTools,
    toolChoice: request.toolChoice,
  });
}

export function toolRuntimeSetupTarget(
  prerequisiteId: string,
): string | undefined {
  return [
    "local_shell_executor",
    "local_editor_executor",
    "remote_mcp_server",
  ].includes(prerequisiteId)
    ? "/settings?tab=tools"
    : undefined;
}

export function getToolRuntimeSettings(): ToolRuntimeSettings {
  return getUserSettings().toolRuntime ?? {};
}

export function getToolRuntimeRunner(): ToolRuntimeRunnerSettings | null {
  return getToolRuntimeSettings().runner ?? null;
}

export const TOOL_RUNTIME_CHANGED_EVENT = "aiboard-tool-runtime-changed";

function notifyToolRuntimeChanged(): void {
  clearToolRuntimeStateCache();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(TOOL_RUNTIME_CHANGED_EVENT));
  }
}

export function saveToolRuntimeRunner(runner: ToolRuntimeRunnerSettings | null): void {
  const current = getToolRuntimeSettings();
  updateUserSettings({ toolRuntime: { ...current, runner } });
  notifyToolRuntimeChanged();
}

export function saveRemoteMcpServer(server: RemoteMcpServerSettings | null): void {
  const current = getToolRuntimeSettings();
  updateUserSettings({ toolRuntime: { ...current, remoteMcpServer: server } });
  notifyToolRuntimeChanged();
}

export async function resolveToolRuntimeResourceState(input: {
  runner?: ToolRuntimeRunnerSettings | null;
  checkRunner?: typeof getNativeRunnerHealth;
  checkRunnerHealth?: boolean;
} = {}): Promise<ToolResourceState> {
  const settings = getToolRuntimeSettings();
  const runner = input.runner === undefined ? settings.runner ?? null : input.runner;
  const checkRunner = input.checkRunner ?? getNativeRunnerHealth;
  let runnerSignal: ToolRuntimeSignal;
  if (!runner?.url?.trim() || !runner.token?.trim()) {
    runnerSignal = {
      configured: false,
      ready: false,
      detail: "Connect Runner V2 in Tools settings to enable local shell and editor execution.",
    };
  } else if (input.checkRunnerHealth === false) {
    runnerSignal = {
      configured: true,
      ready: false,
      detail: "Runner V2 health was not needed for this provider call.",
    };
  } else {
    try {
      const health = await checkRunner({ url: runner.url.trim(), token: runner.token });
      if (!supportsNativeRunnerNodeVersion(health.nodeVersion)) {
        runnerSignal = {
          configured: true,
          ready: false,
          detail: `Runner V2 uses ${health.nodeVersion}; supported policy is ${NATIVE_RUNNER_NODE_POLICY_DESCRIPTION}.`,
        };
      } else {
        runnerSignal = {
          configured: true,
          ready: true,
          detail: `Runner V2 connected to ${health.projectPath}.`,
        };
      }
    } catch (error) {
      runnerSignal = {
        configured: true,
        ready: false,
        detail: error instanceof Error ? error.message : "Runner V2 is unreachable.",
      };
    }
  }

  const remote = settings.remoteMcpServer;
  const remoteIntent = configuredRemoteMcpIntent(remote);
  const remoteMcp: ToolRuntimeSignal = remoteIntent
    ? { configured: true, ready: true, detail: `Approved remote MCP server ${remote?.name}.` }
    : {
        configured: Boolean(remote?.name || remote?.url),
        ready: false,
        detail: "Add and enable an approved http(s) remote MCP server in Tools settings.",
      };

  return buildToolResourceState({
    runner: runnerSignal,
    remoteMcp,
    computerExecutor: {
      configured: false,
      ready: false,
      detail: "The web client does not yet include a same-turn computer-use execution bridge.",
    },
    browserExecutor: {
      configured: false,
      ready: false,
      detail: "The web client does not yet include a same-turn browser-use execution bridge.",
    },
  });
}
let cachedState: { key: string; expiresAt: number; value: ToolResourceState } | undefined;

function runtimeCacheKey(): string {
  const settings = getToolRuntimeSettings();
  return JSON.stringify({
    runner: settings.runner ?? null,
    remoteMcpServer: settings.remoteMcpServer ?? null,
  });
}

export async function resolveToolRuntimeResourceStateCached(
  options: { maxAgeMs?: number; checkRunnerHealth?: boolean } = {},
): Promise<ToolResourceState> {
  const maxAgeMs = options.maxAgeMs ?? 5_000;
  const checkRunnerHealth = options.checkRunnerHealth !== false;
  const key = `${runtimeCacheKey()}|runner-health:${checkRunnerHealth}`;
  const now = Date.now();
  if (cachedState && cachedState.key === key && cachedState.expiresAt > now) {
    return cachedState.value;
  }
  const value = await resolveToolRuntimeResourceState({ checkRunnerHealth });
  cachedState = { key, expiresAt: now + maxAgeMs, value };
  return value;
}

export function clearToolRuntimeStateCache(): void {
  cachedState = undefined;
}
