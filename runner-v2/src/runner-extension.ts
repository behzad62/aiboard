import type {
  AgentActor,
  NativeTool,
  ToolDefinition,
} from "./agent-contracts.js";
import type { LanguageIntelligenceProvider } from "./language-intelligence.js";

export const RUNNER_EXTENSION_API_VERSION = 1 as const;
export const RUNNER_EXTENSION_MANIFEST_FILE = "runner-extension.json";
export const RUNNER_EXTENSION_CONTEXT_MAX_BYTES = 64 * 1024;
export const PROTECTED_RUNNER_LIFECYCLE_TOOL_NAMES = Object.freeze([
  "acknowledge_user_guidance",
  "answer_guidance",
  "ask_architect",
  "ask_user",
  "challenge_guidance",
  "complete_run",
  "plan_final_verification",
  "plan_tasks",
  "plan_verification_repairs",
  "plan_verifier_repairs",
  "reconcile_plan",
  "request_integration",
  "return_to_parent",
  "review_final_verification",
  "review_task",
  "revise_task",
  "submit_final_verification",
  "submit_task",
  "submit_verifier_verdict",
  "upgrade_acceptance_contract",
] as const);

export type RunnerExtensionCapabilityKind =
  | "tools"
  | "context"
  | "language_intelligence";

export interface RunnerExtensionManifest {
  apiVersion: typeof RUNNER_EXTENSION_API_VERSION;
  id: string;
  name: string;
  version: string;
  entry: string;
  capabilities: RunnerExtensionCapabilityKind[];
}

export type RunnerExtensionTool<TInput = unknown> = Omit<
  NativeTool<TInput>,
  "definition"
> & {
  definition: Omit<ToolDefinition, "lifecycle"> & { lifecycle?: false };
};

export interface RunnerExtensionContextRequest {
  runId: string;
  sessionId: string;
  actor: Readonly<AgentActor>;
  objective: string;
  workspacePath: string;
  taskId?: string;
  signal: AbortSignal;
}

export interface RunnerExtensionContextContribution {
  content: string;
  sourceDigest?: string;
  artifactHash?: string;
}

export interface RunnerExtensionContextContributor {
  id: string;
  kind: string;
  priority: number;
  maxBytes: number;
  contribute(
    request: RunnerExtensionContextRequest,
  ): Promise<RunnerExtensionContextContribution | null>;
}

export interface RunnerExtensionCapabilities {
  tools: readonly RunnerExtensionTool[];
  contextContributors: readonly RunnerExtensionContextContributor[];
  languageProviders: readonly LanguageIntelligenceProvider[];
}

export interface RunnerExtensionCapabilityProvider {
  /** Synchronous and side-effect free so all registrations can be validated atomically. */
  capabilities(): RunnerExtensionCapabilities;
}

export interface RunnerExtensionLifecycleContext {
  extensionId: string;
  stateDirectory: string;
  signal: AbortSignal;
}

export interface RunnerExtensionInstance
  extends RunnerExtensionCapabilityProvider {
  start(context: RunnerExtensionLifecycleContext): Promise<void>;
  close(): Promise<void>;
}

export interface RunnerExtensionModule {
  createExtension(): RunnerExtensionInstance;
}

const MANIFEST_KEYS = new Set([
  "apiVersion",
  "id",
  "name",
  "version",
  "entry",
  "capabilities",
]);
const EXTENSION_ID = /^[a-z][a-z0-9.-]{0,63}$/;
const CAPABILITY_ORDER: readonly RunnerExtensionCapabilityKind[] = [
  "tools",
  "context",
  "language_intelligence",
];

export function parseRunnerExtensionManifest(
  input: unknown,
): RunnerExtensionManifest {
  const value = exactManifestObject(input);
  if (value.apiVersion !== RUNNER_EXTENSION_API_VERSION) {
    throw new Error(
      `Runner extension has incompatible API version ${String(value.apiVersion)}; expected ${RUNNER_EXTENSION_API_VERSION}.`,
    );
  }
  const id = boundedString(value.id, "extension id", 64);
  if (!EXTENSION_ID.test(id)) throw new Error(`Runner extension id ${id} is invalid.`);
  const name = boundedString(value.name, "extension name", 128);
  const version = boundedString(value.version, "extension version", 64);
  const entry = boundedString(value.entry, "extension entry", 512);
  if (!portableEntry(entry)) {
    throw new Error(`Runner extension entry ${entry} is invalid.`);
  }
  if (!Array.isArray(value.capabilities) || value.capabilities.length > CAPABILITY_ORDER.length) {
    throw new Error("Runner extension capabilities must be an array.");
  }
  const capabilities: RunnerExtensionCapabilityKind[] = [];
  for (const capability of value.capabilities) {
    if (!CAPABILITY_ORDER.includes(capability as RunnerExtensionCapabilityKind)) {
      throw new Error(`Runner extension capability ${String(capability)} is invalid.`);
    }
    if (capabilities.includes(capability as RunnerExtensionCapabilityKind)) {
      throw new Error(`Runner extension contains duplicate capability ${String(capability)}.`);
    }
    capabilities.push(capability as RunnerExtensionCapabilityKind);
  }
  capabilities.sort(
    (left, right) =>
      CAPABILITY_ORDER.indexOf(left) - CAPABILITY_ORDER.indexOf(right),
  );
  return {
    apiVersion: RUNNER_EXTENSION_API_VERSION,
    id,
    name,
    version,
    entry,
    capabilities,
  };
}

function exactManifestObject(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Runner extension manifest must be an object.");
  }
  const value = input as Record<string, unknown>;
  const unknown = Object.keys(value)
    .filter((key) => !MANIFEST_KEYS.has(key))
    .sort(compareCodeUnits);
  if (unknown.length > 0) {
    throw new Error(`Runner extension manifest contains unknown field ${unknown[0]}.`);
  }
  return value;
}

function portableEntry(value: string): boolean {
  if (
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value.includes("\\")
  ) return false;
  const segments = value.split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}

function boundedString(input: unknown, label: string, maxBytes: number): string {
  if (typeof input !== "string") throw new Error(`${label} must be a string.`);
  const value = input.trim();
  if (!value || Buffer.byteLength(value) > maxBytes) {
    throw new Error(`${label} must contain 1 to ${maxBytes} bytes.`);
  }
  return value;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
