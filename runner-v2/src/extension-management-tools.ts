import type { NativeTool, ToolExecutionContext, ToolExecutionOutput, ValidationResult } from "./agent-contracts.js";
import { ExtensionManagementError, type ExtensionChangePlan, type ExtensionOperation } from "./extension-management-contracts.js";
import type { ExtensionManagementService, ManagementCaller, PlanRequest, SourceInspectionView } from "./extension-management-service.js";
import { parseSourceRequest } from "./extension-sources.js";

export const EXTENSION_MANAGEMENT_TOOL_NAMES = [
  "extensions.list",
  "extensions.inspect_source",
  "extensions.plan_change",
  "extensions.apply_change",
  "extensions.operation_status",
] as const;

export interface ExtensionManagementToolOptions {
  readonly service: ExtensionManagementService;
  /** Runner-derived conversation that carries human-message intent; never a model argument. */
  readonly conversationId: (context: ToolExecutionContext) => string | undefined;
  /** Only the user-facing coordinator may change installed state. */
  readonly canMutate: (context: ToolExecutionContext) => boolean;
}

type Input = Record<string, unknown>;

/**
 * Provider-neutral management tools backed by the shared service. None of them accepts approval or
 * credentials: authorization comes from the user's own message, standing policy or the operation card.
 */
export function createExtensionManagementTools(options: ExtensionManagementToolOptions): NativeTool<unknown>[] {
  const caller = (context: ToolExecutionContext): ManagementCaller => ({
    kind: "agent",
    runId: context.runId,
    sessionId: context.sessionId,
    actorRole: context.actor.role,
    actorId: context.actor.id,
    canMutate: options.canMutate(context),
    ...(options.conversationId(context) ? { conversationId: options.conversationId(context)! } : {}),
    ...(context.workspacePath ? { workspaceRoot: context.workspacePath } : {}),
  });
  const tools: NativeTool<Input>[] = [
    {
      definition: {
        name: "extensions.list",
        description: "List installed skills, MCP servers and plugins visible to this project, with readiness, scope, source and pinned version, plus read-only items discovered elsewhere and any pending installation operations.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        readOnly: true,
        effect: "none",
      },
      validate: strict([]),
      execute: async () => run(async () => {
        const inventory = await options.service.inventory();
        return {
          currentGeneration: inventory.currentGeneration,
          installed: inventory.items.map((item) => ({
            id: item.id, kind: item.kind, name: item.name, scope: item.scope.kind, enabled: item.enabled, readiness: item.readiness,
            source: item.source, version: item.currentVersion?.version, versionId: item.currentVersionId, components: item.currentVersion?.components.map(componentSummary),
          })),
          external: inventory.external,
          pendingOperations: inventory.pendingOperations.map(operationSummary),
        };
      }),
    },
    {
      definition: {
        name: "extensions.inspect_source",
        description: "Resolve and inspect an installation source without running anything from it: an https Git URL (optionally ref and subdirectory), a local folder inside the project or one the user named (a skill folder, or a plugin bundle with aiboard-plugin.json), an npm or PyPI package, an executable already on this machine, or a remote MCP URL. Returns the components found, warnings and what access installing would need.",
        inputSchema: {
          type: "object",
          properties: {
            source: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["git", "local_directory", "npm", "pypi", "executable", "remote_http"] },
                url: { type: "string" }, ref: { type: "string" }, subdirectory: { type: "string" }, path: { type: "string" },
                packageName: { type: "string" }, version: { type: "string" }, command: { type: "string" }, args: { type: "array", items: { type: "string" } },
                serverName: { type: "string", description: "MCP server name (lowercase, max 32)." },
                env: { type: "array", items: { type: "string" }, description: "Names of environment variables the server needs. The user enters their values in a secure field; never put values here or in args." },
                bin: { type: "string", description: "npm: which package program to run." },
                entry: { type: "string", description: "PyPI: the console-script name to run." },
                auth: { type: "string", enum: ["none", "bearer", "oauth"], description: "remote_http: how the Runner signs in." },
              },
              required: ["type"],
              additionalProperties: false,
            },
          },
          required: ["source"],
          additionalProperties: false,
        },
        readOnly: true,
        effect: "none",
      },
      validate: strict(["source"], ["source"]),
      assessAccess: () => ({ capability: "extensions.inspect" }),
      timeoutMs: () => 120_000,
      execute: async (input, context) => run(async () => inspectionSummary(await options.service.inspectSource(parseSourceRequest(input.source), caller(context)))),
    },
    {
      definition: {
        name: "extensions.plan_change",
        description: "Prepare a concrete change. install/update need inspectionId (and componentIds when a source holds several skills the user named); enable, disable, remove and rollback need extensionId. Scope defaults to this project. With applyIfAuthorized the change is applied at once when the user's own request or standing policy already covers it; otherwise the user gets one operation card.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["install", "update", "enable", "disable", "remove", "rollback"] },
            inspectionId: { type: "string" },
            componentIds: { type: "array", items: { type: "string" }, maxItems: 1 },
            scope: { type: "string", enum: ["project", "user"] },
            extensionId: { type: "string" },
            versionId: { type: "string" },
            applyIfAuthorized: { type: "boolean" },
          },
          required: ["action"],
          additionalProperties: false,
        },
        readOnly: false,
        effect: "none",
      },
      validate: strict(["action", "inspectionId", "componentIds", "scope", "extensionId", "versionId", "applyIfAuthorized"], ["action"]),
      assessAccess: () => ({ capability: "extensions.manage" }),
      timeoutMs: () => 600_000,
      execute: async (input, context) => run(async () => {
        const plan = await options.service.planChange(planRequest(input, options.service), caller(context));
        if (input.applyIfAuthorized !== true) return planSummary(plan);
        const operation = await options.service.applyChange({ planId: plan.planId, planDigest: plan.planDigest, key: operationKey(context, plan.planDigest) }, caller(context));
        return { plan: planSummary(plan), operation: operationSummary(operation) };
      }),
    },
    {
      definition: {
        name: "extensions.apply_change",
        description: "Apply a plan from extensions.plan_change. Idempotent: retrying with the same operationKey returns the same operation. You cannot approve on the user's behalf; if approval, a choice, a credential or a sign-in is needed the result says so and the user sees an operation card.",
        inputSchema: {
          type: "object",
          properties: { planId: { type: "string" }, planDigest: { type: "string", pattern: "^[a-f0-9]{64}$" }, operationKey: { type: "string", pattern: "^[A-Za-z0-9:_.-]{8,160}$" } },
          required: ["planId", "planDigest"],
          additionalProperties: false,
        },
        readOnly: false,
        effect: "none",
      },
      validate: strict(["planId", "planDigest", "operationKey"], ["planId", "planDigest"]),
      assessAccess: () => ({ capability: "extensions.manage" }),
      timeoutMs: () => 600_000,
      execute: async (input, context) => run(async () => operationSummary(await options.service.applyChange({
        planId: input.planId as string, planDigest: input.planDigest as string,
        key: typeof input.operationKey === "string" ? `agent:${context.runId}:${input.operationKey}` : operationKey(context, input.planDigest as string),
      }, caller(context)))),
    },
    {
      definition: {
        name: "extensions.operation_status",
        description: "Get an installation operation's stage, outcome, bounded diagnostics and any action only the user can take.",
        inputSchema: { type: "object", properties: { operationId: { type: "string" } }, required: ["operationId"], additionalProperties: false },
        readOnly: true,
        effect: "none",
      },
      validate: strict(["operationId"], ["operationId"]),
      execute: async (input, context) => run(async () => operationSummary(await options.service.operationStatus(input.operationId as string, caller(context)))),
    },
  ];
  return tools as NativeTool<unknown>[];
}

function planRequest(input: Input, service: ExtensionManagementService): PlanRequest {
  const action = input.action as string;
  if (action === "install" || action === "update") {
    if (typeof input.inspectionId !== "string") throw new ExtensionManagementError("invalid_arguments", "install/update need inspectionId from extensions.inspect_source.");
    return {
      action, inspectionId: input.inspectionId,
      ...(Array.isArray(input.componentIds) ? { componentIds: input.componentIds as string[] } : {}),
      scope: input.scope === "user" ? { kind: "user" } : service.projectScope(),
    };
  }
  if (typeof input.extensionId !== "string") throw new ExtensionManagementError("invalid_arguments", `${action} needs extensionId from extensions.list.`);
  return { action: action as "enable" | "disable" | "remove" | "rollback", extensionId: input.extensionId, ...(typeof input.versionId === "string" ? { versionId: input.versionId } : {}) };
}

/** Same call retried after an ambiguous failure maps to the same operation. */
function operationKey(context: ToolExecutionContext, planDigest: string): string {
  return `agent:${context.runId}:${(context.callId ?? planDigest.slice(0, 24)).replace(/[^A-Za-z0-9:_.-]/g, "_")}`.slice(0, 160);
}

function inspectionSummary(view: SourceInspectionView) {
  return {
    inspectionId: view.inspectionId, kind: view.kind, source: view.source, ...(view.name ? { name: view.name } : {}), ...(view.version ? { version: view.version } : {}),
    components: view.components.map(componentSummary), invalid: view.invalid, warnings: view.warnings, access: view.access,
    requiresExecutableTrust: view.requiresExecutableTrust, requiredCredentials: view.requiredCredentials, expiresAt: view.expiresAt,
    ...(view.dependencies?.length ? { dependencies: view.dependencies } : {}),
  };
}

function planSummary(plan: ExtensionChangePlan) {
  return {
    planId: plan.planId, planDigest: plan.planDigest, action: plan.action, kind: plan.kind, name: plan.name, scope: plan.scope.kind,
    ...(plan.extensionId ? { extensionId: plan.extensionId } : {}), ...(plan.source ? { source: plan.source } : {}),
    components: plan.components.map(componentSummary), access: plan.access, requiresExecutableTrust: plan.requiresExecutableTrust,
    requiredCredentials: plan.requiredCredentials, warnings: plan.warnings, expiresAt: plan.expiresAt,
  };
}

function operationSummary(operation: ExtensionOperation) {
  const userAction = operation.userAction;
  return {
    operationId: operation.id, action: operation.action, target: operation.target, stage: operation.stage, outcome: operation.outcome,
    ...(operation.authorizationOrigin ? { authorizedBy: operation.authorizationOrigin } : {}),
    ...(userAction ? { waitingForUser: { kind: userAction.kind, reason: userAction.reason, ...(userAction.kind === "credential" ? { names: userAction.names } : {}), note: "The user sees an operation card in AI Board; do not ask them to paste secrets into chat." } } : {}),
    ...(operation.result ? { result: operation.result } : {}),
    diagnostics: operation.diagnostics,
    next: nextStep(operation),
  };
}

function nextStep(operation: ExtensionOperation): string {
  switch (operation.outcome) {
    case "succeeded": return operation.result?.readiness?.state === "ready"
      ? "Ready. It is available from your next turn (installed skills appear in list_skills; MCP tools appear in your tool list)."
      : operation.result?.readiness?.state === "restart_required"
        ? "Installed, but part of it (a Runner extension) only loads when the user restarts the Runner with no Build running. Other parts that report ready are usable now; do not claim the rest works yet."
        : `Committed with readiness ${operation.result?.readiness?.state ?? "unknown"}; check extensions.list before claiming it works.`;
    case "awaiting_user": return "Waiting for the user on the operation card. Continue other work; check extensions.operation_status later.";
    case "running": return "Still running; check extensions.operation_status.";
    case "rolled_back": return "The update failed its check and the previous working version was restored.";
    case "outcome_unknown": return "The outcome is unknown; do not retry blindly. Tell the user and check extensions.list.";
    default: return "The change did not complete; see diagnostics.";
  }
}

function componentSummary(component: ExtensionChangePlan["components"][number]) {
  switch (component.kind) {
    case "skill": return { kind: "skill", id: component.componentId, name: component.skillName, description: component.description, files: component.files, warnings: component.warnings };
    case "mcp_server": return { kind: "mcp_server", id: component.componentId, name: component.serverName, transport: component.transport, route: component.route, ...(component.toolNames ? { tools: component.toolNames } : {}), credentials: component.environment.map((entry) => entry.name) };
    case "runner_extension": return { kind: "runner_extension", id: component.componentId, extensionId: component.extensionId };
  }
}

async function run(action: () => Promise<unknown>): Promise<ToolExecutionOutput> {
  try {
    return { content: [{ type: "json", value: await action() }], isError: false };
  } catch (error) {
    const code = error instanceof ExtensionManagementError ? error.code : "extension_management_failed";
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: `${code}: ${message}` }], isError: true, error: { code, message } };
  }
}

/** Unknown fields are refused by name; an approval or credential argument is never accepted. */
function strict(allowed: readonly string[], required: readonly string[] = []): (input: unknown) => ValidationResult<Input> {
  return (input) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, issues: ["arguments must be an object"] };
    const value = input as Input;
    const issues: string[] = [];
    for (const key of Object.keys(value)) {
      if (allowed.includes(key)) continue;
      issues.push(/approv|authori|consent|confirm|secret|token|password|credential|api.?key/i.test(key)
        ? `${key} is refused: approval and credentials come only from the user through AI Board, never from tool arguments`
        : `${key} is not allowed`);
    }
    for (const key of required) if (value[key] === undefined) issues.push(`${key} is required`);
    return issues.length ? { ok: false, issues } : { ok: true, value };
  };
}
